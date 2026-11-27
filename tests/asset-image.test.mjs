// 资产出图收回 IC（总导 11-26）：派单 → 收图 → 审图 → 写回 / 退回；_MV 四格 + 拼板；卡住不重派；审图结论校验。假 am，不连 Muse、不起 CLI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-aimg-'));
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

const png = (f, color = 'gray') => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=64x36', '-frames:v', '1', f]); return f; };
const CHECKS_OK = Object.fromEntries(Object.keys({ same_space: 1, style_vs_sample: 1, ethnicity: 1, base_image: 1, count_orientation: 1, no_text: 1, color_temp: 1, appearance_vs_desc: 1 }).map((k) => [k, { ok: true, note: '看过' }]));

// 假 am：记下发出的消息；回图靠测试往 outbox 放文件
function fakeAm() {
  const sent = []; const outbox = {}; const puts = [];
  return {
    sent, outbox, puts,
    send: async (session, text) => { sent.push({ session, text }); return { ok: true, confirmed: true }; },
    put: async (local, remote) => { puts.push(remote); return { ok: true }; },
    list: async () => ({ ok: true, files: Object.keys(outbox).map((name) => ({ name, size: 1 })) }),
    get: async (remote, local) => { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.copyFileSync(outbox[path.basename(remote)], local); return { ok: true }; },
    verdicts: [],
    runReview: null, agentId: 'claude',
  };
}
const waitFor = async (fn) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

function setup(name) {
  const p = core.Projects.create({ name, auto_script: false });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '人物1', session: 's-person', lane: 'person' }, { name: '场景1', session: 's-scene', lane: 'scene' }]);
  return p;
}

test('人物单张：派单 → 回图 → 审过写回原 asset_id（旧图进 versions）→ 父角色同图', async () => {
  const p = setup('aimg-1');
  const jc = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  const cos = core.Assets.create(p.id, { category: 'costume', name: '江澈·T恤装', parent_id: jc.id });
  core.Assets.update(cos.id, { image_path: 'assets/old.png' });
  G.mergeGapList(p.id, { items: [{ kind: 'costume', name: '江澈·T恤装', requirement: '灰蓝T恤' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = cos.id;
  doc.items.push({ kind: 'character', name: '江澈', asset_id: jc.id, need_image: false, base_image_asset_id: cos.id, status: 'active', key: 'character|江澈' });
  fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 1); assert.equal(am.sent[0].session, 's-person');
  assert.match(am.sent[0].text, /江澈·T恤装/); assert.match(am.sent[0].text, /中国人长相/); assert.doesNotMatch(am.sent[0].text, /动漫偏|写实偏动漫/);
  const it = W.loadWork(p.id).items[cos.id];
  am.outbox[it.prefix + '_江澈.png'] = png(path.join(tmp, 'o1.png'));
  await AI.tick(p.id, am);
  const done = await waitFor(() => W.loadWork(p.id).items[cos.id].status === 'passed');
  assert.ok(done);
  const a = core.Assets.get(cos.id);
  assert.notEqual(a.image_path, 'assets/old.png'); assert.ok(a.versions.includes('assets/old.png')); assert.equal(a.source, 'am');
  assert.ok(core.Assets.get(jc.id).image_path, '父角色同图');
  assert.ok(core.Jobs.list(p.id).some((j) => j.type === AI.DISPATCH_JOB)); assert.ok(core.Jobs.list(p.id).some((j) => j.type === AI.REVIEW_JOB && j.status === 'done'));
  AI.setRunning(p.id, false);
});

test('退回：原线程发「【退回 r2」，轮次 +1；r2 过了才写回', async () => {
  const p = setup('aimg-2');
  const prop = core.Assets.create(p.id, { category: 'prop', name: '金砖' });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '道具UI', session: 's-prop', lane: 'prop' }]);
  G.mergeGapList(p.id, { items: [{ kind: 'prop', name: '金砖', requirement: '一公斤' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = prop.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm(); let n = 0;
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; n++; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify(n === 1 ? { verdict: 'return', checks: CHECKS_OK, return_note: '砖面要有编号' } : { verdict: 'pass', checks: CHECKS_OK })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  let it = W.loadWork(p.id).items[prop.id];
  am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'p1.png'));
  await AI.tick(p.id, am);
  await waitFor(() => W.loadWork(p.id).items[prop.id].round === 2);
  assert.match(am.sent[1].text, /【退回 r2·「金砖」】砖面要有编号/); assert.equal(am.sent[1].session, 's-prop');
  it = W.loadWork(p.id).items[prop.id];
  am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'p2.png'));
  await AI.tick(p.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[prop.id].status === 'passed'));
  AI.setRunning(p.id, false);
});

test('_MV 并行（总导 11-26）：A 过 → B/C/D 拆子单同时派给三个场景线程、各自审图 → 齐了拼 2×2 拼板核对 → 写回；线程不够时等空', async () => {
  const p = setup('aimg-3');
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's1', lane: 'scene' }, { name: '场景2', session: 's2', lane: 'scene' }]);
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·工位区·多视角定义图', requirement: '空场' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm(); const reviewed = [];
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; reviewed.push(cp.step); assert.equal(cp.asset_id, mv.id, '审图拿原资产 id'); fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK, checklist: [{ item: '工位', expected: '4×4', seen: '4×4', ok: true }] })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  let it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.step, 'A'); assert.match(am.sent[0].text, /只出 A 格/);
  am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'mv_A.png'), 'red');
  await AI.tick(p.id, am);
  await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'parallel');
  assert.deepEqual(W.loadWork(p.id).items[mv.id].children, [mv.id + '#B', mv.id + '#C', mv.id + '#D']);
  // 两个场景线程：B、C 同时派出，D 等线程空
  await AI.tick(p.id, am);
  let w = W.loadWork(p.id);
  assert.equal(w.items[mv.id + '#B'].status, 'sent'); assert.equal(w.items[mv.id + '#C'].status, 'sent'); assert.equal(w.items[mv.id + '#D'].status, 'next_step');
  assert.notEqual(w.items[mv.id + '#B'].thread, w.items[mv.id + '#C'].thread);
  assert.equal(w.items[mv.id + '#B'].thread, '场景1', '先给母单原来的线程');
  assert.match(am.sent[1].text, /只出 B 格/); assert.match(am.sent[1].text, /A 格/); assert.match(am.sent[2].text, /只出 C 格/);
  const rows = W.rowsWithStatus(p.id);
  assert.ok(rows.some((r) => r.child && r.asset_id === mv.id + '#B' && r.status === 'sent'), '界面列出子单');
  for (const [s, c] of [['B', 'green'], ['C', 'blue']]) am.outbox[w.items[mv.id + '#' + s].prefix + '.png'] = png(path.join(tmp, 'mv_' + s + '.png'), c);
  await AI.tick(p.id, am);
  await waitFor(() => { const x = W.loadWork(p.id).items; return x[mv.id + '#B'].status === 'passed' && x[mv.id + '#C'].status === 'passed'; });
  await AI.tick(p.id, am);
  w = W.loadWork(p.id);
  assert.equal(w.items[mv.id + '#D'].status, 'sent', '线程空了 D 接着派');
  am.outbox[w.items[mv.id + '#D'].prefix + '.png'] = png(path.join(tmp, 'mv_D.png'), 'white');
  await AI.tick(p.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'passed'));
  assert.deepEqual(reviewed.slice(0, 1), ['A']); assert.equal(reviewed[reviewed.length - 1], 'compose');
  assert.deepEqual(reviewed.slice(1, 4).sort(), ['B', 'C', 'D']);
  assert.match(core.Assets.get(mv.id).image_path, /\.png$/);
  assert.equal(Object.values(W.loadWork(p.id).threads).filter((t) => t && t.current).length, 0, '线程都让出来了');
  AI.setRunning(p.id, false);
});

test('_MV 并行：D 能复用同地点已定稿 _MV 的就直接用，不派 am；子单人工审过交母单', async () => {
  const p = setup('aimg-3b');
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's1', lane: 'scene' }, { name: '场景2', session: 's2', lane: 'scene' }]);
  const done = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·走廊·多视角定义图' });
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·走廊·多视角定义图', location_id: 'L01', requirement: 'a' }, { kind: 'scene', name: 'L01_MV·工位区·多视角定义图', location_id: 'L01', requirement: 'b' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = done.id; doc.items[1].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const rel = 'assets/scenes/done.png'; png(path.join(core.projectDir(p.id), rel), 'blue'); core.Assets.update(done.id, { image_path: rel });
  const w0 = W.loadWork(p.id);
  w0.items[mv.id] = { name: 'L01_MV·工位区·多视角定义图', lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 0, step: 'A', round: 1, status: 'needs_human', file: png(path.join(tmp, '3b_a.png'), 'red'), approved: {}, returns: [], history: [], thread: '场景1' };
  w0.allow = [mv.id];
  W.saveWork(p.id, w0);
  const am = fakeAm(); am.runReview = async () => {};
  const r = AI.manualApprove(p.id, mv.id, { reason: 'A 对' }, am);
  assert.equal(r.next, 'parallel');
  let w = W.loadWork(p.id);
  assert.deepEqual(w.items[mv.id].children, [mv.id + '#B', mv.id + '#C'], 'D 复用，不拆子单');
  assert.ok(w.items[mv.id].approved.D); assert.ok(w.items[mv.id].history.some((h) => h.action === 'reuse_d' && h.from === done.id));
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 2); assert.ok(am.sent.every((m) => !/只出 D 格/.test(m.text)));
  w = W.loadWork(p.id);
  w.items[mv.id + '#B'].status = 'needs_human'; w.items[mv.id + '#B'].file = png(path.join(tmp, '3b_b.png'), 'green'); W.saveWork(p.id, w);
  assert.equal(AI.manualApprove(p.id, mv.id + '#B', { reason: 'B 对' }, am).next, 'child_done');
  w = W.loadWork(p.id);
  assert.ok(w.items[mv.id].approved.B); assert.equal(w.items[mv.id].status, 'parallel'); assert.match(w.items[mv.id].note, /还差 C/);
  assert.ok(fs.existsSync(path.join(W.roundsDir(p.id, mv.id), 'review_B_r1_manual.json')), '人工审过记录放原资产目录');
  AI.setRunning(p.id, false);
});

test('卡住：发出 20 分钟没回图标「待对账」，不重派；发送未确认也不重派', async () => {
  const p = setup('aimg-4');
  const prop = core.Assets.create(p.id, { category: 'character', name: '路人' });
  G.mergeGapList(p.id, { items: [{ kind: 'character', name: '路人', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = prop.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  const w = W.loadWork(p.id); w.items[prop.id].sent_at = Date.now() - 21 * 60000; W.saveWork(p.id, w);
  await AI.tick(p.id, am);
  assert.equal(W.loadWork(p.id).items[prop.id].status, 'stale');
  await AI.tick(p.id, am);
  assert.equal(am.sent.length, 1, '不重派');
  AI.setRunning(p.id, false);
});

test('审图结论校验：六项必填；有不过的不能 pass；_MV 非 A 格要对照 A；退回要写意见', () => {
  assert.match(RV.validateReview({ verdict: 'pass', checks: {} }), /same_space/);
  const bad = { ...CHECKS_OK, ethnicity: { ok: false, note: '围观者欧美脸' } };
  assert.match(RV.validateReview({ verdict: 'pass', checks: bad }), /只能是 return/);
  assert.match(RV.validateReview({ verdict: 'return', checks: bad }), /return_note/);
  assert.equal(RV.validateReview({ verdict: 'return', checks: bad, return_note: '换中国人长相' }), '');
  assert.match(RV.validateReview({ verdict: 'pass', checks: { ...CHECKS_OK, same_space: { ok: 'na', note: '-' } }, checklist: [{ item: 'a', expected: 'b', seen: 'b', ok: true }] }, { step: 'B', isMv: true }), /same_space 不能填 na/);
  assert.match(RV.validateReview({ verdict: 'pass', checks: CHECKS_OK }, { step: 'A', isMv: true }), /checklist/);
  assert.match(RV.validateReview({ verdict: 'pass', checks: { ...CHECKS_OK, no_text: { ok: 'na', note: '-' } } }), /不能填 na/);
});

test('派单正文：有底图写图生图；画风不抄项目风格名；排单先 _MV', () => {
  const t = W.buildDispatchText({ name: '中海大厦门口·围观一批', requirement: '约25人' }, { step: 'main', round: 1, style: '写实偏动漫3D', outFile: 'workspace/ic_out/x.png', refRemote: 'workspace/ic_refs/b.png', kind: 'scene' });
  assert.match(t, /图生图/); assert.match(t, /照片级写实/); assert.match(t, /中国人长相/); assert.doesNotMatch(t, /写实偏动漫/);
  assert.ok(W.priorityOf({ name: 'L01_MV·x', kind: 'scene' }) < W.priorityOf({ name: '江澈·T恤', kind: 'costume' }));
  assert.equal(W.laneOf({ name: '系统·光幕A版', kind: 'costume' }), 'prop');
});

test('派单模板（技能参考文件）占位符填好；asset-image 技能能读、不超长', async () => {
  const tpl = fs.readFileSync(path.join(process.cwd(), 'skills', 'asset-image', 'references', '派单模板.md'), 'utf8');
  const t = W.buildDispatchText({ name: '金砖', requirement: '一公斤' }, { step: 'main', round: 2, style: '写实偏动漫3D', template: tpl, outFile: 'workspace/ic_out/a.png', kind: 'prop' });
  assert.match(t, /【IC 单张资产 返修 r2】只做这一张：「金砖」。/); assert.doesNotMatch(t, /\{[^}]+\}/); assert.match(t, /一公斤/);
  const SE = await import('../lib/agent/skill-engine.js');
  const sk = SE.loadSkill('asset-image');
  assert.ok(sk && String(sk.content || sk.body || JSON.stringify(sk)).length < 40000);
});

test('站位踩过的坑：am 改了文件名按资产名兜底收图；发送没确认先查 history，不重发；broadcast 每个线程发一句', async () => {
  const p = setup('aimg-5');
  const a1 = core.Assets.create(p.id, { category: 'character', name: '外卖骑手' });
  G.mergeGapList(p.id, { items: [{ kind: 'character', name: '外卖骑手', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = a1.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm(); let confirmNext = false; const asked = [];
  am.send = async (session, text) => { am.sent.push({ session, text }); return { ok: true, confirmed: confirmNext }; };
  am.historyHas = async (s, marker) => { asked.push(marker); return true; };
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  assert.equal(W.loadWork(p.id).items[a1.id].status, 'unconfirmed');
  await AI.tick(p.id, am);
  assert.equal(W.loadWork(p.id).items[a1.id].status, 'sent', '下一拍对账查到了算发出');
  assert.equal(am.sent.length, 1, '没重发'); assert.match(asked[0], /ic_out/);
  // am 自己起了名字（带行号和 _V2），按资产名兜底收
  am.outbox['27_外卖骑手_V2.png'] = png(path.join(tmp, 'q1.png'));
  am.list = async () => ({ ok: true, files: [{ name: '27_外卖骑手_V2.png', size: 1, modifiedAt: new Date().toISOString() }] });
  await AI.tick(p.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[a1.id].status === 'passed'));
  confirmNext = true;
  const b = await AI.broadcast(p.id, '之前的「国漫」段作废，以本条为准', am);
  assert.equal(b.length, 2); assert.equal(am.sent.slice(-2).every((x) => /作废/.test(x.text)), true);
  AI.setRunning(p.id, false);
});

test('返修 3 轮还不过：标「需人工」停在那一行，不再退回，线程让出来；界面行状态：排队 / 需人工', async () => {
  const p = setup('aimg-6');
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '道具UI', session: 's-prop', lane: 'prop' }]);
  const a1 = core.Assets.create(p.id, { category: 'prop', name: '银行卡' });
  const a2 = core.Assets.create(p.id, { category: 'prop', name: '手机' });
  G.mergeGapList(p.id, { items: [{ kind: 'prop', name: '银行卡', requirement: 'x' }, { kind: 'prop', name: '手机', requirement: 'y' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = a1.id; doc.items[1].asset_id = a2.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'return', checks: { ...CHECKS_OK, no_text: { ok: false, note: '有字' } }, return_note: '去掉卡面字' })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  assert.equal(W.rowsWithStatus(p.id).find((r) => r.asset_id === a2.id).status, 'queued');
  for (let r = 1; r <= 3; r++) {
    const it = W.loadWork(p.id).items[a1.id];
    am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'n' + r + '.png'));
    await AI.tick(p.id, am);
    await waitFor(() => { const x = W.loadWork(p.id).items[a1.id]; return x.round === r + 1 || x.status === 'needs_human'; });
  }
  const it = W.loadWork(p.id).items[a1.id];
  assert.equal(it.status, 'needs_human'); assert.equal(it.round, 3);
  assert.equal(am.sent.filter((x) => /【退回/.test(x.text)).length, 2, '只退回了 r2、r3');
  await AI.tick(p.id, am);
  assert.ok(W.loadWork(p.id).items[a2.id], '线程让出来，派下一张');
  assert.equal(W.rowsWithStatus(p.id).find((r) => r.asset_id === a1.id).status, 'needs_human');
  AI.setRunning(p.id, false);
});

test('阶段变体自动挂本项目 _MV 的 A 格做底图（V3 定稿优先）；拼板按格裁；审图场景行 same_space / base_image 不许 na，取不到交需人工；手工线定稿补登后 view_approved 取得到', async () => {
  const p = setup('aimg-7');
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L05_MV·城市公交车·多视角定义图' });
  const st = core.Assets.create(p.id, { category: 'scene', name: '城市公交车·白天有乘客' });
  G.mergeGapList(p.id, { items: [
    { kind: 'scene', name: 'L05_MV·城市公交车·多视角定义图', location_id: 'L05', requirement: '空场' },
    { kind: 'scene', name: '城市公交车·白天有乘客', location_id: 'L05', requirement: '约12人', base_ref: { project_id: 'v2', asset_id: 'v2asset', name: 'S367' } },
  ] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; doc.items[1].asset_id = st.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  assert.equal(W.applyStageBaseRefs(p.id), 0, '_MV 还没有图：保留原来的 V2 底图');
  const rel = 'assets/scenes/mv.png'; png(path.join(core.projectDir(p.id), rel), 'red'); core.Assets.update(mv.id, { image_path: rel, source: 'uploaded' });
  assert.equal(W.applyStageBaseRefs(p.id), 1);
  const row = G.getGapList(p.id).items.find((x) => x.asset_id === st.id);
  assert.equal(row.base_ref.asset_id, mv.id); assert.equal(row.base_ref.cell, 'A');
  const a = W.baseRefAbs(p.id, row.base_ref); assert.match(a.replace(/\\/g, '/'), /cells\/A_/); assert.ok(fs.existsSync(a));
  // 审图规则
  const naSpace = { ...CHECKS_OK, same_space: { ok: 'na', note: '-' } };
  assert.match(RV.validateReview({ verdict: 'pass', checks: naSpace }, { isScene: true, hasBase: true }), /same_space 不能填 na/);
  assert.match(RV.validateReview({ verdict: 'pass', checks: { ...CHECKS_OK, base_image: { ok: 'na', note: '-' } } }, { hasBase: true }), /base_image 不能填 na/);
  assert.equal(RV.validateReview({ verdict: 'needs_human', checks: {}, return_note: '取不到底图' }), '');
  assert.match(RV.validateReview({ verdict: 'needs_human', checks: {} }), /写清/);
  // 手工线补登
  fs.mkdirSync(W.roundsDir(p.id, mv.id), { recursive: true });
  fs.writeFileSync(path.join(W.roundsDir(p.id, mv.id), 'imported_approved.json'), JSON.stringify({ source: W.IMPORTED_SOURCE, image_path: rel }));
  assert.equal(W.importedApprovedOf(p.id, mv.id).source, '手工线·站位审');
});

test('只有 pass 才写回：needs_human 不写资产；撤图恢复上一版（没有就清空）并标需人工', async () => {
  const p = setup('aimg-8');
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's-scene', lane: 'scene' }]);
  const a = core.Assets.create(p.id, { category: 'scene', name: '公交·白天有乘客' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: '公交·白天有乘客', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = a.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'needs_human', checks: {}, return_note: '取不到底图' })); };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  const it = W.loadWork(p.id).items[a.id];
  am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'nh.png'));
  await AI.tick(p.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[a.id].status === 'needs_human'));
  assert.equal(core.Assets.get(a.id).image_path || '', '', 'needs_human 不写回');
  // 撤图：先模拟一次误写回
  const src = png(path.join(tmp, 'bad.png'));
  W.writeAssetImage(p.id, a.id, src);
  const r = AI.revokeImage(p.id, a.id, '误写回');
  assert.equal(r.restored, ''); assert.equal(core.Assets.get(a.id).image_path, '');
  assert.equal(W.loadWork(p.id).items[a.id].status, 'needs_human');
  AI.setRunning(p.id, false);
});

test('同地点第二张 _MV：派 D 时附已定稿 _MV 的 D 格、只加机位标注；人工指定 D 后 A/B/C 已审就拼板写回', async () => {
  const p = setup('aimg-9');
  const mv1 = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  const mv2 = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·走廊·多视角定义图' });
  G.mergeGapList(p.id, { items: [
    { kind: 'scene', name: 'L01_MV·工位区·多视角定义图', location_id: 'L01', requirement: 'a' },
    { kind: 'scene', name: 'L01_MV·走廊·多视角定义图', location_id: 'L01', requirement: 'b' },
  ] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv1.id; doc.items[1].asset_id = mv2.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const rel = 'assets/scenes/mv1.png'; png(path.join(core.projectDir(p.id), rel), 'blue'); core.Assets.update(mv1.id, { image_path: rel });
  const row2 = G.getGapList(p.id).items.find((x) => x.asset_id === mv2.id);
  const d = W.locationDOf(p.id, row2);
  assert.equal(d.asset_id, mv1.id); assert.ok(fs.existsSync(d.abs));
  const t = W.buildDispatchText(row2, { step: 'D', round: 1, outFile: 'o.png', reuseD: 'workspace/ic_refs/x_locD.png（L01 工位区 的 D 格）', kind: 'scene' });
  assert.match(t, /不重画/); assert.match(t, /只在上面加本张 A\/B\/C/);
  // 人工指定 D：A/B/C 已审 → 拼板写回
  const w = W.loadWork(p.id);
  w.items[mv2.id] = { name: row2.name, lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 3, round: 3, status: 'needs_human', approved: { A: png(path.join(tmp, 'a.png'), 'red'), B: png(path.join(tmp, 'b.png'), 'green'), C: png(path.join(tmp, 'c.png'), 'white') }, returns: [], history: [], thread: '场景1' };
  W.saveWork(p.id, w);
  const am = fakeAm(); let seen = null;
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; seen = cp.step; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK, checklist: [{ item: '门', expected: '南', seen: '南', ok: true }, { item: '饮水机', expected: '东', seen: '东', ok: true }, { item: '机位标注', expected: '本张', seen: '本张', ok: true }] })); };
  const r = AI.setManualD(p.id, mv2.id, mv1.id, am);
  assert.equal(r.composed, true);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv2.id].status === 'passed'), '拼板核对过了才写回');
  assert.equal(seen, 'compose');
  assert.ok(core.Assets.get(mv2.id).image_path);
});

test('人工退回：指定格、原线程出 rN+1；拼板核对没过判需人工不写回', async () => {
  const p = setup('aimg-10');
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L02_MV·金店·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L02_MV·金店·多视角定义图', location_id: 'L02', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  const r = await AI.manualReturn(p.id, mv.id, { note: '柜台方向反了', step: 'B' }, am);
  assert.equal(r.step, 'B'); assert.equal(r.thread, '场景1');
  assert.match(am.sent[0].text, /【退回 r2·「L02_MV·金店·多视角定义图」B 格】【人工退回】柜台方向反了/);
  await assert.rejects(AI.manualReturn(p.id, mv.id, { note: '' }, am), /退回意见/);
  // 拼板核对没过
  const w = W.loadWork(p.id); const it = w.items[mv.id];
  it.approved = { A: png(path.join(tmp, 'ra.png'), 'red'), B: png(path.join(tmp, 'rb.png'), 'green'), C: png(path.join(tmp, 'rc.png'), 'blue'), D: png(path.join(tmp, 'rd.png'), 'white') }; it.stepIdx = 3; it.step = 'D'; W.saveWork(p.id, w);
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'needs_human', checks: {}, return_note: 'D 的饮水机在西、A 里在东' })); };
  const other = core.Assets.create(p.id, { category: 'scene', name: 'L02_MV·金店门外·多视角定义图' });
  const d2 = G.getGapList(p.id); d2.items.push({ kind: 'scene', name: 'L02_MV·金店门外·多视角定义图', location_id: 'L02', asset_id: other.id, status: 'active', key: 'scene|x' }); fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(d2));
  const rel = 'assets/scenes/o.png'; png(path.join(core.projectDir(p.id), rel), 'gray'); core.Assets.update(other.id, { image_path: rel });
  AI.setManualD(p.id, mv.id, other.id, am);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'needs_human'));
  assert.equal(core.Assets.get(mv.id).image_path || '', '', '核对没过不写回');
  assert.match(W.loadWork(p.id).items[mv.id].note, /拼板核对没过/);
});

test('人工审过：停在需人工的那一格判过（记人工审核记录），接着排下一格；D 可取本张旧版本', async () => {
  const p = setup('aimg-11');
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L05_MV·公交·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L05_MV·公交·多视角定义图', location_id: 'L05', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const w = W.loadWork(p.id);
  const cFile = png(path.join(tmp, 'l05c.png'), 'green');
  w.items[mv.id] = { name: 'L05_MV·公交·多视角定义图', lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 2, step: 'C', round: 3, status: 'needs_human', file: cFile, approved: { A: png(path.join(tmp, 'l05a.png'), 'red'), B: png(path.join(tmp, 'l05b.png'), 'blue') }, returns: [], history: [], thread: '场景1' };
  W.saveWork(p.id, w);
  assert.throws(() => AI.manualApprove(p.id, mv.id, { reason: '' }), /理由/);
  const r = AI.manualApprove(p.id, mv.id, { reason: '审图误判，C 和 A 是同一车厢' }, fakeAm());
  assert.equal(r.next, 'next_step');
  const it = W.loadWork(p.id).items[mv.id];
  assert.equal(it.approved.C, cFile); assert.equal(it.step, 'C'); assert.equal(it.stepIdx, 3); assert.equal(it.status, 'next_step');
  assert.ok(fs.existsSync(path.join(W.roundsDir(p.id, mv.id), 'review_C_r3_manual.json')), '人工审核记录');
  // D 取本张旧版本
  const rel = 'assets/scenes/l05old.png'; png(path.join(core.projectDir(p.id), rel), 'white'); core.Assets.update(mv.id, { image_path: rel });
  const am = fakeAm(); am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK, checklist: [{ item: 'a', expected: 'b', seen: 'b', ok: true }, { item: 'c', expected: 'd', seen: 'd', ok: true }, { item: 'e', expected: 'f', seen: 'f', ok: true }] })); };
  const w2 = W.loadWork(p.id); w2.items[mv.id].approved.C = cFile; W.saveWork(p.id, w2);
  const d = AI.setManualD(p.id, mv.id, '', am, { fromVersion: rel });
  assert.equal(d.composed, true);
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mv.id].status === 'passed'));
  assert.throws(() => AI.setManualD(p.id, mv.id, '', am, { fromVersion: 'assets/x.png' }), /不是这张资产的版本/);
});
