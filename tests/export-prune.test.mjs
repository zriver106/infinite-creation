// 导出自动清旧版（Andy 11-28）：同一章只留最新一版；别的章、整片导出、有 2K 派生的旧导出不动；导出 / 插帧 / 交付失败不清。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-prune-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;

const touch = (dir, n) => fs.writeFileSync(path.join(dir, n), 'x');

test('同一章只留最新一版：旧版 mp4 / _nosub / srt / fps_tmp / 合成闸提醒 整组删；别的章、整片导出、新版不动', async () => {
  const { pruneOlderChapterExports } = await import('../lib/core/export-prune.js');
  const dir = fs.mkdtempSync(path.join(tmp, 'exp-'));
  const B = 'V3_第1章';
  for (const n of [B + '_90a01359.mp4', B + '_90a01359_nosub.mp4', B + '_90a01359.srt', B + '_90a01359.fps_tmp.mp4', B + '_90a01359.合成闸提醒.json',
    B + '_aaaaaaaa.mp4', B + '_aaaaaaaa.srt',
    B + '_cb7f7887.mp4', B + '_cb7f7887_nosub.mp4', B + '_cb7f7887.srt',
    'V3_第2章_11111111.mp4', 'V3_22222222.mp4', 'notes.txt']) touch(dir, n);
  const r = pruneOlderChapterExports('p', 'exports/' + B + '_cb7f7887.mp4', { dir });
  assert.deepEqual(r.deleted.sort(), [B + '_90a01359.mp4', B + '_90a01359_nosub.mp4', B + '_90a01359.srt', B + '_90a01359.fps_tmp.mp4', B + '_90a01359.合成闸提醒.json', B + '_aaaaaaaa.mp4', B + '_aaaaaaaa.srt'].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), [B + '_cb7f7887.mp4', B + '_cb7f7887.srt', B + '_cb7f7887_nosub.mp4', 'V3_22222222.mp4', 'V3_第2章_11111111.mp4', 'notes.txt'].sort());
});

test('有 2K 放大版从它派生的旧导出留着；名字不是导出格式的不处理', async () => {
  const { pruneOlderChapterExports } = await import('../lib/core/export-prune.js');
  const dir = fs.mkdtempSync(path.join(tmp, 'exp-'));
  for (const n of ['V3_第1章_11111111.mp4', 'V3_第1章_11111111_2k.mp4', 'V3_第1章_22222222.mp4']) touch(dir, n);
  fs.writeFileSync(path.join(dir, '.ic-versions.json'), JSON.stringify({ files: { 'V3_第1章_11111111_2k.mp4': { upscaled_from: 'V3_第1章_11111111.mp4' } } }));
  const r = pruneOlderChapterExports('p', 'exports/V3_第1章_22222222.mp4', { dir });
  assert.deepEqual(r.deleted, []);
  assert.equal(r.skipped[0].stem, 'V3_第1章_11111111'); assert.match(r.skipped[0].why, /2K/);
  assert.deepEqual(pruneOlderChapterExports('p', 'exports/random.mp4', { dir }), { deleted: [], skipped: [] });
});

test('插帧任务：插帧、交付都成了才清旧版；交付失败不清', async () => {
  const { startExportInterp } = await import('../lib/agent/export-interp.js');
  const run = async (_o, fn) => fn(() => {});
  const gate = async (fn) => fn();
  const fin = async () => ({ failed: false, note: 'ok' });
  const pruned = [];
  const prune = (pid, rel) => { pruned.push(rel); return { deleted: ['old.mp4'], skipped: [] }; };
  await startExportInterp('p', { chapter: '第1章', rels: ['exports/a_11111111.mp4'] }, { run, gate, finalize: fin, deliver: async () => ({ status: 'skipped', reason: '未设置交付目录' }), prune });
  assert.deepEqual(pruned, ['exports/a_11111111.mp4']);
  await assert.rejects(startExportInterp('p', { chapter: '第1章', rels: ['exports/b_22222222.mp4'] }, { run, gate, finalize: fin, deliver: async () => ({ status: 'failed', error: 'x' }), prune }));
  assert.deepEqual(pruned, ['exports/a_11111111.mp4'], '交付失败不清');
});

test('网页导出 / agent 导出都接了清旧版；网页导出要插帧时留给插帧任务清', () => {
  const route = fs.readFileSync(new URL('../app/api/projects/[id]/export/route.js', import.meta.url), 'utf8');
  assert.match(route, /if \(chapter && !interpQueued && !\(delivery && delivery\.status === 'failed'\)\) pruned = pruneOlderChapterExports\(id, outRel\);/);
  const tools = fs.readFileSync(new URL('../lib/agent/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /if \(d\.status !== 'failed' && !fpsNotes\.some\(\(n\) => \/失败\|没跑成\/\.test\(String\(n\)\)\)\) \{\s*try \{ const pr = pruneOlderChapterExports\(ctx\.projectId, outRel\);/);
});
