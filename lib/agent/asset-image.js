// 资产出图编排（总导 11-26：Andy「制作资产也是要走 ic 工作流不是我们这边单独搞」）。
// 每分钟一拍（tick）：① 收图：各线程当前单在 am 工作区有新回图 → 拉回存档 → 起审图任务；② 派单：空闲线程按车道取下一张发给 am。
// 审图任务结束 → 过：写回原 asset_id（_MV 进下一格，D 过后拼 2×2）；不过：原线程退回，轮次 +1。
// 卡住：发出后 10 分钟没回图提示核查，20 分钟标「待对账」——不自动重派（结果不明的不重派）。发送没确认的同样只标「待对账」。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, Assets, projectDir } from '../core/index.js';
import { getGapList } from '../core/asset-gaps.js';
import { amSend, amPut, amList, amGet, amPaths, amHistoryHas } from '../core/am-client.js';
import { loadWork, saveWork, threadsOf, laneOf, stepsOf, candidateRows, outPrefix, buildDispatchText, buildReviseText, composeMv, writeAssetImage, roundsDir, STALE_WARN_MIN, STALE_STOP_MIN, baseRefAbs, applyStageBaseRefs, locationDOf, cellImage } from '../core/asset-image-work.js';
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
  // 同一地点第二张 _MV 的 D：取本地点已定稿 _MV 的 D 格，只加机位标注（缺口第 17 条）
  let reuseD = '';
  if (step === 'D') {
    const d = locationDOf(projectId, row);
    if (d) { const remote = p.refDir + '/' + String(aid).slice(0, 8) + '_locD' + path.extname(d.abs); const r = await deps.put(d.abs, remote); if (r && r.ok) { reuseD = remote + '（' + d.name + ' 的 D 格）'; attach.push(reuseD); } }
  }
  for (const s of Object.keys(it.approved || {})) {
    const remote = p.refDir + '/' + String(aid).slice(0, 8) + '_' + s + '_ok' + path.extname(it.approved[s]);
    const r = await deps.put(it.approved[s], remote); if (r && r.ok) attach.push(remote + '（' + s + ' 格）');
  }
  const style = (Projects.get(projectId) || {}).style || '';
  const text = buildDispatchText(row, { step, round: it.round, style, template: template(), outFile, refRemote, attachRemote: attach, reuseD, kind: row.kind === 'scene' ? 'scene' : row.kind === 'prop' ? 'prop' : 'character' });
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
    if (it.step === 'compose') {
      if (res.verdict === 'pass') { finishWrite(projectId, w, aid, it.file); saveWork(projectId, w); return; }
      Object.assign(it, { status: 'needs_human', note: '拼板核对没过（D 和 A/B/C 对不上），没写回：' + String(res.return_note || '').slice(0, 200) });
      if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
      saveWork(projectId, w); return;
    }
    if (res.verdict !== 'pass' && res.verdict !== 'return') {
      // 审图 Agent 判「需人工」（取不到底图等，总导 11-26）：停在这一行，线程让出来
      Object.assign(it, { status: 'needs_human', note: '审图判需人工（结论 ' + String(res.verdict) + '）：' + String(res.return_note || '').slice(0, 200) });
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
      if (it.steps.length === 4) { startCompose(projectId, w, aid, deps); saveWork(projectId, w); return; }
      finishWrite(projectId, w, aid, it.file);
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

/** 撤图（站位 11-26：needs_human 被旧服务端当成审过写回了资产）：资产图恢复到上一版（没有上一版就清空），这一行标「需人工」。只在 IC 资产出图写回过的资产上用。 */
export function revokeImage(projectId, aid, reason = '') {
  const a = Assets.get(aid);
  if (!a || a.project_id !== projectId) throw Object.assign(new Error('资产不在本项目：' + aid), { code: 'NO_ASSET' });
  const versions = [...(a.versions || [])];
  const prev = versions.pop() || '';
  const removed = a.image_path || '';
  Assets.update(aid, { image_path: prev, versions, status: prev ? 'done' : 'pending', source: prev ? a.source : 'none' });
  const w = loadWork(projectId);
  const it = w.items[aid];
  if (it) {
    Object.assign(it, { status: 'needs_human', note: '已撤图' + (reason ? '：' + reason : ''), image_path: '' });
    it.history.push({ at: Date.now(), action: 'revoke', removed, restored: prev, reason });
    if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
    saveWork(projectId, w);
  }
  logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: a.name, revoke: true }, '撤图：「' + a.name + '」' + (prev ? '恢复到上一版' : '恢复成没图') + (reason ? '——' + reason : ''));
  return { asset_id: aid, removed, restored: prev };
}

/** 人工指定 D（总导 11-26）：_MV 这一行的 D 直接取同地点某张已定稿 _MV 的 D 格；A/B/C 都审过了就立刻拼 2×2 写回。 */
export function setManualD(projectId, aid, fromAid, deps = defaultDeps(), { fromVersion = '' } = {}) {
  const row = rowOf(projectId, aid);
  if (!row || !/_MV/.test(String(row.name || ''))) throw Object.assign(new Error('只有 _MV 行能指定 D'), { code: 'NOT_MV' });
  const d = fromVersion ? ownVersionD(projectId, aid, fromVersion) : locationDOf(projectId, row, String(fromAid || ''));
  if (!d) throw Object.assign(new Error('取不到那张 _MV 的 D 格（要同项目、已有图的 _MV）'), { code: 'NO_D' });
  const w = loadWork(projectId);
  const it = w.items[aid] || (w.items[aid] = { name: row.name, lane: laneOf(row), steps: stepsOf(row), stepIdx: 0, round: 1, approved: {}, returns: [], history: [] });
  it.approved = { ...(it.approved || {}), D: d.abs };
  it.history.push({ at: Date.now(), action: 'manual_d', from: d.asset_id });
  let composed = false;
  if (['A', 'B', 'C'].every((s) => it.approved[s])) {
    // 缺口第 19 条：人工指定的 D 也要核（饮水机方位、幕墙、机位标注是不是本张的），拼板后起一轮拼板核对，过了才写回
    it.note = 'D 人工指定：' + d.name + '，拼板核对中';
    startCompose(projectId, w, aid, deps);
    composed = true;
  } else {
    it.note = 'D 已人工指定（' + d.name + '），等 A/B/C 审过后拼板';
  }
  saveWork(projectId, w);
  logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: row.name, manual_d: d.asset_id }, '人工指定 D：「' + row.name + '」取「' + d.name + '」的 D 格' + (composed ? '，已拼 2×2，拼板核对中（过了才写回）' : '，等 A/B/C'));
  return { asset_id: aid, from: d.asset_id, composed };
}

/** 写回原 asset_id（旧版进 versions）；父角色基础形象＝第一套服装的，同一张也写给父角色。 */
function finishWrite(projectId, w, aid, final) {
  const it = w.items[aid];
  const rel = writeAssetImage(projectId, aid, final, { source: 'am' });
  for (const pr of (getGapList(projectId).items || []).filter((x) => x.base_image_asset_id === aid && x.asset_id && x.status !== 'void')) {
    try { writeAssetImage(projectId, pr.asset_id, final, { source: 'am' }); } catch { /* 父行写不进去不影响本资产 */ }
  }
  Object.assign(it, { status: 'passed', image_path: rel, passed_at: Date.now() });
  if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
}

/** 拼 2×2，起一轮「拼板核对」审图（缺口第 19 条：D 和 A/B/C 是否一致；人工指定的 D 也核），过了才写回。 */
function startCompose(projectId, w, aid, deps = defaultDeps()) {
  const it = w.items[aid];
  const final = composeMv(['A', 'B', 'C', 'D'].map((s) => it.approved[s]), path.join(roundsDir(projectId, aid), 'MV_2x2_' + Date.now().toString(36) + '.png'));
  Object.assign(it, { step: 'compose', round: (it.compose_round || 0) + 1, file: final });
  it.compose_round = it.round;
  it.history.push({ at: Date.now(), action: 'compose', file: path.basename(final) });
  startReview(projectId, w, aid, deps);
}

/** 人工退回（缺口第 18 条）：某一行、某一格填退回意见，在原线程出 rN+1。行还没进 IC 出图（手工线导入）的，按车道挑线程新开。 */
export async function manualReturn(projectId, aid, { note = '', step = '' } = {}, deps = defaultDeps()) {
  if (!String(note).trim()) throw Object.assign(new Error('要写退回意见'), { code: 'NO_NOTE' });
  return withLock(projectId, async () => {
    const row = rowOf(projectId, aid);
    if (!row) throw Object.assign(new Error('缺图单里没有这一行'), { code: 'NO_ROW' });
    const w = loadWork(projectId);
    const it = w.items[aid] || (w.items[aid] = { name: row.name, lane: laneOf(row), steps: stepsOf(row), stepIdx: 0, round: 0, approved: {}, returns: [], history: [] });
    const want = String(step || '').toUpperCase() || (it.step && it.step !== 'compose' ? it.step : it.steps[it.steps.length - 1]);
    const idx = it.steps.indexOf(want === 'MAIN' ? 'main' : want);
    if (idx < 0) throw Object.assign(new Error('这一行没有「' + want + '」格（可选：' + it.steps.join('/') + '）'), { code: 'BAD_STEP' });
    if (!it.thread) {
      const threads = threadsOf(projectId).filter((t) => t.lane === it.lane);
      const busy = new Set(Object.entries(w.threads).filter(([, v]) => v && v.current).map(([k]) => k));
      const th = threads.find((t) => !busy.has(t.name)) || threads[0];
      if (!th) throw Object.assign(new Error('没有「' + it.lane + '」车道的 am 线程'), { code: 'NO_THREAD' });
      it.thread = th.name;
    }
    Object.assign(it, { stepIdx: idx, step: it.steps[idx], round: Math.max(1, it.round || 0) });
    if (it.approved) delete it.approved[it.step];
    w.threads[it.thread] = { current: aid };
    it.history.push({ at: Date.now(), action: 'manual_return', step: it.step, note });
    await sendBack(projectId, w, aid, '【人工退回】' + note, deps);
    saveWork(projectId, w);
    return { asset_id: aid, step: it.step, round: it.round, thread: it.thread, status: it.status };
  });
}

/** 人工审过（缺口第 21 条）：「需人工」等停住的那一格，人工判过（写理由，记成人工审核记录），接着往下走（下一格 / 拼板核对 / 写回）。 */
export function manualApprove(projectId, aid, { reason = '', step = '' } = {}, deps = defaultDeps()) {
  if (!String(reason).trim()) throw Object.assign(new Error('要写一句理由'), { code: 'NO_REASON' });
  const w = loadWork(projectId);
  const it = w.items[aid];
  if (!it) throw Object.assign(new Error('这一行还没进 IC 出图，没有可判的图'), { code: 'NO_ITEM' });
  const st = String(step || it.step || '').trim() || it.step;
  if (st !== it.step) throw Object.assign(new Error('只能判当前这一格（' + it.step + '）'), { code: 'BAD_STEP' });
  if (!it.file || !fs.existsSync(it.file)) throw Object.assign(new Error('当前这一格还没有回图，没法判过'), { code: 'NO_FILE' });
  if (['sent', 'reviewing'].includes(it.status)) throw Object.assign(new Error('这一格还在出图 / 审图中，等它停下再人工判'), { code: 'BUSY' });
  const rec = { verdict: 'pass', source: '人工审过', reason: String(reason).trim(), asset_id: aid, step: it.step, round: it.round, at: Date.now() };
  const f = path.join(roundsDir(projectId, aid), 'review_' + it.step + '_r' + it.round + '_manual.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  it.history.push({ at: Date.now(), action: 'manual_approve', step: it.step, round: it.round, reason: rec.reason });
  logJob(projectId, REVIEW_JOB, { asset_id: aid, name: it.name, step: it.step, round: it.round, manual: true }, '人工审过：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + '——' + rec.reason);
  if (it.step === 'compose') { finishWrite(projectId, w, aid, it.file); saveWork(projectId, w); return { asset_id: aid, next: 'written' }; }
  it.approved = { ...(it.approved || {}), [it.step]: it.file };
  let next = 'written';
  if (it.stepIdx < it.steps.length - 1) { it.stepIdx += 1; it.round = 1; it.status = 'next_step'; it.note = '人工审过 ' + it.step + '，排下一格'; next = 'next_step'; }
  else if (it.steps.length === 4) { startCompose(projectId, w, aid, deps); next = 'compose_review'; }
  else finishWrite(projectId, w, aid, it.file);
  saveWork(projectId, w);
  return { asset_id: aid, next };
}

/** 本张资产的旧版本（含当前图）里取 D 格（缺口第 23 条）。rel 必须是本资产 image_path 或 versions 里的。 */
function ownVersionD(projectId, aid, rel) {
  const a = Assets.get(aid);
  const list = [a && a.image_path, ...((a && a.versions) || [])].filter(Boolean);
  if (!list.includes(rel)) throw Object.assign(new Error('不是这张资产的版本：' + rel), { code: 'BAD_VERSION' });
  const abs = path.join(projectDir(projectId), rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error('旧版本文件不在了：' + rel), { code: 'NO_FILE' });
  return { asset_id: aid, name: a.name + '（本张旧版）', abs: cellImage(projectId, aid, abs, 'D', a.name) };
}
