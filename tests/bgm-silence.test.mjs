// 选曲规则（2026-11-18）：不设默认曲；「静音」是合法选项；选曲必须写 caption（情绪类别 + 理由）。
// 临时数据目录 + 临时配置（IC_CONFIG=:9 + 8188/8189 守卫），不碰真实 data/ic.db、不调 MiniMax。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bgmsilence-'));
writeTempIcConfig(tmp);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let core, tools;
before(async () => {
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
});

function mk() {
  const p = core.Projects.create({ name: '静音测试', auto_script: false });
  const ch = core.Chapters.create(p.id, { title: '第30章', script: 'x' });
  const rel = 'assets/music/a.mp3';
  const abs = path.join(core.projectDir(p.id), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'ID3');
  const m = core.Assets.create(p.id, { category: 'music', name: '主曲甲' });
  core.Assets.update(m.id, { audio_path: rel, status: 'done' });
  core.Chapters.update(ch.id, { music_path: rel, music_prompt: JSON.stringify({ caption: '旧', music_id: m.id, music_name: '主曲甲', cues: [{ start: 0, end: 1, music_id: 'silence' }] }) });
  const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第30章' });
  return { p, ctx, m };
}
const chapterOf = (pid) => core.Chapters.list(pid).find((c) => c.title === '第30章');

test('music_id="silence"：清空 music_path，记下静音和 caption，其余字段保留', async () => {
  const { p, ctx } = mk();
  const out = JSON.parse(await tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: 'silence', caption: '情绪类别：暧昧、回忆与告别｜选曲：静音｜理由：诀别对白' }));
  assert.equal(out.silence, true);
  assert.equal(out.bound, true);
  const ch = chapterOf(p.id);
  assert.equal(ch.music_path, '');
  const mp = JSON.parse(ch.music_prompt);
  assert.equal(mp.music_id, 'silence');
  assert.match(mp.caption, /情绪类别/);
  assert.equal(mp.cues.length, 1, '其余字段（如 cue 表）原样保留');
});

test('「静音」中文写法同样认', async () => {
  const { p, ctx } = mk();
  await tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: '静音', caption: '情绪类别：无对应｜选曲：静音｜理由：指南里没有对应情绪' });
  assert.equal(JSON.parse(chapterOf(p.id).music_prompt).music_id, 'silence');
});

test('传了 music_id 却没写 caption：报错，要求写情绪类别和理由', async () => {
  const { ctx } = mk();
  await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: '主曲甲' }), /情绪类别/);
  await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: 'silence' }), /情绪类别/);
});

test('正常选曲照旧绑定', async () => {
  const { p, ctx, m } = mk();
  const out = JSON.parse(await tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: '主曲甲', caption: '情绪类别：压抑、受困｜选曲：主曲甲｜理由：测试' }));
  assert.equal(out.bound, true);
  assert.equal(JSON.parse(chapterOf(p.id).music_prompt).music_id, m.id);
});

test('选了静音后 generate_music 不绑曲、不生成', async () => {
  const { p, ctx } = mk();
  await tools.runTool(ctx, 'set_chapter_music', { chapter: '第30章', music_id: 'silence', caption: '情绪类别：…｜选曲：静音｜理由：…' });
  const out = JSON.parse(await tools.runTool(ctx, 'generate_music', { chapter: '第30章' }));
  assert.equal(out.silence, true);
  assert.equal(chapterOf(p.id).music_path, '');
});

test('apply_chapter_music 不接受静音', async () => {
  const { ctx } = mk();
  await assert.rejects(() => tools.runTool(ctx, 'apply_chapter_music', { music_id: 'silence', chapters: ['第30章'] }), /不接受静音/);
});

test('技能、提示词、工具说明里不再有「默认 01 囚笼」和以点名为前提的条件', () => {
  const files = ['skills/ai-music-studio/SKILL.md', 'skills/novel-to-video/SKILL.md', 'lib/agent/agent-loop.js', 'lib/agent/tools.js'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.doesNotMatch(t, /默认每章 music_id="01"/, f);
    assert.doesNotMatch(t, /默认 01 囚笼/, f);
    assert.doesNotMatch(t, /Andy 指定/, f);
  }
  const defs = tools.TOOL_DEFINITIONS.find((d) => d.function.name === 'set_chapter_music').function.description;
  assert.match(defs, /静音/);
  assert.match(defs, /情绪类别/);
});
