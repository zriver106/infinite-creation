// 承接上一镜 22 帧（Andy 11-26）：出片帧数、何时承接、工作流注入（LoadVideo → GetVideoComponents → AddGuide 带 audio_vae）、
// 候选记 lead_in_frames、导出输入换成剪掉开头的文件、分镜开关接口、brief 字段。临时数据目录，不碰真库、不起 GPU、不跑 ffmpeg。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-leadin-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
const ROOT = process.cwd();
registerHooks({ resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
  if (spec === 'next/server') return next('next/server.js', ctx);
  return next(spec, ctx);
} });
let core; let L; let WR; let WS; let pwm;
before(async () => {
  core = await import('../lib/core/index.js');
  L = await import('../lib/core/lead-in.js');
  WR = await import('../lib/core/workflow-runner.js');
  WS = await import('../lib/core/workflow-specs.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
});

test('出片帧数：总帧数对齐 17k+5，正文 = 总帧数 − 22（17 的倍数），seconds = 总帧数 / 24', () => {
  for (const d of [3, 5, 6, 8, 10, 12, 15]) {
    const p = L.leadInRenderPlan(d);
    assert.equal(p.totalFrames % 17, 5, d + ' 秒');
    assert.equal(p.contentFrames, p.totalFrames - 22);
    assert.equal(p.contentFrames % 17, 0);
    assert.ok(Math.abs(p.contentSeconds - d) <= 0.36, d + ' 秒正文 ' + p.contentSeconds);
    assert.equal(p.seconds, p.totalFrames / 24);
  }
  assert.deepEqual(L.leadInRenderPlan(6), { totalFrames: 158, contentFrames: 136, seconds: 158 / 24, contentSeconds: 136 / 24 });
});

test('何时承接：同场景且两镜都没写换场 / 跳时 / 闪回 → 自动接；手动接 / 不接；用首帧图的不叠', () => {
  const prev = { idx: 1, scene_ids: ['s1'], visual: '江澈坐在工位' };
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], visual: '江澈站起来' }, prev).on, true);
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s2'], visual: '江澈站起来' }, prev).on, false);
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], visual: '闪回：爷爷的诊室' }, prev).on, false);
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], visual: 'x', scene_name: '次日上午' }, prev).on, false);
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], visual: 'x' }, { ...prev, camera: '跳切' }).on, false);
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s2'], first_frame_source: 'prev_clip22' }, prev).on, true, '手动接');
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], first_frame_source: 'none' }, prev).on, false, '手动不接');
  assert.equal(L.leadInDecision({ idx: 2, scene_ids: ['s1'], first_frame_source: 'prev_shot' }, prev).on, false, '用了首帧图');
  assert.equal(L.leadInDecision({ idx: 1, scene_ids: ['s1'] }, null).on, false, '本章第一镜');
});

test('工作流注入：片段走 LoadVideo → GetVideoComponents → AddGuide（vae + audio_vae + image + audio，frame_idx=0）；规格缺 audioVae 报错', () => {
  const spec = WS.DEFAULT_SPECS.find((s) => s.id === 'minimax_h3_r2v');
  assert.deepEqual(WS.DEFAULT_SPECS.find((s) => s.id === 'minimax_h3_r2v_upscale').keyframes.audioVae, ['257', 3]);
  const kc = spec.keyframes;
  assert.deepEqual(kc.audioVae, ['13', 3]);
  const wf = { 13: { class_type: 'MiniMaxH3EasyOutput', inputs: {} }, 4: { class_type: 'BasicGuider', inputs: { conditioning: ['13', 0] } } };
  WR.injectKeyframes(wf, { keyframes: kc }, [{ clip: 'ic_leadin.mov', frame_idx: 0 }, { filename: 'last.png', frame_idx: -1 }]);
  const byClass = (c) => Object.entries(wf).filter(([, n]) => n.class_type === c);
  const [[lvId, lv]] = byClass('LoadVideo');
  assert.equal(lv.inputs.file, 'ic_leadin.mov');
  const [[gcId, gc]] = byClass('GetVideoComponents');
  assert.deepEqual(gc.inputs.video, [lvId, 0]);
  const guides = byClass('MiniMaxH3AddGuide');
  assert.equal(guides.length, 2);
  const clipGuide = guides.find(([, n]) => n.inputs.audio)[1];
  assert.deepEqual(clipGuide.inputs.image, [gcId, 0]); assert.deepEqual(clipGuide.inputs.audio, [gcId, 1]);
  assert.deepEqual(clipGuide.inputs.audio_vae, ['13', 3]); assert.deepEqual(clipGuide.inputs.vae, ['13', 2]); assert.equal(clipGuide.inputs.frame_idx, 0);
  assert.deepEqual(clipGuide.inputs.positive, ['13', 0], '片段锚在最前');
  const lastGuideId = guides.find(([, n]) => !n.inputs.audio)[0];
  assert.deepEqual(wf[4].inputs.conditioning, [lastGuideId, 0], 'BasicGuider 接最后一个 AddGuide');
  const wf2 = { 13: { class_type: 'MiniMaxH3EasyOutput', inputs: {} }, 4: { class_type: 'BasicGuider', inputs: {} } };
  assert.throws(() => WR.injectKeyframes(wf2, { keyframes: { ...kc, audioVae: undefined } }, [{ clip: 'x.mov' }]), /audioVae/);
});

test('候选记 lead_in_frames，按 shots.video_path 取；导出输入里带承接的换成剪过的文件，其余原样且一一对应', async () => {
  const p = core.Projects.create({ name: 'li', auto_script: false });
  const a = core.Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '' });
  const b = core.Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v', dialogue: '' });
  core.ShotVideos.create(p.id, a.id, { idx: 0, video_path: 'shots/a.mp4' });
  core.ShotVideos.create(p.id, b.id, { idx: 0, video_path: 'shots/b.mp4', lead_in_frames: 22 });
  core.Shots.update(a.id, { video_path: 'shots/a.mp4' }); core.Shots.update(b.id, { video_path: 'shots/b.mp4' });
  assert.equal(core.ShotVideos.leadInOfShot(core.Shots.get(a.id)), 0);
  assert.equal(core.ShotVideos.leadInOfShot(core.Shots.get(b.id)), 22);
  const dir = path.join(tmp, 'vids'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x'); fs.writeFileSync(path.join(dir, 'b.mp4'), 'x');
  const trimmed = [];
  const out = await L.assemblyInputsFor([core.Shots.get(a.id), { video_path: 'shots/missing.mp4' }, core.Shots.get(b.id)],
    (rel) => (rel.includes('missing') ? '' : path.join(dir, path.basename(rel))), (s) => core.ShotVideos.leadInOfShot(s),
    { trim: async (abs, { frames }) => { trimmed.push(frames); return abs + '.trim'; } });
  assert.deepEqual(out, [path.join(dir, 'a.mp4'), '', path.join(dir, 'b.mp4') + '.trim']);
  assert.deepEqual(trimmed, [22]);
});

test('分镜开关接口 lead_in：on / off / auto；列表接口带 lead_in 判断', async () => {
  const p = core.Projects.create({ name: 'li2', auto_script: false });
  const sc = core.Assets.create(p.id, { category: 'scene', name: '办公室' });
  const a = core.Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  const b = core.Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  void a;
  const { POST } = await import('../app/api/projects/[id]/shots/[sid]/first-frame/route.js');
  const call = async (body) => { const r = await POST(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: p.id, sid: b.id }) }); return { status: r.status, j: await r.json() }; };
  let r = await call({ action: 'lead_in', value: 'off' });
  assert.equal(r.j.first_frame_source, 'none'); assert.equal(r.j.lead_in.on, false);
  r = await call({ action: 'lead_in', value: 'auto' });
  assert.equal(r.j.first_frame_source, ''); assert.equal(r.j.lead_in.on, true); assert.equal(r.j.lead_in.mode, 'auto');
  r = await call({ action: 'lead_in', value: 'on' });
  assert.equal(r.j.first_frame_source, 'prev_clip22'); assert.equal(r.j.lead_in.mode, 'manual');
  assert.equal((await call({ action: 'lead_in', value: 'maybe' })).status, 400);
  const { GET } = await import('../app/api/projects/[id]/shots/route.js');
  const list = await (await GET(new Request('http://x/'), { params: Promise.resolve({ id: p.id }) })).json();
  assert.equal(list.find((s) => s.id === b.id).lead_in.on, true);
  assert.equal(list.find((s) => s.id === b.id).lead_in_frames, 0);
});

test('brief：会承接的镜带 lead_in_frames=22 和说明；本章第一镜不带', async () => {
  const p = core.Projects.create({ name: 'li3', auto_script: false });
  const sc = core.Assets.create(p.id, { category: 'scene', name: '办公室' });
  const a = core.Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '', scene_ids: [sc.id], mode: 'text' });
  const b = core.Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v', dialogue: '', scene_ids: [sc.id], mode: 'text' });
  pwm._resetPromptWriteSession();
  const ctx = { projectId: p.id, jobId: 'jl', chapter: '第1章', project: core.Projects.get(p.id), cfg: {} };
  const bb = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'get_shot_prompt_brief', { shot_id: b.id }));
  assert.equal(bb.lead_in_frames, 22); assert.match(bb.lead_in_rule, /0\.92 秒之后/);
  assert.equal(bb.lead_in_content_frames, bb.lead_in_total_frames - 22); assert.equal(bb.lead_in_content_frames % 17, 0); assert.match(bb.lead_in_rule, /正文帧数/);
  const ba = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'get_shot_prompt_brief', { shot_id: a.id }));
  assert.equal(ba.lead_in_frames, undefined);
});

test('跨集：本章第一镜的上一镜是上一章最后一个未作废镜；_MV 和普通场景图算同一地点；上一镜换选片 → 承接过期', async () => {
  const LC = await import('../lib/agent/lead-in-ctx.js');
  const p = core.Projects.create({ name: 'li4', auto_script: false });
  core.Chapters.create(p.id, { title: '第2章', script: 's' });
  const sc = core.Assets.create(p.id, { category: 'scene', name: 'S095·奥迪4S店展厅', description: '我方资产ID：S095；审核：final；展厅' });
  const mv = core.Assets.create(p.id, { category: 'scene', name: '奥迪展厅·前区·多视角定义图', description: '我方资产ID：S095_MV；审核：final；' });
  const a1 = core.Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  const a2 = core.Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v', dialogue: '', scene_ids: [mv.id] });
  const a3 = core.Shots.create(p.id, { chapter: '第1章', idx: 3, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  core.Shots.update(a3.id, { status: 'obsolete' });
  const b1 = core.Shots.create(p.id, { chapter: '第2章', idx: 1, visual: 'v', dialogue: '', scene_ids: [sc.id] });
  const b1ctx = LC.leadInContext(p.id, core.Shots.get(b1.id));
  assert.equal(b1ctx.prev.id, a2.id, '跳过作废镜，取上一章最后一个有效镜');
  assert.equal(b1ctx.cross, true); assert.equal(b1ctx.decision.on, true, '普通场景图 vs _MV 同一地点');
  assert.match(b1ctx.decision.reason, /跨集/);
  assert.equal(LC.leadInContext(p.id, core.Shots.get(a2.id)).decision.on, true, '章内 _MV 与普通图也算同一地点');
  // 过期：b1 的候选钉的是 a2 的旧候选
  const old = core.ShotVideos.create(p.id, a2.id, { idx: 0, video_path: 'shots/a2_old.mp4' });
  core.ShotVideos.setSelected(a2.id, old.id);
  core.ShotVideos.create(p.id, b1.id, { idx: 0, video_path: 'shots/b1.mp4', lead_in_frames: 22, lead_in_from: old.id });
  core.Shots.update(b1.id, { video_path: 'shots/b1.mp4' });
  assert.equal(LC.leadInContext(p.id, core.Shots.get(b1.id)).stale, false);
  const nw = core.ShotVideos.create(p.id, a2.id, { idx: 1, video_path: 'shots/a2_new.mp4' });
  core.ShotVideos.setSelected(a2.id, nw.id);
  const st = LC.leadInContext(p.id, core.Shots.get(b1.id));
  assert.equal(st.stale, true); assert.match(st.stale_reason, /第1章第2镜/);
  assert.equal(L.leadInPrevOf({ id: 'x', chapter: '第1章', idx: 1 }, core.Shots.listInNarrativeOrder(p.id)), null, '全书第一镜没有上一镜');
});

test('剧本【衔接】→ 承接开关：写「承接」的下一场第一镜接，写别的方式的不接；跨集看上一章末【衔接→下一章】；手动设过的不动', () => {
  const script = '## 【第1场｜上午｜办公室】\n[画面：a]\n【衔接→第2场】\n- 方式：承接，同一地点时间连续\n\n## 【第2场｜上午｜办公室】\n[画面：b]\n【衔接→第3场】方式：跳时，插入时钟\n\n## 【第3场｜下午｜走廊】\n[画面：c]\n【衔接→下一章】方式：承接';
  const tr = L.parseScriptTransitions(script);
  assert.equal(L.transitionLeadInValue(tr.toScene.get(2)), 'on'); assert.equal(L.transitionLeadInValue(tr.toScene.get(3)), 'off'); assert.equal(L.transitionLeadInValue(tr.toNextChapter), 'on');
  const sh = (idx, scene, extra = {}) => ({ id: 's' + idx, idx, scene_name: '【第' + scene + '场｜上午｜办公室】', ...extra });
  const shots = [sh(1, 1), sh(2, 1), sh(3, 2), sh(4, 2), sh(5, 3, { first_frame_source: 'prev_clip22' })];
  const plan = L.planTransitionLeadIns(shots, script, '## 【第9场】\n【衔接→下一章】方式：闪回');
  assert.deepEqual(plan.map((x) => [x.shot.idx, x.value]), [[1, 'off'], [3, 'on']], '第1镜看上一章末（闪回→不接），第3镜第2场开头接，第5镜手动设过不动');
  assert.deepEqual(L.planTransitionLeadIns(shots, '', '').map((x) => x.shot.idx), [], '没写衔接的不动');
});
