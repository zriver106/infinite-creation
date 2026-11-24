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
  assert.ok(keys(L.evaluate(snap({ chains: [c], gpuEmptySinceMs: NOW - 70000 }))).includes('gpu_idle'));
  assert.ok(!keys(L.evaluate(snap({ chains: [c], gpuEmptySinceMs: NOW - 30000 }))).includes('gpu_idle'));
  assert.ok(!keys(L.evaluate(snap({ chains: [view({ name: 'b', last: 'b stopped (stop marker)', shots: { unsubmitted: ['x'], uncertain: [] } })], gpuEmptySinceMs: NOW - 900000 }))).includes('gpu_idle'), '人为停下的链不算');
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
  assert.ok(k.includes('handoff_broken:rr1845')); assert.ok(k.includes('gpu_idle')); assert.ok(!k.includes('chain_gone:rr1845'), '交接断取代进程没了');
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
  assert.ok(k1.includes('handoff_broken:rr1845'), k1.join(',')); assert.ok(k1.includes('gpu_idle'));
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
