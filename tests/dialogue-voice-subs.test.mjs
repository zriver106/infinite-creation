// 11-28 跟进2 报第 10 镜被 DIALOGUE_NOT_IN_D 拒：谐音句 dialogue 写显示字「我cy！」，<d> 按规范写配音「我去！」，
// 台词门以前不读 visual 里的「配音替换：「X」读作「Y」」，规范写法也一律拒。现在按替换关系先换再比。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDialogueInD, parseVoiceSubs, applyVoiceSubs, shotVoiceText, assertDialogueInD } from '../lib/core/dialogue-d-gate.js';
import { validateShotContent } from '../lib/core/shot-write.js';

const DLG = '江澈（OS）：我cy！这车……\n江澈：走吧。';
const PR = 'close-up <d>[Chinese] 我去！这车……</d> then <d>[Chinese] 走吧。</d>';
const STD = '【表现】L1｜谐音｜配音替换：「我cy！」读作「我去！」\n江澈愣住';
const codes = (r) => r.errors.map((e) => e.code);

test('解析替换关系：标准标签和【配音】变体都认；没有「配音」二字的行不认', () => {
  assert.deepEqual(parseVoiceSubs(STD), [{ from: '我cy！', to: '我去！' }]);
  assert.deepEqual(parseVoiceSubs('【配音】江澈心声「我cy」读作「我去」'), [{ from: '我cy', to: '我去' }]);
  assert.deepEqual(parseVoiceSubs('他把「甲」读作「乙」'), []);
  assert.equal(applyVoiceSubs('我cy！这车……', [{ from: '我cy', to: '我去' }]), '我去！这车……');
});

test('台词门：按 visual 的替换关系比；没写替换关系照旧拒；<d> 里念显示字也拒', () => {
  assert.deepEqual(codes(checkDialogueInD(DLG, PR)), ['DIALOGUE_NOT_IN_D']);
  assert.deepEqual(codes(checkDialogueInD(DLG, PR, STD)), []);
  assert.deepEqual(codes(checkDialogueInD(DLG, PR, '【配音】江澈心声「我cy」读作「我去」')), []);
  assert.deepEqual(codes(checkDialogueInD(DLG, PR.replace('我去', '我cy'), STD)), ['DIALOGUE_NOT_IN_D']);
});

test('各入口都把 visual / sub_shots 带给台词门：渲染前硬拦、写分镜', () => {
  assert.equal(shotVoiceText({ visual: 'a', sub_shots: [{ t: 'b' }] }), 'a\n[{"t":"b"}]');
  assert.doesNotThrow(() => assertDialogueInD({ idx: 10, dialogue: DLG, visual: STD }, PR));
  assert.doesNotThrow(() => assertDialogueInD({ idx: 10, dialogue: DLG, visual: 'x', sub_shots: JSON.stringify([{ visual: STD }]) }, PR));
  assert.throws(() => assertDialogueInD({ idx: 10, dialogue: DLG, visual: 'x' }, PR), /DIALOGUE_NOT_IN_D/);
  const ok = validateShotContent({ video_prompt: PR }, { dialogue: DLG, visual: STD, duration: 8 });
  assert.ok(!ok.some((e) => /DIALOGUE_NOT_IN_D/.test(e)), JSON.stringify(ok));   // 返回的是错误数组
  const bad = validateShotContent({ video_prompt: PR }, { dialogue: DLG, visual: 'x', duration: 8 });
  assert.ok(bad.some((e) => /DIALOGUE_NOT_IN_D/.test(e)));
});
