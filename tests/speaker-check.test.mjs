// 出片前说话人/音色闸门（2026-11-18，A5-G11-2#26 复盘）：
// 台词说话人与本镜绑定角色名不完全一致 → 拦截出片；开口角色挂占位音色 → 告警。
// IC_CONFIG 指向 :9，守卫拦截 8188/8189/4610，upload 走 mock fetch，不提交渲染。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-speakercheck-'));
writeTempIcConfig(tmp);

globalThis.fetch = async (url) => {
  const href = String(url && url.href ? url.href : url);
  if (/:8188|:8189|:4610/.test(href)) throw new Error('fetch 守卫拦截：' + href);
  if (href.includes('/upload/')) {
    return new Response(JSON.stringify({ name: 'mock.bin', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('测试禁止提交渲染：' + href);
};

let sc, core, tools;
before(async () => {
  sc = await import('../lib/core/speaker-check.js');
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
});

const ch = (name, extra = {}) => ({ id: 'id_' + name, category: 'character', name, voice_ref: 'assets/voice/' + name + '.flac', ...extra });

test('纯函数：说话人与绑定角色精确同名 → 不拦', () => {
  const r = sc.checkShotSpeakers({ shot: { dialogue: '同学男：哈哈，恭喜韩总！' }, chars: [ch('韩子骁'), ch('同学男')] });
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.blockMessage, '');
});

test('纯函数：「同学男」≠「C065_B 正式同学男」→ 显式 block 时拦截（A5-G11-2#26 原样）', () => {
  const r = sc.checkShotSpeakers({ shot: { dialogue: '同学男：哈哈，恭喜韩总！' }, chars: [ch('韩子骁'), ch('C065_B 正式同学男')], cfg: { generation: { speakerCheck: 'block' } } });
  assert.deepEqual(r.unmatched, ['同学男']);
  assert.equal(r.mode, 'block');
  assert.match(r.blockMessage, /同学男/);
  assert.match(r.blockMessage, /已拦截出片/);
});

test('纯函数：未配置 speakerCheck 时默认 warn —— 照样列出未匹配说话人，但不拦', () => {
  assert.equal(sc.speakerCheckMode(null), 'warn');
  assert.equal(sc.speakerCheckMode({ generation: {} }), 'warn');
  assert.equal(sc.speakerCheckMode({ generation: { speakerCheck: 'BLOCK' } }), 'block');
  assert.equal(sc.speakerCheckMode({ generation: { speakerCheck: 'bogus' } }), 'warn');
  const r = sc.checkShotSpeakers({ shot: { dialogue: '同学男：哈哈，恭喜韩总！' }, chars: [ch('C065_B 正式同学男')] });
  assert.equal(r.mode, 'warn');
  assert.deepEqual(r.unmatched, ['同学男']);
  assert.equal(r.blockMessage, '');
});

test('纯函数：说话人没绑进本镜（A5-04#16 便利店同学/同学女）→ 全部列出', () => {
  const r = sc.checkShotSpeakers({ shot: { dialogue: '便利店同学：这一万我先不转了。\n同学女：我也是。' }, chars: [ch('韩子骁')] });
  assert.deepEqual(r.unmatched, ['便利店同学', '同学女']);
});

test('纯函数：旁白/系统等非角色说话人默认豁免；舞台提示括号不影响匹配', () => {
  const r = sc.checkShotSpeakers({ shot: { dialogue: '旁白：那年夏天。\n系统：交易完成。\n江澈（低声）：走吧。' }, chars: [ch('江澈')] });
  assert.deepEqual(r.unmatched, []);
});

test('纯函数：豁免名单可配置；speakerCheck=warn/off 不拦', () => {
  const shot = { dialogue: '系统：交易完成。' };
  let r = sc.checkShotSpeakers({ shot, chars: [], cfg: { generation: { speakerCheckExempt: [], speakerCheck: 'block' } } });
  assert.deepEqual(r.unmatched, ['系统']);
  assert.ok(r.blockMessage);
  r = sc.checkShotSpeakers({ shot, chars: [], cfg: { generation: { speakerCheckExempt: [], speakerCheck: 'warn' } } });
  assert.equal(r.mode, 'warn');
  assert.equal(r.blockMessage, '');
  r = sc.checkShotSpeakers({ shot, chars: [], cfg: { generation: { speakerCheckExempt: [], speakerCheck: 'off' } } });
  assert.equal(r.blockMessage, '');
});

test('纯函数：说话人由本镜 audio_ids 里的独立音色资产承担（「系统音色」）→ 不拦', () => {
  const assets = [{ id: 'v1', category: 'voice', name: '机器人音色（试验）' }];
  const r = sc.checkShotSpeakers({ shot: { dialogue: '机器人：你好。', audio_ids: ['v1'] }, chars: [], assets, cfg: { generation: { speakerCheckExempt: [] } } });
  assert.deepEqual(r.unmatched, []);
});

test('纯函数：开口角色挂占位音色（文件名带「占位」）→ 告警；不开口的占位角色不告警', () => {
  const r = sc.checkShotSpeakers({
    shot: { dialogue: '纸袋青年：嗯。' },
    chars: [ch('纸袋青年', { voice_ref: 'assets/voice/纸袋青年音色_a1占位1118_4a002764.wav' }), ch('C066_B 正式同学女', { voice_ref: 'assets/voice/C066_B音色_a1占位1118_995a4485.wav' })],
  });
  assert.equal(r.blockMessage, '');
  assert.equal(r.placeholders.length, 1);
  assert.equal(r.placeholders[0].name, '纸袋青年');
  assert.match(r.warnMessage, /占位/);
});

test('纯函数：占位音色按 md5 名单识别（文件名看不出时）；开口角色缺音色也告警', () => {
  const cfg = { generation: { placeholderVoiceMd5: ['b8318a7f47ff51d50e6075740243441b'] } };
  const md5Of = (rel) => (rel.endsWith('borrowed.wav') ? 'B8318A7F47FF51D50E6075740243441B' : 'FFFF');
  let r = sc.checkShotSpeakers({ shot: { dialogue: '同学女：好。' }, chars: [ch('同学女', { voice_ref: 'assets/voice/borrowed.wav' })], cfg, md5Of });
  assert.equal(r.placeholders.length, 1);
  r = sc.checkShotSpeakers({ shot: { dialogue: '同学女：好。' }, chars: [ch('同学女', { voice_ref: 'assets/voice/real.flac' })], cfg, md5Of });
  assert.equal(r.placeholders.length, 0);
  r = sc.checkShotSpeakers({ shot: { dialogue: '同学女：好。' }, chars: [ch('同学女', { voice_ref: '' })] });
  assert.equal(r.placeholders[0].reason, '无音色');
});

function put(pid, rel, bytes) {
  const abs = path.join(core.projectDir(pid), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return rel;
}
function mk() {
  const p = core.Projects.create({ name: 'speaker-it', auto_script: false });
  core.Chapters.create(p.id, { title: '第17章', script: 'x' });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第17章' });
  ctx.cfg.comfyui = { url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9', provider: 'native' };
  const reports = [];
  const orig = ctx.report; ctx.report = (x) => { reports.push(x); try { orig && orig(x); } catch {} };
  const mkChar = (name, voiceRel) => {
    const a = core.Assets.create(p.id, { category: 'character', name });
    core.Assets.update(a.id, { image_path: put(p.id, 'assets/characters/' + a.id + '.png', 'IMG'), voice_ref: voiceRel ? put(p.id, voiceRel, 'VOICE') : '', status: 'done' });
    return a;
  };
  return { p, ctx, reports, mkChar };
}

test('prepareShotForRender：显式 speakerCheck=block 且说话人名对不上 → 抛错拦截，不进入提交', async () => {
  const { p, ctx, mkChar } = mk();
  ctx.cfg.generation = { ...(ctx.cfg.generation || {}), speakerCheck: 'block' };
  const a = mkChar('C065_B 正式同学男', 'assets/voice/c065.flac');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '举杯', dialogue: '同学男：哈哈，恭喜韩总！' });
  core.Shots.update(shot.id, { character_ids: [a.id], video_prompt: 'a man toasts' });
  await assert.rejects(() => tools.prepareShotForRender(ctx, shot.id, { render: true }), /同学男.*已拦截出片/);
});

test('prepareShotForRender：未配置 speakerCheck（默认 warn）说话人名对不上 → 不拦，只上报告警', async () => {
  const { p, ctx, reports, mkChar } = mk();
  if (ctx.cfg.generation) delete ctx.cfg.generation.speakerCheck;
  const a = mkChar('C065_B 正式同学男', 'assets/voice/c065w.flac');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '举杯', dialogue: '同学男：哈哈，恭喜韩总！' });
  core.Shots.update(shot.id, { character_ids: [a.id], video_prompt: 'a man toasts' });
  const prepared = await tools.prepareShotForRender(ctx, shot.id, { render: true });
  assert.ok(prepared.prompt);
  assert.ok(reports.some((r) => /仅告警/.test(r.detail || '') && /同学男/.test(r.detail || '')), '默认 warn 要上报未匹配说话人');
});

test('prepareShotForRender：名字对上 → 正常准备，音色挂上', async () => {
  const { p, ctx, mkChar } = mk();
  const a = mkChar('同学男', 'assets/voice/tx.flac');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '举杯', dialogue: '同学男：哈哈，恭喜韩总！' });
  core.Shots.update(shot.id, { character_ids: [a.id], video_prompt: 'a man toasts' });
  const prepared = await tools.prepareShotForRender(ctx, shot.id, { render: true });
  assert.equal(prepared.references.filter((r) => r.type === 'audio').length, 1);
});

test('prepareShotForRender：开口角色挂占位音色 → 不拦但上报告警', async () => {
  const { p, ctx, reports, mkChar } = mk();
  const a = mkChar('纸袋青年', 'assets/voice/纸袋青年音色_a1占位1118_x.wav');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '递袋', dialogue: '纸袋青年：给。' });
  core.Shots.update(shot.id, { character_ids: [a.id], video_prompt: 'a young man hands a bag' });
  const prepared = await tools.prepareShotForRender(ctx, shot.id, { render: true });
  assert.ok(prepared.prompt);
  assert.ok(reports.some((r) => /占位/.test(r.detail || '')), '必须上报占位音色告警');
});

test('prepareShotForRender：render=false（仅改写提示词）不受说话人闸门影响', async () => {
  const { p, ctx, mkChar } = mk();
  const a = mkChar('C065_B 正式同学男', 'assets/voice/c065b.flac');
  const shot = core.Shots.create(p.id, { chapter: '第17章', visual: '举杯', dialogue: '同学男：哈哈！' });
  core.Shots.update(shot.id, { character_ids: [a.id], video_prompt: 'a man toasts' });
  // 无 feedback 时 render=false 按原逻辑报「需要反馈文字」，而不是说话人拦截
  await assert.rejects(() => tools.prepareShotForRender(ctx, shot.id, { render: false }), /反馈文字/);
});
