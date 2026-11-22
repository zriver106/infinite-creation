// 重写分镜残留旧镜（第19章事故，2026-11-17）：作废 / 恢复 / 合成排除。
// 与 changelog.test.mjs 同法：IC_DATA_DIR 指向临时目录后再动态 import，绝不碰真实 data/ic.db。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shot-retire-'));
process.env.IC_DATA_DIR = TMP;

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { Projects, Chapters, Shots, Jobs, listChanges, rollbackLogs, withWriteContext, chapterStats, DB_PATH } = core;

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkProject(name) {
  return withWriteContext('test:create-project', () => Projects.create({ name }));
}
// 造一章「旧分镜」：n 镜，全部已出片（假的 video_path，不需要真文件）
function seedDoneShots(pid, chapter, n, tag = '旧') {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const s = Shots.create(pid, { chapter, idx: i, visual: tag + '画面' + i, video_prompt: tag + 'prompt' + i, scene_name: '【场景 01】包厢·晚上' });
    Shots.update(s.id, { status: 'done', video_path: 'shots/shot' + i + '_' + tag + '.mp4', video_prompt_used: tag + 'prompt' + i });
    ids.push(s.id);
  }
  return ids;
}
const newBoard = (n, chapter = '第1章') => Array.from({ length: n }, (_, i) => ({ chapter, idx: i + 1, visual: '新画面' + (i + 1), scene_name: '【场景 01】包厢·夜' }));
const chapterShots = (pid, ch = '第1章', opts) => Shots.list(pid, opts).filter((s) => s.chapter === ch);
const assembleList = (pid, ch = '第1章') => Shots.listInNarrativeOrder(pid).filter((s) => s.video_path && s.status === 'done' && s.chapter === ch);

test('DB 落在临时目录', () => { assert.ok(DB_PATH.startsWith(TMP), DB_PATH); });

test('复盘第19章：旧 32 镜 + 任务内整章重写 26 镜 → 27–32 自动作废，不删除，合成/进度只认 26 镜', async () => {
  const p = mkProject('残留镜复盘');
  const oldIds = seedDoneShots(p.id, '第1章', 32);
  await sleep(5);
  const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
  const ctx = createToolRuntime({ projectId: p.id, jobId: job.id, chapter: '第1章' });
  const out = await runTool(ctx, 'set_storyboard', { shots: newBoard(26) });
  assert.match(out, /已作废旧分镜残留 6 镜/);
  assert.match(out, /第27镜/); assert.match(out, /第32镜/);
  // 默认列表 / 合成 / 进度都只剩 26 镜
  assert.equal(chapterShots(p.id).length, 26);
  assert.deepEqual(assembleList(p.id).map((s) => s.idx), Array.from({ length: 26 }, (_, i) => i + 1));
  assert.deepEqual(chapterStats(p.id, '第1章'), { total: 26, done: 26, status: 'done' });
  // 行和视频都还在：includeObsolete 能看到，status=obsolete，video_path 原样
  const all = chapterShots(p.id, '第1章', { includeObsolete: true });
  assert.equal(all.length, 32);
  const obs = all.filter((s) => s.status === 'obsolete');
  assert.deepEqual(obs.map((s) => s.idx), [27, 28, 29, 30, 31, 32]);
  for (const s of obs) { assert.ok(s.video_path.endsWith('_旧.mp4')); assert.match(s.error, /已作废/); }
  assert.deepEqual(obs.map((s) => s.id), oldIds.slice(26));
  // 审计：每条作废都有 action=retire 的日志
  const logs = listChanges(p.id, { action: 'retire', limit: 50 });
  assert.equal(logs.length, 6);
  Jobs.update(job.id, { status: 'done' });
  Projects.remove(p.id);
});

test('作废镜不再被单镜生成；批量生成取不到它', async () => {
  const p = mkProject('作废镜不渲染');
  seedDoneShots(p.id, '第1章', 4);
  const [s4] = chapterShots(p.id).filter((s) => s.idx === 4);
  Shots.retire(s4.id, { reason: '测试' });
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await assert.rejects(() => runTool(ctx, 'generate_shot_video', { shot_id: s4.id }), /已作废/);
  assert.ok(!chapterShots(p.id).some((s) => s.id === s4.id));
  Projects.remove(p.id);
});

test('同一任务里先写满 20 镜、再只改前 10 镜：11–20 不会被误作废，只给提示', async () => {
  const p = mkProject('任务内局部改');
  const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
  await sleep(5);
  const ctx = createToolRuntime({ projectId: p.id, jobId: job.id, chapter: '第1章' });
  await runTool(ctx, 'set_storyboard', { shots: newBoard(20) });
  const out = await runTool(ctx, 'set_storyboard', { shots: newBoard(10) });
  assert.doesNotMatch(out, /已作废旧分镜残留/);
  assert.match(out, /本任务里刚写过或刚生成过/);
  assert.equal(chapterShots(p.id).length, 20);
  Jobs.update(job.id, { status: 'done' });
  Projects.remove(p.id);
});

test('replace_chapter=false 一律不作废；镜号不从 1 连续时不自动作废', async () => {
  const p = mkProject('显式不作废');
  seedDoneShots(p.id, '第1章', 8);
  await sleep(5);
  const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
  const ctx = createToolRuntime({ projectId: p.id, jobId: job.id, chapter: '第1章' });
  const o1 = await runTool(ctx, 'set_storyboard', { shots: newBoard(5), replace_chapter: false });
  assert.match(o1, /replace_chapter=false/);
  assert.equal(chapterShots(p.id).length, 8);
  const o2 = await runTool(ctx, 'set_storyboard', { shots: [{ chapter: '第1章', idx: 3, visual: '只改第3镜' }] });
  assert.match(o2, /不是从 1 连续的整章/);
  assert.equal(chapterShots(p.id).length, 8);
  Jobs.update(job.id, { status: 'done' });
  Projects.remove(p.id);
});

test('不在任务里（无 jobId）：自动规则不作废；replace_chapter=true 才作废', async () => {
  const p = mkProject('无任务');
  seedDoneShots(p.id, '第1章', 6);
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  const o1 = await runTool(ctx, 'set_storyboard', { shots: newBoard(4) });
  assert.match(o1, /判断不了是不是旧镜/);
  assert.equal(chapterShots(p.id).length, 6);
  const o2 = await runTool(ctx, 'set_storyboard', { shots: newBoard(4), replace_chapter: true });
  assert.match(o2, /已作废旧分镜残留 2 镜/);
  assert.deepEqual(chapterShots(p.id).map((s) => s.idx), [1, 2, 3, 4]);
  Projects.remove(p.id);
});

test('replace_chapter=true 遇到正在生成的旧镜：整批拒绝，什么都不写', async () => {
  const p = mkProject('生成中拒绝');
  seedDoneShots(p.id, '第1章', 5);
  const s5 = chapterShots(p.id).find((s) => s.idx === 5);
  Shots.update(s5.id, { status: 'generating' });
  const ctx = createToolRuntime({ projectId: p.id, chapter: '第1章' });
  await assert.rejects(() => runTool(ctx, 'set_storyboard', { shots: newBoard(3), replace_chapter: true }), /正在生成的旧镜/);
  assert.equal(chapterShots(p.id).find((s) => s.idx === 1).visual, '旧画面1', '拒绝时一条都不写');
  assert.throws(() => Shots.retire(s5.id), /正在生成中/);
  Projects.remove(p.id);
});

test('恢复：restore 回到 done；同号已被新镜占用时拒绝；回滚 retire 日志同样能恢复', async () => {
  const p = mkProject('恢复');
  seedDoneShots(p.id, '第1章', 3);
  const s3 = chapterShots(p.id).find((s) => s.idx === 3);
  Shots.retire(s3.id, { reason: 'x' });
  assert.equal(Shots.get(s3.id).status, 'obsolete');
  Shots.restore(s3.id);
  assert.equal(Shots.get(s3.id).status, 'done');
  assert.equal(Shots.get(s3.id).error, '');
  // 回滚 retire 日志
  withWriteContext('test:retire', () => Shots.retire(s3.id, { reason: 'y' }));
  const log = listChanges(p.id, { action: 'retire', limit: 10 }).find((l) => l.entity_id === s3.id && !l.reverted_by);
  const r = rollbackLogs({ projectId: p.id, logId: log.id });
  assert.ok(!r.blocked, JSON.stringify(r));
  assert.equal(Shots.get(s3.id).status, 'done', '回滚 retire 日志要把 status 还原');
  // 同号占用：作废后建一条新的第3镜，再恢复旧的 → 拒绝
  Shots.retire(s3.id);
  Shots.create(p.id, { chapter: '第1章', idx: 3, visual: '新第3镜' });
  assert.throws(() => Shots.restore(s3.id), /已被本章新分镜占用/);
  Projects.remove(p.id);
});

test('章节改名时作废镜跟着迁移', async () => {
  const p = mkProject('改名');
  seedDoneShots(p.id, '第1章', 2);
  const s2 = chapterShots(p.id).find((s) => s.idx === 2);
  Shots.retire(s2.id);
  // 走 db 层模拟路由里的迁移循环
  for (const s of Shots.list(p.id, { includeObsolete: true })) if (s.chapter === '第1章') Shots.update(s.id, { chapter: '第1章·改' });
  assert.equal(Shots.get(s2.id).chapter, '第1章·改');
  Projects.remove(p.id);
});