// 续章守护决策单测（2026-11-17）：纯函数，不碰数据库 / LLM / ComfyUI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVideoGuard, planStoryboardGuard, guardianEnabled, statusClass, isStoryboardLaneJob } from '../lib/agent/chapter-guardian-plan.js';

const titles = (n) => Array.from({ length: n }, (_, k) => '第' + (k + 1) + '章');
let seq = 0;
const job = (chapter, status, extra = {}) => ({ id: 'j' + String(++seq).padStart(7, '0'), type: 'create', status, checkpoint: { chapter, ...(extra.cp || {}) }, ...(extra.top || {}) });
const sb = (chapter, status) => job(chapter, status, { cp: { storyboardOnly: true, queue: 'text' } });

function world({ exported = 11, shots = 30, chapters = 40, video = [true, 30], storyboard = [false, 30], jobs = [] } = {}) {
  return {
    settings: { video: { enabled: video[0], until: video[1] }, storyboard: { enabled: storyboard[0], until: storyboard[1] } },
    chapters: titles(chapters),
    jobs,
    exportedOf: (t) => Number(/\d+/.exec(t)[0]) <= exported,
    shotCountOf: (t) => (Number(/\d+/.exec(t)[0]) <= shots ? 10 : 0),
    chapterBusy: (t) => jobs.some((j) => (j.status === 'running' || j.status === 'queued') && j.checkpoint.chapter === t),
  };
}

test('总开关缺省开，chapterGuardian=false 关', () => {
  assert.equal(guardianEnabled({}, {}), true);
  assert.equal(guardianEnabled({ generation: { chapterGuardian: false } }, {}), false);
  // 启动时带 IC_DISABLE_CHAPTER_GUARDIAN=1：守护不跑，收尾钩子也必须回到旧规则（不能两头落空）
  assert.equal(guardianEnabled({}, { IC_DISABLE_CHAPTER_GUARDIAN: '1' }), false);
  assert.equal(statusClass('interrupted'), 'unknown');
  assert.equal(statusClass('cancelled'), 'failed');
});

test('出片守护：本项目有任务在跑/排队就不续（任何类型）', () => {
  for (const j of [job('第12章', 'running'), sb('第20章', 'queued'), { id: 'x', type: 'prompt-write', status: 'running', checkpoint: { chapter: '第29章' } }]) {
    const r = planVideoGuard(world({ jobs: [j] }));
    assert.equal(r.action, 'skip'); assert.equal(r.code, 'project-busy');
  }
});

test('出片守护：空闲 + 上一章成功 → 只续下一章一章', () => {
  const r = planVideoGuard(world({ jobs: [job('第11章', 'done')] }));
  assert.equal(r.action, 'submit'); assert.equal(r.chapter, '第12章'); assert.equal(r.prev, '第11章');
});

test('出片守护：上一章最近一次出片失败 / 取消 / 不明 → 不续', () => {
  for (const st of ['failed', 'cancelled', 'interrupted']) {
    const r = planVideoGuard(world({ jobs: [job('第11章', st), job('第11章', 'done')] }));
    assert.equal(r.code, 'prev-not-ok', st);
  }
});

test('出片守护：下一章最近一次失败 / 取消 / 结果不明 → 不重复提交', () => {
  assert.equal(planVideoGuard(world({ jobs: [job('第12章', 'failed')] })).code, 'next-failed');
  assert.equal(planVideoGuard(world({ jobs: [job('第12章', 'cancelled')] })).code, 'next-failed');
  assert.equal(planVideoGuard(world({ jobs: [job('第12章', 'interrupted')] })).code, 'next-unknown');
  assert.equal(planVideoGuard(world({ jobs: [job('第12章', 'done')] })).code, 'next-done-no-export');
});

test('出片守护：until / 没有下一章 / 没有基准章', () => {
  assert.equal(planVideoGuard(world({ video: [true, 11] })).code, 'until');
  assert.equal(planVideoGuard(world({ exported: 40, video: [true, 50] })).code, 'no-next');
  assert.equal(planVideoGuard(world({ exported: 0 })).code, 'no-base');
  assert.equal(planVideoGuard(world({ video: [false, 30] })).action, 'off');
});

test('出片守护：模拟 12→30，每次只开一章，且只在上一章成功之后', () => {
  let exported = 11; const jobs = []; const opened = [];
  for (let round = 0; round < 200; round++) {
    const w = world({ exported, jobs });
    const r = planVideoGuard(w);
    if (r.action === 'submit') {
      // 提交后同一轮再查一次必须是 busy（不会一轮开两章）
      const j = job(r.chapter, 'running'); jobs.unshift(j); opened.push(r.chapter);
      assert.equal(planVideoGuard(world({ exported, jobs })).code, 'project-busy');
      const n = Number(/\d+/.exec(r.chapter)[0]);
      assert.equal(n, exported + 1, '只开上一章的下一章');
      if (n === 15) { j.status = 'failed'; continue; } // 第15章失败：之后必须停住
      j.status = 'done'; exported = n;
    }
  }
  assert.deepEqual(opened, ['第12章', '第13章', '第14章', '第15章']);
  assert.equal(planVideoGuard(world({ exported, jobs })).code, 'next-failed');
});

test('分镜守护：只看分镜类任务忙不忙，出片任务在跑也照样续（走文本队列）', () => {
  const w = world({ shots: 13, storyboard: [true, 20], video: [false, 30], jobs: [job('第12章', 'running')] });
  const r = planStoryboardGuard(w);
  assert.equal(r.action, 'submit'); assert.equal(r.chapter, '第14章');
  assert.equal(planStoryboardGuard(world({ shots: 13, storyboard: [true, 20], jobs: [sb('第20章', 'running')] })).code, 'sb-busy');
  assert.equal(planStoryboardGuard(world({ shots: 13, storyboard: [true, 20], jobs: [{ id: 'p', type: 'prompt-write', status: 'queued', checkpoint: { chapter: '第3章' } }] })).code, 'sb-busy');
  assert.equal(isStoryboardLaneJob({ type: 'stage', checkpoint: {} }), true);
  assert.equal(isStoryboardLaneJob(job('第1章', 'running')), false);
});

test('分镜守护：上一章还在跑 / 上一章拆分镜失败 / 下一章失败或不明 → 不续', () => {
  const base = { shots: 13, storyboard: [true, 20] };
  assert.equal(planStoryboardGuard(world({ ...base, jobs: [job('第13章', 'running')] })).code, 'prev-busy');
  assert.equal(planStoryboardGuard(world({ ...base, jobs: [sb('第13章', 'failed')] })).code, 'prev-not-ok');
  assert.equal(planStoryboardGuard(world({ ...base, jobs: [sb('第14章', 'cancelled')] })).code, 'next-failed');
  assert.equal(planStoryboardGuard(world({ ...base, jobs: [sb('第14章', 'interrupted')] })).code, 'next-unknown');
  assert.equal(planStoryboardGuard(world({ ...base, jobs: [job('第14章', 'queued')] })).code, 'next-busy');
  assert.equal(planStoryboardGuard(world({ ...base, storyboard: [true, 13] })).code, 'until');
});

test('V2 现状：分镜到第30章、出片到第11章、until 30 → 分镜守护停在 until，出片守护被第12章任务挡住', () => {
  const jobs = [job('第12章', 'running'), job('第11章', 'done')];
  const w = world({ exported: 11, shots: 30, storyboard: [true, 30], video: [true, 30], jobs });
  assert.equal(planStoryboardGuard(w).code, 'until');
  assert.equal(planVideoGuard(w).code, 'project-busy');
  jobs[0].status = 'interrupted'; // 重启打断、恢复还没接手：结果不明，不重复提交
  assert.equal(planVideoGuard(world({ exported: 11, shots: 30, storyboard: [true, 30], jobs })).code, 'next-unknown');
  jobs[0].status = 'done';
  const r = planVideoGuard(world({ exported: 12, shots: 30, storyboard: [true, 30], jobs }));
  assert.equal(r.action, 'submit'); assert.equal(r.chapter, '第13章');
});

test('验证章（非「第N章」标题、排在最后）不参与找上一章 / 下一章', () => {
  const w = world({ shots: 13, exported: 13, storyboard: [true, 14], video: [true, 14] });
  w.chapters = [...w.chapters, '第2章_Q门槛验证_20261116', '串音验证_3镜'];
  const sc = w.shotCountOf; w.shotCountOf = (t) => (/验证/.test(t) ? 5 : sc(t));
  const ex = w.exportedOf; w.exportedOf = (t) => (/验证/.test(t) ? true : ex(t));
  assert.equal(planStoryboardGuard(w).chapter, '第14章');
  assert.equal(planVideoGuard(w).chapter, '第14章');
  // 跳号：没有第14章 → 不跳到第15章
  w.chapters = w.chapters.filter((t) => t !== '第14章');
  assert.equal(planVideoGuard(w).code, 'no-next');
});
