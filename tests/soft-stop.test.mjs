// 第一批 v4：软停止（跑完当前镜再停，不打 ComfyUI /interrupt）与取消 409 修法单测。
// 临时数据目录 + 临时配置；ComfyUI 用 mock fetch 立即成功返回，不起真进程、不碰 8188/8189。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-softstop-'));
let core, tools, runner, gate;

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
  delete process.env.IC_DISABLE_CHAPTER_RENDER_LOCK;
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
  runner = await import('../lib/agent/job-runner.js');
  gate = await import('../lib/core/render-gate.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

class DummyWS { constructor() {} close() {} set onmessage(_) {} }

function mkChapter(name, n = 3, chapter = '第1章') {
  const { Projects, Assets, Shots, projectDir } = core;
  const p = Projects.create({ name });
  const rel = 'assets/character/x.png';
  const abs = path.join(projectDir(p.id), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  const ch = Assets.create(p.id, { category: 'character', name: '角色' });
  Assets.update(ch.id, { image_path: rel, status: 'done' });
  const shots = [];
  for (let i = 0; i < n; i++) {
    const s = Shots.create(p.id, { chapter, visual: '画面' + (i + 1) });
    Shots.update(s.id, { video_prompt: '提示词' + (i + 1), character_ids: [ch.id] });
    shots.push(core.Shots.get(s.id));
  }
  return { p, shots, chapter };
}

function mockComfySuccess({ onPrompt } = {}) {
  const origFetch = globalThis.fetch;
  const origWS = globalThis.WebSocket;
  const calls = [];
  let nPrompt = 0;
  globalThis.WebSocket = DummyWS;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: u, method });
    if (u.includes('/upload/')) {
      return new Response(JSON.stringify({ name: 'x.png', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/prompt') && method !== 'GET') {
      nPrompt += 1;
      const prompt_id = 'pid-soft-' + nPrompt;
      if (onPrompt) await onPrompt({ prompt_id, n: nPrompt, calls });
      return new Response(JSON.stringify({ prompt_id }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/history/')) {
      const prompt_id = u.split('/history/')[1].split('?')[0];
      const body = {
        [prompt_id]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { '9': { videos: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } },
        },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/view') || u.includes('filename=')) {
      return new Response(Buffer.from('fake-mp4'), { status: 200 });
    }
    if (u.endsWith('/queue') && method === 'GET') {
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/free') || u.endsWith('/interrupt') || u.endsWith('/queue')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = origFetch; globalThis.WebSocket = origWS; },
  };
}


function installInterruptAndFetchSpies() {
  const origFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const interruptCalls = [];
  const interruptSpy = async (cfg) => { interruptCalls.push(cfg || true); };
  return {
    interruptSpy,
    interruptCalls,
    fetchCalls,
    interruptFetches: () => fetchCalls.filter((c) => String(c.url).includes('/interrupt')),
    port8189: () => fetchCalls.filter((c) => /:8189\b/.test(String(c.url))),
    restore: () => { globalThis.fetch = origFetch; },
  };
}

// 与 cancel/route.js 相同：dispatchCancel 不传入 interruptTask，仅当 shouldInterrupt 时才调用。
async function runCancelLikeRoute(job, interruptFn) {
  const result = await runner.dispatchCancel(job);
  if (result.shouldInterrupt) {
    try { const cfg = core.loadConfig(); await interruptFn(cfg); } catch {}
  }
  return result;
}

function ctxFor(p, jobId) {
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId });
  ctx.cfg.comfyui.provider = 'native';
  ctx.cfg.generation.videosPerShot = 1;
  ctx.cfg.generation.refLeakGuard = false;
  ctx.reports = [];
  ctx.report = (x) => { ctx.reports.push(x); };
  return ctx;
}


describe('软停止与取消 409', { concurrency: 1 }, () => {
  test('镜间设软停止后，当前镜跑完并标 done，下一镜不开，其余保持 pending，零次 /interrupt', async () => {
    const { p, shots, chapter } = mkChapter('软停止三镜', 3);
    const job = core.Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter } });
    core.Jobs.update(job.id, { status: 'running', phase: '分镜视频' });
    const mock = mockComfySuccess({
      onPrompt: async ({ n }) => {
        // 第一镜已经提交、正在「生成」时打软停止：不得让 generate() 走 /interrupt。
        if (n === 1) runner.requestSoftStop(job.id);
      },
    });
    let out;
    try {
      out = JSON.parse(await tools.runTool(ctxFor(p, job.id), 'generate_chapter_videos', { chapter }));
    } finally { mock.restore(); }

    assert.equal(out.aborted, true);
    assert.equal(out.generated, 1, '只有第一镜应成功收尾');
    assert.equal(core.Shots.get(shots[0].id).status, 'done', '当前镜必须正常标 done');
    assert.ok(core.Shots.get(shots[0].id).video_path, '当前镜应有成片路径');
    assert.equal(core.Shots.get(shots[1].id).status, 'pending', '下一镜不得开渲');
    assert.equal(core.Shots.get(shots[2].id).status, 'pending', '其余镜保持 pending');
    assert.equal(core.Shots.get(shots[1].id).video_path || '', '');
    assert.equal(core.Shots.get(shots[2].id).video_path || '', '');
    const prompts = mock.calls.filter((c) => c.url.includes('/prompt') && c.method !== 'GET');
    assert.equal(prompts.length, 1, '只应提交第一镜，不得提交下一镜');
    assert.equal(mock.calls.some((c) => c.url.includes('/interrupt')), false, '软停止不得打 /interrupt');
    assert.equal(mock.calls.some((c) => /:8189\b/.test(c.url)), false, '不得出现 8189');
    assert.equal(runner.isSoftStopped(job.id), true);
    assert.equal(runner.isJobUserCancelled(job.id), true, '镜间升级后任务应按已取消收尾');
    assert.match(runner.cancelledJobMessage(job.id), /软停止/);
    // 与 finishJobOk 同一口径写下终态，确认状态与说明文案。
    const msg = runner.cancelledJobMessage(job.id);
    core.Jobs.update(job.id, { status: 'cancelled', phase: '已取消', detail: msg, error: msg, finishedAt: Date.now() });
    const finished = core.Jobs.get(job.id);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.phase, '已取消');
    assert.match(finished.detail, /当前镜已跑完/);
  });

  test('取消路由：create 走软停止且不 /interrupt；llm/export 行内任务仍 409', () => {
    const { Projects, Jobs } = core;
    const p = Projects.create({ name: '取消路由项目' });

    const createJob = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
    Jobs.update(createJob.id, { status: 'running', phase: '分镜视频' });
    const createR = runner.applyCancelPolicy(createJob);
    assert.equal(createR.kind, 'soft-stop');
    assert.equal(createR.status, 200);
    assert.equal(createR.mode, 'after-shot');
    assert.match(String(createR.note || ''), /不会向 ComfyUI 发送 \/interrupt/);
    assert.equal(runner.isSoftStopped(createJob.id), true);
    assert.equal(runner.isAborted(createJob.id)(), false, '取消 create 不得打硬停止标记，否则 generate() 会 /interrupt');
    assert.equal(Jobs.get(createJob.id).status, 'running', '软停止当下不改库里的 running，等当前镜跑完由 runner 收尾为 cancelled');

    const llm = Jobs.create({ projectId: p.id, type: 'llm', checkpoint: {} });
    Jobs.update(llm.id, { status: 'running' });
    const rLlm = runner.applyCancelPolicy(llm);
    assert.equal(rLlm.kind, 'reject-inline');
    assert.equal(rLlm.status, 409);
    assert.match(String(rLlm.error || ''), /不占渲染队列/);
    assert.equal(runner.isSoftStopped(llm.id), false);
    assert.equal(runner.isAborted(llm.id)(), false);

    const exp = Jobs.create({ projectId: p.id, type: 'export', checkpoint: {} });
    Jobs.update(exp.id, { status: 'running' });
    const rExp = runner.applyCancelPolicy(exp);
    assert.equal(rExp.kind, 'reject-inline');
    assert.equal(rExp.status, 409);
    assert.equal(runner.isSoftStopped(exp.id), false);
    assert.equal(runner.isAborted(exp.id)(), false);
  });
  test('取消路由：running create 软停、queued create 出队、running llm/export 409，interruptTask 与 /interrupt 均为 0；硬停止正对照会调用', async () => {
    const { Projects, Jobs, interruptTask } = core;
    const p = Projects.create({ name: '取消路径证明' });
    const spies = installInterruptAndFetchSpies();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const holdSlot = (jobId) => {
      let release;
      const done = new Promise((r) => { release = r; });
      const p = gate.runRenderSlot(() => done, { jobId });
      return { release: () => release(), promise: p };
    };
    try {
      // 1) running create：即使占着渲染槽，也只软停止，不 interruptTask、不 /interrupt
      const createRun = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
      Jobs.update(createRun.id, { status: 'running', phase: '分镜视频' });
      const createHold = holdSlot(createRun.id);
      await tick();
      assert.equal(runner.holdsRenderSlot(createRun.id), true, '本例故意让 running create 占着槽，证明软停仍不打断');
      const rCreate = await runCancelLikeRoute(Jobs.get(createRun.id), spies.interruptSpy);
      assert.equal(rCreate.kind, 'soft-stop');
      assert.equal(rCreate.shouldInterrupt, false);
      assert.equal(spies.interruptCalls.length, 0, 'running create 软停不得调用 interruptTask');
      assert.equal(spies.interruptFetches().length, 0, 'running create 软停不得 fetch /interrupt');
      assert.equal(spies.port8189().length, 0);
      assert.equal(runner.isSoftStopped(createRun.id), true);
      assert.equal(runner.isAborted(createRun.id)(), false, '软停不得打 abortFlags，否则 generate() 会 /interrupt');
      assert.equal(Jobs.get(createRun.id).status, 'running');
      createHold.release();
      await createHold.promise;

      // 2) queued create：先用另一任务占满槽，本任务排队；stopJob 出队，shouldInterrupt 为假，interrupt 0
      const blocker = holdSlot('v41-blocker');
      await tick();
      const createQ = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第2章' } });
      Jobs.update(createQ.id, { status: 'queued', phase: '排队中' });
      let queuedRan = false;
      const queuedP = gate.runRenderSlot(async () => { queuedRan = true; }, { jobId: createQ.id });
      await tick();
      assert.equal(runner.holdsRenderSlot(createQ.id), false, '排队中尚未占槽');
      assert.equal(queuedRan, false);
      const rQ = await runCancelLikeRoute(Jobs.get(createQ.id), spies.interruptSpy);
      assert.equal(rQ.kind, 'hard-stop');
      assert.equal(rQ.shouldInterrupt, false);
      assert.equal(spies.interruptCalls.length, 0, 'queued create 出队不得调用 interruptTask');
      assert.equal(spies.interruptFetches().length, 0, 'queued create 出队不得 fetch /interrupt');
      await assert.rejects(queuedP, /任务已停止/);
      assert.equal(queuedRan, false, '被摘队的排队任务不得开跑');
      assert.equal(runner.isAborted(createQ.id)(), true, '排队出队会打硬停止标记，但任务不在 generate() 里');
      blocker.release();
      await blocker.promise;

      // 3) running llm / export：409，不打标记，interrupt 0
      for (const typ of ['llm', 'export']) {
        const j = Jobs.create({ projectId: p.id, type: typ, checkpoint: {} });
        Jobs.update(j.id, { status: 'running' });
        const r = await runCancelLikeRoute(Jobs.get(j.id), spies.interruptSpy);
        assert.equal(r.kind, 'reject-inline', typ + ' 必须 409');
        assert.equal(r.status, 409);
        assert.equal(r.shouldInterrupt, false);
        assert.equal(runner.isSoftStopped(j.id), false);
        assert.equal(runner.isAborted(j.id)(), false);
      }
      assert.equal(spies.interruptCalls.length, 0, 'llm/export 409 不得调用 interruptTask');
      assert.equal(spies.interruptFetches().length, 0, 'llm/export 409 不得 fetch /interrupt');
      assert.equal(spies.port8189().length, 0);

      // 4) 正对照：running 且占槽的非 create 任务，走硬停止，真实 interruptTask 会 fetch /interrupt（打向 :9，不打 8189）
      const hard = Jobs.create({ projectId: p.id, type: 'chapter-video', checkpoint: { chapter: '第3章' } });
      Jobs.update(hard.id, { status: 'running', phase: '分镜视频' });
      const hardHold = holdSlot(hard.id);
      await tick();
      assert.equal(runner.holdsRenderSlot(hard.id), true);
      const rHard = await runCancelLikeRoute(Jobs.get(hard.id), interruptTask);
      assert.equal(rHard.kind, 'hard-stop');
      assert.equal(rHard.shouldInterrupt, true);
      assert.equal(spies.interruptFetches().length, 1, '硬停止正对照必须 fetch /interrupt 一次');
      assert.equal(spies.interruptFetches()[0].method, 'POST');
      assert.match(String(spies.interruptFetches()[0].url), /127\.0\.0\.1:9\/interrupt/);
      assert.equal(spies.port8189().length, 0, '正对照也不得打到 8189');
      assert.equal(runner.isAborted(hard.id)(), true);
      hardHold.release();
      await hardHold.promise;
    } finally {
      spies.restore();
    }
  });
});
