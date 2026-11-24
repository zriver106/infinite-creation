// 看门狗保活（CLA-34）：Windows 任务计划每分钟跑一次本脚本，跑完就退出。
// 只有「看门狗进程不在」且「心跳过期（>60 秒）」才用 WMI Win32_Process Create 拉起一个独立的看门狗；绝不杀进程。
// 单实例：看门狗自己用 watchdog.pid 判重；本脚本另用 keeper.lock（30 秒内有别的 keeper 在跑就退出）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const M = process.env.WD_M || 'C:\\Users\\usazr\\Documents\\moviePro';
const WD = process.env.WD_DIR || path.join(M, 'Claude工作区', '指挥', '看门狗');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'command-watchdog.mjs');
const NODE = process.execPath;
const log = (s) => { try { fs.appendFileSync(path.join(WD, 'keeper.log'), `${new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' })} ${s}\n`); } catch {} };
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

fs.mkdirSync(WD, { recursive: true });
const lock = path.join(WD, 'keeper.lock');
try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs < 30000) process.exit(0); } catch {}
fs.writeFileSync(lock, String(process.pid));

let hbAge = Infinity, pid = null;
try { const hb = JSON.parse(fs.readFileSync(path.join(WD, 'heartbeat.json'), 'utf8')); hbAge = (Date.now() - Date.parse(hb.at)) / 1000; } catch {}
try { pid = parseInt(fs.readFileSync(path.join(WD, 'watchdog.pid'), 'utf8'), 10); } catch {}
let alive = false;
const r = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*command-watchdog.mjs*' -and $_.CommandLine -notlike '*--once*' } | ForEach-Object { $_.ProcessId }`);
const live = String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
alive = !!pid && live.includes(pid); // 本目录 pid 文件里的那个看门狗还在
if (r.status !== 0) { log('进程表查询失败，本次不拉起'); process.exit(0); }
if (alive || hbAge <= 30) { if (process.argv.includes('--verbose')) log(`正常：看门狗进程 ${live.join(',') || '（未查到）'}，心跳 ${Math.round(hbAge)} 秒前`); process.exit(0); }

const out = path.join(WD, 'watchdog.out.log'); const err = path.join(WD, 'watchdog.err.log');
// WMI 起的进程不继承本进程的环境变量：测试用的变量要写进命令行（正式运行时一个都没有）
const PASS = ['WD_DIR', 'WD_M', 'WD_G', 'WD_CF', 'WD_IC', 'WD_PROCS_FILE', 'IC_CONFIG', 'WD_TEST'].filter((k) => process.env[k]);
const sets = PASS.map((k) => `set "${k}=${process.env[k]}"&& `).join('');
const cl = `cmd /c "${sets}"${NODE}" "${SCRIPT}" 1>> "${out}" 2>> "${err}""`;
const esc = (s) => s.replace(/'/g, "''");
const c = ps(`$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${esc(cl)}';CurrentDirectory='${esc(path.dirname(SCRIPT))}'}; "$($r.ReturnValue) $($r.ProcessId)"`);
log(`看门狗不在（pid 文件 ${pid}，心跳 ${hbAge === Infinity ? '无' : Math.round(hbAge) + ' 秒前'}）→ WMI 拉起：${String(c.stdout).trim()} ${String(c.stderr || '').trim().slice(0, 200)}`);
