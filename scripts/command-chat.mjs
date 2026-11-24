// 指挥系统 · 聊天（预览版）
// 一个固定主会话 + 由主会话按需开启的辅助会话；辅助会话有数量上限和空闲自动停。
// 后端接真实 claude CLI（--model opus，--restricted 只读工具 Read/Grep/Glob，工作目录限定在沙箱）。
// 只写本模块自己的沙箱目录（CHAT_ROOT），不写库、不提交 GPU、不连 8188/8189、不碰 4610 进程。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

const CHAT_ROOT = process.env.CMD_CHAT_ROOT || 'C:\\Users\\usazr\\Documents\\moviePro\\Claude工作区\\指挥聊天测试';
const CONFIG_FILE = path.join(CHAT_ROOT, 'chat-config.json');
const SESS_DIR = path.join(CHAT_ROOT, 'sessions');
const WORK_DIR = path.join(CHAT_ROOT, 'work');
const CODEX_PAUSED = 'Codex 在聊天里暂停：缺读取限制';
const DEFAULT_CONFIG = {
  maxAux: 3, // 同时开着的辅助会话上限（方案增补 §8.1 建议 3，待 Andy 定）
  idleMinutes: 20, // 辅助会话空闲多久自动停（§8.1 建议 20 分钟）
  model: 'opus',
  claudeExe: 'C:\\Users\\usazr\\.local\\bin\\claude.exe',
  codexExe: 'C:\\Users\\usazr\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
  codexEnabled: false, // Andy 16:3x 裁定：聊天里的 Codex 暂停（缺读取限制）；只有测试实例用环境变量 CMD_CHAT_CODEX=1 临时打开，配置文件里的值不认
  tools: ['Read', 'Grep', 'Glob'],
  readDirs: ['C:\\Users\\usazr\\Documents\\moviePro\\Claude工作区\\指挥'],
  turnTimeoutSec: 600,
  pageSize: 30, // 首屏和每页上翻条数（§8.2）
  firstScreenBytes: 65536, // 首屏最多 64KB，与 30 条取小者
  longMsgBytes: 4096, // 超过 4KB 的长消息
  previewChars: 1024, // 只先给前 1KB，点「展开」再懒加载全文
  indexEvictMinutes: 5, // 服务端：多久没人看的会话卸载内存索引
};
let cfg = { ...DEFAULT_CONFIG };
const sessions = new Map(); // id -> meta
const procs = new Map(); // id -> child
const indexCache = new Map(); // id -> { offsets: [[off,len]], size, at }
const pending = []; // 超上限排队的开辅助请求

function now() { return new Date().toISOString(); }
async function loadConfig() {
  await fsp.mkdir(SESS_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  try { cfg = { ...DEFAULT_CONFIG, ...JSON.parse((await fsp.readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')) }; }
  catch { await fsp.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2)); cfg = { ...DEFAULT_CONFIG }; }
  if (process.env.CMD_CHAT_IDLE_SEC) cfg.idleMinutes = Number(process.env.CMD_CHAT_IDLE_SEC) / 60; // 仅测试用
  if (process.env.CMD_CHAT_MAX_AUX) cfg.maxAux = Number(process.env.CMD_CHAT_MAX_AUX);
  cfg.codexEnabled = process.env.CMD_CHAT_CODEX === '1';
}
const metaFile = (id) => path.join(SESS_DIR, id, 'meta.json');
const msgFile = (id) => path.join(SESS_DIR, id, 'messages.jsonl');
async function saveMeta(m) { await fsp.writeFile(metaFile(m.id), JSON.stringify(m, null, 2)); }

async function loadSessions() {
  const ents = await fsp.readdir(SESS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    try {
      const m = JSON.parse(await fsp.readFile(metaFile(e.name), 'utf8'));
      if (m.status === 'busy') m.status = m.role === 'main' ? 'idle' : 'stopped'; // 服务重启后不留僵尸
      sessions.set(m.id, m);
    } catch {}
  }
  if (![...sessions.values()].some((m) => m.role === 'main')) await createSession({ role: 'main', provider: 'claude', title: '主会话（统一接收 Andy 指令）' });
  const mainM = sessions.get('main');
  await fsp.writeFile(path.join(CHAT_ROOT, 'sessions.json'), JSON.stringify({ main: { id: 'main', provider: mainM.provider, cliSessionId: mainM.cliSessionId }, note: '主会话固定，用 claude -p --resume <cliSessionId> 续接；预览版存放在本沙箱，正式版按方案放 M\\Claude工作区\\指挥\\聊天\\sessions.json' }, null, 2));
}

async function createSession({ role, provider, title, parent }) {
  const id = role === 'main' ? 'main' : 'aux-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const m = { id, role, provider, title: title || id, parent: parent || null, status: 'idle', created: now(), lastActivity: now(), cliSessionId: null, msgCount: 0, lastSnippet: '', turns: 0, costUsd: 0 };
  await fsp.mkdir(path.join(SESS_DIR, id), { recursive: true });
  await fsp.mkdir(path.join(WORK_DIR, id), { recursive: true });
  await fsp.writeFile(msgFile(id), '', { flag: 'a' });
  sessions.set(id, m); await saveMeta(m);
  return m;
}
const activeAux = () => [...sessions.values()].filter((m) => m.role === 'aux' && m.status !== 'stopped');

async function appendMsg(id, msg) {
  const m = sessions.get(id);
  const rec = { seq: m.msgCount, ts: now(), ...msg };
  const line = JSON.stringify(rec) + '\n';
  const buf = Buffer.from(line, 'utf8');
  const st = await fsp.stat(msgFile(id)).catch(() => ({ size: 0 }));
  await fsp.appendFile(msgFile(id), buf);
  const ix = indexCache.get(id);
  if (ix && ix.size === st.size) { ix.offsets.push([st.size, buf.length]); ix.size += buf.length; }
  else indexCache.delete(id);
  m.msgCount++; m.lastActivity = rec.ts; m.lastSnippet = String(msg.text || '').slice(0, 120);
  await saveMeta(m);
  return rec;
}
async function getIndex(id) {
  let ix = indexCache.get(id);
  const st = await fsp.stat(msgFile(id));
  if (ix && ix.size === st.size) { ix.at = Date.now(); return ix; }
  const offsets = []; let off = 0;
  const buf = await fsp.readFile(msgFile(id));
  let start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { offsets.push([start, i + 1 - start]); start = i + 1; }
  off = buf.length;
  ix = { offsets, size: off, at: Date.now() };
  indexCache.set(id, ix);
  return ix;
}
async function readRange(id, from, to) {
  const ix = await getIndex(id);
  const fh = await fsp.open(msgFile(id), 'r');
  const out = [];
  try {
    for (let i = from; i < to; i++) {
      const [o, l] = ix.offsets[i]; const b = Buffer.alloc(l);
      await fh.read(b, 0, l, o); out.push(JSON.parse(b.toString('utf8')));
    }
  } finally { await fh.close(); }
  return out;
}
function summary(m) {
  return { id: m.id, role: m.role, provider: m.provider, title: m.title, parent: m.parent, status: m.status, created: m.created, lastActivity: m.lastActivity, msgCount: m.msgCount, lastSnippet: m.lastSnippet, turns: m.turns, costUsd: Number((m.costUsd || 0).toFixed(4)), stoppedReason: m.stoppedReason || null };
}

// ---------- claude CLI ----------
const SYS_MAIN = '你是 IC 指挥系统的主会话，统一接收 Andy 的指令。你只有只读工具（Read/Grep/Glob），工作目录是沙箱。不写库、不提交 GPU、不改脚本、不读任何凭据或密钥文件、不打印密钥。需要另开辅助会话分担一件独立的小活时，在回复里单独一行写：[[开辅助:标题:给它的指令]]（系统会按上限决定是否开启，用完会自动停）。回答用中文，简洁。';
const SYS_AUX = '你是 IC 指挥系统的辅助会话，由主会话按需开启，只做交给你的那一件事。你只有只读工具（Read/Grep/Glob），工作目录是沙箱。不写库、不提交 GPU、不改脚本、不读任何凭据或密钥文件、不打印密钥。回答用中文，简洁。';
function runClaude(m, text) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', cfg.model, '--restricted', '--strict-mcp-config', '--tools', cfg.tools.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--output-format', 'json', '--append-system-prompt', m.role === 'main' ? SYS_MAIN : SYS_AUX];
    for (const d of cfg.readDirs || []) args.push('--add-dir', d);
    if (m.cliSessionId) args.push('--resume', m.cliSessionId); else { m.cliSessionId = crypto.randomUUID(); args.push('--session-id', m.cliSessionId); }
    const t0 = Date.now();
    const child = spawn(cfg.claudeExe, args, { cwd: path.join(WORK_DIR, m.id), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.set(m.id, child);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, cfg.turnTimeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer); procs.delete(m.id);
      let j = null; try { j = JSON.parse(out); } catch {}
      resolve({ code, ms: Date.now() - t0, result: j?.result ?? null, isError: j ? !!j.is_error : true, cost: j?.total_cost_usd || 0, err: (j ? '' : (out + err)).slice(0, 800) });
    });
    child.stdin.end(text);
  });
}
function runCodex(m, text) {
  return new Promise((resolve) => {
    const wd = path.join(WORK_DIR, m.id);
    const sys = (m.role === 'main' ? SYS_MAIN : SYS_AUX) + '\n\n';
    const args = m.cliSessionId
      ? ['exec', 'resume', m.cliSessionId, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-']
      : ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', wd, '-'];
    const t0 = Date.now();
    const child = spawn(cfg.codexExe, args, { cwd: wd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.set(m.id, child);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, cfg.turnTimeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer); procs.delete(m.id);
      let result = null, tid = null, failed = null;
      for (const l of out.split(/\r?\n/)) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (e.type === 'thread.started') tid = e.thread_id;
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') result = e.item.text;
        if (e.type === 'turn.failed' || e.type === 'error') failed = JSON.stringify(e).slice(0, 400);
      }
      if (tid && !m.cliSessionId) m.cliSessionId = tid;
      resolve({ code, ms: Date.now() - t0, result, isError: result == null, cost: 0, err: failed || err.slice(-600) });
    });
    child.stdin.end((m.cliSessionId ? '' : sys) + text);
  });
}
const REDACT_OUT = [[/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-***已隐去***'], [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '***JWT已隐去***'], [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1***已隐去***']];
const redact = (s) => REDACT_OUT.reduce((t, [re, r]) => t.replace(re, r), String(s ?? ''));

async function sendMessage(id, text, from = 'Andy') {
  const mm0 = sessions.get(id);
  if (mm0 && mm0.role === 'aux' && from === 'Andy' && mm0.status !== 'stopped' && mm0.status !== 'busy' && sessions.has('main')) await appendMsg('main', { role: 'system', text: `【抄送】Andy 直接发给辅助会话 ${id}「${mm0.title}」：${String(text).slice(0, 500)}` });
  const m = sessions.get(id);
  if (!m) return { code: 404, body: { error: '会话不存在' } };
  if (m.status === 'stopped') return { code: 410, body: { error: '会话已停止' } };
  if (m.status === 'busy') return { code: 409, body: { error: '会话正在回复，等它答完再发' } };
  if (m.provider === 'codex' && !cfg.codexEnabled) return { code: 501, body: { error: CODEX_PAUSED } };
  if (m.provider !== 'claude' && m.provider !== 'codex') return { code: 501, body: { error: `${m.provider} 未启用` } };
  if (!text || !String(text).trim()) return { code: 400, body: { error: '空消息' } };
  const rec = await appendMsg(id, { role: 'user', from, text: String(text).slice(0, 20000) });
  m.status = 'busy'; await saveMeta(m);
  (async () => {
    const r = m.provider === 'codex' ? await runCodex(m, String(text)) : await runClaude(m, String(text));
    const cur = sessions.get(id);
    if (!cur) return;
    if (cur.status === 'stopped') { await appendMsg(id, { role: 'system', text: '会话已停止，本轮回复丢弃' }); return; }
    cur.turns++; cur.costUsd = (cur.costUsd || 0) + r.cost;
    cur.status = 'idle';
    if (r.isError || r.result == null) await appendMsg(id, { role: 'system', text: `调用失败（rc=${r.code}，${r.ms}ms）：${redact(r.err || r.result || '')}` });
    else {
      await appendMsg(id, { role: 'assistant', text: redact(r.result), ms: r.ms, cost: r.cost });
      if (cur.role === 'main') {
        for (const mm of String(r.result).matchAll(/\[\[开辅助:([^:\]]{1,40}):([^\]]{1,2000})\]\]/g)) {
          const res = await openAux({ title: mm[1].trim(), instruction: mm[2].trim(), parent: 'main' });
          await appendMsg('main', { role: 'system', text: res.code === 200 ? `已按主会话要求开启辅助会话 ${res.body.id}「${mm[1].trim()}」` : `没开辅助会话：${res.body.error}` });
        }
      }
    }
    await saveMeta(cur);
  })().catch(async (e) => { const cur = sessions.get(id); if (cur) { cur.status = 'idle'; await saveMeta(cur); } });
  return { code: 202, body: { accepted: true, seq: rec.seq } };
}
async function openAux({ title, instruction, parent = 'main', provider = 'claude' }) {
  if (provider === 'kimi') return { code: 501, body: { error: 'Kimi 未启用（启用需 Andy 本人批）' } };
  if (provider === 'codex' && !cfg.codexEnabled) return { code: 501, body: { error: CODEX_PAUSED } };
  if (activeAux().length >= cfg.maxAux) {
    const q = { qid: 'q-' + Date.now().toString(36), title, instruction, parent, provider, at: now(), reason: `辅助会话已达上限 ${cfg.maxAux} 个，排队等有会话停掉` };
    pending.push(q);
    return { code: 202, body: { queued: true, ...q } };
  }
  const m = await createSession({ role: 'aux', provider, title, parent });
  await appendMsg(m.id, { role: 'system', text: `由 ${parent} 开启。空闲 ${cfg.idleMinutes} 分钟自动停。` });
  if (instruction) await sendMessage(m.id, instruction, parent);
  return { code: 200, body: summary(m) };
}
async function stopSession(id, reason = '手动停止') {
  const m = sessions.get(id);
  if (!m) return { code: 404, body: { error: '会话不存在' } };
  if (m.role === 'main') return { code: 400, body: { error: '主会话固定，不能停' } };
  const child = procs.get(id);
  if (child) { try { child.kill(); } catch {} procs.delete(id); }
  m.status = 'stopped'; m.stoppedReason = reason; m.stoppedAt = now();
  indexCache.delete(id);
  await saveMeta(m);
  await appendMsg(id, { role: 'system', text: `会话已停止：${reason}` });
  while (pending.length && activeAux().length < cfg.maxAux) { const q = pending.shift(); const r = await openAux(q); if (sessions.has('main')) await appendMsg('main', { role: 'system', text: `排队的辅助会话「${q.title}」已开启：${r.body.id || r.body.error}` }); }
  return { code: 200, body: summary(m) };
}
// 空闲巡检：辅助会话空闲超时自动停；服务端内存索引过期卸载
setInterval(async () => {
  const lim = cfg.idleMinutes * 60000;
  for (const m of activeAux()) {
    if (m.status === 'busy') continue;
    if (Date.now() - Date.parse(m.lastActivity) > lim) await stopSession(m.id, `空闲超过 ${cfg.idleMinutes} 分钟自动停`);
  }
  for (const [id, ix] of indexCache) if (Date.now() - ix.at > cfg.indexEvictMinutes * 60000) indexCache.delete(id);
}, 5000).unref();

async function readBody(req, max = 64 * 1024) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > max) throw new Error('请求体过大'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }

let ready = null;
export function chatInit() { if (!ready) ready = loadConfig().then(loadSessions); return ready; }
export async function handleChat(req, res, url) {
  await chatInit();
  const p = url.pathname.replace(/^\/api\/chat\/?/, '');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === 'GET' && parts[0] === '_stats') return send(res, 200, chatStats());
    if (req.method === 'POST' && parts[0] === '_seed') {
      if (process.env.CMD_CHAT_TEST !== '1') return send(res, 403, { error: '压测接口只在 CMD_CHAT_TEST=1 时开' });
      return send(res, 200, await seedLongSession(Math.min(20000, Number(url.searchParams.get('n') || 3000))));
    }
    if (req.method === 'GET' && parts[0] === 'config') return send(res, 200, { config: cfg, chatRoot: CHAT_ROOT, kimi: '未启用（接口预留，启用需 Andy 本人批）', codex: cfg.codexEnabled ? '仅测试实例临时开启（CMD_CHAT_CODEX=1）' : CODEX_PAUSED });
    if (parts[0] !== 'sessions') return send(res, 404, { error: 'unknown' });
    if (parts.length === 1) {
      if (req.method === 'GET') {
        const list = [...sessions.values()].sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : b.lastActivity.localeCompare(a.lastActivity))).map(summary);
        return send(res, 200, { sessions: list, activeAux: activeAux().length, maxAux: cfg.maxAux, idleMinutes: cfg.idleMinutes, procs: procs.size, pending });
      }
      if (req.method === 'POST') { const b = await readBody(req); const r = await openAux({ title: b.title || '辅助会话', instruction: b.instruction || '', parent: b.parent || 'Andy（手动）', provider: b.provider || 'claude' }); return send(res, r.code, r.body); }
    }
    const id = parts[1]; const m = sessions.get(id);
    if (!m) return send(res, 404, { error: '会话不存在' });
    if (parts.length === 2 && req.method === 'GET') return send(res, 200, summary(m));
    if (parts[2] === 'stop' && req.method === 'POST') { const r = await stopSession(id); return send(res, r.code, r.body); }
    if (parts[2] === 'messages' && parts.length === 3 && req.method === 'POST') { const b = await readBody(req); const r = await sendMessage(id, b.text); return send(res, r.code, r.body); }
    if (parts[2] === 'messages' && parts.length === 3 && req.method === 'GET') {
      const ix = await getIndex(id); const total = ix.offsets.length;
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || cfg.pageSize)));
      const before = url.searchParams.has('before') ? Math.min(total, Number(url.searchParams.get('before'))) : total;
      const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null;
      let from, to;
      if (after != null) { from = Math.min(total, after + 1); to = Math.min(total, from + limit); } else { to = before; from = Math.max(0, to - limit); }
      if (!url.searchParams.has('before') && after == null) { // 首屏：最近 30 条或 64KB，取小者
        let bytes = 0; let f = to;
        while (f > from && bytes + ix.offsets[f - 1][1] <= cfg.firstScreenBytes) { bytes += ix.offsets[f - 1][1]; f--; }
        from = Math.max(f, to - limit); if (from === to && to > 0) from = to - 1;
      }
      const msgs = (await readRange(id, from, to)).map((x) => { const t = String(x.text || ''); return Buffer.byteLength(t) > cfg.longMsgBytes ? { ...x, text: t.slice(0, cfg.previewChars), truncated: true, fullLength: t.length } : x; });
      return send(res, 200, { id, total, from, to, hasMore: from > 0, status: m.status, messages: msgs });
    }
    if (parts[2] === 'messages' && parts.length === 4 && req.method === 'GET') {
      const seq = Number(parts[3]); const ix = await getIndex(id);
      if (!(seq >= 0 && seq < ix.offsets.length)) return send(res, 404, { error: '没有这条' });
      return send(res, 200, (await readRange(id, seq, seq + 1))[0]);
    }
    return send(res, 405, { error: '不支持' });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
}
// 测试用：造长会话（只写聊天沙箱）
export async function seedLongSession(n, title = '压测长会话') {
  await chatInit();
  const m = await createSession({ role: 'aux', provider: 'claude', title, parent: '压测' });
  m.status = 'stopped'; m.stoppedReason = '压测数据，不接 CLI';
  const lines = [];
  for (let i = 0; i < n; i++) {
    const long = i % 50 === 7;
    const text = long ? `第 ${i} 条长消息：` + '这是一段很长的测试正文，用来测懒加载。'.repeat(600) : `第 ${i} 条消息：${i % 2 ? '回复' : '指令'} ` + '测试内容'.repeat(10 + (i % 20));
    lines.push(JSON.stringify({ seq: i, ts: now(), role: i % 2 ? 'assistant' : 'user', from: i % 2 ? undefined : 'Andy', text }));
  }
  await fsp.writeFile(msgFile(m.id), lines.join('\n') + '\n');
  m.msgCount = n; m.lastSnippet = '压测数据'; await saveMeta(m);
  indexCache.delete(m.id);
  return summary(m);
}
export function chatStats() { return { sessions: sessions.size, indexCached: [...indexCache.keys()], procs: [...procs.keys()], rssMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }; }
