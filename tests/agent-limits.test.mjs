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
