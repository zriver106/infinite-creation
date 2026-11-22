// 「本章资产齐全检查 / 缺件单」单测（2026-11-17 最小版）：临时数据目录 + 临时资料根（资产表/别名表/缺件单都在临时目录），
// 不碰真实 data/ic.db、不碰真实项目资料目录、不调 LLM / ComfyUI / TTS。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ac-'));
const root = path.join(tmp, '资料根');
let core; let ac; let stages; let tools; let pw; let jr;
let pid; let ch; let A = {};

function put(rel, content) { const f = path.join(core.projectDir(pid), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return rel; }

before(async () => {
  fs.mkdirSync(path.join(root, '资产', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(root, '资产', 'voice', 'C001_V.wav'), 'RIFF');
  fs.writeFileSync(path.join(root, '资产', 'assets.csv'), [
    '# 资产表（测试）',
    'id,pid,rel,type,name,var,file,rest,ch,cert,review,miss,note,描述,属性',
    'C001_B,C001,,char,江澈,B,char/C001_B.png,,1-99,,ok,,,,',
    'C001_V,C001,,voice,江澈,,voice/C001_V.wav,,1-99,,ok,,,,',
    'C020_B,C020,,char,江父,B,,,1-99,,,miss,,,',
    'C020_V,C020,,voice,江父,,,,1-99,,,miss,,,',
    'C045_B,C045,,char,4S销售经理,B,,,11,,,miss,,,',
    'S001,S001,,scene,4S店,,,,11,,,miss,,,',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { url: 'http://127.0.0.1:9' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = path.join(tmp, 'config.json');
  core = await import('../lib/core/index.js');
  ac = await import('../lib/agent/asset-check.js');
  stages = await import('../lib/agent/stages.js');
  tools = await import('../lib/agent/tools.js');
  pw = await import('../lib/agent/prompt-write.js');
  jr = await import('../lib/agent/job-runner.js');

  pid = core.Projects.create({ name: '资产检查测试', auto_script: false }).id;
  core.Projects.setContextKey(pid, 'asset_root', root);
  ch = core.Chapters.create(pid, { title: '第11章', script: '【第1场｜日｜4S店】\n出场人物：江澈、4S销售经理\n江澈：我看看车。\n' });
  const mk = (category, name, extra = {}) => { const a = core.Assets.create(pid, { category, name, ...(extra.parent_id ? { parent_id: extra.parent_id } : {}) }); return a; };
  A.jc = mk('character', '江澈'); A.fa = mk('character', '江父'); A.sm = mk('character', '4S销售经理'); A.gen = mk('character', '路人甲');
  A.scene = mk('scene', '4S店'); A.vjc = mk('voice', '江澈音色');
  A.other = mk('character', '别章人物');
  const img = (a, src = 'uploaded') => { const rel = put('assets/character/' + a.id + '.png', 'PNG'); core.Assets.update(a.id, { image_path: rel, status: 'done', source: src }); };
  img(A.jc); img(A.fa); img(A.sm); img(A.gen, 'generated'); img(A.other);
  core.Assets.update(A.vjc.id, { status: 'done', audio_path: put('assets/voice/vjc.wav', 'RIFF') });
  core.Shots.create(pid, { chapter: '第11章', idx: 1, character_ids: [A.jc.id, A.sm.id], scene_ids: [A.scene.id], dialogue: '江澈：我看看车。\n4S销售经理：欢迎光临。' });
  core.Shots.create(pid, { chapter: '第11章', idx: 2, character_ids: [A.fa.id, A.gen.id], dialogue: '江父：嗯。' });
});

test('auto 模式（缺省）：不检查、不挡、gapListOn=false', () => {
  const p2 = core.Projects.create({ name: '别的项目' }).id;
  core.Chapters.create(p2, { title: '测试章A' });
  assert.equal(ac.gapListOn(p2), false);
  assert.equal(ac.assetGateBeforeRun(p2, '测试章A'), null);
  assert.equal(ac.readAssetCheckSettings(core.Projects.get(p2)).mode, 'auto');
  assert.equal(ac.readAssetCheckSettings(core.Projects.get(p2)).gate, 'B');
});

test('asset_root 缺省 = delivery_dir 的上级（交付）', () => {
  const s = ac.readAssetCheckSettings({ context: { delivery_dir: path.join(tmp, 'X', '交付') } });
  assert.equal(s.root, path.join(tmp, 'X'));
  assert.equal(ac.readAssetCheckSettings({ context: { delivery_dir: path.join(tmp, 'X', 'out') } }).root, '');
});

test('检查：图片缺件、音色三种口径、IC 自生成进复核、可登记音色、只看本章', () => {
  core.Projects.setContextKey(pid, 'asset_mode', 'gap-list');
  const r = ac.checkChapterAssets(pid, '第11章');
  assert.equal(r.phase, 'storyboard');
  assert.equal(r.state, 'missing');
  const miss = (t, n) => r.missing.find((m) => m.type === t && m.name === n);
  assert.ok(miss('scene', '4S店'), '场景无图要缺件');
  assert.deepEqual(miss('scene', '4S店').shots, [1]);
  assert.equal(miss('voice', '4S销售经理').voice_policy, 'ic_generate');
  assert.equal(miss('voice', '江父').voice_policy, 'asset_mgmt');
  assert.deepEqual(r.voice_plan.map((v) => v.asset_id), [A.sm.id], '只有资产表无音色行的台词角色进 voice_plan');
  assert.equal(r.linkable.length, 1);
  assert.equal(r.linkable[0].character_id, A.jc.id);
  assert.ok(r.review.some((x) => x.asset_id === A.gen.id), 'IC 自生成单列待复核');
  assert.ok(!r.missing.some((m) => m.name === '别章人物') && !r.ok.some((m) => m.name === '别章人物'));
  assert.ok(r.missing.find((m) => m.type === 'scene').spec.views);
});

test('人物缺图要三视图规格；别名表匹配', () => {
  const extra = core.Shots.create(pid, { chapter: '第11章', idx: 3, character_ids: [], dialogue: '' });
  core.Assets.update(A.sm.id, { image_path: '' });
  let r = ac.checkChapterAssets(pid, '第11章');
  const m = r.missing.find((x) => x.type === 'character' && x.name === '4S销售经理');
  assert.deepEqual(m.spec.views, ['正面全身', '侧面全身', '背面全身']);
  core.Assets.update(A.sm.id, { image_path: 'assets/character/' + A.sm.id + '.png' });
  // 别名：剧本里叫「销售经理老王」，IC 资产名「4S销售经理」
  fs.writeFileSync(path.join(root, '资产', '别名表.csv'), 'IC名,资产表名\n4S销售经理,销售经理老王\n');
  core.Chapters.update(ch.id, { script: '【第1场｜日｜4S店】\n出场人物：销售经理老王\n' });
  core.Shots.remove ? core.Shots.remove(extra.id) : null;
  r = ac.checkChapterAssets(pid, '第11章');
  assert.equal(r.inputs.alias_rows, 1);
  fs.rmSync(path.join(root, '资产', '别名表.csv'));
  const r2 = ac.checkChapterAssets(pid, '第11章');
  assert.equal(r2.inputs.alias_table, '', '别名表不存在 = 空表');
});

test('runAssetCheck：官方 register_voice 自动登记同名唯一音色，写缺件单到 资料根\\草稿\\IC缺件单，同内容不重写', async () => {
  const { report, gap, registered } = await ac.runAssetCheck(pid, '第11章', { trigger: 'test' });
  assert.equal(registered.length, 1);
  assert.ok(!registered[0].error, registered[0].error);
  assert.ok(String(core.Assets.get(A.jc.id).voice_ref).startsWith('assets/voice/') || String(core.Assets.get(A.jc.id).voice_ref).startsWith('assets\\voice\\'));
  assert.ok(report.ok.some((x) => x.type === 'voice' && x.name === '江澈'), '登记后复查江澈音色齐');
  assert.ok(gap && gap.file.startsWith(path.join(root, '草稿', 'IC缺件单')));
  assert.ok(fs.existsSync(gap.file) && fs.existsSync(gap.md));
  assert.ok(fs.existsSync(path.join(root, '草稿', 'IC缺件单', '第11章_latest.json')));
  const md = fs.readFileSync(gap.md, 'utf8');
  assert.match(md, /4S销售经理/);
  assert.match(md, /待资产管理复核/);
  const st = ac.chapterAssetStatus(pid, ch.id);
  assert.equal(st.state, 'missing');
  assert.equal(st.missing, report.summary.missing);
  assert.equal(st.gapFile, gap.file);
  const again = await ac.runAssetCheck(pid, '第11章', { trigger: 'test' });
  assert.equal(again.gap.reused, true, '内容没变不重写');
  assert.equal(again.registered.length, 0);
});

test('歧义音色只列不登记', () => {
  const p = core.Projects.create({ name: '歧义' }).id;
  core.Projects.setContextKey(p, 'asset_mode', 'gap-list');
  core.Projects.setContextKey(p, 'asset_root', root);
  core.Chapters.create(p, { title: '测试章A' });
  const c = core.Assets.create(p, { category: 'character', name: '甲' });
  const v1 = core.Assets.create(p, { category: 'voice', name: '甲音色' });
  const v2 = core.Assets.create(p, { category: 'voice', name: '甲' });
  const pd = core.projectDir(p);
  for (const v of [v1, v2]) { const rel = 'assets/voice/' + v.id + '.wav'; fs.mkdirSync(path.join(pd, 'assets', 'voice'), { recursive: true }); fs.writeFileSync(path.join(pd, rel), 'RIFF'); core.Assets.update(v.id, { status: 'done', audio_path: rel }); }
  core.Shots.create(p, { chapter: '测试章A', idx: 1, character_ids: [c.id], dialogue: '甲：你好' });
  const r = ac.checkChapterAssets(p, '测试章A');
  assert.equal(r.linkable.length, 0);
  const m = r.missing.find((x) => x.type === 'voice');
  assert.equal(m.reason, 'ambiguous');
  assert.equal(m.voice_policy, 'list_only');
});

test('pendingByStage 按 assetIds 只看本章指定资产', () => {
  const all = stages.pendingByStage(pid, '第11章');
  const scoped = stages.pendingByStage(pid, '第11章', { assetIds: [A.sm.id] });
  assert.ok(all.tts.todo >= scoped.tts.todo);
  assert.equal(scoped.image.todo, 0);
  assert.ok(scoped.tts.items.every((s) => s.includes('4S销售经理')));
});

test('只做分镜任务里 create_asset 被拦（gap-list），记进本章需求；非只做分镜 / auto 项目照旧', async () => {
  const before = core.Assets.list(pid).length;
  const ctx = tools.createToolRuntime({ projectId: pid, chapter: '第11章', renderDisabled: true, onProgress: () => {}, isAborted: () => false });
  const out = JSON.parse(await tools.runTool(ctx, 'create_asset', { category: 'prop', name: '车钥匙' }));
  assert.equal(out.skipped, true);
  assert.equal(core.Assets.list(pid).length, before);
  assert.ok(ac.readStore(pid).requests['第11章'].some((r) => r.name === '车钥匙'));
  const r = ac.checkChapterAssets(pid, '第11章');
  assert.ok(r.missing.some((m) => m.name === '车钥匙' && m.sources.includes('agent_request')));
  // 非渲染禁用（整章生成）的 ctx 不拦
  const ctx2 = tools.createToolRuntime({ projectId: pid, chapter: '第11章', renderDisabled: false, onProgress: () => {}, isAborted: () => false });
  await tools.runTool(ctx2, 'create_asset', { category: 'prop', name: '车钥匙2' });
  assert.ok(core.Assets.list(pid).some((a) => a.name === '车钥匙2'));
  // auto 项目的只做分镜也不拦
  const p3 = core.Projects.create({ name: 'auto 项目' }).id;
  const ctx3 = tools.createToolRuntime({ projectId: p3, chapter: '', renderDisabled: true, onProgress: () => {}, isAborted: () => false });
  await tools.runTool(ctx3, 'create_asset', { category: 'prop', name: '杯子' });
  assert.ok(core.Assets.list(p3).some((a) => a.name === '杯子'));
});

test('闸门：B 不挡；A 有缺件抛 ASSETS_MISSING 且不建任务', () => {
  core.Projects.setContextKey(pid, 'asset_gate', 'B');
  const g = ac.assetGateBeforeRun(pid, '第11章', { trigger: 'test' });
  assert.ok(g && g.report && g.report.summary.missing > 0);
  core.Projects.setContextKey(pid, 'asset_gate', 'A');
  const jobs0 = core.Jobs.list(pid).length;
  assert.throws(() => jr.startCreateJob({ projectId: pid, chapter: '第11章', renderDisabled: true, onProgress: () => {} }), (e) => e.code === 'ASSETS_MISSING');
  assert.equal(core.Jobs.list(pid).length, jobs0);
  core.Projects.setContextKey(pid, 'asset_gate', 'B');
});

test('自动资产任务（gap-list）：只管本章；已有资产任务在跑则不重复提交、不出图', async () => {
  const busy = core.Jobs.create({ projectId: pid, type: 'stage', checkpoint: { stages: ['tts'] } });
  const r = await pw.enqueuePendingAssetsIfNeeded({ projectId: pid, chapter: '第11章', onProgress: () => {} });
  assert.equal(r.chapterScoped, true);
  assert.equal(r.voiceTodo, 1);
  assert.equal(r.skipped, true);
  assert.equal(r.job.id, busy.id);
  assert.equal(core.Jobs.list(pid).filter((j) => j.type === 'stage').length, 1, '没有新任务');
  core.Jobs.update(busy.id, { status: 'done' });
});
