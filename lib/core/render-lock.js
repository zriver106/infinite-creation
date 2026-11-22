// 渲染租约锁（ic23，2026-11-17）：按章批量出片 / 单镜出片的「同一时刻只有一个执行者」。
//
// 为什么需要：外部 Agent（Claude Code）对 stdio MCP 工具有 30 分钟「空闲超时」——工具调用 30 分钟没有
// 响应也没有 progress 通知就判失败，模型随即再调一次 generate_chapter_videos。可第一次调用在 MCP 子进程里
// 仍在跑（没有取消通道），于是两次、三次批量循环并发，同一镜被重复渲染（第16–19章多出 3/14/6/18 条候选）。
// 本地 ComfyUI 走 runRenderSlot，不经过 queue_items 的 dedupe_key，原来的单镜去重也兜不住。
//
// 设计：
// - 锁 = DATA_DIR/locks/render/<kind>-<hash>.lock.json，用 open('wx') 原子创建，跨进程有效
//   （MCP 子进程、后端进程、重启后的新后端都看同一个目录）。不建表、不写 ic.db。
// - 心跳 = 持有期间每 HEARTBEAT_MS 刷一次文件 mtime。
// - 判死（可被接管）：持有进程已不在（pid 探测）；或 pid 就是本进程但本进程并没持有（重启后 pid 复用）；
//   或心跳超过 STALE_MS 没刷新（进程僵住/被强杀）。所以进程崩溃、taskkill、后端重启都不会把锁永久卡死。
// - 接管 = 先把死锁文件 rename 走（只有一个进程能 rename 成功），再 wx 新建；rename 走的旧文件随即删除，
//   并在 render-locks.jsonl 留一条记录。
// - 正常结束：释放前把结果写进 <kind>-<hash>.last.json，等在锁外的其它进程据此直接拿结果，不必重跑。
// - 紧急关闭：IC_DISABLE_CHAPTER_RENDER_LOCK=1 → 全部回到 ic22 的原行为（不加锁、不等待）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export const RENDER_LOCK_ENV = 'IC_DISABLE_CHAPTER_RENDER_LOCK';
export function renderLockDisabled(env = process.env) { return !!env && env[RENDER_LOCK_ENV] === '1'; }

export const RENDER_LOCK_HEARTBEAT_MS = 15 * 1000;
export function renderLockStaleMs(env = process.env) {
  const s = Number(env && env.IC_RENDER_LOCK_STALE_SEC);
  return (s > 0 ? s : 180) * 1000;
}

export function renderLockDir() { return path.join(DATA_DIR, 'locks', 'render'); }
export function renderLockLogFile() { return path.join(DATA_DIR, 'logs', 'render-locks.jsonl'); }

/** 按章批量出片的锁键（项目 + 章节标题）。 */
export function chapterRenderLockKey(projectId, chapterTitle) { return 'chapter-videos|' + String(projectId || '') + '|' + String(chapterTitle || ''); }
/** 单镜出片的锁键。 */
export function shotRenderLockKey(shotId) { return 'shot|' + String(shotId || ''); }

function baseName(key) {
  const kind = String(key).split('|')[0].replace(/[^A-Za-z0-9_-]/g, '_') || 'lock';
  return kind + '-' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
}
export function renderLockFile(key) { return path.join(renderLockDir(), baseName(key) + '.lock.json'); }
function lastFile(key) { return path.join(renderLockDir(), baseName(key) + '.last.json'); }

// 本进程持有的锁：key -> { token, file, timer }
const held = new Map();

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function appendLog(entry) {
  try {
    const f = renderLockLogFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n', 'utf8');
  } catch { /* 只是审计日志 */ }
}

function readRaw(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let info = null;
  try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { info = null; }
  return { file, info, mtimeMs: st.mtimeMs };
}

/**
 * 查看锁的状态（只读）。
 * @returns {{held:false}|{held:true, stale:boolean, reason:string, info:object|null, ageMs:number, file:string}}
 */
export function renderLockState(key, { now = Date.now(), staleMs = renderLockStaleMs(), isPidAlive = pidAlive } = {}) {
  const raw = readRaw(renderLockFile(key));
  if (!raw) return { held: false };
  const ageMs = Math.max(0, now - raw.mtimeMs);
  const info = raw.info;
  let reason = '';
  if (!info || !info.token) {
    // 刚 wx 建出来还没写完内容：心跳新鲜就当作有人持有；旧的坏文件当死锁
    reason = ageMs > staleMs ? 'corrupt' : '';
  } else if (Number(info.pid) === process.pid) {
    const mine = held.get(key);
    if (!mine || mine.token !== info.token) reason = 'self-not-holding';
  } else if (!isPidAlive(info.pid)) {
    reason = 'owner-dead';
  }
  if (!reason && ageMs > staleMs) reason = 'heartbeat-stale';
  return { held: true, stale: !!reason, reason, info, ageMs, file: raw.file };
}

function startHeartbeat(file) {
  const t = setInterval(() => {
    const d = new Date();
    try { fs.utimesSync(file, d, d); } catch { /* 文件被接管/删掉了：下次释放时会发现 token 不符 */ }
  }, RENDER_LOCK_HEARTBEAT_MS);
  if (t.unref) t.unref();
  return t;
}

/**
 * 尝试拿锁（不等待）。
 * @returns {{ok:true, token:string, release:(result?:any)=>void} | {ok:false, state:object}}
 */
export function tryAcquireRenderLock(key, meta = {}, opts = {}) {
  const dir = renderLockDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = renderLockFile(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const state = renderLockState(key, opts);
      if (!state.held) continue;              // 刚被释放，重试
      if (!state.stale) return { ok: false, state };
      // 接管死锁：rename 是原子的，并发接管只有一个能成功
      const moved = file + '.stale-' + Date.now() + '-' + process.pid;
      try { fs.renameSync(file, moved); } catch { continue; }
      appendLog({ action: 'takeover', key, reason: state.reason, ageMs: Math.round(state.ageMs), owner: state.info || null });
      try { fs.rmSync(moved, { force: true }); } catch { /* noop */ }
      continue;
    }
    const token = crypto.randomUUID();
    const info = { key, token, pid: process.pid, startedAt: Date.now(), ...meta };
    try { fs.writeFileSync(fd, JSON.stringify(info)); } finally { try { fs.closeSync(fd); } catch { /* noop */ } }
    const timer = startHeartbeat(file);
    held.set(key, { token, file, timer });
    let released = false;
    const release = (result) => {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (held.get(key)?.token === token) held.delete(key);
      if (result !== undefined) {
        try {
          const lf = lastFile(key);
          const tmp = lf + '.' + process.pid + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({ key, token, finishedAt: Date.now(), startedAt: info.startedAt, meta, result }));
          fs.renameSync(tmp, lf);
        } catch { /* 结果只是给等待者省一次空跑 */ }
      }
      // 只删自己的锁（被判死接管后，文件里已是别人的 token）
      const raw = readRaw(file);
      if (raw && raw.info && raw.info.token === token) { try { fs.rmSync(file, { force: true }); } catch { /* noop */ } }
    };
    return { ok: true, token, release };
  }
  const state = renderLockState(key, opts);
  return { ok: false, state: state.held ? state : { held: true, stale: false, reason: 'contended', info: null, ageMs: 0 } };
}

/** 读上一次正常结束时留下的结果（没有则 null）。 */
export function readRenderLockLast(key) {
  try { return JSON.parse(fs.readFileSync(lastFile(key), 'utf8')); } catch { return null; }
}

/** 本进程是否持有该锁（单测/诊断用）。 */
export function holdsRenderLock(key) { return held.has(key); }

/**
 * 启动时清理（ic21 孤儿任务收尾时一起调用）：把判死的锁删掉并记账；活着的锁不动，只报告。
 * @returns {Array<{file:string, key:string, action:'released'|'kept', reason:string, owner:object|null}>}
 */
export function sweepStaleRenderLocks({ jobStatus, ...opts } = {}) {
  let names = [];
  try { names = fs.readdirSync(renderLockDir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(renderLockDir(), n);
    if (/\.stale-\d+-\d+$/.test(n)) {
      // 接管途中崩溃留下的残片
      try { fs.rmSync(full, { force: true }); } catch { /* noop */ }
      continue;
    }
    if (!n.endsWith('.lock.json')) continue;
    const raw = readRaw(full);
    const key = (raw && raw.info && raw.info.key) || '';
    const state = key ? renderLockState(key, opts) : { held: true, stale: true, reason: 'corrupt', info: null, ageMs: 0 };
    const owner = state.info || null;
    const ownerJob = owner && owner.jobId && typeof jobStatus === 'function' ? jobStatus(owner.jobId) : '';
    if (state.stale) {
      const moved = full + '.stale-' + Date.now() + '-' + process.pid;
      try { fs.renameSync(full, moved); fs.rmSync(moved, { force: true }); } catch { continue; }
      const entry = { file: full, key, action: 'released', reason: state.reason, owner, ownerJob };
      appendLog({ action: 'sweep-released', key, reason: state.reason, owner, ownerJob });
      out.push(entry);
    } else if (state.held) {
      out.push({ file: full, key, action: 'kept', reason: 'owner-alive', owner, ownerJob });
    }
  }
  return out;
}
