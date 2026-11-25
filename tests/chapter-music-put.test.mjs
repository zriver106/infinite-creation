// 续轮12快（总导 00:35）：PUT /api/projects/:id/chapters/:cid/music —— 把章节主曲绑回素材库已有曲目，写进变更日志。
// 临时数据目录 + 临时配置 + 8188/8189/4610 守卫，不碰真实 ic.db。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-music-put-'));
writeTempIcConfig(tmp);
const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

describe('PUT 章节配乐', { concurrency: 1 }, () => {
  let core, PUT, p, ch, good;
  const call = async (body) => {
    const r = await PUT(new Request('http://x/', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id: p.id, cid: ch.id }) });
    return { status: r.status, json: await r.json() };
  };
  before(async () => {
    core = await import('../lib/core/index.js');
    ({ PUT } = await import('../app/api/projects/[id]/chapters/[cid]/music/route.js'));
    const { Projects, Chapters, Assets, withWriteContext, projectDir } = core;
    p = withWriteContext('test', () => Projects.create({ name: '配乐PUT' }));
    ch = Chapters.list(p.id)[0] || withWriteContext('test', () => Chapters.create(p.id, { title: '第1章' }));
    good = 'assets/music/01-囚笼_x.mp3';
    fs.mkdirSync(path.join(projectDir(p.id), 'assets', 'music'), { recursive: true });
    fs.writeFileSync(path.join(projectDir(p.id), good), 'x');
    const a = withWriteContext('test', () => Assets.create(p.id, { category: 'music', name: '01-囚笼' }));
    withWriteContext('test', () => Assets.update(a.id, { audio_path: good }));
    withWriteContext('test', () => Chapters.update(ch.id, { music_path: 'assets/music/17-other.mp3', music_prompt: '{"caption":"旧"}' }));
  });

  test('非法路径 / 库里没有 / 文件不存在 → 400，不改', async () => {
    for (const mp of ['../x.mp3', 'C:/x.mp3', 'assets/other/x.mp3', 'assets/music/none.mp3', 'assets/music/x.txt']) {
      const r = await call({ music_path: mp });
      assert.equal(r.status, 400, mp + ' ' + JSON.stringify(r.json));
    }
    assert.equal(core.Chapters.get(ch.id).music_path, 'assets/music/17-other.mp3');
  });

  test('合法 → 写入 music_path + music_prompt，变更日志有一条带前后值', async () => {
    const r = await call({ music_path: good, music_prompt: '{"caption":"默认 01 囚笼","music_ref":"01"}' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = core.Chapters.get(ch.id);
    assert.equal(c.music_path, good);
    assert.equal(JSON.parse(c.music_prompt).music_ref, '01');
    const logs = core.listChanges(p.id, { entity: 'chapter', limit: 20 }).filter((l) => l.source === 'PUT /api/projects/:id/chapters/:cid/music');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].before.music_path, 'assets/music/17-other.mp3');
    assert.equal(logs[0].after.music_path, good);
  });

  test('只改 music_path（易变字段）也记日志', async () => {
    core.withWriteContext('test', () => core.Chapters.update(ch.id, { music_path: 'assets/music/17-other.mp3' }));
    const r = await call({ music_path: good });
    assert.equal(r.status, 200);
    const logs = core.listChanges(p.id, { entity: 'chapter', limit: 20 }).filter((l) => l.source === 'PUT /api/projects/:id/chapters/:cid/music');
    assert.equal(logs.length, 2);
  });
});
