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

test('set_storyboard（Muse 出图项目）：名字找不到、或有未归档的同名资产，整批拒并列出名字；已归档的同名不算歧义', async () => {
  const p = core.Projects.create({ name: 'sb-strict' });
  core.Projects.setContextKey(p.id, 'asset_mode', 'gap-list');
  core.Projects.setContextKey(p.id, 'asset_binding', 'ic');
  const old = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  const live = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await assert.rejects(tools.runTool(ctx, 'set_storyboard', { shots: [{ idx: 1, visual: '画面', characters: ['江澈'] }] }), /多个同名资产[\s\S]*人物「江澈」/);
  core.Projects.setContextKey(p.id, 'archived_asset_ids', [old.id]);
  const ctx2 = tools.createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await assert.rejects(tools.runTool(ctx2, 'set_storyboard', { shots: [{ idx: 1, visual: '画面', characters: ['江澈', '小铭'] }] }), /找不到：人物「小铭」/);
  assert.equal(core.Shots.list(p.id).length, 0, '整批未写入');
  const out = await tools.runTool(ctx2, 'set_storyboard', { shots: [{ idx: 1, visual: '画面', characters: ['江澈'] }] });
  assert.match(String(out), /分镜已写入/);
  assert.deepEqual(core.Shots.list(p.id)[0].character_ids, [live.id], '绑到未归档的那个');
});

test('音色：只看本章出镜、说话的角色；从已归档的同名旧人物、参考项目导入音色（文件拷进本项目），找不到才交新设计', async () => {
  const ST = await import('../lib/agent/stages.js');
  const VI = await import('../lib/core/voice-import.js');
  const p = core.Projects.create({ name: 'voice-v3' });
  const v2 = core.Projects.create({ name: 'voice-v2' });
  const wv = (pid, name) => { const rel = 'assets/voice/' + name + '.wav'; const abs = path.join(core.projectDir(pid), rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'RIFF'); return rel; };
  const jc = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  const other = core.Assets.create(p.id, { category: 'character', name: '路人甲' });
  core.Shots.create(p.id, { idx: 1, chapter: '第1章', character_ids: [jc.id], dialogue: '江澈：你好' });
  // 本章只有江澈：路人甲没音色不挡本章
  const t1 = ST.pendingByStage(p.id, '第1章').tts.items;
  assert.ok(t1.some((x) => x.includes('江澈'))); assert.ok(!t1.some((x) => x.includes('路人甲')));
  // 参考项目里有同名江澈的音色 → 导入
  const v2jc = core.Assets.create(v2.id, { category: 'character', name: '江澈', voice_desc: '年轻男声，略疲惫' });
  core.Assets.update(v2jc.id, { voice_ref: wv(v2.id, 'v2jc') });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfg.assetAnalyze = { referenceProjects: { [p.id]: [v2.id] } }; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = VI.importMissingVoices(p.id);
  const got = r.find((x) => x.asset_id === jc.id);
  assert.equal(got.imported, true); assert.match(got.from, /参考项目/);
  const a = core.Assets.get(jc.id);
  assert.equal(a.voice_desc, '年轻男声，略疲惫'); assert.ok(fs.existsSync(path.join(core.projectDir(p.id), a.voice_ref)), '文件拷进本项目');
  assert.equal(r.find((x) => x.asset_id === other.id).skipped, '没找到同名的现成音色');
  assert.equal(ST.pendingByStage(p.id, '第1章').tts.todo, 0);
  // 已归档的同名旧人物优先
  const old = core.Assets.create(p.id, { category: 'character', name: '路人甲' }); core.Assets.update(old.id, { voice_ref: wv(p.id, 'oldlr') });
  core.Projects.setContextKey(p.id, 'archived_asset_ids', [old.id]);
  assert.match(VI.importVoice(p.id, other.id).from, /已归档/);
});
