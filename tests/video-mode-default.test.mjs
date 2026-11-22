// 视频 mode 默认值 + prepareShotForRender 集成用例。
// IC_CONFIG 指向 :9，守卫拦截 8188/8189，upload 走 mock fetch，不提交渲染。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-videomode-'));
writeTempIcConfig(tmp);

// mock Comfy 上传：只接受 :9 的 /upload/，禁止 8188/8189（守卫已先拦）
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const href = String(url && url.href ? url.href : url);
  if (/:8188|:8189/.test(href)) throw new Error('fetch 守卫拦截了 8188/8189 请求：' + href);
  if (href.includes('/upload/')) {
    return new Response(JSON.stringify({ name: 'mock.png', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('测试禁止提交渲染：' + href);
};

let inferVideoMode, resolveShotVideoMode, prepareShotForRender, core, tools;

before(async () => {
  const wr = await import('../lib/core/workflow-runner.js');
  inferVideoMode = wr.inferVideoMode;
  resolveShotVideoMode = wr.resolveShotVideoMode;
  tools = await import('../lib/agent/tools.js');
  prepareShotForRender = tools.prepareShotForRender;
  core = await import('../lib/core/index.js');
});

test('空 mode + 1 人物图 + 1 场景图（EP17 #27 同类）默认 reference', () => {
  assert.equal(inferVideoMode([
    { type: 'image', filename: 'char.png', label: '人物' },
    { type: 'image', filename: 'scene.png', label: '场景' },
  ]), 'reference');
});

test('空 mode + 仅 1 张图默认 reference', () => {
  assert.equal(inferVideoMode([{ type: 'image', filename: 'scene.png' }]), 'reference');
});

test('空 mode + 2 张图且带音频 → reference', () => {
  assert.equal(inferVideoMode([
    { type: 'image', filename: 'char.png' },
    { type: 'image', filename: 'scene.png' },
    { type: 'audio', filename: 'voice.wav' },
  ]), 'reference');
});

test('0 媒体 → text', () => {
  assert.equal(inferVideoMode([]), 'text');
  assert.equal(inferVideoMode(null), 'text');
});

test('显式 mode 不被覆盖；空 mode 但有首尾帧路径 → first_last', () => {
  assert.equal(resolveShotVideoMode({ mode: 'image' }), 'image');
  assert.equal(resolveShotVideoMode({ mode: 'first_last' }), 'first_last');
  assert.equal(resolveShotVideoMode({ mode: 'reference' }), 'reference');
  assert.equal(resolveShotVideoMode({ mode: '', first_frame_path: 'a.png', last_frame_path: 'b.png' }), 'first_last');
  assert.equal(resolveShotVideoMode({ mode: '', first_frame_path: 'a.png' }), '');
});

function put(pid, rel, bytes) {
  const abs = path.join(core.projectDir(pid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return rel;
}

function mkProject() {
  const p = core.Projects.create({ name: 'mode-it', auto_script: false });
  core.Chapters.create(p.id, { title: '第17章', script: 'x' });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第17章' });
  ctx.cfg.comfyui = { url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9', provider: 'native' };
  return { p, ctx };
}

test('prepareShotForRender：空 mode + 人物和场景参考图 → reference（不提交渲染）', async () => {
  const { p, ctx } = mkProject();
  const char = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  core.Assets.update(char.id, { image_path: put(p.id, 'assets/characters/c.png', 'CHAR'), status: 'done' });
  const scene = core.Assets.create(p.id, { category: 'scene', name: '牡丹厅' });
  core.Assets.update(scene.id, { image_path: put(p.id, 'assets/scenes/s.png', 'SCENE'), status: 'done' });
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '空厅', mode: '' });
  core.Shots.update(shot.id, { character_ids: [char.id], scene_ids: [scene.id], video_prompt: 'a man in a hall' });
  const prepared = await prepareShotForRender(ctx, shot.id, { render: true });
  assert.equal(prepared.mode, 'reference');
  assert.ok(!prepared.done);
});

test('prepareShotForRender：空 mode 但同时有首帧+尾帧路径 → first_last', async () => {
  const { p, ctx } = mkProject();
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '首尾', mode: '' });
  const first = put(p.id, 'frames/first.png', 'FIRST');
  const last = put(p.id, 'frames/last.png', 'LAST');
  core.Shots.update(shot.id, { first_frame_path: first, last_frame_path: last, video_prompt: 'from a to b' });
  const prepared = await prepareShotForRender(ctx, shot.id, { render: true });
  assert.equal(prepared.mode, 'first_last');
  assert.equal((prepared.references || []).length, 2);
});

test('prepareShotForRender：空 mode 且无任何图像绑定 → text', async () => {
  const { p, ctx } = mkProject();
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '文生', mode: '' });
  core.Shots.update(shot.id, { video_prompt: 'an empty street at night' });
  const prepared = await prepareShotForRender(ctx, shot.id, { render: true });
  assert.equal(prepared.mode, 'text');
  assert.equal((prepared.references || []).length, 0);
});

test('prepareShotForRender：显式 mode=image 保留', async () => {
  const { p, ctx } = mkProject();
  const rel = put(p.id, 'frames/ref.png', 'REF');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '图生', mode: 'image' });
  core.Shots.update(shot.id, { mode: 'image', reference_image_path: rel, video_prompt: 'a still image becomes video' });
  const prepared = await prepareShotForRender(ctx, shot.id, { render: true });
  assert.equal(prepared.mode, 'image');
});
