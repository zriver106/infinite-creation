// 2026-11-25 H2 拆卷：H2C（表现通用，每个【表现】镜都读）、H2（Q 版、特效）、H2L（流行语、段子、谐音），按标记类型加载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleIndex, requiredRanges, shotConditions } from '../lib/core/rule-book.js';

const idx = loadRuleIndex('h3-prompt-writing');
const ON = { switches: { enable_chibi: true, enable_vfx: true, enable_slang: true, enable_jokes: true } };
const P = { id: 'p' };
const ids = (s) => requiredRanges(idx, { chapter: '第1章', idx: 1, camera: 'FIXED', dialogue: '', character_ids: [], ...s }, P, ON).required_ranges.map((x) => x.id);

test('只有流行语标记：读 H2C + H2L，不读 H2', () => {
  const r = ids({ visual: '【表现】L3｜流行语：「好家伙」。他压低声音。' });
  assert.ok(r.includes('H2C') && r.includes('H2L')); assert.ok(!r.includes('H2'));
});
test('只有 Q 版标记：读 H2C + H2，不读 H2L', () => {
  const r = ids({ visual: '【表现】P4｜Q版·方式一（身旁小人）｜1.0–3.0s' });
  assert.ok(r.includes('H2C') && r.includes('H2')); assert.ok(!r.includes('H2L'));
});
test('两种都有：三卷都读', () => {
  const r = ids({ visual: '【表现】特效·G07 金光闪耀\n【表现】流行语：「好家伙」' });
  assert.ok(r.includes('H2C') && r.includes('H2') && r.includes('H2L'));
});
test('只有编号（L·P3）加段子：只按段子读 H2L', () => {
  const r = ids({ visual: '【表现】L·P3 他接梗：段子一句' });
  assert.ok(r.includes('H2L')); assert.ok(!r.includes('H2'));
});
test('分不出类型的描述性标记：只读 H2（与拆卷前一致）', () => {
  const c = shotConditions({ visual: '【表现】额角滑下一颗大汗' }, P, ON);
  assert.ok(c.has('expression_qv')); assert.ok(!c.has('expression_slang'));
});
test('表现开关全关：三卷都不读', () => {
  const r = requiredRanges(idx, { chapter: '第1章', idx: 1, camera: 'FIXED', visual: '【表现】流行语', character_ids: [] }, P, { switches: {} }).required_ranges.map((x) => x.id);
  assert.ok(!r.includes('H2C') && !r.includes('H2') && !r.includes('H2L'));
});
