// 2026-11-25（主会话 seq1589）：「挥拳起哄」不再触发 motion（H1 运镜与动作卷）；真打戏照样触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shotConditions } from '../lib/core/rule-book.js';

const P = { id: 'p' };
const motion = (visual, camera = 'FIXED｜STATIC 全程同一景别') => shotConditions({ chapter: '第1章', idx: 1, camera, visual, dialogue: '', character_ids: [] }, P, {}).has('motion');

test('「挥拳起哄」不触发 motion', () => {
  assert.equal(motion('起哄同学挥拳起哄，喊「周老师威武！」'), false);
});
test('真打戏照样触发 motion：打斗、出拳、扇、踹', () => {
  for (const v of ['两人在巷口打斗', '他猛地出拳', '她扇了他一巴掌', '一脚踹开门']) assert.equal(motion(v), true, v);
});
test('运镜写在 camera 里照样触发', () => {
  assert.equal(motion('他坐着说话', '缓慢推近'), true);
});
