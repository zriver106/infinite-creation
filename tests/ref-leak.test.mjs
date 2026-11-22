import test from 'node:test';
import assert from 'node:assert/strict';
import { findLeakRuns, speechIn, studioScore, shotRefImagePaths } from '../lib/core/ref-leak.js';

const F = (arr) => arr.map(([refSim, studio, diffNext], i) => ({ i, refSim, studio, diffNext }));
const clean = (n) => Array.from({ length: n }, () => [0.05, 0.05, 1]);

test('开头 8 帧参考板 + 硬切 → 裁 0..8', () => {
  const f = F([...Array.from({ length: 7 }, () => [1, 0.85, 0]), [1, 0.85, 63], ...clean(100)]);
  const r = findLeakRuns(f, 24);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].side, r[0].start, r[0].end, !!r[0].suspect], ['head', 0, 8, false]);
});

test('结尾 12 帧参考板 + 硬切 → 裁尾', () => {
  const f = F([...clean(100), ...Array.from({ length: 12 }, () => [1, 0.59, 0])]);
  f[99].diffNext = 93;
  const r = findLeakRuns(f, 24);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].side, r[0].start, r[0].end], ['tail', 100, 112]);
});

test('像棚拍但没有硬切 → 只标复核，不裁', () => {
  const f = F([[0.1, 0.6, 2], [0.1, 0.6, 2], ...clean(60)]);
  const r = findLeakRuns(f, 24);
  assert.equal(r[0].suspect, true);
});

test('超过 1.5 秒都像棚拍 → 只标复核', () => {
  const f = F([...Array.from({ length: 40 }, () => [1, 0.8, 0]), ...clean(60)]);
  f[39].diffNext = 60;
  const r = findLeakRuns(f, 24);
  assert.equal(r[0].suspect, true);
});

test('正常镜头不报', () => {
  assert.deepEqual(findLeakRuns(F(clean(120)), 24), []);
});

test('人声判定：有声不裁，静音可裁', () => {
  const db = Array.from({ length: 300 }, (_, i) => (i < 25 ? -70 : -15));
  const env = { winSec: 0.02, db, p90: -15 };
  assert.equal(speechIn(env, 0, 0.4).speech, false);
  assert.equal(speechIn(env, 0, 0.6).speech, true);
  assert.equal(speechIn(null, 0, 0.4).speech, true); // 音轨读不出 → 保守按有声
});

test('studioScore：纯灰底高分，彩色纹理低分', () => {
  const W = 64, H = 36;
  const gray = Buffer.alloc(W * H * 3, 180);
  assert.ok(studioScore(gray, W, H) > 0.9);
  const noisy = Buffer.alloc(W * H * 3);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 97) % 256;
  assert.ok(studioScore(noisy, W, H) < 0.1);
});

test('参考图优先级：服装 > 年龄 > 人物；场景不参与', () => {
  const assets = [
    { id: 'c1', category: 'character', image_path: 'a/c1.png' },
    { id: 'co1', category: 'costume', parent_id: 'c1', image_path: 'a/co1.png' },
    { id: 'c2', category: 'character', image_path: 'a/c2.png' },
    { id: 'ag2', category: 'age', parent_id: 'c2', image_path: 'a/ag2.png' },
    { id: 's1', category: 'scene', image_path: 'a/s1.png' },
    { id: 'p1', category: 'prop', image_path: 'a/p1.png' },
  ];
  const shot = { character_ids: ['c1', 'c2'], costume_ids: ['co1'], age_ids: ['ag2'], scene_ids: ['s1'], prop_ids: ['p1'] };
  assert.deepEqual(shotRefImagePaths(shot, assets, (r) => '/p/' + r), ['/p/a/co1.png', '/p/a/ag2.png', '/p/a/p1.png']);
});
