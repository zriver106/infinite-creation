// set_storyboard 缺场景/服装/道具时的非致命提示（IC_CONFIG=:9 + 8188/8189 守卫）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sbwarn-'));
writeTempIcConfig(tmp);

let core, tools;
before(async () => {
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
});

function mk() {
  const p = core.Projects.create({ name: '绑定提示测试', auto_script: false });
  core.Projects.setContextKey(p.id, 'asset_binding', 'ic'); // 本组测 IC 自动绑定的提示（系统缺省已改为 Agent 绑定）
  core.Chapters.create(p.id, { title: '第26章', script: 'x' });
  const put = (rel, bytes) => {
    const abs = path.join(core.projectDir(p.id), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return rel;
  };
  const char = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  core.Assets.update(char.id, { image_path: put('assets/characters/c.png', 'c'), status: 'done' });
  const scene = core.Assets.create(p.id, { category: 'scene', name: '物业大厅' });
  core.Assets.update(scene.id, { image_path: put('assets/scenes/s.png', 's'), status: 'done' });
  const costume = core.Assets.create(p.id, { category: 'costume', name: '白T短裤', parent_id: char.id });
  core.Assets.update(costume.id, { image_path: put('assets/costumes/o.png', 'o'), status: 'done' });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第26章' });
  return { p, ctx, char, scene, costume };
}

test('未传 scenes/costumes 时写入成功，但结果里提示补绑', async () => {
  const { ctx } = mk();
  const out = await tools.runTool(ctx, 'set_storyboard', {
    shots: [{ chapter: '第26章', idx: 1, visual: '画面', characters: ['江澈'] }],
  });
  assert.match(String(out), /分镜已写入/);
  assert.match(String(out), /未绑定 scenes/);
  assert.match(String(out), /未绑定 costumes/);
  assert.match(String(out), /不拒绝/);
  const shots = core.Shots.list(ctx.projectId);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].character_ids.length, 1);
});

test('补绑后不再提示缺场景或服装', async () => {
  const { ctx } = mk();
  const out = await tools.runTool(ctx, 'set_storyboard', {
    shots: [{
      chapter: '第26章', idx: 1, visual: '画面',
      characters: ['江澈'], scenes: ['物业大厅'], costumes: ['白T短裤'],
    }],
  });
  assert.match(String(out), /分镜已写入/);
  assert.doesNotMatch(String(out), /未绑定 scenes/);
  assert.doesNotMatch(String(out), /未绑定 costumes/);
});

test('非 Muse 项目：名字对不上仍按原口径回报，不推翻整批', async () => {
  const { ctx } = mk();
  core.Projects.setContextKey(ctx.projectId, 'asset_mode', 'auto');
  const out = await tools.runTool(ctx, 'set_storyboard', {
    shots: [{ chapter: '第26章', idx: 1, visual: '画面', characters: ['不存在的人'], scenes: ['物业大厅'] }],
  });
  assert.match(String(out), /未找到同名资产/);
  assert.match(String(out), /分镜已写入/);
});
