// 切章只认独占一行的「第N章 + 标题」（Andy 11-26「V3 原著导入又切错了」；PG-20261123-023 报告里原著 13 章正文句首「第X回，」被当成章头）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNovelIntoChapters } from '../lib/shared/index.js';

// 原著 V03 里真实出现的正文句首（行首是「第X回」却不是章头）
const BODY_LINES = [
  '第三回，舅舅看过来：“你刚才没吃？”',
  '第二回，小剑悬得更稳。',
  '第三回，脚下绊了自己一下。',
  '第三回续药，江澈回来时，桌上总算讲到了正题。',
  '第一回，韩东总算伸手碰到了肩毛。',
  '第二回，自己又坐在了原来的垫子中央。',
  '第二回，他慢了下来。',
  '第一回，气往地下走，石壁轻轻响了。',
  '第二回，他把回路提到地表，散出的气沿着裂缝走。',
  '第二回，大黄撑了五次才出圈。第三回它只撑了三次。',
  '第一回，玉里没有回应。',
  '第二回，她把寒意收得更细，掌心慢慢结出薄霜。',
  '第一回剑落得很偏，第二回擦着木桩过去。',
  '第一回，她的气乱得几乎接不上。',
];

test('正文句首「第X回，…」不切章：三章原文切出来还是三章，句子留在正文里', () => {
  const novel = ['第1章　暂未检测到可交易物品', '开头。', BODY_LINES[0], '结尾。',
    '第2章　好家伙，这也行？', BODY_LINES[1], '中间。', ...BODY_LINES.slice(2, 8),
    '第3章　收尾', '开头。', ...BODY_LINES.slice(8)].join('\n');
  const out = splitNovelIntoChapters(novel);
  assert.deepEqual(out.map((c) => c.title), ['第1章', '第2章', '第3章']);
  assert.ok(out[1].novel.startsWith('第二回，小剑悬得更稳。'), '章首那句不丢（原第 158 章）');
  for (const l of BODY_LINES) assert.ok(out.some((c) => c.novel.includes(l)), '正文保留：' + l);
});

test('真章头的几种写法照旧认：全角空格、半角空格、冒号、无标题、直接接短标题、标题带标点', () => {
  const novel = '第一章 初入江湖\na\n第二章：风起\nb\n第三章\nc\n第四章开端\nd\n第5章　好家伙，这也行？\ne\nChapter 6\nf';
  assert.deepEqual(splitNovelIntoChapters(novel).map((c) => c.title), ['第一章', '第二章', '第三章', '第四章', '第5章', 'Chapter 6']);
});
