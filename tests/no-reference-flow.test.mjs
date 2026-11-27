// 没有参考项目的新剧从零全流程（Andy 11-26「流程该有的不能少，以后做新剧不可能拿这个 v2」）：
// 资产分析建人物 → 音色（没有现成音色，交新设计）→ 出图派单（无底图，不卡）→ 审图（无底图可 na）→ 写分镜绑定（IC 自己绑）→ 提示词（交提示词撰写）。
// 任何一步都不依赖参考项目；假 am、假审图，不连 Muse、不起 CLI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-noref-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let G; let W; let AI; let RV; let VI; let ST; let tools; let AM; let ac;
before(async () => {
  core = await import('../lib/core/index.js');
  G = await import('../lib/core/asset-gaps.js');
  W = await import('../lib/core/asset-image-work.js');
  AI = await import('../lib/agent/asset-image.js');
  RV = await import('../lib/agent/asset-image-review-mcp.js');
  VI = await import('../lib/core/voice-import.js');
  ST = await import('../lib/agent/stages.js');
  tools = await import('../lib/agent/tools.js');
  AM = await import('../lib/agent/asset-analyze-mcp.js');
  ac = await import('../lib/agent/asset-check.js');
});
const png = (f, c = 'gray') => { fs.mkdirSync(path.dirname(f), { recursive: true }); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=' + c + ':s=64x36', '-frames:v', '1', f]); return f; };
const waitFor = async (fn) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

test('没有参考项目：资产分析建人物 → 音色交新设计 → 出图派单不带底图 → 审图过 → 写分镜 IC 自己绑 → 只剩提示词交提示词撰写', async () => {
  const p = core.Projects.create({ name: '新剧·无参考' });
  core.Projects.setContextKey(p.id, 'asset_mode', 'gap-list');
  assert.equal(ac.icAutoBindOn(p.id), true, '新建项目默认 IC 自己绑');
  // ① 资产分析：看参考图不报错，提示按从零走
  const ctx = { projectId: p.id, jobId: 'jnr' };
  assert.equal(JSON.parse(await AM.runAssetAnalyzeExtraTool(ctx, 'view_reference_asset', { name: 'S434_MV' })).no_reference_project, true);
  // ② 缺图单 → 建资产槽（人物从服装行建出来，服装挂人物下；场景 _MV、阶段变体、道具）
  G.mergeGapList(p.id, { items: [
    { kind: 'costume', name: '林舟·通勤装', requirement: '藏青夹克' },
    { kind: 'scene', name: 'L01_MV·书店·多视角定义图', location_id: 'L01', requirement: '空场' },
    { kind: 'scene', name: '书店·午后有客', location_id: 'L01', requirement: '约6人' },
    { kind: 'prop', name: '旧书', requirement: '泛黄' },
  ] });
  const slots = G.createAssetSlots(p.id, {});
  const lz = core.Assets.list(p.id).find((a) => a.category === 'character' && a.name === '林舟');
  assert.ok(lz, '人物从服装行自动建出来');
  assert.ok(slots.created.length >= 5);
  // ③ 音色：没有参考项目，导入全部跳过（不报错），交音色阶段新设计
  const vr = VI.importMissingVoices(p.id);
  assert.ok(vr.every((x) => x.skipped && !x.error));
  core.Shots.create(p.id, { idx: 1, chapter: '第1章', character_ids: [lz.id], dialogue: '林舟：开门了' });
  assert.ok(ST.pendingByStage(p.id, '第1章').tts.items.some((x) => x.includes('林舟')), '没音色的照常交新设计');
  // ④ 出图派单：没有底图不卡；阶段变体等 _MV 定稿后才挂本项目 A 格
  core.Projects.setContextKey(p.id, W.THREADS_KEY, [{ name: '场景1', session: 's-scene', lane: 'scene' }]);
  const mvRow = G.getGapList(p.id).items.find((x) => /_MV/.test(x.name));
  assert.equal(mvRow.base_ref, undefined);
  assert.equal(W.applyStageBaseRefs(p.id), 0, '_MV 还没定稿，阶段变体不挂底图');
  const sent = []; const outbox = {};
  const am = {
    send: async (s, t) => { sent.push(t); return { ok: true, confirmed: true }; },
    put: async () => ({ ok: true }),
    list: async () => ({ ok: true, files: Object.keys(outbox).map((name) => ({ name, size: 1 })) }),
    get: async (remote, local) => { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.copyFileSync(outbox[path.basename(remote)], local); return { ok: true }; },
    runReview: async ({ jobId }) => {
      const cp = core.Jobs.get(jobId).checkpoint;
      const checks = Object.fromEntries(Object.keys(RV.REVIEW_CHECKS).map((k) => [k, { ok: k === 'base_image' ? 'na' : true, note: k === 'base_image' ? '新剧没有底图' : '看过' }]));
      const r = { verdict: 'pass', checks, checklist: [{ item: '书架', expected: '北墙', seen: '北墙', ok: true }, { item: '柜台', expected: '东', seen: '东', ok: true }, { item: '门', expected: '南', seen: '南', ok: true }] };
      assert.equal(RV.validateReview(r, { step: cp.step, isMv: true, isScene: true, hasBase: false }), '', '没有底图时 base_image 可以 na');
      fs.writeFileSync(RV.reviewResultPath(p.id, cp), JSON.stringify(r));
    },
  };
  AI.setRunning(p.id, true, { allow: [mvRow.asset_id] });
  for (const step of ['A', 'B', 'C', 'D']) {
    await AI.tick(p.id, am);
    const it = W.loadWork(p.id).items[mvRow.asset_id];
    assert.equal(it.step, step);
    assert.doesNotMatch(sent[sent.length - 1], /前作定稿底图/, '没有底图就不提图生图');
    outbox[it.prefix + '.png'] = png(path.join(tmp, step + '.png'));
    await AI.tick(p.id, am);
    await waitFor(() => ['next_step', 'passed'].includes(W.loadWork(p.id).items[mvRow.asset_id].status));
  }
  assert.ok(await waitFor(() => W.loadWork(p.id).items[mvRow.asset_id].status === 'passed'), '拼板核对过了写回');
  assert.ok(core.Assets.get(mvRow.asset_id).image_path);
  AI.setRunning(p.id, false);
  assert.equal(W.applyStageBaseRefs(p.id), 1, '_MV 定稿后阶段变体自动挂本项目 A 格');
  // ⑤ 写分镜：IC 自己绑
  const tctx = tools.createToolRuntime({ projectId: p.id, chapter: '第1章' });
  const cos = core.Assets.list(p.id).find((a) => a.category === 'costume');
  await tools.runTool(tctx, 'set_storyboard', { shots: [{ idx: 2, chapter: '第1章', visual: '林舟推门进书店', characters: ['林舟'], costumes: [cos.name], scenes: ['书店·午后有客'] }] });
  const s2 = core.Shots.list(p.id).find((s) => s.idx === 2);
  assert.deepEqual(s2.character_ids, [lz.id]); assert.equal(s2.scene_ids.length, 1); assert.equal(s2.costume_ids.length, 1);
  // ⑥ 提示词：绑定齐、只差视频提示词 → LLM 收尾交提示词撰写
  const items = ST.pendingByStage(p.id, '第1章').llm.items.filter((x) => x.startsWith('第2镜'));
  assert.deepEqual(items, ['第2镜缺视频提示词']);
});
