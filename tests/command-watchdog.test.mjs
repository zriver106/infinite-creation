// 看门狗测试（CLA-34）。运行：IC_CONFIG=:9 node --test tests/command-watchdog.test.mjs
// 全部用 fixture：8189 用假服务（随机端口），进程表用 WD_PROCS_FILE，链目录用 WD_M/WD_G 指向临时目录。自动恢复只测 dry。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../scripts/command-watchdog-lib.mjs';

process.env.IC_CONFIG = ':9';
// 连接拦截：本测试进程里任何去 8188/8189 的 TCP 连接直接抛错（子进程由看门狗自身的 IC_CONFIG=:9 守卫拦）
import net from 'node:net';
const _connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { const o = Array.isArray(args[0]) ? args[0][0] : args[0]; const port = typeof o === 'object' && o ? Number(o.port) : Number(o); if (port === 8188 || port === 8189) throw new Error('测试禁止连接 ' + port); return _connect.apply(this, args); };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WDJS = path.join(ROOT, 'scripts', 'command-watchdog.mjs');
const REAL_U = 'C:\\Users\\usazr\\Documents\\moviePro\\_';
const FX = path.join(process.env.WD_FIXTURE_ROOT || path.join(REAL_U, 'watchdog_dev', 'fixtures'), 'run_' + Date.now());
fs.mkdirSync(FX, { recursive: true });

const CFG = { gpuIdleGraceSec: 60, chainStaleMin: 50, chainWaitStaleMin: 5, sessionLongMin: 90, gateMaxChapter: 10, recentHours: 6, preparedHours: 2, recovery: { mode: 'dry', whitelist: [{ script: 'gpu_rr1845_chain.py', md5: '0DAB8B2399C4BF0A48CBF92670E45A7F', outDir: REAL_U + '\\rr678b_release' }] } };
const NOW = Date.parse('2026-11-24T02:57:00Z'); // 18:57 PT
const plan678 = [{ chapter: '第6章', ch: 6, ids: [3, 5, 6, 9, 10, 12], tag: 'ch6' }];
const plan1845 = [{ chapter: '第6章', ch: 6, ids: [4, 7, 11, 13], tag: 'ch6' }, { chapter: '第7章', ch: 7, ids: [4, 10, 16, 19, 22], tag: 'ch7' }, { chapter: '第8章', ch: 8, ids: [2, 4, 7, 11, 15, 20, 23, 25], tag: 'ch8' }];
function view(o) { const v = { name: 'x', script: 'gpu_x_chain.py', plan: [], alive: [], logExists: true, logMtimeMs: NOW, last: '', upstream: null, terminal: null, shots: { total: 0, unsubmitted: [], uncertain: [], done: 0 }, recent: true, ...o }; v.terminal = v.terminal ?? L.terminalOf(v.name, v.last); v.state = L.chainState(v); return v; }
const gpuEmpty = { ok: true, running: [], pending: [] };
const snap = (o) => ({ now: NOW, cfg: CFG, gpu: gpuEmpty, gpuEmptySinceMs: null, chains: [], procs: [], sessions: { long: [], errors: [] }, deadlines: [], gateFlag: true, queueChapters: [], ...o });
const keys = (arr) => arr.map((a) => a.key).sort();

test('解析真链脚本 gpu_rr1845_chain.py（PLAN/STOPF/LOGD/UPSTREAM）', () => {
  const t = fs.readFileSync(path.join(REAL_U, 'gpu_rr1845_chain.py'), 'utf8');
  const p = L.parseChainScript(t, 'gpu_rr1845_chain.py');
  assert.equal(p.name, 'rr1845'); assert.equal(p.plan.length, 3); assert.deepEqual(p.plan[0].ids, [4, 7, 11, 13]);
  assert.equal(p.stopName, 'rr1845.STOP'); assert.equal(p.logDir, 'rr1845_chain_20261123'); assert.equal(p.progDirs.ch7, 'rr1845_ch7_20261123');
  assert.deepEqual(p.upstream.rr678, { logDir: 'rr678_chain_20261123', progDirs: ['rr678_ch6_20261123'] });
  assert.equal(L.upstreamFromLog('rr1845', '2026-11-23T18:50:00 rr1845 chain start (armed wait for rr678; pid from process list only) pid 1\n2026-11-23T18:57:14 rr1845 chain start (no upstream wait) pid 2\n'), 'none');
  assert.equal(L.upstreamFromLog('rr1845', '2026-11-23T18:50:00 rr1845 chain start (armed wait for rr678; pid from process list only) pid 1\n'), 'rr678');
});

test('检查1：GPU 空 ≥60 秒且计划有未提交 → ERROR；不到宽限不报', () => {
  const c = view({ name: 'a', alive: [11], last: '2026-11-23T18:56:00 第6章 prelint start', shots: { unsubmitted: ['第6章#4'], uncertain: [] } });
  assert.ok(keys(L.evaluate(snap({ chains: [c], gpuEmptySinceMs: NOW - 70000 }))).includes('gpu_stall'));
  assert.ok(!keys(L.evaluate(snap({ chains: [c], gpuEmptySinceMs: NOW - 30000 }))).includes('gpu_stall'));
  assert.ok(!keys(L.evaluate(snap({ chains: [view({ name: 'b', last: 'b stopped (stop marker)', shots: { unsubmitted: ['x'], uncertain: [] } })], gpuEmptySinceMs: NOW - 900000 }))).includes('gpu_stall'), '人为停下的链不算');
});

test('检查2：进程没了 / 出片中日志 50 分钟没更新 / 等待 5 分钟且上游不在', () => {
  const dead = view({ name: 'd', last: '2026-11-23T18:00:00 submitted 第6章 4 x', shots: { unsubmitted: [], uncertain: ['第6章#4:running'] } });
  const k = keys(L.evaluate(snap({ chains: [dead] })));
  assert.ok(k.includes('chain_gone:d') && k.includes('chain_uncertain:d'));
  const stale = view({ name: 's', alive: [5], last: '2026-11-23T18:00:00 submitted 第6章 4 x', logMtimeMs: NOW - 51 * 60000 });
  assert.deepEqual(keys(L.evaluate(snap({ chains: [stale] }))), ['chain_stale:s']);
  const fresh = view({ name: 's', alive: [5], last: 'x submitted', logMtimeMs: NOW - 44 * 60000 });
  assert.deepEqual(keys(L.evaluate(snap({ chains: [fresh] }))), []);
  const w = view({ name: 'w', alive: [6], last: '2026-11-23T18:40:00 waiting for up pid [] to exit', upstream: 'up', logMtimeMs: NOW - 6 * 60000 });
  assert.deepEqual(keys(L.evaluate(snap({ chains: [w, view({ name: 'up', last: 'up done' })] }))), ['chain_wait_stuck:w']);
  assert.deepEqual(keys(L.evaluate(snap({ chains: [w, view({ name: 'up', alive: [7], last: 'up submitted' })] }))), [], '上游活着就不报');
});

test('检查3 + 今晚回放：rr678 18:50:45 done、rr1845 进程没了、计划有未提交 → 交接断 + gpu_idle', () => {
  const up = view({ name: 'rr678', script: 'gpu_rr678_chain.py', plan: plan678, last: '2026-11-23T18:50:45 rr678 done', shots: { unsubmitted: [], uncertain: [] } });
  const dn = view({ name: 'rr1845', script: 'gpu_rr1845_chain.py', plan: plan1845, md5: '0DAB8B2399C4BF0A48CBF92670E45A7F', last: '2026-11-23T18:50:30 waiting for rr678 pid [41000] to exit; last line: ...', upstream: 'rr678', shots: { unsubmitted: plan1845.flatMap((p) => p.ids.map((k) => `${p.chapter}#${k}`)), uncertain: [] } });
  const found = L.evaluate(snap({ chains: [up, dn], gpuEmptySinceMs: Date.parse('2026-11-24T02:50:46Z') }));
  const k = keys(found);
  assert.ok(k.includes('handoff_broken:rr1845')); assert.ok(k.includes('gpu_stall')); assert.ok(!k.includes('chain_gone:rr1845'), '交接断取代进程没了');
  const d = L.recoveryDecision({ c: dn, up, cfg: CFG, procs: [], gpu: gpuEmpty, gpuIdleSec: 370, stopExists: false, upProgUncertain: [], history: [], now: NOW, M: 'C:\\Users\\usazr\\Documents\\moviePro', python: 'C:\\Python315\\python.exe' });
  assert.equal(d.ok, true, d.reasons.join('；')); assert.equal(d.live, false, 'dry');
  assert.match(d.cmd, /^cmd \/c "cd \/d C:\\Users\\usazr\\Documents\\moviePro\\_ && "C:\\Python315\\python\.exe" -X utf8 -u gpu_rr1845_chain\.py --after=none 1> "C:\\Users\\usazr\\Documents\\moviePro\\_\\rr678b_release\\run_stdout_rr1845_wd\d{12}\.txt" 2> "C:\\Users\\usazr\\Documents\\moviePro\\_\\rr678b_release\\run_stderr_rr1845_wd\d{12}\.txt""$/);
  console.log('  dry 命令：', d.cmd);
  // 每个条件单独不满足 → 不重启
  const no = (o, re) => { const r = L.recoveryDecision({ c: dn, up, cfg: CFG, procs: [], gpu: gpuEmpty, gpuIdleSec: 370, stopExists: false, upProgUncertain: [], history: [], now: NOW, M: 'C:\\M', python: 'py', ...o }); assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => re.test(x)), r.reasons.join('|')); };
  no({ c: { ...dn, md5: 'BAD' } }, /md5/);
  no({ up: { ...up, alive: [1] } }, /上游.*进程还在/);
  no({ up: { ...up, last: 'x rr678 stopped (y)' } }, /上游最后一行/);
  no({ upProgUncertain: ['rr678_ch6#3:unknown'] }, /上游 progress/);
  no({ c: { ...dn, alive: [2] } }, /自己的进程还在/);
  no({ c: { ...dn, terminal: 'stopped' } }, /stopped/);
  no({ c: { ...dn, shots: { unsubmitted: ['a'], uncertain: ['第6章#4:timeout_unknown'] } } }, /状态不明/);
  no({ procs: [{ pid: 9, name: 'python.exe', cmd: 'python gpu_rr1700_chain.py' }] }, /别的提交者/);
  no({ procs: [{ pid: 9, name: 'python.exe', cmd: 'python gpu_submit.py x' }] }, /别的提交者/);
  no({ gpu: { ok: true, running: [[1, 'p']], pending: [] } }, /队列不空/);
  no({ stopExists: true }, /STOP/);
  no({ history: [{ chain: 'rr1845', at: new Date(NOW - 10 * 60000).toISOString(), live: true }] }, /30 分钟/);
  no({ history: [{ chain: 'rr1845', at: new Date(NOW - 5 * 3600000).toISOString(), live: true }, { chain: 'rr1845', at: new Date(NOW - 3 * 3600000).toISOString(), live: true }] }, /2 次/);
});

test('检查4：claude -p 超时 WARN、输出 is_error / 额度用完 ERROR，普通文字不误报', () => {
  const found = L.evaluate(snap({ sessions: { long: [{ pid: 18300, min: 95, created: new Date(NOW - 95 * 60000).toISOString(), cmd: 'claude -p --model opus' }], errors: [{ file: 'C:\\M\\_\\x\\session_out.json', what: 'x' }] } }));
  assert.deepEqual(found.map((a) => [a.key.split(':')[0], a.level]), [['session_long', 'WARN'], ['session_error', 'ERROR']]);
  assert.equal(L.scanOutputTail('session_out.jsonl', '{"type":"assistant","message":{"content":"is_error:true usage limit"}}\n{"type":"result","subtype":"success","is_error":false}'), null);
  assert.match(L.scanOutputTail('session_out.json', '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached"}'), /结果出错.*usage limit/);
  assert.match(L.scanOutputTail('run.jsonl', '{"type":"result","subtype":"error_max_turns","is_error":false}'), /error_max_turns/);
  assert.match(L.scanOutputTail('session_err.txt', 'Error: 5-hour limit reached ∙ resets 9pm\nusage limit'), /stderr/);
  assert.equal(L.scanOutputTail('run_stdout.txt', 'usage limit mentioned in text'), null, '非 err 文件的纯文字不算');
  assert.deepEqual(L.redirectTargets('cmd /c "cd /d C:\\M\\_ && "C:\\Python315\\python.exe" -u a.py 1> rr\\out.txt 2> "C:\\M\\_\\b err.txt""'), ['C:\\M\\_\\rr\\out.txt', 'C:\\M\\_\\b err.txt']);
});

test('检查5：截止时间 提前30/10分钟各提醒、过点再报、完成不报（太平洋时间）', () => {
  assert.equal(L.ptToDate('2026-11-23T20:30').toISOString(), '2026-11-24T04:30:00.000Z');
  const dl = [{ id: 'db', name: '第6–8集写库', at: '2026-11-23T20:30' }];
  const at = (hm) => Date.parse(`2026-11-24T${hm}:00Z`);
  const st = (t, d = dl) => L.evaluate(snap({ now: t, deadlines: d })).map((a) => [a.key, a.level, a.sig]);
  assert.deepEqual(st(at('03:50')), []);
  const s30 = st(at('04:05')); const s10 = st(at('04:22')); const so = st(at('04:31'));
  assert.equal(s30[0][1], 'WARN'); assert.equal(s10[0][1], 'WARN'); assert.equal(so[0][1], 'ERROR');
  assert.equal(new Set([s30[0][2], s10[0][2], so[0][2]]).size, 3, '三个阶段签名不同 → 各推一次');
  assert.equal(st(at('04:06'))[0][2], s30[0][2], '同一阶段签名不变 → 不重复推');
  assert.deepEqual(st(at('04:31'), [{ ...dl[0], done: true }]), []);
});

test('检查6：第1–10集闸门——flag 不存在 + 第11章在队列/计划 → 报警；flag 存在 → 不报', () => {
  const ch11 = view({ name: 'g', alive: [3], plan: [{ chapter: '第11章', ch: 11, ids: [1], tag: 'ch11' }], last: 'x submitted' });
  const q = [{ prompt_id: 'abcdef1234', chapter: 11, src: 'fixture', where: 'running' }];
  const on = keys(L.evaluate(snap({ gateFlag: false, chains: [ch11], queueChapters: q })));
  assert.deepEqual(on, ['gate_chain:g', 'gate_queue:abcdef1234']);
  assert.deepEqual(keys(L.evaluate(snap({ gateFlag: true, chains: [ch11], queueChapters: q }))), []);
  const ok10 = view({ name: 'h', alive: [3], plan: [{ chapter: '第10章', ch: 10, ids: [1], tag: 'ch10' }], last: 'x' });
  assert.deepEqual(keys(L.evaluate(snap({ gateFlag: false, chains: [ok10], queueChapters: [{ prompt_id: 'p', chapter: 10, src: 'f' }] }))), []);
  const prep = view({ name: 'p', logExists: false, scriptMtimeMs: NOW - 3600000, plan: [{ chapter: '第20章', ch: 20, ids: [1], tag: 'ch20' }] });
  const f = L.evaluate(snap({ gateFlag: false, chains: [prep] })); assert.equal(f[0].level, 'WARN');
  assert.deepEqual(keys(L.evaluate(snap({ gateFlag: false, chains: [{ ...prep, scriptMtimeMs: NOW - 5 * 3600000 }] }))), [], '很久以前准备的不报');
});

test('看门狗不杀、不取消、不 POST、不建删 STOP（静态检查源码）', () => {
  const src = fs.readFileSync(WDJS, 'utf8') + fs.readFileSync(path.join(ROOT, 'scripts', 'command-watchdog-lib.mjs'), 'utf8');
  for (const bad of [/Stop-Process/i, /taskkill/i, /method:\s*'POST'/i, /\/interrupt/, /\/api\/queue\/cancel/i, /unlinkSync|rmSync|\.rm\(/, /STOP['"]?\s*,\s*['"]w/]) assert.ok(!bad.test(src), String(bad));
  assert.equal((src.match(/process\.kill\(/g) || []).length, 1, '只有 process.kill(pid, 0) 探活');
  assert.match(src, /process\.kill\(old, 0\)/);
});

test('检查7：链挂在会话下面 → WARN；父进程是 WmiPrvSE → 不报', () => {
  const t = '2026-11-23T18:00:00Z';
  const procs = [{ pid: 1, ppid: 0, name: 'claude.exe', created: t, cmd: 'claude' }, { pid: 2, ppid: 1, name: 'cmd.exe', created: t, cmd: 'cmd /c x' }, { pid: 3, ppid: 2, name: 'python.exe', created: t, cmd: 'python gpu_k_chain.py' },
    { pid: 4, ppid: 0, name: 'WmiPrvSE.exe', created: t }, { pid: 5, ppid: 4, name: 'cmd.exe', created: t, cmd: 'cmd /c y' }, { pid: 6, ppid: 5, name: 'python.exe', created: t, cmd: 'python gpu_j_chain.py' }];
  const k = view({ name: 'k', alive: [3], last: 'x' }); const j = view({ name: 'j', alive: [6], last: 'x' });
  const f = L.evaluate(snap({ chains: [k, j], procs }));
  assert.deepEqual(f.map((a) => [a.key, a.level]), [['chain_under_session:k:3', 'WARN']]);
  assert.match(f[0].text, /claude\.exe\(1\)/);
});

test('去重：同一状态 3 轮只推 1 次；内容变化推 1 次；解决推 1 次；重启后（状态存盘）不重复', () => {
  const st = {}; const A = [{ key: 'chain_gone:x', level: 'ERROR', check: 2, title: 't', text: 'a', sig: 's1' }];
  const ev = []; for (let i = 0; i < 3; i++) ev.push(...L.diffAlerts(st, A, 't' + i));
  assert.deepEqual(ev.map((e) => e.type), ['new']);
  const reloaded = JSON.parse(JSON.stringify(st)); // 模拟看门狗重启：state.json 读回
  assert.deepEqual(L.diffAlerts(reloaded, A, 't3').map((e) => e.type), []);
  assert.deepEqual(L.diffAlerts(reloaded, [{ ...A[0], sig: 's2', text: 'b' }], 't4').map((e) => e.type), ['changed']);
  const r = []; for (let i = 0; i < 4; i++) r.push(...L.diffAlerts(reloaded, [], 'u' + i));
  assert.deepEqual(r.map((e) => e.type), ['resolved']);
});

// ---------- 集成：主循环 --once（假 8189、fixture 目录、fixture 进程表） ----------
function fakeQueue(body) { return new Promise((res) => { const s = http.createServer((req, rsp) => { if (req.method !== 'GET' || req.url !== '/queue') { s.bad = (s.bad || 0) + 1; rsp.writeHead(404); return rsp.end(); } s.hits = (s.hits || 0) + 1; rsp.writeHead(200, { 'content-type': 'application/json' }); rsp.end(JSON.stringify(body)); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
function runOnce(env) { return new Promise((res) => { const p = spawn(process.execPath, [WDJS, '--once'], { env: { ...process.env, IC_CONFIG: ':9', ...env } }); let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('exit', (code) => res({ code, o, e })); }); }

test('集成回放：今晚交接断（真 rr1845 脚本副本，md5 在白名单）→ 报警 + dry 恢复命令；第二轮不重复', async (t) => {
  const Mx = path.join(FX, 'M'); const Ux = path.join(Mx, '_'); const Gx = path.join(Mx, 'G'); const WDx = path.join(FX, 'wd');
  for (const d of [Ux, path.join(Gx, 'rr678_chain_20261123'), path.join(Gx, 'rr678_ch6_20261123'), path.join(Gx, 'rr1845_chain_20261123'), WDx]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(REAL_U, 'gpu_rr1845_chain.py'), path.join(Ux, 'gpu_rr1845_chain.py'));
  fs.copyFileSync(path.join(REAL_U, 'gpu_rr678_chain.py'), path.join(Ux, 'gpu_rr678_chain.py'));
  fs.writeFileSync(path.join(Gx, 'rr678_chain_20261123', 'chain.log'), '2026-11-23T18:30:00 rr678 chain start (no upstream wait) pid 1\n2026-11-23T18:50:45 第6章 chapter done {3: \'done\'}\n2026-11-23T18:50:45 summary []\n2026-11-23T18:50:45 rr678 done\n');
  fs.writeFileSync(path.join(Gx, 'rr678_ch6_20261123', 'progress.json'), JSON.stringify({ status: 'done', shots: [3, 5, 6, 9, 10, 12].map((k) => ({ '镜序': k, status: 'done_not_selected' })) }));
  fs.writeFileSync(path.join(Gx, 'rr1845_chain_20261123', 'chain.log'), '2026-11-23T18:48:00 rr1845 chain start (armed wait for rr678; pid from process list only) pid 777\n2026-11-23T18:48:05 waiting for rr678 pid [41000] to exit; last line: x\n');
  const procsF = path.join(FX, 'procs.json'); fs.writeFileSync(procsF, JSON.stringify([{ pid: 4, ppid: 0, name: 'WmiPrvSE.exe' }]));
  fs.writeFileSync(path.join(WDx, 'watchdog-config.json'), JSON.stringify({ gateFlag: path.join(FX, 'EP1_10_DONE.flag'), deadlines: [], sessionOutputs: { roots: [path.join(FX, 'none')] }, recovery: CFG.recovery }));
  fs.writeFileSync(path.join(WDx, 'state.json'), JSON.stringify({ alerts: {}, recoveries: [], round: 0, gpuEmptySince: Date.now() - 370000, dryLast: {} }));
  const q = await fakeQueue({ queue_running: [], queue_pending: [] }); t.after(() => { q.closeAllConnections(); q.close(); });
  const env = { WD_M: Mx, WD_G: Gx, WD_DIR: WDx, WD_CF: `http://127.0.0.1:${q.address().port}`, WD_IC: "http://127.0.0.1:9", WD_PROCS_FILE: procsF };
  const r1 = await runOnce(env); assert.equal(r1.code, 0, r1.e);
  const out1 = JSON.parse(r1.o);
  const k1 = out1.events.map((e) => e.key);
  assert.ok(k1.includes('handoff_broken:rr1845'), k1.join(',')); assert.ok(k1.includes('gpu_stall'));
  assert.ok(k1.includes('recovery:rr1845'));
  const rec = fs.readFileSync(path.join(WDx, 'recoveries.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(rec.length, 1); assert.equal(rec[0].ok, true); assert.equal(rec[0].live, false); assert.equal(rec[0].mode, 'dry');
  assert.ok(rec[0].cmd.includes(`cd /d ${Ux} && "C:\\Python315\\python.exe" -X utf8 -u gpu_rr1845_chain.py --after=none 1> `), rec[0].cmd);
  console.log('  集成 dry 命令：', rec[0].cmd);
  const hb = JSON.parse(fs.readFileSync(path.join(WDx, 'heartbeat.json'), 'utf8')); assert.equal(hb.round, 1); assert.ok(hb.alerts >= 2);
  assert.match(fs.readFileSync(path.join(WDx, '当前告警.md'), 'utf8'), /链交接断了：rr678 已出完，rr1845 没在跑/);
  const r2 = await runOnce(env); assert.equal(r2.code, 0, r2.e);
  assert.deepEqual(JSON.parse(r2.o).events, [], '第二轮同状态：不重复推，也不重复记 dry');
  assert.equal(fs.readFileSync(path.join(WDx, 'recoveries.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(path.join(WDx, 'alerts.jsonl'), 'utf8').trim().split('\n').length, k1.length);
  // STOP 标记存在 → 不满足（看门狗只读它）
  fs.writeFileSync(path.join(Ux, 'rr1845.STOP'), '');
  const r3 = await runOnce(env); const rec3 = fs.readFileSync(path.join(WDx, 'recoveries.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(rec3.at(-1).ok, false); assert.ok(rec3.at(-1).reasons.some((x) => /STOP/.test(x)));
  assert.ok(fs.existsSync(path.join(Ux, 'rr1845.STOP')), '看门狗没删 STOP');
  assert.equal(q.bad || 0, 0, '只有 GET /queue'); assert.ok(q.hits >= 3);
  q.closeAllConnections(); q.close();
});

test('集成：第11章镜头在队列里（按在跑链 progress 对上）→ gate_queue；flag 存在 → 不报', async (t) => {
  const Mx = path.join(FX, 'M2'); const Ux = path.join(Mx, '_'); const Gx = path.join(Mx, 'G'); const WDx = path.join(FX, 'wd2');
  for (const d of [Ux, path.join(Gx, 'rr9_chain_20261123'), path.join(Gx, 'rr9_ch11_20261123'), WDx]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(Ux, 'gpu_rr9_chain.py'), "PLAN=[('第11章',[13],'ch11')]\nSTOPF=os.path.join(U,'rr9.STOP')\nLOGD=os.path.join(U,'rr9_dryrun') if DRY else os.path.join(G,'rr9_chain_20261123')\no=os.path.join(G,'rr9_%s_20261123'%tag)\n");
  fs.writeFileSync(path.join(Gx, 'rr9_chain_20261123', 'chain.log'), '2026-11-23T19:00:00 submitted 第11章 13 x y\n');
  fs.writeFileSync(path.join(Gx, 'rr9_ch11_20261123', 'progress.json'), JSON.stringify({ status: 'running', shots: [{ '镜序': 13, status: 'running' }] }));
  const procsF = path.join(FX, 'procs2.json'); fs.writeFileSync(procsF, JSON.stringify([{ pid: 4, ppid: 0, name: 'WmiPrvSE.exe' }, { pid: 50, ppid: 4, name: 'python.exe', cmd: 'python -u gpu_rr9_chain.py --after=none', created: new Date().toISOString() }]));
  const flag = path.join(FX, 'EP1_10_DONE.flag');
  fs.writeFileSync(path.join(WDx, 'watchdog-config.json'), JSON.stringify({ gateFlag: flag, deadlines: [], sessionOutputs: { roots: [path.join(FX, 'none')] } }));
  const q = await fakeQueue({ queue_running: [[1, 'prompt-ch11-0001', { 9: { inputs: { filename_prefix: 'video/51ed8141_shot13_0417ba' } } }, {}, ['9']]], queue_pending: [] }); t.after(() => { q.closeAllConnections(); q.close(); });
  const env = { WD_M: Mx, WD_G: Gx, WD_DIR: WDx, WD_CF: `http://127.0.0.1:${q.address().port}`, WD_IC: "http://127.0.0.1:9", WD_PROCS_FILE: procsF };
  const r = JSON.parse((await runOnce(env)).o); const k = r.events.map((e) => e.key).sort();
  assert.deepEqual(k, ['gate_chain:rr9', 'gate_queue:prompt-ch11-0001']);
  assert.match(r.events.find((e) => e.key.startsWith('gate_queue')).text, /progress（第11章#13）/);
  fs.writeFileSync(flag, 'done');
  for (let i = 0; i < 3; i++) await runOnce(env);
  const cur = JSON.parse(fs.readFileSync(path.join(WDx, 'current_alerts.json'), 'utf8'));
  assert.deepEqual(Object.keys(cur.alerts).filter((x) => x.startsWith('gate')), [], 'flag 存在后闸门告警解决');
  assert.ok(fs.readFileSync(path.join(WDx, 'alerts.jsonl'), 'utf8').includes('"type":"resolved"'));
  q.closeAllConnections(); q.close();
});

test('守卫：IC_CONFIG=:9 时连 8189 / 8188 直接拒绝', () => {
  for (const port of [8189, 8188]) {
    const r = spawnSync(process.execPath, [WDJS, '--once'], { env: { ...process.env, IC_CONFIG: ':9', WD_DIR: path.join(FX, 'guard'), WD_CF: `http://127.0.0.1:${port}` }, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /禁止连接 8188/);
  }
});

test('心跳过期变红：>25 秒 → stopped「看门狗停了」；新鲜 → ok；有 ERROR → error', async () => {
  const WDx = path.join(FX, 'wd_hb'); fs.mkdirSync(WDx, { recursive: true });
  process.env.CMD_WATCHDOG_DIR = WDx; process.env.CMD_CHAT_ROOT = path.join(FX, 'chat');
  const api = await import('../scripts/command-watchdog-api.mjs');
  const hb = (sec) => fs.writeFileSync(path.join(WDx, 'heartbeat.json'), JSON.stringify({ at: new Date(Date.now() - sec * 1000).toISOString(), pid: 1, round: 5, ms: 30 }));
  fs.writeFileSync(path.join(WDx, 'current_alerts.json'), JSON.stringify({ alerts: {} }));
  hb(3); let v = api.watchdogView(); assert.equal(v.stale, false); assert.equal(v.status, 'ok');
  hb(26); v = api.watchdogView(); assert.equal(v.stale, true); assert.equal(v.status, 'stopped'); assert.match(v.statusText, /看门狗停了/);
  hb(3); fs.writeFileSync(path.join(WDx, 'current_alerts.json'), JSON.stringify({ alerts: { 'gpu_idle': { level: 'ERROR', title: 't', text: 'x' } } }));
  v = api.watchdogView(); assert.equal(v.status, 'error');
  fs.renameSync(path.join(WDx, 'heartbeat.json'), path.join(WDx, 'heartbeat.moved')); v = api.watchdogView(); assert.equal(v.status, 'stopped');
});

// ---------- 第二轮（20:20）：GPU 空闲 + 页脚 ----------
test('第二轮：GPU 空闲 ≥60 秒 WARN、≥180 秒 ERROR；列近 3 小时 prepared 链，老的只计数；闸门文案', () => {
  const rr1925 = view({ name: 'rr1925', last: '2026-11-23T19:49:23 rr1925 done', shots: { unsubmitted: [], uncertain: [] } });
  const fresh = view({ name: 'rr1955', logExists: false, scriptMtimeMs: NOW - 20 * 60000, plan: [{ chapter: '第3章', ch: 3, ids: [1, 2], tag: 'ch3' }], shots: { unsubmitted: ['第3章#1', '第3章#2'], uncertain: [] } });
  const old = view({ name: 'rr1550', logExists: false, scriptMtimeMs: NOW - 5 * 3600000, plan: [{ chapter: '第22章', ch: 22, ids: [1], tag: 'ch22' }], shots: { unsubmitted: ['x'], uncertain: [] } });
  const ev = (sec, o = {}) => L.evaluate(snap({ idle: { sinceMs: NOW - sec * 1000 }, allChains: [rr1925, fresh, old], chains: [rr1925], gateFlag: false, ...o })).filter((a) => a.key === 'gpu_idle');
  assert.deepEqual(ev(30), []);
  const w = ev(70); assert.equal(w[0].level, 'WARN');
  const e = ev(27 * 60); assert.equal(e[0].level, 'ERROR');
  assert.match(e[0].text, /上一条链 rr1925 在 19:49:23 出完/); assert.match(e[0].text, /rr1955（脚本 .* 改，待出 2 镜）/);
  assert.ok(!/rr1550/.test(e[0].text)); assert.match(e[0].text, /更早准备的链 1 条/);
  assert.match(e[0].text, /若是闸门要求的空闲，请主会话确认/);
  assert.notEqual(w[0].sig, e[0].sig, 'WARN→ERROR 签名变 → 推一次'); assert.equal(ev(28 * 60)[0].sig, e[0].sig, '同为 ERROR 分钟数变不推');
  assert.deepEqual(L.evaluate(snap({ idle: { sinceMs: null } })).filter((a) => a.key === 'gpu_idle'), [], '有链/队列在跑 → 不报');
  // 去重：WARN 出现 1 次、→ERROR 1 次、恢复 1 次（文案「已恢复」）
  const st = {}; const types = [];
  for (const s of [70, 80, 200, 210, 220]) types.push(...L.diffAlerts(st, ev(s), 't' + s).map((x) => x.type));
  for (let i = 0; i < 3; i++) types.push(...L.diffAlerts(st, [], new Date(NOW + i * 10000).toISOString()).map((x) => { assert.match(L.eventText(x), /已恢复/); return x.type; }));
  assert.deepEqual(types, ['new', 'changed', 'resolved']);
});

test('第二轮：页脚如实写自动拉链模式和白名单', () => {
  const m = new Map([['rr1845', { state: 'done' }], ['rr2000', { state: 'dead' }]]);
  const wl = (w, mode = 'live') => L.recoveryFooter({ recovery: { mode, whitelist: w } }, m);
  assert.match(wl([{ script: 'gpu_rr1845_chain.py', md5: '0dab8b2399c4', live: true }]), /^自动拉链：已上线但白名单无可拉的链。白名单：rr1845（md5 0DAB8B23，已完成）/);
  assert.match(wl([]), /已上线但白名单无可拉的链。白名单：空/);
  assert.match(wl([{ script: 'gpu_rr2000_chain.py', md5: 'abcdef1234', live: true }]), /^自动拉链：已上线（live）/);
  assert.match(wl([{ script: 'gpu_rr2000_chain.py', md5: 'abcdef1234', live: true }], 'dry'), /^自动拉链：dry/);
  assert.ok(!/只看不动：不提交/.test(wl([])) || /除此之外看门狗只看不动/.test(wl([])));
});

test('第二轮集成回放：19:49:23 rr1925 done → 20:16 前 GPU 空 27 分钟、rr1955 已准备未起 → gpu_idle ERROR；页脚如实', async (t) => {
  const Mx = path.join(FX, 'M3'); const Ux = path.join(Mx, '_'); const Gx = path.join(Mx, 'G'); const WDx = path.join(FX, 'wd3');
  for (const d of [Ux, path.join(Gx, 'rr1925_chain_20261123'), path.join(Gx, 'rr1925_ch2_20261123'), WDx]) fs.mkdirSync(d, { recursive: true });
  const scr = (n, ch) => `PLAN=[('第${ch}章',[1, 2, 3],'ch${ch}')]\nSTOPF=os.path.join(U,'${n}.STOP')\nLOGD=os.path.join(U,'${n}_dryrun') if DRY else os.path.join(G,'${n}_chain_20261123')\no=os.path.join(G,'${n}_%s_20261123'%tag)\n`;
  fs.writeFileSync(path.join(Ux, 'gpu_rr1925_chain.py'), scr('rr1925', 2)); fs.writeFileSync(path.join(Ux, 'gpu_rr1955_chain.py'), scr('rr1955', 3));
  fs.writeFileSync(path.join(Gx, 'rr1925_chain_20261123', 'chain.log'), '2026-11-23T19:20:00 rr1925 chain start (no upstream wait) pid 1\n2026-11-23T19:49:23 rr1925 done\n');
  fs.writeFileSync(path.join(Gx, 'rr1925_ch2_20261123', 'progress.json'), JSON.stringify({ status: 'done', shots: [1, 2, 3].map((k) => ({ '镜序': k, status: 'done_not_selected' })) }));
  const procsF = path.join(FX, 'procs3.json'); fs.writeFileSync(procsF, JSON.stringify([{ pid: 4, ppid: 0, name: 'WmiPrvSE.exe' }]));
  fs.writeFileSync(path.join(WDx, 'watchdog-config.json'), JSON.stringify({ gateFlag: path.join(FX, 'EP1_10_DONE.flag.none'), deadlines: [], sessionOutputs: { roots: [path.join(FX, 'none')] }, recovery: { mode: 'live', whitelist: [{ script: 'gpu_rr1845_chain.py', md5: '0DAB8B2399C4BF0A48CBF92670E45A7F', live: true }] } }));
  fs.writeFileSync(path.join(WDx, 'state.json'), JSON.stringify({ alerts: {}, recoveries: [], round: 0, gpuEmptySince: Date.now() - 27 * 60000, idleSince: Date.now() - 27 * 60000, dryLast: {} }));
  const q = await fakeQueue({ queue_running: [], queue_pending: [] }); t.after(() => { q.closeAllConnections(); q.close(); });
  const env = { WD_M: Mx, WD_G: Gx, WD_DIR: WDx, WD_CF: `http://127.0.0.1:${q.address().port}`, WD_IC: 'http://127.0.0.1:9', WD_PROCS_FILE: procsF };
  const r = await runOnce(env); assert.equal(r.code, 0, r.e);
  const ev = JSON.parse(r.o).events.find((e) => e.key === 'gpu_idle');
  assert.ok(ev, r.o.slice(0, 500)); assert.equal(ev.level, 'ERROR');
  assert.match(ev.text, /rr1925 在 19:49:23 出完/); assert.match(ev.text, /rr1955（脚本 .* 改，待出 3 镜）/);
  const md = fs.readFileSync(path.join(WDx, '当前告警.md'), 'utf8');
  assert.match(md, /自动拉链：已上线但白名单无可拉的链。白名单：rr1845（md5 0DAB8B23，找不到脚本）/);
  console.log('  回放告警：', ev.text);
  // 链起来了（进程活着）→ 3 轮后「已恢复」
  fs.writeFileSync(procsF, JSON.stringify([{ pid: 4, ppid: 0, name: 'WmiPrvSE.exe' }, { pid: 70, ppid: 4, name: 'python.exe', cmd: 'python -u gpu_rr1955_chain.py --after=none', created: new Date().toISOString() }]));
  for (let i = 0; i < 3; i++) await runOnce(env);
  assert.match(fs.readFileSync(path.join(WDx, 'alerts.jsonl'), 'utf8'), /已恢复】GPU 又开始出片了/);
  assert.equal(q.bad || 0, 0);
});

test('连接拦截生效：测试进程连 8189/8188 直接抛错', async () => {
  for (const port of [8189, 8188]) {
    assert.throws(() => net.connect(port, '127.0.0.1'), /测试禁止连接/);
    const err = await new Promise((res) => { try { const r = http.get(`http://127.0.0.1:${port}/queue`, () => res(null)); r.on('error', res); } catch (e) { res(e); } });
    assert.match(String(err && err.message), /测试禁止连接/);
  }
});

// ---------- 第三轮（20:40）：外部 PATCH 写稿 + 作废链标注 ----------
test('第三轮：外部 PATCH 告警（列章/镜号/shot_id/时间/字段，按 id 去重）+ changedFields', () => {
  assert.deepEqual(L.changedFields('{"a":1,"visual":"x","updated_at":1}', '{"a":1,"visual":"y","updated_at":2,"dialogue":"d"}'), ['visual', 'dialogue']);
  const rows = [{ id: 'c1', ts: NOW - 60000, ch: '第6章', idx: 10, shot: 'c465fcc3-aaaa', fields: ['visual', 'dialogue'] }];
  const f = L.evaluate(snap({ extPatches: [{ group: 'b1', rows }] }));
  assert.equal(f.length, 1); assert.equal(f[0].key, 'ext_patch_content'); assert.equal(f[0].level, 'ERROR');
  assert.match(f[0].text, /第6章#10 改了画面描述、台词（\d\d:\d\d）/); assert.match(f[0].text, /只能走 IC/);
  assert.match(f[0].text, /^\d\d-\d\d \d\d:\d\d/, '带日期时间');
  const f2 = L.evaluate(snap({ extPatches: [{ group: 'b1', rows: [...rows, { id: 'c2', ts: NOW, ch: '第6章', idx: 6, shot: 'ed266bb2', fields: ['sub_shots'] }] }] }));
  assert.notEqual(f2[0].sig, f[0].sig, '同批新增一条 → 变化推一次');
  assert.equal(L.evaluate(snap({ extPatches: [{ group: 'b1', rows: [...rows] }] }))[0].sig, f[0].sig, '同样的 id 集合 → 不重复推');
});

test('2026-11-25：只改绑定的 PATCH 合成一条「信息」，不推聊天；改台词的仍是严重；过点超 12 小时的截止不再报', () => {
  const b = (id, idx, ch = '第41章') => ({ id, ts: NOW - 30000, ch, idx, shot: 'shot-' + id, fields: ['character_ids', 'costume_ids'] });
  const f = L.evaluate(snap({ extPatches: [{ group: 'g1', rows: [b('a', 1), b('b', 2)] }, { group: 'g2', rows: [b('c', 3, '第43章')] }, { group: 'g3', rows: [{ id: 'd', ts: NOW, ch: '第30章', idx: 1, shot: 'shot-d', fields: ['dialogue'] }] }] }));
  const bind = f.find((x) => x.key === 'ext_bind'); const cont = f.find((x) => x.key === 'ext_patch_content');
  assert.equal(bind.level, 'INFO'); assert.match(bind.title, /补了 3 镜的绑定/); assert.match(bind.text, /第41章 2 镜、第43章 1 镜/); assert.match(bind.text, /人物绑定、服装绑定/);
  assert.equal(cont.level, 'ERROR'); assert.match(cont.text, /第30章#1 改了台词/);
  assert.equal(L.quietEvent({ key: 'ext_bind' }), true); assert.equal(L.quietEvent({ key: 'ext_patch_content' }), false);
  const old = new Date(NOW - 13 * 3600000).toISOString();
  assert.equal(L.evaluate(snap({ deadlines: [{ id: 'x', name: '旧事', at: old, done: false }] })).filter((x) => x.key.startsWith('deadline')).length, 0);
});

test('第三轮：gpu_idle / 闸门告警把作废链标「已作废（外部稿），不应起」', () => {
  const v = view({ name: 'rr2010b2', logExists: false, scriptMtimeMs: NOW - 30 * 60000, plan: [{ chapter: '第20章', ch: 20, ids: [1], tag: 'ch20' }], shots: { unsubmitted: ['第20章#1'], uncertain: [] } });
  const voids = new Map([['rr2010b2', 'seq61：第20/21章 22 镜现稿来自外部会话 PATCH，作废']]);
  const f = L.evaluate(snap({ idle: { sinceMs: NOW - 400000 }, allChains: [v], chains: [v], gateFlag: false, voidChains: voids }));
  const idle = f.find((a) => a.key === 'gpu_idle'); assert.match(idle.text, /rr2010b2（.*已作废（外部稿），不应起.*seq61/); assert.match(idle.text, /这些都已作废，没有可起的链/);
  const gate = f.find((a) => a.key === 'gate_chain:rr2010b2'); assert.match(gate.title, /已作废/); assert.match(gate.text, /已作废（外部稿），不应起/);
  const g2 = L.evaluate(snap({ idle: { sinceMs: NOW - 400000 }, allChains: [v], chains: [v], gateFlag: false })).find((a) => a.key === 'gpu_idle');
  assert.ok(!/已作废/.test(g2.text), '不在作废名单就不标');
});

test('第三轮集成：只读 fixture ic.db；首轮只定起点，之后新 PATCH 报一次、重复不推、非 PATCH 不报；作废说明.txt 生效；页脚 dry', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const Mx = path.join(FX, 'M4'); const Ux = path.join(Mx, '_'); const Gx = path.join(Mx, 'G'); const WDx = path.join(FX, 'wd4'); const VD = path.join(FX, 'void'); const dbF = path.join(FX, 'ic_fixture.db');
  for (const d of [Ux, Gx, WDx, path.join(VD, 'rr2010b2')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(VD, 'rr2010b2', '作废说明.txt'), 'seq61：外部会话 PATCH 稿，按铁律作废；本链不起。\n');
  const w = new DatabaseSync(dbF); w.exec("create table change_logs (id text primary key, project_id text, batch_id text default '', ts integer, source text, entity text, entity_id text, action text, before text, after text, revert_of text default '', reverted_by text default '', meta text default '{}')");
  const ins = (id, ts, src, batch, idx) => w.prepare('insert into change_logs (id,project_id,batch_id,ts,source,entity,entity_id,action,before,after) values (?,?,?,?,?,?,?,?,?,?)').run(id, 'p', batch, ts, src, 'shot', 'shot-' + id, 'update', JSON.stringify({ chapter: '第6章', idx, visual: 'a' }), JSON.stringify({ chapter: '第6章', idx, visual: 'b', updated_at: 1 }));
  ins('old', Date.now() - 3600000, 'PATCH /api/projects/:id/shots/:sid', 'b0', 1);
  fs.writeFileSync(path.join(WDx, 'watchdog-config.json'), JSON.stringify({ patchCheckEverySec: 0, voidChains: [], voidNoteDirs: [VD], gateFlag: path.join(FX, 'noflag'), deadlines: [], sessionOutputs: { roots: [path.join(FX, 'none')] }, recovery: { mode: 'dry', whitelist: [] } }));
  const procsF = path.join(FX, 'procs4.json'); fs.writeFileSync(procsF, JSON.stringify([{ pid: 4, ppid: 0, name: 'WmiPrvSE.exe' }]));
  const q = await fakeQueue({ queue_running: [], queue_pending: [] }); t.after(() => { q.closeAllConnections(); q.close(); try { w.close(); } catch {} });
  const env = { WD_M: Mx, WD_G: Gx, WD_DIR: WDx, WD_CF: `http://127.0.0.1:${q.address().port}`, WD_IC: 'http://127.0.0.1:9', WD_PROCS_FILE: procsF, WD_ICDB: dbF };
  const evs = async () => JSON.parse((await runOnce(env)).o).events.filter((e) => e.key.startsWith('ext_patch'));
  assert.deepEqual(await evs(), [], '首轮只定起点，不翻旧账（old 那条不报）');
  ins('n1', Date.now() + 1000, 'PATCH /api/projects/:id/shots/:sid', 'b1', 10);
  ins('x1', Date.now() + 1000, 'POST /api/projects/:id/shots', 'b1', 11);
  const e1 = await evs(); assert.equal(e1.length, 1); assert.equal(e1[0].type, 'new'); assert.match(e1[0].text, /第6章#10 改了画面描述/); assert.ok(!/#11/.test(e1[0].text), '非 PATCH 不算');
  assert.deepEqual(await evs(), [], '同一条不重复推');
  ins('n2', Date.now() + 2000, 'PATCH /api/projects/:id/shots/:sid', 'b1', 12);
  const e2 = await evs(); assert.equal(e2.length, 1); assert.equal(e2[0].type, 'changed'); assert.match(e2[0].title, /有 2 镜/); assert.match(e2[0].text, /第6章#12/);
  const md = fs.readFileSync(path.join(WDx, '当前告警.md'), 'utf8');
  assert.match(md, /台词\/画面\/提示词被直接改了/); assert.match(md, /^自动拉链：dry（只记录「将会执行的命令」，不起链）。白名单：空/m);
  const st = JSON.parse(fs.readFileSync(path.join(WDx, 'state.json'), 'utf8')); assert.deepEqual(Object.keys(st.patch.seen).sort(), ['n1', 'n2']);
  assert.equal(w.prepare('select count(*) n from change_logs').get().n, 4, '看门狗没写库');
});

test('第三轮：同签名时标题和正文都刷新（分钟数），但不推送', () => {
  const st = {}; L.diffAlerts(st, [{ key: 'gpu_idle', level: 'ERROR', title: 'GPU 空闲 3 分钟', text: 'a', sig: 's' }], new Date(NOW).toISOString());
  const ev = L.diffAlerts(st, [{ key: 'gpu_idle', level: 'ERROR', title: 'GPU 空闲 21 分钟', text: 'b', sig: 's' }], new Date(NOW + 1000).toISOString());
  assert.deepEqual(ev, []); assert.equal(st.alerts.gpu_idle.title, 'GPU 空闲 21 分钟'); assert.equal(st.alerts.gpu_idle.text, 'b');
});

test('2026-11-25（Andy：红色要重视，这种不是问题）：改台词后紧接着交了 IC 重写的降成信息、不推聊天；没交 IC 的仍是严重', () => {
  const r = (id, idx, ic) => ({ id, ts: NOW - 20000, ch: '第30章', idx, shot: 'shot-' + id, fields: ['dialogue'], ...(ic ? { ic, icJob: 'fc5e0521-4c31-4440-8ef9-22d08ac2e496' } : {}) });
  const f = L.evaluate(snap({ extPatches: [{ group: 'g', rows: [r('a', 1, 'rewritten'), r('b', 3, 'queued'), r('c', 4)] }] }));
  const ic = f.find((x) => x.key === 'ext_patch_ic'); const cont = f.find((x) => x.key === 'ext_patch_content');
  assert.equal(ic.level, 'WARN', '黄色提醒（主会话 seq1750）'); assert.match(ic.title, /2 镜被直接改了稿，随后交了 IC 重写/); assert.match(ic.text, /1 条 IC 还在排队写/);
  assert.match(ic.text, /第30章#1 改了台词/); assert.match(ic.text, /第30章#3 改了台词/); assert.match(ic.text, /IC 写稿任务：fc5e0521/);
  assert.ok(L.quietEvent({ key: 'ext_patch_ic', type: 'new' }), '走了 IC 的不推聊天');
  assert.equal(cont.level, 'ERROR'); assert.match(cont.title, /有 1 镜/); assert.match(cont.text, /第30章#4 改了台词/); assert.doesNotMatch(cont.text, /第30章#1 /);
  const all = L.evaluate(snap({ extPatches: [{ group: 'g', rows: [r('a', 1, 'rewritten')] }] }));
  assert.ok(!all.some((x) => x.level === 'ERROR'), '全部走了 IC → 没有红色');
});
