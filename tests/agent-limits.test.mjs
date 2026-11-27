// 写稿并行（总导 11-26）：项目设置的各类型上限；写稿闸门按类型分开（剧本、分镜、提示词、资产、审图互不占位）；打分类技能 IC 不用。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-lim-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let L; let RG; let SE; let tools;
before(async () => {
  core = await import('../lib/core/index.js');
  L = await import('../lib/core/agent-limits.js');
  RG = await import('../lib/core/render-gate.js');
  SE = await import('../lib/agent/skill-engine.js');
  tools = await import('../lib/agent/tools.js');
});

test('上限：默认值；项目设置覆盖；规整拒绝不认识的类型和越界值', () => {
  const p = core.Projects.create({ name: 'lim' });
  assert.deepEqual(L.agentLimitsOf(p.id), { script: 2, storyboard: 3, prompt: 3, asset: 1, review: 2 });
  core.Projects.setContextKey(p.id, L.AGENT_LIMITS_KEY, { storyboard: 5, prompt: 99 });
  assert.equal(L.agentLimit(p.id, 'storyboard'), 5); assert.equal(L.agentLimit(p.id, 'prompt'), 8);
  const n = L.normalizeAgentLimits({ script: 3, foo: 1, review: 0 });
  assert.deepEqual(n.limits, { script: 3 }); assert.deepEqual(n.bad.sort(), ['foo', 'review']);
});

test('闸门按类型分开：分镜占满不挡剧本；同类型按上限排队', async () => {
  const hold = []; const started = [];
  const job = (kind, limit, name) => RG.runParallelText(() => { started.push(name); return new Promise((r) => hold.push(r)); }, () => false, { gateKey: kind, limit, jobId: name });
  const a = job('storyboard', 2, 'sb1'); const b = job('storyboard', 2, 'sb2'); const c = job('storyboard', 2, 'sb3');
  const d = job('script', 1, 'sc1');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(started.sort(), ['sb1', 'sb2', 'sc1'], '分镜上限 2，第 3 个排队；剧本不受分镜占位影响');
  hold.shift()();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(started.includes('sb3'));
  while (hold.length) hold.shift()();
  await Promise.all([a, b, c, d]);
});

test('打分类技能：IC 目录里不列、skill() / skill_reference / skill_lines 不给加载、关键词不路由', async () => {
  for (const n of ['short-drama-scriptwriting', 'sd-script-engine', 'script-master']) assert.equal(SE.icSkillAllowed(n), false);
  assert.equal(SE.icSkillAllowed('adapt-rules'), true);
  assert.notEqual(SE.routeSkill('台词诊断', ''), 'sd-script-engine');
  assert.notEqual(SE.routeSkill('微短剧剧本', ''), 'short-drama-scriptwriting');
  const p = core.Projects.create({ name: 'noscore' });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jns' });
  await assert.rejects(tools.runTool(ctx, 'skill', { name: 'short-drama-scriptwriting' }), /打分/);
  await assert.rejects(tools.runTool(ctx, 'skill_reference', { name: 'sd-script-engine', ref: 'roundtable-review.md' }), /打分/);
});

test('LLM 阶段待办：缺提示词、没绑场景、有台词没绑人物都算；Muse 出图项目不算资产提示词', async () => {
  const ST = await import('../lib/agent/stages.js');
  const p = core.Projects.create({ name: 'llm-pending' });
  core.Projects.setContextKey(p.id, 'asset_mode', 'gap-list');
  core.Assets.create(p.id, { category: 'scene', name: '办公室' });
  const sc = core.Assets.list(p.id)[0];
  core.Shots.create(p.id, { idx: 1, chapter: '第1章', dialogue: '江澈：你好', video_prompt: '' });
  core.Shots.create(p.id, { idx: 2, chapter: '第1章', scene_ids: [sc.id], video_prompt: 'x' });
  const llm = ST.pendingByStage(p.id, '第1章').llm;
  assert.ok(llm.items.includes('第1镜缺视频提示词'));
  assert.ok(llm.items.includes('第1镜没绑场景'));
  assert.ok(llm.items.includes('第1镜有台词但没绑人物'));
  assert.ok(!llm.items.some((x) => x.startsWith('第2镜')));
  assert.equal(llm.assetTodo, 0, 'Muse 出图不欠资产提示词');
  assert.equal(ST.LLM_MAX_ROUNDS, 4);
});
