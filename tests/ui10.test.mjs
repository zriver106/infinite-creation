// 界面十项（12_界面五项 + 13_分镜按钮）里纯逻辑部分的单测。只 import 零依赖模块，不碰数据库、不提交任务。
// 交付复制只在 os.tmpdir()（%TEMP%）下新建的测试目录里写，绝不碰真正的交付目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planAutoNext, planAutoChain } from '../lib/agent/auto-chain-plan.js';
import { decideStoryboardLane, jobQueueOf, isLocalUrl } from '../lib/agent/queue-lane.js';
import {
  chapterNumberFromTitle, readAutoNextSettings, readDeliverySettings, stripUiContextKeys, parseUntilInput, UI_CONTEXT_KEYS,
} from '../lib/core/project-ui-settings.js';
import { deliverFileToDir, validateDeliveryDir } from '../lib/core/delivery-copy.js';

// ---------------- 章号 / 设置 ----------------

test('章号只认整个标题「第N章」', () => {
  assert.equal(chapterNumberFromTitle('第1章'), 1);
  assert.equal(chapterNumberFromTitle(' 第13章 '), 13);
  assert.equal(chapterNumberFromTitle('第 3 章'), 3);
  assert.equal(chapterNumberFromTitle('第2章_心声验证'), null);
  assert.equal(chapterNumberFromTitle('串音验证_3镜'), null);
  assert.equal(chapterNumberFromTitle('第01章'), null);
  assert.equal(chapterNumberFromTitle('第0章'), null);
  assert.equal(chapterNumberFromTitle(''), null);
  assert.equal(chapterNumberFromTitle(null), null);
});

test('自动续章设置：缺省不勾、到第 13 章为止；非法值回退 13', () => {
  assert.deepEqual(readAutoNextSettings({ context: {} }), { video: { enabled: false, until: 13 }, storyboard: { enabled: false, until: 13 } });
  const s = readAutoNextSettings({ context: { auto_next: true, auto_next_until: 5, auto_next_storyboard: 'yes', auto_next_storyboard_until: -1 } });
  assert.deepEqual(s, { video: { enabled: true, until: 5 }, storyboard: { enabled: false, until: 13 } });
  assert.equal(parseUntilInput('7'), 7);
  assert.equal(parseUntilInput(0), null);
  assert.equal(parseUntilInput(2.5), null);
});

test('交付设置：启用缺省为 true，目录缺省为空', () => {
  assert.deepEqual(readDeliverySettings({ context: {} }), { dir: '', enabled: true });
  assert.deepEqual(readDeliverySettings({ context: { delivery_dir: ' C:\\x ', delivery_enabled: false } }), { dir: 'C:\\x', enabled: false });
});

test('get_project 交给模型前剔掉界面键', () => {
  const ctx = { bible: 'b', style: 's', continuity: 'c' };
  for (const k of UI_CONTEXT_KEYS) ctx[k] = 'x';
  assert.deepEqual(stripUiContextKeys(ctx), { bible: 'b', style: 's', continuity: 'c' });
  assert.equal(ctx.delivery_dir, 'x'); // 不改原对象
});

// ---------------- 自动续章决策 ----------------

const TITLES = ['第1章', '第2章', '第3章', '第4章', '串音验证_3镜'];

function input(over = {}) {
  const base = {
    finished: { kind: 'video', status: 'done', chapter: '第1章', ok: true },
    settings: { video: { enabled: true, until: 13 }, storyboard: { enabled: false, until: 13 } },
    chapters: TITLES,
    shotCountOf: () => 0,
    exportedOf: () => false,
    lastVideoJobDone: () => false,
    chapterBusy: () => false,
    projectBusy: false,
    otherProjectsBusy: false,
  };
  return { ...base, ...over, finished: { ...base.finished, ...(over.finished || {}) }, settings: { ...base.settings, ...(over.settings || {}) } };
}

test('视频队列：出片成功 → 对下一章走单章 /run（无剧本的章也照常续）', () => {
  const p = planAutoNext(input());
  assert.equal(p.action, 'submit');
  assert.equal(p.kind, 'video');
  assert.equal(p.chapter, '第2章');
});

test('视频队列：取消 / 失败 / 没出片 都停', () => {
  assert.equal(planAutoNext(input({ finished: { status: 'cancelled' } })).action, 'stop');
  assert.equal(planAutoNext(input({ finished: { status: 'failed' } })).action, 'stop');
  assert.equal(planAutoNext(input({ finished: { ok: false, okReason: '本次任务没有合成出新成片' } })).action, 'stop');
});

test('视频队列：没勾就什么都不做；中途取消勾选（收尾时读到 false）同理', () => {
  const p = planAutoNext(input({ settings: { video: { enabled: false, until: 13 } } }));
  assert.equal(p.action, 'none');
});

test('视频队列：刚完成章号 >= until 就停；下一章超过 until 也停', () => {
  assert.equal(planAutoNext(input({ finished: { chapter: '第3章' }, settings: { video: { enabled: true, until: 3 } } })).action, 'stop');
  assert.equal(planAutoNext(input({ finished: { chapter: '第2章' }, settings: { video: { enabled: true, until: 3 } } })).chapter, '第3章');
});

test('视频队列：下一章不存在 / 不是「第N章」/ 已出过片 / 有任务 / 项目或其它项目忙 都停', () => {
  assert.equal(planAutoNext(input({ chapters: ['第1章'] })).action, 'stop');
  assert.equal(planAutoNext(input({ finished: { chapter: '第4章' } })).action, 'stop'); // 下一章是「串音验证_3镜」
  assert.equal(planAutoNext(input({ exportedOf: (t) => t === '第2章' })).action, 'stop');
  assert.equal(planAutoNext(input({ chapterBusy: (t) => t === '第2章' })).action, 'stop');
  assert.equal(planAutoNext(input({ projectBusy: true })).action, 'stop');
  assert.equal(planAutoNext(input({ otherProjectsBusy: true })).action, 'stop');
});

test('视频队列：刚完成的章名不是「第N章」就停（防止闯进实验章）', () => {
  const p = planAutoNext(input({ chapters: ['第1章', '第2章_心声验证', '第3章'], finished: { chapter: '第2章_心声验证' } }));
  assert.equal(p.action, 'stop');
});

const SB = { video: { enabled: false, until: 13 }, storyboard: { enabled: true, until: 13 } };

test('分镜队列：分镜成功 → 下一章只拆分镜；已有分镜的章跳过、绝不重拆', () => {
  const p = planAutoNext(input({ settings: SB, finished: { kind: 'storyboard', chapter: '第1章' }, shotCountOf: (t) => (t === '第2章' ? 10 : 0) }));
  assert.equal(p.action, 'submit');
  assert.equal(p.kind, 'storyboard');
  assert.equal(p.chapter, '第3章');
});

test('分镜队列：取消 / 失败 / 没写出分镜 / 没勾 / 到上限 / 没有下一章 都停', () => {
  const f = { kind: 'storyboard', chapter: '第1章' };
  assert.equal(planAutoNext(input({ settings: SB, finished: { ...f, status: 'cancelled' } })).action, 'stop');
  assert.equal(planAutoNext(input({ settings: SB, finished: { ...f, ok: false } })).action, 'stop');
  assert.equal(planAutoNext(input({ settings: { video: { enabled: false, until: 13 }, storyboard: { enabled: false, until: 13 } }, finished: f })).action, 'none');
  assert.equal(planAutoNext(input({ settings: { video: { enabled: false, until: 13 }, storyboard: { enabled: true, until: 1 } }, finished: f })).action, 'stop');
  assert.equal(planAutoNext(input({ settings: SB, chapters: ['第1章'], finished: f })).action, 'stop');
  assert.equal(planAutoNext(input({ settings: SB, finished: f, projectBusy: true })).action, 'stop');
});

test('分镜队列：后面全有分镜直到上限 → 停（不会越过 until）', () => {
  const p = planAutoNext(input({
    settings: { video: { enabled: false, until: 13 }, storyboard: { enabled: true, until: 3 } },
    finished: { kind: 'storyboard', chapter: '第1章' },
    shotCountOf: (t) => (t === '第2章' || t === '第3章' ? 5 : 0),
  }));
  assert.equal(p.action, 'stop');
});

const BOTH = { video: { enabled: true, until: 13 }, storyboard: { enabled: true, until: 13 } };

test('两个都勾：分镜完成的章，若前一章已出片且最近出片成功 → 先交给视频队列', () => {
  const p = planAutoNext(input({
    settings: BOTH,
    finished: { kind: 'storyboard', chapter: '第3章' },
    exportedOf: (t) => t === '第2章',
    lastVideoJobDone: (t) => t === '第2章',
    shotCountOf: (t) => (t === '第3章' ? 8 : 0),
  }));
  assert.equal(p.action, 'submit');
  assert.equal(p.kind, 'video');
  assert.equal(p.chapter, '第3章');
});

test('两个都勾：前一章没出片（视频队列不在这里）→ 分镜队列继续往后拆', () => {
  const p = planAutoNext(input({
    settings: BOTH,
    finished: { kind: 'storyboard', chapter: '第3章' },
    shotCountOf: (t) => (t === '第3章' ? 8 : 0),
  }));
  assert.equal(p.kind, 'storyboard');
  assert.equal(p.chapter, '第4章');
});

test('两个都勾：前一章已到视频的 until → 不交给视频队列', () => {
  const p = planAutoNext(input({
    settings: { video: { enabled: true, until: 2 }, storyboard: { enabled: true, until: 13 } },
    finished: { kind: 'storyboard', chapter: '第3章' },
    exportedOf: (t) => t === '第2章',
    lastVideoJobDone: (t) => t === '第2章',
  }));
  assert.equal(p.kind, 'storyboard');
});

test('两个都勾：出片完成后下一章正被分镜任务占着 → 视频队列这次不提交（交给分镜完成时接上）', () => {
  const p = planAutoNext(input({ settings: BOTH, chapterBusy: (t) => t === '第2章' }));
  assert.equal(p.action, 'stop');
});

test('只勾分镜：出片任务结束不触发任何续章', () => {
  const p = planAutoNext(input({ settings: SB }));
  assert.equal(p.action, 'none');
});

// ---------------- 双队列：续章决策（dual=true） ----------------

const DUAL = { dual: true, videoQueueBusy: false, textQueueBusy: false };
const kinds = (p) => p.submits.map((x) => x.kind + ':' + x.chapter).sort();

test('双队列·两个都勾：分镜完成且前一章已出片 → 同时交视频队列（本章）和分镜队列（下一章）', () => {
  const p = planAutoChain(input({
    ...DUAL,
    settings: BOTH,
    finished: { kind: 'storyboard', chapter: '第3章' },
    exportedOf: (t) => t === '第2章',
    lastVideoJobDone: (t) => t === '第2章',
    shotCountOf: (t) => (t === '第3章' ? 8 : 0),
  }));
  assert.deepEqual(kinds(p), ['storyboard:第4章', 'video:第3章']);
});

test('双队列·两个都勾：视频队列忙不挡分镜队列；分镜队列忙不挡视频队列', () => {
  const sb = planAutoChain(input({ ...DUAL, videoQueueBusy: true, settings: BOTH, finished: { kind: 'storyboard', chapter: '第1章' } }));
  assert.deepEqual(kinds(sb), ['storyboard:第2章']);
  const vd = planAutoChain(input({ ...DUAL, textQueueBusy: true, settings: BOTH, shotCountOf: (t) => (t === '第2章' ? 6 : 0) }));
  assert.deepEqual(kinds(vd), ['video:第2章']);
});

test('双队列·两个都勾：出片完成，下一章分镜已完成 → 视频队列接下一章', () => {
  const p = planAutoChain(input({ ...DUAL, settings: BOTH, shotCountOf: (t) => (t === '第2章' ? 6 : 0) }));
  assert.deepEqual(kinds(p), ['video:第2章']);
});

test('双队列·两个都勾：出片完成，下一章还没分镜 → 视频队列不接；分镜队列空闲就先把它交给分镜队列', () => {
  const idle = planAutoChain(input({ ...DUAL, settings: BOTH }));
  assert.deepEqual(kinds(idle), ['storyboard:第2章']);
  const busy = planAutoChain(input({ ...DUAL, textQueueBusy: true, settings: BOTH }));
  assert.equal(busy.submits.length, 0);
  assert.equal(busy.stops.length, 1);
});

test('双队列·两个都勾：下一章最近一次拆分镜失败（分镜未完成）→ 视频队列不接', () => {
  const p = planAutoChain(input({ ...DUAL, settings: BOTH, shotCountOf: (t) => (t === '第2章' ? 3 : 0), storyboardReady: () => false }));
  assert.equal(p.submits.length, 0);
});

test('双队列·只勾视频：下一章没分镜也照常 /run（整章正常生成流程，和之前一样）', () => {
  const p = planAutoChain(input({ ...DUAL }));
  assert.deepEqual(kinds(p), ['video:第2章']);
});

test('双队列·分镜队列：跳过正有任务（正在出片）/已有分镜/已出片的章，绝不重拆', () => {
  const p = planAutoChain(input({
    ...DUAL,
    settings: SB,
    finished: { kind: 'storyboard', chapter: '第1章' },
    chapterBusy: (t) => t === '第2章',
    exportedOf: (t) => t === '第3章',
  }));
  assert.deepEqual(kinds(p), ['storyboard:第4章']);
});

test('双队列·两条链各自受自己的「到第 __ 章为止」', () => {
  const p = planAutoChain(input({
    ...DUAL,
    settings: { video: { enabled: true, until: 3 }, storyboard: { enabled: true, until: 3 } },
    finished: { kind: 'storyboard', chapter: '第3章' },
    exportedOf: (t) => t === '第2章',
    lastVideoJobDone: (t) => t === '第2章',
    shotCountOf: (t) => (t === '第3章' ? 8 : 0),
  }));
  assert.deepEqual(kinds(p), ['video:第3章']); // 分镜链到第 3 章为止 → 不再拆第 4 章
  assert.ok(p.stops.some((s) => s.chain === '自动生成下一章分镜'));
});

test('单队列退化（dual=false）：两个都勾时一次只提交一个，GPU 优先（与双队列之前一致）', () => {
  const p = planAutoChain(input({
    settings: BOTH,
    finished: { kind: 'storyboard', chapter: '第3章' },
    exportedOf: (t) => t === '第2章',
    lastVideoJobDone: (t) => t === '第2章',
    shotCountOf: (t) => (t === '第3章' ? 8 : 0),
  }));
  assert.deepEqual(kinds(p), ['video:第3章']);
});

// ---------------- 双队列：哪条队列 ----------------

test('分镜任务进哪条队列：远程 LLM / 云端 CLI 进文本队列；本机 LLM、未知 CLI、总开关关、RunningHub 队列都回到视频队列', () => {
  assert.equal(decideStoryboardLane({ agent: { runtime: 'claude' }, llm: { baseUrl: 'http://127.0.0.1:8080' } }).lane, 'text');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'openclaude' }, llm: { baseUrl: 'https://api.deepseek.com' } }).lane, 'text');
  assert.equal(decideStoryboardLane({ llm: { baseUrl: 'http://127.0.0.1:8080/v1' } }).lane, 'gpu');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'openclaude' }, llm: { baseUrl: 'localhost:11434' } }).lane, 'gpu');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'opencode' } }).lane, 'gpu');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'custom' } }).lane, 'gpu');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'claude' }, generation: { storyboardQueue: false } }).lane, 'gpu');
  assert.equal(decideStoryboardLane({ agent: { runtime: 'claude' } }, true).lane, 'gpu');
  assert.equal(isLocalUrl('https://api.deepseek.com'), false);
  assert.equal(jobQueueOf({ checkpoint: { queue: 'text' } }), 'text');
  assert.equal(jobQueueOf({ checkpoint: { storyboardOnly: true } }), 'gpu'); // 双队列之前提交的
});

// ---------------- 双队列：闸门（硬条件：文本任务碰显卡必须重新过渲染闸门） ----------------
// render-gate 会 import config.js：先把配置/数据目录指到 %TEMP% 下的测试目录，绝不读写真正的 config.json / data。

const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-gate-test-'));
fs.writeFileSync(path.join(gateTmp, 'config.json'), JSON.stringify({ generation: { videoQueueTimeoutMinutes: 1 } }));
process.env.IC_CONFIG = path.join(gateTmp, 'config.json');
process.env.IC_DATA_DIR = path.join(gateTmp, 'data');
const rg = await import('../lib/core/render-gate.js');

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时：' + what)), ms))]);

test('闸门：分镜任务（文本闸门）和出片任务（任务闸门）可以同时跑', async () => {
  const video = deferred();
  const events = [];
  const v = rg.runExclusiveVideo(async () => { events.push('video:start'); await video.promise; events.push('video:end'); }, () => false, { jobId: 'v1' });
  const t = rg.runExclusiveText(async () => { events.push('text:start'); }, () => false, { jobId: 't1' });
  await withTimeout(t, 1000, '文本任务应在出片进行中就跑完');
  assert.deepEqual(events, ['video:start', 'text:start']);
  video.resolve();
  await v;
});

test('闸门：文本闸门容量 1', async () => {
  const a = deferred();
  const events = [];
  const t1 = rg.runExclusiveText(async () => { events.push('t1'); await a.promise; }, () => false, { jobId: 't-a' });
  const t2 = rg.runExclusiveText(async () => { events.push('t2'); }, () => false, { jobId: 't-b', queueTimeoutMs: 5000 });
  await tick();
  assert.deepEqual(events, ['t1']);
  a.resolve();
  await Promise.all([t1, t2]);
  assert.deepEqual(events, ['t1', 't2']);
});

test('硬条件：文本任务里碰显卡（withGpuAccess）要等出片任务释放任务闸门，绝不同时', async () => {
  const video = deferred();
  const events = [];
  let videoRunning = false;
  const v = rg.runExclusiveVideo(async () => { videoRunning = true; events.push('video:start'); await video.promise; videoRunning = false; events.push('video:end'); }, () => false, { jobId: 'v2' });
  const t = rg.runExclusiveText(async () => {
    events.push('text:start');
    await rg.withGpuAccess(async () => {
      assert.equal(videoRunning, false, '借显卡时出片任务必须已经结束');
      events.push('text:gpu');
    }, { what: '测试出图' });
    events.push('text:end');
  }, () => false, { jobId: 't2' });
  await tick(30);
  assert.deepEqual(events, ['video:start', 'text:start']); // 文本任务在等闸门
  video.resolve();
  await Promise.all([v, t]);
  assert.deepEqual(events, ['video:start', 'text:start', 'video:end', 'text:gpu', 'text:end']);
});

test('硬条件：文本任务借着显卡时，新来的出片任务排在后面；借用结束后出片任务不被当成文本任务（不死锁）', async () => {
  const gpu = deferred();
  const events = [];
  const t = rg.runExclusiveText(() => rg.withGpuAccess(async () => { events.push('text:gpu:start'); await gpu.promise; events.push('text:gpu:end'); }), () => false, { jobId: 't3' });
  await tick();
  const v = rg.runExclusiveVideo(async () => {
    events.push('video:start');
    // 出片任务内部的 GPU 调用必须直接放行（若错继承了文本通道上下文，会再去抢自己占着的任务闸门 → 死锁）
    await rg.withGpuAccess(async () => { events.push('video:gpu'); });
  }, () => false, { jobId: 'v3', queueTimeoutMs: 5000 });
  await tick();
  assert.deepEqual(events, ['text:gpu:start']);
  gpu.resolve();
  await withTimeout(Promise.all([t, v]), 2000, '出片任务应在借用结束后正常跑完');
  assert.deepEqual(events, ['text:gpu:start', 'text:gpu:end', 'video:start', 'video:gpu']);
});

test('硬条件：上下文丢失时按 jobId 认出文本任务，照样排队借闸门', async () => {
  const video = deferred();
  const events = [];
  const v = rg.runExclusiveVideo(async () => { events.push('video:start'); await video.promise; events.push('video:end'); }, () => false, { jobId: 'v4' });
  const inLane = deferred();
  const t = rg.runExclusiveText(async () => { inLane.resolve(); await tick(60); }, () => false, { jobId: 't4' });
  await inLane.promise;
  // 在文本通道外（测试顶层）带 jobId 调用，模拟 SDK 丢了 AsyncLocalStorage 上下文
  const g = rg.withGpuAccess(async () => { events.push('t4:gpu'); }, { jobId: 't4' });
  await tick();
  assert.deepEqual(events, ['video:start']);
  video.resolve();
  await Promise.all([v, g, t]);
  assert.deepEqual(events, ['video:start', 'video:end', 't4:gpu']);
});

test('最后一道硬闸：文本通道里没借到显卡时，写 ComfyUI 的请求直接拒绝；只读 GET 放行；借到后放行', async () => {
  await rg.runExclusiveText(async () => {
    assert.throws(() => rg.assertGpuHttpAllowed('POST', 'http://127.0.0.1:8189/prompt'), /不能使用显卡/);
    assert.throws(() => rg.assertGpuHttpAllowed('POST', 'http://127.0.0.1:8189/free'), /不能使用显卡/);
    rg.assertGpuHttpAllowed('GET', 'http://127.0.0.1:8189/history/x');
    await rg.withGpuAccess(async () => { rg.assertGpuHttpAllowed('POST', 'http://127.0.0.1:8189/prompt'); });
  }, () => false, { jobId: 't5' });
  rg.assertGpuHttpAllowed('POST', 'http://127.0.0.1:8189/prompt'); // 文本通道外（出片任务 / 路由）不受影响
});

test('文本任务的 MCP 子进程（IC_MCP_RENDER_DISABLED=1）：碰显卡一律拒绝', async () => {
  const old = process.env.IC_MCP_RENDER_DISABLED;
  process.env.IC_MCP_RENDER_DISABLED = '1';
  try {
    let ran = false;
    await assert.rejects(rg.withGpuAccess(async () => { ran = true; }, { what: '测试' }), (e) => e.code === 'TEXT_LANE_GPU_DENIED');
    assert.equal(ran, false);
    assert.throws(() => rg.assertGpuHttpAllowed('POST', 'http://127.0.0.1:8189/upload/image'), /不能使用显卡/);
  } finally {
    if (old === undefined) delete process.env.IC_MCP_RENDER_DISABLED; else process.env.IC_MCP_RENDER_DISABLED = old;
  }
});

test('取消：排队中的文本任务能从文本闸门摘掉', async () => {
  const a = deferred();
  const t1 = rg.runExclusiveText(() => a.promise, () => false, { jobId: 't-hold' });
  const t2 = rg.runExclusiveText(async () => 'never', () => false, { jobId: 't-cancel', queueTimeoutMs: 5000 });
  await tick();
  assert.equal(rg.cancelQueuedJob('t-cancel'), true);
  await assert.rejects(t2, /排队中/);
  a.resolve();
  await t1;
  await tick(); // 槽位在 withSlot 的 finally 里归还，比 promise 落定晚一拍
  const st = rg.renderGateStats();
  assert.equal(st.textSlots, 0);
  assert.equal(st.jobSlots, 0);
});

// ---------------- 交付复制（只在 %TEMP% 下） ----------------

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-delivery-test-'));
  const dir = path.join(root, '交付');
  fs.mkdirSync(dir);
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  return { root, dir, src };
}

function fakeMp4(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(content));
  return p;
}

test('交付：首次写 EP1.mp4，sha 等于成片', async () => {
  const w = tmpWorld();
  try {
    const a = fakeMp4(w.src, 'a.mp4', 'fake-mp4-A-' + 'x'.repeat(3000));
    const r = await deliverFileToDir({ deliveryDir: w.dir, ep: 1, srcAbs: a, now: new Date(2026, 10, 16, 18, 0, 0) });
    assert.equal(r.ok, true, r.error);
    assert.equal(sha(fs.readFileSync(path.join(w.dir, 'EP1.mp4'))), r.sourceSha);
    assert.equal(r.finalSha, r.sourceSha);
    assert.equal(r.archivePath, '');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('交付：覆盖前先把旧 EP1 归档到交付目录外面（11-28），归档 sha = 旧件；交付目录里不多出东西、别的文件一概不动', async () => {
  const w = tmpWorld();
  const arch = path.join(w.root, '交付归档');
  try {
    const old = fakeMp4(w.dir, 'EP1.mp4', 'old-EP1');
    const oldSha = sha(fs.readFileSync(old));
    const others = { 'readme.txt': 'r', 'EP1_v10_候选.mp4': 'cand', 'EP01.mp4': 'zero-one' };
    for (const [n, c] of Object.entries(others)) fakeMp4(w.dir, n, c);
    const b = fakeMp4(w.src, 'b.mp4', 'new-EP1-content');
    const before = fs.readdirSync(w.dir).sort();
    const r = await deliverFileToDir({ deliveryDir: w.dir, ep: 1, srcAbs: b, archiveDir: arch, now: new Date(2026, 10, 16, 18, 1, 2) });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.previousSha, oldSha);
    assert.equal(r.archivePath, path.join(arch, 'EP1_20261116-180102.mp4'));
    assert.deepEqual(fs.readdirSync(w.dir).sort(), before, '交付目录里只有原来那些文件，没有历史候选等子目录');
    assert.equal(sha(fs.readFileSync(r.archivePath)), oldSha);
    assert.equal(sha(fs.readFileSync(path.join(w.dir, 'EP1.mp4'))), sha(Buffer.from('new-EP1-content')));
    for (const [n, c] of Object.entries(others)) assert.equal(fs.readFileSync(path.join(w.dir, n), 'utf8'), c);
    // 目录里没有残留临时文件
    assert.deepEqual(fs.readdirSync(w.dir).filter((n) => n.includes('ic-tmp')), []);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('交付：内容相同 → 不归档不覆盖，算成功', async () => {
  const w = tmpWorld();
  try {
    fakeMp4(w.dir, 'EP2.mp4', 'same');
    const s = fakeMp4(w.src, 's.mp4', 'same');
    const r = await deliverFileToDir({ deliveryDir: w.dir, ep: 2, srcAbs: s, archiveDir: path.join(w.root, '交付归档') });
    assert.equal(r.ok, true);
    assert.equal(r.unchanged, true);
    assert.equal(fs.existsSync(path.join(w.root, '交付归档')), false);
    assert.equal(fs.existsSync(path.join(w.dir, '历史候选')), false);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('交付：归档目标已存在 / 没给归档目录 / 归档目录在交付目录里 → 失败，EP 文件保持原样', async () => {
  const w = tmpWorld();
  const arch = path.join(w.root, '交付归档');
  try {
    fakeMp4(w.dir, 'EP3.mp4', 'old3');
    const now = new Date(2026, 10, 16, 18, 2, 3);
    fs.mkdirSync(arch, { recursive: true });
    fakeMp4(arch, 'EP3_20261116-180203.mp4', 'occupied');
    const s = fakeMp4(w.src, 's.mp4', 'new3');
    const r = await deliverFileToDir({ deliveryDir: w.dir, ep: 3, srcAbs: s, archiveDir: arch, now });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'archive');
    assert.equal(fs.readFileSync(path.join(w.dir, 'EP3.mp4'), 'utf8'), 'old3');
    assert.equal(fs.readFileSync(path.join(arch, 'EP3_20261116-180203.mp4'), 'utf8'), 'occupied');
    const noArch = await deliverFileToDir({ deliveryDir: w.dir, ep: 3, srcAbs: s, now });
    assert.equal(noArch.ok, false); assert.match(noArch.error, /archiveDir/);
    const inside = await deliverFileToDir({ deliveryDir: w.dir, ep: 3, srcAbs: s, archiveDir: path.join(w.dir, '历史候选'), now });
    assert.equal(inside.ok, false); assert.match(inside.error, /不能在交付目录里/);
    assert.equal(fs.readFileSync(path.join(w.dir, 'EP3.mp4'), 'utf8'), 'old3');
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});

test('交付：目录不存在 / 相对路径 / 成片不存在 / 非法章号 → 失败，不建目录', async () => {
  const w = tmpWorld();
  try {
    const s = fakeMp4(w.src, 's.mp4', 'x');
    const missing = path.join(w.root, 'nope');
    assert.equal((await deliverFileToDir({ deliveryDir: missing, ep: 1, srcAbs: s })).ok, false);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(validateDeliveryDir('relative\\dir').ok, false);
    assert.equal((await deliverFileToDir({ deliveryDir: w.dir, ep: 1, srcAbs: path.join(w.src, 'none.mp4') })).ok, false);
    assert.equal((await deliverFileToDir({ deliveryDir: w.dir, ep: 0, srcAbs: s })).ok, false);
    assert.deepEqual(fs.readdirSync(w.dir), []);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
});
