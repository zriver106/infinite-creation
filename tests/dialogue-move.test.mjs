// 跨镜挪台词（主会话 seq2130/seq2133）：纯函数 planDialogueMove 的单测，不碰数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planDialogueMove, splitSentences, parseLine, dialogueUnits } from '../lib/core/dialogue-move.js';

const L14 = '江澈（OS）：仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。爷爷要是看见，是先惊讶，还是先骂我乱吃东西？';
const ch = () => [
  { id: 's12', idx: 12, status: 'done', dialogue: '江澈：好。' },
  { id: 's13', idx: 13, status: 'done', dialogue: '' },
  { id: 's14', idx: 14, status: 'done', dialogue: L14 },
  { id: 's15', idx: 15, status: 'done', dialogue: '老人：回来吃饭。' },
];

test('切句与前缀', () => {
  assert.deepEqual(parseLine(L14).speaker, '江澈（OS）');
  assert.deepEqual(splitSentences('仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。爷爷要是看见，是先惊讶，还是先骂我乱吃东西？'), ['仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。', '爷爷要是看见，是先惊讶，还是先骂我乱吃东西？']);
  assert.deepEqual(splitSentences('这次……没上次那么难熬了。'), ['这次……', '没上次那么难熬了。']);
  assert.equal(dialogueUnits('A：一。二！\n\nB：三').length, 3);
});

test('24#14 第一句心声挪到 24#13：原句不改、放在 13 末尾、14 留第二句、整章不变', () => {
  const p = planDialogueMove(ch(), [{ from: 's14', to: 's13', text: '仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。' }]);
  assert.equal(p.ok, true, p.errors.join());
  assert.equal(p.updates.s13.after, '江澈（OS）：仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。');
  assert.equal(p.updates.s14.after, '江澈（OS）：爷爷要是看见，是先惊讶，还是先骂我乱吃东西？');
  assert.deepEqual(p.touched.sort(), ['s13', 's14']);
  assert.equal(p.moved[0].position, 'end');
  assert.ok(!p.updates.s12 && !p.updates.s15, '没点名的镜不动');
});

test('挪到后一镜缺省放开头；整行挪走后原镜该行删掉', () => {
  const p = planDialogueMove(ch(), [{ from: 's12', to: 's13', text: '好。' }]);
  assert.equal(p.ok, true); assert.equal(p.updates.s12.after, ''); assert.equal(p.updates.s13.after, '江澈：好。'); assert.equal(p.moved[0].position, 'start');
  const q = planDialogueMove(ch(), [{ from: 's15', to: 's14', text: '回来吃饭。', position: 'start' }]);
  assert.equal(q.updates.s14.after, '老人：回来吃饭。\n' + L14);
});

test('拒绝：改了字 / 半句 / 不相邻 / 同一镜 / 不是本章 / 在生成', () => {
  const bad = (moves, re, shots = ch()) => { const p = planDialogueMove(shots, moves); assert.equal(p.ok, false); assert.match(p.errors.join(), re); assert.deepEqual(p.updates, {}); };
  bad([{ from: 's14', to: 's13', text: '仙丹真吃到了，竹匾里的药，我有一半认不出来了。' }], /找不到这句原文/);
  bad([{ from: 's14', to: 's13', text: '仙丹真吃到了，' }], /找不到这句原文/);
  bad([{ from: 's14', to: 's12', text: '仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。' }], /相邻/);
  bad([{ from: 's14', to: 's14', text: 'x' }], /同一镜/);
  bad([{ from: 's14', to: 'zz', text: 'x' }], /不是本章/);
  const gen = ch(); gen[1].status = 'generating';
  bad([{ from: 's14', to: 's13', text: '仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。' }], /正在生成/, gen);
  bad([], /非空数组/);
});

test('相邻按未作废的镜算：中间隔着作废镜也算相邻', () => {
  const s = ch(); s.splice(2, 0, { id: 'sx', idx: 13.5, status: 'obsolete', dialogue: '' });
  const p = planDialogueMove(s, [{ from: 's14', to: 's13', text: '爷爷要是看见，是先惊讶，还是先骂我乱吃东西？' }]);
  assert.equal(p.ok, true, p.errors.join());
});

test('两句连挪（整句串）也认', () => {
  const p = planDialogueMove(ch(), [{ from: 's14', to: 's13', text: L14.slice('江澈（OS）：'.length) }]);
  assert.equal(p.ok, true); assert.equal(p.updates.s14.after, ''); assert.equal(p.updates.s13.after, L14);
});
