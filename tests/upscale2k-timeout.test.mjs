// 2026-11-26（升2K 会话报、主会话 seq2031）：IC 等满 6 小时判的超时失败，留着 remote_task_id 的，重排时接回原火山任务，不重新提交（不重复扣费）。
// 覆盖两种：本次上线前已存盘的旧文案（transient 未标）、上线后新文案（transient=true）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up2k-timeout-'));
let gets = 0; let posts = 0;
const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
    gets++;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ status: 'failed', task_id: req.url.split('/').pop(), error: { message: 'mock 火山失败' } }));
  }
  posts++;
  res.statusCode = 500; res.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.IC_DATA_DIR = tmp;
process.env.IC_VOLC_MEDIAKIT_BASE = 'http://127.0.0.1:' + srv.address().port;
process.env.IC_UPSCALE_POLL_MS = '200';
const { projectDir } = await import('../lib/core/config.js');
const ex = path.join(projectDir('p1'), 'exports');
fs.mkdirSync(ex, { recursive: true });
fs.writeFileSync(path.join(ex, 'old.mp4'), 'x');
fs.writeFileSync(path.join(ex, 'new.mp4'), 'x');
const now = new Date().toISOString();
const base = { projectId: 'p1', target: '', provider: 'volc', status: 'failed', client_token: 'ct', params: {}, created_at: now, updated_at: now, finished_at: now };
fs.writeFileSync(path.join(tmp, 'upscale2k-tasks.json'), JSON.stringify([
  { ...base, id: 'up_old', source: 'old.mp4', error: '火山任务超过 6 小时未完成', remote_task_id: 'r_old' },
  { ...base, id: 'up_new', source: 'new.mp4', error: '火山任务超过 6 小时未完成（IC 停止等待，火山任务可能仍在处理；重排会接回原任务）', transient: true, remote_task_id: 'r_new' },
]));
const m = await import('../lib/core/upscale2k.js');
after(() => srv.close());

test('超时失败的任务重排：接回原火山任务（旧文案、新文案都接），不重新上传或提交', async () => {
  m.saveUpscaleSettings({ provider: 'volc', volc: { apiKey: 'unit-test-key', concurrency: 2 } });
  const r = await m.enqueueUpscale('p1', ['old.mp4', 'new.mp4']);
  assert.deepEqual(r.tasks.map((t) => t.id).sort(), ['up_new', 'up_old'], '应接着原任务，不新开');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ts = m.listUpscaleTasks('p1');
    if (ts.every((t) => t.status === 'failed' && /mock 火山失败/.test(t.error))) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const ts = m.listUpscaleTasks('p1');
  assert.ok(ts.every((t) => /mock 火山失败/.test(t.error)), JSON.stringify(ts.map((t) => t.error)));
  assert.equal(ts.find((t) => t.id === 'up_old').remote_task_id, 'r_old');
  assert.equal(ts.find((t) => t.id === 'up_old').remote_status, 'failed', '查过原火山任务，状态已落盘');
  assert.ok(gets >= 2);
  assert.equal(posts, 0, '没有重新上传或提交，不重复计费');
});
