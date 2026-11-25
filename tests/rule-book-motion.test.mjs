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

// 2026-11-25（主会话 seq1593）：否定说法、说明「别镜已用过」的，不触发 Q 版/特效（H2）。
const ON = { switches: { enable_chibi: true, enable_vfx: true, enable_slang: true, enable_jokes: true } };
const qv = (visual) => shotConditions({ chapter: '第1章', idx: 1, camera: 'FIXED', visual, dialogue: '', character_ids: [] }, P, ON).has('expression_qv');
test('「不加特效」「不要特效」「无特效」不触发 H2', () => {
  for (const v of ['【表现】L4｜流行语｜「好家伙」冷面演法，不加特效', '【表现】L3｜流行语｜有点东西，不要特效', '【表现】L2｜谐音｜无特效']) assert.equal(qv(v), false, v);
});
test('「金光眼本章已用在镜12」不触发 H2（2#26）', () => {
  assert.equal(qv('【表现】L4｜流行语｜「好家伙」冷面演法，不加特效\n（P7 到账：选真实表演+流行语——金光眼本章已用在镜12）'), false);
});
test('真用了照样触发 H2：特效·A01、Q版小人、本镜金光眼', () => {
  for (const v of ['【表现】P7｜特效·A01 青筋暴起', '【表现】P5｜Q版·方式一（身旁小人）', '江澈双眼亮起金光眼，0.5–1.5s']) assert.equal(qv(v), true, v);
});
