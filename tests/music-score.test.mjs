// 章节配乐任务（主会话 seq2179/seq2181）：工具集、写前守卫与存档、时间轴、任务提交（假 Agent，不起 CLI、不碰 GPU）、rules_hold 排队、路由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-music-score-'));
process.env.IC_RULES_HOLD_POLL_MS = '30';
const { installGpuGuard, writeTempIcConfig } = await import('./helpers/gpu-guard.mjs');
installGpuGuard();
const cfgPath = writeTempIcConfig(tmp);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.agent = { runtime: 'claude' };
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
const ROOT = process.cwd();
registerHooks({ resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
  if (spec === 'next/server') return next('next/server.js', ctx);
  return next(spec, ctx);
} });
const core = await import('../lib/core/index.js');
const M = await import('../lib/agent/music-score-mcp.js');
const { submitMusicScoreJob, MUSIC_SCORE_JOB_TYPE } = await import('../lib/agent/music-score.js');
const { TOOL_DEFINITIONS } = await import('../lib/agent/tools.js');
const { rulesHoldFile } = await import('../lib/core/render-gate.js');
const { POST } = await import('../app/api/projects/[id]/chapters/[cid]/music/score/route.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); } return false; };
let n = 0;
function world() {
  const p = core.Projects.create({ name: '配乐测试' + (++n), auto_script: false });
  const c = core.Chapters.create(p.id, { title: '第32章', script: '宋老：这茶不错。\n江澈：那是。' });
  const a = core.Shots.create(p.id, { chapter: '第32章', idx: 1, visual: '喝茶斗嘴', dialogue: '宋老：这茶不错。', duration: 6 });
  const b = core.Shots.create(p.id, { chapter: '第32章', idx: 2, visual: '病房', dialogue: '', duration: 8 });
  return { p, c, a, b };
}
// 假 Agent：模拟 MCP 子进程里的一次写（守卫 + 存档），并改本章 cue 表
const fakeWriter = (calls) => async ({ projectId, chapter, jobId, musicScore, musicRequirement }) => {
  calls.push({ chapter, musicScore, musicRequirement });
  const ctx = { projectId, chapter, jobId };
  M._resetMusicScoreServed();
  M.noteMusicScoreToolCall('skill', { name: M.MUSIC_SKILL });
  M.noteMusicScoreToolCall('skill_reference', { name: M.MUSIC_SKILL, ref: M.MUSIC_GUIDE_REF });
  const args = M.guardMusicScoreWrite(ctx, 'set_chapter_music_cues', { cues: [{ start: 0, end: 6, music_id: 'silence' }] });
  const ch = core.Chapters.list(projectId).find((x) => x.title === args.chapter);
  core.Chapters.update(ch.id, { music_prompt: JSON.stringify({ cues: args.cues }) });
};

test('工具集：只读 + 两个配乐写工具 + 时间轴；不给合成、出曲、出片', () => {
  const names = new Set(M.musicScoreToolDefinitions(TOOL_DEFINITIONS).map((t) => t.function.name));
  for (const x of ['skill', 'skill_reference', 'get_chapter', 'set_chapter_music', 'set_chapter_music_cues', 'get_chapter_timeline']) assert.ok(names.has(x), x);
  for (const x of ['apply_chapter_music', 'assemble_video', 'generate_music', 'generate_music_asset', 'generate_shot_video', 'update_shot', 'set_storyboard']) assert.ok(!names.has(x), x);
  assert.equal(M.isMusicScoreToolAllowed('generate_music'), false);
});

test('写前守卫：没读技能/指南拒；只能写本章；写前把旧配乐存档', () => {
  const w = world();
  const ctx = { projectId: w.p.id, chapter: '第32章', jobId: 'jg1' };
  M._resetMusicScoreServed();
  assert.throws(() => M.guardMusicScoreWrite(ctx, 'set_chapter_music_cues', { cues: [] }), /skill\(name="ai-music-studio"\)/);
  M.noteMusicScoreToolCall('skill', { name: 'ai-music-studio' });
  assert.throws(() => M.guardMusicScoreWrite(ctx, 'set_chapter_music_cues', { cues: [] }), /曲库指南/);
  M.noteMusicScoreToolCall('skill_reference', { name: 'ai-music-studio', ref: M.MUSIC_GUIDE_REF });
  assert.throws(() => M.guardMusicScoreWrite(ctx, 'set_chapter_music_cues', { chapter: '第33章', cues: [] }), /只能给「第32章」配乐/);
  const a = M.guardMusicScoreWrite(ctx, 'set_chapter_music_cues', { cues: [] });
  assert.equal(a.chapter, '第32章');
  assert.equal(M.musicScoreWritesOfJob(w.p.id, 'jg1').length, 1);
  assert.deepEqual(M.guardMusicScoreWrite(ctx, 'get_chapter', { chapter: 'x' }), { chapter: 'x' }, '读工具不过守卫');
});

test('时间轴：已出片按实测时长、没出片按计划时长并标 planned；起止秒连续', async () => {
  const w = world();
  core.Shots.update(w.a.id, { status: 'done', video_path: 'videos/a.mp4' });
  const tl = await M.chapterTimeline(w.p.id, '第32章', { probe: async () => ({ duration: 6.5 }) });
  assert.equal(tl.shots.length, 2);
  assert.deepEqual([tl.shots[0].start, tl.shots[0].end, tl.shots[1].start, tl.shots[1].end], [0, 6.5, 6.5, 14.5]);
  assert.equal(tl.shots[1].planned, true); assert.equal(tl.planned_shots, 1);
});

test('提交：走写稿队列、Agent 拿到配乐模式和要求、写了配乐就完成', async () => {
  const w = world(); const calls = [];
  const r = submitMusicScoreJob({ projectId: w.p.id, chapter: w.c, requirement: '前半段斗嘴别压苦情曲', runAgentFn: fakeWriter(calls) });
  assert.equal(r.job.type, MUSIC_SCORE_JOB_TYPE); assert.equal(r.lane, 'text');
  assert.ok(await waitFor(() => core.Jobs.get(r.job.id).status === 'done'), core.Jobs.get(r.job.id).status + ' ' + core.Jobs.get(r.job.id).error);
  assert.deepEqual(calls, [{ chapter: '第32章', musicScore: true, musicRequirement: '前半段斗嘴别压苦情曲' }]);
  assert.match(core.Jobs.get(r.job.id).detail, /cue 表写了 1 次.*静音 1 段/);
});

test('提交：Agent 一次配乐都没写 → 失败；同章有任务 → CHAPTER_BUSY', async () => {
  const w = world();
  const r = submitMusicScoreJob({ projectId: w.p.id, chapter: w.c, runAgentFn: async () => {} });
  assert.ok(await waitFor(() => core.Jobs.get(r.job.id).status === 'failed'));
  assert.match(core.Jobs.get(r.job.id).error, /没有写入任何配乐/);
  let release; const hold = new Promise((res) => { release = res; });
  const r2 = submitMusicScoreJob({ projectId: w.p.id, chapter: w.c, runAgentFn: () => hold });
  assert.throws(() => submitMusicScoreJob({ projectId: w.p.id, chapter: w.c, runAgentFn: async () => {} }), (e) => e.code === 'CHAPTER_BUSY');
  release(); await waitFor(() => ['done', 'failed'].includes(core.Jobs.get(r2.job.id).status));
});

test('rules_hold（换规则书）在时：配乐任务排着等、不报错、Agent 不启动；删掉开关后接着跑完', async () => {
  const w = world(); const calls = [];
  fs.mkdirSync(path.dirname(rulesHoldFile()), { recursive: true });
  fs.writeFileSync(rulesHoldFile(), 'test');
  try {
    const r = submitMusicScoreJob({ projectId: w.p.id, chapter: w.c, runAgentFn: fakeWriter(calls) });
    await sleep(200);
    const j = core.Jobs.get(r.job.id);
    assert.equal(j.status, 'queued'); assert.equal(j.error || '', ''); assert.equal(calls.length, 0);
    fs.rmSync(rulesHoldFile());
    assert.ok(await waitFor(() => core.Jobs.get(r.job.id).status === 'done'));
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(rulesHoldFile(), { force: true }); }
});

test('路由：没有外部 Agent 运行时 400；章节不对 404；requirement 不是文本 400', async () => {
  const w = world();
  const call = async (cid, body) => { const r = await POST(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: w.p.id, cid }) }); return { status: r.status, j: await r.json() }; };
  assert.equal((await call('nope', {})).status, 404);
  assert.equal((await call(w.c.id, { requirement: 3 })).status, 400);
  const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); fs.writeFileSync(cfgPath, JSON.stringify({ ...c2, agent: { runtime: 'openclaude' } }));
  try { const r = await call(w.c.id, {}); assert.equal(r.status, 400); assert.equal(r.j.code, 'NO_AGENT'); }
  finally { fs.writeFileSync(cfgPath, JSON.stringify(c2)); }
});
