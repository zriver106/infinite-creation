// 守卫冒烟：必须在其它单测之前单独跑。拦截 8188/8189，不提交渲染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installGpuGuard, blockedUrl } from './helpers/gpu-guard.mjs';

installGpuGuard();

test('守卫会拦截 8188 和 8189', async () => {
  assert.equal(blockedUrl('http://127.0.0.1:8188/prompt'), true);
  assert.equal(blockedUrl('http://127.0.0.1:8189/prompt'), true);
  assert.equal(blockedUrl('http://127.0.0.1:9/prompt'), false);
  await assert.rejects(() => fetch('http://127.0.0.1:8189/prompt'), /守卫拦截/);
  await assert.rejects(() => fetch('http://127.0.0.1:8188/upload/image'), /守卫拦截/);
  assert.throws(() => http.request({ host: '127.0.0.1', port: 8189, path: '/prompt' }), /守卫拦截/);
});
