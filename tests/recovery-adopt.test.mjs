// ic25 重启恢复接管单测：临时数据目录 + 临时配置；真起子进程模拟「外部 Agent 仍在运行」（命令行带 agent-workspaces/<jobId>），
// 用真实进程表（Windows: Get-CimInstance；Linux: ps）判活、判 pid 复用。startRun / autoChain / deliver 全部注入假函数，
// 不起真任务、不调真 CLI、不碰 ComfyUI、不碰真实 data/ic.db。子进程只杀本测试自己起的。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ra-'));
let core;
let rr;
let ra;
let plan;
const children = [];

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, agent: { runtime: 'openclaude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  for (const k of ['IC_DISABLE_RECOVERY_ADOPT', 'IC_DISABLE_RECOVERY_CONTROL', 'IC_DISABLE_RECOVERY_CHECKPOINT']) delete process.env[k];
  core = await import('../lib/core/index.js');
  rr = await import('../lib/agent/restart-recovery.js');
  ra = await import('../lib/agent/recovery-adopt.js');
  plan = await import('../lib/agent/chapter-guardian-plan.js');
});

after(() => { for (const c of children) { try { c.kill(); } catch { /* noop */ } } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个「外部 Agent」：命令行里带 <tmp>/agent-workspaces/<jobId>/claude-mcp.json，和 claude.exe 的 --mcp-config 同形。 */
async function fakeAgent(jobId) {
  const cfg = path.join(tmp, 'agent-workspaces', jobId, 'claude-mcp.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, '{}');
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', cfg], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  await sleep(400);
  return c;
}
async function stopAgent(c) {
  const done = new Promise((r) => c.once('exit', r));
  c.kill();
  await done;
  await sleep(200);
}

function makeChapter({ name, title = '第1章', n = 2, rendered = false, exported = false }) {
  const { Projects, Chapters, Shots, projectDir, slugify } = core;
  const p = Projects.create({ name, auto_script: false });
  for (const t of [title, '第2章']) if (!Chapters.list(p.id).some((c) => c.title === t)) Chapters.create(p.id, { title: t, script: 's' });
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const s = Shots.create(p.id, { chapter: title, idx: i, visual: 'v' + i, video_prompt: 'p' + i, mode: 'text' });
    if (rendered || i === 1) Shots.update(s.id, { status: 'done', video_path: 'shots/' + i + '.mp4' });
    ids.push(s.id);
  }
  const exportNow = () => {
    for (const sid of ids) Shots.update(sid, { status: 'done', video_path: 'shots/' + sid + '.mp4' });
    const dir = path.join(projectDir(p.id), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, slugify(p.name) + '_' + slugify(title) + '_0123abcd.mp4'), 'fake-mp4');
  };
  if (exported) exportNow();
  return { p, title, ids, exportNow };
}

// 一个「上次进程里还在跑」的出片任务（status=running，startedAt 在过去）
function runningJob(projectId, chapter) {
  const { Jobs } = core;
  const j = Jobs.create({ projectId, type: 'create', checkpoint: { chapter, subject: chapter } });
  return Jobs.update(j.id, { startedAt: Date.now() - 120000 });
}

// 模拟一次后端启动：查进程表 → startupCleanup → 记接管（与 server.js 同顺序）
function boot() {
  const bootAt = Date.now();
  const pl = ra.planAdoptionAtBoot({ bootAt });
  core.startupCleanup({ adopt: pl.adopt });
  const adopted = ra.commitAdoption(pl, { bootAt });
  return { bootAt, pl, adopted };
}

const spy = () => {
  const calls = [];
  const fn = (args) => { calls.push(args); return { job: { id: 'NEW-' + calls.length }, deduped: false }; };
  fn.calls = calls;
  return fn;
};
function setControl(obj) {
  const f = ra.controlFile();
  if (obj === null) { try { fs.rmSync(f); } catch { /* noop */ } return; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function logLines() {
  try { return fs.readFileSync(ra.recoveryLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
}

// ———————————— 1. 接管状态 ————————————

test('startupCleanup：adopt 里的标 adopted（不写 finished_at），其余 running 照旧 interrupted；不传 adopt = 原行为', () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '清理口径' });
  const a = runningJob(p.id, title);
  const b = runningJob(p.id, '第2章');
  core.startupCleanup({ adopt: [a.id] });
  assert.equal(Jobs.get(a.id).status, 'adopted');
  assert.equal(Jobs.get(a.id).finishedAt, null);
  assert.equal(Jobs.get(b.id).status, 'interrupted');
  // 下次启动没再接管（进程退了）→ adopted 也落 interrupted，finished_at = 本次，重启恢复能按 since 接手
  const t = Date.now();
  core.startupCleanup();
  assert.equal(Jobs.get(a.id).status, 'interrupted');
  assert.ok(Jobs.get(a.id).finishedAt >= t);
  assert.ok(rr.pickInterruptedJobs(t - 1000).some((j) => j.id === a.id));
});

test('真实子进程：外部 Agent 还活着 → 启动时标 adopted、记 pid/启动时间、日志写「重启恢复正在等外部 Agent 退出」；死了的照旧 interrupted', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '接管真进程' });
  const live = runningJob(p.id, title);
  const dead = runningJob(p.id, '第2章');
  const c = await fakeAgent(live.id);
  try {
    const { pl, adopted } = boot();
    assert.ok(pl.procsAvailable, '进程表可用');
    assert.deepEqual(adopted.map((x) => x.jobId).filter((id) => id === live.id), [live.id]);
    assert.equal(Jobs.get(live.id).status, 'adopted');
    assert.equal(Jobs.get(dead.id).status, 'interrupted');
    assert.match(Jobs.get(live.id).detail, /重启恢复正在等外部 Agent 退出/);
    assert.match(Jobs.get(live.id).phase, /接管中/);
    const e = ra.getWatchEntry(live.id);
    assert.ok(e, '写了监视检查点');
    assert.equal(e.procs[0].pid, c.pid);
    assert.ok(e.procs[0].startMs > 0 && e.procs[0].cmdSig);
    assert.equal(e.boots, 1);
    assert.ok(logLines().some((l) => l.event === 'adopt' && l.jobId === live.id));
    assert.equal(ra.trackedAgentAlive(live.id), true);
  } finally {
    await stopAgent(c);
  }
  assert.equal(ra.trackedAgentAlive(live.id), false, '进程退出后判死');
});

test('adopted 算活动任务：同章去重（单章 /run 不重复提交）、清章节挡住、守护判忙「重启恢复正在等外部 Agent 退出」', async () => {
  const { Jobs, chapterClearBusyJobs } = core;
  const jr = await import('../lib/agent/job-runner.js');
  const ac = await import('../lib/agent/auto-chain.js');
  const { p, title } = makeChapter({ name: '算忙' });
  const j = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j.id] });
  assert.equal(jr.activeJobOfChapter(p.id, title).id, j.id);
  assert.equal(jr.activeJobOf(p.id).id, j.id);
  const r = ac.startSingleChapterRun({ projectId: p.id, chapter: title });
  assert.equal(r.deduped, true);
  assert.equal(r.job.id, j.id);
  assert.equal(Jobs.list(p.id).filter((x) => x.type === 'create').length, 1, '没有多建任务');
  assert.ok(chapterClearBusyJobs(p.id, title).some((x) => x.id === j.id));
  assert.equal(plan.statusClass('adopted'), 'active');
  const g = plan.planVideoGuard({
    settings: { video: { enabled: true, until: 99 }, storyboard: { enabled: false, until: 0 } },
    chapters: ['第1章', '第2章'], jobs: Jobs.list(p.id), exportedOf: () => true, shotCountOf: () => 1, chapterBusy: () => false,
  });
  assert.equal(g.action, 'skip');
  assert.equal(g.code, 'recovery-waiting');
  assert.match(g.reason, /重启恢复正在等外部 Agent 退出/);
  const gl = await import('../lib/agent/chapter-guardian.js');
  assert.match(gl.statusLine('video', { action: 'skip', code: 'recovery-waiting', reason: g.reason }), /^出片守护：正常（/);
  core.startupCleanup(); // 收尾，别影响后面的用例
});

test('取消 / 停止 = 放弃接管：落 cancelled、删检查点；恢复监视随即退出、不提交', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '放弃接管' });
  const j = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j.id] });
  ra.putWatchEntry(j.id, { projectId: p.id, chapter: title, adoptedAt: Date.now(), procs: [] });
  const startRun = spy();
  const ps = rr.startRestartRecovery({ since: Date.now(), pollMs: 20, alive: (id) => (id === j.id ? true : false), deps: { startRun, autoChain: () => assert.fail('不该续章'), deliver: async () => assert.fail() } });
  await sleep(80);
  const r = ra.releaseAdoptedJob(Jobs.get(j.id), { reason: '取消：放弃接管', source: 'cancel' });
  assert.equal(r.action, 'cancelled');
  assert.equal(Jobs.get(j.id).status, 'cancelled');
  assert.match(Jobs.get(j.id).detail, /外部 Agent 进程没有被终止/);
  assert.equal(ra.getWatchEntry(j.id), null);
  const res = (await Promise.all(ps)).find((x) => x.jobId === j.id);
  assert.equal(res.action, 'skipped');
  assert.equal(startRun.calls.length, 0);
  assert.equal(plan.statusClass(Jobs.get(j.id).status), 'failed', '守护按失败类处理，不会自动重提');
});

// ———————————— 2. 运行时开关 ————————————

test('控制文件：缺省 auto；mode / 布尔值 / 项目覆盖；坏文件按「只记录」；IC_DISABLE_RECOVERY_CONTROL=1 忽略文件', () => {
  setControl(null);
  assert.deepEqual(ra.readRecoveryControl('x'), { reportOnly: false, resume: true, chain: true, source: 'default' });
  setControl({ mode: 'no-chain' });
  assert.equal(ra.readRecoveryControl('x').chain, false);
  assert.equal(ra.readRecoveryControl('x').resume, true);
  setControl({ mode: 'auto', projects: { P1: { mode: 'report-only' } } });
  assert.equal(ra.readRecoveryControl('P1').reportOnly, true);
  assert.equal(ra.readRecoveryControl('P1').chain, false);
  assert.equal(ra.readRecoveryControl('P2').reportOnly, false);
  setControl({ resume: false });
  assert.equal(ra.readRecoveryControl('x').resume, false);
  setControl('{ 坏 json');
  assert.equal(ra.readRecoveryControl('x').reportOnly, true);
  assert.equal(ra.readRecoveryControl('x').source, 'invalid');
  setControl({ mode: 'bogus' });
  assert.equal(ra.readRecoveryControl('x').reportOnly, true, '未知 mode 也按最保守处理');
  process.env.IC_DISABLE_RECOVERY_CONTROL = '1';
  try {
    assert.equal(ra.readRecoveryControl('x').reportOnly, false);
    assert.equal(ra.chainHoldReason('x'), '');
  } finally { delete process.env.IC_DISABLE_RECOVERY_CONTROL; }
  setControl({ mode: 'no-chain' });
  assert.match(ra.chainHoldReason('x'), /暂停续章/);
  setControl(null);
  assert.equal(ra.chainHoldReason('x'), '');
});

test('运行时切换（不重启）：等待期间改成「只记录」→ 外部 Agent 退出后不记完成、不补交付、不续章、不继续，任务落 interrupted', async () => {
  const { Jobs } = core;
  setControl(null);
  const { p, title, exportNow } = makeChapter({ name: '中途切只记录' });
  const j = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j.id] });
  let probes = 0;
  const startRun = spy();
  const ps = rr.startRestartRecovery({
    since: Date.now(), pollMs: 20,
    alive: (id) => {
      if (id !== j.id) return false;
      probes++;
      if (probes === 2) setControl({ mode: 'report-only' }); // 运维在等待期间改了开关
      if (probes === 3) exportNow(); // 老进程自己把这一章做完了
      return probes < 4;
    },
    deps: { startRun, autoChain: () => assert.fail('只记录时不该续章'), deliver: async () => assert.fail('只记录时不该补交付') },
  });
  const res = (await Promise.all(ps)).find((x) => x.jobId === j.id);
  assert.equal(res.action, 'reported');
  assert.equal(res.finished, true);
  assert.equal(Jobs.get(j.id).status, 'interrupted');
  assert.match(Jobs.get(j.id).detail, /只记录/);
  assert.equal(startRun.calls.length, 0);
  // 守护看到的：上一章（已出片的第1章）最近一次出片任务不是成功 → 不续第2章
  const g = plan.planVideoGuard({
    settings: { video: { enabled: true, until: 99 }, storyboard: { enabled: false, until: 0 } },
    chapters: ['第1章', '第2章'], jobs: Jobs.list(p.id), exportedOf: (t) => t === '第1章', shotCountOf: () => 1, chapterBusy: () => false,
  });
  assert.equal(g.code, 'prev-not-ok');
  setControl(null);
});

test('运行时开关 no-chain：已出片 → 记完成 + 补交付，但不调续章；守护也暂停续章（recovery-hold）', async () => {
  const { Jobs } = core;
  setControl({ mode: 'no-chain' });
  const { p, title } = makeChapter({ name: '不续章', rendered: true, exported: true });
  const j = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j.id] });
  const delivered = [];
  const r = await rr.settleInterruptedJob(Jobs.get(j.id), { startRun: () => assert.fail(), autoChain: () => assert.fail('不该续章'), deliver: async (a) => { delivered.push(a); return { status: 'ok' }; } });
  assert.equal(r.action, 'done');
  assert.equal(r.chained, false);
  assert.equal(Jobs.get(j.id).status, 'done');
  assert.equal(delivered.length, 1);
  assert.match(Jobs.get(j.id).detail, /不触发续章/);
  const g = plan.planVideoGuard({
    settings: { video: { enabled: true, until: 99 }, storyboard: { enabled: false, until: 0 } },
    chapters: ['第1章', '第2章'], jobs: Jobs.list(p.id), exportedOf: (t) => t === '第1章', shotCountOf: () => 1, chapterBusy: () => false,
    chainHold: ra.chainHoldReason(p.id),
  });
  assert.equal(g.code, 'recovery-hold');
  // 改回 auto（不重启）→ 守护照常续
  setControl(null);
  const g2 = plan.planVideoGuard({
    settings: { video: { enabled: true, until: 99 }, storyboard: { enabled: false, until: 0 } },
    chapters: ['第1章', '第2章'], jobs: Jobs.list(p.id), exportedOf: (t) => t === '第1章', shotCountOf: () => 1, chapterBusy: () => false,
    chainHold: ra.chainHoldReason(p.id),
  });
  assert.equal(g2.action, 'submit');
  assert.equal(g2.chapter, '第2章');
});

test('运行时开关 no-resume：没出完 → 不自动「继续」，任务落 interrupted（守护判「结果不明」不重提）；改回 auto 后照常「继续」一次', async () => {
  const { Jobs } = core;
  setControl({ mode: 'no-resume' });
  const { p, title } = makeChapter({ name: '不继续' });
  const j = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j.id] });
  const startRun = spy();
  const r = await rr.settleInterruptedJob(Jobs.get(j.id), { startRun, autoChain: () => assert.fail(), deliver: async () => assert.fail() });
  assert.equal(r.action, 'held');
  assert.equal(startRun.calls.length, 0);
  assert.equal(Jobs.get(j.id).status, 'interrupted');
  // 对照：auto 下接管任务先退回 interrupted 再「继续」（否则同章去重会把它自己当成「已有任务」）
  setControl(null);
  const j2 = runningJob(p.id, title);
  core.startupCleanup({ adopt: [j2.id] });
  let seenStatus = '';
  const r2 = await rr.settleInterruptedJob(Jobs.get(j2.id), {
    startRun: (a) => { seenStatus = Jobs.get(j2.id).status; return { job: { id: 'NEW' }, deduped: false, a }; },
    autoChain: () => assert.fail(), deliver: async () => assert.fail(),
  });
  assert.equal(r2.action, 'resumed');
  assert.equal(seenStatus, 'interrupted');
});

// ———————————— 3. 监视检查点、二次重启、pid 复用 ————————————

test('pid 复用判断：同 pid 但启动时间或命令行对不上 → 不算同一个进程', async () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const c = await fakeAgent(id);
  try {
    const procs = ra.listAgentProcesses();
    assert.ok(Array.isArray(procs));
    const mine = ra.procsOfJob(procs, id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].pid, c.pid);
    const rec = { pid: c.pid, startMs: mine[0].startMs, cmdSig: ra.cmdSig(mine[0].cmd) };
    assert.equal(ra.aliveByEntry(id, { procs: [rec] }, procs), true);
    assert.equal(ra.aliveByEntry(id, { procs: [{ ...rec, startMs: rec.startMs - 3600 * 1000 }] }, procs), false, '启动时间不同 = pid 被复用');
    assert.equal(ra.aliveByEntry(id, { procs: [{ ...rec, cmdSig: 'deadbeefdeadbeef' }] }, procs), false, '命令行不同 = pid 被复用');
    assert.equal(ra.aliveByEntry(id, null, procs), true, '没有检查点 → 按命令行匹配（ic25 之前的口径）');
    assert.equal(ra.aliveByEntry(id, { procs: [rec] }, null), null, '进程表不可用 → 不明');
    // 记下的 pid 被一个「别的进程」占着（这里用本测试进程的 pid 模拟）：命令行里没有这个任务 → 不算
    assert.equal(ra.aliveByEntry(id, { procs: [{ pid: process.pid, startMs: 1, cmdSig: rec.cmdSig }] }, [{ pid: process.pid, startMs: Date.now(), cmd: 'node other.js' }]), false);
  } finally {
    await stopAgent(c);
  }
});

test('二次重启：接管后后端又重启 → 按检查点接着监视同一个外部进程（等待计时不重来）；进程退出后只「继续」一次', async () => {
  const { Jobs } = core;
  setControl(null);
  const { p, title } = makeChapter({ name: '二次重启' });
  const j = runningJob(p.id, title);
  const c = await fakeAgent(j.id);
  let exited = false;
  try {
    const b1 = boot();
    assert.ok(b1.adopted.some((x) => x.jobId === j.id));
    const e1 = ra.getWatchEntry(j.id);
    // 第一次启动的恢复模块还没来得及判定，后端又重启了（不起 startRestartRecovery = 内存里的监视丢了）
    await sleep(50);
    const b2 = boot();
    const again = b2.adopted.find((x) => x.jobId === j.id);
    assert.ok(again && again.again, '第二次启动接着接管');
    assert.equal(Jobs.get(j.id).status, 'adopted');
    const e2 = ra.getWatchEntry(j.id);
    assert.equal(e2.procs[0].pid, c.pid, '监视的是同一个进程');
    assert.equal(e2.adoptedAt, e1.adoptedAt, '等待计时从第一次接管算');
    assert.equal(e2.boots, 2);
    assert.match(Jobs.get(j.id).detail, /后端再次重启，接着监视/);
    assert.ok(logLines().some((l) => l.event === 'readopt' && l.jobId === j.id));
    // 第二次启动的恢复模块（真实进程表 + 检查点判活）
    const startRun = spy();
    const ps = rr.startRestartRecovery({ since: b2.bootAt - 1000, pollMs: 100, deps: { startRun, autoChain: () => assert.fail(), deliver: async () => assert.fail() } });
    await sleep(600);
    assert.equal(startRun.calls.length, 0, '进程活着期间不提交');
    assert.equal(Jobs.get(j.id).status, 'adopted');
    await stopAgent(c);
    exited = true;
    const res = (await Promise.all(ps)).find((x) => x.jobId === j.id);
    assert.equal(res.action, 'resumed');
    assert.equal(startRun.calls.filter((x) => x.projectId === p.id).length, 1, '只提交一次');
    assert.equal(ra.getWatchEntry(j.id), null, '判定完删检查点');
  } finally {
    if (!exited) await stopAgent(c);
  }
});

test('二次重启遇到 pid 复用：检查点里的进程已不在（同 pid 换了人）→ 不接管，落 interrupted 交给原流程', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: 'pid复用' });
  const j = runningJob(p.id, title);
  const c = await fakeAgent(j.id);
  try {
    boot();
    assert.equal(Jobs.get(j.id).status, 'adopted');
    // 模拟：检查点记的是「另一个」进程（启动时间对不上）——现在占着这个 pid 的不是当初那个外部 Agent
    const e = ra.getWatchEntry(j.id);
    ra.putWatchEntry(j.id, { procs: e.procs.map((x) => ({ ...x, startMs: x.startMs - 7200 * 1000 })) });
    const b = boot();
    assert.ok(!b.pl.adopt.includes(j.id));
    assert.equal(Jobs.get(j.id).status, 'interrupted');
    assert.ok(rr.pickInterruptedJobs(b.bootAt - 1000).some((x) => x.id === j.id), '交给原有的 interrupted 流程');
  } finally {
    await stopAgent(c);
  }
});

test('等待超时 / 进程表一直查不到：接管任务退回 interrupted，不会一直挂着让守护判忙', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '超时' });
  const j1 = runningJob(p.id, title);
  const j2 = runningJob(p.id, '第2章');
  core.startupCleanup({ adopt: [j1.id, j2.id] });
  const res = await Promise.all(rr.startRestartRecovery({
    since: Date.now(), pollMs: 2, maxWaitMs: 30,
    alive: (id) => (id === j1.id ? true : id === j2.id ? null : false),
    deps: { startRun: () => assert.fail(), autoChain: () => assert.fail(), deliver: async () => assert.fail() },
  }));
  assert.equal(res.find((x) => x.jobId === j1.id).detail, '等待超时');
  assert.equal(res.find((x) => x.jobId === j2.id).detail, '进程表不可用');
  assert.equal(Jobs.get(j1.id).status, 'interrupted');
  assert.equal(Jobs.get(j2.id).status, 'interrupted');
});

// ———————————— 紧急开关 ————————————

test('IC_DISABLE_RECOVERY_ADOPT=1：不接管（全部 interrupted，回到 ic25 之前）；上次留下的 adopted 也落 interrupted', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '关接管' });
  const j = runningJob(p.id, title);
  const left = runningJob(p.id, '第2章');
  core.startupCleanup({ adopt: [left.id] });
  const c = await fakeAgent(j.id);
  process.env.IC_DISABLE_RECOVERY_ADOPT = '1';
  try {
    const b = boot();
    assert.equal(b.pl.skipped, 'IC_DISABLE_RECOVERY_ADOPT=1');
    assert.equal(Jobs.get(j.id).status, 'interrupted');
    assert.equal(Jobs.get(left.id).status, 'interrupted');
  } finally {
    delete process.env.IC_DISABLE_RECOVERY_ADOPT;
    await stopAgent(c);
  }
});

test('IC_DISABLE_RECOVERY_CHECKPOINT=1：不写不读检查点，判活回到按命令行匹配；接管本身照常', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '关检查点' });
  const j = runningJob(p.id, title);
  const c = await fakeAgent(j.id);
  process.env.IC_DISABLE_RECOVERY_CHECKPOINT = '1';
  try {
    boot();
    assert.equal(Jobs.get(j.id).status, 'adopted');
    assert.equal(ra.getWatchEntry(j.id), null);
    assert.equal(ra.trackedAgentAlive(j.id), true);
  } finally {
    delete process.env.IC_DISABLE_RECOVERY_CHECKPOINT;
    await stopAgent(c);
  }
  const raw = fs.existsSync(ra.watchFile()) ? JSON.parse(fs.readFileSync(ra.watchFile(), 'utf8')) : { jobs: {} };
  assert.ok(!raw.jobs[j.id]);
  core.startupCleanup();
});
