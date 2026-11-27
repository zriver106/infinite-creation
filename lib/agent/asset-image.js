// 资产出图编排（总导 11-26：Andy「制作资产也是要走 ic 工作流不是我们这边单独搞」）。
// 每分钟一拍（tick）：① 收图：各线程当前单在 am 工作区有新回图 → 拉回存档 → 起审图任务；② 派单：空闲线程按车道取下一张发给 am。
// 审图任务结束 → 过：写回原 asset_id（_MV 进下一格，D 过后拼 2×2）；不过：原线程退回，轮次 +1。
// 卡住：发出后 10 分钟没回图提示核查，20 分钟标「待对账」——不自动重派（结果不明的不重派）。发送没确认的同样只标「待对账」。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, Assets, projectDir } from '../core/index.js';
import { getGapList } from '../core/asset-gaps.js';
import { amSend, amPut, amList, amGet, amPaths, amHistoryHas } from '../core/am-client.js';
import { loadWork, saveWork, threadsOf, laneOf, stepsOf, candidateRows, outPrefix, buildDispatchText, buildReviseText, composeMv, writeAssetImage, roundsDir, STALE_WARN_MIN, STALE_STOP_MIN, baseRefAbs, applyStageBaseRefs } from '../core/asset-image-work.js';
import { reviewResultPath, ASSET_IMAGE_SKILL } from './asset-image-review-mcp.js';
import { skillDir } from './skill-engine.js';
import { runExternalAgent } from './external/runner.js';
import { promptWriteAgentId } from './prompt-write.js';
import { loadConfig } from '../core/config.js';
import { runParallelText } from '../core/render-gate.js';
import { agentLimit } from '../core/agent-limits.js';

export const DISPATCH_JOB = 'asset-image-dispatch';
export const REVIEW_JOB = 'asset-image-review';
export const MAX_ROUNDS = 3;
const IMG = /\.(png|jpe?g|webp)$/i;
const MIN = 60 * 1000;

function template() {
  try { const f = path.join(skillDir(ASSET_IMAGE_SKILL), 'references', '派单模板.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; }
}
const rowOf = (projectId, aid) => (getGapList(projectId).items || []).find((x) => x.asset_id === aid);
const logJob = (projectId, type, checkpoint, detail, status = 'done') => {
  const j = Jobs.create({ projectId, type, checkpoint });
  Jobs.update(j.id, { status, phase: status === 'done' ? '完成' : status, detail: String(detail).slice(0, 2000), finishedAt: Date.now() });
  return j.id;
};

function refAbsOf(base) {
  if (!base || !base.asset_id) return '';
  const a = Assets.get(base.asset_id);
  return a && a.image_path ? path.join(projectDir(a.project_id), a.image_path) : '';
}

const defaultDeps = () => ({
  send: amSend, put: amPut, list: amList, get: amGet, historyHas: amHistoryHas,
  runReview: (o) => runExternalAgent(o),
  agentId: promptWriteAgentId(loadConfig()),
});

/** 给某线程发一张（新单或 _MV 的下一格）。 */
async function dispatch(projectId, w, th, aid, deps) {
  const row = rowOf(projectId, aid);
  if (!row) return;
  const it = w.items[aid] || (w.items[aid] = { name: row.name, lane: laneOf(row), steps: stepsOf(row), stepIdx: 0, round: 1, approved: {}, returns: [], history: [] });
  it.thread = th.name;
  const step = it.steps[it.stepIdx];
  const p = amPaths();
  const prefix = outPrefix(aid, step, it.round);
  const outFile = p.outDir + '/' + prefix + '_' + String(row.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '.png';
  const attach = [];
  let refRemote = '';
  const baseAbs = baseRefAbs(projectId, row.base_ref);
  if (baseAbs && (step === 'main' || step === 'A')) {
    refRemote = p.refDir + '/' + String(aid).slice(0, 8) + '_base' + path.extname(baseAbs);
    const r = await deps.put(baseAbs, refRemote); if (!r || !r.ok) refRemote = '';
  }
  for (const s of Object.keys(it.approved || {})) {
    const remote = p.refDir + '/' + String(aid).slice(0, 8) + '_' + s + '_ok' + path.extname(it.approved[s]);
    const r = await deps.put(it.approved[s], remote); if (r && r.ok) attach.push(remote + '（' + s + ' 格）');
  }
  const style = (Projects.get(projectId) || {}).style || '';
  const text = buildDispatchText(row, { step, round: it.round, style, template: template(), outFile, refRemote, attachRemote: attach, kind: row.kind === 'scene' ? 'scene' : row.kind === 'prop' ? 'prop' : 'character' });
  const sent = await deps.send(th.session, text);
  Object.assign(it, { step, prefix, out_file: outFile, sent_at: Date.now(), status: sent.confirmed ? 'sent' : 'unconfirmed', note: sent.confirmed ? '' : (sent.error || '发送未确认') });
  it.history.push({ at: Date.now(), action: 'dispatch', step, round: it.round, thread: th.name, confirmed: !!sent.confirmed });
  w.threads[th.name] = { current: aid };
  logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: row.name, step, round: it.round, thread: th.name, out_file: outFile }, (sent.confirmed ? '已派' : '发送未确认（待对账，不重发）') + '：「' + row.name + '」' + (step !== 'main' ? step + ' 格' : '') + ' r' + it.round + ' → ' + th.name);
}

/** 退回：原线程发返修意见，轮次 +1。 */
async function sendBack(projectId, w, aid, note, deps) {
  const it = w.items[aid]; const row = rowOf(projectId, aid);
  const th = threadsOf(projectId).find((t) => t.name === it.thread);
  it.round += 1;
  const p = amPaths();
  it.prefix = outPrefix(aid, it.step, it.round);
  it.out_file = p.outDir + '/' + it.prefix + '_' + String(row.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '.png';
  it.returns.push({ step: it.step, round: it.round - 1, note });
  const sent = th ? await deps.send(th.session, buildReviseText(row, { step: it.step, round: it.round, note, outFile: it.out_file })) : { confirmed: false, error: '线程没了' };
  Object.assign(it, { sent_at: Date.now(), status: sent.confirmed ? 'sent' : 'unconfirmed', file: '' });
  it.history.push({ at: Date.now(), action: 'return', step: it.step, round: it.round, confirmed: !!sent.confirmed });
  logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: row.name, step: it.step, round: it.round, thread: it.thread, returned: true }, '退回返修 r' + it.round + '：「' + row.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + '——' + String(note).slice(0, 300));
}

/** 起审图任务（外部 Agent，受限工具集）；结束后读结论接着走。 */
function startReview(projectId, w, aid, deps) {
  const it = w.items[aid];
  const cp = { asset_id: aid, name: it.name, step: it.step, round: it.round, file: it.file, approved: it.approved, previous_returns: it.returns, assetImageReview: true };
  const job = Jobs.create({ projectId, type: REVIEW_JOB, checkpoint: cp });
  it.status = 'reviewing'; it.review_job = job.id;
  it.history.push({ at: Date.now(), action: 'review_start', step: it.step, round: it.round, job: job.id });
  Jobs.update(job.id, { status: 'running', phase: '审图', detail: '「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round });
  runParallelText(() => deps.runReview({ projectId, jobId: job.id, agentId: deps.agentId, assetImageReview: true, assetId: aid, renderDisabled: true, isAborted: () => false, onProgress: () => {} }), () => false, { jobId: job.id, gateKey: 'review', limit: agentLimit(projectId, 'review') })
    .catch((e) => e)
    .then((err) => onReviewDone(projectId, aid, job.id, deps, err));
}

/** 审图任务结束：按结论写回 / 进下一格 / 退回。 */
export async function onReviewDone(projectId, aid, jobId, deps = defaultDeps(), agentErr = null) {
  return withLock(projectId, async () => {
    const w = loadWork(projectId); const it = w.items[aid];
    if (!it || it.review_job !== jobId) return;
    const resF = reviewResultPath(projectId, { asset_id: aid, step: it.step, round: it.round });
    if (!fs.existsSync(resF)) {
      it.status = 'review_failed'; it.note = '审图任务没交结论' + (agentErr && agentErr.message ? '：' + agentErr.message : '');
      Jobs.update(jobId, { status: 'failed', phase: '失败', error: it.note, finishedAt: Date.now() });
      saveWork(projectId, w); return;
    }
    const res = JSON.parse(fs.readFileSync(resF, 'utf8'));
    Jobs.update(jobId, { status: 'done', phase: '完成', detail: (res.verdict === 'pass' ? '审过' : '退回') + '：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + (res.return_note ? '——' + res.return_note.slice(0, 300) : ''), finishedAt: Date.now() });
    it.history.push({ at: Date.now(), action: 'review', step: it.step, round: it.round, verdict: res.verdict, job: jobId });
    if (res.verdict === 'needs_human') {
      // 审图 Agent 判「需人工」（取不到底图等，总导 11-26）：停在这一行，线程让出来
      Object.assign(it, { status: 'needs_human', note: '审图判需人工：' + String(res.return_note || '').slice(0, 200) });
      if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
      saveWork(projectId, w); return;
    }
    if (res.verdict === 'return') {
      // 返修到第 MAX_ROUNDS 轮还不过：标「需人工」，停在这一行，线程让给别的单（总导 11-26）
      if (it.round >= MAX_ROUNDS) {
        it.returns.push({ step: it.step, round: it.round, note: res.return_note });
        Object.assign(it, { status: 'needs_human', note: '返修 ' + it.round + ' 轮仍不过，需人工：' + String(res.return_note || '').slice(0, 200) });
        if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
        saveWork(projectId, w); return;
      }
      await sendBack(projectId, w, aid, res.return_note, deps); saveWork(projectId, w); return;
    }
    it.approved[it.step] = it.file;
    if (it.stepIdx < it.steps.length - 1) {
      it.stepIdx += 1; it.round = 1; it.status = 'next_step';
    } else {
      let final = it.file;
      if (it.steps.length === 4) final = composeMv(['A', 'B', 'C', 'D'].map((s) => it.approved[s]), path.join(roundsDir(projectId, aid), 'MV_2x2_' + Date.now().toString(36) + '.png'));
      const rel = writeAssetImage(projectId, aid, final, { source: 'am' });
      // 父角色基础形象＝第一套服装：缺图单父行 base_image_asset_id 指向本资产的，同一张也写给父角色
      for (const pr of (getGapList(projectId).items || []).filter((x) => x.base_image_asset_id === aid && x.asset_id && x.status !== 'void')) {
        try { writeAssetImage(projectId, pr.asset_id, final, { source: 'am' }); } catch { /* 父行写不进去不影响本资产 */ }
      }
      Object.assign(it, { status: 'passed', image_path: rel, passed_at: Date.now() });
      if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
    }
    saveWork(projectId, w);
  });
}

const locks = new Map();
function withLock(projectId, fn) {
  const prev = locks.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(projectId, next.catch(() => {}));
  return next;
}

/** 一拍：收图 → 派单。deps 可注入（测试用假 am）。 */
export function tick(projectId, deps = defaultDeps()) {
  return withLock(projectId, async () => {
    try { applyStageBaseRefs(projectId); } catch { /* 挂底图失败不挡收图派单 */ }
    const w = loadWork(projectId);
    const threads = threadsOf(projectId);
    const p = amPaths();
    // ⓪ 发送未确认的对账
    for (const [aid, it] of Object.entries(w.items)) {
      if (it.status !== 'unconfirmed' || !deps.historyHas) continue;
      const th = threads.find((t) => t.name === it.thread);
      if (th && it.out_file && await deps.historyHas(th.session, it.out_file)) { it.status = 'sent'; it.note = '对账：已送达'; it.history.push({ at: Date.now(), action: 'confirmed_by_history' }); }
    }
    // ① 收图
    const waiting = Object.entries(w.items).filter(([, it]) => it.status === 'sent' || it.status === 'stale_warn');
    if (waiting.length) {
      const ls = await deps.list(p.outDir);
      const files = (ls && ls.ok && ls.files) || [];
      for (const [aid, it] of waiting) {
        const used = new Set(w.consumed || []);
        const key = (x) => x.name + '|' + (x.modifiedAt || x.size);
        const nm = String(it.name || '').replace(/[\/:*?"<>|s]+/g, '_');
        const fresh = (x) => !used.has(key(x)) && (!x.modifiedAt || Date.parse(x.modifiedAt) >= (it.sent_at || 0) - 60000);
        const f = files.find((x) => IMG.test(x.name) && fresh(x) && x.name.startsWith(it.prefix))
          || files.filter((x) => IMG.test(x.name) && !x.name.startsWith('media-generation') && fresh(x) && (x.name.includes(it.name) || x.name.includes(nm)) && (it.step === 'main' || new RegExp('_' + it.step + '(_|\.|$)').test(x.name))).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))[0];
        if (f) {
          const local = path.join(roundsDir(projectId, aid), it.step + '_r' + it.round + '_' + f.name);
          const g = await deps.get(p.outDir + '/' + f.name, local);
          if (g && g.ok) { (w.consumed = w.consumed || []).push(key(f)); it.file = local; it.history.push({ at: Date.now(), action: 'received', step: it.step, round: it.round, file: f.name }); startReview(projectId, w, aid, deps); continue; }
        }
        const age = (Date.now() - (it.sent_at || 0)) / MIN;
        if (age >= STALE_STOP_MIN) { it.status = 'stale'; it.note = STALE_STOP_MIN + ' 分钟没回图：待对账（不自动重派）'; }
        else if (age >= STALE_WARN_MIN) { it.status = 'stale_warn'; it.note = STALE_WARN_MIN + ' 分钟没回图，核查中'; }
      }
    }
    // ② 派单（暂停时不派新单，在途的照常收图审图）：先接着派 _MV 的下一格（同线程），再给空闲线程派新单
    if (!w.running) { saveWork(projectId, w); return summary(w); }
    for (const [aid, it] of Object.entries(w.items)) {
      if (it.status !== 'next_step') continue;
      const th = threads.find((t) => t.name === it.thread);
      if (th) await dispatch(projectId, w, th, aid, deps);
    }
    const busy = new Set(Object.entries(w.threads).filter(([, v]) => v && v.current).map(([k]) => k));
    const taken = new Set(Object.keys(w.items));
    const rows = candidateRows(projectId, w).filter((r) => !taken.has(r.asset_id));
    for (const th of threads) {
      if (busy.has(th.name)) continue;
      const row = rows.find((r) => laneOf(r) === th.lane && !taken.has(r.asset_id));
      if (!row) continue;
      taken.add(row.asset_id);
      await dispatch(projectId, w, th, row.asset_id, deps);
    }
    saveWork(projectId, w);
    return summary(w);
  });
}

export function summary(w) {
  const by = {};
  for (const it of Object.values(w.items || {})) by[it.status] = (by[it.status] || 0) + 1;
  return { running: !!w.running, allow: (w.allow || []).length, items: Object.keys(w.items || {}).length, by_status: by, threads: w.threads };
}

const loops = new Map();
/** 开 / 停。开时可给 allow（只派这些 asset_id，总导确认过的单子）。 */
export function setRunning(projectId, running, { allow = null } = {}) {
  const w = loadWork(projectId);
  w.running = !!running;
  if (Array.isArray(allow)) w.allow = allow.map(String);
  saveWork(projectId, w);
  ensureLoop(projectId);
  return summary(w);
}
/** 服务重启后，第一次读状态时把循环接上。 */
export function ensureLoop(projectId) {
  const w = loadWork(projectId);
  const inflight = Object.values(w.items || {}).some((it) => ['sent', 'stale_warn', 'reviewing'].includes(it.status));
  if ((w.running || inflight) && !loops.has(projectId)) {
    const t = setInterval(() => { tick(projectId).catch(() => {}); }, MIN);
    if (t.unref) t.unref();
    loops.set(projectId, t);
  }
  if (!w.running && !inflight && loops.has(projectId)) { clearInterval(loops.get(projectId)); loops.delete(projectId); }
}

/** 口径变了：给每个线程单独发一句「之前的 X 作废，以本条为准」（站位：am 会沿用线程里的旧指令）。 */
export async function broadcast(projectId, text, deps = defaultDeps()) {
  const out = [];
  for (const th of threadsOf(projectId)) {
    const r = await deps.send(th.session, String(text));
    out.push({ thread: th.name, confirmed: !!r.confirmed });
    logJob(projectId, DISPATCH_JOB, { broadcast: true, thread: th.name }, (r.confirmed ? '已发' : '发送未确认') + '：口径通知 → ' + th.name + '：' + String(text).slice(0, 300));
  }
  return out;
}
