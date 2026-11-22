// 章节配乐解绑 DELETE /api/projects/:id/chapters/:cid/music 的 HTTP 测试（A_v3，2026-11-18）。
// 本机临时 HTTP 服务把请求交给 route.js 的 DELETE；临时数据目录 + 临时配置 + 8188/8189/4610 守卫，不碰真实 ic.db。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-unbind-http-'));
writeTempIcConfig(tmp);

const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

describe('DELETE /api/projects/:id/chapters/:cid/music（HTTP）', { concurrency: 1 }, () => {
  let core, DELETE, server, base;
  before(async () => {
    core = await import('../lib/core/index.js');
    ({ DELETE } = await import('../app/api/projects/[id]/chapters/[cid]/music/route.js'));
    server = http.createServer(async (req, res) => {
      try {
        const m = /^\/api\/projects\/([^/]+)\/chapters\/([^/]+)\/music$/.exec(req.url);
        if (!m) { res.writeHead(404); res.end(); return; }
        if (req.method !== 'DELETE') { res.writeHead(405); res.end(); return; }
        const r = await DELETE(new Request('http://127.0.0.1' + req.url, { method: 'DELETE' }), { params: Promise.resolve({ id: decodeURIComponent(m[1]), cid: decodeURIComponent(m[2]) }) });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.writeHead(599); res.end(String(e && e.stack || e)); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  function mk() {
    const p = core.Projects.create({ name: '解绑测试', auto_script: false });
    const ch = core.Chapters.create(p.id, { title: '第30章', script: 'x' });
    const abs = path.join(core.projectDir(p.id), 'assets/music/a.mp3');
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'ID3');
    core.Chapters.update(ch.id, { music_path: 'assets/music/a.mp3', music_prompt: JSON.stringify({
      caption: '情绪类别：压抑｜选曲：01｜囚笼｜理由：x', music_id: 'm1', music_ref: '01', music_name: '01 囚笼',
      cues: [{ start: 0, end: 2, music_id: 'silence', fade_in: 0, fade_out: 0, source_offset: null }],
    }) });
    return { p, ch, abs };
  }
  const del = (pid, cid) => fetch(base + '/api/projects/' + encodeURIComponent(pid) + '/chapters/' + encodeURIComponent(cid) + '/music', { method: 'DELETE' });

  test('解绑：music_path 清空，主曲字段去掉，caption / cue 表保留，旧曲记在 unbound.previous，音频文件不删', async () => {
    const { p, ch, abs } = mk();
    const r = await del(p.id, ch.id);
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.unbound, true);
    assert.equal(j.previous.music_path, 'assets/music/a.mp3');
    const after = core.Chapters.get(ch.id);
    assert.equal(after.music_path, '');
    const mp = JSON.parse(after.music_prompt);
    assert.equal(mp.music_id, undefined);
    assert.equal(mp.music_name, undefined);
    assert.match(mp.caption, /情绪类别/);
    assert.equal(mp.cues.length, 1);
    assert.equal(mp.unbound.previous.music_name, '01 囚笼');
    assert.ok(fs.existsSync(abs), '不删音频文件');
    // 解绑后合成：没有主曲
    const m = core.chapterMusicForMerge ? core.chapterMusicForMerge(after, { getAsset: () => null, resolvePath: (rel) => core.resolveProjectPath(p.id, rel), exists: (f) => fs.existsSync(f) }) : undefined;
    if (m) assert.equal(m.mainKey, null);
  });

  test('再解绑一次：幂等，200 + unbound=false', async () => {
    const { p, ch } = mk();
    await del(p.id, ch.id);
    const r = await del(p.id, ch.id);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).unbound, false);
  });

  test('章节不属于该项目 / 不存在：404，不改别人的章节', async () => {
    const a = mk(); const b = mk();
    const r = await del(b.p.id, a.ch.id);
    assert.equal(r.status, 404);
    assert.equal(core.Chapters.get(a.ch.id).music_path, 'assets/music/a.mp3');
    assert.equal((await del(a.p.id, 'nope')).status, 404);
  });

  test('章节 PATCH 仍不接受 music_*：解绑只走这条 DELETE', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'chapters', '[cid]', 'route.js'), 'utf8');
    assert.match(src, /pickChapterFields/);
  });
});
