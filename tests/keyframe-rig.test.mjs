// 首尾帧控制（总导 11-28 批，第一批）：机位校验、S6 承接规则、关键帧工作流结构、审图结论规整、灰模渲染、整条编排（GPU / LLM 用替身）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-kfrig-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let CR; let KG; let KR; let RIG; let SR; let SM;
before(async () => {
  core = await import('../lib/core/index.js');
  CR = await import('../lib/core/camera-rig.js');
  KG = await import('../lib/core/keyframe-gen.js');
  SR = await import('../lib/core/scene-render.js');
  SM = await import('../lib/core/scene-master.js');
  KR = await import('../lib/agent/keyframe-review.js');
  RIG = await import('../lib/agent/keyframe-rig.js');
});

// 小号开放办公区：1 排 2 张工位（人朝北），东南角经理室
const MASTER = {
  scene_id: 'T-办公区', name: '测试办公区', room: { x0: 0, y0: 0, x1: 8, y1: 6, h: 2.8 },
  openings: [{ id: 'W1', name: '北窗', side: 'north', kind: 'window', from: 0.5, to: 7.5 }],
  workstations: { desk: { w: 1.4, d: 0.7, h: 0.75, partition_h: 1.15 }, yaw: 0, rows: [{ id: 'R1', y: 3.0, chair_y: 2.2 }], cols: [{ id: 'A', x: 2.5 }, { id: 'B', x: 4.0 }] },
  office: { id: 'F-OFF', name: '经理室', x0: 6, y0: 0, x1: 8, y1: 2, h: 2.6, door: { id: 'D4', x0: 6, x1: 6.8, side: 'north' }, furniture: [{ id: 'OFF-DESK', x: 7.2, y: 1, w: 1.2, d: 0.6, h: 0.76, yaw: 270 }, { id: 'OFF-CHAIR', x: 7.7, y: 1, yaw: 270 }] },
  asset_ids: [],
};
// 从北边看向主角（脸朝北，相机朝南偏东），首尾沿过道后退约 1.2 米
const RIG_OK = {
  scene_id: 'T-办公区',
  first: { pos: [3.3, 4.0], eye: 1.4, yaw: 195, pitch: -5, lens_mm: 28, desc: '主角坐在工位前' },
  last: { pos: [3.2, 5.2], eye: 1.5, yaw: 190, pitch: -3, lens_mm: 26, desc: '主管站在过道' },
  people: [{ x: 2.5, y: 2.2, yaw: 0, pose: 'sit', role: '主角' }, { x: 3.3, y: 2.4, yaw: 330, pose: 'stand', role: '主管', only: 'last' }],
  expect: [{ at: [7, 1], side: 'left', in: 'both', note: '经理室' }, { at: [4, 6], side: 'behind', in: 'both', note: '北窗' }],
};

test('机位校验：合格机位过；卡在桌子里、首尾差太远、画左画右反了都拦', () => {
  const v = CR.validateRig(MASTER, RIG_OK);
  assert.equal(v.ok, true, v.errors.join('；'));
  assert.equal(v.frame.first.find((f) => f.role === '主角').inFrame, true);
  const inDesk = { ...RIG_OK, first: { ...RIG_OK.first, pos: [2.5, 3.0] } };
  assert.match(CR.validateRig(MASTER, inDesk).errors.join(''), /卡在 WS-R1-A/);
  const tooFar = { ...RIG_OK, first: { ...RIG_OK.first, pos: [1.0, 3.9] }, last: { ...RIG_OK.last, pos: [3.3, 5.6] } };
  assert.match(CR.validateRig(MASTER, tooFar).errors.join(''), /相距 [0-9.]+ 米，超过 1.6 米/);
  const flipped = { ...RIG_OK, expect: [{ at: [7, 1], side: 'right', in: 'first', note: '经理室' }] };
  assert.match(CR.validateRig(MASTER, flipped).errors.join(''), /经理室 应在画右，实际在画左/);
  const outside = { ...RIG_OK, first: { ...RIG_OK.first, pos: [8.1, 3] } };
  assert.match(CR.validateRig(MASTER, outside).errors.join(''), /不在房间里/);
});

test('承接上一镜 22 帧：首机位要接上上一镜尾机位；承接时只锚尾帧（S6）', () => {
  const prev = { last: { pos: [3.3, 4.0], yaw: 195 } };
  assert.equal(CR.validateRig(MASTER, RIG_OK, { prevRig: prev }).ok, true);
  const prevFar = { last: { pos: [1.0, 4.5], yaw: 90 } };
  assert.match(CR.validateRig(MASTER, RIG_OK, { prevRig: prevFar }).errors.join(''), /首机位要接上上一镜的尾机位/);
  assert.deepEqual(CR.anchorsFor(RIG_OK, true), { first: false, last: true });
  assert.deepEqual(CR.anchorsFor(RIG_OK, false), { first: true, last: true });
  assert.deepEqual(CR.anchorsFor({ ...RIG_OK, last: null }, false), { first: true, last: false });
});

test('关键帧工作流：线稿 → 深度叠加 → 灰模底图重绘 0.9，人物参考接编辑编码器 image1/image2', () => {
  const wf = KG.buildKeyframeWorkflow({ edge: 'e.png', depth: 'd.png', gray: 'g.png', refs: ['a.png', 'b.png'], prompt: 'p', seed: 7, W: 1360, H: 768 });
  assert.equal(wf['8'].class_type, 'QwenImageDiffsynthControlnet'); assert.equal(wf['8'].inputs.strength, 1.0);
  assert.deepEqual(wf['23'].inputs.model, ['8', 0]); assert.equal(wf['23'].inputs.strength, 0.6);
  assert.deepEqual(wf['12'].inputs.model, ['23', 0]);
  assert.deepEqual(wf['12'].inputs.latent_image, ['16', 0]); assert.equal(wf['12'].inputs.denoise, 0.9);
  assert.deepEqual(wf['9'].inputs.image1, ['30', 0]); assert.deepEqual(wf['9'].inputs.image2, ['31', 0]); assert.deepEqual(wf['9'].inputs.vae, ['5', 0]);
  assert.equal(wf['61'].inputs.width, 1360);
  const bare = KG.buildKeyframeWorkflow({ edge: 'e.png', prompt: 'p', seed: 1, W: 1024, H: 576 });
  assert.equal(bare['12'].inputs.denoise, 1.0); assert.deepEqual(bare['12'].inputs.latent_image, ['11', 0]); assert.equal(bare['9'].inputs.image1, undefined);
  assert.deepEqual(KG.targetSize(1280, 720), { W: 1360, H: 768 });
});

test('审图结论：五项缺一算不过；模型写 pass 但有一项不过按不过', () => {
  const all = KR.REVIEW_KEYS.map((k) => ({ key: k, ok: true }));
  assert.equal(KR.normalizeReview({ verdict: 'pass', items: all }).verdict, 'pass');
  const r = KR.normalizeReview({ verdict: 'pass', items: all.slice(0, 4) });
  assert.equal(r.verdict, 'fail'); assert.match(r.failed.join(''), /人物位置/);
  const w = KR.normalizeReview({ items: all.map((x) => (x.key === 'openings' ? { ...x, ok: false, note: '画右多一扇窗' } : x)) });
  assert.equal(w.verdict, 'fail'); assert.match(w.failed[0], /门窗开口：画右多一扇窗/);
  assert.match(KR.reviewPrompt({ which: 'last', openings: ['北窗（north，window）'] }), /尾帧[\s\S]*北窗/);
});

const hasPython = (() => { try { execFileSync(process.env.IC_RIG_PYTHON || 'python', ['-c', 'import numpy, PIL'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('渲首尾灰模：出灰模 / 深度 / 线稿各一张，meta 里主角在首帧画里、主管只在尾帧', { skip: !hasPython && '没有带 numpy/Pillow 的 python' }, async () => {
  const p = core.Projects.create({ name: 'kf-render', auto_script: false });
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'T-办公区.json'), JSON.stringify(MASTER));
  const r = await SR.renderRig(p.id, 'shotX', RIG_OK, {});
  for (const k of ['first', 'last']) for (const f of Object.values(r[k])) assert.ok(fs.existsSync(core.resolveProjectPath(p.id, f)), f);
  const roles = (k) => r.meta[k].people_in_frame.map((x) => x.role);
  assert.ok(roles('first').includes('主角'));
  assert.ok(!roles('first').includes('主管') && roles('last').includes('主管'));
});

test('整条编排（GPU / LLM 替身）：审过挂首尾帧槽位；承接 22 帧的镜只出、只挂尾帧', async () => {
  const p = core.Projects.create({ name: 'kf-run', auto_script: false });
  const scene = core.Assets.create(p.id, { category: 'scene', name: '测试办公区' });
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'T-办公区.json'), JSON.stringify({ ...MASTER, asset_ids: [scene.id] }));
  const s1 = core.Shots.create(p.id, { chapter: '第1章', idx: 1, scene_ids: [scene.id], visual: '主角坐在工位前' });
  const s2 = core.Shots.create(p.id, { chapter: '第1章', idx: 2, scene_ids: [scene.id], visual: '主管走过来' });
  core.Shots.setRigFields(s1.id, { camera_rig: RIG_OK });
  core.Shots.setRigFields(s2.id, { camera_rig: RIG_OK });
  core.Shots.setRigFields(s1.id, { camera_rig: { ...RIG_OK, last: { ...RIG_OK.first } } });   // s1 不动的镜：尾机位 = 首机位，s2 承接后首机位接得上
  const made = [];
  const deps = {
    renderRig: async (pid, sid, rig) => {
      const out = { dir: 'frames/rig/' + sid, meta: { first: { size: [1280, 720], people_in_frame: [] }, last: { size: [1280, 720], people_in_frame: [] } } };
      for (const k of ['first', 'last']) {
        if (!rig[k]) continue;
        const rel = 'frames/rig/' + sid + '/' + k + '/灰模.png'; const abs = core.resolveProjectPath(pid, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x');
        out[k] = { gray: rel, depth: rel, edge: rel };
      }
      return out;
    },
    generateKeyframe: async (cfg, pid, sid, which, views, o) => {
      const rel = 'frames/rig/' + sid + '/cand/' + which + '_s' + o.seed + '.png'; const abs = core.resolveProjectPath(pid, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'png'); made.push(sid + ':' + which + ':' + o.seed); return { rel, seed: o.seed };
    },
    reviewKeyframe: async (ctx, inp) => (inp.imageAbs.endsWith('_s7.png') ? KR.normalizeReview({ items: KR.REVIEW_KEYS.map((k) => ({ key: k, ok: k !== 'openings', note: k === 'openings' ? '多一扇窗' : '' })) }) : KR.normalizeReview({ items: KR.REVIEW_KEYS.map((k) => ({ key: k, ok: true })) })),
  };
  const cfg = { generation: {} };
  const r1 = await RIG.runKeyframeRig({ projectId: p.id, cfg }, s1.id, { deps });
  assert.equal(r1.review.lead_in, false); assert.equal(r1.applied, true);
  assert.deepEqual(made.filter((x) => x.startsWith(s1.id)), [s1.id + ':first:7', s1.id + ':first:11', s1.id + ':last:7', s1.id + ':last:11'], 's7 审不过换 s11');
  const g1 = core.Shots.get(s1.id);
  assert.equal(g1.first_frame_source, 'upload'); assert.match(g1.first_frame_path, /first_s11\.png$/);
  assert.equal(g1.last_frame_source, 'upload'); assert.match(g1.last_frame_path, /last_s11\.png$/);
  assert.equal(CR.keyframeReviewOf(g1).verdict, 'pass');
  // s2：和 s1 同一地点、没写换场 → 自动承接 22 帧：只出、只挂尾帧，首帧字段不动（留给承接）
  const r2 = await RIG.runKeyframeRig({ projectId: p.id, cfg }, s2.id, { deps });
  assert.equal(r2.review.lead_in, true);
  assert.ok(!made.some((x) => x.startsWith(s2.id + ':first')), '承接的镜不出首帧');
  const g2 = core.Shots.get(s2.id);
  assert.equal(g2.first_frame_source, ''); assert.equal(g2.last_frame_source, 'upload');
});
