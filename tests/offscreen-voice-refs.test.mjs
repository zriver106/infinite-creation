// 心声/电话声挂本人音色参考（2026-11-22，第1–10集共同根因）：全部台词由 H3 直出，角色的画外台词（心声/OS、电话那头）
// 也要拿说话人本人的音色参考（refs.js assembleShotReferences 经 prompts.js dialogueVoiceSpeakers）。
// 临时数据目录 + 临时配置（8188/8189/4610 守卫）；upload=false 只解析参考清单，不上传、不渲染。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-osvoice-'));
writeTempIcConfig(tmp);

let core;
let prompts;
let sc;
before(async () => {
  core = await import('../lib/core/index.js');
  prompts = await import('../lib/core/prompts.js');
  sc = await import('../lib/core/speaker-check.js');
});

describe('dialogueVoiceSpeakers：入画说话人在前，角色画外说话人在后', () => {
  test('江澈（OS）、江澈OS、许曼宁（电话）、电话里的王总 都列为画外说话人', () => {
    const d = '江澈（OS）：这菜单也太贵了。\n许曼宁（电话）：你到哪了？\n江澈OS：稳住。\n电话里的王总：明天来公司。';
    assert.deepEqual(prompts.dialogueVoiceSpeakers(d), [
      { name: '江澈', kind: 'os' }, { name: '许曼宁', kind: 'phone' }, { name: '王总', kind: 'phone' },
    ]);
    // 入画说话人语义不变：dialogueSpeakerNames 仍只列入画说话人（单镜说话人上限用）
    assert.deepEqual(prompts.dialogueSpeakerNames(d), []);
  });
  test('入画优先；同一人既入画又有心声只算一次', () => {
    const d = '许曼宁（电话）：你到哪了？\n江澈：马上到。\n江澈（OS）：其实还没出门。\n林默（对着电话）：我也快了。';
    assert.deepEqual(prompts.dialogueVoiceSpeakers(d), [
      { name: '江澈', kind: null }, { name: '林默', kind: null }, { name: '许曼宁', kind: 'phone' },
    ]);
  });
  test('旁白/系统音/广播不算角色画外说话人', () => {
    const d = '旁白：多年以后。\n系统：叮，任务完成。\n广播里的主持人：开始检票。\n江澈（旁白）：那年夏天。\n苏晴（广播）：请注意。';
    const off = prompts.dialogueVoiceSpeakers(d).filter((s) => s.kind);
    assert.deepEqual(off, []);
  });
});

describe('兜底提示词：画外台词按现行口径写进去', () => {
  test('心声/电话声标明种类和本人声音；入画台词照旧', () => {
    const p = prompts.fallbackVideoPrompt({ dialogue: '江澈：你点好了吗？\n江澈（OS）：这菜单也太贵了。\n许曼宁（电话）：你到哪了？\n系统：叮。', characterName: '江澈' });
    assert.match(p, /说出“江澈：你点好了吗？”/);
    assert.match(p, /江澈的心声（画外内心独白，用江澈本人的声音[^）]*）：“这菜单也太贵了。”/);
    assert.match(p, /电话那头许曼宁的声音（从听筒里传出，用许曼宁本人的声音[^）]*）：“你到哪了？”/);
    assert.match(p, /系统音（画外声[^）]*）：“叮。”/);
  });
});

describe('assembleShotReferences：画外说话人拿本人音色（upload=false）', { concurrency: 1 }, () => {
  let p; let A;
  before(() => {
    p = core.Projects.create({ name: '心声音色测试', auto_script: false });
    const dir = core.projectDir(p.id);
    const file = (rel) => { const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'x'); return rel; };
    const mk = (category, name, patch) => { const a = core.Assets.create(p.id, { category, name }); core.Assets.update(a.id, { status: 'done', ...patch }); return core.Assets.get(a.id); };
    A = {
      jc: mk('character', '江澈', { image_path: file('assets/character/jc.png'), voice_ref: file('assets/voice/jc.wav') }),
      lm: mk('character', '林默', { image_path: file('assets/character/lm.png'), voice_ref: file('assets/voice/lm.wav') }),
      tzx: mk('character', '唐知夏', { image_path: file('assets/character/tzx.png'), voice_ref: file('assets/voice/tzx.wav') }),
      // 许曼宁：角色有音色，但不绑进镜头（电话那头不入画）
      xmn: mk('character', '许曼宁（职场）', { image_path: file('assets/character/xmn.png'), voice_ref: file('assets/voice/xmn.wav') }),
      // 王总：没有角色资产，只有同名 voice 资产「王总音色」
      wz: mk('voice', '王总音色', { audio_path: file('assets/voice/wz.wav') }),
      // 主持人：库里有同名角色音色，但「广播里的主持人」是广播，不配角色音色
      host: mk('character', '主持人', { image_path: file('assets/character/host.png'), voice_ref: file('assets/voice/host.wav') }),
      narr: mk('voice', '旁白音色', { audio_path: file('assets/voice/narr.wav') }),
    };
  });
  const run = (shot) => core.assembleShotReferences({ cfg: core.loadConfig(), project: core.Projects.get(p.id), shot, assets: core.Assets.list(p.id), upload: false });
  const audioLabels = (r) => r.references.filter((x) => x.type === 'audio').map((x) => x.label);

  test('江澈（OS）/ 江澈OS → 江澈的声音（心声）', async () => {
    for (const d of ['江澈（OS）：这菜单也太贵了。', '江澈OS：稳住。', '江澈（心声）：别慌。']) {
      const r = await run({ character_ids: [A.jc.id], dialogue: d });
      assert.deepEqual(audioLabels(r), ['江澈的声音（心声）'], d);
      assert.ok(r.references.find((x) => x.type === 'audio').filename.includes(A.jc.id.slice(0, 8)));
      assert.deepEqual(r.unmatchedSpeakers, []);
    }
  });
  test('本镜角色按 character_ids 顺序送音色，入画/画外混排（第6章 #4/#7/#11：REF 江澈 在 唐知夏 前）', async () => {
    let r = await run({ character_ids: [A.jc.id, A.tzx.id], dialogue: '唐知夏：你怎么不说话？\n江澈（OS）：说什么都是错。' });
    assert.deepEqual(audioLabels(r), ['江澈的声音（心声）', '唐知夏的声音']);
    // 反过来绑定，顺序跟着 character_ids 走
    r = await run({ character_ids: [A.tzx.id, A.jc.id], dialogue: '江澈：好。\n唐知夏（OS）：才怪。' });
    assert.deepEqual(audioLabels(r), ['唐知夏的声音（心声）', '江澈的声音']);
    // 绑了但不说话的角色不送
    r = await run({ character_ids: [A.jc.id, A.tzx.id, A.lm.id], dialogue: '林默：走吧。\n江澈OS：再等等。' });
    assert.deepEqual(audioLabels(r), ['江澈的声音（心声）', '林默的声音']);
  });
  test('许曼宁（电话）没绑进本镜 → 按名字从资产库找到本人音色，排在本镜角色之后', async () => {
    const r = await run({ character_ids: [A.lm.id], dialogue: '许曼宁（电话）：你到哪了？\n林默：快到了。' });
    assert.deepEqual(audioLabels(r), ['林默的声音', '许曼宁的声音（电话那头）']);
    assert.ok(r.references.filter((x) => x.type === 'audio')[1].filename.includes(A.xmn.id.slice(0, 8)));
    assert.deepEqual(r.unmatchedSpeakers, [], '电话那头不入画，不算「说话人没绑进本镜」');
    assert.deepEqual(r.offscreenVoiceMissing, []);
  });
  test('电话里的王总 → 同名 voice 资产「王总音色」；audio_ids 再绑一次不重复送', async () => {
    let r = await run({ character_ids: [A.lm.id], dialogue: '电话里的王总：明天来公司。' });
    assert.deepEqual(audioLabels(r), ['王总的声音（电话那头）']);
    r = await run({ character_ids: [A.lm.id], dialogue: '电话里的王总：明天来公司。', audio_ids: [A.wz.id] });
    assert.deepEqual(audioLabels(r), ['王总的声音（电话那头）']);
  });
  test('画外说话人找不到音色 → offscreenVoiceMissing 报出来，不抛错', async () => {
    const r = await run({ character_ids: [A.lm.id], dialogue: '电话里的李四：喂？' });
    assert.deepEqual(audioLabels(r), []);
    assert.deepEqual(r.offscreenVoiceMissing, ['李四']);
  });
  test('合计超过 3 段 → 按「本镜说话角色（character_ids 序）→ 本镜外画外说话人 → audio_ids」截断，丢弃项可查', async () => {
    const r = await run({
      character_ids: [A.lm.id, A.jc.id],
      dialogue: '许曼宁（电话）：在吗？\n江澈（OS）：别接。\n林默：喂？\n电话里的王总：明天来。',
      audio_ids: [A.narr.id],
    });
    assert.deepEqual(audioLabels(r), ['林默的声音', '江澈的声音（心声）', '许曼宁的声音（电话那头）']);
    assert.deepEqual(r.droppedAudio, ['王总的声音（电话那头）', '旁白音色（语音）']);
  });
  test('旁白/系统音/广播不拿角色音色；只走分镜绑定的 audios', async () => {
    const d = '旁白：多年以后。\n系统：叮，任务完成。\n广播里的主持人：开始检票。';
    let r = await run({ character_ids: [A.jc.id], dialogue: d });
    assert.deepEqual(audioLabels(r), [], '主持人有同名角色音色也不送');
    r = await run({ character_ids: [A.jc.id], dialogue: d, audio_ids: [A.narr.id] });
    assert.deepEqual(audioLabels(r), ['旁白音色（语音）']);
  });
  test('同一人入画又有心声：音色只送一次', async () => {
    const r = await run({ character_ids: [A.jc.id], dialogue: '江澈：好。\n江澈（OS）：才怪。' });
    assert.deepEqual(audioLabels(r), ['江澈的声音']);
  });
});

describe('checkShotSpeakers：画外说话人不要求绑进本镜，只查音色', () => {
  const chars = [{ id: 'c1', name: '林默', voice_ref: 'assets/voice/lm.wav' }];
  const assets = [...chars, { id: 'c2', category: 'character', name: '许曼宁', voice_ref: 'assets/voice/xmn.wav' }];
  test('电话那头没绑进本镜：block 模式也不拦', () => {
    const r = sc.checkShotSpeakers({ shot: { dialogue: '林默：喂？\n许曼宁（电话）：在吗？' }, chars, assets, cfg: { generation: { speakerCheck: 'block' } } });
    assert.deepEqual(r.unmatched, []);
    assert.equal(r.blockMessage, '');
    assert.deepEqual(r.offscreenSpeakers, ['许曼宁']);
    assert.equal(r.warnMessage, '');
  });
  test('画外说话人缺音色/占位音色 → 告警不拦', () => {
    const r = sc.checkShotSpeakers({ shot: { dialogue: '林默：喂？\n电话里的李四：在吗？' }, chars, assets, cfg: { generation: { speakerCheck: 'block' } } });
    assert.equal(r.blockMessage, '');
    assert.match(r.warnMessage, /李四（画外）/);
    const r2 = sc.checkShotSpeakers({ shot: { dialogue: '江澈（OS）：稳住。' }, chars: [], assets: [{ id: 'c3', category: 'character', name: '江澈', voice_ref: 'assets/voice/占位.wav' }] });
    assert.match(r2.warnMessage, /江澈（画外）/);
  });
});
