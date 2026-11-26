// 台词进 <d>：数字两种写法视为一致（主会话 seq2152；手册 M03 第3条；R-003 第0条用途表）。纯函数单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cnStandard, cnValueReadings, parseCnValue, includesNumberAware } from '../lib/core/number-reading.js';
import { checkDialogueInD } from '../lib/core/dialogue-d-gate.js';

const D = (...xs) => xs.map((x) => '<d>' + x + '</d>').join(' ');
const codes = (r) => r.errors.map((e) => e.code);

test('标准读法与省略说法', () => {
  assert.equal(cnStandard(3200), '三千二百'); assert.equal(cnStandard(13800), '一万三千八百'); assert.equal(cnStandard(17000), '一万七千');
  assert.equal(cnStandard(1301), '一千三百零一'); assert.equal(cnStandard(15), '十五'); assert.equal(cnStandard(10500), '一万零五百'); assert.equal(cnStandard(110000), '十一万');
  assert.deepEqual(cnValueReadings(3200).sort(), ['三千二', '三千二百'].sort());
  assert.ok(cnValueReadings(150).includes('一百五'));
  for (const [s, v] of [['三千二', 3200], ['一万三千八', 13800], ['一万七', 17000], ['一千三百零一', 1301], ['十五', 15], ['两万', 20000], ['一百五', 150]]) assert.equal(parseCnValue(s), v, s);
});

test('价格：28#1 原句 dialogue 阿拉伯数字、<d> 汉字读法 → 通过', () => {
  const r = checkDialogueInD('江澈：鞋子3200，衣服13800，一共17000。', D('鞋子三千二，衣服一万三千八，一共一万七。'));
  assert.deepEqual(codes(r), []); assert.equal(r.warnings.filter((w) => /对不上/.test(w.msg)).length, 0);
  assert.deepEqual(codes(checkDialogueInD('江澈：鞋子3200，衣服13800，一共17000。', D('鞋子三千二百，衣服一万三千八百，一共一万七千。'))), []);
  assert.deepEqual(codes(checkDialogueInD('江澈：两千块。', D('2000块。'))), [], '反方向：dialogue 汉字、<d> 阿拉伯');
  assert.deepEqual(codes(checkDialogueInD('店员：这双2000块。', D('这双两千块。'))), [], '百千万前的 2 读「两」');
});

test('价格：数值不同 / 读成别的数 → 照拦', () => {
  assert.deepEqual(codes(checkDialogueInD('江澈：鞋子3200。', D('鞋子三两百。'))), ['DIALOGUE_NOT_IN_D'], 'E-012 的错读');
  assert.deepEqual(codes(checkDialogueInD('江澈：鞋子3200。', D('鞋子三千。'))), ['DIALOGUE_NOT_IN_D']);
  assert.deepEqual(codes(checkDialogueInD('江澈：鞋子3200块。', D('鞋子三二零零块。'))), ['DIALOGUE_NOT_IN_D'], '有量词的价格不认逐位念');
});

test('号码：逐位念能对上；读成数值（一千三百零一）不放过', () => {
  assert.deepEqual(codes(checkDialogueInD('前台：您的房间是1301室。', D('您的房间是一三零一室。'))), []);
  assert.deepEqual(codes(checkDialogueInD('前台：您的房间是1301室。', D('您的房间是幺三零幺室。'))), []);
  assert.deepEqual(codes(checkDialogueInD('前台：您的房间是1301室。', D('您的房间是一千三百零一室。'))), ['DIALOGUE_NOT_IN_D']);
  assert.deepEqual(codes(checkDialogueInD('林：手机尾号0817。', D('手机尾号零八幺七。'))), []);
  assert.deepEqual(codes(checkDialogueInD('林：手机尾号0817。', D('手机尾号八百一十七。'))), ['DIALOGUE_NOT_IN_D']);
  assert.deepEqual(codes(checkDialogueInD('林：电话13912345678。', D('电话幺三九幺二三四五六七八。'))), []);
});

test('年份逐位念；小数、百分数按数值', () => {
  assert.deepEqual(codes(checkDialogueInD('老人：2026年。', D('二零二六年。'))), []);
  assert.deepEqual(codes(checkDialogueInD('老人：2026年。', D('两千零二十六年。'))), ['DIALOGUE_NOT_IN_D']);
  assert.deepEqual(codes(checkDialogueInD('系统面板：涨了3.5倍。', D('涨了三点五倍。'))), []);
  assert.deepEqual(codes(checkDialogueInD('江澈：跌了50%。', D('跌了百分之五十。'))), []);
});

test('没有数字的句子照旧逐字比对', () => {
  assert.deepEqual(codes(checkDialogueInD('江澈：我回来了。', D('我回来了。'))), []);
  assert.deepEqual(codes(checkDialogueInD('江澈：我回来了。', D('我又回来了。'))), ['DIALOGUE_NOT_IN_D']);
  assert.equal(includesNumberAware('abc', 'abd'), false);
});
