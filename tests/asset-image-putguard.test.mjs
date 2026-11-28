// 参考图传不上去整单不派（总导 11-27：am 网关改接口后 put 回 422，派单悄悄不带附图）；审图 checklist 放进 checks 里也认（站位 11-28）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pg-'));
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

test('参考图传不上去：整单不派、不发 am，标「参考图没传上」、线程让出来；10 分钟后重试，传上了才派', async () => {
  const p = core.Projects.create({ name: 'pg-1', auto_script: false });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's1', lane: 'scene' }]);
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·某地·多视角定义图' });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·某地·多视角定义图', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const w = W.loadWork(p.id);
  w.items[mv.id] = { name: 'L01_MV·某地·多视角定义图', lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 1, step: 'B', round: 1, status: 'next_step', approved: { A: png(path.join(tmp, 'a.png'), 'red') }, returns: [], history: [], thread: '场景1' };
  W.saveWork(p.id, w);
  let putOk = false; const sent = [];
  const am = { send: async (s, t) => { sent.push(t); return { ok: true, confirmed: true }; }, put: async () => (putOk ? { ok: true } : { ok: false, error: "gateway status=422 missing field `append`" }), list: async () => ({ ok: true, files: [] }), get: async () => ({ ok: false }), runReview: async () => {}, agentId: 'claude' };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  let it = W.loadWork(p.id).items[mv.id];
  assert.equal(sent.length, 0, '传不上不派');
  assert.equal(it.status, 'put_failed'); assert.match(it.note, /参考图传不上去（已审过的 A 格）.*422/);
  assert.ok(!(W.loadWork(p.id).threads['场景1'] || {}).current, '线程没被占');
  assert.ok(core.Jobs.list(p.id).some((j) => j.status === 'failed' && /没派/.test(j.detail || '')));
  putOk = true;
  await AI.tick(p.id, am);
  assert.equal(sent.length, 0, '没到 10 分钟不重试');
  const w2 = W.loadWork(p.id); w2.items[mv.id].failed_at = Date.now() - 11 * 60000; W.saveWork(p.id, w2);
  await AI.tick(p.id, am);
  it = W.loadWork(p.id).items[mv.id];
  assert.equal(sent.length, 1); assert.equal(it.status, 'sent'); assert.match(sent[0], /A 格/);
  AI.setRunning(p.id, false);
});

test('审图 checklist 放进 checks 里 / 传成字符串：挪回顶层再校验；缺了时报错写清楚放哪、收到几件', () => {
  const checks = Object.fromEntries(Object.keys(RV.REVIEW_CHECKS).map((k) => [k, { ok: true, note: '看过' }]));
  const list = [{ item: '饮水机', expected: '北', seen: '北', ok: true }, { item: '老板椅', expected: '南', seen: '南', ok: true }, { item: '门', expected: '西', seen: '西', ok: true }];
  const nested = RV.normalizeReviewArgs({ verdict: 'pass', checks: { ...checks, checklist: list } });
  assert.equal(nested.checklist.length, 3); assert.equal(nested.checks.checklist, undefined);
  assert.equal(RV.validateReview(nested, { step: 'compose', isMv: true, isScene: true }), '');
  const str = RV.normalizeReviewArgs({ verdict: 'pass', checks: JSON.stringify(checks), checklist: JSON.stringify(list) });
  assert.equal(RV.validateReview(str, { step: 'compose', isMv: true, isScene: true }), '');
  assert.match(RV.validateReview({ verdict: 'pass', checks }, { step: 'compose', isMv: true, isScene: true }), /顶层字段，和 checks 并列.*现在收到 没有/);
});

test('底图优先级 V3 已审定稿 > V2 > 无：V2 查不到、本资产有 V3 已审定稿就拿它当底图，不交需人工；提示词写明', async () => {
  const p = core.Projects.create({ name: 'pg-3', auto_script: false });
  const a = core.Assets.create(p.id, { category: 'scene', name: '某地·阶段变体' });
  const rel = 'assets/scenes/v3.png'; png(path.join(core.projectDir(p.id), rel), 'blue'); core.Assets.update(a.id, { image_path: rel });
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: '某地·阶段变体', requirement: 'x' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = a.id; doc.items[0].base_ref = { project_id: 'v2-project-gone', asset_id: 'nope', name: 'S999' };
  fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  fs.mkdirSync(W.roundsDir(p.id, a.id), { recursive: true });
  fs.writeFileSync(path.join(W.roundsDir(p.id, a.id), 'imported_approved.json'), JSON.stringify({ image_path: rel }));
  const j = core.Jobs.create({ projectId: p.id, type: AI.REVIEW_JOB, checkpoint: { asset_id: a.id, name: '某地·阶段变体', step: 'main', round: 1, file: path.join(core.projectDir(p.id), rel) } });
  const r = await RV.runReviewExtraTool({ projectId: p.id, jobId: j.id }, 'view_reference_asset', {});
  const meta = JSON.parse(r.text || r);
  assert.match(meta.base, /V3 已审定稿/); assert.equal(meta.own, true);
  assert.match(RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'a', step: 'main', round: 1 } }), /V3 已审定稿 > V2 底图 > 没有底图/);
});
