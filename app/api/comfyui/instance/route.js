// 本地附加 ComfyUI 实例的启动 / 停止 / 状态（设置页「ComfyUI 服务」端点卡片上的「启动 / 停止」按钮）。2026-11-25。
// 只管本机 127.0.0.1 上的附加实例；8189（主实例，正在出片）一律拒绝，不能在这里启停。
// 启动走 scripts/multi-gpu/start-comfyui-gpu.ps1（端口占用、没有这张卡、GPU 0 / 显存已占都会被脚本拒绝），
// 停止走 stop-comfyui-gpu.ps1（只停命令行里带 --port <端口> 的进程）。公开模式（IC_PUBLIC=1）禁用。
import { NextResponse } from 'next/server';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const dynamic = 'force-dynamic';

const PUBLIC_MODE = process.env.IC_PUBLIC === '1';
const MAIN_PORT = 8189;
const SCRIPTS = path.join(process.cwd(), 'scripts', 'multi-gpu');
const LOG_DIR = path.join(process.cwd(), 'data', 'logs');
const starting = new Map(); // port -> { at, pid, log }

function parsePort(baseUrl, port) {
  if (port != null && port !== '') return Number(port);
  try {
    const u = new URL(String(baseUrl || ''));
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return NaN;
    return Number(u.port);
  } catch { return NaN; }
}
function badPort(p) {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return '端口不对';
  if (p === MAIN_PORT) return '8189 是正在出片的主实例，不能在这里启停';
  return '';
}
function listening(port) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}`], { timeout: 15000, windowsHide: true }, (err, out) => {
      const pid = Number(String(out || '').trim());
      resolve(Number.isInteger(pid) && pid > 0 ? pid : 0);
    });
  });
}
async function systemStats(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// GET ?baseUrl=… 或 ?port=… → { port, state: 'stopped'|'starting'|'running', pid, main }
export async function GET(req) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不可用' }, { status: 403 });
  const u = new URL(req.url);
  const port = parsePort(u.searchParams.get('baseUrl'), u.searchParams.get('port'));
  if (port === MAIN_PORT) return NextResponse.json({ port, main: true, state: (await systemStats(port)) ? 'running' : 'stopped' });
  const bad = badPort(port);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  const pid = await listening(port);
  const ok = pid ? await systemStats(port) : false;
  const st = starting.get(port);
  let state = ok ? 'running' : (st && Date.now() - st.at < 10 * 60 * 1000 ? 'starting' : 'stopped');
  if (state === 'starting' && st.log) { try { if (/失败：|\[refuse\]/.test(fs.readFileSync(st.log, 'utf8').slice(-2000))) { state = 'failed'; } } catch {} }
  if (ok || state === 'failed') starting.delete(port);
  let tail = '';
  if (st && st.log && state !== 'running') { try { tail = fs.readFileSync(st.log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3).join(' / '); } catch {} }
  return NextResponse.json({ port, main: false, state, pid: pid || null, log: tail });
}

// POST { action: 'start'|'stop', baseUrl | port, gpu }
export async function POST(req) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不可用' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const port = parsePort(body.baseUrl, body.port);
  const bad = badPort(port);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  if (body.action === 'start') {
    const gpu = Number(body.gpu);
    if (!Number.isInteger(gpu) || gpu < 0) return NextResponse.json({ error: '显卡编号不对' }, { status: 400 });
    if (await listening(port)) return NextResponse.json({ error: '端口 ' + port + ' 已有程序在监听' }, { status: 409 });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const log = path.join(LOG_DIR, `comfyui-instance-${port}.log`);
    const out = fs.openSync(log, 'a');
    // 脚本自己做安全检查并用 WMI 分离启动，这里只把它跑起来；不加 -Force（GPU 0 / 显存已占时由脚本拒绝）。
    const ps1 = path.join(SCRIPTS, 'start-comfyui-gpu.ps1').replace(/'/g, "''");
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorView='CategoryView'; try { & '${ps1}' -Gpu ${gpu} -Port ${port} } catch { Write-Output ('失败：' + $_.Exception.Message); exit 1 }`],
      { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    child.unref();
    starting.set(port, { at: Date.now(), pid: child.pid, log });
    return NextResponse.json({ ok: true, port, state: 'starting', log }, { status: 202 });
  }
  if (body.action === 'stop') {
    const r = await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { & '${path.join(SCRIPTS, 'stop-comfyui-gpu.ps1').replace(/'/g, "''")}' -Port ${port} } catch { Write-Output ('失败：' + $_.Exception.Message); exit 1 }`], { timeout: 30000, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
    });
    starting.delete(port);
    return NextResponse.json({ ok: r.ok, port, state: r.ok ? 'stopped' : 'unknown', detail: r.out.trim().split(/\r?\n/).slice(-3).join(' / ') }, { status: r.ok ? 200 : 500 });
  }
  return NextResponse.json({ error: 'action 只能是 start / stop' }, { status: 400 });
}
