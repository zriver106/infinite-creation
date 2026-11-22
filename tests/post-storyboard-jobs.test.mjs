// 项目级分镜收尾开关 post_storyboard_jobs：缺省 queue（原行为）；none 不排出图/TTS，只把缺图和缺音色写进报告。
// 临时数据目录 + 临时配置 + 8188/8189 守卫；默认路径用 Jobs.create 拦截证明会入队，但不真正启动阶段任务/GPU。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-post-sb-jobs-'));
writeTempIcConfig(tmp);

const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

let core, afterStoryboardTextJob, enqueuePendingAssetsIfNeeded, GET, PUT, server, base;

before(async () => {
  core = await import('../lib/core/index.js');
  ({ afterStoryboardTextJob, enqueuePendingAssetsIfNeeded } = await import('../lib/agent/prompt-write.js'));
  ({ GET, PUT } = await import('../app/api/projects/[id]/storyboard-settings/route.js'));
  server = http.createServer(async (req, res) => {
    try {
      const m = /^\/api\/projects\/([^/]+)\/storyboard-settings$/.exec(req.url);
      if (!m) { res.writeHead(404); res.end(); return; }
      const params = { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) };
      let r;
      if (req.method === 'GET') {
        r = await GET(new Request('http://127.0.0.1' + req.url, { method: 'GET' }), params);
      } else if (req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        r = await PUT(new Request('http://127.0.0.1' + req.url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks),
        }), params);
      } else {
        res.writeHead(405); res.end(); return;
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(599);
      res.end(String(e && e.stack || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (!server) return; return new Promise((r) => server.close(r)); });

function mkPendingProject() {
  const p = core.Projects.create({ name: '分镜收尾开关测试', auto_script: false });
  const title = '第1章';
  const ch = core.Chapters.list(p.id).find((c) => c.title === title) || core.Chapters.create(p.id, { title, script: 'x' });
  const char = core.Assets.create(p.id, { category: 'character', name: '测试角色甲' });
  const shot = core.Shots.create(p.id, {
    chapter: ch.title,
    idx: 1,
    visual: '画面',
    video_prompt: '已写提示词，避免收尾再调 LLM',
    mode: 'text',
    character_ids: [char.id],
  });
  return { p, ch, char, shot, title: ch.title };
}

function stageJobs(projectId) {
  return core.Jobs.list(projectId).filter((j) => j.type === 'stage');
}

function blockStageCreate() {
  const blocked = [];
  const orig = core.Jobs.create;
  core.Jobs.create = function guardedCreate(info) {
    if (info && info.type === 'stage') {
      blocked.push(info);
      throw new Error('TEST_BLOCK_STAGE_JOB');
    }
    return orig.apply(this, arguments);
  };
  return {
    blocked,
    restore() { core.Jobs.create = orig; },
  };
}

describe('readPostStoryboardJobs 缺省', () => {
  test('键不存在或非 none 都是 queue，默认值不变', () => {
    assert.equal(core.readPostStoryboardJobs({}), 'queue');
    assert.equal(core.readPostStoryboardJobs({ context: {} }), 'queue');
    assert.equal(core.readPostStoryboardJobs({ context: { post_storyboard_jobs: 'queue' } }), 'queue');
    assert.equal(core.readPostStoryboardJobs({ context: { post_storyboard_jobs: 'bogus' } }), 'queue');
    assert.equal(core.readPostStoryboardJobs({ context: { post_storyboard_jobs: 'none' } }), 'none');
    const p = core.Projects.create({ name: '缺省开关', auto_script: false });
    assert.equal(core.readPostStoryboardJobs(core.Projects.get(p.id)), 'queue');
  });
});

describe('afterStoryboardTextJob + post_storyboard_jobs', () => {
  test('none：不入队（Jobs.create 阶段任务一次都不调），报告含缺图和缺音色清单', async () => {
    const { p, title, char } = mkPendingProject();
    core.Projects.setContextKey(p.id, core.POST_STORYBOARD_JOBS_KEY, 'none');
    const guard = blockStageCreate();
    try {
      const report = await afterStoryboardTextJob({ projectId: p.id, chapter: title });
      assert.match(String(report), /缺图/);
      assert.match(String(report), /缺音色/);
      assert.match(String(report), /post_storyboard_jobs=none/);
      assert.match(String(report), new RegExp(char.name));
      assert.equal(guard.blocked.length, 0, 'none 不得调用 startStageJob/Jobs.create(stage)');
      assert.equal(stageJobs(p.id).length, 0);
    } finally {
      guard.restore();
    }
  });

  test('缺省 queue：有待做资产图/音色时会调用 startStageJob（此处拦截，不真入队、不碰 GPU）', async () => {
    const { p, title } = mkPendingProject();
    assert.equal(core.readPostStoryboardJobs(core.Projects.get(p.id)), 'queue');
    const guard = blockStageCreate();
    try {
      let caught = null;
      try {
        await enqueuePendingAssetsIfNeeded({ projectId: p.id, chapter: title });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, '默认路径应尝试创建阶段任务');
      assert.equal(caught.message, 'TEST_BLOCK_STAGE_JOB');
      assert.equal(guard.blocked.length, 1);
      const stages = (guard.blocked[0].checkpoint && guard.blocked[0].checkpoint.stages) || [];
      assert.ok(stages.includes('image') && stages.includes('tts'), JSON.stringify(stages));
      assert.equal(stageJobs(p.id).length, 0, '拦截后库里不应留下阶段任务');
    } finally {
      guard.restore();
    }
  });

  test('缺省 queue 走 afterStoryboardTextJob 时也会尝试入队（拦截，不真提交）', async () => {
    const { p, title } = mkPendingProject();
    const guard = blockStageCreate();
    try {
      const report = await afterStoryboardTextJob({ projectId: p.id, chapter: title });
      // startStageJob 在 Jobs.create 处被拦，收尾把失败写进报告，但证明走了入队分支而不是 none 清单。
      assert.match(String(report), /排入资产生成失败：TEST_BLOCK_STAGE_JOB/);
      assert.doesNotMatch(String(report), /post_storyboard_jobs=none/);
      assert.equal(guard.blocked.length, 1);
      assert.equal(stageJobs(p.id).length, 0);
    } finally {
      guard.restore();
    }
  });
});

describe('GET/PUT /api/projects/:id/storyboard-settings', () => {
  test('GET 缺省为 queue；PUT none/queue 读写往返；非法值 400；不提交任务', async () => {
    const { p } = mkPendingProject();
    const url = base + '/api/projects/' + encodeURIComponent(p.id) + '/storyboard-settings';
    const g0 = await fetch(url);
    const j0 = await g0.json();
    assert.equal(g0.status, 200, JSON.stringify(j0));
    assert.equal(j0.post_storyboard_jobs, 'queue');

    const pNone = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ post_storyboard_jobs: 'none' }) });
    const jn = await pNone.json();
    assert.equal(pNone.status, 200, JSON.stringify(jn));
    assert.equal(jn.post_storyboard_jobs, 'none');
    assert.equal(core.readPostStoryboardJobs(core.Projects.get(p.id)), 'none');

    const g1 = await (await fetch(url)).json();
    assert.equal(g1.post_storyboard_jobs, 'none');

    const pQ = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ post_storyboard_jobs: 'queue' }) });
    const jq = await pQ.json();
    assert.equal(pQ.status, 200, JSON.stringify(jq));
    assert.equal(jq.post_storyboard_jobs, 'queue');

    const bad = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ post_storyboard_jobs: 'off' }) });
    assert.equal(bad.status, 400);
    assert.equal(core.readPostStoryboardJobs(core.Projects.get(p.id)), 'queue');
    assert.equal(stageJobs(p.id).length, 0);
  });
});
