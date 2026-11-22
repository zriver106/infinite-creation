// 第二批：删除活动任务/项目一律 409，不 stopJob、不 abortFlags、不 interruptTask、不 /interrupt、不删记录。
// v1.1：最新未接续的 interrupted 出片任务同样 409「该任务等待断点续跑…」；已被接续的旧 interrupted 仍可删。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-del409-'));
let core, runner;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' },
    comfyui: { baseUrl: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9', provider: 'native' },
    generation: { videosPerShot: 1, refLeakGuard: false },
    agent: { runtime: 'openclaude' },
  }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  process.env.IC_ASSET_PRECHECK = 'off';
  core = await import('../lib/core/index.js');
  runner = await import('../lib/agent/job-runner.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function installSpies() {
  const origFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const stopCalls = [];
  const interruptCalls = [];
  const spies = {
    stopJob: (id) => { stopCalls.push(id); },
    interruptTask: async (cfg) => { interruptCalls.push(cfg || true); },
    stopCalls,
    interruptCalls,
    fetchCalls,
    interruptFetches: () => fetchCalls.filter((c) => String(c.url).includes('/interrupt')),
    port8189: () => fetchCalls.filter((c) => /:8189\b/.test(String(c.url))),
    restore: () => { globalThis.fetch = origFetch; },
  };
  return spies;
}

// 与删除任务路由相同：只根据策略决定 409 或删记录，绝不调用 stopJob / interruptTask。
function runDeleteJobLikeRoute(job, spies) {
  const policy = runner.applyDeleteJobPolicy(job);
  if (policy.kind !== 'delete-ok') {
    // 即使调用方塞了间谍，拒绝路径也不得调用。
    return policy;
  }
  core.Jobs.remove(job.id);
  return { kind: 'delete-ok', status: 200, deleted: true, id: job.id };
}

// 与删除项目路由相同。
function runDeleteProjectLikeRoute(projectId, spies) {
  const p = core.Projects.get(projectId);
  if (!p) return { kind: 'missing', status: 404, error: '项目不存在' };
  const policy = runner.applyDeleteProjectPolicy(core.Jobs.list(projectId));
  if (policy.kind !== 'delete-ok') return policy;
  core.Projects.remove(projectId);
  try { fs.rmSync(core.projectDir(projectId), { recursive: true, force: true }); } catch {}
  return { kind: 'delete-ok', status: 200, deleted: true };
}

function assertNoHardStop(spies, jobId, msg) {
  assert.equal(spies.stopCalls.length, 0, msg + '：stopJob 必须 0 次');
  assert.equal(spies.interruptCalls.length, 0, msg + '：interruptTask 必须 0 次');
  assert.equal(spies.interruptFetches().length, 0, msg + '：/interrupt fetch 必须 0 次');
  assert.equal(spies.port8189().length, 0, msg + '：不得打到 8189');
  if (jobId) assert.equal(runner.isAborted(jobId)(), false, msg + '：不得打 abortFlags');
}

describe('删除活动任务/项目 409', { concurrency: 1 }, () => {
  test('删除任务：running 与 queued（含 adopted）回 409，记录仍在，stopJob / interruptTask / /interrupt 均为 0；终态任务仍可删', () => {
    const { Projects, Jobs } = core;
    const p = Projects.create({ name: '删任务409' });
    const spies = installSpies();
    try {
      for (const status of ['running', 'queued', 'adopted']) {
        const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
        Jobs.update(job.id, { status });
        const fresh = Jobs.get(job.id);
        const also = runner.executeDeleteJob(fresh, { stopJob: spies.stopJob, interruptTask: spies.interruptTask });
        const r = runDeleteJobLikeRoute(fresh, spies);
        assert.equal(also.kind, 'reject-active', status + ' executeDeleteJob 必须 409');
        assert.equal(r.kind, 'reject-active', status + ' 必须 409');
        assert.equal(r.status, 409);
        assert.equal(r.error, '请先取消，等任务结束后再删');
        assert.equal(also.deleted, false);
        assert.ok(Jobs.get(job.id), status + ' 记录必须仍在');
        assert.equal(Jobs.get(job.id).status, status);
        assertNoHardStop(spies, job.id, '删任务 ' + status);
      }

      // 行内 running 同样 409（不再用旧的「不占渲染队列」文案），且无副作用
      const llm = Jobs.create({ projectId: p.id, type: 'llm', checkpoint: {} });
      Jobs.update(llm.id, { status: 'running' });
      const rLlm = runDeleteJobLikeRoute(Jobs.get(llm.id), spies);
      assert.equal(rLlm.kind, 'reject-active');
      assert.equal(rLlm.error, '请先取消，等任务结束后再删');
      assert.ok(Jobs.get(llm.id));
      assertNoHardStop(spies, llm.id, '删 running llm');

      // 正对照：终态任务仍删除成功。此处 interrupted 不带章节，不在「待续跑」范围内，仍可删。
      for (const status of ['done', 'failed', 'cancelled', 'interrupted']) {
        const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: {} });
        Jobs.update(job.id, { status });
        const id = job.id;
        const r = runDeleteJobLikeRoute(Jobs.get(id), spies);
        assert.equal(r.kind, 'delete-ok', status + ' 应允许删除');
        assert.ok(!Jobs.get(id), status + ' 记录应已删除');
        assert.equal(spies.stopCalls.length, 0, '删终态任务也不得 stopJob');
        assert.equal(spies.interruptCalls.length, 0, '删终态任务也不得 interruptTask');
        assert.equal(spies.interruptFetches().length, 0);
      }
    } finally {
      spies.restore();
    }
  });

  test('删除项目：有 running / queued / adopted 任务时 409，项目与任务都还在，硬停止 0 次；空闲项目仍可删', () => {
    const { Projects, Jobs } = core;
    const spies = installSpies();
    try {
      for (const status of ['running', 'queued', 'adopted']) {
        const p = Projects.create({ name: '删项目409-' + status });
        const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
        Jobs.update(job.id, { status });
        const also = runner.executeDeleteProject(Jobs.list(p.id), { stopJob: spies.stopJob, interruptTask: spies.interruptTask });
        const r = runDeleteProjectLikeRoute(p.id, spies);
        assert.equal(also.kind, 'reject-active');
        assert.equal(r.kind, 'reject-active');
        assert.equal(r.status, 409);
        assert.equal(r.error, '请先取消，等任务结束后再删');
        assert.ok(Projects.get(p.id), '项目必须仍在');
        assert.ok(Jobs.get(job.id), '任务必须仍在');
        assert.equal(Jobs.get(job.id).status, status);
        assertNoHardStop(spies, job.id, '删项目 ' + status);
      }

      // 正对照：只有终态任务的空闲项目可以删
      const idle = Projects.create({ name: '空闲可删' });
      const done = Jobs.create({ projectId: idle.id, type: 'export', checkpoint: {} });
      Jobs.update(done.id, { status: 'done' });
      const rIdle = runDeleteProjectLikeRoute(idle.id, spies);
      assert.equal(rIdle.kind, 'delete-ok');
      assert.ok(!Projects.get(idle.id), '空闲项目应已删除');
      assert.equal(spies.stopCalls.length, 0, '删空闲项目不得 stopJob');
      assert.equal(spies.interruptCalls.length, 0);
      assert.equal(spies.interruptFetches().length, 0);

      // 无任务的空项目也可以删
      const empty = Projects.create({ name: '空项目' });
      const rEmpty = runDeleteProjectLikeRoute(empty.id, spies);
      assert.equal(rEmpty.kind, 'delete-ok');
      assert.ok(!Projects.get(empty.id), '空项目应已删除');
    } finally {
      spies.restore();
    }
  });

  test('删除任务/项目：最新未接续的 interrupted 出片任务 409「等待断点续跑」，无副作用；已被接续的旧 interrupted 可删', () => {
    const { Projects, Jobs } = core;
    const spies = installSpies();
    const MSG = '该任务等待断点续跑，请先在该章点「继续」，续跑开始后再删';
    try {
      // 最新未接续：type=create + 带章节 + interrupted，后面没有更新的 create
      const p = Projects.create({ name: '待续跑409' });
      const pending = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
      Jobs.update(pending.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const also = runner.executeDeleteJob(Jobs.get(pending.id), { stopJob: spies.stopJob, interruptTask: spies.interruptTask });
      const r = runDeleteJobLikeRoute(Jobs.get(pending.id), spies);
      assert.equal(also.kind, 'reject-pending-resume');
      assert.equal(r.kind, 'reject-pending-resume');
      assert.equal(r.status, 409);
      assert.equal(r.error, MSG);
      assert.equal(also.deleted, false);
      assert.ok(Jobs.get(pending.id), '待续跑 interrupted 记录必须仍在');
      assert.equal(Jobs.get(pending.id).status, 'interrupted');
      assertNoHardStop(spies, pending.id, '删待续跑 interrupted');

      // 已被接续：同章有 startedAt 更大的 create，旧 interrupted 可删，新任务仍在
      const p2 = Projects.create({ name: '已接续可删' });
      const old = Jobs.create({ projectId: p2.id, type: 'create', checkpoint: { chapter: '第2章' } });
      Jobs.update(old.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const newer = Jobs.create({ projectId: p2.id, type: 'create', checkpoint: { chapter: '第2章' } });
      Jobs.update(newer.id, { status: 'done', startedAt: 2000, finishedAt: 2100 });
      const rOld = runDeleteJobLikeRoute(Jobs.get(old.id), spies);
      assert.equal(rOld.kind, 'delete-ok', '已被接续的旧 interrupted 应允许删除');
      assert.ok(!Jobs.get(old.id), '旧 interrupted 记录应已删除');
      assert.ok(Jobs.get(newer.id), '接续任务不得被连带删除');
      assertNoHardStop(spies, null, '删已接续 interrupted');

      // 同章两条 interrupted：只保护 startedAt 更大的那条（最新未接续）
      const p3 = Projects.create({ name: '两条interrupted' });
      const olderInt = Jobs.create({ projectId: p3.id, type: 'create', checkpoint: { chapter: '第3章' } });
      Jobs.update(olderInt.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const latestInt = Jobs.create({ projectId: p3.id, type: 'create', checkpoint: { chapter: '第3章' } });
      Jobs.update(latestInt.id, { status: 'interrupted', startedAt: 2000, finishedAt: 2100 });
      const rOlder = runDeleteJobLikeRoute(Jobs.get(olderInt.id), spies);
      assert.equal(rOlder.kind, 'delete-ok', '被更新 interrupted 盖过的旧记录可删');
      const rLatest = runDeleteJobLikeRoute(Jobs.get(latestInt.id), spies);
      assert.equal(rLatest.kind, 'reject-pending-resume');
      assert.equal(rLatest.error, MSG);
      assert.ok(Jobs.get(latestInt.id));
      assertNoHardStop(spies, latestInt.id, '两条 interrupted 只挡最新');

      // 无章节、非 create 的 interrupted 仍可删（不在重启恢复接手范围）
      const p4 = Projects.create({ name: '无关interrupted' });
      const noCh = Jobs.create({ projectId: p4.id, type: 'create', checkpoint: {} });
      Jobs.update(noCh.id, { status: 'interrupted' });
      const llmInt = Jobs.create({ projectId: p4.id, type: 'llm', checkpoint: { chapter: '第1章' } });
      Jobs.update(llmInt.id, { status: 'interrupted' });
      assert.equal(runDeleteJobLikeRoute(Jobs.get(noCh.id), spies).kind, 'delete-ok');
      assert.equal(runDeleteJobLikeRoute(Jobs.get(llmInt.id), spies).kind, 'delete-ok');
      assert.ok(!Jobs.get(noCh.id) && !Jobs.get(llmInt.id));

      // 项目：只有待续跑 interrupted → 409，项目与任务都还在
      const pHold = Projects.create({ name: '项目待续跑' });
      const hold = Jobs.create({ projectId: pHold.id, type: 'create', checkpoint: { chapter: '第4章' } });
      Jobs.update(hold.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const alsoP = runner.executeDeleteProject(Jobs.list(pHold.id), { stopJob: spies.stopJob, interruptTask: spies.interruptTask });
      const rHold = runDeleteProjectLikeRoute(pHold.id, spies);
      assert.equal(alsoP.kind, 'reject-pending-resume');
      assert.equal(rHold.kind, 'reject-pending-resume');
      assert.equal(rHold.status, 409);
      assert.equal(rHold.error, MSG);
      assert.ok(Projects.get(pHold.id), '项目必须仍在');
      assert.ok(Jobs.get(hold.id), '待续跑任务必须仍在');
      assertNoHardStop(spies, hold.id, '删含待续跑项目');

      // 项目：只有已被接续的旧 interrupted + 终态接续任务 → 可删
      const pOk = Projects.create({ name: '项目已接续可删' });
      const oldP = Jobs.create({ projectId: pOk.id, type: 'create', checkpoint: { chapter: '第5章' } });
      Jobs.update(oldP.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const newP = Jobs.create({ projectId: pOk.id, type: 'create', checkpoint: { chapter: '第5章' } });
      Jobs.update(newP.id, { status: 'done', startedAt: 2000, finishedAt: 2100 });
      const rOk = runDeleteProjectLikeRoute(pOk.id, spies);
      assert.equal(rOk.kind, 'delete-ok');
      assert.ok(!Projects.get(pOk.id), '已接续项目应已删除');
      assertNoHardStop(spies, null, '删已接续项目');

      // 项目同时有活动任务和待续跑 interrupted：活动优先，文案仍是「请先取消」
      const pBoth = Projects.create({ name: '活动优先' });
      const hold2 = Jobs.create({ projectId: pBoth.id, type: 'create', checkpoint: { chapter: '第6章' } });
      Jobs.update(hold2.id, { status: 'interrupted', startedAt: 1000, finishedAt: 1100 });
      const run = Jobs.create({ projectId: pBoth.id, type: 'create', checkpoint: { chapter: '第7章' } });
      Jobs.update(run.id, { status: 'running', startedAt: 3000 });
      const rBoth = runDeleteProjectLikeRoute(pBoth.id, spies);
      assert.equal(rBoth.kind, 'reject-active');
      assert.equal(rBoth.error, '请先取消，等任务结束后再删');
      assert.ok(Projects.get(pBoth.id) && Jobs.get(hold2.id) && Jobs.get(run.id));
      assertNoHardStop(spies, run.id, '活动优先于待续跑');
    } finally {
      spies.restore();
    }
  });

    test('源码：两条删除路由都没有调用 stopJob / interruptTask', () => {
    const jobRoute = fs.readFileSync(path.join(process.cwd(), 'app', 'api', 'projects', '[id]', 'jobs', '[jobId]', 'route.js'), 'utf8');
    const projRoute = fs.readFileSync(path.join(process.cwd(), 'app', 'api', 'projects', '[id]', 'route.js'), 'utf8');
    assert.ok(/applyDeleteJobPolicy\(job\)/.test(jobRoute));
    assert.ok(/applyDeleteProjectPolicy\(/.test(projRoute));
    assert.ok(!/stopJob\s*\(/.test(jobRoute) && !/interruptTask\s*\(/.test(jobRoute));
    assert.ok(!/stopJob\s*\(/.test(projRoute) && !/interruptTask\s*\(/.test(projRoute));
  });
});
