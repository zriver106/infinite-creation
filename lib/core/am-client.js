// am（本机 Muse 账号 Agent1Muse）客户端：发消息走 muse-cli send，工作区读写走 am_bridge.py（muse-cli 自带 python）。
// 总导 11-26：资产出图收回 IC；逻辑从站位会话的 工具\am_v3_queue/sync/upload.py 搬来。
// 规矩：send 的等待时间不低于 30 秒（设 0 会丢消息）。结果不明的不重发——发送没确认就记「未确认」，交给对账，不自动重派。
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'agent', 'external', 'am_bridge.py');
export const AM_MIN_WAIT = 30;

export function amPaths(cfg = loadConfig()) {
  const a = (cfg && cfg.am) || {};
  return {
    museCli: a.museCli || path.join(os.homedir(), '.local', 'bin', 'muse-cli.exe'),
    python: a.python || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'uv', 'tools', 'muse-cli', 'Scripts', 'python.exe'),
    outDir: a.outDir || 'workspace/ic_out',
    refDir: a.refDir || 'workspace/ic_refs',
  };
}

function run(bin, args, { input = null, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? String(err.message || err) : '' });
    });
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

/** 发一条消息到 am 的某个会话。返回 { ok, confirmed }：ok=false 是确定没发出去；confirmed=false 是结果不明（不要重发）。 */
export async function amSend(session, text, { wait = AM_MIN_WAIT, cfg } = {}) {
  const p = amPaths(cfg);
  const w = Math.max(AM_MIN_WAIT, Number(wait) || AM_MIN_WAIT);
  const r = await run(p.museCli, ['send', '--thread', String(session), '--wait', String(w), String(text)], { timeout: (w + 120) * 1000 });
  const confirmed = r.code === 0 && /"sent":\s*true/.test(r.stdout);
  if (/auth error|401/.test(r.stdout + r.stderr)) return { ok: false, confirmed: false, auth: true, error: 'muse-cli 登录过期：运行 muse-cli auth export --browser agent-browser 续登录' };
  return { ok: r.code === 0, confirmed, error: confirmed ? '' : (r.error || r.stderr || r.stdout).slice(0, 300) };
}

async function bridge(cmd, args, cfg) {
  const p = amPaths(cfg);
  const r = await run(p.python, ['-I', BRIDGE, cmd], { input: JSON.stringify(args) });
  const line = r.stdout.trim().split(/\r?\n/).pop() || '';
  try { return JSON.parse(line); } catch { return { ok: false, error: (r.error || r.stderr || line).slice(0, 300) }; }
}

/** 本机文件写进 am 工作区（参考图、底图、已审过的 A 格）。 */
export const amPut = (local, remote, cfg) => bridge('put', { local, remote }, cfg);
/** 列 am 工作区目录里的文件。 */
export const amList = (dir, cfg) => bridge('list', { dir }, cfg);
/** 从 am 工作区读回本机。 */
export const amGet = (remote, local, cfg) => bridge('get', { remote, local }, cfg);
