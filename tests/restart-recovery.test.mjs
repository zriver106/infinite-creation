// 重启恢复单测（2026-11-17 第三轮）：临时数据目录 + 临时配置；startRun / autoChain / deliver 全部注入假函数，
// 不起真任务、不调真 CLI、不碰 ComfyUI、不碰真实 data/ic.db。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rr-'));
let core;
let rr;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, agent: { runtime: 'openclaude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  rr = await import('../lib/agent/restart-recovery.js');
});

// 造一章：n 镜，rendered=全部出完；exported=写一份主成片（mtime = 现在）
function makeChapter({ name, title = '第1章', n = 2, rendered = true, exported = true }) {
  const { Projects, Chapters, Shots, projectDir, slugify } = core;
  const p = Projects.create({ name, auto_script: false });
  for (const t of [title, '第2章']) if (!Chapters.list(p.id).some((c) => c.title === t)) Chapters.create(p.id, { title: t, script: 's' });
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const s = Shots.create(p.id, { chapter: title, idx: i, visual: 'v' + i, video_prompt: 'p' + i, mode: 'text' });
    if (rendered || i === 1) Shots.update(s.id, { status: 'done', video_path: 'shots/' + i + '.mp4' });
    ids.push(s.id);
  }
  let rel = '';
  if (exported) {
    const dir = path.join(projectDir(p.id), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = slugify(p.name) + '_' + slugify(title) + '_0123abcd.mp4';
    fs.writeFileSync(path.join(dir, file), 'fake-mp4');
    rel = 'exports/' + file;
  }
  return { p, title, ids, rel };
}

// 造一个「本次启动刚被标 interrupted」的出片任务（startupCleanup 的效果）
function interruptedJob(projectId, chapter, { startedAt = Date.now() - 60000, storyboardOnly = false } = {}) {
  const { Jobs } = core;
  const j = Jobs.create({ projectId, type: 'create', checkpoint: { chapter, subject: chapter, ...(storyboardOnly ? { storyboardOnly: true } : {}) } });
  return Jobs.update(j.id, { status: 'interrupted', startedAt, finishedAt: Date.now() });
}

const spy = () => {
  const calls = [];
  const fn = (args) => { calls.push(args); return { job: { id: 'NEW-' + calls.length }, deduped: false }; };
  fn.calls = calls;
  return fn;
};

test('agentAlive：按 agent-workspaces/<jobId> 精确匹配；进程表不可用 → null', () => {
  const id = '015b2357-d24e-44db-80e4-a89526ecdbd5';
  const lines = ['"C:\\x\\claude.exe" --print --mcp-config C:\\tmp\\data\\agent-workspaces\\' + id + '\\claude-mcp.json --strict-mcp-config'];
  assert.equal(rr.agentAlive(id, () => lines), true);
  assert.equal(rr.agentAlive('015b2357-d24e-44db-80e4-a89526ecdbd', () => lines), false, '前缀不算');
  assert.equal(rr.agentAlive('other', () => lines), false);
  assert.equal(rr.agentAlive(id, () => ['node /data/agent-workspaces/' + id + '/mcp.json']), true, 'posix 路径');
  assert.equal(rr.agentAlive(id, () => null), null);
});

test('pickInterruptedJobs：只取本次启动标 interrupted 的出片(create)任务、必须带章节', () => {
  const { Jobs } = core;
  const { p } = makeChapter({ name: '挑任务' });
  const since = Date.now() - 1000;
  const a = interruptedJob(p.id, '第1章');
  const old = Jobs.update(Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第2章' } }).id, { status: 'interrupted', finishedAt: since - 3600000 });
  const stage = Jobs.update(Jobs.create({ projectId: p.id, type: 'stage', checkpoint: { chapter: '第1章' } }).id, { status: 'interrupted', finishedAt: Date.now() });
  const noCh = Jobs.update(Jobs.create({ projectId: p.id, type: 'create', checkpoint: {} }).id, { status: 'interrupted', finishedAt: Date.now() });
  const ids = rr.pickInterruptedJobs(since).map((j) => j.id);
  assert.ok(ids.includes(a.id));
  for (const x of [old, stage, noCh]) assert.ok(!ids.includes(x.id));
});

test('场景1：已出片 + 被打断 → 记 done、补交付、走自动续章；不重新提交本章', async () => {
  const { Jobs } = core;
  const { p, title, rel } = makeChapter({ name: '已出片' });
  const job = interruptedJob(p.id, title);
  const startRun = spy();
  const delivered = [];
  const chained = [];
  const r = await rr.settleInterruptedJob(job, {
    startRun,
    deliver: async (a) => { delivered.push(a); return { status: 'ok', ep: 1 }; },
    autoChain: (a) => { chained.push(a); return { id: 'NEXT' }; },
  });
  assert.equal(r.action, 'done');
  const j = Jobs.get(job.id);
  assert.equal(j.status, 'done');
  assert.match(j.detail, /【重启恢复】.*记为完成/);
  assert.equal(startRun.calls.length, 0, '已出片不重新提交');
  assert.equal(delivered.length, 1);
  assert.deepEqual({ ...delivered[0] }, { projectId: p.id, chapterTitle: title, exportRel: rel, source: 'restart-recovery' });
  assert.equal(chained.length, 1);
  assert.equal(chained[0].job.status, 'done', '自动续章拿到的是 done 任务（与正常收尾 afterOk 同口径）');
  // 再跑一次：状态已不是 interrupted → 不重复处理
  const again = await rr.settleInterruptedJob(job, { startRun, autoChain: (a) => chained.push(a), deliver: async (a) => delivered.push(a) });
  assert.equal(again.action, 'skipped');
  assert.equal(chained.length, 1);
  assert.equal(delivered.length, 1);
});

test('场景1b：交付日志里已有这份成片的成功记录 → 不重复交付', async () => {
  const { p, title, rel } = makeChapter({ name: '已交付' });
  const logFile = core.deliveryLogPath(p.id);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify({ status: 'ok', exportRel: rel, chapter: title }) + '\n');
  const job = interruptedJob(p.id, title);
  const delivered = [];
  const r = await rr.settleInterruptedJob(job, { startRun: spy(), deliver: async (a) => { delivered.push(a); return { status: 'ok' }; }, autoChain: () => null });
  assert.equal(r.action, 'done');
  assert.equal(delivered.length, 0);
  assert.match(core.Jobs.get(job.id).detail, /交付已在出片时完成/);
});

test('成片早于任务开始（旧成片）→ 不算出片，按「继续」重新提交本章', async () => {
  const { p, title } = makeChapter({ name: '旧成片' });
  const job = interruptedJob(p.id, title, { startedAt: Date.now() + 60000 });
  const startRun = spy();
  const r = await rr.settleInterruptedJob(job, { startRun, autoChain: () => assert.fail('不该续章'), deliver: async () => assert.fail('不该交付') });
  assert.equal(r.action, 'resumed');
  assert.equal(startRun.calls.length, 1);
});

test('场景2：没出完 + 进程不在 → 等同本章「继续」（startSingleChapterRun 带章节），不清已完成分镜', async () => {
  const { Jobs, Shots } = core;
  const { p, title, ids } = makeChapter({ name: '没出完', n: 3, rendered: false, exported: false });
  const job = interruptedJob(p.id, title);
  const startRun = spy();
  const r = await rr.settleInterruptedJob(job, { startRun, autoChain: () => assert.fail('不该续章'), deliver: async () => assert.fail('不该交付') });
  assert.equal(r.action, 'resumed');
  assert.equal(startRun.calls.length, 1);
  assert.equal(startRun.calls[0].projectId, p.id);
  assert.equal(startRun.calls[0].chapter, title, '必须带章节');
  assert.equal(Jobs.get(job.id).status, 'interrupted', '旧任务保持 interrupted，只追加说明');
  assert.match(Jobs.get(job.id).detail, /按本章「继续」重新提交/);
  assert.equal(Shots.get(ids[0]).status, 'done');
  assert.equal(Shots.list(p.id).filter((s) => s.chapter === title).length, 3);
});

test('只生成分镜任务被打断 → 不自动重拆（会清分镜），只记一笔', async () => {
  const { p, title } = makeChapter({ name: '分镜任务', rendered: false, exported: false });
  const job = interruptedJob(p.id, title, { storyboardOnly: true });
  const startRun = spy();
  const r = await rr.settleInterruptedJob(job, { startRun, autoChain: () => assert.fail(), deliver: async () => assert.fail() });
  assert.equal(r.action, 'skipped');
  assert.equal(startRun.calls.length, 0);
});

test('同章之后已有更新的任务（用户已手动继续）→ 不插手', async () => {
  const { Jobs } = core;
  const { p, title } = makeChapter({ name: '已手动继续', rendered: false, exported: false });
  const job = interruptedJob(p.id, title);
  const newer = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: title } });
  Jobs.update(newer.id, { status: 'done', finishedAt: Date.now() });
  const startRun = spy();
  const r = await rr.settleInterruptedJob(job, { startRun, autoChain: () => assert.fail(), deliver: async () => assert.fail() });
  assert.equal(r.action, 'skipped');
  assert.equal(startRun.calls.length, 0);
});

test('场景3：进程还活着 → 轮询等待，退出后再判定（只提交一次）', async () => {
  const { p, title } = makeChapter({ name: '进程活着', rendered: false, exported: false });
  const since = Date.now() - 500;
  const job = interruptedJob(p.id, title);
  const seq = [true, true, true, false];
  let probes = 0;
  const startRun = spy();
  const promises = rr.startRestartRecovery({
    since, pollMs: 20,
    alive: (id) => (id === job.id ? seq[Math.min(probes++, seq.length - 1)] : false),
    deps: { startRun, autoChain: () => null, deliver: async () => ({ status: 'skipped' }) },
  });
  const results = await Promise.all(promises);
  const mine = results.find((x) => x.jobId === job.id);
  assert.equal(mine.action, 'resumed');
  assert.ok(probes >= 4, '等到进程退出才处理');
  assert.equal(startRun.calls.filter((c) => c.projectId === p.id).length, 1);
  assert.match(core.Jobs.get(job.id).detail, /进程仍在运行/);
});

test('场景3b：进程活着期间外部 Agent 把这一章做完了 → 退出后记 done + 续章', async () => {
  const { Shots, Jobs, projectDir, slugify } = core;
  const { p, title, ids } = makeChapter({ name: '活着做完', n: 2, rendered: false, exported: false });
  const since = Date.now() - 500;
  const job = interruptedJob(p.id, title);
  let probes = 0;
  const chained = [];
  const startRun = spy();
  const promises = rr.startRestartRecovery({
    since, pollMs: 20,
    alive: (id) => {
      if (id !== job.id) return false;
      probes++;
      if (probes === 3) {
        // 「孤儿」Agent 在这期间出完最后一镜并合成成片
        for (const sid of ids) Shots.update(sid, { status: 'done', video_path: 'shots/' + sid + '.mp4' });
        const dir = path.join(projectDir(p.id), 'exports');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, slugify(p.name) + '_' + slugify(title) + '_deadbeef.mp4'), 'x');
      }
      return probes < 4;
    },
    deps: { startRun, autoChain: (a) => { chained.push(a); return null; }, deliver: async () => ({ status: 'ok' }) },
  });
  const results = await Promise.all(promises);
  assert.equal(results.find((x) => x.jobId === job.id).action, 'done');
  assert.equal(Jobs.get(job.id).status, 'done');
  assert.equal(chained.filter((c) => c.projectId === p.id).length, 1);
  assert.equal(startRun.calls.filter((c) => c.projectId === p.id).length, 0);
});

test('进程表一直查不到 → 状态不明，不自动处理', async () => {
  const { p, title } = makeChapter({ name: '进程表坏', rendered: false, exported: false });
  const since = Date.now() - 500;
  const job = interruptedJob(p.id, title);
  const startRun = spy();
  const results = await Promise.all(rr.startRestartRecovery({ since, pollMs: 5, alive: () => null, deps: { startRun } }));
  assert.equal(results.find((x) => x.jobId === job.id).action, 'skipped');
  assert.equal(startRun.calls.length, 0);
});

test('「继续」提交本身失败（如章节无剧本）→ 不重试、在旧任务上记原因', async () => {
  const { p, title } = makeChapter({ name: '继续失败', rendered: false, exported: false });
  const job = interruptedJob(p.id, title);
  const r = await rr.settleInterruptedJob(job, { startRun: () => { throw new Error('没有剧本'); }, autoChain: () => assert.fail(), deliver: async () => assert.fail() });
  assert.equal(r.action, 'skipped');
  assert.match(core.Jobs.get(job.id).detail, /重新提交失败：没有剧本/);
  assert.equal(core.Jobs.get(job.id).status, 'interrupted');
});
