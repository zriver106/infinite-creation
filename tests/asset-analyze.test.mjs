// 资产分析任务 + 地点表（Andy 11-26；adapt J-004 / J-009 / J-010）：地点表存取与匹配、戏份说明、受限工具集（先读规则才给原著）、
// 任务提交（假 Agent）、路由、binding-check 地点 W、剧本自检地点、brief 地点字段。临时数据目录，不起 CLI、不碰 GPU。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-aa-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
const ROOT = process.cwd();
registerHooks({ resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
  if (spec === 'next/server') return next('next/server.js', ctx);
  return next(spec, ctx);
} });
let core; let LOC; let SN; let AM; let AA; let bk; let SG; let pwm; let TOOLS;
before(async () => {
  core = await import('../lib/core/index.js');
  LOC = await import('../lib/core/locations.js');
  SN = await import('../lib/core/scene-notes.js');
  AM = await import('../lib/agent/asset-analyze-mcp.js');
  AA = await import('../lib/agent/asset-analyze.js');
  bk = await import('../lib/agent/binding-check.js');
  SG = await import('../lib/agent/stage-guards.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
  TOOLS = (await import('../lib/agent/tools.js')).TOOL_DEFINITIONS;
});

const TABLE = { rows: [
  { id: 'L01', name: '五缘金店', aliases: ['五缘金店店内'], first_chapter: 2, last_chapter: 24, kind: '内景', variants: [{ name: '店外', asset_id: 'a_out' }], asset_ids: ['a_in'] },
  { id: 'L02', name: '偏僻金店甲', first_chapter: 8, last_chapter: 8, asset_ids: [] },
], doubts: [{ question: '第 12 章的金店是不是五缘？', chapters: ['12'] }] };

test('地点表：校验（缺 ID / 重名 / 首末章颠倒）、存取留档、按名字和资产找地点', () => {
  const p = core.Projects.create({ name: 'loc', auto_script: false });
  assert.throws(() => LOC.saveLocations(p.id, { rows: [{ id: '', name: 'x' }, { id: 'A', name: 'y', first_chapter: 5, last_chapter: 2 }, { id: 'B', name: 'y' }] }), (e) => e.code === 'BAD_LOCATIONS' && e.errors.length === 3);
  LOC.saveLocations(p.id, TABLE, { source: 't' });
  LOC.saveLocations(p.id, TABLE, { source: 't2' });
  assert.equal(fs.readFileSync(path.join(core.projectDir(p.id), 'locations_history.jsonl'), 'utf8').trim().split('\n').length, 1);
  const t = LOC.getLocations(p.id);
  assert.equal(t.rows.length, 2); assert.equal(t.doubts.length, 1);
  assert.equal(LOC.locationForName(t, '【场景 03】五缘金店·店内柜台').id, 'L01', '名字里含地点名');
  assert.equal(LOC.locationForName(t, '五缘金店店内').id, 'L01', '别名');
  assert.equal(LOC.locationForName(t, '海鲜自助餐厅'), null);
  assert.equal(LOC.locationOfAsset(t, 'a_out').id, 'L01');
  assert.deepEqual(LOC.locationAssetIds(t.rows[0]), ['a_in', 'a_out']);
});

test('戏份说明：存取、覆盖留档、空内容报错', () => {
  const p = core.Projects.create({ name: 'sn', auto_script: false });
  SN.saveSceneNote(p.id, 'L01', '# 五缘金店\n生命周期：第 2–24 章');
  SN.saveSceneNote(p.id, 'L01', '# 五缘金店 v2');
  assert.equal(SN.getSceneNote(p.id, 'L01').text, '# 五缘金店 v2');
  assert.equal(SN.listSceneNotes(p.id).length, 1);
  assert.equal(fs.readdirSync(path.join(core.projectDir(p.id), 'scene_notes', '_history')).length, 1);
  assert.throws(() => SN.saveSceneNote(p.id, 'x', '  '), (e) => e.code === 'BAD_NOTE');
});

test('工具集：只读规则 / 资产 + 检索读原著 + 写地点表 / 戏份说明 / 缺图单；不给出图、出片、改分镜', () => {
  const names = new Set(AM.assetAnalyzeToolDefinitions(TOOLS).map((t) => t.function.name));
  for (const x of ['skill', 'skill_reference', 'list_assets', 'search_novel', 'read_chapter_novel', 'save_locations', 'save_scene_note', 'save_gap_list']) assert.ok(names.has(x), x);
  for (const x of ['generate_asset_image', 'generate_shot_video', 'set_storyboard', 'update_shot', 'set_chapter_script', 'create_asset', 'get_chapter']) assert.ok(!names.has(x), x);
});

test('先读规则才给原著；检索返回章号和句子；读章可分段；写地点表 / 戏份说明 / 缺图单（附 J-009 原文）', async () => {
  const p = core.Projects.create({ name: 'aa', auto_script: false });
  const c1 = core.Chapters.list(p.id)[0];
  core.Chapters.update(c1.id, { novel: '江澈走进五缘金店。柜台后的老板抬起头。' });
  core.Chapters.create(p.id, { title: '第2章', novel: '第二天他又去了五缘金店，店里人很多。' });
  const ctx = { projectId: p.id, jobId: 'jaa' };
  AM._resetAssetAnalyzeServed();
  await assert.rejects(AM.runAssetAnalyzeExtraTool(ctx, 'search_novel', { keywords: ['金店'] }), /先读规则/);
  AM.noteAssetAnalyzeToolCall('skill', { name: 'adapt-rules' });
  await assert.rejects(AM.runAssetAnalyzeExtraTool(ctx, 'read_chapter_novel', { chapter: 1 }), /戏份说明模板/);
  for (const ref of AM.ASSET_ANALYZE_REFS) AM.noteAssetAnalyzeToolCall('skill_reference', { name: 'adapt-rules', ref });
  const s = JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'search_novel', { keywords: ['五缘金店'] }));
  assert.deepEqual(s.chapters_hit, [1, 2]); assert.equal(s.first_chapter, 1); assert.equal(s.last_chapter, 2);
  assert.match(s.hits[0].sentence, /五缘金店/);
  assert.deepEqual(JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'search_novel', { keywords: ['五缘金店'], chapter_from: 2 })).chapters_hit, [2]);
  const r = JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'read_chapter_novel', { chapter: 1, from: 0, to: 6 }));
  assert.equal(r.text, '江澈走进五缘'); assert.match(r.more, /from=6/);
  assert.equal(JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'save_locations', TABLE)).rows, 2);
  assert.equal(JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'save_scene_note', { key: 'L01', text: '# 五缘金店' })).saved, true);
  const g = JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'save_gap_list', { items: [{ kind: 'scene', name: '五缘金店', location_id: 'L01', requirement: '店内柜台' }] }));
  const txt = fs.readFileSync(path.join(core.projectDir(p.id), g.file), 'utf8');
  assert.match(txt, /五缘金店/); assert.match(txt, /J-009/);
  assert.equal(AM.assetAnalyzeWriteCount(), 3);
  assert.match(AM.buildAssetAnalyzeAgentPrompt({ project: { name: 'V3' }, range: [1, 12] }), /第 1–12 章[\s\S]*不读项目外/);
});

test('提交：范围校验、同项目只跑一个、假 Agent 写了地点表就完成、什么都没写就失败', async () => {
  const p = core.Projects.create({ name: 'aa-job', auto_script: false });
  assert.throws(() => AA.submitAssetAnalyzeJob({ projectId: p.id, chapters: [5, 1] }), (e) => e.code === 'BAD_RANGE');
  const calls = [];
  const r = AA.submitAssetAnalyzeJob({ projectId: p.id, chapters: [1, 12], requirement: '只看场景', runAgentFn: async (o) => { calls.push(o); LOC.saveLocations(p.id, TABLE); } });
  assert.equal(r.job.type, 'asset-analyze'); assert.deepEqual(r.range, [1, 12]);
  const wait = async (id, ok) => { for (let i = 0; i < 150; i++) { const j = core.Jobs.get(id); if (ok.includes(j.status)) return j; await new Promise((x) => setTimeout(x, 20)); } return core.Jobs.get(id); };
  const j = await wait(r.job.id, ['done', 'failed']);
  assert.equal(j.status, 'done', j.error); assert.match(j.detail, /地点表 2 个地点/);
  assert.deepEqual(calls[0].assetAnalyzeRange, [1, 12]); assert.equal(calls[0].assetAnalyze, true); assert.equal(calls[0].assetAnalyzeRequirement, '只看场景');
  const r2 = AA.submitAssetAnalyzeJob({ projectId: p.id, runAgentFn: async () => {} });
  const j2 = await wait(r2.job.id, ['done', 'failed']);
  assert.equal(j2.status, 'failed'); assert.match(j2.error, /没有写入任何分析结果/);
  let release; const hold = new Promise((x) => { release = x; });
  const r3 = AA.submitAssetAnalyzeJob({ projectId: p.id, runAgentFn: () => hold });
  assert.throws(() => AA.submitAssetAnalyzeJob({ projectId: p.id, runAgentFn: async () => {} }), (e) => e.code === 'PROJECT_BUSY');
  release(); await wait(r3.job.id, ['done', 'failed']);
});

test('路由：范围写错 400、项目不存在 404', async () => {
  const p = core.Projects.create({ name: 'aa-route', auto_script: false });
  const { POST } = await import('../app/api/projects/[id]/assets/analyze/route.js');
  const call = async (id, body) => { const r = await POST(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }); return { status: r.status, j: await r.json() }; };
  assert.equal((await call('nope', {})).status, 404);
  assert.equal((await call(p.id, { chapters: [3] })).j.code, 'BAD_RANGE');
  assert.equal((await call(p.id, { requirement: 1 })).status, 400);
  const L = await import('../app/api/projects/[id]/locations/route.js');
  const put = await L.PUT(new Request('http://x/', { method: 'PUT', body: JSON.stringify(TABLE) }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(put.status, 200);
  assert.equal((await (await L.GET(new Request('http://x/'), { params: Promise.resolve({ id: p.id }) })).json()).rows.length, 2);
});

test('地点表用起来：binding-check 报绑错地点 / 未登记资产（W，不拦）；剧本场头地点不在表里提示；brief 带本镜地点', async () => {
  const p = core.Projects.create({ name: 'aa-use', auto_script: false });
  const A = (name) => core.Assets.create(p.id, { category: 'scene', name });
  const inn = A('五缘金店·店内'); const out = A('五缘金店·店外'); const other = A('五缘金店·另一套'); const street = A('街头金店');
  LOC.saveLocations(p.id, { rows: [{ id: 'L01', name: '五缘金店', asset_ids: [inn.id], variants: [{ name: '店外', asset_id: out.id }] }, { id: 'L09', name: '街头金店', asset_ids: [street.id] }] });
  const sh = core.Shots.create(p.id, { chapter: '第1章', idx: 1, scene_name: '【场景 01】五缘金店·店内', visual: 'v', dialogue: '', scene_ids: [inn.id, street.id], mode: 'text' });
  const assets = core.Assets.list(p.id);
  const r = bk.checkShotBindings(core.Shots.get(sh.id), { assets, projectId: p.id });
  const w = r.issues.filter((i) => i.kind.startsWith('loc_'));
  assert.ok(w.some((i) => i.kind === 'loc_mismatch' && /街头金店/.test(i.detail) && /L09/.test(i.detail)), JSON.stringify(w));
  assert.ok(w.some((i) => i.kind === 'loc_unregistered' && /另一套/.test(i.detail)));
  assert.equal(r.blocking, bk.checkShotBindings(core.Shots.get(sh.id), { assets, projectId: p.id, warnings: false }).blocking, '只报不拦');
  const table = LOC.getLocations(p.id);
  const lock = '**场头锁定**\n- **地点：** 金店\n- **在场：** 江澈\n- **服装：** 白T\n- **站位：** 柜台前\n';
  const codes = SG.checkScriptDraft('## 【第1场｜上午｜金店】\n' + lock + '[画面：x。]', '', { locations: table }).map((x) => x.code);
  assert.ok(codes.includes('LOCATION_UNKNOWN'));
  assert.ok(!SG.checkScriptDraft('## 【第1场｜上午｜金店】\n' + lock.replace('金店', '五缘金店') + '[画面：x。]', '', { locations: table }).some((x) => x.code === 'LOCATION_UNKNOWN'));
  assert.ok(!SG.checkScriptDraft('## 【第1场｜上午｜金店】\n' + lock + '[画面：x。]', '', { locations: { rows: [] } }).some((x) => x.code === 'LOCATION_UNKNOWN'), '地点表为空不报');
  pwm._resetPromptWriteSession();
  const b = JSON.parse(await pwm.runPromptWriteExtraTool({ projectId: p.id, jobId: 'jb', chapter: '第1章', project: core.Projects.get(p.id), cfg: {} }, 'get_shot_prompt_brief', { shot_id: sh.id }));
  assert.equal(b.location.id, 'L01'); assert.deepEqual(b.location.assets.map((a) => a.name).sort(), ['五缘金店·店内', '五缘金店·店外']);
});

test('只写剧本：只能写本章且强制覆盖；重写模式 get_chapter 不给旧剧本、先读规则才给原著；提交后剧本变了才算完成', async () => {
  const SW = await import('../lib/agent/script-write.js');
  const tools = await import('../lib/agent/tools.js');
  const SG2 = await import('../lib/agent/stage-guards.js');
  const p = core.Projects.create({ name: 'sw', auto_script: true });
  const c1 = core.Chapters.list(p.id)[0];
  core.Chapters.update(c1.id, { novel: '江澈走进五缘金店。', script: '旧剧本' });
  const ctx = { projectId: p.id, chapter: c1.title };
  assert.deepEqual(SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }), { script: 'x', chapter: c1.title, overwrite: true });
  assert.throws(() => SW.guardScriptWrite(ctx, 'set_chapter_script', { chapter: '第9章', script: 'x' }), /只能重写/);
  const names = SW.scriptWriteToolDefinitions(TOOLS).map((t) => t.function.name);
  assert.ok(names.includes('set_chapter_script') && names.includes('get_locations') && !names.includes('set_storyboard'));
  const rt = tools.createToolRuntime({ projectId: p.id, jobId: 'jsw', chapter: c1.title });
  rt.scriptRewrite = true;
  const r1 = JSON.parse(await tools.runTool(rt, 'get_chapter', { chapter: c1.title }));
  assert.equal(r1.novel, ''); assert.notEqual(r1.script, '旧剧本');
  SG2.noteSkillServed(rt, 'adapt-rules'); SG2.noteSkillServed(rt, 'sd-storyboard-engine'); SG2.noteSkillLinesServed(rt, 'adapt-rules', ['H2']);
  for (const ref of ['剧本样稿.md', '叙述转换方法.md']) await tools.runTool(rt, 'skill_reference', { name: 'adapt-rules', ref });
  const r2 = JSON.parse(await tools.runTool(rt, 'get_chapter', { chapter: c1.title }));
  assert.equal(r2.novel, '江澈走进五缘金店。'); assert.equal(r2.script, ''); assert.match(r2.script_note, /重写模式/);
  const wait = async (id) => { for (let i = 0; i < 150; i++) { const j = core.Jobs.get(id); if (['done', 'failed'].includes(j.status)) return j; await new Promise((x) => setTimeout(x, 20)); } return core.Jobs.get(id); };
  const ch = core.Chapters.get(c1.id);
  const ok = SW.submitScriptWriteJob({ projectId: p.id, chapter: ch, runAgentFn: async () => { core.Chapters.update(c1.id, { script: '新剧本' }); } });
  assert.equal((await wait(ok.job.id)).status, 'done');
  const same = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c1.id), runAgentFn: async () => {} });
  const j = await wait(same.job.id); assert.equal(j.status, 'failed'); assert.match(j.error, /没有写入新剧本/);
  assert.match(SW.buildScriptWriteAgentPrompt({ project: { name: 'V3' }, chapter: '第1章' }), /节拍表 → 叙述转换表/);
});

test('归档资产：资产分析的 list_assets 不列；接口只记 id、不删资产', async () => {
  const p = core.Projects.create({ name: 'arch', auto_script: false });
  const a = core.Assets.create(p.id, { category: 'scene', name: '旧公司' });
  const b = core.Assets.create(p.id, { category: 'scene', name: '新场景' });
  const R = await import('../app/api/projects/[id]/assets/archive/route.js');
  const put = await R.PUT(new Request('http://x/', { method: 'PUT', body: JSON.stringify({ ids: [a.id] }) }), { params: Promise.resolve({ id: p.id }) });
  assert.deepEqual((await put.json()).archived, [a.id]);
  const res = JSON.parse(await AM.runAssetAnalyzeExtraTool({ projectId: p.id, jobId: 'x' }, 'list_assets', {}));
  assert.deepEqual(res.assets.map((x) => x.id), [b.id]); assert.equal(res.archived_hidden, 1);
  assert.ok(core.Assets.get(a.id), '资产还在');
});

test('关了自动承接：列表 / 分镜卡的 lead_in 显示不接（原因写明），手动接照常', async () => {
  const LC = await import('../lib/agent/lead-in-ctx.js');
  const p = core.Projects.create({ name: 'li-auto', auto_script: false });
  const sc = core.Assets.create(p.id, { category: 'scene', name: '办公室' });
  core.Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  const b = core.Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(LC.leadInContext(p.id, core.Shots.get(b.id)).decision.on, true);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, generation: { ...(cfg.generation || {}), leadInAuto: false } }));
  try {
    const d = LC.leadInContext(p.id, core.Shots.get(b.id)).decision;
    assert.equal(d.on, false); assert.match(d.reason, /自动承接已关/);
    core.Shots.setFrameAnchor(b.id, { first_frame_source: 'prev_clip22' });
    assert.equal(LC.leadInContext(p.id, core.Shots.get(b.id)).decision.on, true, '手动接照常');
  } finally { fs.writeFileSync(cfgPath, JSON.stringify(cfg)); }
});
