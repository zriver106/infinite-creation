// 资产出图编排（总导 11-26：Andy「制作资产也是要走 ic 工作流不是我们这边单独搞」）。
// 每分钟一拍（tick）：① 收图：各线程当前单在 am 工作区有新回图 → 拉回存档 → 起审图任务；② 派单：空闲线程按车道取下一张发给 am。
// 审图任务结束 → 过：写回原 asset_id（_MV 进下一格，D 过后拼 2×2）；不过：原线程退回，轮次 +1。
// 卡住：发出后 10 分钟没回图提示核查，20 分钟标「待对账」——不自动重派（结果不明的不重派）。发送没确认的同样只标「待对账」。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, Assets, projectDir } from '../core/index.js';
import { getGapList } from '../core/asset-gaps.js';
import { amSend, amPut, amList, amGet, amPaths, amHistoryHas } from '../core/am-client.js';
import { loadWork, saveWork, threadsOf, laneOf, stepsOf, candidateRows, outPrefix, buildDispatchText, buildReviseText, composeMv, writeAssetImage, roundsDir, STALE_WARN_MIN, STALE_STOP_MIN, baseRefAbs, applyStageBaseRefs, locationDOf, cellImage, importedApprovedOf } from '../core/asset-image-work.js';
import { reviewResultPath, ASSET_IMAGE_SKILL } from './asset-image-review-mcp.js';
import { skillDir } from './skill-engine.js';
import { runExternalAgent } from './external/runner.js';
import { promptWriteAgentId } from './prompt-write.js';
import { loadConfig } from '../core/config.js';
import { runParallelText } from '../core/render-gate.js';
import { cellSpec } from './asset-cell-spec.js';
import { agentLimit } from '../core/agent-limits.js';

export const DISPATCH_JOB = 'asset-image-dispatch';
export const REVIEW_JOB = 'asset-image-review';
export const MAX_ROUNDS = 3;
const IMG = /\.(png|jpe?g|webp)$/i;
const MIN = 60 * 1000;

function template() {
  try { const f = path.join(skillDir(ASSET_IMAGE_SKILL), 'references', '派单模板.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; } catch { return ''; }
}
// _MV 并行（总导 11-26）：A 审过后 B/C/D 拆成子单「<asset_id>#B」各自派线程、各自审图；baseOf 取回原资产 id
export const baseOf = (aid) => String(aid || '').split('#')[0];
const rowOf = (projectId, aid) => (getGapList(projectId).items || []).find((x) => x.asset_id === baseOf(aid));
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
  cellSpec: (projectId, row, step) => cellSpec(projectId, row, step),
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
  // 本格可见清单（总导 11-26 第 1、2 类）：从布局表和站位表推算这一格应数出几排、每排几张，人坐哪侧面朝哪，屏幕 / 椅子看到哪面
  let spec = '';
  if (deps.cellSpec && /_MV/.test(String(row.name || '')) && step !== 'main') {
    const cs = await deps.cellSpec(projectId, row, step);
    spec = (cs && cs.text) || '';
    it.cell_spec = spec;
    if (!spec && cs && cs.error) it.history.push({ at: Date.now(), action: 'cell_spec_failed', step, error: cs.error });
  }
  const text = buildDispatchText(row, { step, round: it.round, style, template: template(), outFile, refRemote, attachRemote: attach, reuseD, kind: row.kind === 'scene' ? 'scene' : row.kind === 'prop' ? 'prop' : 'character', cellSpec: spec });
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
  const sent = th ? await deps.send(th.session, buildReviseText(row, { step: it.step, round: it.round, note, outFile: it.out_file, cellSpec: it.cell_spec || '' })) : { confirmed: false, error: '线程没了' };
  Object.assign(it, { sent_at: Date.now(), status: sent.confirmed ? 'sent' : 'unconfirmed', file: '' });
  it.history.push({ at: Date.now(), action: 'return', step: it.step, round: it.round, confirmed: !!sent.confirmed });
  logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: row.name, step: it.step, round: it.round, thread: it.thread, returned: true }, '退回返修 r' + it.round + '：「' + row.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + '——' + String(note).slice(0, 300));
}

/** 起审图任务（外部 Agent，受限工具集）；结束后读结论接着走。 */
function startReview(projectId, w, aid, deps) {
  const it = w.items[aid];
  const par = it.parent ? w.items[it.parent] : null;
  const sibs = { ...((par && par.approved) || {}), ...(it.approved || {}) };
  if (it.step !== 'compose') delete sibs[it.step];
  const cp = { asset_id: baseOf(aid), work_key: aid, name: it.name, step: it.step, round: it.round, file: it.file, approved: sibs, cell_spec: it.cell_spec || '', previous_returns: it.returns, assetImageReview: true, ...(it.step === 'compose' && dBorrowed(it, aid) ? { reused_d: true } : {}), ...(it.rereview ? { rereview: it.rereview.n } : {}) };
  const job = Jobs.create({ projectId, type: REVIEW_JOB, checkpoint: cp });
  it.status = 'reviewing'; it.review_job = job.id; delete it.pre_return;
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
    const resF = reviewResultPath(projectId, { asset_id: baseOf(aid), step: it.step, round: it.round, rereview: it.rereview ? it.rereview.n : 0 });
    if (!fs.existsSync(resF)) {
      if (it.rereview) { it.last_rereview = { n: it.rereview.n, verdict: 'no_result', at: Date.now() }; delete it.rereview; }
      it.status = 'review_failed'; it.note = '审图任务没交结论' + (agentErr && agentErr.message ? '：' + agentErr.message : '');
      Jobs.update(jobId, { status: 'failed', phase: '失败', error: it.note, finishedAt: Date.now() });
      saveWork(projectId, w); return;
    }
    const res = JSON.parse(fs.readFileSync(resF, 'utf8'));
    Jobs.update(jobId, { status: 'done', phase: '完成', detail: (res.verdict === 'pass' ? '审过' : '退回') + '：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + (res.return_note ? '——' + res.return_note.slice(0, 300) : ''), finishedAt: Date.now() });
    it.history.push({ at: Date.now(), action: 'review', step: it.step, round: it.round, verdict: res.verdict, job: jobId });
    if (it.rereview) { finishRereview(projectId, w, aid, res); saveWork(projectId, w); return; }
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
    stepPassed(projectId, w, aid, deps);
    saveWork(projectId, w);
  });
}

/** 这一格审过（审图过 / 人工审过）之后往下走。返回 next_step | parallel | child_done | compose_review | written。 */
function stepPassed(projectId, w, aid, deps) {
  const it = w.items[aid];
  it.approved = { ...(it.approved || {}), [it.step]: it.file };
  if (it.parent) return childDone(projectId, w, aid, deps);
  if (it.steps.length === 4 && it.step === 'A' && !it.redo_only) return fanOut(projectId, w, aid, deps);
  // 重审退回只重出退回的那一格：其余格已审过（从写回的 2×2 裁出来的）就跳过，直接拼板核对
  let nx = it.stepIdx + 1;
  if (it.redo_only) while (nx < it.steps.length && it.approved[it.steps[nx]]) nx += 1;
  if (nx < it.steps.length) { it.stepIdx = nx; it.round = 1; it.status = 'next_step'; return 'next_step'; }
  delete it.redo_only;
  if (it.steps.length === 4) { startCompose(projectId, w, aid, deps); return 'compose_review'; }
  finishWrite(projectId, w, aid, it.file);
  return 'written';
}

/** _MV 的 A 审过：B、C（和不能复用的 D）拆成子单同时派给空闲线程、各自审图；D 能复用同地点已定稿 _MV 的就直接用，不派 am。 */
function fanOut(projectId, w, aid, deps) {
  const it = w.items[aid];
  const row = rowOf(projectId, aid);
  const subs = [];
  for (const s of ['B', 'C', 'D']) {
    if (it.approved[s]) continue;
    if (s === 'D') {
      const d = row ? locationDOf(projectId, row) : null;
      if (d) { it.approved.D = d.abs; it.history.push({ at: Date.now(), action: 'reuse_d', from: d.asset_id }); continue; }
    }
    const key = aid + '#' + s;
    w.items[key] = { name: it.name, lane: it.lane, steps: [s], stepIdx: 0, step: s, round: 1, approved: { A: it.approved.A }, returns: [], history: [{ at: Date.now(), action: 'fan_out' }], parent: aid, status: 'next_step', thread: '' };
    subs.push(s);
  }
  if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
  it.children = subs.map((s) => aid + '#' + s);
  it.history.push({ at: Date.now(), action: 'fan_out', steps: subs });
  if (!subs.length) { startCompose(projectId, w, aid, deps); return 'compose_review'; }
  Object.assign(it, { status: 'parallel', note: 'A 已审过，' + subs.join('、') + ' 格并行出图' + (it.approved.D ? '；D 复用同地点已定稿的' : '') });
  return 'parallel';
}

/** 子单审过：交给母单；B/C/D 都齐了就拼 2×2、起拼板核对。 */
function childDone(projectId, w, aid, deps) {
  const it = w.items[aid]; const par = w.items[it.parent];
  it.status = 'passed'; it.note = '';
  if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
  if (!par) return 'child_done';
  par.approved = { ...(par.approved || {}), [it.step]: it.file };
  par.history.push({ at: Date.now(), action: 'child_passed', step: it.step });
  if (['A', 'B', 'C', 'D'].every((s) => par.approved[s])) { startCompose(projectId, w, it.parent, deps); return 'compose_review'; }
  par.note = '并行出图中：已审过 ' + ['B', 'C', 'D'].filter((s) => par.approved[s]).join('、') + '，还差 ' + ['B', 'C', 'D'].filter((s) => !par.approved[s]).join('、');
  return 'child_done';
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
        const voided = (w.voided_prefixes || []);
        const fresh = (x) => !used.has(key(x)) && !voided.some((vp) => x.name.startsWith(vp)) && (!x.modifiedAt || Date.parse(x.modifiedAt) >= (it.sent_at || 0) - 60000);
        const f = files.find((x) => IMG.test(x.name) && fresh(x) && x.name.startsWith(it.prefix))
          || files.filter((x) => IMG.test(x.name) && !x.name.startsWith('media-generation') && fresh(x) && (x.name.includes(it.name) || x.name.includes(nm)) && (it.step === 'main' || new RegExp('_' + it.step + '(_|\.|$)').test(x.name))).sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))[0];
        if (f) {
          const local = path.join(roundsDir(projectId, baseOf(aid)), it.step + '_r' + it.round + '_' + f.name);
          const g = await deps.get(p.outDir + '/' + f.name, local);
          if (g && g.ok) { (w.consumed = w.consumed || []).push(key(f)); it.file = local; it.history.push({ at: Date.now(), action: 'received', step: it.step, round: it.round, file: f.name }); startReview(projectId, w, aid, deps); continue; }
        }
        const age = (Date.now() - (it.sent_at || 0)) / MIN;
        if (age >= STALE_STOP_MIN) { it.status = 'stale'; it.note = STALE_STOP_MIN + ' 分钟没回图：待对账（不自动重派）'; }
        else if (age >= STALE_WARN_MIN) { it.status = 'stale_warn'; it.note = STALE_WARN_MIN + ' 分钟没回图，核查中'; }
      }
    }
    // ①½ 重审没过、排队退回的：按原线程退回（原线程在忙就等它空）；手工线导入的没有原线程，取同车道空闲线程。附上原图和其余已审过的格
    for (const [aid, it] of Object.entries(w.items)) {
      if (it.status !== 'return_queued') continue;
      const busyNow = new Set(Object.entries(w.threads).filter(([, v]) => v && v.current && v.current !== aid).map(([k]) => k));
      const own = threads.find((t) => t.name === it.thread);
      const th = own ? (busyNow.has(own.name) ? null : own) : threads.find((t) => t.lane === it.lane && !busyNow.has(t.name));
      if (!th) continue;
      it.thread = th.name; w.threads[th.name] = { current: aid };
      let note = it.pending_return || '【重审退回】';
      if (it.rereview_src && fs.existsSync(it.rereview_src)) {
        const remote = p.refDir + '/' + String(aid).slice(0, 8) + '_rr_' + it.step + path.extname(it.rereview_src);
        const r = await deps.put(it.rereview_src, remote); if (r && r.ok) note += '\n原图（照它改，只改上面说的地方）：' + remote;
      }
      for (const s of Object.keys(it.approved || {})) {
        const remote = p.refDir + '/' + String(aid).slice(0, 8) + '_' + s + '_ok' + path.extname(it.approved[s]);
        const r = await deps.put(it.approved[s], remote); if (r && r.ok) note += '\n已审过的 ' + s + ' 格（对照用，不重画）：' + remote;
      }
      delete it.pending_return;
      await sendBack(projectId, w, aid, note, deps);
    }
    // ② 派单（暂停时不派新单，在途的照常收图审图）：先接着派 _MV 的下一格（同线程），再给空闲线程派新单
    if (!w.running) { saveWork(projectId, w); return summary(w); }
    for (const [aid, it] of Object.entries(w.items)) {
      if (it.status !== 'next_step') continue;
      let th = threads.find((t) => t.name === it.thread);
      if (!th && it.parent) {
        // 子单：同车道空闲线程，先给母单原来的线程
        const busyNow = new Set(Object.entries(w.threads).filter(([, v]) => v && v.current).map(([k]) => k));
        const pth = (w.items[it.parent] || {}).thread;
        th = threads.find((t) => t.lane === it.lane && t.name === pth && !busyNow.has(t.name)) || threads.find((t) => t.lane === it.lane && !busyNow.has(t.name));
      }
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
  const inflight = Object.values(w.items || {}).some((it) => ['sent', 'stale_warn', 'reviewing', 'return_queued'].includes(it.status));
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
  if (w.items[aid] && w.items[aid].status === 'parallel') throw Object.assign(new Error('B/C/D 并行出图中，等它们出完再指定 D'), { code: 'PARALLEL' });
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
    if (it.status === 'parallel') throw Object.assign(new Error('B/C/D 并行出图中：退回请在下面「↳ 某格」那一行做'), { code: 'PARALLEL' });
    if (it.steps.length > 1 && !String(step || '').trim()) throw Object.assign(new Error('_MV 要自己选退哪一格（A/B/C/D），不默认'), { code: 'NO_STEP' });
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
    it.pre_return = { stepIdx: it.stepIdx, step: it.step, round: it.round, approved: { ...(it.approved || {}) }, status: it.status, note: it.note || '' };
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
  const f = path.join(roundsDir(projectId, baseOf(aid)), 'review_' + it.step + '_r' + it.round + '_manual.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  it.history.push({ at: Date.now(), action: 'manual_approve', step: it.step, round: it.round, reason: rec.reason });
  logJob(projectId, REVIEW_JOB, { asset_id: aid, name: it.name, step: it.step, round: it.round, manual: true }, '人工审过：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + '——' + rec.reason);
  if (it.step === 'compose') { finishWrite(projectId, w, aid, it.file); saveWork(projectId, w); return { asset_id: aid, next: 'written' }; }
  const next = stepPassed(projectId, w, aid, deps);
  if (next === 'next_step') it.note = '人工审过 ' + it.step + '，排下一格';
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

// ── 重审（总导 11-26：手工线导入成已审定稿的图 IC 从没审过，Andy 退回了 L01 工位区 _MV）──
// 用现在的审图 Agent 和必核项重审已经写回的图。过了不动；不过按 on_fail：needs_human 标「需人工」（图不动），return 按原线程退回那一格。
export const REREVIEW_ON_FAIL = ['needs_human', 'return'];
export const REREVIEW_SCOPES = ['imported', 'all'];
const BUSY = ['sent', 'unconfirmed', 'stale_warn', 'reviewing', 'next_step', 'return_queued', 'parallel'];

/** 要重审的行：给了 asset_ids 就只看这些；否则 scope=imported（手工线导入的）/ all（已写回的全部）。在途的跳过并写明。 */
export function rereviewTargets(projectId, { scope = '', asset_ids = null } = {}) {
  const w = loadWork(projectId);
  const ids = Array.isArray(asset_ids) && asset_ids.length ? new Set(asset_ids.map(String)) : null;
  const targets = []; const skipped = [];
  for (const x of (getGapList(projectId).items || [])) {
    if (x.status === 'void' || x.need_image === false || !x.asset_id) continue;
    if (ids && !ids.has(x.asset_id)) continue;
    const imported = !!importedApprovedOf(projectId, x.asset_id);
    if (!ids && scope === 'imported' && !imported) continue;
    const a = Assets.get(x.asset_id);
    if (!a || !a.image_path || !fs.existsSync(path.join(projectDir(projectId), a.image_path))) { if (ids) skipped.push({ asset_id: x.asset_id, name: x.name, why: '还没有写回的图' }); continue; }
    const it = w.items[x.asset_id];
    if (it && BUSY.includes(it.status)) { skipped.push({ asset_id: x.asset_id, name: x.name, why: '正在出图 / 审图（' + it.status + '），等它停下再重审' }); continue; }
    targets.push({ row: x, asset: a, imported });
  }
  return { targets, skipped };
}

export function reReview(projectId, { asset_ids = null, scope = '', on_fail = 'needs_human' } = {}, deps = defaultDeps()) {
  if (!REREVIEW_ON_FAIL.includes(on_fail)) throw Object.assign(new Error('on_fail 只能是 ' + REREVIEW_ON_FAIL.join(' / ')), { code: 'BAD_ON_FAIL' });
  if (!(Array.isArray(asset_ids) && asset_ids.length) && !REREVIEW_SCOPES.includes(scope)) throw Object.assign(new Error('给 asset_ids，或 scope = imported（手工线导入的）/ all（已写回的全部）'), { code: 'BAD_SCOPE' });
  return withLock(projectId, async () => {
    const { targets, skipped } = rereviewTargets(projectId, { scope, asset_ids });
    const w = loadWork(projectId);
    for (const { row, asset } of targets) {
      const aid = row.asset_id;
      const isMv = /_MV/.test(String(row.name || ''));
      const it = w.items[aid] || (w.items[aid] = { name: row.name, lane: laneOf(row), steps: stepsOf(row), stepIdx: 0, round: 0, approved: {}, returns: [], history: [] });
      const abs = path.join(projectDir(projectId), asset.image_path);
      const n = (it.rereview_count || 0) + 1;
      it.rereview_count = n;
      it.rereview = { n, on_fail, image_path: asset.image_path };
      it.approved = isMv ? Object.fromEntries(['A', 'B', 'C', 'D'].map((c) => [c, cellImage(projectId, aid, abs, c, row.name)])) : {};
      Object.assign(it, { step: isMv ? 'compose' : 'main', stepIdx: it.steps.length - 1, round: Math.max(1, it.round || 0), file: abs, note: '重审中（第 ' + n + ' 次）' });
      it.history.push({ at: Date.now(), action: 'rereview_start', n, on_fail, image_path: asset.image_path });
      startReview(projectId, w, aid, deps);
    }
    saveWork(projectId, w);
    if (targets.length || skipped.length) logJob(projectId, REVIEW_JOB, { rereview: true, scope: scope || 'selected', on_fail, count: targets.length }, '重审：' + targets.length + ' 张进审图' + (skipped.length ? '，跳过 ' + skipped.length + ' 张（' + skipped.slice(0, 5).map((x) => x.name + '：' + x.why).join('；') + '）' : '') + '；不过时' + (on_fail === 'return' ? '按原线程退回' : '标需人工'));
    return { queued: targets.map((t) => ({ asset_id: t.row.asset_id, name: t.row.name, imported: t.imported })), skipped, on_fail };
  });
}

/** 重审结论：过 → 已通过（图不动）；不过 → 需人工，或排队按原线程退回那一格（只重出那一格，其余格沿用，重出后拼板核对过了才写回）。 */
function finishRereview(projectId, w, aid, res) {
  const it = w.items[aid]; const rr = it.rereview; delete it.rereview;
  const note = String(res.return_note || '');
  it.last_rereview = { n: rr.n, verdict: res.verdict, on_fail: rr.on_fail, at: Date.now(), note: note.slice(0, 300) };
  it.history.push({ at: Date.now(), action: 'rereview', n: rr.n, verdict: res.verdict });
  if (res.verdict === 'pass') { Object.assign(it, { status: 'passed', note: '重审过（第 ' + rr.n + ' 次），图没动' }); return; }
  if (res.verdict !== 'return' || rr.on_fail === 'needs_human') { Object.assign(it, { status: 'needs_human', note: '重审没过（图没动，等人看）：' + note.slice(0, 200) }); return; }
  const isMv = it.steps.length === 4;
  const redo = isMv ? String(res.redo_step || 'A').toUpperCase() : 'main';
  const idx = Math.max(0, it.steps.indexOf(redo));
  const src = (it.approved || {})[redo] || it.file;
  if (isMv) delete it.approved[redo]; else it.approved = {};
  Object.assign(it, { stepIdx: idx, step: it.steps[idx], status: 'return_queued', redo_only: true, rereview_src: src, pending_return: '【重审退回】' + note, note: '重审没过，排队退回' + (isMv ? ' ' + redo + ' 格' : '') + '（等原线程空闲）：' + note.slice(0, 160) });
}

/** 撤回在途的单（缺口第 13 条）：退错了 / 派错了的那一单，在原线程补发一条「作废上一条」，它交回来的图不收（按文件前缀记作废）。
 *  人工退回撤回时，恢复退回前的已审格；这一行标「需人工」，等人重新退回或审过。审图中的不能撤（等它出结论）。 */
export async function cancelInflight(projectId, aid, { reason = '' } = {}, deps = defaultDeps()) {
  if (!String(reason).trim()) throw Object.assign(new Error('要写一句撤回原因'), { code: 'NO_REASON' });
  return withLock(projectId, async () => {
    const w = loadWork(projectId);
    const it = w.items[aid];
    if (!it) throw Object.assign(new Error('这一行没有在途的单'), { code: 'NO_ITEM' });
    if (it.status === 'reviewing') throw Object.assign(new Error('这一格在审图中，等审图出结论再处理'), { code: 'BUSY' });
    if (!['sent', 'unconfirmed', 'stale_warn', 'stale', 'return_queued'].includes(it.status)) throw Object.assign(new Error('这一行不在途（' + it.status + '），没有可撤的单'), { code: 'NOT_INFLIGHT' });
    let sent = null;
    if (it.status !== 'return_queued') {
      (w.voided_prefixes = w.voided_prefixes || []).push(it.prefix);
      const th = threadsOf(projectId).find((t) => t.name === it.thread);
      const text = '【作废】上一条指令作废：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + '（文件名 ' + it.prefix + ' 开头那张）不要再画；已经画了也不用交，交了 IC 也不收。原因：' + String(reason).trim() + '。等下一条指令。';
      sent = th ? await deps.send(th.session, text) : { confirmed: false, error: '线程没了' };
    }
    const undo = it.pre_return;
    if (undo && (it.history || []).slice(-1)[0] && ['return', 'manual_return'].includes(it.history.slice(-1)[0].action)) {
      Object.assign(it, { stepIdx: undo.stepIdx, step: undo.step, approved: undo.approved });
    }
    delete it.pre_return; delete it.pending_return;
    Object.assign(it, { status: 'needs_human', note: '已撤回 ' + (it.step !== 'main' ? it.step + ' 格 ' : '') + 'r' + it.round + '：' + String(reason).trim() + (sent && !sent.confirmed ? '（作废通知发送未确认，去线程里核一下）' : '') });
    it.history.push({ at: Date.now(), action: 'cancel', step: it.step, round: it.round, prefix: it.prefix || '', reason: String(reason).trim(), notified: sent ? !!sent.confirmed : null });
    if (w.threads[it.thread] && w.threads[it.thread].current === aid) w.threads[it.thread].current = null;
    saveWork(projectId, w);
    logJob(projectId, DISPATCH_JOB, { asset_id: aid, name: it.name, cancel: true, prefix: it.prefix || '' }, '撤回：「' + it.name + '」' + (it.step !== 'main' ? it.step + ' 格' : '') + ' r' + it.round + (sent ? (sent.confirmed ? '，已在原线程发作废' : '，作废通知发送未确认') : '（还没发出，直接取消）') + '——' + String(reason).trim());
    return { asset_id: aid, status: it.status, step: it.step, notified: sent ? !!sent.confirmed : null };
  });
}

/** D 是不是借来的（总导 11-26）：最近一次定 D 是自动复用同地点 _MV 的，或人工指定了别的 _MV 的 D → 拼板核对机位标注不算不一致；人工取本张旧版本的 D 照旧核机位标注。 */
function dBorrowed(it, aid) {
  const last = (it.history || []).filter((h) => h.action === 'reuse_d' || h.action === 'manual_d').slice(-1)[0];
  if (!last) return false;
  return last.action === 'reuse_d' || (last.from && last.from !== baseOf(aid));
}
