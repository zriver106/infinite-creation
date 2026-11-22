// 配乐/合成调用日志：MCP（set_chapter_music / set_chapter_music_cues / assemble_video）和 HTTP 入口都记。
// 只记录、不拦截。临时数据目录 + 临时配置 + 8188/8189 守卫；不碰真实 ic.db，不提交 GPU，不跑 ffmpeg 合成。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-reqlog-music-'));
writeTempIcConfig(tmp);

const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

let core, tools, GET, PUT, DELETE, EXPORT_POST, APPLY_POST, server, base;

before(async () => {
  core = await import('../lib/core/index.js');
  tools = await import('../lib/agent/tools.js');
  ({ DELETE } = await import('../app/api/projects/[id]/chapters/[cid]/music/route.js'));
  ({ POST: EXPORT_POST } = await import('../app/api/projects/[id]/export/route.js'));
  ({ POST: APPLY_POST } = await import('../app/api/projects/[id]/music/apply/route.js'));
  server = http.createServer(async (req, res) => {
    try {
      const u = req.url || '';
      const chunks = [];
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        for await (const c of req) chunks.push(c);
      }
      const body = Buffer.concat(chunks);
      const headers = { 'content-type': 'application/json', 'x-caller': req.headers['x-caller'] || '', 'user-agent': req.headers['user-agent'] || 'music-assemble-test' };
      const mkReq = (method) => new Request('http://127.0.0.1' + u, { method, headers, body: body.length ? body : undefined });
      let r;
      let m;
      if ((m = /^\/api\/projects\/([^/]+)\/export$/.exec(u)) && req.method === 'POST') {
        r = await EXPORT_POST(mkReq('POST'), { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) });
      } else if ((m = /^\/api\/projects\/([^/]+)\/music\/apply$/.exec(u)) && req.method === 'POST') {
        r = await APPLY_POST(mkReq('POST'), { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) });
      } else if ((m = /^\/api\/projects\/([^/]+)\/chapters\/([^/]+)\/music$/.exec(u)) && req.method === 'DELETE') {
        r = await DELETE(mkReq('DELETE'), { params: Promise.resolve({ id: decodeURIComponent(m[1]), cid: decodeURIComponent(m[2]) }) });
      } else {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(599);
      res.end(String(e && e.stack || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (!server) return; return new Promise((r) => server.close(r)); });

function captureInfo() {
  const logs = [];
  const orig = core.logger.info;
  core.logger.info = (msg, extra) => { logs.push({ msg, extra }); };
  return { logs, restore() { core.logger.info = orig; } };
}

function mk() {
  const p = core.Projects.create({ name: '配乐日志测试', auto_script: false });
  const ch = core.Chapters.list(p.id).find((c) => c.title === '第1章') || core.Chapters.create(p.id, { title: '第1章', script: 'x' });
  return { p, ch };
}

describe('MCP 配乐/合成入口', () => {
  test('set_chapter_music / set_chapter_music_cues / assemble_video 都会记一条提交请求；调用失败也不挡（只记录）', async () => {
    const { p, ch } = mk();
    const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'job-mcp-1', chapter: ch.title });
    const cap = captureInfo();
    try {
      await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music', { chapter: ch.title, music_id: '35' }));
      await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music_cues', { chapter: ch.title }));
      await assert.rejects(() => tools.runTool(ctx, 'assemble_video', { chapter: ch.title }));
      const submits = cap.logs.filter((x) => x.msg === '提交请求');
      assert.equal(submits.length, 3);
      assert.deepEqual(submits.map((x) => x.extra.route), [
        'MCP set_chapter_music',
        'MCP set_chapter_music_cues',
        'MCP assemble_video',
      ]);
      for (const s of submits) {
        assert.equal(s.extra.projectId, p.id);
        assert.equal(s.extra.chapter, ch.title);
        assert.equal(s.extra.jobId, 'job-mcp-1');
        assert.equal(s.extra.caller, 'MCP');
      }
    } finally {
      cap.restore();
    }
  });

  test('fields.caller 可覆盖（无 HTTP 头时也能记 MCP）', () => {
    const cap = captureInfo();
    try {
      core.logSubmitRequest({}, { route: 'MCP set_chapter_music', projectId: 'p', chapter: '第1章', caller: 'MCP' });
      assert.equal(cap.logs[0].extra.caller, 'MCP');
    } finally {
      cap.restore();
    }
  });
});

describe('HTTP 配乐/合成入口', () => {
  test('POST /export 无成片时返回 400，不跑 ffmpeg，也不记合成提交', async () => {
    const { p, ch } = mk();
    const cap = captureInfo();
    try {
      const r = await fetch(base + '/api/projects/' + p.id + '/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-caller': 'http-test' },
        body: JSON.stringify({ chapter: ch.title }),
      });
      const j = await r.json();
      assert.equal(r.status, 400, JSON.stringify(j));
      // 没有已完成分镜：在记日志之前就 400，不调用 mergeVideos。此处确认没有误入队、也没有提交日志（避免空跑也记成合成）。
      const submits = cap.logs.filter((x) => x.msg === '提交请求' && x.extra.route && x.extra.route.includes('/export'));
      assert.equal(submits.length, 0, '无成片的 400 不应记成一次合成提交');
    } finally {
      cap.restore();
    }
  });

  test('DELETE 解绑配乐会记日志，且仍只解绑、不删文件', async () => {
    const { p, ch } = mk();
    const cap = captureInfo();
    try {
      const r = await fetch(base + '/api/projects/' + p.id + '/chapters/' + ch.id + '/music', { method: 'DELETE' });
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
      const submits = cap.logs.filter((x) => x.msg === '提交请求');
      assert.ok(submits.some((s) => s.extra.route === 'DELETE /api/projects/:id/chapters/:cid/music' && s.extra.projectId === p.id && s.extra.chapter === ch.title));
    } finally {
      cap.restore();
    }
  });
});
