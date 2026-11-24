// 指挥系统常驻看门狗（CLA-34，Andy 2026-11-23 18:57/18:58）。纯脚本，运行时不调用任何模型。
// 每 10 秒一轮：8189 只 GET /queue（每轮最多一次）；4610 只 GET /api/queue（最多 30 秒一次）；
// 进程表用常驻 PowerShell 子进程查一次；日志只看 mtime 和尾部；progress/md5 按 mtime 缓存；不查 ic.db。
// 只报警：不提交 GPU、不改链脚本、不建/删 STOP、不杀/不取消任何东西。唯一的“动作”是自动恢复（白名单 + 全部条件满足，默认 dry）。
// 用法：node scripts/command-watchdog.mjs [--once] [--config=<path>]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as L from './command-watchdog-lib.mjs';

const ENV = process.env;
const TEST = ENV.IC_CONFIG === ':9' || ENV.WD_TEST === '1';
const M = ENV.WD_M || 'C:\\Users\\usazr\\Documents\\moviePro';
const U = path.join(M, '_');
const G = ENV.WD_G || path.join(M, '运行记录', 'gpu生产');
const WD = ENV.WD_DIR || path.join(M, 'Claude工作区', '指挥', '看门狗');
const CF = ENV.WD_CF || 'http://127.0.0.1:8189';
const IC = ENV.WD_IC || 'http://127.0.0.1:4610';
const ONCE = process.argv.includes('--once');
const CONFIG = (process.argv.find((a) => a.startsWith('--config=')) || '').slice(9) || path.join(WD, 'watchdog-config.json');
if (/:8188\b/.test(CF) || /:8188\b/.test(IC) || /:(8188|8189)\b/.test(IC)) throw new Error('禁止连接 8188；4610 地址不能是 8188/8189');
if (TEST && /:(8188|8189)\b/.test(CF)) throw new Error('测试模式（IC_CONFIG=:9）禁止连接 8188/8189，请用 WD_CF 指向假服务');

export const DEFAULT_CONFIG = {
  note: '看门狗配置（CLA-34）。时间一律太平洋时间。改了下一轮自动生效（按 mtime 重读）。',
  intervalSec: 10,
  gpuIdleGraceSec: 60,
  gpuIdleWarnSec: 60,
  gpuIdleErrorSec: 180,
  idlePreparedHours: 3,
  chainStaleMin: 50,
  chainWaitStaleMin: 5,
  recentHours: 6,
  preparedHours: 2,
  sessionLongMin: 90,
  ic4610EverySec: 30,
  heavyEverySec: 60,
  outputScanEverySec: 120,
  resolveAfterRounds: 3,
  gateMaxChapter: 10,
  gateFlag: 'C:\\Users\\usazr\\Documents\\moviePro\\_\\watchdog\\EP1_10_DONE.flag',
  python: 'C:\\Python315\\python.exe',
  ignoreChains: [],
  sessionOutputs: {
    rule: '① 活着的 claude/codex/run_sess 进程（及其父 cmd）命令行里的重定向文件 1>/2>/>；② run_sess.py 参数里的目录（只看第一层）；③ M\\_ 下 3 层以内、3 小时内修改、文件名含 session/run/stream/events/_out/_err 的 .jsonl/.json/.txt/.log。只读尾部 8KB（mtime/大小变了才读）。JSON 行只认 type=result 且 is_error=true 或 subtype 以 error 开头、或 type=error；纯文本只在文件名含 err 时找额度/限流字样。',
    roots: ['C:\\Users\\usazr\\Documents\\moviePro\\_'],
    maxDepth: 3,
    recentHours: 3,
    exclude: ['watchdog_dev', 'watchdog', 'cmd4621_test', 'cmd4620_archive', 'archive', '封存', 'node_modules'],
  },
  deadlines: [
    { id: 'ep6_8_db', name: '第6–8集写库', at: '2026-11-23T20:30', done: false },
    { id: 'select_export', name: '选片/导出/报 Andy', at: '2026-11-23T23:30', done: false },
    { id: 'ic_rule_sync', name: 'IC 规则同步', at: '2026-11-24T09:00', done: false },
    { id: 'rw62_ep1', name: '62 镜按集重写：第1集', at: '2026-11-23T21:00', done: false },
    { id: 'rw62_ep2', name: '62 镜按集重写：第2集', at: '2026-11-23T21:40', done: false },
    { id: 'rw62_ep3', name: '62 镜按集重写：第3集', at: '2026-11-23T22:10', done: false },
    { id: 'rw62_ep4', name: '62 镜按集重写：第4集', at: '2026-11-23T22:50', done: false },
    { id: 'rw62_ep5', name: '62 镜按集重写：第5集', at: '2026-11-23T23:20', done: false },
    { id: 'rw62_ep9', name: '62 镜按集重写：第9集', at: '2026-11-24T00:00', done: false },
    { id: 'rw62_ep10', name: '62 镜按集重写：第10集', at: '2026-11-24T00:30', done: false },
  ],
  deadlineDoneDir: 'C:\\Users\\usazr\\Documents\\moviePro\\_\\watchdog\\done',
  deadlineNote: 'done=true 或在 deadlineDoneDir 里放 <id>.done 文件，都算完成。Andy 19:02 取消 62 镜固定顺序，截止时间仍作提醒。',
  recovery: {
    mode: 'dry',
    note: 'mode=dry 只记「将会执行的命令」；mode=live 且白名单条目 live=true 才真的起链。看门狗自己从不提交 GPU、从不改链脚本。',
    whitelist: [{ script: 'gpu_rr1845_chain.py', md5: '0DAB8B2399C4BF0A48CBF92670E45A7F', outDir: 'C:\\Users\\usazr\\Documents\\moviePro\\_\\rr678b_release', live: false }],
  },
};

// ---------- 小工具 ----------
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const statQ = (p) => { try { return fs.statSync(p); } catch { return null; } };
function readTail(p, bytes) {
  let fd; try {
    fd = fs.openSync(p, 'r'); const st = fs.fstatSync(fd); const n = Math.min(bytes, st.size);
    const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); return b.toString('utf8');
  } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
function md5File(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }
function writeAtomic(p, s) { const t = p + '.tmp'; fs.writeFileSync(t, s); fs.renameSync(t, p); }
function appendLine(p, o) { fs.appendFileSync(p, JSON.stringify(o) + '\n'); }
function wlog(...a) { try { fs.appendFileSync(path.join(WD, 'watchdog.log'), `${L.ptStr()} ${a.join(' ')}\n`); } catch {} }
function httpGet(url, timeoutMs = 5000) {
  // 8189：只允许 GET /queue；从不 POST
  const u = new URL(url);
  if (u.port === '8188') return Promise.reject(new Error('禁止 8188'));
  if (u.port === '8189' && u.pathname !== '/queue') return Promise.reject(new Error('8189 只允许 GET /queue'));
  if (TEST && /^(8188|8189)$/.test(u.port)) return Promise.reject(new Error('测试模式禁止 8188/8189'));
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d));
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

// ---------- 常驻 PowerShell 子进程（进程表 / WMI 启动） ----------
const PS_LOOP = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'
while($true){ $l=[Console]::In.ReadLine(); if($l -eq $null){break}
 try{ $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l)); $o=& ([scriptblock]::Create($s)); [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($o) -Compress -Depth 4)) }
 catch{ [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{__error=$_.ToString()} -Compress)) }
 [Console]::Out.WriteLine('<<WD_END>>'); [Console]::Out.Flush() }`;
class PS {
  constructor() { this.p = null; this.buf = ''; this.wait = null; }
  start() {
    this.p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_LOOP], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => { this.buf += d; const i = this.buf.indexOf('<<WD_END>>'); if (i >= 0 && this.wait) { const out = this.buf.slice(0, i); this.buf = this.buf.slice(i + 10).replace(/^\r?\n/, ''); const w = this.wait; this.wait = null; w.res(out); } });
    this.p.stderr.on('data', () => {});
    this.p.on('exit', () => { this.p = null; if (this.wait) { this.wait.rej(new Error('ps exited')); this.wait = null; } });
  }
  run(script, timeoutMs = 20000) {
    if (!this.p) this.start();
    if (this.wait) return Promise.reject(new Error('ps busy'));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.wait) { this.wait = null; try { this.p.stdin.end(); } catch {} this.p = null; this.buf = ''; rej(new Error('ps timeout')); } }, timeoutMs); // 超时：关掉 stdin 让它自己退出，下次新起一个（不杀进程）
      this.wait = { res: (o) => { clearTimeout(t); try { const j = JSON.parse(o.trim() || '[]'); if (j && j.__error) rej(new Error(j.__error)); else res(j); } catch (e) { rej(e); } }, rej: (e) => { clearTimeout(t); rej(e); } };
      this.p.stdin.write(Buffer.from(script, 'utf8').toString('base64') + '\n');
    });
  }
}
const PROC_SCRIPT = `$want='^(python|pythonw|claude|codex|grok.*|cmd|powershell|pwsh|bash|node|wsl|conhost|WmiPrvSE)\\.exe$'
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { $n=$_.Name; [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;name=$n;created=$(if($_.CreationDate){$_.CreationDate.ToString('o')}else{$null});cmd=$(if($n -match $want){$_.CommandLine}else{$null})} }`;
let ps = null;
async function getProcs() {
  if (ENV.WD_PROCS_FILE) return JSON.parse(fs.readFileSync(ENV.WD_PROCS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  if (!ps) ps = new PS();
  return (await ps.run(PROC_SCRIPT)).filter(Boolean);
}
async function wmiCreate(cmdline, cwd) {
  if (TEST) throw new Error('测试模式不启动任何进程');
  const esc = (s) => s.replace(/'/g, "''");
  const r = await (ps || (ps = new PS())).run(`$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${esc(cmdline)}';CurrentDirectory='${esc(cwd)}'}; [pscustomobject]@{rv=$r.ReturnValue;pid=$r.ProcessId}`, 30000);
  return r[0];
}

// ---------- 配置与状态 ----------
let cfg = null, cfgMtime = 0;
function loadConfig() {
  const st = statQ(CONFIG);
  if (!st) { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n'); return loadConfig(); }
  if (cfg && st.mtimeMs === cfgMtime) return cfg;
  try { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')); cfg = { ...DEFAULT_CONFIG, ...c, sessionOutputs: { ...DEFAULT_CONFIG.sessionOutputs, ...(c.sessionOutputs || {}) }, recovery: { ...DEFAULT_CONFIG.recovery, ...(c.recovery || {}) } }; cfgMtime = st.mtimeMs; }
  catch (e) { wlog('配置读不了，沿用上次：', e.message); if (!cfg) cfg = { ...DEFAULT_CONFIG }; }
  return cfg;
}
const STATE_F = () => path.join(WD, 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_F(), 'utf8')); } catch { return { alerts: {}, recoveries: [], round: 0, gpuEmptySince: null, dryLast: {} }; } }

// ---------- 缓存 ----------
const scriptCache = new Map(); // path -> {mtime, parsed, md5}
const logCache = new Map(); // path -> {mtime,size,last,upstream,readAt}
const progCache = new Map(); // path -> {mtime, data}
let scriptList = { at: 0, files: [] };
let ic4610 = { at: 0, data: null, error: null };
let outFiles = { at: 0, files: [] };
const tailCache = new Map(); // file -> {mtime,size,hit}

function listScripts(now) {
  if (now - scriptList.at < cfg.heavyEverySec * 1000 && scriptList.files.length) return scriptList.files;
  let names = []; try { names = fs.readdirSync(U).filter((n) => /^gpu_.+_chain.*\.py$/i.test(n)); } catch {}
  scriptList = { at: now, files: names.map((n) => ({ base: n, full: path.join(U, n), st: statQ(path.join(U, n)) })).filter((x) => x.st) };
  return scriptList.files;
}
function getScript(full, st) {
  const c = scriptCache.get(full);
  if (c && c.mtime === st.mtimeMs) return c;
  let text = ''; try { text = fs.readFileSync(full, 'utf8'); } catch {}
  const v = { mtime: st.mtimeMs, parsed: L.parseChainScript(text, path.basename(full)), md5: (() => { try { return md5File(full); } catch { return null; } })() };
  scriptCache.set(full, v); return v;
}
function getLog(p, now) {
  const st = statQ(p); if (!st) return null;
  const c = logCache.get(p);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
  const tail = readTail(p, 4096);
  const v = { mtime: st.mtimeMs, size: st.size, last: L.lastLine(tail), upstream: c?.upstream ?? null, upAt: c?.upAt ?? 0, name: null };
  logCache.set(p, v); return v;
}
function logUpstream(p, name, v, now) {
  if (v.upAt && now - v.upAt < cfg.heavyEverySec * 1000 && v.upName === name && v.upMtime === v.mtime) return v.upstream;
  v.upstream = L.upstreamFromLog(name, readTail(p, 65536)); v.upAt = now; v.upName = name; v.upMtime = v.mtime; return v.upstream;
}
function getProg(p) {
  const st = statQ(p); if (!st) return null;
  const c = progCache.get(p); if (c && c.mtime === st.mtimeMs) return c.data;
  let d = null; try { d = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { d = c?.data ?? null; }
  progCache.set(p, { mtime: st.mtimeMs, data: d }); return d;
}

function buildChainView(file, procs, now) {
  const sc = getScript(file.full, file.st); const pz = sc.parsed;
  if (!pz.name) return null;
  const alive = L.chainProcs(procs, file.base).map((p) => p.pid);
  const logP = pz.logDir ? path.join(G, pz.logDir, 'chain.log') : null;
  const lg = logP ? getLog(logP, now) : null;
  const prog = {}; for (const p of pz.plan) prog[p.tag] = pz.progDirs[p.tag] ? getProg(path.join(G, pz.progDirs[p.tag], 'progress.json')) : null;
  let upstream = null;
  const liveCmd = procs.find((p) => alive.includes(p.pid))?.cmd;
  if (liveCmd) upstream = L.afterFromCmd(liveCmd) || pz.defaultAfter;
  else if (lg) upstream = logUpstream(logP, pz.name, lg, now);
  const v = {
    name: pz.name, script: file.base, parsed: pz.parsed, plan: pz.plan, progDirs: pz.progDirs, md5: sc.md5, upstreamMap: pz.upstream, stopName: pz.stopName,
    alive, logExists: !!lg, logMtimeMs: lg?.mtime ?? null, last: lg?.last || '', upstream,
    terminal: lg ? L.terminalOf(pz.name, lg.last) : null,
    shots: pz.plan.length ? L.shotSummary(pz, prog) : null,
    scriptMtimeMs: file.st.mtimeMs, ignored: (cfg.ignoreChains || []).includes(pz.name),
  };
  v.state = L.chainState(v);
  const rh = cfg.recentHours * 3600000;
  v.recent = alive.length > 0 || (v.logMtimeMs != null && now - v.logMtimeMs < rh) || (!v.logExists && now - v.scriptMtimeMs < rh);
  return v;
}

// ---------- 写稿会话 ----------
function walkOutputs(now) {
  const so = cfg.sessionOutputs; const found = [];
  const lim = now - so.recentHours * 3600000; const ex = (so.exclude || []).map((x) => x.toLowerCase());
  const rx = /(session|run|stream|events|_out|_err)[^\\/]*\.(jsonl|json|txt|log)$/i;
  const walk = (dir, d) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (d < so.maxDepth && !ex.some((x) => e.name.toLowerCase().includes(x))) walk(full, d + 1); continue; }
      if (!rx.test(e.name)) continue;
      const st = statQ(full); if (st && st.mtimeMs > lim && st.size > 0) found.push(full);
    }
  };
  for (const r of so.roots) walk(r, 0);
  return found;
}
function sessionCheck(procs, now) {
  const long = []; const errors = []; const files = new Set();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (const p of procs) {
    if (!p.cmd) continue;
    const isClaudeP = /^claude\.exe$/i.test(p.name) && /(^|\s)-p(\s|$)/.test(p.cmd);
    if (isClaudeP && p.created) { const min = (now - Date.parse(p.created)) / 60000; if (min > cfg.sessionLongMin) long.push({ pid: p.pid, min, created: p.created, cmd: p.cmd }); }
    if (isClaudeP || /^codex\.exe$/i.test(p.name) && /\bexec\b/.test(p.cmd) || /run_sess\.py/i.test(p.cmd)) {
      for (let a = byPid.get(p.ppid), i = 0; a && i < 3; a = byPid.get(a.ppid), i++) if (/^cmd\.exe$/i.test(a.name)) for (const f of L.redirectTargets(a.cmd)) files.add(f);
      for (const f of L.redirectTargets(p.cmd)) files.add(f);
      if (/run_sess\.py/i.test(p.cmd)) for (const m of p.cmd.matchAll(/"([a-z]:\\[^"]+)"/gi)) { try { for (const n of fs.readdirSync(m[1])) files.add(path.join(m[1], n)); } catch {} }
    }
  }
  if (now - outFiles.at > cfg.outputScanEverySec * 1000) outFiles = { at: now, files: walkOutputs(now) };
  for (const f of outFiles.files) files.add(f);
  for (const f of files) {
    if (!/\.(jsonl|json|txt|log)$/i.test(f)) continue;
    if (f.toLowerCase().startsWith(WD.toLowerCase())) continue;
    const st = statQ(f); if (!st || !st.size) continue;
    let c = tailCache.get(f);
    if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) { c = { mtime: st.mtimeMs, size: st.size, hit: L.scanOutputTail(path.basename(f), readTail(f, 8192)) }; tailCache.set(f, c); }
    if (c.hit && now - st.mtimeMs < cfg.sessionOutputs.recentHours * 3600000) errors.push({ file: f, what: c.hit });
  }
  return { long, errors, watched: files.size };
}

// ---------- 主循环 ----------
let state = null;
async function round() {
  const t0 = Date.now(); loadConfig(); const now = Date.now(); const nowIso = new Date(now).toISOString();
  const summary = {}; const errs = [];
  // 8189：每轮最多一次 GET /queue
  let gpu = { ok: false, running: [], pending: [], error: null };
  try { const q = await httpGet(CF + '/queue'); gpu = { ok: true, running: q.queue_running || [], pending: q.queue_pending || [] }; } catch (e) { gpu.error = String(e.message || e); }
  if (gpu.ok && !gpu.running.length && !gpu.pending.length) { if (state.gpuEmptySince == null) state.gpuEmptySince = now; } else if (gpu.ok) state.gpuEmptySince = null;
  const gpuIdleSec = state.gpuEmptySince != null ? Math.round((now - state.gpuEmptySince) / 1000) : 0;
  summary.gpu = gpu.ok ? { running: gpu.running.length, pending: gpu.pending.length, idleSec: gpuIdleSec } : { error: gpu.error };
  // 4610：最多 30 秒一次
  if (now - ic4610.at >= cfg.ic4610EverySec * 1000) { ic4610.at = now; try { ic4610.data = await httpGet(IC + '/api/queue'); ic4610.error = null; } catch (e) { ic4610.error = String(e.message || e); } }
  summary.ic4610 = ic4610.error ? { error: ic4610.error } : { running: ic4610.data?.running ?? null, waiting: ic4610.data?.waiting ?? null };
  // 进程表
  let procs = []; try { procs = await getProcs(); } catch (e) { errs.push('进程表：' + e.message); }
  summary.procs = procs.length;
  // 链
  const files = listScripts(now);
  const views = []; const byName = new Map();
  for (const f of files) { try { const v = buildChainView(f, procs, now); if (v) { byName.set(v.name, v); if (v.recent) views.push(v); } } catch (e) { errs.push(`链 ${f.base}：${e.message}`); } }
  for (const v of views) if (v.upstream && v.upstream !== 'none' && !views.includes(byName.get(v.upstream)) && byName.get(v.upstream)) views.push(byName.get(v.upstream)); // 上游即使不“最近”也要看
  summary.chains = views.map((v) => ({ name: v.name, state: v.state, alive: v.alive, upstream: v.upstream, unsubmitted: v.shots?.unsubmitted.length ?? null, uncertain: v.shots?.uncertain.length ?? null, last: L.stripTs(v.last).slice(0, 80) }));
  // 队列 → 章节
  const queueChapters = [];
  for (const [where, arr] of [['running', gpu.running], ['pending', gpu.pending]]) for (const it of arr) {
    const pid = String(it[1] || ''); const s = JSON.stringify(it[2] || {}); const m = s.match(/"filename_prefix":"[^"]*?_shot(\d+)_/);
    let chapter = null, src = '取不到';
    if (m) { const idx = +m[1]; for (const v of views.filter((x) => x.alive.length)) for (const p of v.plan) { if (!v.progDirs[p.tag]) continue; const pj = getProg(path.join(G, v.progDirs[p.tag], 'progress.json')); const hit = (pj?.shots || []).find((x) => x['镜序'] === idx && ['running', 'submitting'].includes(x.status)); if (hit) { chapter = p.ch; src = `在跑链 ${v.name} 的 progress（${p.chapter}#${idx}）`; } } }
    if (chapter == null) { const alivePlans = views.filter((x) => x.alive.length).flatMap((x) => x.plan.map((p) => p.ch)); if (alivePlans.length) { chapter = Math.max(...alivePlans); src = '对不上镜头，按在跑链 PLAN 里最大章号'; } }
    queueChapters.push({ prompt_id: pid, chapter, src, where });
  }
  // 写稿会话
  let sessions = { long: [], errors: [] }; try { sessions = sessionCheck(procs, now); } catch (e) { errs.push('会话检查：' + e.message); }
  summary.sessions = { long: sessions.long.length, errors: sessions.errors.length, watchedFiles: sessions.watched };
  // 截止时间
  const deadlines = (cfg.deadlines || []).map((d) => ({ ...d, done: d.done || exists(path.join(cfg.deadlineDoneDir || '', d.id + '.done')) }));
  const gateFlag = exists(cfg.gateFlag);
  summary.gate = gateFlag ? '标记文件存在：第1–10集已完成，闸门关闭' : '闸门生效（标记文件不存在）';
  // 评估 + 去重
  // GPU 空闲（第二轮）：8189 空 + 4610 无 running/queued（读不到 4610 时只看另两项）+ 没有活着的 gpu_*chain/gpu_submit 进程
  const procsOk = !errs.some((x) => x.startsWith('进程表'));
  const icBusy = !ic4610.error && ic4610.data && ((ic4610.data.running || 0) > 0 || (ic4610.data.waiting || 0) > 0);
  const submitters = L.anyChainOrSubmit(procs, null);
  const idleNow = gpu.ok && !gpu.running.length && !gpu.pending.length && !icBusy && procsOk && submitters.length === 0;
  if (idleNow) { if (state.idleSince == null) state.idleSince = now; } else if (gpu.ok && procsOk) state.idleSince = null;
  summary.idle = { now: idleNow, sinceSec: state.idleSince != null ? Math.round((now - state.idleSince) / 1000) : null, submitters: submitters.map((p) => p.pid), ic4610Busy: !!icBusy };
  const found = L.evaluate({ now, cfg, gpu, gpuEmptySinceMs: state.gpuEmptySince, idle: { sinceMs: state.idleSince }, chains: views, allChains: [...byName.values()], procs, sessions, deadlines, gateFlag, queueChapters });
  const events = L.diffAlerts(state, found, nowIso, cfg.resolveAfterRounds);
  // 自动恢复（只对白名单脚本、进程没了的链）
  const recov = [];
  for (const v of views) {
    if (v.state !== 'dead' || v.ignored) continue;
    if (!(cfg.recovery.whitelist || []).some((w) => w.script.toLowerCase() === v.script.toLowerCase())) continue;
    const up = v.upstream && v.upstream !== 'none' ? byName.get(v.upstream) : null;
    const upProgUncertain = [];
    if (v.upstream && v.upstream !== 'none') { const u = v.upstreamMap[v.upstream]; for (const pd of (u?.progDirs || [])) { const pj = getProg(path.join(G, pd, 'progress.json')); for (const s of (pj?.shots || [])) if (L.UNCERTAIN.has(s.status)) upProgUncertain.push(`${pd}#${s['镜序']}:${s.status}`); } }
    const stopExists = exists(path.join(U, v.stopName || `${v.name}.STOP`));
    const d = L.recoveryDecision({ c: v, up, cfg, procs, gpu, gpuIdleSec, stopExists, upProgUncertain, history: state.recoveries, now, M, python: cfg.python });
    const dkey = L.sig({ ok: d.ok, r: d.reasons.map((x) => x.replace(/\d+ 秒/g, 'N 秒')), last: v.last, live: d.live }); // 秒数变化不算变化，免得每轮记一行
    if (state.dryLast[v.name] !== dkey) {
      state.dryLast[v.name] = dkey;
      const rec = { at: nowIso, chain: v.name, ok: d.ok, live: d.ok && d.live, reasons: d.reasons, cmd: d.cmd, cwd: d.cwd, mode: d.live ? 'live' : 'dry' };
      if (d.ok && d.live) {
        try { const r = await wmiCreate(d.cmd, d.cwd); rec.result = r; rec.started = r && r.rv === 0; } catch (e) { rec.result = { error: e.message }; rec.started = false; }
        state.recoveries.push({ chain: v.name, at: nowIso, live: true, started: rec.started });
      } else if (d.ok) rec.note = '条件全部满足；dry 模式：将会执行上面这条命令（没有执行）';
      appendLine(path.join(WD, 'recoveries.jsonl'), rec); recov.push(rec);
      if (d.ok) events.push({ type: 'recovery', key: `recovery:${v.name}`, level: rec.live ? 'ERROR' : 'INFO', check: 'recovery', title: rec.live ? (rec.started ? `已自动重启链 ${v.name}` : `自动重启链 ${v.name} 失败`) : `链 ${v.name} 满足自动恢复条件（dry，没执行）`, text: rec.live ? `命令：${d.cmd}；结果 ${JSON.stringify(rec.result)}` : `将会执行：${d.cmd}`, at: nowIso });
    }
  }
  state.recoveries = (state.recoveries || []).filter((h) => now - Date.parse(h.at) < 24 * 3600000);
  for (const e of events) appendLine(path.join(WD, 'alerts.jsonl'), { ...e, atPT: L.ptStr(new Date(e.at)), msg: L.eventText(e) });
  state.round = (state.round || 0) + 1;
  const ms = Date.now() - t0;
  const hb = { at: nowIso, atPT: L.ptStr(new Date(now)), pid: process.pid, round: state.round, ms, intervalSec: cfg.intervalSec, test: TEST, alerts: Object.keys(state.alerts).length, errorAlerts: Object.values(state.alerts).filter((a) => a.level === 'ERROR').length, events: events.length, recoveryMode: cfg.recovery.mode, summary, errors: errs };
  writeAtomic(path.join(WD, 'current_alerts.json'), JSON.stringify({ at: nowIso, alerts: state.alerts }, null, 1));
  writeAtomic(path.join(WD, '当前告警.md'), L.renderCurrentMd(state.alerts, hb, L.recoveryFooter(cfg, byName)));
  writeAtomic(STATE_F(), JSON.stringify(state));
  writeAtomic(path.join(WD, 'heartbeat.json'), JSON.stringify(hb, null, 1));
  if (errs.length) wlog('本轮错误：', errs.join(' | '));
  return { hb, events, found, recov, views };
}

// ---------- 单实例 ----------
async function lockOrExit() {
  const lf = path.join(WD, 'watchdog.pid');
  let old = null; try { old = parseInt(fs.readFileSync(lf, 'utf8'), 10); } catch {}
  if (old && old !== process.pid) {
    let alive = false; try { process.kill(old, 0); alive = true; } catch {}
    if (alive) {
      let isWd = true; // 查不到命令行时按“是”处理：宁可不起第二个
      try { const r = await (ps || (ps = new PS())).run(`Get-CimInstance Win32_Process -Filter "ProcessId=${old}" | ForEach-Object { $_.CommandLine }`); isWd = !r.length || /command-watchdog\.mjs/.test(String(r[0])); } catch {}
      if (isWd) { console.log(`看门狗已在运行（PID ${old}），本进程退出`); if (ps?.p) ps.p.stdin.end(); process.exit(0); }
    }
  }
  fs.writeFileSync(lf, String(process.pid)); return lf; // 旧 pid 不在（或是别的程序复用了这个号）：接管，不杀任何进程
}

export async function main() {
  fs.mkdirSync(WD, { recursive: true });
  loadConfig(); state = loadState(); state.dryLast = state.dryLast || {}; state.recoveries = state.recoveries || [];
  if (ONCE) { const r = await round(); process.stdout.write(JSON.stringify({ hb: r.hb, events: r.events, recov: r.recov }, null, 1) + '\n', () => { if (ps?.p) ps.p.stdin.end(); process.exit(0); }); return r; }
  const lf = await lockOrExit();
  const cleanup = () => { try { if (parseInt(fs.readFileSync(lf, 'utf8'), 10) === process.pid) fs.renameSync(lf, lf + '.exited'); } catch {} };
  process.on('exit', cleanup); process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
  wlog(`看门狗启动 pid=${process.pid} 测试=${TEST} 配置=${CONFIG}`);
  for (;;) {
    const t = Date.now();
    // 换代码/测保活用：放一个 restart_request 文件，看门狗自己正常退出（不是被杀），保活任务 1 分钟内用新代码拉起
    const rq = path.join(WD, 'restart_request'); if (exists(rq)) { try { fs.renameSync(rq, rq + '.' + Date.now() + '.done'); } catch {} wlog('收到 restart_request，自己退出，等保活拉起'); if (ps?.p) ps.p.stdin.end(); process.exit(0); }
    try { await round(); } catch (e) { wlog('轮次异常：', e.stack || e.message); }
    await new Promise((r) => setTimeout(r, Math.max(1000, cfg.intervalSec * 1000 - (Date.now() - t))));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { wlog('致命：', e.stack || e.message); console.error(e); process.exit(1); });
