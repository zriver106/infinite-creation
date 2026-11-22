// 导出路由 POST /api/projects/:id/export 的 HTTP 测试（B_v2，2026-11-18）：起一个本机临时 HTTP 服务，
// 把请求交给 route.js 的 POST（与 Next 的 app router 同一个签名），从 HTTP 层验证 cue 表在导出时生效。
// 临时数据目录 + 临时配置（IC_CONFIG=:9 + 8188/8189/4610 守卫）；不启动 IC、不碰 ComfyUI、不碰真实 ic.db。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-export-http-'));
writeTempIcConfig(tmp);

// route.js 用 Next 的 '@/…' 别名和 'next/server'：测试里按 jsconfig.json 的 paths 解析（'@/*' → 仓库根）。
const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

describe('POST /api/projects/:id/export（HTTP）', { concurrency: 1, skip: hasFfmpeg ? false : '本机没有 ffmpeg' }, () => {
  let core, POST, server, base;
  before(async () => {
    core = await import('../lib/core/index.js');
    ({ POST } = await import('../app/api/projects/[id]/export/route.js'));
    server = http.createServer(async (req, res) => {
      try {
        const m = /^\/api\/projects\/([^/?]+)\/export(?:\?.*)?$/.exec(req.url);
        if (!m || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const request = new Request('http://127.0.0.1' + req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
        const r = await POST(request, { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.writeHead(599); res.end(String(e && e.stack || e)); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const maxDb = (f, ss, t) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', String(t), '-i', f, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
    return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200;
  };
  function mkProject({ cues }) {
    const p = core.Projects.create({ name: '导出 HTTP 测试', auto_script: false, enable_subtitles: false });
    const ch = core.Chapters.create(p.id, { title: '测试章', script: 'x' });
    core.ensureProjectDirs(p.id); // 与 POST /api/projects 建项目时一致：建好 exports/ 等子目录
    const dir = core.projectDir(p.id);
    const rel = (r) => { fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true }); return r; };
    for (const [i, name] of ['a.mp4', 'b.mp4'].entries()) {
      ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(dir, rel('videos/' + name))]);
      core.Shots.create(p.id, { chapter: '测试章', idx: i + 1, duration: 3, video_path: 'videos/' + name, status: 'done' });
    }
    // 主曲 2.5 秒粉噪 + 0.6 秒数字静音：成片 6 秒，主曲要循环（B_v2 交叉淡化，不硬接）
    ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.5:duration=2.5:sample_rate=44100', '-af', 'apad=pad_dur=0.6', '-c:a', 'pcm_s16le', path.join(dir, rel('assets/music/main.wav'))]);
    const m = core.Assets.create(p.id, { category: 'music', name: '主曲' });
    core.Assets.update(m.id, { audio_path: 'assets/music/main.wav', status: 'done' });
    core.Chapters.update(ch.id, { music_path: 'assets/music/main.wav', music_prompt: JSON.stringify({ caption: '情绪类别：压抑', music_id: m.id, music_name: '主曲', ...(cues ? { cues } : {}) }) });
    return p;
  }
  const post = (pid, body) => fetch(base + '/api/projects/' + encodeURIComponent(pid) + '/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('按章导出：cue 表生效（静音段无 BGM、之后主曲进来），HTTP 200 + export_path 落盘', async () => {
    const p = mkProject({ cues: [{ start: 0, end: 2, music_id: 'silence', fade_in: 0, fade_out: 0 }] });
    const r = await post(p.id, { chapter: '测试章' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.music, true);
    assert.equal(j.shots, 2);
    const out = core.resolveProjectPath(p.id, j.export_path);
    assert.ok(fs.existsSync(out), '导出文件存在');
    assert.ok(maxDb(out, 0.2, 1.5) < -60, '静音 cue 段没有 BGM');
    assert.ok(maxDb(out, 3.2, 2.5) > -50, '静音段后主曲（循环）照常垫入');
  });

  test('没有 cue 表：整章一首照旧（HTTP 200，有 BGM）', async () => {
    const p = mkProject({ cues: null });
    const r = await post(p.id, { chapter: '测试章' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.ok(maxDb(core.resolveProjectPath(p.id, j.export_path), 0.5, 1) > -50);
  });

  test('章节没有已完成镜头：HTTP 400', async () => {
    const p = mkProject({ cues: null });
    const r = await post(p.id, { chapter: '不存在的章' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /没有已完成的镜头/);
  });
});
