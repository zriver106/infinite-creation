// ic27 首尾帧衔接：DB 字段 / 承接上一镜抽帧（真 ffmpeg，CPU）/ 过期判断 / 工作流注入 MiniMaxH3AddGuide /
// 单镜重生成与整章批量出片两条渲染链路都带上首帧。
// 守卫：IC_CONFIG 指向 :9，8188/8189 一律拦截；:9 的 /upload/ 返回 mock，/prompt 只抓取提交的图然后让它失败——不出片、不占 GPU。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-firstframe-'));
writeTempIcConfig(tmp);

const submitted = []; // 抓到的 ComfyUI prompt 图
const uploads = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url && url.href ? url.href : url);
  if (/:8188|:8189/.test(href)) throw new Error('fetch 守卫拦截了 8188/8189 请求：' + href);
  if (href.includes('/upload/')) {
    const name = 'up_' + uploads.length + '.png';
    uploads.push(name);
    return new Response(JSON.stringify({ name, subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/\/prompt\b/.test(href) && init && init.method === 'POST') {
    try { submitted.push(JSON.parse(init.body).prompt); } catch { submitted.push(null); }
    return new Response(JSON.stringify({ error: { message: 'TEST: 已抓取提交图，拒绝执行（不出片）' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('测试禁止访问：' + href);
};

let core, tools, ff, wr, specs;
before(async () => {
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
  ff = await import('../lib/core/first-frame.js');
  wr = await import('../lib/core/workflow-runner.js');
  specs = await import('../lib/core/workflow-specs.js');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// 生成一段 1 秒测试视频：前 0.8s 蓝色，最后 0.2s 红色 —— 抽出的「最后一帧」必须是红色
function makeClip(abs, lastColor = 'red') {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=0.8',
    '-f', 'lavfi', '-i', 'color=c=' + lastColor + ':s=320x180:r=24:d=0.2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', abs]);
  if (r.status !== 0) throw new Error('ffmpeg 生成测试视频失败：' + r.stderr);
}
function avgRgb(absPng) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', absPng, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...r.stdout.subarray(0, 3)];
}
function put(pid, rel, bytes) {
  const abs = path.join(core.projectDir(pid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return rel;
}
function mkProject(chapter = '第5章') {
  const p = core.Projects.create({ name: 'ff-it', auto_script: false });
  core.Chapters.create(p.id, { title: chapter, script: 'x' });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter });
  ctx.cfg.comfyui = { url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9', provider: 'native' };
  ctx.cfg.generation = { ...(ctx.cfg.generation || {}), videosPerShot: 1, clipQuality: false, refLeakGuard: false };
  return { p, ctx, chapter };
}
// 两镜：第1镜有一条选中候选（红尾），第2镜绑一个人物参考图
function mkTwoShots() {
  const { p, ctx, chapter } = mkProject();
  const char = core.Assets.create(p.id, { category: 'character', name: '江澈' });
  core.Assets.update(char.id, { image_path: put(p.id, 'assets/characters/c.png', 'CHAR'), status: 'done' });
  const s1 = core.Shots.create(p.id, { chapter, idx: 1, visual: '一', mode: 'reference' });
  const s2 = core.Shots.create(p.id, { chapter, idx: 2, visual: '二', mode: 'reference' });
  core.Shots.update(s2.id, { character_ids: [char.id], video_prompt: '__MINIMAX_H3_REF_1__ walks in' });
  makeClip(path.join(core.projectDir(p.id), 'shots/s1_a.mp4'), 'red');
  const v1 = core.ShotVideos.create(p.id, s1.id, { idx: 0, video_path: 'shots/s1_a.mp4', seed: 1 });
  core.ShotVideos.setSelected(s1.id, v1.id);
  core.Shots.update(s1.id, { status: 'done', video_path: 'shots/s1_a.mp4' });
  return { p, ctx, chapter, char, s1, s2, v1 };
}

// —— 纯函数：工作流注入 ——
test('buildWorkflow(minimax_h3_r2v)：参考图+音色照常绑定，首/尾帧经 MiniMaxH3AddGuide 串到 BasicGuider', () => {
  const spec = specs.getDefaultSpecById('minimax_h3_r2v');
  const wf = wr.buildWorkflow(spec, {
    positive_prompt: 'p', mode: 'reference', seed: 1, filename_prefix: 'video/t',
    references: [{ type: 'image', filename: 'char.png' }, { type: 'image', filename: 'scene.png' }, { type: 'audio', filename: 'v.wav' }],
    keyframes: [{ filename: 'first.png', frame_idx: 0 }, { filename: 'last.png', frame_idx: -1 }],
  });
  // 参考素材不受影响：节点 2 仍有 3 个 media（2 图 + 1 音），mode=reference
  assert.equal(wf['2'].inputs.mode, 'reference');
  assert.equal(Object.keys(wf['2'].inputs).filter((k) => /^media_\d+$/.test(k)).length, 3);
  // 首帧：LoadImage 3000 → AddGuide 3001(positive=13.0, frame_idx 0)；尾帧：3002 → 3003(positive=3001, frame_idx -1)
  assert.equal(wf['3000'].class_type, 'LoadImage');
  assert.equal(wf['3000'].inputs.image, 'first.png');
  assert.equal(wf['3001'].class_type, 'MiniMaxH3AddGuide');
  assert.deepEqual(wf['3001'].inputs.positive, ['13', 0]);
  assert.deepEqual(wf['3001'].inputs.latent, ['13', 1]);
  assert.deepEqual(wf['3001'].inputs.vae, ['13', 2]);
  assert.equal(wf['3001'].inputs.frame_idx, 0);
  assert.deepEqual(wf['3003'].inputs.positive, ['3001', 0]);
  assert.equal(wf['3003'].inputs.frame_idx, -1);
  assert.deepEqual(wf['4'].inputs.conditioning, ['3003', 0]);
  // 剪枝后仍可达（没被当孤立节点删掉）
  for (const id of ['3000', '3001', '3002', '3003']) assert.ok(wf[id], '节点 ' + id + ' 被剪掉了');
});

test('buildWorkflow：无 keyframes 时与改动前完全一致（BasicGuider 仍接 13.0）', () => {
  const spec = specs.getDefaultSpecById('minimax_h3_r2v');
  const wf = wr.buildWorkflow(spec, { positive_prompt: 'p', mode: 'reference', references: [{ type: 'image', filename: 'c.png' }] });
  assert.deepEqual(wf['4'].inputs.conditioning, ['13', 0]);
  assert.ok(!Object.values(wf).some((n) => n.class_type === 'MiniMaxH3AddGuide'));
});

test('buildWorkflow(二次采样超分)：只锚首遍 BasicGuider 126，二遍 259 不动', () => {
  const spec = specs.getDefaultSpecById('minimax_h3_r2v_upscale');
  const wf = wr.buildWorkflow(spec, { positive_prompt: 'p', mode: 'reference', references: [{ type: 'image', filename: 'c.png' }], keyframes: [{ filename: 'f.png', frame_idx: 0 }] });
  assert.deepEqual(wf['126'].inputs.conditioning, ['3001', 0]);
  assert.deepEqual(wf['3001'].inputs.positive, ['257', 0]);
  assert.deepEqual(wf['259'].inputs.conditioning, ['258', 0]);
});

test('不支持锚定的工作流（RunningHub）带首帧 → 明确报错，不静默丢首帧', () => {
  const spec = specs.getDefaultSpecById('runninghub_minimax_h3_r2v');
  assert.throws(() => wr.buildWorkflow(spec, { positive_prompt: 'p', references: [], keyframes: [{ filename: 'f.png', frame_idx: 0 }] }), /不支持首\/尾帧锚定/);
});

test('resolveShotVideoMode：卡片槽位设置的首+尾帧不会把空 mode 推成 first_last；历史上传仍是 first_last', () => {
  assert.equal(wr.resolveShotVideoMode({ mode: '', first_frame_path: 'a.png', last_frame_path: 'b.png' }), 'first_last');
  assert.equal(wr.resolveShotVideoMode({ mode: '', first_frame_path: 'a.png', last_frame_path: 'b.png', first_frame_source: 'prev_shot', last_frame_source: 'upload' }), '');
});

test('prevShotOf：同章、跳过作废镜、取 idx 最大的前一镜', () => {
  const shots = [
    { id: 'a', chapter: 'c', idx: 1 }, { id: 'b', chapter: 'c', idx: 2, status: 'obsolete' },
    { id: 'x', chapter: 'd', idx: 2 }, { id: 'c', chapter: 'c', idx: 3 },
  ];
  assert.equal(ff.prevShotOf(shots[3], shots).id, 'a');
  assert.equal(ff.prevShotOf(shots[0], shots), null);
});

// —— DB + 真 ffmpeg ——
test('DB 迁移：shots 有 first_frame_source / first_frame_from_shot_id / first_frame_from_video_id / last_frame_source', () => {
  const { p, chapter } = mkProject();
  const s = core.Shots.create(p.id, { chapter, visual: 'v' });
  for (const k of ['first_frame_source', 'first_frame_from_shot_id', 'first_frame_from_video_id', 'last_frame_source']) assert.equal(s[k], '', k);
});

test('承接上一镜：抽到的是上一镜选中候选的最后一帧（红），并记录来源 shot_video id', { skip: !hasFfmpeg && '无 ffmpeg' }, async () => {
  const { p, s1, s2, v1 } = mkTwoShots();
  const r = await ff.chainFirstFrameFromPrev(p.id, s2.id);
  assert.equal(r.prev_shot_id, s1.id);
  assert.equal(r.video_id, v1.id);
  const s = core.Shots.get(s2.id);
  assert.equal(s.first_frame_source, 'prev_shot');
  assert.equal(s.first_frame_from_shot_id, s1.id);
  assert.equal(s.first_frame_from_video_id, v1.id);
  assert.match(s.first_frame_path, /^frames\/shot2_.*\.png$/);
  const [R, G, B] = avgRgb(path.join(core.projectDir(p.id), s.first_frame_path));
  assert.ok(R > 180 && G < 80 && B < 80, '最后一帧应为红色，实际 rgb=' + [R, G, B]);
  // 状态：未过期
  assert.equal(ff.firstFrameStatus(s, core.Shots.list(p.id), { exists: () => true }).stale, false);
  // 第一镜不能承接
  await assert.rejects(ff.chainFirstFrameFromPrev(p.id, s1.id), /第一镜/);
});

test('上一镜换选中候选 → 下一镜首帧判过期；出片前 resolveShotKeyframes 自动按新候选重抽（绿）', { skip: !hasFfmpeg && '无 ffmpeg' }, async () => {
  const { p, s1, s2 } = mkTwoShots();
  await ff.chainFirstFrameFromPrev(p.id, s2.id);
  makeClip(path.join(core.projectDir(p.id), 'shots/s1_b.mp4'), 'lime');
  const v2 = core.ShotVideos.create(p.id, s1.id, { idx: 1, video_path: 'shots/s1_b.mp4', seed: 2 });
  core.ShotVideos.setSelected(s1.id, v2.id);
  const st = ff.firstFrameStatus(core.Shots.get(s2.id), core.Shots.list(p.id), { exists: () => true });
  assert.equal(st.stale, true);
  assert.match(st.reason, /换了选中候选/);
  const notes = [];
  const kfs = await ff.resolveShotKeyframes(p.id, s2.id, { mode: 'reference', report: (m) => notes.push(m) });
  assert.equal(kfs.length, 1);
  assert.equal(kfs[0].frame_idx, 0);
  assert.equal(core.Shots.get(s2.id).first_frame_from_video_id, v2.id);
  assert.ok(notes.some((m) => /重新抽帧/.test(m)), notes.join('|'));
  const [R, G] = avgRgb(kfs[0].abs);
  assert.ok(G > 180 && R < 80, '重抽后应为新候选最后一帧（绿），实际 R=' + R + ' G=' + G);
});

test('手动上传首帧/尾帧 + 清空（文件保留）；非图片/越界路径被拒', () => {
  const { p, chapter } = mkProject();
  const s = core.Shots.create(p.id, { chapter, visual: 'v' });
  const rel = put(p.id, 'media/f.png', 'PNG');
  const rel2 = put(p.id, 'media/l.png', 'PNG');
  ff.setUploadedFrame(p.id, s.id, 'first', rel);
  ff.setUploadedFrame(p.id, s.id, 'last', rel2);
  let x = core.Shots.get(s.id);
  assert.equal(x.first_frame_source, 'upload');
  assert.equal(x.last_frame_source, 'upload');
  assert.throws(() => ff.setUploadedFrame(p.id, s.id, 'first', '../../etc/passwd.png'), /不存在或不在项目目录内/);
  put(p.id, 'media/a.txt', 'x');
  assert.throws(() => ff.setUploadedFrame(p.id, s.id, 'first', 'media/a.txt'), /只接受图片/);
  ff.clearFrame(p.id, s.id, 'first');
  x = core.Shots.get(s.id);
  assert.equal(x.first_frame_path, '');
  assert.equal(x.first_frame_source, '');
  assert.ok(fs.existsSync(path.join(core.projectDir(p.id), rel)), '清空槽位不应删除图片文件');
});

test('image 模式忽略卡片槽位；first_last 历史模式不经过槽位', async () => {
  const { p, chapter } = mkProject();
  const s = core.Shots.create(p.id, { chapter, visual: 'v' });
  ff.setUploadedFrame(p.id, s.id, 'first', put(p.id, 'media/f.png', 'PNG'));
  const notes = [];
  assert.deepEqual(await ff.resolveShotKeyframes(p.id, s.id, { mode: 'image', report: (m) => notes.push(m) }), []);
  assert.ok(notes.length);
  assert.deepEqual(await ff.resolveShotKeyframes(p.id, s.id, { mode: 'first_last' }), []);
});

// —— 渲染链路（抓提交图，不出片） ——
function lastGraph() { return submitted[submitted.length - 1]; }
function guides(g) { return Object.entries(g || {}).filter(([, n]) => n.class_type === 'MiniMaxH3AddGuide'); }

test('单镜「生成候选」（regenerate_shot append）：提交的图里带首帧 AddGuide + 原人物参考图', { skip: !hasFfmpeg && '无 ffmpeg' }, async () => {
  const { p, ctx, s2 } = mkTwoShots();
  await ff.chainFirstFrameFromPrev(p.id, s2.id);
  const before = submitted.length;
  await assert.rejects(tools.runTool(ctx, 'regenerate_shot', { shot_id: s2.id, append: true }));
  assert.ok(submitted.length > before, '应该走到提交 /prompt');
  const g = lastGraph();
  const gs = guides(g);
  assert.equal(gs.length, 1);
  assert.equal(gs[0][1].inputs.frame_idx, 0);
  const loadId = gs[0][1].inputs.image[0];
  assert.match(g[loadId].inputs.image, /^ic_[0-9a-f]{8}_kffirst_[0-9a-f]{8}\.png$/);
  assert.deepEqual(g['4'].inputs.conditioning, [gs[0][0], 0]);
  assert.equal(g['2'].inputs.mode, 'reference');
  assert.ok(Object.keys(g['2'].inputs).some((k) => /^media_\d+$/.test(k)), '人物参考图仍应绑定在节点 2');
});

test('整章批量出片（generate_chapter_videos）：第2镜在第1镜之后解析首帧，提交图带 AddGuide', { skip: !hasFfmpeg && '无 ffmpeg' }, async () => {
  const { p, ctx, chapter, s2 } = mkTwoShots();
  await ff.chainFirstFrameFromPrev(p.id, s2.id);
  // 把第1镜也设成 done 且提示词一致 → 本批只跑第2镜
  const s1 = core.Shots.list(p.id).find((s) => s.idx === 1);
  core.Shots.update(s1.id, { video_prompt: 'x', video_prompt_used: 'x', status: 'done' });
  const before = submitted.length;
  const out = JSON.parse(await tools.runTool(ctx, 'generate_chapter_videos', { chapter }));
  assert.ok(submitted.length > before, '批量出片应提交 /prompt：' + JSON.stringify(out));
  const gs = guides(lastGraph());
  assert.equal(gs.length, 1);
  assert.equal(gs[0][1].inputs.frame_idx, 0);
  assert.equal(out.failed, 1); // mock 拒绝执行 → 本镜失败（预期），但图已带首帧
});

test('未设置槽位的分镜：提交图与改动前一致（没有 AddGuide）', async () => {
  const { p, ctx, chapter } = mkProject();
  const char = core.Assets.create(p.id, { category: 'character', name: '甲' });
  core.Assets.update(char.id, { image_path: put(p.id, 'assets/characters/a.png', 'A'), status: 'done' });
  const s = core.Shots.create(p.id, { chapter, idx: 1, visual: 'v', mode: 'reference' });
  core.Shots.update(s.id, { character_ids: [char.id], video_prompt: '__MINIMAX_H3_REF_1__ stands' });
  const before = submitted.length;
  await assert.rejects(tools.runTool(ctx, 'regenerate_shot', { shot_id: s.id, append: true }));
  assert.ok(submitted.length > before);
  assert.equal(guides(lastGraph()).length, 0);
  assert.deepEqual(lastGraph()['4'].inputs.conditioning, ['13', 0]);
});
