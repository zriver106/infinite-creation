// 场景三视图审图（手册 13 号；总导 11-28）：逐件清单的百分比、宽高比、结论校验（比例不过 / 有件不对强制 fail）、
// 过了写 art/ + 白板 + 备份、不过 art/ 不动、只交两张时沿用已定稿。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sr-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let SR; let MCP; let AG; let SM;
before(async () => {
  core = await import('../lib/core/index.js');
  SM = await import('../lib/core/scene-master.js');
  SR = await import('../lib/core/scene-review.js');
  MCP = await import('../lib/agent/scene-review-mcp.js');
  AG = await import('../lib/agent/scene-review.js');
});

const png = (abs, size, color = 'gray') => { fs.mkdirSync(path.dirname(abs), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=' + size, '-frames:v', '1', abs]); return abs; };
const NAMES = { plan: '平面图', front: '正视图', left: '左视图', right: '右视图' };
const MASTER = {
  scene_id: 'L09-小店', name: '小店',
  room: { x0: 0, y0: 0, x1: 10, y1: 5, h: 3 },
  openings: [{ id: 'D1', name: '店门', side: 'south', kind: 'door', from: 4, to: 6 }, { id: 'W1', name: '东窗', side: 'east', kind: 'window', from: 1, to: 4 }],
  items: [{ id: 'C1', name: '椅子', type: 'chair', center: [2, 1], size: [0.6, 0.4] }, { id: 'T1', name: '柜台', box: [5, 3, 0, 9, 4, 1] }, { id: 'P1', name: '花盆', center: [1, 4], size: 0.4 }],
};

function setupScene(name) {
  const p = core.Projects.create({ name, auto_script: false });
  const dir = SM.sceneMasterDir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MASTER.scene_id + '.json'), JSON.stringify(MASTER));
  for (const n of Object.values(NAMES)) { png(path.join(dir, MASTER.scene_id, n + '.png'), '160x96'); png(path.join(dir, MASTER.scene_id, n + '_标注.png'), '160x96'); }
  return p;
}
const cand = (name, views, size = '320x192', color = 'green') => { const d = path.join(tmp, 'cand_' + name); for (const v of views) png(path.join(d, 'art_' + v + '.png'), size, color); return d; };
const allItems = () => [{ id: 'C1', expected: '17–23%', seen_pct: '18–23%', ok: true }];
const submitAll = (over = {}) => ({ verdict: 'pass', views: SR.VIEW_KEYS.map((k) => ({ view: k, verdict: 'pass', items: allItems(), defects: [], fix_note: '', ...(over[k] || {}) })) });
const fakeDeps = (projectId, args) => ({ agentId: 'claude', runReview: async ({ jobId }) => { await MCP.runSceneReviewTool({ projectId, jobId }, 'submit_scene_review', args); } });

test('逐件清单：各视图横向百分比（平面 / 正视从西数，左视从北数，右视从南数），列表尺寸的椅子、门窗正对 / 侧面', () => {
  const cl = SR.sceneChecklist(MASTER);
  const c1 = cl.find((x) => x.id === 'C1');
  assert.deepEqual(c1.span, { plan: [17, 23], front: [17, 23], left: [76, 84], right: [16, 24] });
  assert.deepEqual(cl.find((x) => x.id === 'T1').span, { plan: [50, 90], front: [50, 90], left: [20, 40], right: [60, 80] });
  assert.deepEqual(cl.find((x) => x.id === 'P1').span.plan, [8, 12]);
  const d1 = cl.find((x) => x.id === 'D1');
  assert.deepEqual(d1.span.plan, [40, 60]); assert.equal(d1.face.front, 'removed'); assert.equal(d1.face.left, 'edge_on');
  const w1 = cl.find((x) => x.id === 'W1');
  assert.deepEqual(w1.span.plan, [100, 100], '东墙门窗在平面图最右'); assert.deepEqual(w1.span.left, [20, 80]); assert.equal(w1.face.left, 'face_on'); assert.equal(w1.face.front, 'edge_on'); assert.equal(w1.face.right, 'removed');
  const ws = SR.sceneChecklist({ room: MASTER.room, workstations: { desk: { w: 1, d: 0.5 }, cols: [{ id: 'a', x: 2 }, { id: 'b', x: 4 }], rows: [{ id: 'R1', y: 3 }] }, fixtures: [{ id: 'LED', name: '灯', grid: { cols_x: [2, 8], rows_y: [1, 4] }, w: 1, d: 0.5 }] });
  assert.equal(ws.find((x) => x.id === 'WS').count, 2, '工位按一组一行');
  assert.equal(ws.find((x) => x.id === 'LED').count, 4);
});

test('宽高比：整图差 >10% 判不过', () => {
  const g = png(path.join(tmp, 'r_g.png'), '160x96');
  assert.equal(SR.ratioCheck(g, png(path.join(tmp, 'r_ok.png'), '320x200')).fail, false);
  const bad = SR.ratioCheck(g, png(path.join(tmp, 'r_bad.png'), '300x300'));
  assert.equal(bad.fail, true); assert.ok(bad.img_ratio < 0.9);
});

test('结论校验：比例不过强制 fail；有件 ok=false 强制该视图 fail；总结论跟着改；主动判 fail 要写 fix_note', () => {
  let v = MCP.validateSceneReview(submitAll(), { ratio: { left: { img_ratio: 1.3, fail: true } } });
  assert.equal(v.result.verdict, 'fail');
  assert.equal(v.result.views.find((x) => x.view === 'left').verdict, 'fail');
  assert.ok(v.result.views.find((x) => x.view === 'left').fix_note);
  assert.ok(v.forced.some((f) => /宽高比/.test(f)));
  v = MCP.validateSceneReview(submitAll({ front: { items: [{ id: 'C1', expected: '17–23%', seen_pct: '40%', ok: false }] } }));
  assert.equal(v.result.views.find((x) => x.view === 'front').verdict, 'fail');
  assert.equal(v.result.verdict, 'fail');
  assert.match(MCP.validateSceneReview(submitAll({ plan: { verdict: 'fail' } })).error, /fix_note/);
  assert.match(MCP.validateSceneReview({ verdict: 'pass', views: submitAll().views.slice(0, 3) }).error, /缺 right/);
  assert.match(MCP.validateSceneReview(submitAll({ plan: { items: [] } })).error, /items/);
  assert.equal(MCP.validateSceneReview(submitAll()).result.verdict, 'pass');
});

test('阈值集中在 REVIEW_LIMITS：位置差 >12% 改判不对、≤12% 不判；尺寸差 2 倍及以上才判；审图判的不对不会被改成对', () => {
  assert.deepEqual({ ...SR.REVIEW_LIMITS }, { ratio_tol: 0.10, pos_tol_pct: 12, size_factor: 2, margin_judged: false });
  const one = (exp, seen, ok = true) => MCP.validateSceneReview(submitAll({ front: { items: [{ id: 'T1', expected: exp, seen_pct: seen, ok }] } }));
  assert.equal(one('17–23%', '28–34%').result.verdict, 'pass', '中心差 11%，不判');
  let v = one('17–23%', '33–39%');
  assert.equal(v.result.verdict, 'fail', '中心差 16%');
  assert.equal(v.result.views.find((x) => x.view === 'front').items[0].ok, false);
  assert.ok(v.forced.some((f) => /位置差/.test(f)));
  assert.equal(one('40-60%', '42-58%').result.verdict, 'pass', '尺寸差 1.25 倍，不判（ASCII 连字符也能读）');
  v = one('40–60%', '45–55%');
  assert.equal(v.result.verdict, 'fail', '尺寸只剩一半');
  assert.ok(v.forced.some((f) => /尺寸差 2\.0 倍/.test(f)));
  assert.equal(one('100–100%', '98–100%').result.verdict, 'pass', '侧面成一条边的门窗不比尺寸');
  assert.equal(one('17–23%', '18–23%', false).result.verdict, 'fail', '审图判不对的照旧不对（数量、朝向等）');
  assert.equal(SR.itemLimitIssue('50%', '61%'), '');
  assert.match(SR.itemLimitIssue('50%', '63%'), /位置差 13%/);
});

test('过：旧 art/ 备份到 art_history，四张写进 art/，拼白板_2x2.jpg', async () => {
  const p = setupScene('sr-pass');
  const ad = SR.artDir(p.id, MASTER.scene_id);
  for (const n of Object.values(NAMES)) png(path.join(ad, n + '.png'), '320x192', 'red');
  const r = AG.reviewSceneCandidates(p.id, MASTER.scene_id, cand('pass', SR.VIEW_KEYS), {}, fakeDeps(p.id, submitAll()));
  assert.equal(r.round, 'r1');
  assert.ok(fs.existsSync(SR.overviewFile(p.id, MASTER.scene_id, 'r1')), '登记时拼好审图总览');
  const out = await r.done;
  assert.equal(out.status, 'accepted');
  assert.ok(fs.existsSync(path.join(ad, SR.WHITEBOARD)));
  assert.ok(out.backup && fs.existsSync(path.join(out.backup, '平面图.png')), '旧图有备份');
  assert.notEqual(fs.readFileSync(path.join(ad, '平面图.png')).toString('base64'), fs.readFileSync(path.join(out.backup, '平面图.png')).toString('base64'));
  assert.ok(SM.sceneMasterArtViews(p.id, MASTER.scene_id), '四张齐，参考图能送');
  assert.equal(core.Jobs.get(r.job_id).status, 'done');
  assert.equal(SR.loadRound(p.id, MASTER.scene_id, 'r1').status, 'accepted');
  assert.throws(() => AG.startSceneReview(p.id, MASTER.scene_id, 'r1', fakeDeps(p.id, submitAll())), /已经审过/);
});

test('不过：art/ 不动，写 review.json 和退回意见；第一轮四张没交齐不让登记', async () => {
  const p = setupScene('sr-fail');
  assert.throws(() => SR.registerRound(p.id, MASTER.scene_id, cand('fail_part', ['plan'])), /还没有定稿/);
  const r = AG.reviewSceneCandidates(p.id, MASTER.scene_id, cand('fail', SR.VIEW_KEYS), {}, fakeDeps(p.id, submitAll({ right: { items: [{ id: 'C1', expected: '16–24%', seen_pct: '60%', ok: false }], defects: ['多了一个柜子'], fix_note: '椅子挪回画面左侧 16–24%，删掉多出的柜子' } })));
  const out = await r.done;
  assert.equal(out.status, 'returned'); assert.deepEqual(out.failed_views, ['right']);
  assert.ok(!fs.existsSync(SR.artDir(p.id, MASTER.scene_id)), 'art/ 没写');
  const note = fs.readFileSync(out.return_note, 'utf8');
  assert.match(note, /右视图/); assert.match(note, /多了一个柜子/); assert.match(note, /椅子挪回/);
  assert.equal(SR.loadReviewResult(p.id, MASTER.scene_id, r.round).verdict, 'fail');
  // 下一轮能看到上次的退回意见
  const r2 = SR.registerRound(p.id, MASTER.scene_id, cand('fail2', SR.VIEW_KEYS));
  assert.equal(r2.round, 'r2');
  assert.equal(SR.previousReturns(p.id, MASTER.scene_id, 'r2')[0].views[0].view, 'right');
});

test('比例不过的图即使审图判过也不写回', async () => {
  const p = setupScene('sr-ratio');
  const r = AG.reviewSceneCandidates(p.id, MASTER.scene_id, cand('ratio', SR.VIEW_KEYS, '300x300'), {}, fakeDeps(p.id, submitAll()));
  assert.equal(r.ratio.plan.fail, true);
  const out = await r.done;
  assert.equal(out.status, 'returned');
  assert.ok(!fs.existsSync(SR.artDir(p.id, MASTER.scene_id)));
});

test('只交两张：没交的沿用已定稿 art/，四张一起审，过了只换交的两张', async () => {
  const p = setupScene('sr-partial');
  const ad = SR.artDir(p.id, MASTER.scene_id);
  for (const n of Object.values(NAMES)) png(path.join(ad, n + '.png'), '320x192', 'red');
  const before = fs.readFileSync(path.join(ad, '正视图.png'));
  let ctxSeen = null;
  const deps = { agentId: 'claude', runReview: async ({ jobId }) => {
    ctxSeen = JSON.parse(await MCP.runSceneReviewTool({ projectId: p.id, jobId }, 'get_scene_review_context', {}));
    await MCP.runSceneReviewTool({ projectId: p.id, jobId }, 'submit_scene_review', submitAll());
  } };
  const r = AG.reviewSceneCandidates(p.id, MASTER.scene_id, cand('partial', ['plan', 'left'], '320x192', 'blue'), {}, deps);
  assert.deepEqual(r.new_views, ['plan', 'left']); assert.deepEqual(r.fallback_views, ['front', 'right']);
  const rd = SR.roundDir(p.id, MASTER.scene_id, r.round);
  for (const k of SR.VIEW_KEYS) assert.ok(fs.existsSync(path.join(rd, 'art_' + k + '.png')));
  assert.deepEqual(fs.readFileSync(path.join(rd, 'art_front.png')), before, '没交的视图拷的是已定稿图');
  const out = await r.done;
  assert.equal(out.status, 'accepted');
  assert.deepEqual(ctxSeen.new_views, ['plan', 'left']);
  assert.ok(ctxSeen.checklist.some((x) => x.id === 'C1'));
  assert.deepEqual(ctxSeen.limits, { ...SR.REVIEW_LIMITS }, '审图 Agent 看得到当前阈值');
  assert.deepEqual(fs.readFileSync(path.join(ad, '正视图.png')), before, '沿用的那张写回后不变');
  assert.notDeepEqual(fs.readFileSync(path.join(ad, '平面图.png')), before);
});

test('受限工具集：只列场景审图工具；看图工具带图', async () => {
  const p = setupScene('sr-tools');
  const reg = SR.registerRound(p.id, MASTER.scene_id, cand('tools', SR.VIEW_KEYS));
  const job = core.Jobs.create({ projectId: p.id, type: AG.SCENE_REVIEW_JOB, checkpoint: { scene_id: MASTER.scene_id, round: reg.round } });
  const ctx = { projectId: p.id, jobId: job.id };
  assert.deepEqual(MCP.sceneReviewToolDefinitions().map((t) => t.function.name), ['get_scene_review_context', 'view_overview', 'view_gray', 'view_art', 'submit_scene_review']);
  for (const [n, a] of [['view_overview', {}], ['view_gray', { view: 'left', labelled: true }], ['view_art', { view: 'right' }]]) {
    const r = await MCP.runSceneReviewTool(ctx, n, a);
    assert.equal(r.images.length, 1, n);
  }
  assert.match(MCP.buildSceneReviewAgentPrompt({ project: { name: 'V3' }, cp: { scene_id: MASTER.scene_id, round: reg.round } }), /submit_scene_review/);
  const pr = MCP.buildSceneReviewAgentPrompt({ project: { name: 'V3' }, cp: { scene_id: MASTER.scene_id, round: reg.round } });
  assert.match(pr, /12%/); assert.match(pr, /2 倍/); assert.match(pr, /透视/); assert.doesNotMatch(pr, /8%/);
});
