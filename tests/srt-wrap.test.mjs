// 11-28 跟进2 报：19 字字幕被 libass 自动折行，逗号落到第二行行首。烧录前自己在标点后断行，WrapStyle=2 关掉自动折行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { textUnits, maxUnitsPerLine, wrapLine, wrapSrtForBurn } from '../lib/core/srt-wrap.js';

const NO_START = /^[，、；：。！？…—,;:!?）」』”’)\]》]/;

test('一行宽度：1280×720 字号 36 约 17 个全角字（实测每字约 68px）；半角算半个', () => {
  assert.equal(maxUnitsPerLine(1280, 720, 36), 17);
  assert.ok(textUnits('车前几天被暴雨冲走了，幸好——车贷还在。') > 17, '跟进2 报的那条要折');
  assert.ok(textUnits('许曼宁，他从大学谈到现在的女朋友。') <= 17, '17 字的放得下一行');
  assert.equal(textUnits('我cy'), 2);
});

test('断在标点后，逗号和破折号留在上一行末尾，行首不出标点', () => {
  assert.deepEqual(wrapLine('车前几天被暴雨冲走了，幸好——车贷还在。', 12), ['车前几天被暴雨冲走了，', '幸好——车贷还在。']);
  for (const s of ['许曼宁，他从大学谈到现在的女朋友。', '我cy，这也太离谱了吧，一二三四五六七八九十一二三', '一二三四五六七八九十一，二三四五', '好好好好好好好好好好好好，，，']) {
    const lines = wrapLine(s, 12);
    assert.equal(lines.join(''), s, '只断行不改字');
    for (const l of lines) { assert.ok(textUnits(l) <= 12, l); }
    for (const l of lines.slice(1)) assert.ok(!NO_START.test(l), '行首是标点：' + l);
  }
  assert.equal(wrapLine('许曼宁，他从大学谈到现在的女朋友。', 12).length, 2, '能两行放下就不为了标点折三行');
  assert.deepEqual(wrapLine('你好', 12), ['你好']);
});

test('SRT 全文：只断正文，序号和时间轴不动', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,000\n你好\n\n2\n00:00:02,000 --> 00:00:05,000\n车前几天被暴雨冲走了，幸好——车贷还在。\n';
  const w = wrapSrtForBurn(srt, 12);
  assert.match(w, /2\n00:00:02,000 --> 00:00:05,000\n车前几天被暴雨冲走了，\n幸好——车贷还在。/);
  assert.match(w, /^1\n00:00:00,000 --> 00:00:02,000\n你好\n\n/);
});

test('烧录滤镜带 WrapStyle=2，写入的是断过行的 SRT', () => {
  const src = fs.readFileSync(new URL('../lib/core/ffmpeg.js', import.meta.url), 'utf8');
  assert.match(src, /WrapStyle=2/);
  assert.match(src, /wrapSrtForBurn\(subtitleText, maxUnitsPerLine\(tw, th, fontSize\)\)/);
});
