// 片内配乐闸门（2026-11-18）：non_diegetic_music 必须是 N/A；music 资产不绑进分镜。默认只告警，block 才拦。
// 临时数据目录 + 临时配置（IC_CONFIG=:9 + 8188/8189/4610 守卫），upload 走 mock fetch，不提交渲染。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';
import { checkShotMusic, musicCheckMode, h3Sections, isEmptyMusic, isBlankMusic, EMPTY_MUSIC_VALUES } from '../lib/core/music-check.js';
import { fileURLToPath } from 'node:url';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-musiccheck-'));
writeTempIcConfig(tmp);

globalThis.fetch = async (url) => {
  const href = String(url && url.href ? url.href : url);
  if (/:8188|:8189|:4610/.test(href)) throw new Error('fetch 守卫拦截：' + href);
  if (href.includes('/upload/')) {
    return new Response(JSON.stringify({ name: 'mock.bin', subfolder: '', type: 'input' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('测试禁止提交渲染：' + href);
};

const P = (ndm) => 'summary: x\ndetailed_description:\n[Shot 1] A man stands.\n\noverall_soundscape:\nRain on glass.\n' + (ndm == null ? '' : '\nnon_diegetic_music:\n' + ndm + '\n');

describe('music-check 纯函数', () => {
  test('只认 silence / 没有配乐 / N/A / none（不分大小写，可带句号）', () => {
    for (const v of ['N/A', 'n/a', 'N/A.', 'none', 'None', 'NONE.', 'silence', 'Silence.', '没有配乐', '没有配乐。']) assert.ok(isEmptyMusic(v), v);
    for (const v of ['', ' ', '.', '。', ' . ', '无', '无配乐', 'No music.', 'na', '-', 'Sparse piano at a slow tempo.']) assert.ok(!isEmptyMusic(v), JSON.stringify(v));
    for (const v of ['', '   ', '.', '。', ' 。 ']) assert.ok(isBlankMusic(v), JSON.stringify(v));
    assert.ok(!isBlankMusic('N/A'));
  });
  test('段在但为空/单个句号/只有空白 → ndm_missing（不是「无配乐」）', () => {
    for (const v of ['', '.', '。', '   ']) {
      assert.deepEqual(checkShotMusic({ prompt: P(v) }).issues.map((i) => i.code), ['ndm_missing'], JSON.stringify(v));
    }
    assert.deepEqual(checkShotMusic({ prompt: 'Sound: rain. Background music: .' }).issues.map((i) => i.code), ['ndm_missing']);
    assert.deepEqual(checkShotMusic({ prompt: P('silence') }).issues, []);
  });
  test('JS EMPTY_MUSIC_VALUES 与 Python H10B_EMPTY_MUSIC_VALUES 一致', () => {
    const py = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'short-drama-director', 'scripts', 'validate_prompt.py'), 'utf8');
    const m = /^H10B_EMPTY_MUSIC_VALUES = (\[[^\]]*\])/m.exec(py);
    assert.ok(m, 'validate_prompt.py 里找不到 H10B_EMPTY_MUSIC_VALUES');
    assert.deepEqual(JSON.parse(m[1]), EMPTY_MUSIC_VALUES);
    assert.deepEqual(EMPTY_MUSIC_VALUES, ['silence', '没有配乐', 'N/A', 'none']);
  });
  test('分段：多行段落、同行写值都能切出', () => {
    assert.equal(h3Sections(P('N/A')).non_diegetic_music, 'N/A');
    assert.equal(h3Sections('overall_soundscape: rain\nnon_diegetic_music: N/A').non_diegetic_music, 'N/A');
    assert.deepEqual(h3Sections('自由文本提示词，没有分段'), {});
  });
  test('写了配乐 → 默认只告警（warn），不拦', () => {
    const r = checkShotMusic({ prompt: P('Sparse piano notes at a slow tempo.') });
    assert.equal(r.mode, 'warn');
    assert.deepEqual(r.issues.map((i) => i.code), ['ndm_content']);
    assert.match(r.warnMessage, /仅告警/);
    assert.equal(r.blockMessage, '');
  });
  test('N/A → 不报', () => {
    const r = checkShotMusic({ prompt: P('N/A') });
    assert.equal(r.issues.length, 0);
    assert.equal(r.warnMessage, '');
  });
  test('H3 分段格式缺 non_diegetic_music → 告警；自由文本不判', () => {
    assert.deepEqual(checkShotMusic({ prompt: P(null) }).issues.map((i) => i.code), ['ndm_missing']);
    assert.equal(checkShotMusic({ prompt: '一个男人站在雨里。' }).issues.length, 0);
  });
  test('自由文本：Background music 句有内容 → 告警；none / 无该句 → 不报', () => {
    const free = 'The video begins inside the dining room. Sound: room tone, cups clinking. Background music: a low, restrained cello line that builds slowly.';
    assert.deepEqual(checkShotMusic({ prompt: free }).issues.map((i) => i.code), ['ndm_freetext']);
    assert.equal(checkShotMusic({ prompt: 'Sound: room tone.\nBackground music: none.' }).issues.length, 0);
    assert.equal(checkShotMusic({ prompt: 'Sound: room tone. A radio plays an old song in the corner.' }).issues.length, 0);
    assert.equal(checkShotMusic({ prompt: 'Sound: room tone.\n背景音乐：没有配乐' }).issues.length, 0);
    assert.deepEqual(checkShotMusic({ prompt: 'Sound: room tone.\n背景音乐：无' }).issues.map((i) => i.code), ['ndm_freetext'], '「无」不在四个写法里');
    assert.deepEqual(checkShotMusic({ prompt: 'Sound: rain.\n背景音乐：低沉的大提琴' }).issues.map((i) => i.code), ['ndm_freetext']);
  });
  test('规则写进三处提示词：写提示词、反馈改写、agent-loop', () => {
    const tools = fs.readFileSync(path.join(process.cwd(), 'lib', 'agent', 'tools.js'), 'utf8');
    const loop = fs.readFileSync(path.join(process.cwd(), 'lib', 'agent', 'agent-loop.js'), 'utf8');
    const rw = tools.slice(tools.indexOf('async function rewritePromptWithFeedback'), tools.indexOf('async function rewritePromptWithFeedback') + 3000);
    assert.match(rw, /Background music/, '反馈改写要求去掉配乐句');
    assert.match(rw, /声音（背景音乐除外）/, '严格模式不再要求保留背景音乐');
    const wp = tools.slice(tools.indexOf('async function writeShotVideoPrompt'), tools.indexOf('async function writeShotVideoPrompt') + 3000);
    assert.match(wp, /non_diegetic_music 段一律写 N\/A/);
    assert.match(wp, /Background music/);
    assert.match(loop, /不写「Background music/);
  });
  test('分镜 audios 绑了 music 资产 → 告警；voice/sfx 不报', () => {
    const assets = [{ id: 'm', category: 'music', name: '01-囚笼' }, { id: 'v', category: 'voice', name: '旁白音色' }, { id: 's', category: 'sfx', name: '雨声' }];
    assert.deepEqual(checkShotMusic({ prompt: P('N/A'), shot: { audio_ids: ['v', 's'] }, assets }).issues.length, 0);
    const r = checkShotMusic({ prompt: P('N/A'), shot: { audio_ids: ['m', 'v'] }, assets });
    assert.deepEqual(r.issues.map((i) => i.code), ['music_ref']);
    assert.match(r.warnMessage, /01-囚笼/);
  });
  test('模式：缺省 warn；block 显式配置才拦；off 关闭', () => {
    assert.equal(musicCheckMode(null), 'warn');
    assert.equal(musicCheckMode({ generation: { musicCheck: 'BLOCK' } }), 'block');
    assert.equal(musicCheckMode({ generation: { musicCheck: 'weird' } }), 'warn');
    const b = checkShotMusic({ prompt: P('Piano.'), cfg: { generation: { musicCheck: 'block' } } });
    assert.match(b.blockMessage, /已拦截出片/);
    assert.equal(b.warnMessage, '');
    const o = checkShotMusic({ prompt: P('Piano.'), cfg: { generation: { musicCheck: 'off' } } });
    assert.equal(o.issues.length, 0);
  });
});

describe('prepareShotForRender 接线', { concurrency: 1 }, () => {
  let core, tools;
  before(async () => {
    core = await import('../lib/core/index.js');
    tools = await import('../lib/agent/tools.js');
  });
  function mk(prompt, cfgPatch) {
    const p = core.Projects.create({ name: '片内配乐测试', auto_script: false });
    core.Chapters.create(p.id, { title: '第30章', script: 'x' });
    const out = await_create(p, prompt);
    const reports = [];
    const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第30章', onProgress: (e) => reports.push(e) });
    if (cfgPatch) ctx.cfg = { ...ctx.cfg, generation: { ...(ctx.cfg.generation || {}), ...cfgPatch } };
    return { ctx, shotId: out.id, reports };
  }
  function await_create(p, prompt) {
    const [s] = core.Shots.bulkCreate
      ? core.Shots.bulkCreate(p.id, [{ chapter: '第30章', idx: 1, visual: '画面', duration: 5, mode: 'text', video_prompt: prompt }])
      : [core.Shots.create(p.id, { chapter: '第30章', idx: 1, visual: '画面', duration: 5, mode: 'text', video_prompt: prompt })];
    return s;
  }
  const text = (reports) => reports.map((r) => JSON.stringify(r)).join('\n');

  test('默认 warn：写了配乐照常准备出片，并上报告警', async () => {
    const { ctx, shotId, reports } = mk(P('Sparse piano notes.'));
    const prepared = await tools.prepareShotForRender(ctx, shotId);
    assert.ok(prepared && prepared.prompt, '不拦');
    assert.match(text(reports), /片内配乐/);
  });
  test('N/A：不上报', async () => {
    const { ctx, shotId, reports } = mk(P('N/A'));
    await tools.prepareShotForRender(ctx, shotId);
    assert.doesNotMatch(text(reports), /片内配乐/);
  });
  test('generation.musicCheck=block：拦截出片', async () => {
    const { ctx, shotId } = mk(P('Sparse piano notes.'), { musicCheck: 'block' });
    await assert.rejects(() => tools.prepareShotForRender(ctx, shotId), /已拦截出片/);
  });
});
