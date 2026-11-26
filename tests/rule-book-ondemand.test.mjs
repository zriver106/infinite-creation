// 2026-11-25（Andy：规则用到才读；主会话 seq1821/1823）：心声 C 段按 os 条件读；画面说明 / sub_shots 里的心声也触发，否定写法不触发；
// 预算按「基础 + 本镜分卷」合计判 too_dense。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleIndex, requiredRanges, shotConditions } from '../lib/core/rule-book.js';

const P = { id: 'p' };
const os = (s) => shotConditions({ chapter: '第1章', idx: 1, camera: 'FIXED', dialogue: '', character_ids: [], ...s }, P, {}).has('os');

test('心声写在画面说明或 sub_shots 里也触发 os（V2 30#6 那种）', () => {
  assert.equal(os({ visual: '他低头看杯子，挑眉琢磨（心声后期配音，画面不发声）' }), true);
  assert.equal(os({ sub_shots: '0-3秒：江澈（OS）：这次……' }), true);
  assert.equal(os({ dialogue: '江澈（OS）：总算一百次了！' }), true);
});
test('「无台词无心声」「没有心声」不触发 os', () => {
  for (const v of ['（无台词无心声）0秒已在走廊内', '全镜无台词、无心声、无特效。', '本镜没有任何人说话、没有心声。']) assert.equal(os({ visual: v }), false, v);
  assert.equal(os({ visual: '江澈站在门口。' }), false);
});
test('规则书：C 心声是分卷（os 才读），合计口径判 too_dense', () => {
  const idx = loadRuleIndex('h3-prompt-writing');
  const C = idx.sections.find((s) => s.id === 'C');
  assert.equal(C.tier, 'volume'); assert.deepEqual(C.when, ['os']);
  assert.equal(idx.budget_mode, 'total'); assert.equal(idx.budget_chars, 84000);
  const plain = requiredRanges(idx, { chapter: '第1章', idx: 1, camera: 'FIXED', visual: '江澈站在门口。', dialogue: '' }, P, {});
  assert.ok(!plain.required_ranges.some((r) => r.id === 'C'), '没心声的镜不读 C');
  const withOs = requiredRanges(idx, { chapter: '第1章', idx: 1, camera: 'FIXED', visual: '他沉默', dialogue: '江澈（OS）：好家伙' }, P, {});
  assert.ok(withOs.required_ranges.some((r) => r.id === 'C'), '有心声的镜读 C');
  assert.equal(withOs.too_dense, withOs.required_chars > 84000);
});
