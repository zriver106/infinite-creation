// 画外台词不进段文件（2026-11-18）：心声/OS、电话那头、广播、系统音不进 <d>、不拿段内音色参考，改进画外音声源清单。
// 临时数据目录 + 临时配置（8188/8189/4610 守卫），不提交渲染。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';
import * as off from '../lib/core/offscreen-lines.js';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-offscreen-'));
writeTempIcConfig(tmp);
let prompts;
let pwm;
before(async () => {
  prompts = await import('../lib/core/prompts.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
});

const DIALOGUE = [
  '江澈：你点好了吗？',
  '江澈（OS）：这菜单也太贵了。',
  '苏晴（电话）：你到哪了？',
  '广播：各位旅客请注意，G101次列车开始检票。',
  '林默（对着电话）：我马上到。',
  '系统：叮，交易完成。',
  '江澈OS：稳住。',
  '电话里的王总：明天来公司。',
].join('\n');
const SUB = '0-3秒（近景）：江澈抬头；台词：江澈：你点好了吗？3-6秒（特写）：江澈盯着菜单，闭嘴；台词：江澈（OS）：这菜单也太贵了。6-9秒（近景）：林默贴着手机听；苏晴（电话）：你到哪了？';
const ASSETS = [
  { id: 'c1', category: 'character', name: '江澈', voice_ref: 'assets/voice/jc.wav' },
  { id: 'c2', category: 'character', name: '苏晴（职场）', voice_ref: 'assets/voice/sq.wav,assets/voice/sq2.wav' },
  { id: 'c3', category: 'character', name: '林默', voice_ref: 'assets/voice/lm.wav' },
];

describe('画外台词识别', () => {
  test('OS、电话、广播、系统都排除；普通台词和「对着电话」的入画台词保留', () => {
    const kinds = off.parseDialogue(DIALOGUE).map((l) => [l.speaker, l.kind]);
    assert.deepEqual(kinds, [
      ['江澈', null], ['江澈', 'os'], ['苏晴', 'phone'], ['广播', 'broadcast'],
      ['林默', null], ['系统', 'system'], ['江澈', 'os'], ['王总', 'phone'],
    ]);
    assert.equal(off.onscreenDialogue(DIALOGUE), '江澈：你点好了吗？\n林默（对着电话）：我马上到。');
    assert.equal(off.parseDialogueLine('唐知夏（C005，电话）：喂？').kind, 'phone');
    assert.equal(off.parseDialogueLine('林默（站在路口，望着远处）：我知道。').kind, null);
    assert.equal(off.parseDialogueLine('街道上行人稀少。').kind, null);
    assert.equal(off.isOffscreenPersonLine('江澈（OS）：稳住。'), true);
    assert.equal(off.isOffscreenPersonLine('系统：叮。'), false);
    assert.equal(off.isOffscreenLine('系统：叮。'), true);
  });
  test('dialogueSpeakerNames 不再把（OS）剥成入画说话人：画外说话人拿不到段内音色参考', () => {
    // 「广播」「系统」本身不是角色、不配角色音色（说话人闸门 v2 有豁免名单），照旧列为说话人名；角色的画外台词整行跳过
    assert.deepEqual(prompts.dialogueSpeakerNames(DIALOGUE), ['江澈', '广播', '林默', '系统']);
    assert.deepEqual(prompts.dialogueSpeakerNames('江澈（OS）：这菜单也太贵了。\n苏晴（电话）：你到哪了？'), []);
    assert.deepEqual(prompts.dialogueSpeakerNames('林默（站在路口，望着远处）：我知道你一直在这里。'), ['林默']);
  });
  test('兜底提示词只说入画台词', () => {
    const p = prompts.fallbackVideoPrompt({ dialogue: DIALOGUE, characterName: '江澈' });
    assert.match(p, /你点好了吗/);
    assert.match(p, /我马上到/);
    for (const s of ['这菜单也太贵了', '你到哪了', '检票', '交易完成', '稳住', '明天来公司']) assert.ok(!p.includes(s), s);
  });
  test('save 校验：画外台词进了 <d> → 拒；只有入画台词 → 过', () => {
    const bad = pwm.checkVideoPrompt('Jiang Che (S1) says: <d>[Chinese] 你点好了吗？</d> An off-screen voice narrates <d>[Chinese] 这菜单也太贵了。</d>', 0, DIALOGUE);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes('画外台词') && e.includes('这菜单也太贵了')), bad.errors.join(' | '));
    const phone = pwm.checkVideoPrompt('The voice on the phone says <d>[Chinese] 你到哪了？</d>', 0, DIALOGUE);
    assert.equal(phone.ok, false);
    const good = pwm.checkVideoPrompt('Jiang Che (S1) says: <d>[Chinese] 你点好了吗？</d> 3-6s: his eyes narrow, lips resting closed.', 0, DIALOGUE);
    assert.equal(good.ok, true, good.errors.join(' | '));
    assert.equal(pwm.checkVideoPrompt('He says <d>[Chinese] 我的心声</d>', 0).ok, true, '不传台词时行为不变');
  });
  test('offscreenCheckMode：默认 warn，block/off 显式配置', () => {
    assert.equal(off.offscreenCheckMode(null), 'warn');
    assert.equal(off.offscreenCheckMode({ generation: { offscreenCheck: 'block' } }), 'block');
    assert.equal(off.offscreenCheckMode({ generation: { offscreenCheck: 'off' } }), 'off');
    assert.equal(off.offscreenCheckMode({ generation: { offscreenCheck: 'x' } }), 'warn');
  });
});

describe('画外音声源清单', () => {
  const shots = [
    { id: 's2', idx: 2, chapter: '第30章', dialogue: '江澈：好。', sub_shots: '' },
    { id: 's1', idx: 1, chapter: '第30章', dialogue: DIALOGUE, sub_shots: SUB },
    { id: 's0', idx: 0, chapter: '第30章', status: 'obsolete', dialogue: '江澈（OS）：作废镜。', sub_shots: '' },
  ];
  test('每条画外台词一条：镜、时间窗、原话、说话人、本人声线样本资产 id', () => {
    const m = off.buildVoiceSourceManifest({ chapter: '第30章', shots, assets: ASSETS });
    assert.equal(m.type, 'voice-source-manifest');
    assert.equal(m.entries.length, 6, '作废镜和入画台词不进清单');
    const [os1, ph, bc, sys, os2, ph2] = m.entries;
    assert.deepEqual({ shot_id: os1.shot_id, kind: os1.kind, speaker: os1.speaker, text: os1.text, window: os1.window, voice: os1.voice_asset_id },
      { shot_id: 's1', kind: 'os', speaker: '江澈', text: '这菜单也太贵了。', window: { start: 3, end: 6 }, voice: 'c1' });
    assert.equal(os1.voice_ref, 'assets/voice/jc.wav');
    assert.deepEqual(os1.issues, []);
    assert.deepEqual([ph.speaker, ph.window, ph.voice_asset_id, ph.voice_ref], ['苏晴', { start: 6, end: 9 }, 'c2', 'assets/voice/sq.wav']);
    assert.equal(bc.kind, 'broadcast');
    assert.equal(bc.window, null);
    assert.ok(bc.issues.some((x) => x.includes('时间窗')));
    assert.equal(sys.kind, 'system');
    assert.equal(os2.text, '稳住。');
    assert.equal(ph2.speaker, '王总');
    assert.equal(ph2.voice_asset_id, null);
    assert.ok(ph2.issues.some((x) => x.includes('声线样本')));
  });
  test('写到 画外音声源/ 目录，文件名按章', () => {
    const dir = path.join(tmp, 'proj', '画外音声源');
    const m = off.buildVoiceSourceManifest({ chapter: '第30章', shots, assets: ASSETS });
    const file = off.writeVoiceSourceManifest(dir, m);
    assert.equal(path.basename(file), 'manifest_第30章.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), m);
  });
});
