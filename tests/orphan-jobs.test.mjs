// 孤儿排队任务单测（2026-11-17 第四轮）：临时数据目录 + 临时配置；不起真任务、不碰 ComfyUI、不碰真实 data/ic.db。
// 「旧进程建的任务」用 globalThis.__icLiveJobIds.delete(id) 模拟（本进程没有它的执行者）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-orphan-'));
let core;
let oj;
let rr;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, agent: { runtime: 'openclaude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  oj = await import('../lib/agent/orphan-jobs.js');
  rr = await import('../lib/agent/restart-recovery.js');
});

const forget = (id) => globalThis.__icLiveJobIds.delete(id); // 模拟「旧进程建的」
function job(projectId, type, status, { subject, chapter, live = false } = {}) {
  const { Jobs } = core;
  const j = Jobs.create({ projectId, type, checkpoint: { ...(subject ? { subject } : {}), ...(chapter ? { chapter } : {}) } });
  Jobs.update(j.id, { status, phase: status === 'queued' ? '排队中' : '' });
  if (!live) forget(j.id);
  return core.Jobs.get(j.id);
}
const logLines = () => { const f = oj.orphanLogFile(); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

test('Jobs.isLive：本进程 create 后为 true，落终态后为 false', () => {
  const { Jobs, Projects } = core;
  const p = Projects.create({ name: 'live-reg' });
  const j = Jobs.create({ projectId: p.id, type: 'voice-design' });
  assert.equal(Jobs.isLive(j.id), true);
  Jobs.update(j.id, { status: 'queued' });
  assert.equal(Jobs.isLive(j.id), true);
  Jobs.update(j.id, { status: 'done' });
  assert.equal(Jobs.isLive(j.id), false);
});

test('isOrphanQueued：四个条件缺一不可（纯判定）', () => {
  const since = 1_000_000;
  const base = { id: 'x', status: 'queued', startedAt: since - 60_000, updatedAt: since - 60_000 };
  const dead = () => false;
  assert.equal(oj.isOrphanQueued(base, { since, isLive: dead }), true);
  assert.equal(oj.isOrphanQueued({ ...base, status: 'running' }, { since, isLive: dead }), false, 'running 不碰');
  assert.equal(oj.isOrphanQueued({ ...base, status: 'interrupted' }, { since, isLive: dead }), false, 'interrupted 不碰');
  assert.equal(oj.isOrphanQueued(base, { since, isLive: () => true }), false, '本进程有执行者');
  assert.equal(oj.isOrphanQueued({ ...base, startedAt: since + 1 }, { since, isLive: dead }), false, '启动后新建的');
  assert.equal(oj.isOrphanQueued({ ...base, updatedAt: since - 4_000 }, { since, isLive: dead }), false, 'updatedAt 在 since-5s 内（多实例保护）');
  assert.equal(oj.isOrphanQueued({ ...base, updatedAt: since - 5_001 }, { since, isLive: dead }), true);
  assert.equal(oj.isOrphanQueued(null, { since, isLive: dead }), false);
});

test('settleOrphanQueuedJobs：只把旧进程的 queued 落 cancelled；其他状态/新任务/活任务不动；资产与项目复位；写日志', () => {
  const { Jobs, Projects, Assets } = core;
  const p = Projects.create({ name: 'orphan-startup' });
  const aNoAudio = Assets.create(p.id, { category: 'character', name: '无音频人物' });
  Assets.update(aNoAudio.id, { status: 'generating' });
  const aAudio = Assets.create(p.id, { category: 'character', name: '有音频人物' });
  Assets.update(aAudio.id, { status: 'generating', audio_path: 'assets/voice/x.flac' });
  const orphan1 = job(p.id, 'voice-design', 'queued', { subject: aNoAudio.id });
  const orphan2 = job(p.id, 'voice-design', 'queued', { subject: aAudio.id });
  const liveQ = job(p.id, 'regenerate', 'queued', { live: true });
  const running = job(p.id, 'create', 'running', { chapter: '第1章' });
  const interrupted = job(p.id, 'create', 'interrupted', { chapter: '第2章' });
  const done = job(p.id, 'export', 'done');
  Projects.update(p.id, { status: 'running' });
  const before = logLines().length;

  // since 取未来 60s：所有已建任务都算「启动前」，updatedAt 都早于 since-5s
  const since = Date.now() + 60_000;
  const r = rr.settleOrphanQueuedJobs({ since });
  const ids = r.filter((x) => x.action === 'cancelled').map((x) => x.jobId).sort();
  assert.deepEqual(ids, [orphan1.id, orphan2.id].sort());
  for (const o of [orphan1, orphan2]) {
    const g = Jobs.get(o.id);
    assert.equal(g.status, 'cancelled');
    assert.equal(g.phase, '已取消');
    assert.match(g.error, /没有执行者/);
    assert.match(g.detail, /【孤儿任务】/);
    assert.ok(g.finishedAt > 0);
  }
  assert.equal(Jobs.get(liveQ.id).status, 'queued', '本进程有执行者的排队任务不动');
  assert.equal(Jobs.get(running.id).status, 'running');
  assert.equal(Jobs.get(interrupted.id).status, 'interrupted');
  assert.equal(Jobs.get(done.id).status, 'done');
  assert.equal(Assets.get(aNoAudio.id).status, 'failed', '没有音频 → failed');
  assert.equal(Assets.get(aAudio.id).status, 'done', '已有音频 → done');
  assert.equal(Projects.get(p.id).status, 'running', '还有活动任务（liveQ/running）→ 项目保持 running');
  const logs = logLines().slice(before);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((l) => l.jobId).sort(), ids);
  assert.ok(logs.every((l) => l.action === 'cancelled' && l.source === 'startup' && l.type === 'voice-design'));
  // 再跑一次：幂等，不重复落库、不重复写日志
  assert.equal(rr.settleOrphanQueuedJobs({ since }).length, 0);
  assert.equal(logLines().length, before + 2);
});

test('settleOrphanQueuedJobs：since 在过去（任务是本次启动后建的）→ 不动', () => {
  const { Jobs, Projects } = core;
  const p = Projects.create({ name: 'orphan-new' });
  const q = job(p.id, 'voice-design', 'queued');
  const r = rr.settleOrphanQueuedJobs({ since: Date.now() - 60_000 });
  assert.equal(r.length, 0);
  assert.equal(Jobs.get(q.id).status, 'queued');
});

test('settleOrphanQueuedJobs：updatedAt 在 since-5s 以内 → 不动（多实例保护）', () => {
  const { Jobs, Projects } = core;
  const p = Projects.create({ name: 'orphan-guard' });
  const q = job(p.id, 'voice-design', 'queued');
  const r = rr.settleOrphanQueuedJobs({ since: Date.now() + 2_000 });
  assert.equal(r.filter((x) => x.jobId === q.id).length, 0);
  assert.equal(Jobs.get(q.id).status, 'queued');
});

test('settleOrphanJob：唯一活动任务被作废后项目复位 idle；资产被别的活任务占着时不复位', () => {
  const { Jobs, Projects, Assets } = core;
  const p = Projects.create({ name: 'orphan-cancel' });
  const a = Assets.create(p.id, { category: 'character', name: '被占用' });
  Assets.update(a.id, { status: 'generating' });
  const o = job(p.id, 'voice-design', 'queued', { subject: a.id });
  const other = job(p.id, 'voice-design', 'running', { subject: a.id, live: true });
  Projects.update(p.id, { status: 'running' });
  const r1 = oj.settleOrphanJob(Jobs.get(o.id), { source: 'cancel', reason: '取消：无执行者' });
  assert.equal(r1.action, 'cancelled');
  assert.equal(r1.assetReset, 'asset-busy');
  assert.equal(Assets.get(a.id).status, 'generating', '别的任务在跑同一资产 → 不复位');
  assert.equal(Projects.get(p.id).status, 'running');
  Jobs.update(other.id, { status: 'done' });
  const o2 = job(p.id, 'voice-design', 'queued');
  oj.settleOrphanJob(Jobs.get(o2.id), { source: 'cancel' });
  assert.equal(Projects.get(p.id).status, 'idle', '没有别的活动任务 → idle');
  // 已不是 queued → skipped
  assert.equal(oj.settleOrphanJob(Jobs.get(o2.id)).action, 'skipped');
  const last = logLines().slice(-2);
  assert.ok(last.every((l) => l.source === 'cancel'));
});

test('startupCleanup + settleOrphanQueuedJobs：running→interrupted 不受影响，queued→cancelled', () => {
  const { Jobs, Projects, startupCleanup } = core;
  const p = Projects.create({ name: 'orphan-boot' });
  const run = job(p.id, 'create', 'running', { chapter: '第1章' });
  const q = job(p.id, 'voice-design', 'queued');
  const since = Date.now() + 60_000;
  startupCleanup();
  const r = rr.settleOrphanQueuedJobs({ since });
  assert.ok(r.some((x) => x.jobId === q.id && x.action === 'cancelled'));
  assert.equal(Jobs.get(run.id).status, 'interrupted');
  assert.equal(Jobs.get(q.id).status, 'cancelled');
  // restart-recovery 仍按原逻辑挑出被标 interrupted 的出片任务
  assert.ok(rr.pickInterruptedJobs(0).some((j) => j.id === run.id));
});
