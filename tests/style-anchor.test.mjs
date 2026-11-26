// 「写实偏动漫3D」风格（Andy 11-26）：预设在基础风格组；英文锚点进兜底出图 / 视频提示词和写稿 brief；没锚点的风格照旧只写中文名。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../lib/shared/index.js');
const P = await import('../lib/core/prompts.js');
const ANCHOR = 'semi-realistic 3D animated, Chinese 3D donghua look, realistic proportions and materials';

test('预设在「基础风格」组，进 STYLE_PRESETS / STYLE_OPTIONS', () => {
  assert.ok(S.STYLE_GROUPS.find((g) => g.label === '基础风格').styles.includes('写实偏动漫3D'));
  assert.ok(S.STYLE_PRESETS.includes('写实偏动漫3D')); assert.ok(S.STYLE_OPTIONS.includes('写实偏动漫3D'));
});

test('英文锚点：预设名和含预设名的自定义风格都认；其他风格不加', () => {
  assert.equal(S.styleAnchor('写实偏动漫3D'), ANCHOR);
  assert.equal(S.styleAnchor('写实偏动漫3D，偏暖'), ANCHOR);
  assert.equal(S.styleAnchor('动漫'), ''); assert.equal(S.styleAnchor(''), '');
  assert.equal(S.styleWithAnchor('动漫'), '动漫');
  assert.equal(S.styleWithAnchor('写实偏动漫3D'), '写实偏动漫3D（' + ANCHOR + '）');
});

test('兜底视频 / 出图提示词带锚点；别的风格原样', () => {
  assert.match(P.fallbackVideoPrompt({ references: [], style: '写实偏动漫3D', visual: 'v' }), new RegExp('画面风格：写实偏动漫3D（semi-realistic 3D animated'));
  assert.match(P.fallbackVideoPrompt({ references: [], style: '动漫', visual: 'v' }), /画面风格：动漫(?!（)/);
  const a = P.fallbackAssetPrompt({ type: 'character', name: '江澈', description: 'd', style: '写实偏动漫3D' });
  assert.ok(JSON.stringify(a).includes('Chinese 3D donghua look'));
});
