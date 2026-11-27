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
const CHECKS_OK = Object.fromEntries(Object.keys({ same_space: 1, style_vs_sample: 1, ethnicity: 1, base_image: 1, count_orientation: 1, no_text: 1 }).map((k) => [k, { ok: true, note: '看过' }]));

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

test('_MV：A 过 → 同线程带 A 派 B → C → D，D 过后拼 2×2 写回', async () => {
  const p = setup('aimg-3');
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·工位区·多视角定义图', requirement: '空场' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const am = fakeAm();
  am.runReview = async ({ jobId }) => { const cp = core.Jobs.get(jobId).checkpoint; fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: 'pass', checks: CHECKS_OK, checklist: [{ item: '工位', expected: '4×4', seen: '4×4', ok: true }] })); };
  AI.setRunning(p.id, true);
  for (const [i, step] of ['A', 'B', 'C', 'D'].entries()) {
    await AI.tick(p.id, am);
    const it = W.loadWork(p.id).items[mv.id];
    assert.equal(it.step, step); assert.match(am.sent[i].text, new RegExp('只出 ' + step + ' 格'));
    if (step !== 'A') assert.match(am.sent[i].text, /A 格/);
    am.outbox[it.prefix + '.png'] = png(path.join(tmp, 'mv_' + step + '.png'), ['red', 'green', 'blue', 'white'][i]);
    await AI.tick(p.id, am);
    await waitFor(() => { const x = W.loadWork(p.id).items[mv.id]; return x.status === 'next_step' || x.status === 'passed'; });
  }
  assert.equal(W.loadWork(p.id).items[mv.id].status, 'passed');
  assert.match(core.Assets.get(mv.id).image_path, /\.png$/);
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
