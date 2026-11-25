// 续轮16（总导 04:54）：H2（Q 版、特效、流行语与谐音）按本镜加载。用在用规则索引 + 生产库只读快照导出的真实分镜（fixtures/r16_expression_shots.json）。
// 纯函数测试，不碰库、不连服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuleIndex, requiredRanges, shotConditions, expressionMarkers } from '../lib/core/rule-book.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'r16_expression_shots.json'), 'utf8'));
const idx = loadRuleIndex('h3-prompt-writing');
const ON = { switches: { enable_chibi: true, enable_vfx: true, enable_slang: true, enable_jokes: true } };
const OFF = { switches: { enable_chibi: false, enable_vfx: false, enable_slang: false, enable_jokes: false } };
const P = { id: 'p' };
const ids = (rr) => rr.required_ranges.map((r) => r.id);

test('① 7#5、#11、#14：本镜没有表现手段 → 不加载 H2，分册 ≤ 40,000，不再 too_dense', () => {
  assert.ok(idx, '要有 h3-prompt-writing 规则索引');
  for (const s of FX.too_dense_7) {
    assert.deepEqual(expressionMarkers(s), [], s.chapter + '#' + s.idx + ' 不应有标记');
    const rr = requiredRanges(idx, s, P, ON);
    assert.ok(!['H2', 'H2L', 'H2C'].some((x) => ids(rr).includes(x)), s.chapter + '#' + s.idx + ' 不应加载 H2/H2L/H2C');
    assert.ok(rr.volume_chars <= (idx.budget_chars || 40000), s.chapter + '#' + s.idx + ' 分册 ' + rr.volume_chars);
    assert.equal(rr.too_dense, false);
  }
});

test('② 第1–5集用了 Q版/特效/谐音/流行语/段子 的镜照样加载 H2', () => {
  const kinds = Object.keys(FX.expression_ep1_5);
  assert.deepEqual(kinds.sort(), ['Q版', '流行语', '特效', '段子', '谐音'].sort());
  for (const [k, s] of Object.entries(FX.expression_ep1_5)) {
    assert.ok(expressionMarkers(s).length, k + ' 镜要有标记');
    { const r = ids(requiredRanges(idx, s, P, ON)); assert.ok(r.includes('H2') || r.includes('H2L'), k + '（' + s.chapter + '#' + s.idx + '）要加载 H2 或 H2L（2026-11-25 拆卷）'); }
  }
});

test('③ 否定写法（不用Q版、不加特效、无特效）不算；项目开关全关不加载', () => {
  for (const s of FX.negated) {
    assert.deepEqual(expressionMarkers(s), [], s.chapter + '#' + s.idx + ' 否定写法不算');
    assert.ok(!shotConditions(s, P, ON).has('expression'));
  }
  const q = { visual: '【表现】P4｜Q版·方式一（身旁小人）｜1.0–3.0s｜江澈身旁弹出Q版小人' };
  assert.ok(shotConditions(q, P, ON).has('expression'));
  assert.ok(!shotConditions(q, P, OFF).has('expression'), '开关全关不加载');
  assert.ok(!shotConditions(q, null, ON).has('expression'), '没有项目不加载（新口径；旧口径在没有项目时仍按本镜关键词加载，现有调用方都传项目，见报告）');
});

test('③ 标记表：【表现】行类型、正文关键词、同小句否定、表演行不算', () => {
  const m = (t, f = 'visual') => expressionMarkers({ [f]: t });
  assert.ok(m('【表现】P3｜特效·G01 金光眼｜0.0–1.8s').some((x) => x.startsWith('visual:【表现】特效')));
  assert.ok(m('【表现】L1｜谐音｜配音替换：「我cy！」读作「我去！」').includes('visual:【表现】谐音'));
  assert.ok(m('【表现】额角滑下一颗夸张的大汗珠').length, '不带编号、直接写效果的【表现】行也算');
  assert.ok(m('【表现】段子·原著自带：冷面演').length);
  assert.deepEqual(m('【表现】真人表演：眼眶发红'), []);
  assert.ok(m('不知不觉Q版小人跳出').length, '单字「不」不算否定');
  assert.ok(m('ＱＱ版小人在肩头蹦').length || m('Ｑ版小人').length, '全角 Ｑ 按半角算');
  assert.deepEqual(m('without any chibi or VFX', 'camera'), []);
  assert.ok(m('【表现】L3｜流行语｜有点东西').includes('visual:【表现】流行语'));
  assert.ok(m('【表现】L4｜段子·原著自带｜冷面演').some((x) => x.startsWith('visual:【表现】段子')));
  assert.deepEqual(m('【表现】P3｜表演｜真人懊恼：手按额头'), []);
  assert.deepEqual(m('【表现】P3｜表演｜真人懊恼：手按额头，不用Q版、不加特效'), []);
  assert.deepEqual(m('严肃段，只用真实表演，无Q版无特效。'), []);
  assert.deepEqual(m('不切近景，特效直接在前景出'), ['visual:特效'], '逗号隔开的否定不管后面的标记');
  assert.ok(m('chibi insert at 2s', 'sub_shots').length);
  assert.ok(m('VFX: golden eyes', 'camera').length);
  assert.deepEqual(m('no chibi, no VFX', 'camera'), []);
});

test('复查1 第1条回归：不带编号的【表现】行、「段子·」开头的【表现】行、L 编号行 → 加载 H2', () => {
  assert.equal(FX.review1_missed.length, 8);
  for (const s of FX.review1_missed) {
    assert.ok(expressionMarkers(s).length, s.project + ' ' + s.chapter + '#' + s.idx + ' 要有标记');
    { const r = ids(requiredRanges(idx, s, P, ON)); assert.ok(r.includes('H2') || r.includes('H2L'), s.project + ' ' + s.chapter + '#' + s.idx + ' 要加载 H2 或 H2L（2026-11-25 拆卷）'); }
  }
});

test('复查1 第2条：H2 原第 8、9 条（开场在场景内、光幕位置）移到 H2G，每镜都加载；H2 里不再重复', () => {
  const g = idx.sections.find((x) => x.id === 'H2G');
  assert.ok(g, '要有 H2G 段'); assert.deepEqual(g.when, ['always']);
  for (const s of [...FX.too_dense_7, ...Object.values(FX.expression_ep1_5), ...FX.negated]) assert.ok(ids(requiredRanges(idx, s, P, ON)).includes('H2G'));
  const lines = fs.readFileSync(path.join(here, '..', 'skills', 'h3-prompt-writing', '规则全文.md'), 'utf8').split('\n');
  const text = (id) => { const x = idx.sections.find((y) => y.id === id); return lines.slice(x.start - 1, x.end).join('\n'); };
  assert.match(text('H2G'), /\*\*8\. The shot must open already inside the scene/);
  assert.match(text('H2G'), /\*\*9\. System panel position/);
  assert.doesNotMatch(text('H2'), /\*\*8\. The shot must open already inside the scene/);
  // H2 里原有的「移到 H2G」迁移注是作废文字，已在 8a1f608（压缩分卷）删除，不再断言。
});

test('复查2 第1条回归：「避免…/已有镜N…/…未用/…放在下一镜」与资产名「·Q版设定」不算本镜用了表现手段', () => {
  assert.equal(FX.review2_false_pos.length, 4);
  for (const s of FX.review2_false_pos) {
    assert.deepEqual(expressionMarkers(s), [], s.chapter + '#' + s.idx);
    assert.ok(!['H2', 'H2L', 'H2C'].some((x) => ids(requiredRanges(idx, s, P, ON)).includes(x)), s.chapter + '#' + s.idx + ' 不应加载 H2/H2L/H2C');
  }
  const m = (t) => expressionMarkers({ visual: t });
  assert.ok(m('画面无比夸张的金光眼特效').length, '「无比」不是否定');
  assert.ok(m('【表现】P4｜Q版·方式一（身旁小人）｜江澈身旁弹出Q版小人，绑何启航·Q版设定').length, '有【表现】Q版行照样算');
  const g = fs.readFileSync(path.join(here, '..', 'skills', 'h3-prompt-writing', '规则全文.md'), 'utf8');
  assert.match(g, /No device unless marked/);
  assert.doesNotMatch(g, /TR-V04 \(item 4 below\)/);
});
