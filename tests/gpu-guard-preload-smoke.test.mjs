// 预加载守卫冒烟：只在 NODE_OPTIONS 装了 gpu-guard-preload.mjs 时跑（否则跳过，避免真的去连 8188/8189）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
const active = !!globalThis.__icGuardPreload;
const skip = active ? false : '未装预加载守卫（NODE_OPTIONS=--import=.../gpu-guard-preload.mjs）';

function connectErr(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', (e) => resolve(e));
    s.on('connect', () => { s.destroy(); resolve(null); });
  });
}

test('预加载守卫：net.connect 到 8188 / 8189 / 4610 被拦', { skip }, async () => {
  for (const p of [8188, 8189, 4610]) {
    const e = await connectErr(p);
    assert.ok(e, p + ' 应被拦');
    assert.match(e.message, /IC 测试守卫拦截连接/);
  }
});

test('预加载守卫：http.get 与 fetch 到 8189 被拦，IC_CONFIG / IC_DATA_DIR 指向临时目录', { skip }, async () => {
  const e = await new Promise((resolve) => { const r = http.get('http://127.0.0.1:8189/system_stats', () => resolve(null)); r.on('error', resolve); });
  assert.ok(e);
  await assert.rejects(() => fetch('http://127.0.0.1:8188/prompt', { method: 'GET' }));
  assert.ok(process.env.IC_CONFIG && !/^https?:/.test(process.env.IC_CONFIG));
  assert.ok(process.env.IC_DATA_DIR && !/infinite-creation[\\/]data/.test(process.env.IC_DATA_DIR));
});
