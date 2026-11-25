// 2026-11-25：升级2K 网络瞬断（ECONNRESET）不再整条判失败；失败过且已有火山 task_id 的，重排时接着查原任务，不重新提交（不重复计费）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up2k-retry-'));
let gets = 0; let posts = 0;
const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/v1/tasks/')) {
    gets++;
    if (gets === 1) { req.socket.destroy(); return; } // 第一次查进度：连接被重置
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ status: 'failed', error: { message: 'mock 火山失败' } }));
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
fs.writeFileSync(path.join(ex, 'a.mp4'), 'x');
const now = new Date().toISOString();
fs.writeFileSync(path.join(tmp, 'upscale2k-tasks.json'), JSON.stringify([{ id: 'up_old', projectId: 'p1', source: 'a.mp4', target: '', provider: 'volc', status: 'failed', error: 'read ECONNRESET', remote_task_id: 'r1', client_token: 'ct', params: {}, created_at: now, updated_at: now, finished_at: now }]));
const m = await import('../lib/core/upscale2k.js');
after(() => srv.close());

test('isTransientError：网络瞬断、超时、5xx 算瞬断；火山任务失败不算', () => {
  assert.equal(m.isTransientError({ message: 'read ECONNRESET' }), true);
  assert.equal(m.isTransientError({ code: 'ETIMEDOUT', message: '' }), true);
  assert.equal(m.isTransientError({ message: '火山接口 /x 返回错误：HTTP 502 bad gateway' }), true);
  assert.equal(m.isTransientError({ message: '火山任务失败：码率不支持' }), false);
});

test('瞬断失败过的任务重排：复用原火山任务、不重新提交；查进度遇到 ECONNRESET 会重试', async () => {
  m.saveUpscaleSettings({ provider: 'volc', volc: { apiKey: 'unit-test-key' } });
  const r = await m.enqueueUpscale('p1', ['a.mp4']);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].id, 'up_old', '应接着原任务，不新开');
  const deadline = Date.now() + 10_000;
  let t;
  while (Date.now() < deadline) {
    t = m.listUpscaleTasks('p1').find((x) => x.id === 'up_old');
    if (t && t.status === 'failed') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(t.status, 'failed');
  assert.match(t.error, /mock 火山失败/, '第一次 ECONNRESET 被重试过，最后拿到的是火山真实状态');
  assert.equal(gets, 2);
  assert.equal(posts, 0, '没有重新上传或提交，不重复计费');
});
