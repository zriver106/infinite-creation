// 重审（总导 11-26：手工线导入成已审定稿的 _MV，IC 审图从来没审过）：用现在的审图 Agent 和必核项重审已写回的图。
// 过了不动；不过按开关标需人工（图不动）或按原线程退回那一格（只重出那一格，拼板核对过了才写回）。假 am，不连 Muse、不起 CLI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rr-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let W; let AI; let RV; let G;
before(async () => {
  core = await import('../lib/core/index.js');
  W = await import('../lib/core/asset-image-work.js');
  AI = await import('../lib/agent/asset-image.js');
  RV = await import('../lib/agent/asset-image-review-mcp.js');
  G = await import('../lib/core/asset-gaps.js');
});

const png = (f, color = 'gray', size = '64x36') => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=' + size, '-frames:v', '1', f]); return f; };
const CHECKS_OK = Object.fromEntries(['same_space', 'style_vs_sample', 'ethnicity', 'base_image', 'count_orientation', 'no_text', 'color_temp', 'appearance_vs_desc'].map((k) => [k, { ok: true, note: '看过' }]));
const CHECKS_BAD = { ...CHECKS_OK, count_orientation: { ok: false, note: 'B 朝向和 D 对不上' } };
const LIST = [{ item: '门', expected: '南', seen: '南', ok: true }, { item: '饮水机', expected: '东', seen: '东', ok: true }, { item: '机位标注', expected: '本张', seen: '本张', ok: true }];
const waitFor = async (fn) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

function fakeAm() {
  const sent = []; const outbox = {}; const puts = [];
  return {
    sent, outbox, puts,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true, confirmed: true }; },
    put: async (local, remote) => { puts.push(remote); return { ok: true }; },
    list: async () => ({ ok: true, files: Object.keys(outbox).map((name) => ({ name, size: 1 })) }),
    get: async (remote, local) => { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.copyFileSync(outbox[path.basename(remote)], local); return { ok: true }; },
    runReview: null, agentId: 'claude',
  };
}

// 一张手工线导入的 _MV（2×2 已写回、补登了 imported_approved.json）+ 一张 IC 自己审过的道具
function setup(name) {
  const p = core.Projects.create({ name, auto_script: false });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's-scene', lane: 'scene' }, { name: '道具1', session: 's-prop', lane: 'prop' }]);
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  const prop = core.Assets.create(p.id, { category: 'prop', name: '工牌' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·工位区·多视角定义图', location_id: 'L01', requirement: 'a' }, { kind: 'prop', name: '工牌', requirement: 'b' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; doc.items[1].asset_id = prop.id;
  fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const rel = 'assets/scenes/l01_mv.png'; png(path.join(core.projectDir(p.id), rel), 'blue', '128x72'); core.Assets.update(mv.id, { image_path: rel });
  fs.mkdirSync(W.roundsDir(p.id, mv.id), { recursive: true });
  fs.writeFileSync(path.join(W.roundsDir(p.id, mv.id), 'imported_approved.json'), JSON.stringify({ image_path: rel, source: '手工线' }));
  const prel = 'assets/props/badge.png'; png(path.join(core.projectDir(p.id), prel), 'red'); core.Assets.update(prop.id, { image_path: prel });
  return { p, mv, prop, rel };
}

test('重审手工线导入的：只挑导入的；_MV 按 2×2 拼板逐格核（四格都给审图看）；过了图不动，结论另存不覆盖原记录', async () => {
  const { p, mv, prop, rel } = setup('rr-1');
  const am = fakeAm(); let seen = null;
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; seen = cp; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK, checklist: LIST })); };
  const r = await AI.reReview(p.id, { scope: 'imported' }, am);
  assert.deepEqual(r.queued.map((x) => x.asset_id), [mv.id], '只挑手工线导入的，不挑道具');
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'passed'));
  assert.equal(seen.step, 'compose'); assert.equal(seen.rereview, 1);
  assert.deepEqual(Object.keys(seen.approved).sort(), ['A', 'B', 'C', 'D']);
  assert.ok(fs.existsSync(path.join(W.roundsDir(p.id, mv.id), 'review_rereview1_compose.json')));
  assert.equal(core.Assets.get(mv.id).image_path, rel, '过了图不动');
  assert.equal((core.Assets.get(mv.id).versions || []).length, 0);
  assert.match(W.loadWork(p.id).items[mv.id].note, /重审过/);
  const row = W.rowsWithStatus(p.id).find((x) => x.asset_id === mv.id);
  assert.equal(row.imported, true); assert.equal(row.last_rereview.verdict, 'pass');
  assert.equal(W.rowsWithStatus(p.id).find((x) => x.asset_id === prop.id).imported, false);
  assert.ok(core.Jobs.list(p.id).some((j) => j.type === AI.REVIEW_JOB && /重审：1 张进审图/.test(j.detail || '')));
});

test('重审不过、开关「标需人工」：图不动，行标需人工、写明原因；不发 am', async () => {
  const { p, mv, rel } = setup('rr-2');
  const am = fakeAm();
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'return', checks: CHECKS_BAD, checklist: LIST, return_note: 'B 朝向和 D 对不上', redo_step: 'B' })); };
  await AI.reReview(p.id, { asset_ids: [mv.id], on_fail: 'needs_human' }, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'needs_human'));
  assert.match(W.loadWork(p.id).items[mv.id].note, /重审没过.*B 朝向/);
  assert.equal(core.Assets.get(mv.id).image_path, rel);
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 0);
});

test('重审不过、开关「按原线程退回」：排队退回那一格 → 线程空了发「【重审退回】」附原图和其余格 → 只重出 B，跳过 C/D 直接拼板核对，过了才写回（旧图进 versions）', async () => {
  const { p, mv, rel } = setup('rr-3');
  const am = fakeAm(); const steps = [];
  am.runReview = async ({ jobId }) => {
    const cp = core.Jobs.get(jobId).checkpoint; steps.push(cp.rereview ? 'rereview' : cp.step);
    const res = cp.rereview ? { verdict: 'return', checks: CHECKS_BAD, checklist: LIST, return_note: 'B 朝向和 D 对不上，门应在左手', redo_step: 'B' } : { verdict: 'pass', checks: CHECKS_OK, checklist: LIST };
    fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify(res));
  };
  await AI.reReview(p.id, { asset_ids: [mv.id], on_fail: 'return' }, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'return_queued'));
  // 别的单占着场景线程：等它空
  let w = W.loadWork(p.id); w.threads['场景1'] = { current: 'other' }; W.saveWork(p.id, w);
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 0, '线程在忙不插队');
  w = W.loadWork(p.id); w.threads['场景1'] = { current: null }; W.saveWork(p.id, w);
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 1); assert.equal(am.sent[0].session, 's-scene');
  assert.match(am.sent[0].text, /【重审退回】B 朝向和 D 对不上/); assert.match(am.sent[0].text, /原图/);
  assert.ok(am.puts.some((x) => /_rr_B/.test(x))); assert.ok(['A', 'C', 'D'].every((c) => am.puts.some((x) => x.includes('_' + c + '_ok'))));
  const it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.step, 'B'); assert.equal(it.status, 'sent');
  am.outbox[it.prefix + '_L01.png'] = png(path.join(tmp, 'b2.png'), 'green');
  await AI.tick(p.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'passed'));
  assert.deepEqual(steps, ['rereview', 'B', 'compose'], '只重出 B，C/D 沿用，拼板核对过了才写回');
  const a = core.Assets.get(mv.id);
  assert.notEqual(a.image_path, rel); assert.ok(a.versions.includes(rel));
  assert.equal(W.loadWork(p.id).items[mv.id].redo_only, undefined);
});

test('在途的不重审（写明跳过原因）；没图的跳过；参数要给范围；重审 _MV 退回要填 redo_step', async () => {
  const { p, mv, prop } = setup('rr-4');
  const w = W.loadWork(p.id); w.items[prop.id] = { name: '工牌', lane: 'prop', steps: ['main'], stepIdx: 0, round: 1, status: 'sent', approved: {}, returns: [], history: [] }; W.saveWork(p.id, w);
  const am = fakeAm(); am.runReview = async () => {};
  const r = await AI.reReview(p.id, { asset_ids: [prop.id] }, am);
  assert.equal(r.queued.length, 0); assert.match(r.skipped[0].why, /正在出图/);
  core.Assets.update(mv.id, { image_path: '' });
  const r2 = await AI.reReview(p.id, { asset_ids: [mv.id] }, am);
  assert.equal(r2.queued.length, 0); assert.match(r2.skipped[0].why, /没有写回的图/);
  assert.throws(() => AI.reReview(p.id, {}, am), /scope/);
  assert.throws(() => AI.reReview(p.id, { scope: 'all', on_fail: 'x' }, am), /on_fail/);
  const bad = { verdict: 'return', checks: CHECKS_BAD, checklist: LIST, return_note: 'x' };
  assert.match(RV.validateReview(bad, { step: 'compose', isMv: true, isScene: true, rereview: true }), /redo_step/);
  assert.equal(RV.validateReview({ ...bad, redo_step: 'B' }, { step: 'compose', isMv: true, isScene: true, rereview: true }), '');
  assert.equal(RV.validateReview(bad, { step: 'compose', isMv: true, isScene: true }), '', '平常的拼板核对不要求 redo_step');
  assert.match(RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'L01_MV', step: 'compose', round: 1, rereview: 2 } }), /这一轮是重审[\s\S]*redo_step/);
  assert.doesNotMatch(RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'L01_MV', step: 'compose', round: 1, rereview: 2 } }), /这一轮是拼板核对/);
});

test('人物外形逐项核（韩志成·上班装）：人物 / 服装 / 年龄图 appearance_vs_desc 不能 na；场景可以 na；审图上下文带本资产和所属角色的描述', async () => {
  const ok = { verdict: 'pass', checks: { ...CHECKS_OK, appearance_vs_desc: { ok: 'na', note: '不适用' } } };
  assert.match(RV.validateReview(ok, { isPerson: true }), /appearance_vs_desc/);
  assert.equal(RV.validateReview({ ...ok, checks: { ...ok.checks, same_space: { ok: 'na', note: '不适用' }, color_temp: { ok: 'na', note: '不适用' } } }, { isPerson: false }), '');
  const bad = { verdict: 'pass', checks: { ...CHECKS_OK, appearance_vs_desc: { ok: false, note: '描述三十七八岁略发福后梳深灰裤 / 图里约三十偏瘦侧分藏青裤' } } };
  assert.match(RV.validateReview(bad, { isPerson: true }), /只能是 return/);
  const p = core.Projects.create({ name: 'rr-5', auto_script: false });
  const han = core.Assets.create(p.id, { category: 'character', name: '韩志成', description: '三十七八岁，略发福，头发后梳' });
  const cos = core.Assets.create(p.id, { category: 'costume', name: '韩志成·上班装', parent_id: han.id, description: '白衬衫，深灰西裤' });
  G.mergeGapList(p.id, { items: [{ kind: 'costume', name: '韩志成·上班装', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = cos.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const j = core.Jobs.create({ projectId: p.id, type: AI.REVIEW_JOB, checkpoint: { asset_id: cos.id, name: '韩志成·上班装', step: 'main', round: 1, file: path.join(tmp, 'x.png') } });
  const ctx = JSON.parse(await RV.runReviewExtraTool({ projectId: p.id, jobId: j.id }, 'get_review_context'));
  assert.match(ctx.asset_description.self, /深灰西裤/); assert.match(ctx.asset_description.parent.description, /略发福/);
  assert.ok(ctx.checks_required.appearance_vs_desc);
  await assert.rejects(RV.runReviewExtraTool({ projectId: p.id, jobId: j.id }, 'submit_review', ok), /appearance_vs_desc/);
  assert.match(RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'a', step: 'main', round: 1 } }), /年龄段、体型、发型和发际线/);
});

test('缺口 27：_MV 人工退回不默认选格，没选就拒；缺口 13：退错了能撤回——原线程补发作废、它交回来的图不收、恢复退回前已审的格', async () => {
  const p = core.Projects.create({ name: 'rr-6', auto_script: false });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's-scene', lane: 'scene' }]);
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L09_MV·某地·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L09_MV·某地·多视角定义图', location_id: 'L09', requirement: 'a' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const cells = { A: png(path.join(tmp, '6a.png'), 'red'), B: png(path.join(tmp, '6b.png'), 'green'), C: png(path.join(tmp, '6c.png'), 'white'), D: png(path.join(tmp, '6d.png'), 'blue') };
  const w = W.loadWork(p.id);
  w.items[mv.id] = { name: 'L09_MV·某地·多视角定义图', lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 3, step: 'D', round: 1, status: 'needs_human', approved: { ...cells }, returns: [], history: [], thread: '场景1' };
  W.saveWork(p.id, w);
  const am = fakeAm(); am.runReview = async () => {};
  await assert.rejects(AI.manualReturn(p.id, mv.id, { note: '改 A 的门' }, am), /自己选退哪一格/);
  // 退错格：意见是改 A，却选了 D
  await AI.manualReturn(p.id, mv.id, { note: '改 A 的门', step: 'D' }, am);
  let it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.step, 'D'); assert.equal(it.status, 'sent'); assert.equal(it.approved.D, undefined);
  const wrongPrefix = it.prefix;
  await assert.rejects(AI.cancelInflight(p.id, mv.id, {}, am), /撤回原因/);
  const r = await AI.cancelInflight(p.id, mv.id, { reason: '退错格了，意见是改 A 却选了 D' }, am);
  assert.equal(r.notified, true);
  assert.equal(am.sent.length, 2); assert.equal(am.sent[1].session, 's-scene');
  assert.match(am.sent[1].text, /【作废】上一条指令作废/); assert.ok(am.sent[1].text.includes(wrongPrefix));
  it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.status, 'needs_human'); assert.match(it.note, /已撤回/); assert.equal(it.approved.D, cells.D, '恢复退回前已审过的 D');
  assert.equal(W.loadWork(p.id).threads['场景1'].current, null);
  // 撤回后重新按正确的格退回；作废那张晚到了也不收
  await AI.manualReturn(p.id, mv.id, { note: '改 A 的门', step: 'A' }, am);
  it = W.loadWork(p.id).items[mv.id];
  am.outbox[wrongPrefix + '_L09.png'] = png(path.join(tmp, '6late.png'), 'yellow');
  await AI.tick(p.id, am);
  it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.status, 'sent', '作废那张不收'); assert.equal(it.step, 'A');
  await assert.rejects(AI.cancelInflight(p.id, 'nope', { reason: 'x' }, am), /没有在途/);
});

test('拼板核对：D 是复用的，提示词写明机位标注不算不一致、只核空间布局；非复用照旧核机位标注', () => {
  const reused = RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'L01_MV', step: 'compose', round: 1, reused_d: true } });
  assert.match(reused, /机位标注.*不算不一致/); assert.match(reused, /门窗的位置和数量、家具的数量和朝向、通道/);
  assert.doesNotMatch(reused, /借来的 D 上标的是别张的机位就不对/);
  const normal = RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'L01_MV', step: 'compose', round: 1 } });
  assert.match(normal, /借来的 D 上标的是别张的机位就不对/);
});
