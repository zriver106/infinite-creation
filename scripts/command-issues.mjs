// 指挥系统 · 问题描述（可编辑）+ 返修进度推算 + GPU 状态栏（预览版）
// 写：只写配置里的目标文件（测试阶段是测试副本）、备份目录、修改记录、建议队列；桌面真文件在 Andy 点头前拒写。
// 读：chain.log / progress.json / 链脚本 / 进程表（只读）；IC 只发 GET；不连 8188/8189；不碰 4610 进程。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const M = 'C:\\Users\\usazr\\Documents\\moviePro';
const P = path.join(M, 'projects', '我在城市用交易系统修仙');
const G = path.join(M, '运行记录', 'gpu生产');
const U = path.join(M, '_');
const REAL_FILE = 'C:\\Users\\usazr\\Desktop\\问题描述.txt';
const TEST_DIR = path.join(M, 'Claude工作区', '指挥预览测试');
const CONFIG_FILE = path.join(TEST_DIR, 'issues-config.json');
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
  gpuOrder: ['style6_a1', 'rr1230d', 'rr1310', 'rr1500', 'ch19_21', 'rr1200e', 'rr1540', '第22–24章新链（待建）'],
};
let cfg = { ...DEFAULT_CFG };
async function loadCfg() {
  await fsp.mkdir(TEST_DIR, { recursive: true });
  try { cfg = { ...DEFAULT_CFG, ...JSON.parse((await fsp.readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')) }; }
  catch { await fsp.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CFG, null, 2)); cfg = { ...DEFAULT_CFG }; }
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
async function readDoc() {
  const buf = await fsp.readFile(cfg.target);
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
    const h = /^第([一二三四五六七八九十百零两\d]+)集(.*)$/.exec(t);
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
async function commit(op, operator, baseMd5, via) {
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
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
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
    await appendLog({ operator, op, via, result: 'written', target: cfg.target, beforeMd5: doc.md5, afterMd5: after, backup: bak, diff });
    return { ok: true, beforeMd5: doc.md5, afterMd5: after, backup: bak, diff };
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
let procCache = { at: 0, v: [] };
function chainProcs() {
  if (Date.now() - procCache.at < 5000) return Promise.resolve(procCache.v);
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true, maxBuffer: 8 << 20 }, (e, out) => {
    let a = []; try { a = JSON.parse(out || '[]'); } catch {} if (!Array.isArray(a)) a = [a];
    const v = a.filter((p) => p && /gpu_[\w\-]+_chain\.py/i.test(p.CommandLine || '')).map((p) => ({ pid: p.ProcessId, key: (p.CommandLine.match(/gpu_([\w\-]+)_chain\.py/i) || [])[1], after: ((p.CommandLine.match(/--after=(\S+)/) || [])[1]) || '(默认)', dry: /--dry-run/.test(p.CommandLine) }));
    procCache = { at: Date.now(), v }; res(v);
  }));
}
const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
async function readLines(f) { try { return (await fsp.readFile(f, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/); } catch { return null; } }
async function chainInfo(key, procs) {
  const script = path.join(U, `gpu_${key}_chain.py`);
  const info = { key, script: fs.existsSync(script) ? script : null, plan: [], ids: {}, state: 'missing', done: 0, total: 0, current: null, after: null, pid: null, lastLine: null, startedAt: null, doneAt: null, shots: [] };
  if (!info.script) return info;
  const src = await readLines(script) || [];
  const planLine = src.find((l) => /^PLAN\s*=/.test(l));
  if (planLine) for (const m of planLine.matchAll(/\('(第\d+章)',\s*\[([\d,\s]*)\]/g)) info.plan.push({ ch: m[1], nums: m[2].split(',').map((x) => Number(x.trim())).filter((x) => x > 0) });
  for (const l of src) for (const m of l.matchAll(/\('(第\d+章)',\s*(\d+)\):\s*'([0-9a-f]{6,})'/g)) info.ids[`${m[1]}#${m[2]}`] = m[3];
  info.total = info.plan.reduce((a, p) => a + p.nums.length, 0);
  const dir = path.join(G, `${key}_chain_${ymd()}`);
  const log = (await readLines(path.join(dir, 'chain.log'))) || [];
  const p = procs.find((x) => x.key === key && !x.dry);
  if (p) { info.pid = p.pid; info.after = p.after; }
  const sub = new Map(), done = new Map();
  const planShots = [];
  for (const l of log) {
    if (!l) continue;
    if (!info.startedAt && /chain start/.test(l)) info.startedAt = l.slice(0, 19);
    let m;
    if ((m = /^(\S+) PLAN (第\d+章) #(\d+) ([0-9a-f-]{36})/.exec(l))) { if (!planShots.some((s) => s.id === m[4])) planShots.push({ ch: m[2], num: Number(m[3]), id: m[4] }); }
    else if ((m = /^(\S+) submitted (第\d+章) (\d+) ([0-9a-f-]{36}) ([0-9a-f-]{36})/.exec(l))) sub.set(m[4], { at: m[1], ch: m[2], num: Number(m[3]), job: m[5] });
    else if ((m = /^(\S+) submitted idx (\d+) .*? ([0-9a-f-]{36}) job ([0-9a-f-]{36})/.exec(l))) sub.set(m[3], { at: m[1], ch: '', num: Number(m[2]), job: m[4] });
    else if ((m = /^(\S+) done (第\d+章) (\d+) ([0-9a-f-]{36}) ([\d.]+) ([\d.]+)/.exec(l))) done.set(m[4], { at: m[1], ch: m[2], num: Number(m[3]), elapsed: Number(m[6]) });
    else if ((m = /^(\S+) done idx (\d+) .*? vid ([0-9a-f-]{36}).*?elapsed ([\d.]+)/.exec(l))) { const id = [...sub.entries()].find(([, v]) => v.num === Number(m[2]) && !v.ch); if (id) done.set(id[0], { at: m[1], ch: '', num: Number(m[2]), elapsed: Number(m[4]) }); }
    if (/^\S+\s+[A-Za-z0-9_]+ done(\s|$)/.test(l)) info.doneAt = l.slice(0, 19);
  }
  info.lastLine = log.filter(Boolean).slice(-1)[0] || null;
  if (planShots.length) { info.shots = planShots; info.total = planShots.length; }
  else info.shots = info.plan.flatMap((pl) => pl.nums.map((n) => ({ ch: pl.ch, num: n, id: info.ids[`${pl.ch}#${n}`] || null })));
  info.shots = info.shots.map((s) => { const full = s.id && [...sub.keys(), ...done.keys()].find((k) => k.startsWith(s.id)); const id = full || s.id; return { ...s, id, submitted: id && sub.get(id)?.at || null, job: id && sub.get(id)?.job || null, done: id && done.get(id)?.at || null }; });
  info.done = done.size; if (!info.total) info.total = Math.max(sub.size, done.size);
  const curId = [...sub.keys()].filter((k) => !done.has(k)).pop();
  if (curId) info.current = { id: curId, ...sub.get(curId) };
  info.samples = [...done.values()].map((d) => d.elapsed).filter((x) => x > 0);
  if (info.doneAt) info.state = 'done';
  else if (info.pid) info.state = info.current ? 'running' : (/waiting/.test(info.lastLine || '') || !log.length ? 'waiting' : 'running');
  else info.state = log.length ? 'stopped' : 'ready';
  return info;
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
async function allTodaySamples() {
  const dirs = (await fsp.readdir(G).catch(() => [])).filter((n) => n.includes(ymd()));
  const out = [];
  for (const d of dirs) { const L = await readLines(path.join(G, d, 'chain.log')); if (!L) continue; for (const l of L) { let m; if ((m = /^(\S+) done 第\d+章 \d+ [0-9a-f-]{36} [\d.]+ ([\d.]+)/.exec(l))) out.push({ at: m[1], s: Number(m[2]) }); else if ((m = /^(\S+) done idx \d+ .*?elapsed ([\d.]+)/.exec(l))) out.push({ at: m[1], s: Number(m[2]) }); } }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(-40).map((x) => x.s);
}
export async function gpuQueue() {
  await ready();
  const procs = await chainProcs();
  const keys = [...cfg.gpuOrder];
  for (const p of procs) if (p.key && !keys.includes(p.key)) keys.push(p.key);
  // 今天新建/改过、但不在参考顺序里的链脚本：也列出来（标「不在参考顺序」），放在「待建」占位之前
  const unlisted = [];
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const f of await fsp.readdir(U)) {
      const m = /^gpu_(.+)_chain\.py$/.exec(f); if (!m || keys.includes(m[1])) continue;
      const st = await fsp.stat(path.join(U, f)).catch(() => null);
      if (st && st.mtimeMs >= today.getTime()) unlisted.push({ key: m[1], mtime: st.mtimeMs });
    }
  } catch {}
  unlisted.sort((a, b) => a.mtime - b.mtime);
  const ph = keys.findIndex((k) => /待建/.test(k));
  keys.splice(ph === -1 ? keys.length : ph, 0, ...unlisted.map((u) => u.key));
  const chains = [];
  for (const k of keys) {
    if (/待建/.test(k)) { chains.push({ key: k, state: 'missing', placeholder: true, total: 0, done: 0, shots: [], plan: [] }); continue; }
    { const ci = await chainInfo(k, procs); if (unlisted.some((u) => u.key === k)) { if (ci.state === 'done' || ci.state === 'stopped') continue; ci.unlisted = true; } chains.push(ci); }
  }
  const samples = await allTodaySamples();
  const per = median(samples);
  let t = Date.now();
  for (const c of chains) {
    const remaining = c.state === 'done' ? 0 : Math.max(0, (c.total || 0) - (c.done || 0));
    c.remaining = remaining;
    if (c.state === 'done') { c.eta = null; continue; }
    if (!per || c.state === 'missing' || c.state === 'stopped') { c.eta = null; continue; }
    t += remaining * per * 1000; c.eta = new Date(t).toISOString();
  }
  const running = chains.find((c) => c.state === 'running');
  const after = chains.filter((c) => c.state !== 'done' && c !== running);
  return { at: nowIso(), perShotSec: per, sampleCount: samples.length, running: running || null, next: after[0] || null, queue: after, chains, procs, idle: !procs.some((p) => !p.dry), note: '只读：数据来自 chain.log、progress、链脚本和进程表；顺序参考配置，状态以进程和日志为准；预计时间是估算' };
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
    else if (active) { const cur = active.current && active.current.ch === ch; stage = cur ? '出片中' : '排队出片'; chain = active.key; shots = active.shots.filter((s) => s.ch === ch).map((s) => `${s.num}${s.done ? '✓' : ''}`); eta = active.eta; ev.push(`链 ${active.key} 在跑${cur ? `，当前镜 ${ch}#${active.current.num}` : ''}`); }
    else if (queued) { stage = '排队出片'; chain = queued.key; shots = queued.shots.filter((s) => s.ch === ch).map((s) => String(s.num)); eta = queued.eta; ev.push(`链 ${queued.key} 状态 ${queued.state}，镜单含本章`); }
    else if (ic.v) {
      const mine = ic.v.filter((s) => s.ch === ch);
      const pending = mine.filter((s) => s.promptChanged && s.updated > s.newestVideo + 1000);
      if (pending.length) { stage = '写库'; shots = pending.map((s) => String(s.idx)); ev.push(`IC：${pending.length} 镜的 video_prompt 和上次出片用的不同、且 updated_at 晚于最新视频，不在任何已知链里（已写库、待排链）`); }
      else if (lastDone) {
        const doneMs = Date.parse(lastDone.doneAt);
        chain = lastDone.key; shots = lastDone.shots.filter((s) => s.ch === ch).map((s) => String(s.num));
        const rv = revs.find((r) => r.eps.includes(e.no) && r.mtime > doneMs);
        const dl = dels.find((d) => d.no === e.no && d.mtime > doneMs);
        if (dl) { stage = '待 Andy 点头'; ev.push(`交付目录 ${dl.name} 晚于出片，等 Andy 看`); }
        else if (rv) { stage = '待导出'; ev.push(`审片目录 ${rv.name} 晚于出片`); }
        else { stage = '审片'; ev.push(`链 ${lastDone.key} 已出完（${lastDone.doneAt}），还没看到更晚的审片记录`); }
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
let readyP = null; const ready = () => (readyP ||= loadCfg());
async function readBody(req) { let n = 0; const c = []; for await (const x of req) { n += x.length; if (n > 64 * 1024) throw new Error('请求体过大'); c.push(x); } const s = Buffer.concat(c).toString('utf8'); return s ? JSON.parse(s) : {}; }
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
const isHuman = (op) => cfg.humans.includes(op);
export async function handleIssues(req, res, url) {
  await ready();
  const parts = url.pathname.replace(/^\/api\/issues\/?/, '').split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && parts.length === 0) {
      const doc = await readDoc(); const eps = parse(doc.lines); const gpu = await gpuQueue(); const st = await episodeStages(eps, gpu);
      const sugs = (await loadSugs()).filter((s) => s.state === 'pending');
      return send(res, 200, { config: { target: cfg.target, realFile: cfg.realFile, allowRealFile: cfg.allowRealFile, isTestCopy: path.resolve(cfg.target).toLowerCase() !== path.resolve(cfg.realFile).toLowerCase(), backupDir: cfg.backupDir, logFile: cfg.logFile, humans: cfg.humans, ais: cfg.ais }, file: { md5: doc.md5, bom: doc.bom, eol: doc.eol === '\r\n' ? 'CRLF' : 'LF', lines: doc.lines.length }, stages: STAGES, episodes: eps.map((e) => ({ no: e.no, note: e.note, items: e.items.map(({ start, end, text, tag, status, orig, key }) => ({ start, end, text, tag, status, orig, key })), stage: st.byEpisode[e.no] })), icReadAt: st.icReadAt, icError: st.icError, gpu, suggestions: sugs, authNote: '预览里的「操作人」只是演示切换，不是真正的身份认证' });
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
      const r = await commit(b.op, operator, b.baseMd5, 'direct'); return send(res, 200, r);
    }
    if (parts[0] === 'suggestions' && parts[1] && (parts[2] === 'confirm' || parts[2] === 'reject')) {
      if (!isHuman(operator)) return send(res, 403, { error: '只有 Andy 或总导能确认/驳回建议' });
      const a = await loadSugs(); const s = a.find((x) => x.id === parts[1] && x.state === 'pending');
      if (!s) return send(res, 404, { error: '没有这条待确认建议' });
      if (parts[2] === 'reject') { s.state = 'rejected'; s.decidedBy = operator; s.decidedAt = nowIso(); await saveSugs(a); await appendLog({ operator, result: 'suggestion_rejected', suggestion: s.id }); return send(res, 200, s); }
      const r = await commit(s.op, operator, b.baseMd5 || null, `confirm ${s.id} (by ${s.by})`);
      s.state = 'applied'; s.decidedBy = operator; s.decidedAt = nowIso(); s.result = { afterMd5: r.afterMd5, backup: r.backup }; await saveSugs(a);
      return send(res, 200, { ...r, suggestion: s });
    }
    if (parts[0] === 'suggest-auto') { const made = await autoSuggest(operator.startsWith('AI') ? operator : '指挥系统（自动）'); return send(res, 200, { made: made.length, suggestions: made }); }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message || e), currentMd5: e.currentMd5 }); }
}
