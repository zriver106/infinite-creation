// 指挥系统 第一期只读预览服务（独立端口，默认 4620）
// - 静态托管 studio/dist（本 worktree 构建产物）
// - /api/command/* ：只读文件 / 只读进程表 / 对 4610 只发 GET
// - 其余 /api /files /samples：只允许 GET/HEAD 透传到线上 4610（只读），任何 POST/PUT/PATCH/DELETE 一律 403
// - 不连 8188/8189，不读写 ic.db，不读任何凭据文件
import { checkOrder, DISPATCH_RULES, MODEL_TABLE } from './command-rules.mjs';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { handleIssues } from './command-issues.mjs';
import { handleChat, chatRegistry, chatInit } from './command-chat.mjs';
import { handleApiKey } from './command-apikey.mjs';
import { handleTrial, trialInit } from './command-codex-trial.mjs';
import { handleOverview, overviewInit, sessionTitle } from './command-overview.mjs';
import { handleWatchdog, watchdogInit } from './command-watchdog-api.mjs';

const PORT = Number(process.env.CMD_PREVIEW_PORT || 4620);
const HOST = process.env.CMD_PREVIEW_HOST || '0.0.0.0';
const LIVE = process.env.CMD_LIVE_BACKEND || 'http://127.0.0.1:4610';
if (/:(8188|8189)\b/.test(LIVE)) throw new Error('禁止连接 8188/8189');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.CMD_PREVIEW_DIST || path.join(__dirname, '..', 'studio', 'dist'));
const HOME = process.env.USERPROFILE || 'C:\\Users\\usazr';
const M = process.env.CMD_M || 'C:\\Users\\usazr\\Documents\\moviePro';
const P = path.join(M, 'projects', '我在城市用交易系统修仙');
const PATHS = {
  issues: process.env.CMD_ISSUES || 'C:\\Users\\usazr\\Desktop\\问题描述.txt',
  gpuRuns: path.join(M, '运行记录', 'gpu生产'),
  cmdDir: path.join(M, 'Claude工作区', '指挥'),
  linkDir: path.join(P, '问题链路记录'),
  claude: path.join(HOME, '.claude', 'projects'),
  codex: path.join(HOME, '.codex', 'sessions'),
};
const DENY_NAME = /(credential|auth|secret|token|\.env|key)/i;

// ---------- 脱敏 ----------
const REDACT = [
  [/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-***已隐去***'],
  [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '***已隐去***'],
  [/xox[abprs]-[A-Za-z0-9\-]{10,}/g, '***已隐去***'],
  [/AKIA[0-9A-Z]{16}/g, '***已隐去***'],
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '***JWT已隐去***'],
  [/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1***已隐去***'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|authorization|token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1***已隐去***'],
];
function redact(s) {
  let t = String(s ?? '');
  for (const [re, rep] of REDACT) t = t.replace(re, rep);
  return t;
}

// ---------- 工具 ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
async function liveGet(p, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(LIVE + p, { method: 'GET', signal: ac.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text: json ? undefined : text.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}
async function tailLines(file, n = 8, maxBytes = 256 * 1024) {
  try {
    const st = await fsp.stat(file);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start); await fh.close();
    let s = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = s.split(/\r?\n/).filter((l) => l.length);
    if (start > 0) lines.shift();
    return lines.slice(-n);
  } catch { return null; }
}
async function readJsonSafe(file) {
  try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}
function psDate(v) { const m = /Date\((\d+)\)/.exec(String(v || '')); return m ? new Date(Number(m[1])).toISOString() : v || null; }
let procCache = { at: 0, data: null };
function chainProcs() {
  if (Date.now() - procCache.at < 8000 && procCache.data) return Promise.resolve(procCache.data);
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve({ error: String(err.message || err) });
      let arr = []; try { arr = JSON.parse(out || '[]'); } catch {}
      if (!Array.isArray(arr)) arr = [arr];
      const all = arr.filter(Boolean);
      const chains = all.filter((p) => /gpu_[\w\-]+chain\.py/i.test(p.CommandLine || '')).map((p) => ({
        pid: p.ProcessId, script: ((p.CommandLine || '').match(/gpu_[\w\-]+chain\.py/i) || [''])[0],
        args: redact(((p.CommandLine || '').split(/chain\.py/i)[1] || '').trim()), started: psDate(p.CreationDate),
      }));
      const comfy = all.filter((p) => /main\.py.*--port\s+81(88|89)/.test(p.CommandLine || '')).map((p) => ({ pid: p.ProcessId, port: (p.CommandLine.match(/--port\s+(\d+)/) || [])[1] }));
      const data = { chains, comfyProcesses: comfy, pythonCount: all.length };
      procCache = { at: Date.now(), data }; resolve(data);
    });
  });
}

// ---------- ① 总览 ----------
async function overview() {
  const [health, queue, activity, procs] = await Promise.all([
    liveGet('/api/health'), liveGet('/api/queue'), liveGet('/api/activity'), chainProcs(),
  ]);
  let studio = null;
  try { const r = await fetch('http://127.0.0.1:4710/', { method: 'GET' }); studio = { ok: r.ok, status: r.status }; } catch (e) { studio = { ok: false, error: String(e.message || e) }; }
  let runs = [];
  try {
    const dirs = await fsp.readdir(PATHS.gpuRuns, { withFileTypes: true });
    const st = await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const full = path.join(PATHS.gpuRuns, d.name);
      let m = 0; try { m = (await fsp.stat(path.join(full, 'chain.log'))).mtimeMs; } catch { try { m = (await fsp.stat(full)).mtimeMs; } catch {} }
      return { name: d.name, full, mtime: m };
    }));
    st.sort((a, b) => b.mtime - a.mtime);
    runs = await Promise.all(st.slice(0, 8).map(async (r) => {
      const state = (await readJsonSafe(path.join(r.full, 'state.json'))) || (await readJsonSafe(path.join(r.full, 'progress.json')));
      const tail = await tailLines(path.join(r.full, 'chain.log'), 6);
      let stopFile = false;
      const files = await fsp.readdir(r.full).catch(() => []);
      stopFile = files.some((f) => /STOP/i.test(f));
      return { name: r.name, mtime: r.mtime ? new Date(r.mtime).toISOString() : null, state: state ? JSON.stringify(state).slice(0, 1500) : null, tail: tail ? tail.map((l) => redact(l).slice(0, 600)) : null, files: files.slice(0, 30), stopFile };
    }));
  } catch (e) { runs = { error: String(e.message || e) }; }
  const act = activity.json;
  return {
    at: new Date().toISOString(),
    live4610: { ok: health.ok, health: health.json || health.error },
    studio4710: studio,
    queue: queue.json || queue.error,
    activity: Array.isArray(act) ? act.slice(0, 20) : (act && Array.isArray(act.items) ? act.items.slice(0, 20) : act),
    gpu: procs,
    chainRuns: runs,
  };
}

// ---------- ② 按集看板 ----------
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}
function statusOf(tag) {
  if (!tag) return 'todo';
  if (/完成|☑/.test(tag)) return 'done';
  if (/修改中|进行中|处理中|返修中/.test(tag)) return 'doing';
  return 'todo';
}
async function episodes() {
  const st = await fsp.stat(PATHS.issues);
  const raw = (await fsp.readFile(PATHS.issues, 'utf8')).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  const eps = []; let cur = null; let pending = []; let batch = 0;
  const flush = () => { if (cur && pending.length) { cur.items.push({ text: pending.join(''), tag: '', status: 'todo', line: null }); } pending = []; };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const h = /^第([一二三四五六七八九十百零两\d]+)集(.*)$/.exec(t);
    if (h) { flush(); cur = { no: cnNum(h[1]), title: t, note: h[2].replace(/^[（(]|[）)]$/g, ''), batch, line: i + 1, items: [] }; eps.push(cur); return; }
    if (/^-{5,}/.test(t)) { flush(); batch++; return; }
    if (!cur) return;
    const m = /^(.*?)\s*-{2,}\s*([^-]+?)\s*$/.exec(t);
    if (m && m[1]) {
      const text = pending.join('') + m[1]; pending = [];
      cur.items.push({ text, tag: m[2], status: statusOf(m[2]), line: i + 1 });
    } else if (/[，,、]$/.test(t)) {
      pending.push(t);
    } else {
      flush(); cur.items.push({ text: t, tag: '', status: 'todo', line: i + 1 });
    }
  });
  flush();
  for (const e of eps) {
    const c = { done: 0, doing: 0, todo: 0 };
    e.items.forEach((it) => c[it.status]++);
    e.counts = c; e.total = e.items.length;
    e.status = e.total === 0 ? 'empty' : c.doing ? 'doing' : c.todo ? 'todo' : 'done';
  }
  return { file: PATHS.issues, mtime: st.mtime.toISOString(), size: st.size, episodes: eps, note: '只读解析；打钩只能 Andy 本人批，本页不写问题描述.txt' };
}

// ---------- ⑦ AI 会话 ----------
function rootOf(provider) {
  if (provider === 'claude') return PATHS.claude;
  if (provider === 'codex') return PATHS.codex;
  return null;
}
async function listSessions(provider, days) {
  const root = rootOf(provider);
  if (!root) return { provider, enabled: false, sessions: [], note: provider === 'kimi' ? 'Kimi：接口预留，默认关闭，未启用（启用需 Andy 本人批）' : '未知 provider' };
  const since = Date.now() - days * 86400000;
  const out = [];
  if (provider === 'claude') {
    const dirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const full = path.join(root, d.name);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.mtimeMs < since) return;
      const files = await fsp.readdir(full).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fs2 = await fsp.stat(path.join(full, f)).catch(() => null);
        if (fs2 && fs2.mtimeMs >= since) {
          // 2026-11-25：IC 自己起的写稿 Agent 归一组；桌面会话带上会话名（jsonl 里的 custom-title），页面不再只列文件名
          const ic = /infinite-creation-data-agent/i.test(d.name);
          out.push({ id: d.name + '/' + f, project: d.name, size: fs2.size, mtime: fs2.mtime.toISOString(), group: ic ? 'ic' : 'desk', name: ic ? null : await sessionTitle(path.join(full, f)).catch(() => null) });
        }
      }
    }));
  } else {
    for (let k = 0; k <= days + 14; k++) { // Codex 按开始日期分目录，老会话可能最近还在更新
      const dt = new Date(Date.now() - k * 86400000);
      const rel = [String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0')];
      const full = path.join(root, ...rel);
      const files = await fsp.readdir(full).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fs2 = await fsp.stat(path.join(full, f)).catch(() => null);
        if (fs2 && fs2.mtimeMs >= since) out.push({ id: rel.join('/') + '/' + f, project: rel.join('-'), size: fs2.size, mtime: fs2.mtime.toISOString() });
      }
    }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { provider, enabled: true, days, total: out.length, sessions: out.slice(0, 300) };
}
function safeSessionPath(provider, id) {
  const root = rootOf(provider);
  if (!root || !id || !id.endsWith('.jsonl') || DENY_NAME.test(path.basename(id))) return null;
  const full = path.resolve(root, id);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  return full;
}
function partText(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map(partText).filter(Boolean).join('\n');
  switch (p.type) {
    case 'text': case 'input_text': case 'output_text': return p.text || '';
    case 'thinking': case 'redacted_thinking': case 'reasoning': return '';
    case 'tool_use': return `[工具调用 ${p.name}] ` + JSON.stringify(p.input ?? {}).slice(0, 1500);
    case 'tool_result': return '[工具结果] ' + partText(p.content).slice(0, 1500);
    case 'image': case 'input_image': return '[图片]';
    default: return p.text || '';
  }
}
function extract(obj, provider) {
  const ts = obj.timestamp || obj.ts || null;
  if (provider === 'claude') {
    if (obj.type === 'summary') return { role: 'summary', ts, text: obj.summary || '' };
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;
    const text = partText(obj.message?.content);
    return text ? { role: obj.message?.role || obj.type, ts, text } : null;
  }
  if (obj.type === 'session_meta') return { role: 'meta', ts, text: `会话开始 cwd=${obj.payload?.cwd || ''}` };
  if (obj.type !== 'response_item') return null;
  const p = obj.payload || {};
  if (p.type === 'message') { const text = partText(p.content); return text ? { role: p.role, ts, text } : null; }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') return { role: 'tool', ts, text: `[工具调用 ${p.name}] ` + String(p.arguments ?? p.input ?? '').slice(0, 1500) };
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return { role: 'tool', ts, text: '[工具结果] ' + partText(p.output?.content ?? p.output).slice(0, 1500) };
  return null;
}
const countCache = new Map();
async function iterate(file, provider, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let idx = 0;
  for await (const line of rl) {
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const m = extract(obj, provider);
    if (!m) continue;
    if (fn(m, idx++) === false) { rl.close(); break; }
  }
  return idx;
}
async function readSession(provider, id, page, size) {
  const file = safeSessionPath(provider, id);
  if (!file) return { error: '路径不允许' };
  const st = await fsp.stat(file);
  const key = file + '|' + st.size + '|' + st.mtimeMs;
  let total = countCache.get(key);
  if (total == null) { total = await iterate(file, provider, () => true); countCache.set(key, total); }
  const pages = Math.max(1, Math.ceil(total / size));
  if (page < 0 || page >= pages) page = pages - 1;
  const from = page * size, to = from + size;
  const msgs = [];
  await iterate(file, provider, (m, i) => {
    if (i >= to) return false;
    if (i >= from) msgs.push({ i, role: m.role, ts: m.ts, text: redact(m.text.length > 4000 ? m.text.slice(0, 4000) + '…（截断）' : m.text) });
  });
  return { provider, id, size: st.size, mtime: st.mtime.toISOString(), total, page, pages, pageSize: size, messages: msgs };
}

// ---------- 正在干活的会话（只读，尾部读取，首屏要快） ----------
// 只从文件尾部读（默认 1.5MB），不全文件扫描；按 文件+大小+修改时间 缓存；所有文本过 redact
const liveCache = new Map();
async function readTail(file, maxBytes) {
  const st = await fsp.stat(file);
  const start = Math.max(0, st.size - maxBytes);
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(st.size - start); await fh.read(buf, 0, buf.length, start); const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean); if (start > 0) lines.shift(); return { st, lines, truncated: start > 0 }; }
  finally { await fh.close(); }
}
async function readHeadTitle(file, provider) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024); const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const l of buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const m = extract(o, provider); if (m && m.role === 'user' && m.text && !m.text.startsWith('[工具结果]') && !/^\s*<(local-command|command-|system-reminder)/.test(m.text)) return redact(m.text.replace(/\s+/g, ' ').slice(0, 60));
    }
  } catch {} finally { await fh.close(); }
  return null;
}
function liveStatus(objs, provider, mtimeMs) {
  const ageSec = Math.round((Date.now() - mtimeMs) / 1000);
  let state = '不明', tool = null, busy = null;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (provider === 'claude') {
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      const c = o.message?.content; const parts = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
      const tu = parts.filter((p) => p.type === 'tool_use');
      if (o.type === 'assistant' && tu.length) { tool = tu.map((p) => p.name).join('、'); state = `在调用工具：${tool}`; busy = true; break; }
      if (o.type === 'user' && parts.some((p) => p.type === 'tool_result')) { state = '工具已返回，在想下一步'; busy = true; break; }
      if (o.type === 'user') { state = '收到新消息，在想'; busy = true; break; }
      if (o.type === 'assistant') { const sr = o.message?.stop_reason; if (sr === 'end_turn' || sr === 'stop_sequence') { state = '这一轮答完了，在等下一条'; busy = false; } else { state = '在写回复'; busy = true; } break; }
    } else {
      const p = o.payload || {};
      if (o.type === 'event_msg' && /task_complete|turn_complete/.test(p.type || '')) { state = '这一轮做完了，在等下一条'; busy = false; break; }
      if (o.type !== 'response_item') continue;
      if (p.type === 'function_call' || p.type === 'custom_tool_call') { tool = p.name; state = `在调用工具：${p.name}`; busy = true; break; }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') { state = '工具已返回，在想下一步'; busy = true; break; }
      if (p.type === 'message') { state = p.role === 'assistant' ? '刚回复完' : '收到新消息，在想'; busy = p.role !== 'assistant'; break; }
    }
  }
  if (busy && ageSec > 180) state += `（已 ${Math.round(ageSec / 60)} 分钟没写入：可能在跑长命令，或已卡住）`;
  return { state, busy, tool, ageSec };
}
async function liveRead(provider, id, n) {
  const file = safeSessionPath(provider, id);
  if (!file) return { error: '路径不允许' };
  const st0 = await fsp.stat(file);
  const key = `${file}|${st0.size}|${st0.mtimeMs}|${n}`;
  const hit = liveCache.get(key); if (hit) { const { _objs, ...rest } = hit; return { ...rest, cached: true, status: liveStatus(_objs, provider, st0.mtimeMs) }; }
  let bytes = 1536 * 1024, r, objs, msgs;
  for (;;) {
    r = await readTail(file, bytes); objs = []; msgs = [];
    for (const l of r.lines) { let o; try { o = JSON.parse(l); } catch { continue; } objs.push(o); const m = extract(o, provider); if (m) msgs.push(m); }
    if (msgs.length >= n || !r.truncated || bytes >= 12 * 1024 * 1024) break;
    bytes *= 3;
  }
  const out = { provider, id, size: r.st.size, mtime: r.st.mtime.toISOString(), tailBytes: Math.min(bytes, r.st.size), olderNotLoaded: r.truncated, messages: msgs.slice(-n).map((m) => ({ role: m.role, ts: m.ts, text: redact(m.text.length > 3000 ? m.text.slice(0, 3000) + '…（截断）' : m.text) })) };
  const cwdObj = objs.find((o) => o.cwd || o.payload?.cwd); out.cwd = cwdObj ? redact(cwdObj.cwd || cwdObj.payload.cwd) : null;
  liveCache.set(key, { ...out, _objs: objs.slice(-50) }); if (liveCache.size > 40) liveCache.delete(liveCache.keys().next().value);
  return { ...out, cached: false, status: liveStatus(objs.slice(-50), provider, r.st.mtimeMs) };
}
const titleCache = new Map();
async function liveList() {
  await chatInit().catch(() => {});
  const reg = (() => { try { return chatRegistry(); } catch { return []; } })();
  const since = Date.now() - 10 * 60e3;
  const out = [];
  for (const provider of ['claude', 'codex']) {
    const l = await listSessions(provider, 1).catch(() => null);
    for (const s of (l?.sessions || []).filter((x) => new Date(x.mtime).getTime() >= since).slice(0, 15)) {
      const file = safeSessionPath(provider, s.id); if (!file) continue;
      let title = titleCache.get(file); if (title === undefined) { title = await readHeadTitle(file, provider); titleCache.set(file, title); }
      const r0 = reg.find((x) => x.cliSessionId && String(s.id).includes(x.cliSessionId));
      let status = null; try { const t = await readTail(file, 96 * 1024); const objs = []; for (const ln of t.lines.slice(-40)) { try { objs.push(JSON.parse(ln)); } catch {} } status = liveStatus(objs, provider, t.st.mtimeMs); } catch {}
      // 2026-11-26：优先用会话名（custom-title）；IC 内部写稿 Agent 归一组；都没有才退回第一条指令
      const nm = r0 ? `聊天·${r0.title}` : s.name || (s.group === 'ic' ? 'IC 内部写稿 Agent' : null);
      out.push({ provider, id: s.id, project: s.project, size: s.size, mtime: s.mtime, title: nm || (provider === 'codex' ? 'Codex 会话 ' : '会话 ') + String(s.id).split('/').pop().replace(/^rollout-[\dT:-]+-/, '').slice(0, 8), named: !!nm, firstLine: title || '', group: s.group || 'desk', chat: r0 ? r0.id : null, status });
    }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { at: new Date().toISOString(), windowMin: 10, sessions: out, note: '「正在干活」= 会话文件 10 分钟内有新内容；状态按文件最后几条记录推断（只读，不连进程）' };
}

// ---------- ⑩ 证据与日志 ----------
const EV_ROOTS = { cmd: PATHS.cmdDir, link: PATHS.linkDir };
async function evidence() {
  const out = {};
  for (const [k, dir] of Object.entries(EV_ROOTS)) {
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    out[k] = { dir, files: await Promise.all(ents.filter((e) => e.isFile()).map(async (e) => { const s = await fsp.stat(path.join(dir, e.name)); return { name: e.name, size: s.size, mtime: s.mtime.toISOString() }; })) };
    out[k].files.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }
  return out;
}
async function evidenceFile(root, name, maxLines) {
  const dir = EV_ROOTS[root];
  if (!dir || !name || name !== path.basename(name) || DENY_NAME.test(name) || !/\.(md|txt|json|log|diff)$/i.test(name)) return { error: '不允许' };
  const full = path.join(dir, name);
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) return { error: '不存在' };
  const lines = await tailLines(full, maxLines, 600 * 1024);
  return { root, name, path: full, size: st.size, mtime: st.mtime.toISOString(), tailLines: maxLines, content: redact((lines || []).join('\n')) };
}


// ---------- ⑨ 派工（只读） ----------
const DISPATCH_DIR = path.join(PATHS.cmdDir, '派工');
const MD5_LINE = /^([0-9A-Fa-f]{32})\s+(?:\d+\s+)?(.+)$/;
async function md5Entries(dir, max = 8) {
  try {
    const raw = (await fsp.readFile(path.join(dir, 'md5.txt'), 'utf8')).replace(/^\uFEFF/, '');
    const out = [];
    for (const l of raw.split(/\r?\n/)) { const m = MD5_LINE.exec(l.trim()); if (m) out.push({ path: path.join(dir, m[2].trim()), md5: m[1].toUpperCase() }); }
    return out.slice(0, max);
  } catch { return null; }
}
async function latestSubdirs(root, n, filter = () => true) {
  const ents = await fsp.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!ents) return null;
  const st = await Promise.all(ents.filter((e) => e.isDirectory() && filter(e.name)).map(async (e) => {
    const full = path.join(root, e.name); const s = await fsp.stat(full).catch(() => null);
    return s ? { name: e.name, full, mtime: s.mtimeMs } : null;
  }));
  return st.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, n);
}
async function dirDeliveries(dirs) {
  const out = [];
  for (const d of dirs || []) {
    const md5 = await md5Entries(d.full, 6);
    out.push({ title: d.name, at: new Date(d.mtime).toISOString(), path: d.full, items: md5 || [], note: md5 ? '' : '该目录没有 md5.txt' });
  }
  return out;
}
function mdEntries(raw, n) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const idx = []; lines.forEach((l, i) => { if (/^##\s/.test(l)) idx.push(i); });
  return idx.slice(-n).map((s, k, arr) => {
    const end = k + 1 < arr.length ? arr[k + 1] : lines.length;
    const all = idx.indexOf(s); const realEnd = all + 1 < idx.length ? idx[all + 1] : lines.length;
    return { title: lines[s].replace(/^##\s*/, ''), line: s + 1, body: lines.slice(s + 1, Math.min(realEnd, end)) };
  });
}
async function readText(file) { try { return await fsp.readFile(file, 'utf8'); } catch { return null; } }
const HEX32 = /md5[^0-9A-Fa-f\n]{0,4}([0-9A-Fa-f]{8,32})\b|\b([0-9A-Fa-f]{32})\b/i;
const WAIT_RE = /(等|待|未|STOP|暂停|拦|阻塞|需.{0,4}(批|点头|确认))/;

async function partyGpu() {
  const procs = await chainProcs();
  const runs = (await latestSubdirs(PATHS.gpuRuns, 4)) || [];
  const current = [];
  for (const c of procs.chains || []) current.push(`链进程 PID ${c.pid} ${c.script} ${c.args}（启动 ${c.started}）`);
  if (!current.length) current.push('进程表里没有正在运行的 gpu_*chain.py');
  const deliveries = [];
  for (const r of runs) {
    const lines = (await tailLines(path.join(r.full, 'chain.log'), 400)) || [];
    if (r === runs[0] && lines.length) current.push(`${r.name} 最后一行：${redact(lines.at(-1)).slice(0, 300)}`);
    const done = lines.filter((l) => /\sdone\s/.test(l) && !/chapter done/.test(l)).slice(-4).reverse();
    for (const l of done) {
      const mp4 = (l.match(/([A-Za-z]:\\[^\s]+\.mp4)/) || [])[1] || null;
      const sha = (l.match(/sha256\s+([0-9A-Fa-f]{64})/) || [])[1] || null;
      deliveries.push({ title: r.name, at: l.slice(0, 19), path: mp4, md5: null, sha256: sha, raw: redact(l).slice(0, 300) });
    }
  }
  const today = new Date(); const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const allRuns = (await fsp.readdir(PATHS.gpuRuns).catch(() => [])).filter((n) => n.includes(ymd));
  const underscore = path.join(M, '_');
  const waiting = [];
  const ents = await fsp.readdir(underscore).catch(() => []);
  for (const f of ents) {
    if (/\.STOP$/i.test(f)) waiting.push(`STOP 标记：${path.join(underscore, f)}`);
    const m = /^gpu_(.+)_chain\.py$/.exec(f);
    if (!m) continue;
    const st = await fsp.stat(path.join(underscore, f)).catch(() => null);
    if (!st || new Date(st.mtimeMs).toDateString() !== today.toDateString()) continue;
    const key = m[1];
    const running = (procs.chains || []).some((c) => c.script === f);
    const ran = allRuns.some((n) => n.startsWith(key + '_') || n.startsWith(key.replace(/_a1$/, '') + '_'));
    if (!running && !ran) waiting.push(`今天改过、还没有运行记录的链脚本：${f}（${new Date(st.mtimeMs).toLocaleTimeString('zh-CN', { hour12: false })}）`);
  }
  return {
    id: 'gpu', name: 'GPU生产', found: true,
    sources: [PATHS.gpuRuns + '\\*\\chain.log', '进程表（python gpu_*chain.py）', path.join(underscore, 'gpu_*_chain.py / *.STOP')],
    current, deliveries, deliveriesNote: 'chain.log 记录的是 sha256（不是 md5）；只列最近 4 个运行目录里的 done 行',
    waiting: waiting.length ? waiting : ['没有发现 STOP 标记或今天未运行的新脚本'], waitingNote: '「在等什么」由文件推断：链序本身不在文件里，以 GPU生产/总导 的排链为准',
  };
}
async function partyClaude() {
  const shared = path.join(PATHS.linkDir, 'Claude会话共享记录.md');
  const log = path.join(PATHS.cmdDir, '日志.md');
  const [a, b] = await Promise.all([readText(shared), readText(log)]);
  const ea = a ? mdEntries(a, 4) : [];
  const eb = b ? mdEntries(b, 3).filter((e) => !/^指挥日志/.test(e.title)) : [];
  const current = [...ea.slice(-3).reverse().map((e) => `共享记录 L${e.line}：${e.title}`), ...eb.reverse().map((e) => `指挥日志：${e.title}`)];
  const deliveries = [];
  for (const e of ea.slice().reverse()) {
    for (const l of e.body) if (HEX32.test(l)) deliveries.push({ title: e.title.slice(0, 60), at: e.title.slice(0, 16), path: ((l.match(/([A-Za-z]:\\[^\s`）)]+|M\\[^\s`）)]+|P\\[^\s`）)]+)/) || [])[1]) || null, md5: (() => { const mm = l.match(HEX32); return (mm[1] || mm[2]).toUpperCase(); })(), raw: redact(l.trim()).slice(0, 300) });
  }
  const reviews = await latestSubdirs(path.join(M, '_'), 2, (n) => /^审片_/.test(n));
  const waiting = [];
  for (const e of ea.slice(-2).reverse()) for (const l of e.body) if (WAIT_RE.test(l) && l.trim()) waiting.push(redact(l.trim()).slice(0, 240));
  return {
    id: 'claude', name: 'Claude', found: !!(a || b),
    sources: [shared, log, path.join(M, '_', '审片_*')],
    current: current.length ? current : ['暂无条目'],
    deliveries: deliveries.slice(0, 10), extraDeliveries: await dirDeliveries(reviews),
    deliveriesNote: '从共享记录最近 4 条里带 32 位 md5 的行抽取；另列最近的审片目录',
    waiting: waiting.slice(0, 8).length ? waiting.slice(0, 8) : ['最近条目里没有写「等/待」的行'], waitingNote: '从最近 2 条共享记录里含「等/待/未/STOP/需批」的行抽取',
  };
}
async function partyDirs(id, name, root, guessNote) {
  const dirs = await latestSubdirs(root, 4);
  if (!dirs) return { id, name, found: false, sources: [], current: [], deliveries: [], waiting: [], missing: '暂无数据源' };
  const top = dirs[0];
  const inner = top ? await latestSubdirs(top.full, 6) : [];
  const current = dirs.map((d) => `${d.name}（更新 ${new Date(d.mtime).toLocaleString('zh-CN', { hour12: false })}）`);
  if (inner && inner.length) current.push(`${top.name} 里最近动过：` + inner.map((d) => d.name).join('、'));
  return {
    id, name, found: true, sources: [root], sourceNote: guessNote,
    current, deliveries: [], extraDeliveries: await dirDeliveries(dirs), deliveriesNote: '列各目录的 md5.txt（没有就注明）',
    waiting: ['暂无数据源（这个目录里没有待办或等待记录）'],
  };
}
async function dispatchOrders() {
  const ents = await fsp.readdir(DISPATCH_DIR).catch(() => null);
  if (!ents) return { dir: DISPATCH_DIR, exists: false, orders: [], rules: DISPATCH_RULES, modelTable: MODEL_TABLE.map(({ re, ...m }) => m) };
  const orders = [];
  for (const f of ents.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const full = path.join(DISPATCH_DIR, f);
    const buf = await fsp.readFile(full).catch(() => null);
    if (!buf) continue;
    const md5 = crypto.createHash('md5').update(buf).digest('hex').toUpperCase();
    try { const data = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); orders.push({ file: f, md5, data, rule: checkOrder(data) }); }
    catch (e) { orders.push({ file: f, md5, error: 'JSON 解析失败：' + e.message }); }
  }
  return { dir: DISPATCH_DIR, exists: true, orders, rules: DISPATCH_RULES, modelTable: MODEL_TABLE.map(({ re, ...m }) => m) };
}
async function dispatchView() {
  const [gpu, claude, wf, asset, orders] = await Promise.all([
    partyGpu(), partyClaude(),
    partyDirs('workflow', '工作流', path.join(M, '工作流工作区'), '推测：M\\工作流工作区 是工作流的工作目录（目前只有 T2_返修教训通用规则 一个包）'),
    partyDirs('asset', '资产管理', path.join(P, '资产候选'), '推测：P\\资产候选 是资产管理出候选图的目录（Muse 产出在 Mac 上，agent1 只看得到落地的文件）'),
    dispatchOrders(),
  ]);
  const qc = { id: 'qc', name: '成片质检', found: false, sources: [], current: [], deliveries: [], waiting: [], missing: '暂无数据源', missingNote: '在 agent1 上没找到成片质检专属的工作目录或记录。M\\_\\审片_* 是 Claude 做的审片，记在 Claude 栏。' };
  return { at: new Date().toISOString(), readOnly: true, note: '只读，没有发单按钮。真正发单属于上线，要 Andy 批；在此之前各方照现在的分工干。', parties: [gpu, asset, wf, qc, claude], orders };
}

// ---------- 静态 & 代理 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webp': 'image/webp' };
async function serveStatic(req, res, pathname) {
  let file = path.resolve(DIST, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  let st = await fsp.stat(file).catch(() => null);
  if (!st || st.isDirectory()) { file = path.join(DIST, 'index.html'); st = await fsp.stat(file).catch(() => null); }
  if (!st) { res.writeHead(404); return res.end('dist 不存在'); }
  // index.html 不缓存（每次都拿最新构建）；带 hash 的 assets 照常长期缓存
  const isIndex = path.basename(file) === 'index.html';
  const cc = isIndex ? 'no-cache, no-store, must-revalidate' : (/[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cc });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function proxyGet(req, res) {
  const u = new URL(LIVE);
  const pr = http.request({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: { ...req.headers, host: u.host } }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  pr.on('error', (e) => send(res, 502, { error: '4610 不可达: ' + e.message }));
  pr.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // 问题描述编辑走自己独立的接口（只写配置的目标文件=测试副本、备份、记录、建议队列）；其余写请求照旧一律 403
    if (p === '/api/issues' || p.startsWith('/api/issues/')) return handleIssues(req, res, url);
    // 聊天走自己独立的接口（只写聊天沙箱目录 CMD_CHAT_ROOT）
    if (p === '/api/chat' || p.startsWith('/api/chat/')) return handleChat(req, res, url);
    // 设置页：Claude API 密钥（只存本机 local_secrets，接口只回 {set, last4}）；Codex 只读试用
    if (p.startsWith('/api/command/settings/claude-api')) return handleApiKey(req, res, p.slice('/api/command/'.length), send);
    if (p === '/api/command/codex-trial' || p.startsWith('/api/command/codex-trial/')) return handleTrial(req, res, p.slice('/api/command/'.length), send);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 403, { error: '指挥系统预览为只读：拒绝 ' + req.method + ' ' + p + '（不提交任何任务、不写任何数据）' });
    }
    if (p.startsWith('/api/command/')) {
      const sub = p.slice('/api/command/'.length);
      if (sub === 'ping') return send(res, 200, { ok: true, readOnly: true, port: PORT, live: LIVE, pid: process.pid });
      if (sub === 'overview') return send(res, 200, await overview());
      if (sub === 'ov') return handleOverview(req, res, url, send);
      if (sub === 'watchdog') return handleWatchdog(req, res, send);
      if (sub === 'episodes') return send(res, 200, await episodes());
      if (sub === 'sessions') {
        const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') || 3)));
        return send(res, 200, await listSessions(url.searchParams.get('provider') || 'claude', days));
      }
      if (sub === 'session') {
        const size = Math.min(200, Math.max(5, Number(url.searchParams.get('size') || 40)));
        const r = await readSession(url.searchParams.get('provider'), url.searchParams.get('id'), Number(url.searchParams.get('page') ?? -1), size);
        return send(res, r.error ? 400 : 200, r);
      }
      if (sub === 'live') { const t0 = Date.now(); const r = await liveList(); r.serverMs = Date.now() - t0; return send(res, 200, r); }
      if (sub === 'live/session') {
        const t0 = Date.now(); const n = Math.min(200, Math.max(5, Number(url.searchParams.get('n') || 60)));
        const r = await liveRead(url.searchParams.get('provider'), url.searchParams.get('id'), n).catch((e) => ({ error: String(e.message || e) }));
        if (!r.error && url.searchParams.get('since') && url.searchParams.get('since') === `${r.size}|${r.mtime}`) return send(res, 200, { unchanged: true, size: r.size, mtime: r.mtime, status: r.status, serverMs: Date.now() - t0 });
        r.serverMs = Date.now() - t0; return send(res, r.error ? 400 : 200, r);
      }
      if (sub === 'dispatch') return send(res, 200, await dispatchView());
      if (sub === 'evidence') return send(res, 200, await evidence());
      if (sub === 'evidence/file') {
        const r = await evidenceFile(url.searchParams.get('root'), url.searchParams.get('name'), Math.min(3000, Number(url.searchParams.get('lines') || 400)));
        return send(res, r.error ? 400 : 200, r);
      }
      return send(res, 404, { error: 'unknown' });
    }
    if (p === '/ws' || p.startsWith('/ws/')) return send(res, 404, { error: '预览不代理 WebSocket' });
    if (p.startsWith('/api/') || p.startsWith('/files/') || p.startsWith('/samples/')) return proxyGet(req, res);
    // 裸路径 / 默认进入指挥系统总览
    if (p === '/' && !url.searchParams.get('mode')) { res.writeHead(302, { location: '/?mode=command&sub=overview', 'cache-control': 'no-store' }); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
overviewInit({ listSessions, readSession });
server.listen(PORT, HOST, () => { trialInit().catch(() => {}); watchdogInit(); }); server.on('listening', () => console.log(`[command-preview] pid ${process.pid} http://${HOST}:${PORT} dist=${DIST} live=${LIVE} (GET only)`));
