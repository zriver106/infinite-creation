// 本格可见清单（总导 11-26 第 1–3 类）：派单写清这一格应数出几排每排几张、人坐哪侧面朝哪、屏幕 / 椅子看哪面；审图照它数、拿兄弟格比结构；
// 借来的 D（自动复用 / 人工取别的 _MV）拼板核对不核机位标注，取本张旧版的照旧核。假 LLM、假 am。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cs-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let W; let AI; let RV; let G; let CS; let SN;
before(async () => {
  core = await import('../lib/core/index.js');
  W = await import('../lib/core/asset-image-work.js');
  AI = await import('../lib/agent/asset-image.js');
  RV = await import('../lib/agent/asset-image-review-mcp.js');
  G = await import('../lib/core/asset-gaps.js');
  CS = await import('../lib/agent/asset-cell-spec.js');
  SN = await import('../lib/core/scene-notes.js');
});
const png = (f, color = 'gray', size = '64x36') => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=' + size, '-frames:v', '1', f]); return f; };
const SPEC = { camera: '南墙玻璃大门内主过道，朝北', rows: [{ order: '从近到远第1排', layout_row: '布局表第4排', left: 2, right: 2, total: 4, cut: '下沿裁掉半排' }, { order: '第2排', layout_row: '第3排', left: 2, right: 2, total: 4 }, { order: '第3排', layout_row: '第2排', left: 2, right: 2, total: 4 }, { order: '第4排', layout_row: '第1排', left: 2, right: 2, total: 4 }], total_visible: 16, seating: '人坐桌子南侧、面朝北窗', screens: '背面', chairs: '椅背', left_side: '西墙', right_side: '东墙、东南角主管办公室', far_end: '北墙落地窗' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(name) {
  const p = core.Projects.create({ name, auto_script: false });
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's1', lane: 'scene' }, { name: '场景2', session: 's2', lane: 'scene' }]);
  const mv = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·工位区·多视角定义图' });
  SN.saveSceneNote(p.id, 'L01', '# L01\n开放工位 4 排 × 每排 4 张，中间小过道。人坐南侧面朝北。D 格机位：A 在南侧主过道朝北。');
  G.mergeGapList(p.id, { items: [{ kind: 'scene', name: 'L01_MV·工位区·多视角定义图', location_id: 'L01', note_key: 'L01', requirement: '4 排 × 4' }] });
  const doc = G.getGapList(p.id); doc.items[0].asset_id = mv.id; fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  return { p, mv, row: G.getGapList(p.id).items[0] };
}

test('推算本格可见清单：读戏份说明 → 结构化 → 派单文字；说明没改就走缓存不重算；推不出来不挡', async () => {
  const { p, row } = setup('cs-1');
  let calls = 0; let prompt = '';
  const chat = async (msgs) => { calls++; prompt = msgs[0].content; return { content: JSON.stringify(SPEC) }; };
  const r = await CS.cellSpec(p.id, row, 'A', { chat });
  assert.equal(calls, 1); assert.match(prompt, /4 排 × 每排 4 张/); assert.match(prompt, /A 格（主视角）/);
  assert.match(r.text, /从近到远第1排（布局表第4排）：左 2、右 2，共 4 张；下沿裁掉半排/);
  assert.match(r.text, /可见总数：16 张/); assert.match(r.text, /屏幕：看到背面/); assert.match(r.text, /椅子：看到椅背/); assert.match(r.text, /人坐桌子南侧、面朝北窗/);
  const r2 = await CS.cellSpec(p.id, row, 'A', { chat });
  assert.equal(calls, 1); assert.equal(r2.cached, true);
  SN.saveSceneNote(p.id, 'L01', '# L01\n改成 3 排 × 4');
  await CS.cellSpec(p.id, row, 'A', { chat }); assert.equal(calls, 2, '说明改了重算');
  const bad = await CS.cellSpec(p.id, row, 'B', { chat: async () => ({ content: '不是 json' }) });
  assert.equal(bad.text, ''); assert.match(bad.error, /JSON/);
  assert.equal((await CS.cellSpec(p.id, { ...row, name: '金砖' }, 'main', { chat })).text, '', '非 _MV 不算');
});

test('派单带清单、审图拿清单和兄弟格；B/C/D 单格判过要逐件对照表；退回意见也带清单', async () => {
  const { p, mv } = setup('cs-2');
  const sent = []; const outbox = {}; const cps = [];
  const checks = () => Object.fromEntries(Object.keys(RV.REVIEW_CHECKS).map((k) => [k, { ok: true, note: '看过' }]));
  const am = {
    send: async (s, t) => { sent.push(t); return { ok: true, confirmed: true }; }, put: async () => ({ ok: true }),
    list: async () => ({ ok: true, files: Object.keys(outbox).map((name) => ({ name, size: 1 })) }),
    get: async (remote, local) => { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.copyFileSync(outbox[path.basename(remote)], local); return { ok: true }; },
    cellSpec: async (pid, row, step) => ({ text: CS.renderCellSpec(step, SPEC) }),
    runReview: async ({ jobId }) => {
      const cp = core.Jobs.get(jobId).checkpoint; cps.push(cp);
      const isB = cp.step === 'B';
      fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify({ verdict: isB ? 'return' : 'pass', checks: isB ? { ...checks(), count_orientation: { ok: false, note: '多一排' } } : checks(), return_note: '多一排', checklist: [] }));
    },
    agentId: 'claude',
  };
  AI.setRunning(p.id, true);
  await AI.tick(p.id, am);
  assert.match(sent[0], /本格可见清单（A 格/); assert.match(sent[0], /可见总数：16 张/);
  const it = W.loadWork(p.id).items[mv.id];
  outbox[it.prefix + '.png'] = png(path.join(tmp, 'a.png'), 'red');
  await AI.tick(p.id, am);
  await sleep(300);
  assert.equal(cps[0].step, 'A'); assert.match(cps[0].cell_spec, /可见总数/);
  await AI.tick(p.id, am);
  const b = W.loadWork(p.id).items[mv.id + '#B'];
  outbox[b.prefix + '.png'] = png(path.join(tmp, 'b.png'), 'green');
  await AI.tick(p.id, am);
  await sleep(300);
  const cpB = cps.find((c) => c.step === 'B');
  assert.deepEqual(Object.keys(cpB.approved), ['A'], 'B 格审图拿已审过的 A 比结构');
  assert.match(cpB.cell_spec, /本格可见清单（B 格/);
  assert.ok(sent.some((t) => /【退回 r2/.test(t) && /本格可见清单（B 格/.test(t)), '退回意见带清单');
  assert.match(RV.validateReview({ verdict: 'pass', checks: checks() }, { step: 'B', isMv: true, isScene: true }), /逐件比结构/);
  const list3 = [{ item: '东墙', expected: '幕墙', seen: '幕墙', ok: true }, { item: '窗', expected: '北', seen: '北', ok: true }, { item: '工位', expected: '4 排', seen: '4 排', ok: true }];
  assert.equal(RV.validateReview({ verdict: 'pass', checks: checks(), checklist: list3 }, { step: 'B', isMv: true, isScene: true }), '');
  const pr = RV.buildReviewAgentPrompt({ project: { name: 'x' }, cp: { name: 'L01_MV', step: 'B', round: 1, cell_spec: 'x' } });
  assert.match(pr, /逐排数/); assert.match(pr, /兄弟格/);
  AI.setRunning(p.id, false);
});

test('人工指定 D：取别的 _MV 的 D → 拼板核对不核机位标注；取本张旧版本的 D → 照旧核', async () => {
  const { p, mv } = setup('cs-3');
  const other = core.Assets.create(p.id, { category: 'scene', name: 'L01_MV·走廊·多视角定义图' });
  const doc = G.getGapList(p.id); doc.items.push({ kind: 'scene', name: 'L01_MV·走廊·多视角定义图', location_id: 'L01', asset_id: other.id, status: 'active', key: 'scene|走廊' });
  fs.writeFileSync(path.join(core.projectDir(p.id), 'asset_gaps', 'gaps.json'), JSON.stringify(doc));
  const orel = 'assets/scenes/other.png'; png(path.join(core.projectDir(p.id), orel), 'blue', '128x72'); core.Assets.update(other.id, { image_path: orel });
  const mrel = 'assets/scenes/mine.png'; png(path.join(core.projectDir(p.id), mrel), 'white', '128x72'); core.Assets.update(mv.id, { image_path: mrel });
  const cps = [];
  const am = { runReview: async ({ jobId }) => { cps.push(core.Jobs.get(jobId).checkpoint); }, send: async () => ({ confirmed: true }), agentId: 'claude' };
  const mk = () => { const w = W.loadWork(p.id); w.items[mv.id] = { name: 'L01_MV·工位区·多视角定义图', lane: 'scene', steps: ['A', 'B', 'C', 'D'], stepIdx: 3, step: 'D', round: 1, status: 'needs_human', approved: { A: png(path.join(tmp, '3a.png'), 'red'), B: png(path.join(tmp, '3b.png'), 'green'), C: png(path.join(tmp, '3c.png'), 'gray') }, returns: [], history: (w.items[mv.id] || {}).history || [], thread: '场景1' }; W.saveWork(p.id, w); };
  mk(); AI.setManualD(p.id, mv.id, other.id, am);
  await sleep(200);
  assert.equal(cps[0].step, 'compose'); assert.equal(cps[0].reused_d, true, '取别的 _MV 的 D');
  mk(); AI.setManualD(p.id, mv.id, '', am, { fromVersion: mrel });
  await sleep(200);
  assert.equal(cps[1].reused_d, undefined, '取本张旧版本的 D 照旧核机位标注');
});
