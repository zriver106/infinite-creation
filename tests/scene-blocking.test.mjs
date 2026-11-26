// 站位表进写稿 brief（主会话 seq2215）：本镜地点 _MV 的说明整段放进 get_shot_prompt_brief.scene_blocking。临时数据目录，不碰真库、不起 CLI/GPU。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-blocking-'));
let core; let pwm; let bc; let cfgMod;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  cfgMod = await import('../lib/core/config.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
  bc = await import('../lib/agent/binding-check.js');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const BLOCK = 'D 平面：江澈坐东窗主桌朝西，许曼宁坐他对面；门在西南角；双人对话镜从 A 拍。';

function setup(name) {
  const { Projects, Chapters, Shots, Assets } = core;
  const p = Projects.create({ name, auto_script: false });
  Chapters.create(p.id, { title: '第8章', script: 's' });
  const dir = cfgMod.projectDir(p.id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 's.png'), PNG);
  const a1 = Assets.create(p.id, { category: 'character', name: '江澈' });
  const a2 = Assets.create(p.id, { category: 'character', name: '许曼宁' });
  const scene = Assets.create(p.id, { category: 'scene', name: 'S400·海鲜自助餐厅', description: '餐厅背景' });
  Assets.update(scene.id, { image_path: 'assets/s.png' });
  const mv = Assets.create(p.id, { category: 'scene', name: 'S400_MV·海鲜自助餐厅·多视角定义图', description: '我方资产ID：S400_MV；审核：final；' + BLOCK });
  Assets.update(mv.id, { image_path: 'assets/s.png' });
  const other = Assets.create(p.id, { category: 'scene', name: 'S163·开放式办公室', description: '办公室' });
  Assets.update(other.id, { image_path: 'assets/s.png' });
  const mk = (idx, extra) => Shots.create(p.id, { chapter: '第8章', idx, visual: 'v', dialogue: '', duration: 6, ...extra });
  const multi = mk(1, { character_ids: [a1.id, a2.id], scene_ids: [mv.id] });
  const single = mk(2, { character_ids: [a1.id], scene_ids: [scene.id] });
  const none = mk(3, { character_ids: [a1.id], scene_ids: [other.id] });
  return { p, mv, scene, multi, single, none };
}
const ctxOf = (p) => ({ projectId: p.id, jobId: 'j-none', chapter: '第8章', project: core.Projects.get(p.id), cfg: {} });

test('sceneBlockingOf：绑了 _MV → bound:true，说明去掉「我方资产ID/审核」前缀整段带上', () => {
  const w = setup('blk-1');
  const r = bc.sceneBlockingOf(core.Shots.get(w.multi.id), core.Assets.list(w.p.id));
  assert.equal(r.length, 1);
  assert.equal(r[0].mv_id, w.mv.id); assert.equal(r[0].bound, true); assert.equal(r[0].place, '海鲜自助餐厅');
  assert.equal(r[0].blocking, BLOCK);
});

test('sceneBlockingOf：单人镜只绑普通场景、地点有 _MV → 也带上，bound:false；地点没 _MV → 空', () => {
  const w = setup('blk-2');
  const assets = core.Assets.list(w.p.id);
  const r = bc.sceneBlockingOf(core.Shots.get(w.single.id), assets);
  assert.equal(r.length, 1); assert.equal(r[0].bound, false); assert.equal(r[0].blocking, BLOCK);
  assert.deepEqual(bc.sceneBlockingOf(core.Shots.get(w.none.id), assets), []);
  // 同时绑了普通场景和 _MV：只出一条，bound:true
  const both = bc.sceneBlockingOf({ scene_ids: [w.scene.id, w.mv.id] }, assets);
  assert.equal(both.length, 1); assert.equal(both[0].bound, true);
});

test('get_shot_prompt_brief 带 scene_blocking 字段和使用说明', async () => {
  const w = setup('blk-3');
  pwm._resetPromptWriteSession();
  const b1 = JSON.parse(await pwm.runPromptWriteExtraTool(ctxOf(w.p), 'get_shot_prompt_brief', { shot_id: w.multi.id }));
  assert.equal(b1.scene_blocking.length, 1); assert.equal(b1.scene_blocking[0].blocking, BLOCK);
  assert.match(b1.scene_blocking_rule, /站位表/);
  const b3 = JSON.parse(await pwm.runPromptWriteExtraTool(ctxOf(w.p), 'get_shot_prompt_brief', { shot_id: w.none.id }));
  assert.deepEqual(b3.scene_blocking, []);
});
