// ic23 按章加锁单测（2026-11-17）：临时数据目录 + 临时配置；ComfyUI 用 mock fetch（提交请求被「卡住」模拟
// 长时间渲染），不起真进程、不碰 8188/8189、不碰真实 data/ic.db。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-renderlock-'));
let core, tools, oj, rl, mcpCfg;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9', provider: 'native' }, generation: { videosPerShot: 1 }, agent: { runtime: 'openclaude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  process.env.IC_ASSET_PRECHECK = 'off';
  delete process.env.IC_DISABLE_CHAPTER_RENDER_LOCK;
  delete process.env.IC_CHAPTER_LOCK_WAIT_MIN;
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
  oj = await import('../lib/agent/orphan-jobs.js');
  rl = await import('../lib/core/render-lock.js');
  mcpCfg = await import('../lib/agent/external/mcp-config.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const DEAD_PID = 2147483000; // 不存在的 pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个能直接出片的章节：一个已就绪角色 + n 镜（都有提示词）
function mkChapter(name, n = 1, chapter = '第1章') {
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

// mock ComfyUI：上传参考图成功；其余请求（提交渲染）记一次，然后卡在 gate 上，放行后抛错（镜头记 failed）
function mockComfy() {
  const orig = globalThis.fetch;
  const submitted = [];
  let open;
  let gate = new Promise((r) => { open = r; });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/upload/')) return new Response(JSON.stringify({ name: 'x.png', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
    submitted.push(String(url));
    await gate;
    throw new Error('模拟 ComfyUI 不可达');
  };
  return {
    submitted,
    release: () => open(),
    restore: () => { globalThis.fetch = orig; },
    waitSubmitted: async (n, ms = 5000) => { const end = Date.now() + ms; while (submitted.length < n && Date.now() < end) await sleep(20); return submitted.length; },
  };
}

function ctxFor(p, jobId = '') {
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId });
  ctx.cfg.comfyui.provider = 'native';
  ctx.cfg.generation.videosPerShot = 1;
  ctx.reports = [];
  ctx.report = (x) => { ctx.reports.push(x); };
  return ctx;
}

function writeForeignLock(key, info, mtimeMs = Date.now()) {
  const f = rl.renderLockFile(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ key, token: 'foreign-' + Math.random(), startedAt: Date.now(), ...info }));
  const d = new Date(mtimeMs);
  fs.utimesSync(f, d, d);
  return f;
}

// ───────────────────────── render-lock 模块 ─────────────────────────

test('租约锁：拿到/再拿冲突/释放后可再拿；释放时写 last 结果', () => {
  const key = rl.chapterRenderLockKey('p-unit', '第1章');
  const a = rl.tryAcquireRenderLock(key, { jobId: 'J1' });
  assert.equal(a.ok, true);
  assert.equal(rl.holdsRenderLock(key), true);
  const b = rl.tryAcquireRenderLock(key, { jobId: 'J2' });
  assert.equal(b.ok, false);
  assert.equal(b.state.stale, false);
  assert.equal(b.state.info.jobId, 'J1');
  a.release({ text: '{"ok":1}', force: false });
  assert.equal(fs.existsSync(rl.renderLockFile(key)), false);
  assert.equal(rl.holdsRenderLock(key), false);
  assert.equal(rl.readRenderLockLast(key).result.text, '{"ok":1}');
  const c = rl.tryAcquireRenderLock(key, {});
  assert.equal(c.ok, true);
  c.release();
});

test('租约锁不会永久卡死：持有进程已死 / 心跳过期 / pid 被本进程复用但并未持有 → 判死接管并记账', () => {
  const k1 = rl.chapterRenderLockKey('p-stale', '死进程');
  writeForeignLock(k1, { pid: DEAD_PID, jobId: 'old' });
  assert.equal(rl.renderLockState(k1).reason, 'owner-dead');
  const a = rl.tryAcquireRenderLock(k1, {});
  assert.equal(a.ok, true, '死进程的锁应被接管');
  a.release();

  const k2 = rl.chapterRenderLockKey('p-stale', '心跳过期');
  writeForeignLock(k2, { pid: process.ppid, jobId: 'hung' }, Date.now() - 10 * 60 * 1000);
  assert.equal(rl.renderLockState(k2).reason, 'heartbeat-stale');
  const b = rl.tryAcquireRenderLock(k2, {});
  assert.equal(b.ok, true);
  b.release();

  const k3 = rl.chapterRenderLockKey('p-stale', 'pid复用');
  writeForeignLock(k3, { pid: process.pid, jobId: 'prev-boot' });
  assert.equal(rl.renderLockState(k3).reason, 'self-not-holding');
  const c = rl.tryAcquireRenderLock(k3, {});
  assert.equal(c.ok, true);
  c.release();

  // 活着且心跳新鲜的别的进程：不接管
  const k4 = rl.chapterRenderLockKey('p-stale', '活进程');
  writeForeignLock(k4, { pid: process.ppid, jobId: 'alive' });
  const d = rl.tryAcquireRenderLock(k4, {});
  assert.equal(d.ok, false);
  assert.equal(d.state.stale, false);
  fs.rmSync(rl.renderLockFile(k4), { force: true });

  const log = fs.readFileSync(rl.renderLockLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const reasons = log.filter((e) => e.action === 'takeover').map((e) => e.reason);
  for (const r of ['owner-dead', 'heartbeat-stale', 'self-not-holding']) assert.ok(reasons.includes(r), r);
});

test('心跳：持有期间刷新 mtime（不会被误判过期）', async () => {
  const key = rl.shotRenderLockKey('hb-shot');
  const a = rl.tryAcquireRenderLock(key, {});
  const f = rl.renderLockFile(key);
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(f, old, old);
  // 直接调用心跳的效果等同：这里只验证判定用的是 mtime，且 staleMs 可调
  assert.equal(rl.renderLockState(key, { staleMs: 30 * 1000 }).reason, 'heartbeat-stale');
  assert.equal(rl.renderLockState(key, { staleMs: 120 * 1000 }).stale, false);
  a.release();
});

test('紧急开关与 MCP 环境：IC_DISABLE_CHAPTER_RENDER_LOCK 只在设了时才带给 MCP 子进程', () => {
  assert.equal(rl.renderLockDisabled({}), false);
  assert.equal(rl.renderLockDisabled({ IC_DISABLE_CHAPTER_RENDER_LOCK: '1' }), true);
  const base = mcpCfg.mcpEnv({ projectId: 'p', jobId: 'j' });
  assert.equal('IC_DISABLE_CHAPTER_RENDER_LOCK' in base, false, '平时 MCP 环境与之前完全一致');
  process.env.IC_DISABLE_CHAPTER_RENDER_LOCK = '1';
  try { assert.equal(mcpCfg.mcpEnv({ projectId: 'p', jobId: 'j' }).IC_DISABLE_CHAPTER_RENDER_LOCK, '1'); }
  finally { delete process.env.IC_DISABLE_CHAPTER_RENDER_LOCK; }
  assert.equal(tools.chapterLockWaitMs({ IC_MCP_PROJECT_ID: 'x' }), 25 * 60 * 1000, 'MCP 子进程里要短于 Claude Code 的 30 分钟空闲超时');
  assert.equal(tools.chapterLockWaitMs({}), 360 * 60 * 1000);
  assert.equal(tools.chapterLockWaitMs({ IC_CHAPTER_LOCK_WAIT_MIN: '2' }), 2 * 60 * 1000);
});

// ───────────────────────── generate_chapter_videos 按章加锁 ─────────────────────────

test('第16–19章复盘：上一次批量还在跑时重调 → 不重复提交渲染，等它跑完并返回它的结果', async () => {
  const { p, shots } = mkChapter('复盘-超时重调', 1);
  const m = mockComfy();
  try {
    const ctx1 = ctxFor(p, 'job-A');
    const ctx2 = ctxFor(p, 'job-A');
    const first = tools.runTool(ctx1, 'generate_chapter_videos', { chapter: '第1章' });
    assert.equal(await m.waitSubmitted(1), 1, '前提：第一次已提交第1镜');
    const second = tools.runTool(ctx2, 'generate_chapter_videos', { chapter: '第1章' }); // 「30 分钟超时后重调」
    await sleep(300);
    assert.equal(m.submitted.length, 1, '重调期间不得再提交');
    m.release();
    const r1 = JSON.parse(await first);
    const r2 = JSON.parse(await second);
    assert.equal(m.submitted.length, 1, '整个过程同一镜只提交一次');
    assert.equal(r1.total, 1);
    assert.equal(r2.joined, true);
    assert.equal(r2.duplicate_suppressed, true);
    assert.equal(r2.total, r1.total);
    assert.equal(r2.failed, r1.failed);
    assert.ok(ctx2.reports.some((x) => /已有批量生成在跑/.test(x.detail || '')));
    assert.equal(fs.existsSync(rl.renderLockFile(rl.chapterRenderLockKey(p.id, '第1章'))), false, '跑完锁已释放');
    assert.equal(core.ShotVideos.listByShot(shots[0].id).length, 0);
  } finally { m.restore(); m.release(); }
});

test('等待超时：返回 running=true + 进度（remaining>0），不提交、不改分镜', async () => {
  const { p } = mkChapter('等待超时', 2);
  const m = mockComfy();
  process.env.IC_CHAPTER_LOCK_WAIT_MIN = '0.01'; // 0.6 秒
  try {
    const first = tools.runTool(ctxFor(p, 'job-B'), 'generate_chapter_videos', { chapter: '第1章' });
    await m.waitSubmitted(1);
    const r2 = JSON.parse(await tools.runTool(ctxFor(p, 'job-B'), 'generate_chapter_videos', { chapter: '第1章' }));
    assert.equal(r2.running, true);
    assert.equal(r2.total, 2);
    assert.ok(r2.remaining > 0, '不能让 Agent 以为跑完了去合成');
    assert.equal(r2.in_progress.owner_job, 'job-B');
    assert.equal(r2.in_progress.generating, 1);
    assert.equal(r2.in_progress.pending, 1);
    assert.match(r2.note, /不要 assemble_video/);
    assert.equal(m.submitted.length, 1);
    m.release();
    await first;
  } finally { delete process.env.IC_CHAPTER_LOCK_WAIT_MIN; m.restore(); m.release(); }
});

test('跨进程：另一进程持有同章锁 → 本次等待；它正常结束留下结果 → 直接返回，不空跑', async () => {
  const { p } = mkChapter('跨进程', 1);
  const key = rl.chapterRenderLockKey(p.id, '第1章');
  const modUrl = pathToFileURL(path.join(HERE, '..', 'lib', 'core', 'render-lock.js')).href;
  const code = `const rl = await import(${JSON.stringify(modUrl)});
    const lk = rl.tryAcquireRenderLock(${JSON.stringify(key)}, { jobId: 'job-child', chapter: '第1章' });
    if (!lk.ok) { console.log('NOLOCK'); process.exit(2); }
    console.log('LOCKED');
    await new Promise((r) => setTimeout(r, 1500));
    lk.release({ text: JSON.stringify({ chapter: '第1章', total: 1, generated: 1, failed: 0, remaining: 0 }), force: false });
    console.log('RELEASED');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((r) => child.on('close', r)); // 先挂监听：子进程可能在本次调用返回前就退出了
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const end = Date.now() + 10000;
  while (!out.includes('LOCKED') && Date.now() < end) await sleep(20);
  assert.ok(out.includes('LOCKED'), '子进程拿到锁：' + out);
  const m = mockComfy();
  try {
    const r = JSON.parse(await tools.runTool(ctxFor(p, 'job-parent'), 'generate_chapter_videos', { chapter: '第1章' }));
    assert.equal(r.joined, true);
    assert.equal(r.generated, 1);
    assert.equal(r.joined_job, 'job-child');
    assert.equal(m.submitted.length, 0, '另一进程在跑时本进程不得提交');
  } finally { m.restore(); m.release(); }
  await closed;
});

test('持有者已死（进程崩溃/被强杀）→ 锁被接管，照常出片', async () => {
  const { p } = mkChapter('死锁接管', 1);
  writeForeignLock(rl.chapterRenderLockKey(p.id, '第1章'), { pid: DEAD_PID, jobId: 'crashed' });
  const m = mockComfy();
  m.release();
  try {
    const r = JSON.parse(await tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' }));
    assert.equal(r.total, 1);
    assert.equal(r.joined, undefined);
    assert.equal(m.submitted.length, 1);
  } finally { m.restore(); }
});

test('force 请求遇到非 force 的在跑批量：等它跑完后自己再跑（用户要的是全部重出）', async () => {
  const { p } = mkChapter('force', 1);
  const m = mockComfy();
  try {
    const first = tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' });
    await m.waitSubmitted(1);
    const second = tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章', force: true });
    await sleep(300);
    assert.equal(m.submitted.length, 1, '在跑期间不并发');
    m.release();
    await first;
    const r2 = JSON.parse(await second);
    assert.equal(r2.joined, undefined);
    assert.equal(m.submitted.length, 2, 'force 的那次在前一次结束后才提交');
  } finally { m.restore(); m.release(); }
});

test('单镜锁：镜头已在生成中 → generate_shot_video 不重复提交；批量循环跳过它且不记失败', async () => {
  const { p, shots } = mkChapter('单镜锁', 2);
  const busy = rl.tryAcquireRenderLock(rl.shotRenderLockKey(shots[0].id), { jobId: 'other', via: 'shot' });
  assert.equal(busy.ok, true);
  const m = mockComfy();
  m.release();
  try {
    const r = JSON.parse(await tools.runTool(ctxFor(p), 'generate_shot_video', { shot_id: shots[0].id }));
    assert.equal(r.skipped, true);
    assert.equal(r.in_progress, true);
    assert.equal(r.owner_job, 'other');
    assert.equal(m.submitted.length, 0);
    const before = core.Shots.get(shots[0].id).status;
    const b = JSON.parse(await tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' }));
    assert.deepEqual(b.skipped_busy, [shots[0].idx]);
    assert.equal(m.submitted.length, 1, '只提交了没被占用的第2镜');
    assert.equal(core.Shots.get(shots[0].id).status, before, '被占用的镜不标 generating / failed');
    assert.ok(b.remaining >= 1);
  } finally { busy.release(); m.restore(); }
});

test('批量开跑后某镜已被别的调用出完 → 跳过，不重复渲染', async () => {
  const { p, shots } = mkChapter('中途出完', 2);
  const m = mockComfy();
  try {
    const first = tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' });
    await m.waitSubmitted(1);
    // 第1镜渲染期间，模拟第2镜被单镜入口出完
    core.Shots.update(shots[1].id, { status: 'done', video_path: 'videos/x.mp4', video_prompt_used: core.Shots.get(shots[1].id).video_prompt });
    m.release();
    const r = JSON.parse(await first);
    assert.deepEqual(r.skipped_done, [shots[1].idx]);
    assert.equal(m.submitted.length, 1);
  } finally { m.restore(); m.release(); }
});

test('紧急开关 IC_DISABLE_CHAPTER_RENDER_LOCK=1：回到原行为（不加锁，两次调用各自提交）', async () => {
  const { p } = mkChapter('开关', 1);
  const m = mockComfy();
  process.env.IC_DISABLE_CHAPTER_RENDER_LOCK = '1';
  try {
    const a = tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' });
    await m.waitSubmitted(1);
    const b = tools.runTool(ctxFor(p), 'generate_chapter_videos', { chapter: '第1章' });
    // 关掉锁时第二次照旧提交（这正是 ic23 之前的重复渲染）；本地闸门串行，等第一次放行后它才会提交
    m.release();
    await a; await b;
    assert.equal(m.submitted.length, 2);
    assert.equal(fs.existsSync(rl.renderLockDir()) ? fs.readdirSync(rl.renderLockDir()).filter((n) => n.endsWith('.lock.json')).length : 0, 0, '开关关闭时不建锁文件');
  } finally { delete process.env.IC_DISABLE_CHAPTER_RENDER_LOCK; m.restore(); m.release(); }
});

// ───────────────────────── 与 ic21 启动收尾的结合 ─────────────────────────

test('启动收尾：清掉持有者已死的锁、保留持有者还活着的锁；orphan-jobs.jsonl 不因此多记', () => {
  const dead = writeForeignLock(rl.chapterRenderLockKey('p-sweep', '第1章'), { pid: DEAD_PID, jobId: 'gone' });
  const alive = writeForeignLock(rl.chapterRenderLockKey('p-sweep', '第2章'), { pid: process.ppid, jobId: 'still-running' });
  fs.writeFileSync(dead.replace('.lock.json', '.lock.json.stale-1-1'), '{}'); // 接管途中崩溃的残片
  const orphanLog = oj.orphanLogFile();
  const beforeLines = fs.existsSync(orphanLog) ? fs.readFileSync(orphanLog, 'utf8') : '';
  const settled = oj.settleOrphanQueuedJobs({ since: Date.now() });
  assert.deepEqual(settled, [], '没有孤儿任务时返回值不变');
  assert.equal(fs.existsSync(dead), false, '死锁已清');
  assert.equal(fs.existsSync(alive), true, '活锁保留');
  assert.equal(fs.readdirSync(rl.renderLockDir()).some((n) => /\.stale-/.test(n)), false, '残片已清');
  const afterLines = fs.existsSync(orphanLog) ? fs.readFileSync(orphanLog, 'utf8') : '';
  assert.equal(afterLines, beforeLines, 'orphan-jobs.jsonl 只记任务');
  const log = fs.readFileSync(rl.renderLockLogFile(), 'utf8');
  assert.match(log, /sweep-released/);
  fs.rmSync(alive, { force: true });
});

test('紧急开关打开时启动收尾不动锁', () => {
  const dead = writeForeignLock(rl.chapterRenderLockKey('p-sweep2', '第1章'), { pid: DEAD_PID });
  process.env.IC_DISABLE_CHAPTER_RENDER_LOCK = '1';
  try { assert.deepEqual(oj.sweepRenderLocksAtStartup(), []); } finally { delete process.env.IC_DISABLE_CHAPTER_RENDER_LOCK; }
  assert.equal(fs.existsSync(dead), true);
  fs.rmSync(dead, { force: true });
});
