// 2026-11-26（Andy「不涉及 gpu 的改动都可以同步去做」；主会话 seq2121）：提示词撰写闸门可并行，换规则书开关挡新任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pwrite-'));
process.env.IC_DATA_DIR = tmp;
process.env.IC_RULES_HOLD_POLL_MS = '30';
const { installGpuGuard, writeTempIcConfig } = await import('./helpers/gpu-guard.mjs');
installGpuGuard(); writeTempIcConfig(tmp);
const g = await import('../lib/core/render-gate.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

test('容量：promptWriteConcurrency 默认 3、上限 8；runParallelText 同时最多 limit 个', async () => {
  assert.equal(g.promptWriteConcurrency({}), 3);
  assert.equal(g.promptWriteConcurrency({ generation: { promptWriteConcurrency: 20 } }), 8);
  assert.equal(g.promptWriteConcurrency({ generation: { promptWriteConcurrency: 0 } }), 3);
  let now = 0; let max = 0; const ds = [deferred(), deferred(), deferred()];
  const runs = ds.map((d, i) => g.runParallelText(async () => { now++; max = Math.max(max, now); await d.p; now--; return i; }, () => false, { limit: 2, jobId: 'pw' + i }));
  await sleep(50);
  assert.equal(now, 2, '第三个在排队');
  ds[0].resolve(); await sleep(50);
  assert.equal(now, 2, '空出一个就放进下一个');
  ds[1].resolve(); ds[2].resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.equal(max, 2);
});

test('规则书开关：打开后新写稿排着等、已在写的照常写完；删掉文件后接着跑', async () => {
  const running = deferred(); let firstDone = false;
  const first = g.runParallelText(async () => { await running.p; firstDone = true; return 'a'; }, () => false, { limit: 3, jobId: 'pwA' });
  await sleep(20);
  fs.writeFileSync(g.rulesHoldFile(), 'test');
  assert.equal(g.rulesHoldOn(), true);
  const states = []; let secondStarted = false;
  const second = g.runParallelText(async () => { secondStarted = true; return 'b'; }, () => false, { limit: 3, jobId: 'pwB', onQueue: (s) => states.push(s) });
  await sleep(120);
  assert.equal(secondStarted, false, '开关打开时新任务不开跑');
  assert.deepEqual(states, ['queued']);
  running.resolve();
  assert.equal(await first, 'a', '已经在写的照常写完');
  assert.equal(firstDone, true);
  assert.equal(secondStarted, false);
  fs.rmSync(g.rulesHoldFile());
  assert.equal(await second, 'b', '删掉开关后接着跑');
  assert.deepEqual(states, ['queued', 'running']);
});

test('开关打开时停止排着的任务：不开跑，按停止处理', async () => {
  fs.writeFileSync(g.rulesHoldFile(), 'test');
  let aborted = false; let started = false;
  const p = g.runParallelText(async () => { started = true; }, () => aborted, { limit: 3, jobId: 'pwC' });
  await sleep(60);
  aborted = true;
  fs.rmSync(g.rulesHoldFile());
  await p.catch(() => {});
  assert.equal(started, false);
});
