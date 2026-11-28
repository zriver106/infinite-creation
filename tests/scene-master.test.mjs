// 场景母本（手册 13 号 / R-006 第 4 条，总导 11-28）：项目里有场景母本时，只写剧本任务没读过母本不让存剧本；读工具给 JSON 和标注版平面图。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sm-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let SM; let SW;
before(async () => { core = await import('../lib/core/index.js'); SM = await import('../lib/core/scene-master.js'); SW = await import('../lib/agent/script-write.js'); });

test('列出 / 读场景母本；有母本时没读过不让存剧本，读过才放行；没有母本的项目照旧', () => {
  const p = core.Projects.create({ name: 'sm-1', auto_script: false });
  const ch = core.Chapters.create ? null : null;
  const ctx = { projectId: p.id, chapter: '第1章' };
  assert.deepEqual(SM.listSceneMasters(p.id), []);
  assert.equal(SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }).overwrite, true, '没有母本的项目照旧能存');
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(path.join(dir, 'L02-金店店内'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'L02-金店店内.json'), JSON.stringify({ scene_id: 'L02-金店店内', name: '五缘金店·店内', items: [{ id: 'F01' }, { id: 'F05' }] }));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', path.join(dir, 'L02-金店店内', '平面图_标注.png')]);
  assert.deepEqual(SM.listSceneMasters(p.id), [{ scene_id: 'L02-金店店内', name: '五缘金店·店内', items: 2, has_plan: true }]);
  const r = SM.getSceneMaster(p.id, 'L02-金店店内');
  assert.equal(r.master.name, '五缘金店·店内'); assert.ok(r.plan.endsWith('平面图_标注.png'));
  assert.equal(SM.getSceneMaster(p.id, 'nope'), null);
  assert.throws(() => SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }), /get_scene_master/);
  ctx.sceneMasterRead = true;
  assert.equal(SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }).overwrite, true);
  assert.ok(SW.SCRIPT_WRITE_EXTRA.has('get_scene_master') && SW.SCRIPT_WRITE_EXTRA.has('list_scene_masters'));
  assert.match(SW.buildScriptWriteAgentPrompt({ project: { name: 'V3' }, chapter: '第1章' }), /get_scene_master[\s\S]*R-006 第 4 条/);
});

test('场景结构资产：绑了母本里的 _MV 资产，参考图按「人物 → 平面 → 正 → 左 → 右」，_MV 旧图不送；超 9 张先去平面图', async () => {
  const R = await import('../lib/core/refs.js');
  const p = core.Projects.create({ name: 'sm-2', auto_script: false });
  const pd = core.projectDir ? core.projectDir(p.id) : path.join(process.env.IC_DATA_DIR, 'projects', p.id);
  const mk = (rel) => { const a = path.join(pd, rel); fs.mkdirSync(path.dirname(a), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', a]); return rel; };
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'L02-金店店内.json'), JSON.stringify({ scene_id: 'L02-金店店内', name: '五缘金店·店内', asset_ids: ['mv1', 'st1'], items: [] }));
  for (const n of ['平面图', '正视图', '左视图', '右视图']) mk('scene_master/L02-金店店内/art/' + n + '.png');
  // 审过记录（总导 11-28）：只有审过写入的 art/ 才送；先确认没记录时不送四视图、照旧送 _MV 图
  const artDir = path.join(dir, 'L02-金店店内', 'art');
  const noRec = (await R.assembleShotReferences({ cfg: {}, project: p, shot: { character_ids: ['c1'], scene_ids: ['mv1'], prop_ids: [], dialogue: '' }, assets: [{ id: 'c1', type: 'character', name: '江澈', image_path: mk('assets/c1.png') }, { id: 'mv1', type: 'scene', name: 'S095_MV 金店店内多视角定义图', image_path: mk('assets/mv1.png') }], upload: false })).references;
  assert.ok(!noRec.some((r) => r.sceneView), '没有审过记录的 art/ 不送进出片');
  const sizes = Object.fromEntries([['plan', '平面图'], ['front', '正视图'], ['left', '左视图'], ['right', '右视图']].map(([k, n]) => [k, fs.statSync(path.join(artDir, n + '.png')).size]));
  fs.writeFileSync(path.join(artDir, '_审过记录.json'), JSON.stringify({ verdict: 'pass', round: 'r1', sizes }));
  const assets = [
    { id: 'c1', type: 'character', name: '江澈', image_path: mk('assets/c1.png') },
    { id: 'mv1', type: 'scene', name: 'S095_MV 金店店内多视角定义图', image_path: mk('assets/mv1.png') },
    { id: 'st1', type: 'scene', name: 'S095 金店店内·有客人', image_path: mk('assets/st1.png') },
  ];
  const run = async (sceneIds, extraChars = []) => (await R.assembleShotReferences({ cfg: {}, project: p, shot: { character_ids: ['c1', ...extraChars], scene_ids: sceneIds, prop_ids: [], dialogue: '' }, assets, upload: false })).references;
  let refs = await run(['mv1']);
  const imgs = refs.filter((r) => r.type === 'image');
  assert.equal(imgs.length, 5);
  assert.match(imgs[0].label, /江澈/);
  assert.deepEqual(imgs.slice(1).map((r) => r.sceneView), ['plan', 'front', 'left', 'right']);
  assert.ok(imgs.every((r) => !/多视角定义图/.test(r.label) || r.sceneView), '_MV 旧图不送');
  refs = await run(['st1', 'mv1']);
  assert.equal(refs.filter((r) => r.type === 'image').length, 6, '阶段变体照送 + 四视图只送一次');
  for (let i = 0; i < 5; i++) assets.push({ id: 'x' + i, type: 'character', name: '路人' + i, image_path: mk('assets/x' + i + '.png') });
  refs = await run(['st1'], ['x0', 'x1', 'x2', 'x3']);
  const im2 = refs.filter((r) => r.type === 'image');
  assert.equal(im2.length, 9); assert.ok(!im2.some((r) => r.sceneView === 'plan'), '超 9 张先去平面图');
});

test('审过记录：图被换过（大小对不上记录）或结论不是 pass，就不算审过、不送', () => {
  const p = core.Projects.create({ name: 'sm-3', auto_script: false });
  const dir = SM.sceneMasterDir(p.id); const art = path.join(dir, 'L07-花店', 'art'); fs.mkdirSync(art, { recursive: true });
  const sizes = {};
  for (const [k, n] of [['plan', '平面图'], ['front', '正视图'], ['left', '左视图'], ['right', '右视图']]) { fs.writeFileSync(path.join(art, n + '.png'), 'x' + k); sizes[k] = fs.statSync(path.join(art, n + '.png')).size; }
  assert.equal(SM.sceneMasterArtViews(p.id, 'L07-花店'), null, '没记录');
  fs.writeFileSync(path.join(art, '_审过记录.json'), JSON.stringify({ verdict: 'pass', sizes }));
  assert.equal(SM.sceneMasterArtViews(p.id, 'L07-花店').length, 4);
  fs.writeFileSync(path.join(art, '左视图.png'), 'replaced-by-hand');
  assert.equal(SM.sceneMasterArtViews(p.id, 'L07-花店'), null, '审过后被手工换图');
  fs.writeFileSync(path.join(art, '左视图.png'), 'xleft');
  fs.writeFileSync(path.join(art, '_审过记录.json'), JSON.stringify({ verdict: 'return', sizes }));
  assert.equal(SM.sceneMasterArtViews(p.id, 'L07-花店'), null, '结论不是 pass');
});

test('母本标 send_scene_image:false：没有审过的四视图时，绑的 _MV 图不送（只靠空间约束文字）；阶段变体照送', async () => {
  const R = await import('../lib/core/refs.js');
  const p = core.Projects.create({ name: 'sm-4', auto_script: false });
  const pd = core.projectDir ? core.projectDir(p.id) : path.join(process.env.IC_DATA_DIR, 'projects', p.id);
  const mk = (rel) => { const a = path.join(pd, rel); fs.mkdirSync(path.dirname(a), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', a]); return rel; };
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'L02-金店店内.json'), JSON.stringify({ scene_id: 'L02-金店店内', name: '五缘金店·店内', asset_ids: ['mv1', 'st1'], send_scene_image: false, items: [] }));
  const assets = [
    { id: 'c1', type: 'character', name: '江澈', image_path: mk('assets/c1.png') },
    { id: 'mv1', type: 'scene', name: 'L02_MV·五缘金店·店内·多视角定义图', image_path: mk('assets/mv1.png') },
    { id: 'st1', type: 'scene', name: '五缘金店·店内·有客人', image_path: mk('assets/st1.png') },
  ];
  const refs = (await R.assembleShotReferences({ cfg: {}, project: p, shot: { character_ids: ['c1'], scene_ids: ['mv1', 'st1'], prop_ids: [], dialogue: '' }, assets, upload: false })).references.filter((r) => r.type === 'image');
  assert.equal(refs.length, 2, '人物 + 阶段变体，_MV 不送');
  assert.ok(!refs.some((r) => /多视角定义图/.test(r.label || '')));
});
