// ic25 重启恢复接管（2026-11-17，第19章残留镜 / 第21章 23599dfe 复盘，上下文见 草稿/第19章残留镜_20261117/流程修复/ic25_重启恢复接管/）。
//
// 背景：后端重启时 startupCleanup 把 running 任务一律标 interrupted。外部 Agent（claude.exe）是独立进程，旧后端没了它照样在出镜，
// 可守护把 interrupted 当「结果不明」、项目也不算忙；重启恢复的「自动继续 / 自动续章」没有不重启就能关的开关；
// 对外部进程的监视只在内存里，再重启一次就没人接手。本模块做三件事（每件都有 IC_DISABLE_* 紧急开关）：
//
//  1) 接管状态 adopted（被重启恢复接管、等外部 Agent 进程退出）：启动清理前先查进程表，外部 Agent 还活着的出片任务
//     不标 interrupted，标 adopted。adopted 算「活动任务」（守护判忙、同章去重、清章节都挡），但不是本进程的执行者：
//     取消 / 停止只是「放弃接管」（落 cancelled），不打断 ComfyUI、不杀外部进程。     关：IC_DISABLE_RECOVERY_ADOPT=1
//  2) 运行时开关 DATA_DIR/control/restart-recovery.json（每次判定时现读，不用重启）：只记录 / 不自动继续 / 不触发续章。
//                                                                                   关：IC_DISABLE_RECOVERY_CONTROL=1
//  3) 监视检查点 DATA_DIR/recovery/adopted-jobs.json：记下被监视的外部进程（pid + 启动时间 + 命令行指纹），后端再重启时
//     接着监视同一个进程；pid 被复用（启动时间或命令行对不上）不算活着。                关：IC_DISABLE_RECOVERY_CHECKPOINT=1
//
// 不写 SQL（状态走 Jobs.update；startupCleanup 里的批量 UPDATE 是它原有的写法）、不杀进程、不调 /run、不碰 ComfyUI。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Jobs, logger, withWriteContext, DATA_DIR } from '../core/index.js';

export const ADOPTED = 'adopted';
export const WAITING_TEXT = '重启恢复正在等外部 Agent 退出';

const on = (v) => v === '1' || v === 'true';
export function adoptDisabled(env = process.env) { return on(env && env.IC_DISABLE_RECOVERY_ADOPT); }
export function controlDisabled(env = process.env) { return on(env && env.IC_DISABLE_RECOVERY_CONTROL); }
export function checkpointDisabled(env = process.env) { return on(env && env.IC_DISABLE_RECOVERY_CHECKPOINT); }

export function controlFile() { return path.join(DATA_DIR, 'control', 'restart-recovery.json'); }
export function watchFile() { return path.join(DATA_DIR, 'recovery', 'adopted-jobs.json'); }
export function recoveryLogFile() { return path.join(DATA_DIR, 'logs', 'restart-recovery.jsonl'); }

/** 审计日志：一行一条 JSON。写不进去不影响恢复。 */
export function recoveryLog(entry) {
  try {
    const f = recoveryLogFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n', 'utf8');
  } catch { /* noop */ }
}

/** 出片任务（与 pickInterruptedJobs 同口径）：create + 带章节。 */
export function isRecoverableJob(j) { return !!j && j.type === 'create' && !!(j.checkpoint && j.checkpoint.chapter); }

// ———————————————————— 进程表 ————————————————————

export const cmdSig = (cmd) => crypto.createHash('sha1').update(String(cmd || '')).digest('hex').slice(0, 16);

/**
 * 命令行含 agent-workspaces 的进程：[{ pid, ppid, startMs, cmd }]；查不到进程表返回 null（状态不明）。
 * startMs = 进程创建时间（epoch ms），用于识别 pid 复用。
 */
export function listAgentProcesses() {
  try {
    if (process.platform === 'win32') {
      const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $l = @(Get-CimInstance Win32_Process -Filter \"CommandLine like '%agent-workspaces%'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; startMs = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); cmd = [string]$_.CommandLine } }); ConvertTo-Json -InputObject $l -Compress -Depth 3";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0 || r.error) return null;
      const txt = String(r.stdout || '').trim();
      if (!txt) return [];
      const arr = JSON.parse(txt);
      return (Array.isArray(arr) ? arr : [arr]).filter(Boolean).map((p) => ({ pid: Number(p.pid), ppid: Number(p.ppid) || 0, startMs: Number(p.startMs) || 0, cmd: String(p.cmd || '') }))
        .filter((p) => p.pid !== process.pid);
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0 || r.error) return null;
    const t = Date.now();
    return String(r.stdout || '').split('\n').filter((l) => l.includes('agent-workspaces')).map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      if (!m) return null;
      // etimes 是整秒：startMs 只精确到秒，比对时留容差
      return { pid: Number(m[1]), ppid: Number(m[2]), startMs: Math.round((t - Number(m[3]) * 1000) / 1000) * 1000, cmd: m[4] };
    }).filter((p) => p && p.pid !== process.pid);
  } catch {
    return null;
  }
}

/** 命令行是否属于这个任务的外部 Agent（agent-workspaces/<jobId>/...，与 restart-recovery.agentAlive 同一个正则）。 */
export function cmdMatchesJob(cmd, jobId) {
  const re = new RegExp('agent-workspaces[\\\\/]+' + String(jobId).replace(/[^0-9a-zA-Z-]/g, '') + '([\\\\/"\\s]|$)');
  return re.test(String(cmd || ''));
}

export function procsOfJob(procs, jobId) { return (procs || []).filter((p) => cmdMatchesJob(p.cmd, jobId)); }

const START_TOLERANCE_MS = 2500;

/** 记下的进程是否还是「同一个进程」：pid 在、启动时间对得上、命令行指纹一致。pid 复用 → false。 */
export function sameProcess(rec, live) {
  if (!rec || !live) return false;
  if (Number(rec.pid) !== Number(live.pid)) return false;
  if (rec.startMs && live.startMs && Math.abs(Number(rec.startMs) - Number(live.startMs)) > START_TOLERANCE_MS) return false;
  if (rec.cmdSig && rec.cmdSig !== cmdSig(live.cmd)) return false;
  return true;
}

/**
 * 判定外部 Agent 是否还活着：true / false / null（进程表不可用）。
 * 有检查点（记过 pid）→ 只认同一个进程（防 pid 复用）；没有 → 按命令行匹配（ic25 之前的口径）。
 */
export function aliveByEntry(jobId, entry, procs) {
  if (!Array.isArray(procs)) return null;
  const recs = entry && Array.isArray(entry.procs) ? entry.procs : [];
  if (recs.length) return recs.some((rec) => procs.some((p) => sameProcess(rec, p)));
  return procsOfJob(procs, jobId).length > 0;
}

const toRec = (p) => ({ pid: p.pid, ppid: p.ppid || 0, startMs: p.startMs || 0, cmdSig: cmdSig(p.cmd), cmd: String(p.cmd || '').slice(0, 300) });

// ———————————————————— 监视检查点（文件） ————————————————————

export function readWatch() {
  if (checkpointDisabled()) return { version: 1, jobs: {} };
  try {
    const j = JSON.parse(fs.readFileSync(watchFile(), 'utf8'));
    return j && typeof j === 'object' && j.jobs && typeof j.jobs === 'object' ? j : { version: 1, jobs: {} };
  } catch {
    return { version: 1, jobs: {} };
  }
}

function writeWatch(w) {
  if (checkpointDisabled()) return;
  const f = watchFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), jobs: w.jobs || {} }, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    logger.warn('重启恢复：写监视检查点失败', { error: e && e.message });
  }
}

export function getWatchEntry(jobId) { return readWatch().jobs[jobId] || null; }

export function putWatchEntry(jobId, patch) {
  if (checkpointDisabled()) return null;
  const w = readWatch();
  w.jobs[jobId] = { ...(w.jobs[jobId] || {}), ...patch, jobId };
  writeWatch(w);
  return w.jobs[jobId];
}

export function dropWatchEntry(jobId) {
  if (checkpointDisabled()) return;
  const w = readWatch();
  if (!w.jobs[jobId]) return;
  delete w.jobs[jobId];
  writeWatch(w);
}

/** 带检查点的存活判定（restart-recovery 默认用它）。 */
export function trackedAgentAlive(jobId, lister = listAgentProcesses) {
  return aliveByEntry(jobId, getWatchEntry(jobId), lister());
}

// ———————————————————— 运行时开关（控制文件） ————————————————————

const DEFAULT_CONTROL = { reportOnly: false, resume: true, chain: true };
const MODES = {
  auto: { reportOnly: false, resume: true, chain: true },
  'report-only': { reportOnly: true, resume: false, chain: false },
  'no-resume': { reportOnly: false, resume: false, chain: true },
  'no-chain': { reportOnly: false, resume: true, chain: false },
  'manual': { reportOnly: false, resume: false, chain: false },
};

function applyLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return base;
  let out = { ...base };
  if (typeof layer.mode === 'string') {
    if (!MODES[layer.mode]) throw new Error('未知 mode：' + layer.mode);
    out = { ...MODES[layer.mode] };
  }
  for (const k of ['reportOnly', 'resume', 'chain']) if (typeof layer[k] === 'boolean') out[k] = layer[k];
  return out;
}

/**
 * 每次现读控制文件。文件不存在 → 默认（与 ic25 之前一样自动处理）。文件坏了 → 按最保守的「只记录」处理并写日志。
 * 格式：{ "mode": "auto|report-only|no-resume|no-chain|manual", "reportOnly": bool, "resume": bool, "chain": bool,
 *         "projects": { "<projectId>": { 同上，覆盖全局 } } }
 * @returns {{reportOnly:boolean, resume:boolean, chain:boolean, source:string}}
 */
export function readRecoveryControl(projectId = '') {
  if (controlDisabled()) return { ...DEFAULT_CONTROL, source: 'disabled' };
  let raw;
  try { raw = fs.readFileSync(controlFile(), 'utf8'); } catch { return { ...DEFAULT_CONTROL, source: 'default' }; }
  try {
    const j = JSON.parse(raw);
    let c = applyLayer({ ...DEFAULT_CONTROL }, j);
    let source = 'file';
    const pj = projectId && j && j.projects && j.projects[projectId];
    if (pj) { c = applyLayer(c, pj); source = 'file:project'; }
    if (c.reportOnly) { c.resume = false; c.chain = false; }
    return { ...c, source };
  } catch (e) {
    logger.warn('重启恢复：控制文件读不懂，按「只记录」处理', { file: controlFile(), error: e && e.message });
    return { reportOnly: true, resume: false, chain: false, source: 'invalid' };
  }
}

export function describeControl(c) {
  if (c.reportOnly) return '只记录';
  const parts = [];
  if (!c.resume) parts.push('不自动继续');
  if (!c.chain) parts.push('不触发续章');
  return parts.length ? parts.join('、') : '自动';
}

/** 给守护：本项目的出片续章是否被运行时开关暂停（chain=false）。返回原因或 ''。 */
export function chainHoldReason(projectId) {
  const c = readRecoveryControl(projectId);
  if (c.chain) return '';
  return '运行时开关暂停续章（' + describeControl(c) + '，' + path.relative(DATA_DIR, controlFile()).replace(/\\/g, '/') + '）';
}

// ———————————————————— 启动时接管 ————————————————————

/**
 * 启动清理之前调用（server.js）。挑出 running / adopted 的出片任务，查进程表：外部 Agent 还活着的 → 接管。
 * 只做判定，不写库；返回给 startupCleanup({ adopt }) 和 commitAdoption。
 * @returns {{ adopt:string[], entries:object[], procsAvailable:boolean, skipped?:string }}
 */
export function planAdoptionAtBoot({ bootAt = Date.now(), lister = listAgentProcesses, jobs } = {}) {
  if (adoptDisabled()) return { adopt: [], entries: [], procsAvailable: false, skipped: 'IC_DISABLE_RECOVERY_ADOPT=1' };
  let cands;
  try { cands = (jobs || Jobs.list()).filter((j) => (j.status === 'running' || j.status === ADOPTED) && isRecoverableJob(j)); } catch (e) {
    return { adopt: [], entries: [], procsAvailable: false, skipped: '读取任务失败：' + (e && e.message) };
  }
  if (!cands.length) return { adopt: [], entries: [], procsAvailable: true };
  const procs = lister();
  if (!Array.isArray(procs)) {
    // 进程表不可用：running 照旧标 interrupted（ic25 之前的行为）；已接管的保持接管，交给恢复模块轮询判定
    const keep = cands.filter((j) => j.status === ADOPTED);
    return { adopt: keep.map((j) => j.id), entries: keep.map((j) => ({ job: j, procs: null, again: true, probe: 'unavailable' })), procsAvailable: false };
  }
  const watch = readWatch();
  const adopt = [];
  const entries = [];
  for (const j of cands) {
    const entry = watch.jobs[j.id] || null;
    if (!aliveByEntry(j.id, entry, procs)) continue;
    const mine = entry && Array.isArray(entry.procs) && entry.procs.length
      ? entry.procs.filter((rec) => procs.some((p) => sameProcess(rec, p)))
      : procsOfJob(procs, j.id).map(toRec);
    adopt.push(j.id);
    entries.push({ job: j, procs: mine, again: j.status === ADOPTED || !!entry, bootAt });
  }
  return { adopt, entries, procsAvailable: true };
}

/** startupCleanup 之后调用：写 detail、日志、监视检查点。 */
export function commitAdoption(plan, { bootAt = Date.now() } = {}) {
  if (!plan || !plan.entries || !plan.entries.length) return [];
  const out = [];
  for (const e of plan.entries) {
    const j = Jobs.get(e.job.id);
    if (!j || j.status !== ADOPTED) continue;
    const pids = (e.procs || []).map((p) => p.pid).join(',');
    const text = (e.again ? '后端再次重启，接着监视' : '后端重启时外部 Agent 进程仍在运行，任务改为「接管中」') + '：' + WAITING_TEXT + (pids ? '（pid ' + pids + '）' : '') + '，退出后再判定完成 / 继续';
    withWriteContext('job:restart-recovery', () => {
      Jobs.update(j.id, { phase: '接管中：等外部 Agent 退出', detail: String(j.detail || '').slice(0, 1800) + '\n\n【重启恢复】' + text });
    });
    const prev = getWatchEntry(j.id) || {};
    if (Array.isArray(e.procs)) {
      putWatchEntry(j.id, {
        projectId: j.projectId, chapter: String(j.checkpoint.chapter || ''),
        adoptedAt: prev.adoptedAt || bootAt, lastBootAt: bootAt, boots: (prev.boots || 0) + 1,
        procs: prev.procs && prev.procs.length ? prev.procs : e.procs, lastAliveAt: bootAt,
      });
    }
    recoveryLog({ event: e.again ? 'readopt' : 'adopt', jobId: j.id, projectId: j.projectId, chapter: j.checkpoint.chapter, procs: (e.procs || []).map((p) => ({ pid: p.pid, startMs: p.startMs })), text });
    logger.info('重启恢复：' + text, { jobId: j.id, chapter: j.checkpoint.chapter });
    out.push({ jobId: j.id, again: !!e.again, pids });
  }
  return out;
}

/**
 * 接管任务离开 adopted（判定完成 / 退回 interrupted / 放弃接管）。同时删掉监视检查点。
 * @param {'done'|'interrupted'|'cancelled'} status
 */
export function leaveAdopted(jobId, status, text, extra = {}) {
  const cur = Jobs.get(jobId);
  if (!cur) return null;
  const fields = { status, detail: String(cur.detail || '').slice(0, 1800) + '\n\n【重启恢复】' + text, ...extra };
  if (status !== ADOPTED && !fields.finishedAt) fields.finishedAt = Date.now();
  if (status === 'interrupted') { fields.phase = fields.phase || '已中断'; fields.error = ''; }
  if (status === 'cancelled') { fields.phase = '已取消'; fields.error = fields.error || text; }
  const r = withWriteContext('job:restart-recovery', () => Jobs.update(jobId, fields));
  dropWatchEntry(jobId);
  recoveryLog({ event: 'leave-adopted', jobId, projectId: cur.projectId, from: cur.status, to: status, text });
  return r;
}

/** 取消 / 停止路由：放弃接管。不杀外部进程、不打断 ComfyUI、不重新提交。 */
export function releaseAdoptedJob(job, { reason = '', source = 'cancel', onProgress } = {}) {
  const cur = Jobs.get(job.id);
  if (!cur || cur.status !== ADOPTED) return { jobId: job.id, action: 'skipped', detail: '状态已是 ' + (cur && cur.status) };
  const text = (reason || '放弃接管') + '：外部 Agent 进程没有被终止（IC 不杀外部进程），它已经出好的镜照常保留；重启恢复不再自动记完成 / 继续 / 续章';
  leaveAdopted(cur.id, 'cancelled', text);
  logger.warn('重启恢复：放弃接管（' + source + '）', { jobId: cur.id, projectId: cur.projectId });
  if (onProgress) { try { onProgress({ projectId: cur.projectId, jobId: cur.id, type: cur.type, phase: '已取消', status: 'cancelled', detail: text }); } catch { /* noop */ } }
  return { jobId: cur.id, action: 'cancelled', detail: text };
}
