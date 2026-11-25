// 开渲前资产检查单测（2026-11-17）：临时数据目录 + 临时资料根（资产表 / sha.csv / 映射表 / 清单都在临时目录），
// 不碰真实 data/ic.db、真实项目资料目录，不调 LLM / ComfyUI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-apc-'));
const root = path.join(tmp, '资料根');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let core; let apc; let tools;
let pid; const A = {};
const outDir = path.join(tmp, 'dry-out');

function put(rel, content) { const f = path.join(core.projectDir(pid), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return rel; }
function mapCsv(rows) {
  const cols = ['target_id', 'target_name', 'category', 'final_asset_id', 'final_pid', 'final_name', 'final_sha256', 'basis', 'shot_id'];
  fs.writeFileSync(path.join(root, '资产', 'IC定稿映射.csv'), '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] || '').join(','))].join('\r\n'));
}

before(async () => {
  fs.mkdirSync(path.join(root, '资产'), { recursive: true });
  fs.writeFileSync(path.join(root, '资产', 'assets.csv'), [
    '# 资产表（测试）',
    'id,pid,rel,type,name,var,file,rest,ch,cert,review,miss,note,描述,属性',
    'S900,S900,,scene,酒店门口送别区,,scene/S900.png,,,ok,final,,,,',
    'S901,S901,,scene,金店,,scene/S901.png,,,ok,final,,,,',
    'S902,S902,,scene,夜跑路线,,scene/S902.png,,,ok,final,,,,',
    'P903,P903,,prop,名片,,prop/P903.png,,,ok,final,,,,',
    'P904,P904,,prop,名片,,prop/P904.png,,,ok,final,,,,',
    'C905_B,C905,,char,大叔,B,char/C905_B.png,,,ok,pending,,,,',
    'S906,S906,,scene,梅园牡丹厅,,scene/S906.png,,,ok,final,,,,',
    'S907,S907,,scene,龙津门岗,,scene/S907.png,,,ok,final,,,,',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ generation: { assetImageSource: 'ic' }, llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = path.join(tmp, 'config.json');
  delete process.env.IC_ASSET_PRECHECK; delete process.env.IC_ASSET_FINAL_MAP;
  core = await import('../lib/core/index.js');
  apc = await import('../lib/agent/asset-precheck.js');
  tools = await import('../lib/agent/tools.js');

  pid = core.Projects.create({ name: '开渲前检查测试', auto_script: false }).id;
  core.Projects.setContextKey(pid, 'asset_root', root);
  core.Projects.setContextKey(pid, 'asset_mode', 'gap-list');
  core.Chapters.create(pid, { title: '第15章', script: 'x' });
  core.Chapters.create(pid, { title: '第16章', script: 'x' });
  const shaRows = ['file,sha256,bytes,note'];
  const mk = (key, category, name, { src = 'generated', bytes, pidTag = '', review = 'final', sheetFile = '' } = {}) => {
    const a = core.Assets.create(pid, { category, name, description: pidTag ? '我方资产ID：' + pidTag + '；审核：' + review + '；测试' : '' });
    const b = Buffer.from(bytes || ('IMG-' + key));
    const rel = put('assets/' + category + 's/' + key + '.png', b);
    core.Assets.update(a.id, { image_path: rel, status: 'done', source: src });
    if (sheetFile) shaRows.push(sheetFile + ',' + sha(b) + ',' + b.length + ',');
    A[key] = core.Assets.get(a.id);
  };
  mk('G1', 'scene', '酒店门口');            mk('F1', 'scene', '酒店门口送别区', { src: 'uploaded', pidTag: 'S900', sheetFile: 'scene/S900.png' });
  mk('G2', 'scene', '金店');                mk('F2', 'scene', '金店', { src: 'uploaded', pidTag: 'S901', sheetFile: 'scene/S901.png' });
  mk('G3', 'scene', '夜跑步道');            mk('F3', 'scene', '夜跑路线', { src: 'uploaded', pidTag: 'S902', sheetFile: 'scene/S902.png' });
  mk('G4', 'prop', '名片');                 mk('F4a', 'prop', '名片', { src: 'uploaded', pidTag: 'P903', sheetFile: 'prop/P903.png' }); mk('F4b', 'prop', '名片', { src: 'uploaded', pidTag: 'P904', sheetFile: 'prop/P904.png' });
  mk('G5', 'character', '大叔');            mk('F5', 'character', '大叔', { src: 'uploaded', pidTag: 'C905_B', review: 'pending', sheetFile: 'char/C905_B.png' });
  mk('G6', 'scene', '牡丹厅包厢');          mk('F6', 'scene', '梅园牡丹厅', { src: 'uploaded', pidTag: 'S906', sheetFile: 'scene/S906.png' });
  mk('G7', 'scene', '门岗');                mk('F7', 'scene', '龙津门岗', { src: 'uploaded', pidTag: 'S907' });
  shaRows.push('scene/S907.png,' + 'f'.repeat(64) + ',1,');            // 资产表 sha 与库里图不一致
  mk('G8', 'scene', '旧书摊');
  mk('G10', 'scene', '改过名的场景');
  mk('U9', 'character', '江澈', { src: 'uploaded', pidTag: 'C001_B' });
  mk('G11', 'scene', '别章场景');
  mk('G12', 'scene', '同字节场景', { bytes: 'IMG-F1' }); // 字节已与 F1 一致
  fs.writeFileSync(path.join(root, '资产', 'sha.csv'), shaRows.join('\n'));
  mapCsv([
    { target_id: A.G1.id, target_name: '酒店门口', category: 'scene', final_asset_id: A.F1.id, final_pid: 'S900', final_sha256: sha(Buffer.from('IMG-F1')), basis: '测试' },
    { target_id: A.G6.id, target_name: '牡丹厅包厢', category: 'scene', final_asset_id: A.F6.id, final_pid: 'S906', final_sha256: 'a'.repeat(64), basis: 'sha 已变' },
    { target_id: A.G7.id, target_name: '门岗', category: 'scene', final_asset_id: A.F7.id, final_pid: 'S907', basis: '资产表 sha 不符' },
    { target_id: A.G8.id, target_name: '旧书摊', category: 'scene', final_asset_id: A.F1.id, final_pid: 'S900', basis: '忙' },
    { target_id: A.G10.id, target_name: '原名', category: 'scene', final_asset_id: A.F1.id, basis: '改名' },
    { target_id: A.G12.id, target_name: '同字节场景', category: 'scene', final_asset_id: A.F1.id, basis: '同字节' },
  ]);
  core.Shots.create(pid, { chapter: '第15章', idx: 1, character_ids: [A.G5.id, A.U9.id], scene_ids: [A.G1.id], prop_ids: [A.G4.id], video_prompt: 'p1' });
  core.Shots.create(pid, { chapter: '第15章', idx: 2, scene_ids: [A.G2.id, A.G3.id], video_prompt: 'p2' });
  core.Shots.create(pid, { chapter: '第15章', idx: 3, scene_ids: [A.G6.id, A.G7.id, A.G8.id, A.G10.id, A.G12.id], character_ids: ['不存在的id'], video_prompt: 'p3' });
  core.Shots.create(pid, { chapter: '第16章', idx: 1, scene_ids: [A.G11.id, A.G2.id], video_prompt: 'q1' });
  core.Queue.enqueue({ projectId: pid, pool: 'render', kind: 'asset', dedupeKey: 'asset:' + A.G8.id, payload: {} });
});

const codeOf = (r, key) => { const x = r.items.find((i) => i.asset_id === A[key].id); return x ? x.action + ':' + x.code : 'none'; };

test('开关：env 优先，其次 config.generation.assetPrecheck，缺省 swap', () => {
  assert.equal(apc.assetPrecheckMode({}, {}), 'swap');
  assert.equal(apc.assetPrecheckMode({ generation: { assetPrecheck: 'list' } }, {}), 'list');
  assert.equal(apc.assetPrecheckMode({ generation: { assetPrecheck: false } }, {}), 'off');
  assert.equal(apc.assetPrecheckMode({ generation: { assetPrecheck: 'list' } }, { IC_ASSET_PRECHECK: 'off' }), 'off');
  assert.equal(apc.assetPrecheckMode({}, { IC_ASSET_PRECHECK: 'bogus' }), 'swap');
});

test('映射表：BOM/CRLF、缺列报错、同一 target 重复 → 整条冲突不用', () => {
  const m = apc.parseFinalMap('\uFEFFtarget_id,final_asset_id\r\na,b\r\nc,\r\na,d\r\n');
  assert.equal(m.entries.length, 1); assert.equal(m.entries[0].conflict, true); assert.equal(m.errors.length, 2);
  assert.equal(apc.parseFinalMap(null).exists, false);
});

test('名称相近只当提示：逐字相同 0.95 以上才可能，包含/二元组打分', () => {
  assert.ok(apc.nameSimilarity('夜跑步道', '夜跑路线') >= 0.2);
  assert.ok(apc.nameSimilarity('酒店门口', '酒店门口送别区') > 0.6);
  assert.equal(apc.nameSimilarity('书摊', '阳台'), 0);
});

test('dry：逐项判定正确；不改库、不写项目目录，只写 outDir', () => {
  const before = core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]);
  const r = apc.runAssetPrecheck(pid, '第15章', { mode: 'dry', outDir, trigger: 'test' });
  assert.equal(codeOf(r, 'G1'), 'replace:mapping');
  assert.equal(codeOf(r, 'G2'), 'replace:exact-name');
  assert.equal(codeOf(r, 'G3'), 'list:no-final');
  assert.ok(r.items.find((i) => i.asset_id === A.G3.id).suggestions.some((s) => s.asset_id === A.F3.id), '相近名只进提示');
  assert.equal(codeOf(r, 'G4'), 'list:ambiguous-exact-name');
  assert.equal(codeOf(r, 'G5'), 'list:exact-name-not-final');
  assert.equal(codeOf(r, 'G6'), 'list:final-sha-changed');
  assert.equal(codeOf(r, 'G7'), 'list:final-not-ready');
  assert.equal(codeOf(r, 'G8'), 'list:busy');
  assert.equal(codeOf(r, 'G10'), 'list:mapping-stale');
  assert.equal(codeOf(r, 'G12'), 'ok:same-bytes');
  assert.equal(codeOf(r, 'U9'), 'none', '我方资产不进清单');
  assert.equal(codeOf(r, 'G11'), 'none', '只看本章');
  assert.equal(r.summary.non_generated, 1); assert.equal(r.summary.dangling, 0); // Shots.create 已丢弃无效 id
  assert.equal(r.summary.replace, 2); assert.equal(r.summary.replaced, 0);
  assert.deepEqual(core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]), before);
  assert.ok(r.files && r.files.md.startsWith(outDir) && fs.existsSync(r.files.md));
  assert.equal(fs.existsSync(path.join(root, '草稿')), false, 'dry 不写资料根');
  assert.equal(fs.existsSync(apc.precheckLogFile()), false, 'dry 不写日志');
});

test('list（起任务时）：不改库，写清单到 资料根\\草稿\\IC开渲前资产检查 + 日志；同样结果不重复出文件', () => {
  const before = core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]);
  const r = apc.runAssetPrecheck(pid, '第15章', { mode: 'list', trigger: 'submit' });
  assert.deepEqual(core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]), before);
  assert.ok(r.files.md.startsWith(path.join(root, '草稿', 'IC开渲前资产检查')));
  const md = fs.readFileSync(r.files.md, 'utf8');
  assert.match(md, /夜跑步道/); assert.match(md, /不挡出片/);
  const r2 = apc.runAssetPrecheck(pid, '第15章', { mode: 'list', trigger: 'submit' });
  assert.equal(r2.files.reused, true);
  assert.ok(fs.readFileSync(apc.precheckLogFile(), 'utf8').trim().split('\n').length >= 2);
});

test('swap：只换映射表 + 同名唯一的两项；归档旧图、新文件 sha=定稿、改库同 upload 路由；再跑一次幂等', () => {
  const oldG1 = core.Assets.get(A.G1.id); const oldAbs = path.join(core.projectDir(pid), oldG1.image_path);
  const r = apc.runAssetPrecheck(pid, '第15章', { mode: 'swap', trigger: 'render' });
  assert.equal(r.summary.replaced, 2); assert.equal(r.summary.replace_failed, 0);
  for (const [g, f] of [['G1', 'F1'], ['G2', 'F2']]) {
    const a = core.Assets.get(A[g].id);
    assert.equal(a.source, 'uploaded'); assert.equal(a.status, 'done'); assert.notEqual(a.image_path, A[g].image_path);
    assert.match(a.image_path, new RegExp('^assets/scenes/' + A[g].name + '_[0-9a-f]{8}\\.png$'));
    assert.equal(sha(fs.readFileSync(path.join(core.projectDir(pid), a.image_path))), sha(fs.readFileSync(path.join(core.projectDir(pid), A[f].image_path))));
    const x = r.items.find((i) => i.asset_id === A[g].id);
    assert.ok(fs.existsSync(x.result.archived)); assert.equal(sha(fs.readFileSync(x.result.archived)), x.result.old_sha256);
  }
  assert.ok(fs.existsSync(oldAbs), '旧文件不删');
  for (const k of ['G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G10', 'G12', 'G11']) assert.equal(core.Assets.get(A[k].id).source, 'generated', k + ' 不该被换');
  assert.equal(core.Assets.get(A.F1.id).image_path, A.F1.image_path, '定稿资产本身不动');
  const again = apc.runAssetPrecheck(pid, '第15章', { mode: 'swap', trigger: 'render' });
  assert.equal(again.summary.replaced, 0); assert.equal(again.summary.non_generated, 3);
  const log = fs.readFileSync(apc.precheckLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.mode === 'swap' && l.replaced.length === 2));
});

test('executeReplace：检查后资产被别人改过 → 跳过不动', () => {
  const plan = apc.runAssetPrecheck(pid, '第16章', { mode: 'dry', outDir });
  const it = { asset_id: A.G11.id, image_path: 'assets/scenes/别的.png', category: 'scene', name: '别章场景', final: { asset_id: A.F1.id, image_path: A.F1.image_path, sha256: 'x' } };
  const res = apc.executeReplace(pid, {}, it);
  assert.equal(res.skipped, true);
  assert.equal(core.Assets.get(A.G11.id).source, 'generated');
  assert.equal(plan.summary.generated, 1, '第16章只剩 G11（G2 已换）');
});

test('非 gap-list 项目 / 开关 off：不检查', () => {
  const p2 = core.Projects.create({ name: '别的项目' }).id;
  assert.equal(apc.runAssetPrecheck(p2, '第99章', { mode: 'swap' }), null);
  assert.equal(apc.runAssetPrecheck(pid, '第15章', { mode: 'off' }), null);
});

test('出错不抛：映射表坏行照样跑，返回结果', () => {
  fs.appendFileSync(path.join(root, '资产', 'IC定稿映射.csv'), '\r\n"未闭合引号,xx\r\n');
  const r = apc.runAssetPrecheck(pid, '第15章', { mode: 'dry', outDir });
  assert.ok(r && !r.error && r.summary);
});

test('generate_chapter_videos：在 prepare/上传参考图之前换图（ComfyUI 不通也已换完）', async () => {
  // 第16章 G11 加一条映射；prepare 会因 ComfyUI 不通失败，但换图必须已经发生
  mapCsv([{ target_id: A.G11.id, target_name: '别章场景', category: 'scene', final_asset_id: A.F1.id, final_pid: 'S900', basis: '工具接入测试' }]);
  const ctx = tools.createToolRuntime({ projectId: pid, chapter: '第16章', onProgress: () => {}, isAborted: () => false });
  const phases = []; const rep = ctx.report; ctx.report = (p) => { phases.push(p.phase); try { rep && rep(p); } catch { /* noop */ } };
  let out = null; let err = null;
  try { out = await tools.runTool(ctx, 'generate_chapter_videos', { chapter: '第16章' }); } catch (e) { err = e; }
  const a = core.Assets.get(A.G11.id);
  assert.equal(a.source, 'uploaded', '开渲前已换图（' + (err ? err.message : out) + '）');
  assert.ok(phases.includes('开渲前资产检查'));
});

test('起出片任务（startCreateJob，非 renderDisabled）：只列清单写进 checkpoint，不换图；只拆分镜任务不查', async () => {
  const jr = await import('../lib/agent/job-runner.js');
  const before = core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]);
  const job = jr.startCreateJob({ projectId: pid, chapter: '第15章', onProgress: () => {} });
  try {
    const cp = core.Jobs.get(job.id).checkpoint;
    assert.ok(cp.assetPrecheck, '应带开渲前检查摘要');
    assert.equal(cp.assetPrecheck.mode, 'list');
    assert.ok(cp.assetPrecheck.listed >= 1);
    assert.deepEqual(core.Assets.list(pid).map((a) => [a.id, a.image_path, a.source]), before);
  } finally { jr.stopJob(job.id); }
  await new Promise((r) => setTimeout(r, 300));
  const sbJob = jr.startCreateJob({ projectId: pid, chapter: '第16章', onProgress: () => {}, renderDisabled: true });
  try { assert.equal(core.Jobs.get(sbJob.id).checkpoint.assetPrecheck, undefined); } finally { jr.stopJob(sbJob.id); }
  await new Promise((r) => setTimeout(r, 300));
});
test('映射表只认 <asset_root>\\资产\\IC定稿映射.csv：环境变量和项目目录都不读', () => {
  process.env.IC_ASSET_FINAL_MAP = path.join(tmp, 'nope.csv');
  const files = apc.finalMapFiles(pid, { root });
  assert.deepEqual(files, [path.join(root, '资产', 'IC定稿映射.csv')]);
  assert.deepEqual(apc.finalMapFiles(pid, { root: '' }), []);
  delete process.env.IC_ASSET_FINAL_MAP;
});

function fileShaRel(rel) {
  const f = path.join(core.projectDir(pid), rel);
  return fs.existsSync(f) ? sha(fs.readFileSync(f)) : null;
}
function addGen(key, category, name) {
  const a = core.Assets.create(pid, { category, name, description: '' });
  const b = Buffer.from('IMG-' + key);
  const rel = put('assets/' + category + 's/' + key + '.png', b);
  core.Assets.update(a.id, { image_path: rel, status: 'done', source: 'generated' });
  return core.Assets.get(a.id);
}
function planFor(chapter, map) {
  return apc.planAssetPrecheck({
    chapter,
    shots: core.Shots.list(pid).filter((s) => s.chapter === chapter),
    assets: core.Assets.list(pid),
    map,
    deps: { fileSha: fileShaRel, busy: () => null, sheet: apc.loadOurSheet({ root }), aliases: null },
  });
}
function mapFromRows(rows) {
  const head = 'target_id,target_name,category,final_asset_id,final_pid,final_name,final_sha256,basis,shot_id';
  return apc.parseFinalMap('\uFEFF' + [head, ...rows].join('\r\n'));
}

test('映射表：默认行 + 覆盖行不算冲突；同一默认或同一 target+shot 重复才冲突', () => {
  const ok = apc.parseFinalMap('target_id,final_asset_id,shot_id\r\na,b,\r\na,c,shot-1\r\n');
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.entries.length, 2);
  assert.ok(ok.entries.every((e) => !e.conflict));
  assert.equal(apc.resolveMapEntry(ok, 'a', 'shot-1').kind, 'override');
  assert.equal(apc.resolveMapEntry(ok, 'a', 'shot-1').entry.final_asset_id, 'c');
  assert.equal(apc.resolveMapEntry(ok, 'a', 'other-shot').kind, 'default');
  assert.equal(apc.resolveMapEntry(ok, 'a', 'other-shot').entry.final_asset_id, 'b');
  assert.equal(apc.resolveMapEntry(ok, 'a', '16#14').kind, 'default');
  const dupDef = apc.parseFinalMap('target_id,final_asset_id,shot_id\r\na,b,\r\na,d,\r\n');
  assert.equal(dupDef.entries.length, 1); assert.equal(dupDef.entries[0].conflict, true);
  const dupOv = apc.parseFinalMap('target_id,final_asset_id,shot_id\r\na,b,s1\r\na,c,s1\r\n');
  assert.equal(dupOv.entries.length, 1); assert.equal(dupOv.entries[0].conflict, true);
});

test('映射表：只有默认行时，各镜头都用默认定稿并可整资产换图', () => {
  core.Chapters.create(pid, { title: '第18章', script: 'x' });
  const T = addGen('T18def', 'scene', '默认真厅');
  const s1 = core.Shots.create(pid, { chapter: '第18章', idx: 1, scene_ids: [T.id], video_prompt: 'a' });
  const s2 = core.Shots.create(pid, { chapter: '第18章', idx: 2, scene_ids: [T.id], video_prompt: 'b' });
  const map = mapFromRows([
    [T.id, '默认真厅', 'scene', A.F1.id, 'S900', '酒店门口送别区', sha(Buffer.from('IMG-F1')), '默认', ''].join(','),
  ]);
  assert.equal(map.errors.length, 0);
  assert.equal(apc.resolveMapEntry(map, T.id, s1.id).kind, 'default');
  assert.equal(apc.resolveMapEntry(map, T.id, s2.id).entry.final_pid, 'S900');
  const item = planFor('第18章', map).items.find((i) => i.asset_id === T.id);
  assert.equal(item.action + ':' + item.code, 'replace:mapping');
  assert.equal(item.final.pid, 'S900');
  assert.deepEqual(item.shots, [1, 2]);
});

test('映射表：默认 + 按镜头覆盖时，覆盖镜用覆盖定稿，其余镜用默认，且不能整资产换图', () => {
  core.Chapters.create(pid, { title: '第21章', script: 'x' });
  const T = addGen('T21mix', 'scene', '牡丹厅试验');
  const sDef = core.Shots.create(pid, { chapter: '第21章', idx: 1, scene_ids: [T.id], video_prompt: 'a' });
  const sOv = core.Shots.create(pid, { chapter: '第21章', idx: 2, scene_ids: [T.id], video_prompt: 'b' });
  const map = mapFromRows([
    [T.id, '牡丹厅试验', 'scene', A.F1.id, 'S900', '酒店门口送别区', sha(Buffer.from('IMG-F1')), '默认', ''].join(','),
    [T.id, '牡丹厅试验', 'scene', A.F2.id, 'S901', '金店', sha(Buffer.from('IMG-F2')), '覆盖', sOv.id].join(','),
  ]);
  assert.equal(map.errors.length, 0);
  assert.equal(apc.resolveMapEntry(map, T.id, sDef.id).kind, 'default');
  assert.equal(apc.resolveMapEntry(map, T.id, sDef.id).entry.final_pid, 'S900');
  assert.equal(apc.resolveMapEntry(map, T.id, sOv.id).kind, 'override');
  assert.equal(apc.resolveMapEntry(map, T.id, sOv.id).entry.final_pid, 'S901');
  const item = planFor('第21章', map).items.find((i) => i.asset_id === T.id);
  assert.equal(item.action, 'list');
  assert.equal(item.code, 'mapping-per-shot');
  const byIdx = Object.fromEntries(item.resolutions.map((x) => [x.idx, x]));
  assert.equal(byIdx[1].final_pid, 'S900');
  assert.equal(byIdx[2].final_pid, 'S901');
  assert.equal(byIdx[1].shot_id, sDef.id);
  assert.equal(byIdx[2].shot_id, sOv.id);
});

test('映射表：仅例外目标时，只有该镜头替换，其他镜头不替换', () => {
  core.Chapters.create(pid, { title: '第22章', script: 'x' });
  const T = addGen('T22only', 'scene', '办公室试验');
  const sOv = core.Shots.create(pid, { chapter: '第22章', idx: 1, scene_ids: [T.id], video_prompt: 'a' });
  const sOther = core.Shots.create(pid, { chapter: '第22章', idx: 2, scene_ids: [T.id], video_prompt: 'b' });
  const map = mapFromRows([
    [T.id, '办公室试验', 'scene', A.F2.id, 'S901', '金店', sha(Buffer.from('IMG-F2')), '仅例外', sOv.id].join(','),
  ]);
  assert.equal(map.errors.length, 0);
  assert.equal(apc.resolveMapEntry(map, T.id, sOv.id).kind, 'override');
  assert.equal(apc.resolveMapEntry(map, T.id, sOv.id).entry.final_pid, 'S901');
  assert.equal(apc.resolveMapEntry(map, T.id, sOther.id).kind, 'none');
  assert.equal(apc.resolveMapEntry(map, T.id, sOther.id).entry, null);
  const item = planFor('第22章', map).items.find((i) => i.asset_id === T.id);
  assert.equal(item.action, 'list');
  assert.equal(item.code, 'mapping-per-shot');
  const byIdx = Object.fromEntries(item.resolutions.map((x) => [x.idx, x]));
  assert.equal(byIdx[1].final_pid, 'S901');
  assert.equal(byIdx[2].final_pid, '');
  assert.equal(byIdx[2].kind, 'none');
});
