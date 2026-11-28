// 网页导出的帧率收尾（11-28 第二版）：当场只裁边（不碰显卡，裁不成整个导出失败）；插到 30 帧另起 export-interp 任务，
// 走视频任务闸门排在出片后面；插帧没成任务记失败；临时文件换不回去时重试 / 拷贝，不再静默留下 .fps_tmp。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-exp-fin-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;

test('网页导出路由：当场只裁边（interp:false，不用 withGpuAccess，失败不吞）；插帧排 export-interp；有只重跑插帧的入口', () => {
  const src = fs.readFileSync(new URL('../app/api/projects/[id]/export/route.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const rel of \[outRel, subtitles \? nosubRel : ''\]\.filter\(Boolean\)\)/);
  assert.match(src, /finalizeExport\(id, resolveProjectPath\(id, rel\), \{ report: \(d\) => emit\(d\), interp: false \}\)/);
  assert.doesNotMatch(src, /withGpuAccess/, '网页导出不在文本通道，withGpuAccess 会直接放行，不能用它挡显卡');
  assert.doesNotMatch(src, /帧率收尾失败（成片保持原样）/, '裁边失败不能再吞掉');
  assert.match(src, /startExportInterp\(id, \{ chapter, rels: \[outRel, subtitles \? nosubRel : ''\]/);
  assert.match(src, /body\.action === 'finalize'/);
  assert.ok(src.indexOf('finalizeExport(id') > src.indexOf('await mergeVideos(inputs, resolveProjectPath(id, outRel)'));
});

test('replaceFile：改名 EPERM 先重试，仍不行就拷贝；拷贝也失败才抛错并写明临时文件位置', async () => {
  const { replaceFile } = await import('../lib/core/fps-finalize.js');
  const sleep = async () => {};
  let n = 0;
  const flaky = { renameSync: () => { n++; if (n < 3) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; } }, copyFileSync: () => { throw new Error('不该走到'); }, rmSync: () => {} };
  assert.equal(await replaceFile('a', 'b', { sleep, fsx: flaky }), 'rename'); assert.equal(n, 3);
  let copied = false;
  const locked = { renameSync: () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }, copyFileSync: () => { copied = true; }, rmSync: () => {} };
  assert.equal(await replaceFile('a', 'b', { sleep, fsx: locked, tries: 3 }), 'copy'); assert.ok(copied);
  const dead = { renameSync: () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }, copyFileSync: () => { throw new Error('EBUSY copy'); }, rmSync: () => {} };
  await assert.rejects(replaceFile('C:/x/a.fps_tmp.mp4', 'b', { sleep, fsx: dead, tries: 2 }), /临时文件留在 C:\/x\/a\.fps_tmp\.mp4/);
  const a = path.join(tmp, 'r.tmp'); const b = path.join(tmp, 'r.mp4'); fs.writeFileSync(a, 'new'); fs.writeFileSync(b, 'old');
  assert.equal(await replaceFile(a, b), 'rename'); assert.equal(fs.readFileSync(b, 'utf8'), 'new'); assert.ok(!fs.existsSync(a));
});

test('export-interp 任务：走视频闸门、逐份插帧、插完按章重新交付；任一份没插成任务失败，不报完成', async () => {
  const { startExportInterp } = await import('../lib/agent/export-interp.js');
  const calls = [];
  const run = async (_opt, fn) => fn(() => {});
  const gate = async (fn) => { calls.push('gate'); return fn(); };
  const deliver = async (a) => { calls.push('deliver:' + a.exportRel); return { status: 'ok' }; };
  const okFin = async (_pid, abs) => { calls.push('fin:' + path.basename(abs)); return { failed: false, note: 'RIFE 独立版插到 30fps' }; };
  const r = await startExportInterp('p1', { chapter: '第1章', rels: ['exports/a.mp4', 'exports/a_nosub.mp4', ''] }, { finalize: okFin, gate, deliver, run });
  assert.deepEqual(calls, ['gate', 'fin:a.mp4', 'fin:a_nosub.mp4', 'deliver:exports/a.mp4']);
  assert.match(r, /交付：ok/);
  const badFin = async () => ({ failed: true, note: 'RIFE 插帧没跑成（vulkan out of memory）' });
  await assert.rejects(startExportInterp('p1', { chapter: '第1章', rels: ['exports/a.mp4'] }, { finalize: badFin, gate, deliver, run }), /插帧失败：RIFE 插帧没跑成/);
});
