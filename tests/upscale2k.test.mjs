// ic31 升级2K：纯逻辑单测（不起服务、不调火山、不跑 ffmpeg）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up2k-'));
process.env.IC_DATA_DIR = tmp;
const m = await import('../lib/core/upscale2k.js');

test('2K 判定按短边：1440 起为 2K，2160 起为 4K，竖屏同理', () => {
  assert.equal(m.resolutionTier(854, 480), '');
  assert.equal(m.resolutionTier(1920, 1080), '');
  assert.equal(m.resolutionTier(2594, 1440), '2K');
  assert.equal(m.resolutionTier(1440, 2560), '2K');
  assert.equal(m.resolutionTier(3840, 2160), '4K');
  assert.equal(m.resolutionTier(0, 0), '');
});

test('设置：保存 Key 后公开设置只给 configured，不含 Key；本地暂未开放', () => {
  const KEY = 'unit-test-key-abcdef123';
  const pub = m.saveUpscaleSettings({ provider: 'volc', volc: { apiKey: KEY } });
  assert.equal(pub.volc.configured, true);
  assert.ok(!JSON.stringify(pub).includes(KEY));
  assert.ok(!JSON.stringify(m.publicUpscaleSettings()).includes(KEY));
  assert.equal(m.readUpscaleSettings().volc.apiKey, KEY);
  assert.throws(() => m.saveUpscaleSettings({ provider: 'local' }), /暂未开放/);
  // 留空不覆盖
  m.saveUpscaleSettings({ volc: { apiKey: '' } });
  assert.equal(m.readUpscaleSettings().volc.apiKey, KEY);
  // 打码：key、Bearer、签名 URL
  const red = m.redactSecrets('Authorization: Bearer ' + KEY + ' url https://x.volcvideo.com/a.mp4?auth_key=SECRET ' + KEY);
  assert.ok(!red.includes(KEY) && !red.includes('SECRET'));
  m.saveUpscaleSettings({ volc: { clearKey: true } });
  assert.equal(m.publicUpscaleSettings().volc.configured, false);
});

test('新旧片关系：rootOf / selectedOf 回退规则', () => {
  const v = { files: { 'a_2k.mp4': { upscaled_from: 'a.mp4' } }, selected: {} };
  assert.equal(m.rootOf(v, 'a_2k.mp4'), 'a.mp4');
  assert.equal(m.rootOf(v, 'a.mp4'), 'a.mp4');
  assert.equal(m.selectedOf(v, 'a.mp4', new Set(['a.mp4', 'a_2k.mp4'])), 'a.mp4');
  v.selected['a.mp4'] = 'a_2k.mp4';
  assert.equal(m.selectedOf(v, 'a.mp4', new Set(['a.mp4', 'a_2k.mp4'])), 'a_2k.mp4');
  // 选用的 2K 被删 → 回退原片
  assert.equal(m.selectedOf(v, 'a.mp4', new Set(['a.mp4'])), 'a.mp4');
  assert.equal(m.chapterTitleFromExportName('项目_第12章_abcd1234_2k.mp4'), '第12章');
  assert.equal(m.chapterTitleFromExportName('项目_试验.mp4'), '');
});
