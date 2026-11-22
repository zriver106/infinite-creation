import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planVideoRefCrop, toVideoReferenceImage, videoRefCropFor, videoRefKind, sha256File, VIDEOREF_DIR } from '../lib/core/videoref-crop.js';

// 用 ffmpeg 画合成参考图（不依赖真实素材）：纯色棚拍背景 + 肤色头 + 深色身体。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vrcrop-'));
const SKIN = '0xdcb496', NAVY = '0x1e2a44';
function draw(name, w, h, bg, boxes) {
  const f = path.join(TMP, name);
  const vf = boxes.map(([x, y, bw, bh, c]) => `drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:color=${c}:t=fill`).join(',');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${bg}:s=${w}x${h}`, '-frames:v', '1', ...(vf ? ['-vf', vf] : []), f]);
  assert.equal(r.status, 0, String(r.stderr));
  return f;
}
const person = (x, y, s = 1) => [[x + 30 * s, y, 60 * s, 70 * s, SKIN], [x, y + 70 * s, 120 * s, 650 * s, NAVY]];

test('单人棚拍全身 → 裁成头到腰，不含脚', async () => {
  const f = draw('single.png', 600, 900, '0x9a9a9a', person(240, 100));
  const p = await planVideoRefCrop(f, 'char');
  assert.ok(p.crop, JSON.stringify(p));
  assert.equal(p.layout, '单人棚拍');
  assert.ok(p.crop.y <= 100 && p.crop.y + p.crop.h < 600, JSON.stringify(p.crop));
  assert.ok(p.crop.x >= 150 && p.crop.x + p.crop.w <= 450, JSON.stringify(p.crop));
});

test('左特写 + 右三视图 → 只取左侧特写', async () => {
  const views = [650, 850, 1050].flatMap((x) => [[x + 20, 40, 50, 60, SKIN], [x, 100, 90, 620, NAVY]]);
  const f = draw('t3.png', 1344, 768, '0xf2f2f2', [[120, 60, 300, 360, SKIN], [40, 420, 460, 348, NAVY], ...views]);
  const p = await planVideoRefCrop(f, 'char');
  assert.ok(p.crop, JSON.stringify(p));
  assert.match(p.layout, /左特写/);
  assert.ok(p.crop.x < 60 && p.crop.x + p.crop.w < 1344 * 0.45, JSON.stringify(p.crop));
});

test('道具：白底多角度板裁一块，单件实物图不裁', async () => {
  const gold = '0xd4a017';
  const board = draw('propboard.png', 1200, 600, 'white', [[100, 200, 200, 220, gold], [500, 200, 200, 220, gold], [900, 200, 200, 220, gold]]);
  const p = await planVideoRefCrop(board, 'prop');
  assert.ok(p.crop && p.crop.w < 400, JSON.stringify(p));
  const single = draw('propone.png', 1200, 600, 'white', [[400, 150, 400, 300, gold]]);
  assert.equal((await planVideoRefCrop(single, 'prop')).crop, null);
});

test('实景/复杂背景 → 不裁', async () => {
  const f = path.join(TMP, 'scene.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=800x600', '-frames:v', '1', f]);
  const p = await planVideoRefCrop(f, 'char');
  assert.equal(p.crop, null);
});

test('落盘：原图不动、记源图 sha 与裁切框、命中缓存、给 ref-leak 找得到裁切图', async () => {
  const proj = fs.mkdtempSync(path.join(TMP, 'proj-'));
  const src = draw('single2.png', 600, 900, '0x9a9a9a', person(240, 100));
  const before = sha256File(src);
  const logs = [];
  const asset = { id: 'abcdef1234567890', name: '测试人物', category: 'character' };
  const r1 = await toVideoReferenceImage({ projectDirAbs: proj, asset, abs: src, kind: 'char', log: (lv, m) => logs.push(lv + ' ' + m) });
  assert.ok(r1 && fs.existsSync(r1.path) && !r1.cached);
  assert.equal(sha256File(src), before, '原图被改了');
  assert.ok(r1.path.startsWith(path.join(proj, VIDEOREF_DIR)));
  const rec = JSON.parse(fs.readFileSync(r1.path.replace(/\.png$/, '.json'), 'utf8'));
  assert.equal(rec.src_sha256, before);
  assert.ok(rec.crop && rec.crop.w > 0 && rec.out_sha256);
  assert.ok(logs.some((l) => l.startsWith('info') && l.includes('已裁切')));
  const r2 = await toVideoReferenceImage({ projectDirAbs: proj, asset, abs: src, kind: 'char' });
  assert.ok(r2.cached && r2.path === r1.path);
  assert.equal(videoRefCropFor(proj, src), r1.path);
});

test('拿不准 / 出错 → 返回 null（用原图）并记 warn', async () => {
  const proj = fs.mkdtempSync(path.join(TMP, 'proj-'));
  const blank = draw('blank.png', 600, 900, '0x9a9a9a', []);
  const logs = [];
  const r = await toVideoReferenceImage({ projectDirAbs: proj, asset: { id: 'blank0001' }, abs: blank, kind: 'char', log: (lv, m) => logs.push(lv + ' ' + m) });
  assert.equal(r, null);
  assert.ok(logs.some((l) => l.startsWith('warn')), logs.join('\n'));
  const bad = path.join(TMP, 'notanimage.png'); fs.writeFileSync(bad, 'xx');
  const logs2 = [];
  assert.equal(await toVideoReferenceImage({ projectDirAbs: proj, asset: { id: 'bad00001' }, abs: bad, log: (lv, m) => logs2.push(lv) }), null);
  assert.deepEqual(logs2, ['warn']);
  assert.equal(videoRefCropFor(proj, blank), '');
});

test('资产类型 → 裁切类型', () => {
  assert.equal(videoRefKind({ category: 'character' }), 'char');
  assert.equal(videoRefKind({ category: 'age' }), 'char');
  assert.equal(videoRefKind({ category: 'costume' }), 'costume');
  assert.equal(videoRefKind({ category: 'prop', name: '金砖' }), 'prop');
  assert.equal(videoRefKind({ category: 'prop', name: '江澈·Q版设定' }), 'char');
});
