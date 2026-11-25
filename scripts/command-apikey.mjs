// Claude API 密钥入口（只存在 agent1 本机；任何接口只回 {set, last4}，不回密钥、不写日志）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

export const SECRET_DIR = process.env.CMD_SECRET_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'moviePro', 'local_secrets');
const KEY_FILE = path.join(SECRET_DIR, 'claude_api.json');
const ROUTE_FILE = path.join(SECRET_DIR, 'claude_api_routing.json');   // 不含密钥
const USAGE_FILE = path.join(SECRET_DIR, 'claude_api_usage.json');     // 不含密钥：我们自己调用记下的 token 数
const API_BASE = process.env.CMD_ANTHROPIC_BASE || 'https://api.anthropic.com';
const KEY_RE = /^sk-ant-[A-Za-z0-9_\-]{4,200}$/;

async function ensureDir() {
  await fsp.mkdir(SECRET_DIR, { recursive: true });
  // 只给当前用户：去掉继承，只授当前用户完全控制（Windows；失败不致命，状态里会显示）
  if (process.platform === 'win32' && !ensureDir.done) {
    ensureDir.acl = await new Promise((r) => execFile('icacls', [SECRET_DIR, '/inheritance:r', '/grant:r', `${process.env.USERNAME || os.userInfo().username}:(OI)(CI)F`], { windowsHide: true }, (e) => r(e ? '设置失败：' + String(e.message).slice(0, 80) : '只限当前用户')));
    ensureDir.done = true;
  }
}
async function readJson(f, d) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return d; } }
async function writeJson(f, o) { await ensureDir(); const tmp = f + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(o, null, 2), { mode: 0o600 }); await fsp.rename(tmp, f); }
async function getKey() { const j = await readJson(KEY_FILE, {}); return typeof j.key === 'string' && j.key ? j.key : null; }

export async function apiKeyForChild() { return getKey(); } // 只给本进程起子进程用，不出接口
export async function status() {
  const k = await getKey(); const meta = await readJson(KEY_FILE, {});
  return { set: !!k, last4: k ? k.slice(-4) : null, savedAt: k ? meta.savedAt || null : null, file: KEY_FILE, acl: ensureDir.acl || null };
}
export async function routing() {
  const r = await readJson(ROUTE_FILE, {});
  return { default: 'cc', roles: { main: r.roles?.main === 'api' ? 'api' : 'cc', aux: r.roles?.aux === 'api' ? 'api' : 'cc' }, sessions: Object.fromEntries(Object.entries(r.sessions || {}).filter(([, v]) => v === 'api' || v === 'cc')), changedAt: r.changedAt || null, changedBy: r.changedBy || null };
}
export async function modeFor(sessionId, role) {
  const r = await routing();
  const m = r.sessions[sessionId] || r.roles[role === 'main' ? 'main' : 'aux'] || 'cc';
  if (m !== 'api') return 'cc';
  return (await getKey()) ? 'api' : 'cc'; // 选了 API 但没存密钥：照旧走 Claude Code
}
export async function recordUsage(sessionId, usage) {
  if (!usage) return;
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' });
  const u = await readJson(USAGE_FILE, {});
  u[day] = u[day] || {}; const s = (u[day][sessionId] = u[day][sessionId] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
  s.input += Number(usage.input_tokens || 0); s.output += Number(usage.output_tokens || 0); s.cacheRead += Number(usage.cache_read_input_tokens || 0); s.cacheWrite += Number(usage.cache_creation_input_tokens || 0); s.calls += 1;
  await writeJson(USAGE_FILE, u);
}
export async function usageView() {
  const u = await readJson(USAGE_FILE, {});
  const days = Object.keys(u).sort().reverse().slice(0, 14).map((d) => { const ss = u[d]; const tot = Object.values(ss).reduce((a, s) => ({ input: a.input + s.input, output: a.output + s.output, calls: a.calls + s.calls }), { input: 0, output: 0, calls: 0 }); return { day: d, ...tot, sessions: ss }; });
  return { days, note: '这里是我们自己走 API 调用时记下的 token 数（按会话、按天，太平洋时间）；Anthropic 官方的用量/花费接口要单独的管理员密钥，没有接，不是官方账单' };
}

async function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
async function testConn() {
  const k = await getKey(); if (!k) return { ok: false, status: null, msg: '还没存密钥' };
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(`${API_BASE}/v1/models?limit=1`, { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, signal: ac.signal });
    await r.arrayBuffer().catch(() => null); // 不回传任何响应内容
    return { ok: r.ok, status: r.status, msg: r.ok ? '通' : '不通' };
  } catch (e) { return { ok: false, status: null, msg: '不通（连不上）' }; }
  finally { clearTimeout(tm); }
}
// 路由：/api/command/settings/claude-api[/key|/clear|/test|/routing]
export async function handleApiKey(req, res, sub, send) {
  const act = sub.replace(/^settings\/claude-api\/?/, '');
  if (req.method === 'GET' && !act) return send(res, 200, { key: await status(), routing: await routing(), usage: await usageView(), apiBase: API_BASE === 'https://api.anthropic.com' ? '官方' : '测试地址' });
  if (req.method !== 'POST') return send(res, 405, { error: '不支持' });
  const b = await readBody(req);
  if (act === 'key') {
    const key = String(b.key || '').trim();
    if (!KEY_RE.test(key)) return send(res, 400, { error: '格式不对：应以 sk-ant- 开头' });
    const prev = await readJson(KEY_FILE, {});
    await writeJson(KEY_FILE, { key, savedAt: new Date().toISOString(), replaced: !!prev.key });
    return send(res, 200, await status());
  }
  if (act === 'clear') { await writeJson(KEY_FILE, { key: null, clearedAt: new Date().toISOString() }); return send(res, 200, await status()); }
  if (act === 'test') return send(res, 200, await testConn());
  if (act === 'routing') {
    const cur = await readJson(ROUTE_FILE, {});
    const roles = { ...(cur.roles || {}) }; const sessions = { ...(cur.sessions || {}) };
    if (b.role && ['main', 'aux'].includes(b.role) && ['api', 'cc'].includes(b.mode)) roles[b.role] = b.mode;
    if (b.session && /^[A-Za-z0-9_\-]{1,60}$/.test(b.session) && ['api', 'cc', 'default'].includes(b.mode)) { if (b.mode === 'default') delete sessions[b.session]; else sessions[b.session] = b.mode; }
    await writeJson(ROUTE_FILE, { roles, sessions, changedAt: new Date().toISOString(), changedBy: String(b.operator || 'Andy').slice(0, 20) });
    return send(res, 200, await routing());
  }
  return send(res, 404, { error: '没有这个操作' });
}
