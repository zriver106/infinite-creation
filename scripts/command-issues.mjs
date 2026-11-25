// 指挥系统 · 问题描述（可编辑）+ 返修进度推算 + GPU 状态栏（预览版）
// 写：只写配置里的目标文件（测试阶段是测试副本）、备份目录、修改记录、建议队列；桌面真文件在 Andy 点头前拒写。
// 读：chain.log / progress.json / 链脚本 / 进程表（只读）；IC 只发 GET；8189 只 GET /queue（3 秒超时）；ic.db 只读（worker + readOnly）；不连 8188；不碰 4610 进程。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { waiterStatus } from './command-waiter.mjs';
import { linkEpisodes, linksInit, setManual } from './command-links.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const M = 'C:\\Users\\usazr\\Documents\\moviePro';
const P = path.join(M, 'projects', '我在城市用交易系统修仙');
const G = path.join(M, '运行记录', 'gpu生产');
const U = path.join(M, '_');
const REAL_FILE = process.env.CMD_ISSUES_REAL_FILE || 'C:\\Users\\usazr\\Desktop\\问题描述.txt'; // 测试实例用环境变量指向副本
const TEST_DIR = path.join(M, 'Claude工作区', '指挥预览测试');
const CONFIG_FILE = process.env.CMD_ISSUES_CONFIG || path.join(TEST_DIR, 'issues-config.json');
const LIVE = process.env.CMD_LIVE_BACKEND || 'http://127.0.0.1:4610';
const PROJECT = '51ed8141-419f-4cf6-af96-406142970482';
const DEFAULT_CFG = {
  target: path.join(TEST_DIR, '问题描述_测试副本.txt'),
  realFile: REAL_FILE,
  allowRealFile: false, // Andy 看过点头后才改成 true 并把 target 切到 realFile
  backupDir: path.join(U, '问题描述备份_指挥预览'),
  logFile: path.join(TEST_DIR, '问题描述修改记录.jsonl'),
  suggestionsFile: path.join(TEST_DIR, '问题描述建议队列.json'),
  humans: ['Andy', '总导'],
  ais: ['AI-Claude', 'AI-Codex'],
  gpuOrder: ['style6_a1', 'rr1230d', 'rr1310', 'rr1500', 'ch19_21', 'rr1200e', 'rr1540', 'rr1550', 'rr1600'],
  // 还没审过的新链（Claude 审过放行后从这里去掉）；只影响显示「待审」
  reviewPending: [],
  // 放行记录（Claude 审过放行、还没被进程或等待器接手的链）：key -> { by, at, note }
  approvals: {},
};
let cfg = { ...DEFAULT_CFG };
async function loadCfg() {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  try { cfg = { ...DEFAULT_CFG, ...JSON.parse((await fsp.readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')) }; }
  catch { await fsp.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CFG, null, 2)); cfg = { ...DEFAULT_CFG }; }
  // 迁移：旧配置里的「第22–24章新链（待建）」就是 rr1550，rr1600 接在它后面（Claude 16:03 转述 GPU生产）
  if (Array.isArray(cfg.gpuOrder) && cfg.gpuOrder.some((k) => /待建/.test(k))) {
    const o = cfg.gpuOrder.filter((k) => !/待建/.test(k)); for (const k of ['rr1550', 'rr1600']) if (!o.includes(k)) o.push(k);
    cfg.gpuOrder = o; await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
}
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex').toUpperCase();
const nowIso = () => new Date().toISOString();
const STATUS_WORD = { done: '完成☑️', doing: '修改中', todo: '待修改' };
const STATUS_LABEL = { done: '完成', doing: '修改中', todo: '待修改' };

// ---------- 文件解析（保留格式） ----------
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) { if (/^\d+$/.test(s)) return Number(s); let t = 0, c = 0; for (const ch of s) { if (ch in CN) c = CN[ch]; else if (ch === '十') { t += (c || 1) * 10; c = 0; } else if (ch === '百') { t += (c || 1) * 100; c = 0; } } return t + c; }
function numCn(n) { const d = '零一二三四五六七八九'; if (n < 10) return d[n]; if (n < 20) return '十' + (n % 10 ? d[n % 10] : ''); if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : ''); return String(n); }
function statusOfTag(tag) { if (!tag) return null; if (/^完成|☑/.test(tag)) return 'done'; if (/^修改中|^进行中/.test(tag)) return 'doing'; if (/^待修改/.test(tag)) return 'todo'; return null; }
const TAG_RE = /^(.*?)(\s*-{3}\s*)([^-].*?)\s*$/; // 「正文 --- 标记」，分隔符原样保留
async function readDoc(file) {
  const buf = await fsp.readFile(file || cfg.target);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const str = buf.slice(bom ? 3 : 0).toString('utf8');
  const eol = str.includes('\r\n') ? '\r\n' : '\n';
  const lines = str.split(eol); // 末尾换行会留下一个空串，原样保留
  return { buf, bom, eol, lines, md5: md5(buf) };
}
function serialize(doc, lines) { const s = lines.join(doc.eol); return Buffer.concat([doc.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(s, 'utf8')]); }
function parse(lines) {
  const eps = []; let cur = null; let pend = null;
  const flush = () => { if (cur && pend) { cur.items.push({ ...pend, tag: '', status: 'todo', untagged: true }); } pend = null; };
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) { flush(); return; }
    // 带状态标记（--- 完成/修改中…）的行是问题行，不是集标题：如「第七集 1分29秒，…--- 修改中」写在第十七集下面（2026-11-25 Andy：第七集被误标未完成）
    const h = TAG_RE.test(raw) ? null : /^第([一二三四五六七八九十百零两\d]+)集(.*)$/.exec(t);
    if (h) { flush(); cur = { no: cnNum(h[1]), header: raw, headerLine: i, note: h[2], items: [] }; eps.push(cur); return; }
    if (/^-{5,}/.test(t)) { flush(); return; }
    if (!cur) return;
    const m = TAG_RE.exec(raw);
    const st = m ? statusOfTag(m[3]) : null;
    if (m && st) {
      const start = pend ? pend.start : i;
      const text = (pend ? pend.text : '') + m[1].trim();
      pend = null;
      cur.items.push({ start, end: i, text, tag: m[3], sep: m[2], status: st });
    } else if (/[，,、]$/.test(t)) {
      pend = pend ? { ...pend, text: pend.text + t } : { start: i, end: i, text: t };
      pend.end = i;
    } else { flush(); cur.items.push({ start: i, end: i, text: t, tag: '', status: 'todo', untagged: true }); }
  });
  flush();
  for (const e of eps) { e.lastLine = e.items.length ? e.items[e.items.length - 1].end : e.headerLine; e.items.forEach((it, k) => { it.key = `${e.no}:${it.start}`; it.orig = lines.slice(it.start, it.end + 1).join('\n'); }); }
  return eps;
}

// ---------- 修改操作 ----------
function applyOp(doc, op) {
  const lines = doc.lines.slice();
  const eps = parse(lines);
  const findItem = () => {
    for (const e of eps) for (const it of e.items) if (it.start === op.start) {
      if (it.orig !== op.orig) throw Object.assign(new Error('条目内容和你看到的不一致（文件可能被改过），请刷新'), { code: 409 });
      return { e, it };
    }
    throw Object.assign(new Error('找不到这一条，请刷新'), { code: 409 });
  };
  if (op.op === 'status') {
    const { it } = findItem();
    const word = STATUS_WORD[op.status]; if (!word) throw Object.assign(new Error('状态只能是 待修改/修改中/完成'), { code: 400 });
    const last = lines[it.end];
    const m = TAG_RE.exec(last);
    if (m && statusOfTag(m[3])) lines[it.end] = m[1] + m[2] + m[3].replace(/^(完成☑️|完成|修改中|进行中|待修改)/, word);
    else lines[it.end] = last.replace(/\s+$/, '') + ' --- ' + word;
    return lines;
  }
  if (op.op === 'edit') {
    const { it } = findItem();
    const text = String(op.text || '').trim(); if (!text || /[\r\n]/.test(text)) throw Object.assign(new Error('正文不能为空、不能换行'), { code: 400 });
    if (/-{3}/.test(text)) throw Object.assign(new Error('正文里不能含 ---（那是状态分隔符）'), { code: 400 });
    const newLine = it.tag ? text + it.sep + it.tag : text;
    lines.splice(it.start, it.end - it.start + 1, newLine);
    return lines;
  }
  if (op.op === 'add') {
    const text = String(op.text || '').trim(); if (!text || /[\r\n]/.test(text) || /-{3}/.test(text)) throw Object.assign(new Error('正文不能为空、不能换行、不能含 ---'), { code: 400 });
    const no = Number(op.episode); if (!(no > 0)) throw Object.assign(new Error('集数不对'), { code: 400 });
    const newLine = text + ' --- ' + (STATUS_WORD[op.status] || STATUS_WORD.todo);
    const ep = eps.find((e) => e.no === no);
    if (ep) lines.splice(ep.lastLine + 1, 0, newLine);
    else {
      let at = lines.length; while (at > 0 && lines[at - 1] === '') at--; // 插在末尾空行之前
      lines.splice(at, 0, '', `第${numCn(no)}集`, newLine);
    }
    return lines;
  }
  throw Object.assign(new Error('未知操作'), { code: 400 });
}
function lineDiff(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1, eb = b.length - 1; while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const out = [];
  for (let i = s; i <= ea; i++) out.push(`-${i + 1}: ${a[i]}`);
  for (let i = s; i <= eb; i++) out.push(`+${i + 1}: ${b[i]}`);
  return out;
}
async function appendLog(rec) { await fsp.appendFile(cfg.logFile, JSON.stringify({ at: nowIso(), ...rec }) + '\n'); }
let writing = false;
async function commit(op, operator, baseMd5, via, reason) {
  if (path.resolve(cfg.target).toLowerCase() === path.resolve(cfg.realFile).toLowerCase() && !cfg.allowRealFile) {
    await appendLog({ operator, op, result: 'refused', reason: '目标是桌面真文件，Andy 未点头，拒写' });
    throw Object.assign(new Error('目标是桌面真文件；Andy 点头前不写'), { code: 403 });
  }
  if (writing) throw Object.assign(new Error('另一笔写入正在进行，请稍后'), { code: 409 });
  writing = true;
  try {
    const doc = await readDoc();
    if (baseMd5 && doc.md5 !== String(baseMd5).toUpperCase()) {
      await appendLog({ operator, op, via, result: 'rejected_conflict', baseMd5, currentMd5: doc.md5, reason: '文件在你打开之后被外部改过，拒写' });
      throw Object.assign(new Error(`文件在你打开之后被改过（你看到的 md5 ${baseMd5}，现在 ${doc.md5}），已拒写，请刷新后再改`), { code: 409, currentMd5: doc.md5 });
    }
    const lines = applyOp(doc, op);
    const out = serialize(doc, lines);
    await fsp.mkdir(cfg.backupDir, { recursive: true });
    const ts = new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles', hour12: false }).replace(/[-:]/g, '').replace(' ', '_'); // 太平洋时间 年月日_时分秒
    const bak = path.join(cfg.backupDir, `${path.basename(cfg.target, '.txt')}_${ts}_${doc.md5.slice(0, 8)}.txt`);
    await fsp.writeFile(bak, doc.buf, { flag: 'wx' }).catch(async () => fsp.writeFile(bak.replace(/\.txt$/, '_' + crypto.randomBytes(2).toString('hex') + '.txt'), doc.buf));
    const tmp = cfg.target + '.writing';
    await fsp.writeFile(tmp, out);
    // 写之前再核一次：防止备份到写入之间被外部改
    const again = md5(await fsp.readFile(cfg.target));
    if (again !== doc.md5) { await fsp.rename(tmp, tmp + '.discarded_' + ts); throw Object.assign(new Error('写入前一刻文件又被改了，已放弃，请刷新'), { code: 409 }); }
    await fsp.rename(tmp, cfg.target);
    const after = md5(await fsp.readFile(cfg.target));
    const diff = lineDiff(doc.lines, lines);
    // 写后重读核对：BOM、换行符、改动行都要和预期一致
    const re = await readDoc(); const verify = { bom: re.bom === doc.bom, eol: re.eol === doc.eol, md5: re.md5 === md5(out), lines: re.lines.length === lines.length && re.lines.every((l, i) => l === lines[i]) };
    const verifyOk = Object.values(verify).every(Boolean);
    await appendLog({ operator, op, via, reason: reason || null, result: verifyOk ? 'written' : 'written_verify_failed', target: cfg.target, beforeMd5: doc.md5, afterMd5: after, backup: bak, bom: re.bom, eol: re.eol === '\r\n' ? 'CRLF' : 'LF', verify, changedLines: diff.filter((d) => d.startsWith('+')).map((d) => Number(d.slice(1, d.indexOf(':')))), diff });
    if (!verifyOk) throw Object.assign(new Error('写后核对不过（BOM/换行/内容），备份在 ' + bak), { code: 500 });
    return { ok: true, beforeMd5: doc.md5, afterMd5: after, backup: bak, diff, verify };
  } finally { writing = false; }
}

// ---------- 建议队列 ----------
async function loadSugs() { try { return JSON.parse(await fsp.readFile(cfg.suggestionsFile, 'utf8')); } catch { return []; } }
async function saveSugs(a) { await fsp.writeFile(cfg.suggestionsFile, JSON.stringify(a, null, 2)); }
async function addSuggestion(s) {
  const a = await loadSugs();
  if (s.dedupKey && a.some((x) => x.dedupKey === s.dedupKey && x.state === 'pending')) return null;
  const rec = { id: 'S' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), state: 'pending', created: nowIso(), ...s };
  a.push(rec); await saveSugs(a);
  await appendLog({ operator: s.by, result: 'suggested', suggestion: rec.id, op: s.op, reason: s.reason });
  return rec;
}

// ---------- GPU 链状态（只读） ----------
let procCache = { at: 0, v: [], ps: [] };
function readProcs() {
  if (Date.now() - procCache.at < 5000) return Promise.resolve(procCache);
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name like 'python%' or Name like 'powershell%' or Name like 'pwsh%'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true, maxBuffer: 8 << 20 }, (e, out) => {
    let a = []; try { a = JSON.parse(out || '[]'); } catch {} if (!Array.isArray(a)) a = [a];
    const py = a.filter((p) => p && /^python/i.test(p.Name || '') && /gpu_[\w\-]+_chain\.py/i.test(p.CommandLine || ''));
    const v = py.map((p) => ({ pid: p.ProcessId, key: (p.CommandLine.match(/gpu_([\w\-]+)_chain\.py/i) || [])[1], after: ((p.CommandLine.match(/--after=(\S+)/) || [])[1]) || '(默认)', dry: /--dry-run/.test(p.CommandLine) }));
    const ps = a.filter((p) => p && /^(powershell|pwsh)/i.test(p.Name || '') && /arm_waiter/i.test(p.CommandLine || '')).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine }));
    procCache = { at: Date.now(), v, ps }; res(procCache);
  }));
}
async function chainProcs() { return (await readProcs()).v; }
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
// 某链最近一个日志目录（<key>_chain_YYYYMMDD，取日期最大的，最多回看 2 天）
function latestChainDir(key) {
  let names = []; try { names = fs.readdirSync(G); } catch { return null; }
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_chain_(\\d{8})$`);
  const hit = names.map((n) => { const m = re.exec(n); return m ? { n, d: m[1] } : null; }).filter(Boolean).sort((a, b) => b.d.localeCompare(a.d))[0];
  if (!hit) return null;
  const st = fs.statSync(path.join(G, hit.n), { throwIfNoEntry: false });
  return st && Date.now() - st.mtimeMs < 2 * 86400e3 ? path.join(G, hit.n) : null;
}
// ic.db 只读（同总览：worker 线程 + readOnly，限时）
const IC_DB = process.env.CMD_IC_DB || 'C:/tmp_infinite_creation/infinite-creation/data/ic.db';
function runIcDb(mode, timeoutMs = 8000) {
  if (process.env.CMD_GPU_NO_DB) return Promise.resolve({ error: '测试模式不读 ic.db' });
  return new Promise((resolve) => {
    const w = new Worker(new URL('./command-overview-db.mjs', import.meta.url), { execArgv: [], workerData: { dbPath: IC_DB, project: PROJECT, mode, now: Date.now() } });
    const tm = setTimeout(() => { w.terminate(); resolve({ error: `ic.db 查询超时（>${timeoutMs / 1000} 秒）` }); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(tm); resolve(m); w.terminate(); });
    w.once('error', (e) => { clearTimeout(tm); resolve({ error: String(e.message || e) }); });
  });
}
// 8189 队列（只 GET，3 秒超时）
async function comfyQueue() {
  if (process.env.CMD_GPU_NO_COMFY) return { ok: false, error: '查不到' };
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 3000);
    const r = await fetch('http://127.0.0.1:8189/queue', { signal: ac.signal }); clearTimeout(tm);
    const j = await r.json();
    return { ok: true, running: (j.queue_running || []).length, pending: (j.queue_pending || []).length };
  } catch { return { ok: false, error: '查不到' }; }
}
const chNum = (c) => Number(String(c || '').replace(/\D/g, '')) || null;
const shotsPreview = (shots, n = 6) => ({ head: shots.slice(0, n), more: Math.max(0, shots.length - n), total: shots.length });
async function readLines(f) { try { return (await fsp.readFile(f, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/); } catch { return null; } }
// chain.log 增量读：第一次整读建缓存，之后只读新增字节；文件变小（截断/换文件）就重建
const logCache = new Map();
export async function readLogLines(f) {
  let st; try { st = await fsp.stat(f); } catch { logCache.delete(f); return null; }
  let c = logCache.get(f);
  const out = (x) => x.lines.concat(x.rest.length ? [x.rest.toString('utf8')] : []);
  if (c && st.size === c.size) return out(c);
  if (!c || st.size < c.size) c = { size: 0, lines: [], rest: Buffer.alloc(0), rebuilds: c ? c.rebuilds + 1 : 0 };
  const fh = await fsp.open(f, 'r');
  try {
    const len = st.size - c.size; const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, c.size);
    const all = Buffer.concat([c.rest, buf]); const k = all.lastIndexOf(0x0a);
    const whole = k >= 0 ? all.subarray(0, k + 1) : Buffer.alloc(0);
    c.rest = Buffer.from(k >= 0 ? all.subarray(k + 1) : all);
    let t = whole.toString('utf8'); if (!c.lines.length) t = t.replace(/^\uFEFF/, '');
    const L = t.split(/\r?\n/); L.pop(); for (const x of L) c.lines.push(x);
  } finally { await fh.close(); }
  c.size = st.size; logCache.set(f, c);
  return out(c);
}
export function logCacheStats() { return [...logCache.entries()].map(([f, c]) => ({ file: f, bytes: c.size, lines: c.lines.length, rebuilds: c.rebuilds })); }
// 链脚本只读解析：多行 PLAN、镜号→id、默认 --after、自己的 STOP 名、UPSTREAM_PY 映射
const scriptCache = new Map();
export async function scriptMeta(key) {
  const f = path.join(U, `gpu_${key}_chain.py`);
  const st = await fsp.stat(f).catch(() => null); if (!st) return null;
  const c = scriptCache.get(f); if (c && c.mtime === st.mtimeMs) return c.v;
  const src = (await fsp.readFile(f, 'utf8')).replace(/^\uFEFF/, '');
  const plan = [];
  const pm = /^PLAN\s*=\s*\[/m.exec(src);
  if (pm) {
    let i = pm.index + pm[0].length, d = 1; const s0 = i;
    while (i < src.length && d > 0) { const ch = src[i]; if (ch === '[') d++; else if (ch === ']') d--; i++; }
    for (const m of src.slice(s0, i - 1).matchAll(/\(\s*'(第\d+章)'\s*,\s*\[([\d,\s]*)\]/g)) plan.push({ ch: m[1], nums: m[2].split(',').map((x) => Number(x.trim())).filter((x) => x > 0) });
  }
  const ids = {}; for (const m of src.matchAll(/\('(第\d+章)',\s*(\d+)\):\s*'([0-9a-f]{6,})'/g)) ids[`${m[1]}#${m[2]}`] = m[3];
  const am = /^AFTER\s*=.*?or\s*\[\s*'([^']*)'\s*\]\s*\)/m.exec(src);
  const stopm = /^STOPF\s*=.*?'([^'\\/]+)\.STOP'/m.exec(src);
  const upPy = {}; const um = /^UPSTREAM_PY\s*=\s*\{([^}]*)\}/m.exec(src);
  if (um) for (const m of um[1].matchAll(/'([^']+)'\s*:\s*'gpu_([\w\-]+)_chain\.py'/g)) upPy[m[1]] = m[2];
  const v = { file: f, mtime: st.mtimeMs, plan, ids, defaultAfter: am ? (am[1] || null) : null, afterFound: !!am, stopName: stopm ? stopm[1] : null, upPy, total: plan.reduce((x, p) => x + p.nums.length, 0) };
  scriptCache.set(f, { mtime: st.mtimeMs, v }); return v;
}
function rangeTxt(nums) {
  const a = [...new Set(nums)].sort((x, y) => x - y); const out = [];
  for (let i = 0; i < a.length; i++) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(j > i ? `${a[i]}–${a[j]}` : `${a[i]}`); i = j; }
  return out.join('、');
}
// 链的中文名：英文 key 只放悬停
export function chainLabel(key, plan) {
  if (/待建/.test(key)) return key;
  if (/^style/i.test(key)) return `画风测试${(key.match(/\d+/) || [''])[0]}`;
  const chs = (plan || []).map((p) => Number((p.ch.match(/\d+/) || [0])[0])).filter(Boolean);
  const range = chs.length ? `第${rangeTxt(chs)}集` : '集数未知';
  const tm = /^rr(\d{2})(\d{2})/.exec(key);
  if (tm) return `${range}返修 · ${tm[1]}:${tm[2]} 批`;
  return `${range}出片`;
}
async function chainInfo(key, procs) {
  const meta = await scriptMeta(key);
  const info = { key, script: meta ? meta.file : null, plan: meta ? meta.plan : [], ids: meta ? meta.ids : {}, state: 'missing', done: 0, total: 0, current: null, after: null, pid: null, lastLine: null, startedAt: null, doneAt: null, shots: [], label: chainLabel(key, meta ? meta.plan : []), defaultAfter: meta ? meta.defaultAfter : null, upPy: meta ? meta.upPy : {}, logNote: null };
  if (!meta) return info;
  info.total = meta.total;
  let dir = path.join(G, `${key}_chain_${ymd()}`);
  if (!fs.existsSync(dir)) { const alt = latestChainDir(key); if (alt) dir = alt; } // 跨午夜：链昨天起的，日志还在昨天日期的目录
  if (!fs.existsSync(dir) && meta.stopName && meta.stopName !== key && fs.existsSync(path.join(G, `${meta.stopName}_chain_${ymd()}`))) { dir = path.join(G, `${meta.stopName}_chain_${ymd()}`); info.logNote = `脚本内部名是 ${meta.stopName}，日志写在 ${meta.stopName}_chain 目录（与同名链共用）`; }
  info.logDir = dir;
  let log = (await readLogLines(path.join(dir, 'chain.log'))) || [];
  const starts = log.map((l) => /^(\S+) \S+ chain start/.exec(l)).filter(Boolean);
  if (starts.length) { const t = new Date(starts[starts.length - 1][1]).getTime(); if (t && t < meta.mtime - 1000) { info.logNote = (info.logNote ? info.logNote + '；' : '') + `日志最后一次启动 ${starts[starts.length - 1][1].slice(11)} 早于脚本当前版本（${new Date(meta.mtime).toLocaleTimeString('zh-CN', { hour12: false })}），视为旧日志，不计入`; log = []; } }
  const p = procs.find((x) => x.key === key && !x.dry);
  if (p) { info.pid = p.pid; info.after = p.after; }
  const sub = new Map(), done = new Map();
  const planShots = []; const blocks = [];
  for (const l of log) {
    if (!l) continue;
    if (/chain start/.test(l)) info.startedAt = l.slice(0, 19);
    let m;
    if ((m = /^(\S+) PLAN (第\d+章) #(\d+) ([0-9a-f-]{36})/.exec(l))) { if (!planShots.some((s) => s.id === m[4])) planShots.push({ ch: m[2], num: Number(m[3]), id: m[4] }); }
    else if ((m = /^(\S+) submitted (第\d+章) (\d+) ([0-9a-f-]{36}) ([0-9a-f-]{36})/.exec(l))) sub.set(m[4], { at: m[1], ch: m[2], num: Number(m[3]), job: m[5] });
    else if ((m = /^(\S+) submitted idx (\d+) .*? ([0-9a-f-]{36}) job ([0-9a-f-]{36})/.exec(l))) sub.set(m[3], { at: m[1], ch: '', num: Number(m[2]), job: m[4] });
    else if ((m = /^(\S+) done (第\d+章) (\d+) ([0-9a-f-]{36}) ([\d.]+) ([\d.]+)/.exec(l))) done.set(m[4], { at: m[1], ch: m[2], num: Number(m[3]), dur: Number(m[5]), elapsed: Number(m[6]) });
    else if ((m = /^(\S+) done idx (\d+) .*? vid ([0-9a-f-]{36}).*?elapsed ([\d.]+)/.exec(l))) { const id = [...sub.entries()].find(([, v]) => v.num === Number(m[2]) && !v.ch); if (id) done.set(id[0], { at: m[1], ch: '', num: Number(m[2]), elapsed: Number(m[4]) }); }
    if (/^\S+\s+[A-Za-z0-9_]+ done(\s|$)/.test(l)) info.doneAt = l.slice(0, 19);
    if (/\bstopped\b|\bStop\b|blocked now \[[^\]]/.test(l)) blocks.push(l.slice(0, 300));
  }
  info.blocks = blocks.slice(-5);
  info.lastLine = log.filter(Boolean).slice(-1)[0] || null;
  if (planShots.length) { info.shots = planShots; info.total = planShots.length; }
  else info.shots = info.plan.flatMap((pl) => pl.nums.map((n) => ({ ch: pl.ch, num: n, id: info.ids[`${pl.ch}#${n}`] || null })));
  info.shots = info.shots.map((s) => { const full = s.id && [...sub.keys(), ...done.keys()].find((k) => k.startsWith(s.id)); const id = full || s.id; return { ...s, id, submitted: id && sub.get(id)?.at || null, job: id && sub.get(id)?.job || null, done: id && done.get(id)?.at || null }; });
  info.done = done.size; if (!info.total) info.total = Math.max(sub.size, done.size);
  const curId = [...sub.keys()].filter((k) => !done.has(k)).pop();
  if (curId) info.current = { id: curId, ...sub.get(curId) };
  info.samples = [...done.values()].map((d) => d.elapsed).filter((x) => x > 0);
  if (info.doneAt) info.state = 'done';
  else if (info.pid) info.state = info.current ? 'running' : (/waiting|armed/.test(info.lastLine || '') || !log.length ? 'waiting' : 'running');
  else info.state = log.length ? 'stopped' : 'ready';
  return info;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
async function allTodaySamples() {
  // 今天日期的目录 + 跨午夜还在写的旧日期目录（链按启动日期建目录）；样本只取今天日期的 done 行
  const day = ymd(); const dayIso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const dirs = [];
  for (const n of await fsp.readdir(G).catch(() => [])) { if (n.includes(day)) { dirs.push(n); continue; } if (!/_\d{8}$/.test(n)) continue; const st = await fsp.stat(path.join(G, n, 'chain.log')).catch(() => null); if (st && st.mtimeMs >= t0.getTime()) dirs.push(n); }
  const out = [];
  for (const d of dirs) { const L = await readLogLines(path.join(G, d, 'chain.log')); if (!L) continue; for (const l of L) { let m; if ((m = /^(\S+) done 第\d+章 \d+ [0-9a-f-]{36} [\d.]+ ([\d.]+)/.exec(l))) out.push({ at: m[1], s: Number(m[2]) }); else if ((m = /^(\S+) done idx \d+ .*?elapsed ([\d.]+)/.exec(l))) out.push({ at: m[1], s: Number(m[2]) }); } }
  for (let i = out.length - 1; i >= 0; i--) if (!out[i].at.startsWith(dayIso)) out.splice(i, 1);
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(-40).map((x) => x.s);
}
// 链日志里的 IC 任务 id → 链名（最近 24 小时动过的日志目录）
async function jobChainMap() {
  const m = new Map();
  const dirs = await fsp.readdir(G).catch(() => []);
  for (const d of dirs) {
    const mm = /^(.+)_chain_\d{8}$/.exec(d); if (!mm) continue;
    const f = path.join(G, d, 'chain.log'); const st = await fsp.stat(f).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > 24 * 3600e3) continue;
    const L = await readLogLines(f); if (!L) continue;
    for (const l of L) { const x = /^\S+ submitted (?:第\d+章 \d+|idx \d+ .*?) [0-9a-f-]{36}(?: job)? ([0-9a-f-]{36})/.exec(l); if (x) m.set(x[1], mm[1]); const y = /^\S+ done 第\d+章 \d+ ([0-9a-f-]{36}) /.exec(l); if (y) m.set(y[1], mm[1]); }
  }
  return m;
}
// 新版 GPU 面板数据：now / today / upcoming / recent / diag（旧字段不动）
async function gpuGlance({ info, procs, running, per, samples, superseded }) {
  const [db, comfy, jmap] = await Promise.all([runIcDb('gpu'), comfyQueue(), jobChainMap()]);
  const nowMs = Date.now();
  const dbOk = !db.error;
  const icActive = dbOk ? db.active || [] : [];
  const icRun = icActive.filter((j) => j.status === 'running' && ['regenerate', 'create'].includes(j.type));
  let current = null;
  if (running && running.current) {
    const at = Date.parse(running.current.at) || null;
    current = { ch: chNum(running.current.ch), num: running.current.num, source: 'chain', chain: running.key, label: running.label, job: running.current.job || null, startedAt: at ? new Date(at).toISOString() : null, runMin: at ? Math.round((nowMs - at) / 6000) / 10 : null };
  } else if (icRun.length) {
    const j = icRun[0];
    current = { ch: chNum(j.ch), num: j.idx, source: 'ic', chain: jmap.get(j.id) || null, label: jmap.get(j.id) || null, job: j.id, startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null, runMin: j.startedAt ? Math.round((nowMs - j.startedAt) / 6000) / 10 : null };
  }
  const busy = !!current || (comfy.ok && comfy.running > 0);
  const lastDone = dbOk ? db.lastGenFinished : null;
  const now = {
    busy, state: busy ? '出片中' : '空闲',
    idleMin: !busy && lastDone ? Math.round((nowMs - lastDone) / 6000) / 10 : null, idleSince: !busy && lastDone ? new Date(lastDone).toISOString() : null,
    current,
    comfy: comfy.ok ? { ok: true, running: comfy.running, pending: comfy.pending } : { ok: false, error: comfy.error },
    ic: dbOk ? { ok: true, running: icActive.filter((j) => j.status === 'running').map((j) => ({ type: j.type, ch: chNum(j.ch), idx: j.idx, job: j.id.slice(0, 8) })), queued: icActive.filter((j) => j.status !== 'running').map((j) => ({ type: j.type, ch: chNum(j.ch), idx: j.idx, job: j.id.slice(0, 8) })) } : { ok: false, error: db.error },
  };
  const today = dbOk ? {
    ok: true, videos: db.today.videos, selected: db.today.selected, unselected: db.today.unselected, failedJobs: db.today.failedJobs,
    perShotSec: per, sampleCount: samples.length,
    idleMin: db.busyToday ? Math.round((db.busyToday.spanMs - db.busyToday.busyMs) / 6000) / 10 : null,
    busyMin: db.busyToday ? Math.round(db.busyToday.busyMs / 6000) / 10 : null,
    hourly: (db.hourly || []).map((h) => ({ at: new Date(h.from).toISOString(), n: h.n })),
    note: '出片＝ic.db shot_videos 今天（太平洋时间）新建条数；忙闲＝ic.db 重生成/新建任务运行区间并集（含所有项目）；灰片拦截库里没有字段，不单列',
  } : { ok: false, error: db.error, perShotSec: per, sampleCount: samples.length };
  // 接下来：最近 6 小时改过、没跑完、没被取代、没有 .STOP 的链脚本（最多 3 条）
  const cand = new Map(info);
  for (const f of await fsp.readdir(U).catch(() => [])) {
    const m = /^gpu_(.+)_chain\.py$/.exec(f); if (!m || cand.has(m[1])) continue;
    const st = await fsp.stat(path.join(U, f)).catch(() => null);
    if (st && nowMs - st.mtimeMs < 6 * 3600e3) cand.set(m[1], await chainInfo(m[1], procs));
  }
  const supKeys = new Set(superseded.map((s) => s.key));
  const stopped = (c) => { const sn = scriptCache.get(c.script)?.v?.stopName || c.key; return fs.existsSync(path.join(U, `${sn}.STOP`)); };
  const mt = (c) => scriptCache.get(c.script)?.mtime || 0;
  const rank = { running: 0, waiting: 1, ready: 2, stopped: 3 };
  const upcoming = [...cand.values()]
    .filter((c) => c.script && (c.state === 'running' || nowMs - mt(c) < 6 * 3600e3) && c.state !== 'done' && c.state !== 'missing' && !c.superseded && !supKeys.has(c.key) && !stopped(c) && (c.total || 0) - (c.done || 0) > 0)
    .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || mt(a) - mt(b))
    .slice(0, 3)
    .map((c) => { const sh = (c.shots || []).map((s) => ({ ch: chNum(s.ch), num: s.num, done: !!s.done })); return { key: c.key, label: c.label, state: c.state, total: c.total, done: c.done, remaining: Math.max(0, (c.total || 0) - (c.done || 0)), mtime: new Date(mt(c)).toISOString(), shots: shotsPreview(sh).head, more: shotsPreview(sh).more, allShots: sh }; });
  const recent = dbOk ? (db.recent || []).map((v) => ({ at: new Date(v.at).toISOString(), ch: chNum(v.ch), num: v.idx, dur: v.dur, selected: v.selected, ...(() => { const ch = jmap.get(v.id) || (v.job && jmap.get(v.job)); return { source: ch || (v.job ? v.job.slice(0, 8) : null), sourceKind: ch ? 'chain' : v.job ? 'job' : null, job: v.job ? v.job.slice(0, 8) : null }; })() })) : [];
  // 排链诊断（旧）：只留在跑 / 在等 / 未完成、24 小时内动过的
  const moved = (c) => { const lm = c.logDir ? (fs.statSync(path.join(c.logDir, 'chain.log'), { throwIfNoEntry: false })?.mtimeMs || 0) : 0; return Math.max(mt(c), lm) > nowMs - 24 * 3600e3; };
  const diag = [...info.values()].filter((c) => c.script && c.state !== 'done' && c.state !== 'missing' && !c.superseded && (c.pid || moved(c))).map((c) => { const sh = (c.shots || []).filter((s) => !s.done).map((s) => `${chNum(s.ch)}#${s.num}`); return { key: c.key, label: c.label, state: c.state, done: c.done, total: c.total, upstream: c.upstream, upstreamLabel: c.upstreamLabel || null, refPos: c.refPos ?? null, mismatch: !!c.mismatch, pid: c.pid || null, shots: sh.slice(0, 6), more: Math.max(0, sh.length - 6) }; });
  return { now, today, upcoming, recent, diag };
}
export async function gpuQueue() {
  await ready();
  const { v: procs, ps } = await readProcs();
  const waiters = await waiterStatus(ps, U);
  const aw = waiters.find((w) => w.alive && w.state === 'alive') || null; // 正在起作用的等待器
  const cfgRef = cfg.gpuOrder.filter((k) => !/待建/.test(k));
  const wkeys = aw ? aw.steps.map((x) => x.key) : [];
  const pend = Array.isArray(cfg.reviewPending) ? cfg.reviewPending : [];
  const appr = cfg.approvals && typeof cfg.approvals === 'object' ? cfg.approvals : {};
  let ref = cfgRef;
  // 候选链：参考顺序 + 进程里的 + 今天改过的链脚本
  const keys = [...ref];
  for (const p of procs) if (p.key && !keys.includes(p.key)) keys.push(p.key);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  try {
    const found = [];
    for (const f of await fsp.readdir(U)) { const m = /^gpu_(.+)_chain\.py$/.exec(f); if (!m || keys.includes(m[1])) continue; const st = await fsp.stat(path.join(U, f)).catch(() => null); if (st && st.mtimeMs >= today.getTime()) found.push({ key: m[1], mtime: st.mtimeMs }); }
    found.sort((a, b) => a.mtime - b.mtime); for (const x of found) keys.push(x.key);
  } catch {}
  const info = new Map();
  for (const k of wkeys.concat(pend, Object.keys(appr))) if (!keys.includes(k)) keys.push(k);
  for (const k of keys) info.set(k, await chainInfo(k, procs));
  // 参考顺序以实际等待器为准：已跑完/在跑的按原口述顺序在前，之后接等待器的执行顺序，未审的新链放最后
  if (aw) {
    const head = cfgRef.filter((k) => !wkeys.includes(k) && ['done', 'running'].includes(info.get(k)?.state));
    const tail = cfgRef.filter((k) => !wkeys.includes(k) && !head.includes(k) && !pend.includes(k));
    ref = [...head, ...wkeys, ...tail];
  }
  for (const k of [...pend, ...Object.keys(appr)]) if (!ref.includes(k) && info.get(k)?.script) ref = [...ref, k];
  // 等待器每一步落到链上
  if (aw) for (const st of aw.steps) { const c = info.get(st.key); if (!c) continue; c.waiter = { name: aw.name, pid: aw.pid, kind: st.kind, status: st.status, after: st.after, at: st.at }; if (st.kind === 'launch' && st.status === 'armed' && !c.pid && c.state !== 'done') c.waiterArmed = true; }
  for (const k of pend) { const c = info.get(k); if (c && c.state !== 'done' && !c.pid) c.reviewPending = true; }
  for (const [k, v] of Object.entries(appr)) { const c = info.get(k); if (!c) continue; c.approval = v; if (c.state !== 'done' && !c.pid && !c.waiterArmed) { c.reviewPending = false; c.approvedWaiting = true; } }
  // 每条链的实际上游：在跑的进程看命令行 --after，否则看脚本默认 --after；内部名经 UPSTREAM_PY 映射到脚本名
  const nameToKey = (name, c) => { if (!name || name === 'none') return null; if (c.upPy && c.upPy[name]) return c.upPy[name]; return name; };
  for (const c of info.values()) {
    const byProc = c.pid && c.after && c.after !== '(默认)';
    const byWaiter = !c.pid && c.waiterArmed && c.waiter.after;
    const a = byProc ? c.after : byWaiter ? c.waiter.after : c.defaultAfter;
    c.upstreamName = a || null; c.upstream = nameToKey(a, c);
    c.upstreamSrc = byProc ? '进程命令行' : byWaiter ? `等待器 ${c.waiter.name} 的启动参数 --after` : (a ? '脚本默认 --after' : (c.script ? '脚本没有默认上游（启动时手动指定）' : '无脚本'));
  }
  // 只保留有意义的：参考顺序里的、在跑/在等的、今天新出现且还没跑完的
  const keep = (c) => ref.includes(c.key) || c.pid || !['done', 'stopped'].includes(c.state);
  // 同一个内部名（STOP 文件名）有多份脚本时，旧版视为被新版取代，不进链序（例如 rr1200d 被 rr1200e 取代）
  const superseded = [];
  const byStop = new Map(); for (const c of info.values()) { const sn = scriptCache.get(c.script)?.v?.stopName; if (!sn) continue; if (!byStop.has(sn)) byStop.set(sn, []); byStop.get(sn).push(c); }
  for (const arr of byStop.values()) if (arr.length > 1) { arr.sort((a, b) => (scriptCache.get(b.script)?.mtime || 0) - (scriptCache.get(a.script)?.mtime || 0)); for (const c of arr.slice(1)) if (!c.pid && c.state !== 'running') { c.superseded = arr[0].key; superseded.push({ key: c.key, label: c.label, by: arr[0].key }); } }
  const live = [...info.values()].filter((c) => keep(c) && !c.superseded);
  // 推出的链序：从在跑的链（没有就从最早未完成的）沿「谁接在谁后面」往下走；一条上游后面接了多条就标冲突
  const kids = new Map(); for (const c of live) { if (!c.upstream) continue; if (!kids.has(c.upstream)) kids.set(c.upstream, []); kids.get(c.upstream).push(c); }
  for (const a of kids.values()) a.sort((x, y) => (scriptCache.get(x.script)?.mtime || 0) - (scriptCache.get(y.script)?.mtime || 0));
  const derived = []; const seen = new Set(); const conflicts = [];
  for (const [up, arr] of kids) { const open = arr.filter((x) => x.state !== 'done'); if (open.length > 1) conflicts.push({ upstream: up, children: open.map((x) => x.key) }); }
  const walk = (c, depth) => { if (seen.has(c.key)) return; seen.add(c.key); derived.push({ key: c.key, depth }); const ks = (kids.get(c.key) || []).filter((x) => !seen.has(x.key) && x.state !== 'done'); ks.forEach((x, i) => walk(x, depth + (ks.length > 1 && i > 0 ? 1 : 0))); };
  const running = live.find((c) => c.state === 'running');
  if (running) walk(running, 0);
  // 其它没接上的根：上游不存在 / 已跑完 / 没在候选里
  const roots = live.filter((c) => !seen.has(c.key) && c.state !== 'done' && (!c.upstream || !info.has(c.upstream) || ['done', 'stopped'].includes(info.get(c.upstream).state) || !live.some((x) => x.key === c.upstream)));
  const orphanStart = derived.length;
  for (const r of roots) walk(r, 0);
  for (const c of live) if (!seen.has(c.key) && c.state !== 'done') walk(c, 0);
  // 参考顺序对照
  const refPrev = new Map(); ref.forEach((k, i) => refPrev.set(k, i ? ref[i - 1] : null));
  const ordered = [...ref.filter((k) => info.get(k)?.state === 'done').map((k) => info.get(k)), ...derived.map((d) => info.get(d.key))];
  for (const k of ref) if (!ordered.includes(info.get(k))) ordered.push(info.get(k));
  for (let i = ordered.length - 1; i >= 0; i--) if (ordered.indexOf(ordered[i]) !== i) ordered.splice(i, 1);
  const samples = await allTodaySamples();
  const per = median(samples);
  let t = Date.now();
  for (const c of ordered) {
    const d = derived.find((x) => x.key === c.key);
    c.derivedPos = d ? derived.indexOf(d) + 1 : null; c.branch = d ? d.depth : 0; c.orphan = d ? derived.indexOf(d) >= orphanStart : false;
    c.refPos = ref.includes(c.key) ? ref.indexOf(c.key) + 1 : null; c.refPrev = refPrev.has(c.key) ? refPrev.get(c.key) : undefined;
    c.unlisted = !ref.includes(c.key);
    c.mismatch = c.state !== 'done' && c.refPrev !== undefined && c.refPos > 1 && c.upstream !== c.refPrev;
    c.upstreamLabel = c.upstream ? (info.get(c.upstream)?.label || c.upstream) : null;
    c.refPrevLabel = c.refPrev ? (info.get(c.refPrev)?.label || c.refPrev) : null;
    c.remaining = c.state === 'done' ? 0 : Math.max(0, (c.total || 0) - (c.done || 0));
    if (c.state === 'done' || !per || c.state === 'missing' || c.state === 'stopped') { c.eta = null; continue; }
    t += c.remaining * per * 1000; c.eta = new Date(t).toISOString();
  }
  const next = derived.map((d) => info.get(d.key)).find((c) => c !== running && c.state !== 'done') || null;
  const nextArmed = !!(next && ((next.pid && next.state === 'waiting') || next.waiterArmed));
  const nextArmedBy = next ? (next.pid && next.state === 'waiting' ? 'process' : next.waiterArmed ? 'waiter' : null) : null;
  const glance = await gpuGlance({ info, procs, running, per, samples, superseded });
  return {
    ...glance,
    at: nowIso(), perShotSec: per, sampleCount: samples.length, running: running || null, next, nextArmed, nextArmedBy, queue: ordered.filter((c) => c.state !== 'done' && c !== running), chains: ordered, procs, idle: !procs.some((p) => !p.dry),
    derived: derived.map((d) => ({ ...d, label: info.get(d.key).label, state: info.get(d.key).state, upstream: info.get(d.key).upstream })), conflicts: conflicts.map((x) => ({ ...x, upstreamLabel: info.get(x.upstream)?.label, childLabels: x.children.map((k) => info.get(k)?.label) })),
    superseded, reference: ref.map((k) => ({ key: k, label: info.get(k)?.label || k, state: info.get(k)?.state })), referenceNote: aw ? `参考顺序以正在运行的等待器 ${aw.name}（PID ${aw.pid}）为准：已跑完/在跑的链按原口述顺序在前，之后是等待器的执行顺序；未审的新链列在最后` : '没有在运行的等待器；参考顺序来自总导口述（配置 issues-config.json 的 gpuOrder），只作对照',
    waiters: waiters.filter((w) => w.alive || w.logLines).map((w) => ({ name: w.name, file: w.file, pid: w.pid, alive: w.alive, state: w.state, log: w.log, firstLine: w.firstLine, lastLine: w.lastLine, aborted: w.aborted, finished: w.finished, stopPresent: w.stopPresent, steps: w.steps.map((x) => ({ kind: x.kind, key: x.key, label: info.get(x.key)?.label || x.key, after: x.after, status: x.status, at: x.at, pid: x.pidStarted })) })),
    note: '只读：链序由 M\\_\\gpu_*_chain.py 的默认 --after（在跑的看命令行）推出；状态来自 chain.log 和进程表；预计时间是估算',
  };
}

// ---------- 返修环节推算 ----------
let icCache = { at: 0, v: null, err: null };
async function icShots() {
  if (Date.now() - icCache.at < 120000 && (icCache.v || icCache.err)) return icCache;
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 20000);
    const r = await fetch(`${LIVE}/api/projects/${PROJECT}/shots`, { method: 'GET', signal: ac.signal }); clearTimeout(tm);
    const a = await r.json();
    const v = a.map((s) => { const vids = Array.isArray(s.videos) ? s.videos : []; const newest = vids.reduce((m, x) => Math.max(m, Number(x.created_at || x.createdAt || 0)), 0); return { id: s.id, ch: s.chapter, idx: s.idx, updated: Number(s.updated_at || 0), newestVideo: newest, promptChanged: String(s.video_prompt || '').trim() !== String(s.video_prompt_used || '').trim() }; });
    icCache = { at: Date.now(), v, err: null };
  } catch (e) { icCache = { at: Date.now(), v: null, err: String(e.message || e) }; }
  return icCache;
}
const STAGES = ['待改稿', '改稿中', '复审', '写库', '排队出片', '出片中', '审片', '待导出', '待 Andy 点头', '已完成'];
async function reviewDirs() { const n = await fsp.readdir(U).catch(() => []); const out = []; for (const d of n.filter((x) => /^审片_/.test(x))) { const st = await fsp.stat(path.join(U, d)).catch(() => null); const eps = [...d.matchAll(/(?:EP|ch)(\d+)/gi)].map((m) => Number(m[1])); const m2 = /EP(\d+)_(\d+)/i.exec(d); if (m2) eps.push(Number(m2[2])); out.push({ name: d, mtime: st ? st.mtimeMs : 0, eps }); } return out; }
async function deliveries() { const dir = path.join(P, '交付'); const n = await fsp.readdir(dir).catch(() => []); const out = []; for (const f of n) { const m = /第(\d+)集|EP0?(\d+)|ep0?(\d+)/i.exec(f) || /第([一二三四五六七八九十]+)集/.exec(f); if (!m) continue; const no = Number(m[1] || m[2] || m[3]) || cnNum(m[1] || ''); const st = await fsp.stat(path.join(dir, f)).catch(() => null); if (st && st.isFile()) out.push({ no, name: f, mtime: st.mtimeMs }); } return out; }
async function episodeStages(eps, gpu) {
  const ic = await icShots();
  const revs = await reviewDirs(); const dels = await deliveries();
  const out = {};
  for (const e of eps) {
    const ch = `第${e.no}章`;
    const ev = []; let stage = '未知', chain = null, shots = [], eta = null;
    const allDone = e.items.length && e.items.every((i) => i.status === 'done');
    const inChains = gpu.chains.filter((c) => (c.shots || []).some((s) => s.ch === ch) || (c.plan || []).some((p) => p.ch === ch));
    const active = inChains.find((c) => c.state === 'running' && c.shots.some((s) => s.ch === ch && !s.done));
    const queued = inChains.find((c) => (c.state === 'waiting' || c.state === 'ready') && c.shots.some((s) => s.ch === ch && !s.done));
    const lastDone = inChains.filter((c) => c.state === 'done').sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))[0];
    if (allDone) { stage = '已完成'; ev.push('Andy 的条目全部是「完成」'); }
    else if (active) { const cur = active.current && active.current.ch === ch; stage = cur ? '出片中' : '排队出片'; chain = active.label;  shots = active.shots.filter((s) => s.ch === ch).map((s) => `${s.num}${s.done ? '✓' : ''}`); eta = active.eta; ev.push(`「${active.label}」在跑${cur ? `，当前镜 ${ch}#${active.current.num}` : ''}`); }
    else if (queued) { stage = '排队出片'; chain = queued.label; shots = queued.shots.filter((s) => s.ch === ch).map((s) => String(s.num)); eta = queued.eta; ev.push(`「${queued.label}」${({ waiting: '已挂起等上游', ready: '脚本就绪未启动', stopped: '有日志但进程不在', running: '在跑' })[queued.state] || queued.state}，镜单含本章`); }
    else if (ic.v) {
      const mine = ic.v.filter((s) => s.ch === ch);
      const pending = mine.filter((s) => s.promptChanged && s.updated > s.newestVideo + 1000);
      if (pending.length) { stage = '写库'; shots = pending.map((s) => String(s.idx)); ev.push(`IC：${pending.length} 镜的 video_prompt 和上次出片用的不同、且 updated_at 晚于最新视频，不在任何已知链里（已写库、待排链）`); }
      else if (lastDone) {
        const doneMs = Date.parse(lastDone.doneAt);
        chain = lastDone.label; shots = lastDone.shots.filter((s) => s.ch === ch).map((s) => String(s.num));
        const rv = revs.find((r) => r.eps.includes(e.no) && r.mtime > doneMs);
        const dl = dels.find((d) => d.no === e.no && d.mtime > doneMs);
        if (dl) { stage = '待 Andy 点头'; ev.push(`交付目录 ${dl.name} 晚于出片，等 Andy 看`); }
        else if (rv) { stage = '待导出'; ev.push(`审片目录 ${rv.name} 晚于出片`); }
        else { stage = '审片'; ev.push(`「${lastDone.label}」已出完（${lastDone.doneAt}），还没看到更晚的审片记录`); }
      }
    } else if (ic.err) ev.push('IC 读取失败：' + ic.err);
    if (stage === '未知') ev.push('对不上：本集没有在已知链里、IC 里也没有待出片的改动，无法判断在哪个环节');
    out[e.no] = { stage, chain, shots, eta, evidence: ev };
  }
  return { byEpisode: out, icReadAt: ic.at ? new Date(ic.at).toISOString() : null, icError: ic.err };
}

// ---------- 自动建议（只进待确认队列） ----------
async function autoSuggest(by) {
  const doc = await readDoc(); const eps = parse(doc.lines); const gpu = await gpuQueue(); const st = await episodeStages(eps, gpu);
  const made = [];
  for (const e of eps) {
    const s = st.byEpisode[e.no];
    for (const it of e.items) {
      let want = null, reason = null;
      if (it.status === 'todo' && ['排队出片', '出片中', '写库'].includes(s.stage)) { want = 'doing'; reason = `本集推算环节是「${s.stage}」（${s.evidence.join('；')}），建议把「待修改」改为「修改中」`; }
      if (it.status === 'doing' && ['待 Andy 点头'].includes(s.stage)) { want = 'done'; reason = `本集已出片并已导出到交付目录（${s.evidence.join('；')}），请 Andy 看片后确认是否改为「完成」`; }
      if (!want) continue;
      const rec = await addSuggestion({ by, op: { op: 'status', start: it.start, orig: it.orig, status: want }, episode: e.no, itemText: it.text, from: STATUS_LABEL[it.status], to: STATUS_LABEL[want], reason, baseMd5: doc.md5, dedupKey: `${e.no}|${it.orig}|${want}` });
      if (rec) made.push(rec);
    }
  }
  return made;
}

// ---------- HTTP ----------
let readyP = null; const ready = () => (readyP ||= loadCfg().then(() => linksInit(path.join(TEST_DIR, '问题镜头关联.json'))));
async function readBody(req) { let n = 0; const c = []; for await (const x of req) { n += x.length; if (n > 64 * 1024) throw new Error('请求体过大'); c.push(x); } const s = Buffer.concat(c).toString('utf8'); return s ? JSON.parse(s) : {}; }
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
const isHuman = (op) => cfg.humans.includes(op);
// ---------- 给总览用的只读汇总 ----------
// 问题描述：总览读桌面正式文件（只读，绝不写）；可编辑页仍只写测试副本
// 总览用：问题描述.txt（正式文件，只读）逐条 {集, 正文, 状态}
export async function issueItems() {
  await ready();
  const doc = await readDoc(cfg.realFile);
  return { md5: doc.md5, eps: parse(doc.lines).map((e) => ({ no: e.no, items: e.items.map((i) => ({ text: i.text, status: i.status })) })) };
}
export async function issuesForOverview() {
  await ready();
  const file = cfg.realFile;
  const doc = await readDoc(file);
  const eps = parse(doc.lines);
  // 设计稿口径：「第N集」标题下的非空行 = 原文行；含「完成」且不含「未完成」= 标记完成
  let raw = 0, rawDone = 0, inEp = false, heads = 0;
  for (const l of doc.lines) {
    const t = l.trim();
    if (/^第[一二三四五六七八九十百零两\d]+集/.test(t) && !TAG_RE.test(l)) { inEp = true; heads++; continue; }
    if (!inEp || !t || /^-+新-+$/.test(t)) continue;
    raw++; if (/完成/.test(t) && !/未完成/.test(t)) rawDone++;
  }
  const gpu = await gpuQueue();
  const st = await episodeStages(eps, gpu);
  const linked = await linkEpisodes(eps, { gpu, ic: await icShots(), deliveryDir: path.join(P, '交付'), onlyOpen: true }).catch((e) => ({ error: String(e.message || e) }));
  let fixing = null;
  if (Array.isArray(linked)) {
    const open = linked.flatMap((e) => e.items.filter((i) => i.status !== 'done').map((i) => ({ ep: e.no, text: i.text, status: i.status, links: i.links })));
    const by = {}; let lk = 0, fx = 0, man = 0; const unl = [];
    for (const o of open) { if (o.links?.shots?.length) { lk++; if (o.links.src === 'manual') man++; } else unl.push({ ep: o.ep, text: o.text.slice(0, 40), why: o.links?.why }); if (o.links?.fixing) fx++; const steps = [...new Set((o.links?.shots || []).map((x) => x.step))]; const k = !o.links?.shots?.length ? '未关联' : steps.find((x) => x !== '没在修') || '没在修'; by[k] = (by[k] || 0) + 1; }
    fixing = { value: fx, open: open.length, linked: lk, manual: man, unlinked: unl.length, unlinkedList: unl.slice(0, 20), byStep: by, estimate: true, method: '问题行的时间点 → 本集当前选用镜头按顺序拼成的时间轴（ffprobe 实测时长）→ 落在哪一镜；人工关联优先。镜头在未跑完的链里、已写库待排链、或导出后有新片，都算「正在修」', drift: linked.filter((e) => e.timeline && e.timeline.drift != null && Math.abs(e.timeline.drift) > 3).map((e) => ({ ep: e.no, drift: e.timeline.drift, epDur: e.timeline.epDur, total: e.timeline.total })) };
  }
  return { fixing, linked: Array.isArray(linked) ? linked.map((e) => ({ no: e.no, timeline: e.timeline, items: e.items.filter((i) => i.status !== 'done').map((i) => ({ text: i.text, status: i.status, links: i.links })) })) : null, linkError: Array.isArray(linked) ? null : linked.error, file, md5: doc.md5, mtime: (await fsp.stat(file)).mtime.toISOString(), heads, raw, rawDone, eps: eps.map((e) => ({ no: e.no, items: e.items.length, done: e.items.filter((i) => i.status === 'done').length, doing: e.items.filter((i) => i.status === 'doing').length, todo: e.items.filter((i) => i.status === 'todo').length, stage: st.byEpisode[e.no] })), icReadAt: st.icReadAt, icError: st.icError, gpu };
}
// 写库领先量：IC 里 video_prompt 已改、晚于最新视频、且不在任何未跑完链的镜单里
export async function writeLead(gpu) {
  const ic = await icShots(); if (!ic.v) return { error: ic.err || 'IC 读不到' };
  const pendingIds = []; for (const c of gpu.chains) if (c.state !== 'done') for (const s of c.shots || []) if (s.id) pendingIds.push(s.id);
  const inChain = (id) => pendingIds.some((p) => id.startsWith(p) || p.startsWith(id));
  const lead = ic.v.filter((s) => s.promptChanged && s.updated > s.newestVideo + 1000 && !inChain(s.id));
  const queued = ic.v.filter((s) => inChain(s.id)).length;
  const by = {}; for (const s of lead) by[s.ch] = (by[s.ch] || 0) + 1;
  return { count: lead.length, byChapter: by, queuedInChains: queued, at: new Date(ic.at).toISOString() };
}
export function issuesCfg() { return cfg; }

export async function handleIssues(req, res, url) {
  await ready();
  const parts = url.pathname.replace(/^\/api\/issues\/?/, '').split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && parts.length === 0) {
      const doc = await readDoc(); const eps = parse(doc.lines); const gpu = await gpuQueue(); const st = await episodeStages(eps, gpu);
      const sugs = (await loadSugs()).filter((s) => s.state === 'pending');
      const linked = await linkEpisodes(eps, { gpu, ic: await icShots(), deliveryDir: path.join(P, '交付'), onlyOpen: true }).catch(() => null);
      const lmap = new Map(); for (const e of linked || []) for (const it of e.items) if (it.links) lmap.set(`${e.no}|${it.start}`, it.links);
      const tmap = new Map(); for (const e of linked || []) tmap.set(e.no, e.timeline);
      return send(res, 200, { config: { target: cfg.target, realFile: cfg.realFile, allowRealFile: cfg.allowRealFile, isTestCopy: path.resolve(cfg.target).toLowerCase() !== path.resolve(cfg.realFile).toLowerCase(), backupDir: cfg.backupDir, logFile: cfg.logFile, humans: cfg.humans, ais: cfg.ais }, file: { md5: doc.md5, bom: doc.bom, eol: doc.eol === '\r\n' ? 'CRLF' : 'LF', lines: doc.lines.length }, stages: STAGES, episodes: eps.map((e) => ({ no: e.no, note: e.note, items: e.items.map(({ start, end, text, tag, status, orig, key }) => ({ start, end, text, tag, status, orig, key, links: lmap.get(`${e.no}|${start}`) || null })), stage: st.byEpisode[e.no], timeline: tmap.get(e.no) || null })), icReadAt: st.icReadAt, icError: st.icError, gpu, suggestions: sugs, authNote: '预览里的「操作人」只是演示切换，不是真正的身份认证' });
    }
    if (req.method === 'GET' && parts[0] === 'gpu') return send(res, 200, await gpuQueue());
    if (req.method === 'GET' && parts[0] === 'log') {
      const raw = await fsp.readFile(cfg.logFile, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter(Boolean); return send(res, 200, { file: cfg.logFile, total: lines.length, entries: lines.slice(-50).reverse().map((l) => JSON.parse(l)) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: '不支持' });
    const b = await readBody(req);
    const operator = String(b.operator || req.headers['x-operator'] || '');
    if (!cfg.humans.includes(operator) && !cfg.ais.includes(operator)) return send(res, 400, { error: '操作人无效' });
    if (parts[0] === 'op') {
      if (!isHuman(operator)) { // AI 只能提建议
        const rec = await addSuggestion({ by: operator, op: b.op, episode: b.episode, itemText: b.itemText || b.op?.text, from: b.from, to: b.op?.status ? STATUS_LABEL[b.op.status] : null, reason: b.reason || 'AI 提交的建议', baseMd5: b.baseMd5 });
        return send(res, 202, { suggested: true, suggestion: rec, note: 'AI 不能直接改，已进待确认队列，等 Andy 或总导确认' });
      }
      const r = await commit(b.op, operator, b.baseMd5, 'direct', String(b.reason || '').slice(0, 300) || null); return send(res, 200, r);
    }
    if (parts[0] === 'suggestions' && parts[1] && (parts[2] === 'confirm' || parts[2] === 'reject')) {
      if (!isHuman(operator)) return send(res, 403, { error: '只有 Andy 或总导能确认/驳回建议' });
      const a = await loadSugs(); const s = a.find((x) => x.id === parts[1] && x.state === 'pending');
      if (!s) return send(res, 404, { error: '没有这条待确认建议' });
      if (parts[2] === 'reject') { s.state = 'rejected'; s.decidedBy = operator; s.decidedAt = nowIso(); await saveSugs(a); await appendLog({ operator, result: 'suggestion_rejected', suggestion: s.id }); return send(res, 200, s); }
      const r = await commit(s.op, operator, b.baseMd5 || null, `confirm ${s.id} (by ${s.by})`, s.reason || null);
      s.state = 'applied'; s.decidedBy = operator; s.decidedAt = nowIso(); s.result = { afterMd5: r.afterMd5, backup: r.backup }; await saveSugs(a);
      return send(res, 200, { ...r, suggestion: s });
    }
    if (parts[0] === 'links') { // 问题行↔镜头的人工关联：只写预览目录里的 问题镜头关联.json
      const r = await setManual(Number(b.episode), String(b.text || ''), b.shots, operator, b.note);
      await appendLog({ operator, result: 'link_set', episode: b.episode, itemText: String(b.text || '').slice(0, 200), shots: r.value ? r.value.shots : [] });
      return send(res, 200, r);
    }
    if (parts[0] === 'suggest-auto') { const made = await autoSuggest(operator.startsWith('AI') ? operator : '指挥系统（自动）'); return send(res, 200, { made: made.length, suggestions: made }); }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message || e), currentMd5: e.currentMd5 }); }
}
