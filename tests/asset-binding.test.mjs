// 系统设置「资产绑定方式」（generation.assetBindingSource，缺省 ag）与出片口缺绑检查（A/B/C，缺省只报不拦）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bind-'));
writeTempIcConfig(tmp);

let core, tools, bc, ac;
before(async () => {
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
  bc = await import('../lib/agent/binding-check.js');
  ac = await import('../lib/agent/asset-check.js');
});

function mk(binding) {
  const p = core.Projects.create({ name: '绑定开关测试', auto_script: false });
  if (binding) core.Projects.setContextKey(p.id, 'asset_binding', binding);
  core.Chapters.create(p.id, { title: '第26章', script: 'x' });
  const A = (category, name, extra = {}) => core.Assets.create(p.id, { category, name, ...extra });
  const jc = A('character', '甲'); const yz = A('character', '乙');
  const scene = A('scene', '餐厅'); const mv = A('scene', 'S9_MV·餐厅·多视角定义图');
  const lone = A('scene', '路边');
  const jcCos = A('costume', '甲·便装', { parent_id: jc.id });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第26章' });
  return { p, ctx, jc, yz, scene, mv, lone, jcCos };
}

test('ag（外部绑）：set_storyboard 不写绑定，已有绑定原样保留，并在返回里写明', async () => {
  const { p, ctx, jc, scene } = mk();
  core.Projects.setContextKey(p.id, 'asset_binding', 'ag'); // 新建项目默认已改成 ic（总导 11-26），这里显式设外部绑
  core.Projects.setContextKey(p.id, 'asset_mode', 'auto');
  assert.equal(ac.icAutoBindOn(p.id), false);
  await tools.runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第26章', idx: 1, visual: '画面', characters: ['甲'], scenes: ['餐厅'] }] });
  let s = core.Shots.list(p.id)[0];
  assert.deepEqual(s.character_ids || [], []);
  assert.deepEqual(s.scene_ids || [], []);
  core.Shots.update(s.id, { character_ids: [jc.id], scene_ids: [scene.id] }); // Agent 绑定
  await tools.runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第26章', idx: 1, visual: '画面2', characters: ['乙'], scenes: ['路边'] }] });
  s = core.Shots.get(s.id);
  assert.deepEqual(s.character_ids, [jc.id], '重写分镜不改 Agent 已绑的人物');
  assert.deepEqual(s.scene_ids, [scene.id]);
});

test('项目设 ic：照旧按名字自动绑定', async () => {
  const { p, ctx, jc, scene } = mk('ic');
  await tools.runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第26章', idx: 1, visual: '画面', characters: ['甲'], scenes: ['餐厅'] }] });
  const s = core.Shots.list(p.id)[0];
  assert.deepEqual(s.character_ids, [jc.id]);
  assert.deepEqual(s.scene_ids, [scene.id]);
});

test('缺绑检查：A 缺场景', () => {
  const { p, jc, jcCos } = mk();
  const r = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: [jc.id], scene_ids: [], costume_ids: [jcCos.id] });
  assert.ok(r.issues.some((i) => i.level === 'A' && i.kind === 'scene'));
  assert.equal(r.blocking, true);
});

test('缺绑检查：B 有服装没绑；C 没服装资产', () => {
  const { p, jc, yz, scene } = mk();
  const r = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: [jc.id], scene_ids: [scene.id], costume_ids: [] });
  assert.ok(r.issues.some((i) => i.level === 'B' && i.kind === 'costume'));
  const r2 = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: [yz.id], scene_ids: [scene.id], costume_ids: [] });
  assert.ok(r2.issues.some((i) => i.level === 'C' && i.kind === 'costume'));
  assert.equal(r2.blocking, false, '只有 C 级不算拦截项');
});

test('缺绑检查：多人镜地点有 _MV 没绑 → B；地点没 _MV → C；绑了 _MV → 不报', () => {
  const { p, jc, yz, scene, mv, lone } = mk();
  const two = [jc.id, yz.id];
  const b = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: two, scene_ids: [scene.id], costume_ids: [] });
  assert.ok(b.issues.some((i) => i.level === 'B' && i.kind === 'mv'));
  const c = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: two, scene_ids: [lone.id], costume_ids: [] });
  assert.ok(c.issues.some((i) => i.level === 'C' && i.kind === 'mv'));
  const ok = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: two, scene_ids: [mv.id], costume_ids: [] });
  assert.ok(!ok.issues.some((i) => i.kind === 'mv'));
});

test('缺绑检查：绑全了放行', () => {
  const { p, jc, scene, jcCos } = mk();
  const r = bc.checkShotBindings({ project_id: p.id, idx: 1, character_ids: [jc.id], scene_ids: [scene.id], costume_ids: [jcCos.id] });
  assert.deepEqual(r.issues, []);
});

test('出片口：缺省只报不拦；打开缺绑拦截后 A/B 拦这一镜', async () => {
  const { p, ctx } = mk();
  const shot = core.Shots.create(p.id, { chapter: '第26章', idx: 1, visual: '画面', dialogue: '', video_prompt: 'a quiet street' });
  const reports = []; ctx.report = (x) => reports.push(x);
  ctx.cfg.generation = { ...(ctx.cfg.generation || {}), bindingCheckBlock: false };
  // 缺省：不因缺绑抛 BINDING_MISSING（后面可能因别的原因失败，这里只看不是缺绑拦截）
  await tools.prepareShotForRender(ctx, shot.id, { render: true }).catch((e) => assert.notEqual(e.code, 'BINDING_MISSING'));
  assert.ok(reports.some((r) => r.phase === '缺绑检查' && /A·/.test(r.detail)), '缺场景要上报');
  ctx.cfg.generation.bindingCheckBlock = true;
  await assert.rejects(() => tools.prepareShotForRender(ctx, shot.id, { render: true }), (e) => e.code === 'BINDING_MISSING');
});

test('基础形象豁免：豁免段内的人物不报 B/C，段外照报', () => {
  const { p, jc, yz, scene } = mk();
  const shot = (idx, chapter = '第26章') => ({ project_id: p.id, idx, chapter, character_ids: [jc.id, yz.id], scene_ids: [scene.id], costume_ids: [] });
  const { out, errors } = bc.normalizeCostumeBase([
    { character_id: jc.id.slice(0, 8), chapter: 26, from: 1, to: 3 },
    { character_id: yz.id, chapter: '第26章' },
    { character_id: 'abc', chapter: 26 },
  ]);
  assert.equal(out.length, 2); assert.equal(errors.length, 1);
  core.Projects.setContextKey(p.id, bc.COSTUME_BASE_KEY, out);
  const inRange = bc.checkShotBindings(shot(2));
  assert.ok(!inRange.issues.some((i) => i.kind === 'costume'), '甲 1–3 镜、乙全章都豁免');
  const outRange = bc.checkShotBindings(shot(5));
  assert.ok(outRange.issues.some((i) => i.level === 'B' && i.kind === 'costume' && /甲/.test(i.detail)), '甲第 5 镜不在豁免段，照报 B');
  assert.ok(!outRange.issues.some((i) => /乙/.test(i.detail) && i.kind === 'costume'));
  const otherCh = bc.checkShotBindings(shot(2, '第27章'));
  assert.ok(otherCh.issues.some((i) => /乙/.test(i.detail) && i.level === 'C'), '别的章不豁免');
});

test('新建项目默认 IC 自己绑', () => {
  const p = core.Projects.create({ name: 'bind-default' });
  assert.equal(ac.icAutoBindOn(p.id), true);
});
