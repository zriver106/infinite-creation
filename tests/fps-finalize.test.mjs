// 成片帧率收尾（总导 11-26）：1088 裁 1080；按项目设置插 30 帧（RIFE 独立版）；RIFE 不可用 / 不插时只裁、写明原因。不碰显卡。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fps-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, rife: { root: path.join(tmp, 'no_rife_here') } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let F;
before(async () => { core = await import('../lib/core/index.js'); F = await import('../lib/core/fps-finalize.js'); });
const clip = (f) => { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x1088:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]); return f; };

test('缺省是 RIFE 独立版；RIFE 不在时只裁 1088→1080、帧率不动、写明原因', async () => {
  const p = core.Projects.create({ name: 'fps' });
  assert.equal(F.interpModeOf(p.id), 'rife');
  assert.equal(F.rifeAvailable(), false);
  const f = clip(path.join(tmp, 'a.mp4'));
  const r = await F.finalizeExport(p.id, f);
  assert.equal(r.cropped, true); assert.equal(r.interp, false); assert.match(r.note, /RIFE 独立版文件不在/);
  const i = await F.probe(f);
  assert.equal(i.height, 1080); assert.ok(Math.abs(i.fps - 24) < 0.1);
});

test('项目设置不插帧：只裁；已经是 1080 / 30 帧的不动', async () => {
  const p = core.Projects.create({ name: 'fps2' });
  core.Projects.setContextKey(p.id, F.EXPORT_INTERP_KEY, 'none');
  const f = clip(path.join(tmp, 'b.mp4'));
  const r = await F.finalizeExport(p.id, f);
  assert.match(r.note, /不插帧/); assert.equal((await F.probe(f)).height, 1080);
  const r2 = await F.finalizeExport(p.id, f);
  assert.equal(r2.cropped, false);
});

test('RIFE 插帧跑失败（比如只跑文本的任务里不许用显卡）：退回只裁，成片照样出', async () => {
  const p = core.Projects.create({ name: 'fps3' });
  const fake = path.join(tmp, 'fake_rife'); fs.mkdirSync(path.join(fake, 'rife-v4.6'), { recursive: true }); fs.writeFileSync(path.join(fake, 'rife-ncnn-vulkan.exe'), 'x');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfg.rife = { root: fake }; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const f = clip(path.join(tmp, 'c.mp4'));
  const r = await F.finalizeExport(p.id, f, { runGpu: () => Promise.reject(new Error('分镜任务（只跑文本）不能使用显卡')) });
  assert.equal(r.interp, false); assert.match(r.note, /RIFE 插帧没跑成/); assert.equal((await F.probe(f)).height, 1080);
});

test('裁边按标准档：736→720、1088→1080、496→480；标准档和差太多的不动（11-28 跟进2 报 720P 出 736）', async () => {
  assert.equal(F.cropTargetHeight(736), 720); assert.equal(F.cropTargetHeight(1088), 1080); assert.equal(F.cropTargetHeight(496), 480);
  for (const h of [720, 1080, 480, 2160]) assert.equal(F.cropTargetHeight(h), 0);
  assert.equal(F.cropTargetHeight(900), 0, '离下一档 180 行，不是对齐多出来的，不裁');
  const f = path.join(tmp, 'h736.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x736:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const r = await F.finalizeExport(core.Projects.create({ name: 'fps736' }).id, f);
  assert.equal(r.cropped, true); assert.match(r.note, /736→720/);
  assert.equal((await F.probe(f)).height, 720);
});
