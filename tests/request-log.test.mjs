// 提交类 API 请求日志：只记录、不拦截；读头失败或 logger 抛错不能影响调用方。
// 临时数据目录 + 临时配置 + 8188/8189 守卫；不碰真实 ic.db、不提交 GPU。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-request-log-'));
writeTempIcConfig(tmp);

let core;
before(async () => {
  core = await import('../lib/core/index.js');
});

function captureInfo() {
  const logs = [];
  const orig = core.logger.info;
  core.logger.info = (msg, extra) => { logs.push({ msg, extra }); };
  return {
    logs,
    restore() { core.logger.info = orig; },
  };
}

describe('logSubmitRequest', () => {
  test('记录时间以外的约定字段：IP、UA、章节、镜头、X-Caller、job id；X-Caller 空也记', () => {
    const cap = captureInfo();
    try {
      const req = new Request('http://127.0.0.1/api/projects/p1/run', {
        method: 'POST',
        headers: {
          'x-ic-remote-ip': '127.0.0.1',
          'user-agent': 'unit-test-ua',
          'x-caller': '',
        },
      });
      core.logSubmitRequest(req, {
        route: 'POST /api/projects/:id/run',
        projectId: 'p1',
        chapter: '第1章',
        shots: ['s1', 's2'],
        jobId: 'job-1',
      });
      assert.equal(cap.logs.length, 1);
      assert.equal(cap.logs[0].msg, '提交请求');
      const e = cap.logs[0].extra;
      assert.equal(e.route, 'POST /api/projects/:id/run');
      assert.equal(e.projectId, 'p1');
      assert.equal(e.chapter, '第1章');
      assert.deepEqual(e.shots, ['s1', 's2']);
      assert.equal(e.jobId, 'job-1');
      assert.deepEqual(e.jobIds, ['job-1']);
      assert.equal(e.ip, '127.0.0.1');
      assert.equal(e.userAgent, 'unit-test-ua');
      assert.equal(e.caller, '');
    } finally {
      cap.restore();
    }
  });

  test('优先用 server 盖写的 x-ic-remote-ip，不信客户端 X-Forwarded-For；Node IncomingMessage 头也能读', () => {
    const cap = captureInfo();
    try {
      const req = {
        headers: {
          'x-ic-remote-ip': '10.0.0.8',
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
          'user-agent': 'node-ua',
          'x-caller': 'openclaude-agent',
        },
      };
      core.logSubmitRequest(req, {
        route: 'POST /api/projects/:id/stages',
        projectId: 'p2',
        chapter: '第2章',
        jobIds: ['a', 'b'],
      });
      const e = cap.logs[0].extra;
      assert.equal(e.ip, '10.0.0.8');
      assert.equal(e.caller, 'openclaude-agent');
      assert.equal(e.userAgent, 'node-ua');
      assert.equal(e.jobId, 'a');
      assert.deepEqual(e.jobIds, ['a', 'b']);
    } finally {
      cap.restore();
    }
  });

  test('没有盖写头时回退 X-Forwarded-For 首项', () => {
    assert.equal(core.requestIp({ headers: { 'x-forwarded-for': ' 8.8.8.8, 9.9.9.9' } }), '8.8.8.8');
    assert.equal(core.requestIp({ headers: { 'x-real-ip': '9.9.9.9' } }), '9.9.9.9');
    assert.equal(core.requestCaller({ headers: {} }), '');
  });

  test('logger 抛错或残缺 req 不能向外抛', () => {
    const orig = core.logger.info;
    core.logger.info = () => { throw new Error('log boom'); };
    try {
      assert.doesNotThrow(() => core.logSubmitRequest(null, { route: 'x', jobId: 'j' }));
      assert.doesNotThrow(() => core.logSubmitRequest({ headers: { get() { throw new Error('hdr'); } } }, { route: 'x' }));
    } finally {
      core.logger.info = orig;
    }
  });
});
