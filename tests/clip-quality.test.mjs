// 第三批提案：出片质量闸门（lib/core/clip-quality.js + tools.js renderShotCandidate 接线）单测。
// 纯函数部分不需要 ffmpeg；取帧器用假实现注入。集成部分用 ffmpeg lavfi 在临时目录现造 2 秒小片（CPU），
// ComfyUI 用 mock fetch，不起真进程、不碰 8188/8189/4610。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLIP_QUALITY_DEFAULTS, resolveClipQualityOptions, frameStats, sampleTimes, judgeClip, checkClipQuality, guardClipQuality,
} from '../lib/core/clip-quality.js';

const W = 160, H = 90;
const flat = (v = 120, jitter = 0) => { const b = Buffer.alloc(W * H); for (let i = 0; i < b.length; i++) b[i] = v + (jitter ? ((i * 7919) % (2 * jitter + 1)) - jitter : 0); return b; };
const gradient = () => { const b = Buffer.alloc(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[y * W + x] = Math.round((x / (W - 1)) * 200 + 20); return b; };
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const noise = () => { const b = Buffer.alloc(W * H); for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256); return b; };

describe('clip-quality 纯函数', () => {
  test('frameStats：纯色 std=0；渐变 std 大、相邻差/std 小；白噪声相邻差/std ≈ 1.1', () => {
    assert.equal(frameStats(flat(130), W, H).std, 0);
    const g = frameStats(gradient(), W, H);
    assert.ok(g.std > 50, 'gradient std ' + g.std);
    assert.ok(g.adjRatio < 0.1, 'gradient adjRatio ' + g.adjRatio);
    const n = frameStats(noise(), W, H);
    assert.ok(n.std > 60);
    assert.ok(n.adjRatio > 1.0 && n.adjRatio < 1.3, 'noise adjRatio ' + n.adjRatio);
    const tex = frameStats(flat(110, 4), W, H);
    assert.ok(tex.std > 1 && tex.std < 10, '棕灰细纹理 std ' + tex.std);
  });

  test('sampleTimes：取各段中点；时长未知取 0', () => {
    assert.deepEqual(sampleTimes(10, 5), [1, 3, 5, 7, 9]);
    assert.deepEqual(sampleTimes(0, 5), [0]);
  });

  test('judgeClip：摩天轮坏镜实测（std 1.4–3.3）→ bad/flat', () => {
    const r = judgeClip([3.28, 2.9, 3.11, 2.8, 2.7].map((std) => ({ std, adjRatio: 0.5 })));
    assert.equal(r.verdict, 'bad');
    assert.equal(r.kind, 'flat');
    assert.match(r.reason, /近纯色\/灰场/);
    assert.match(r.reason, /< 10/);
  });

  test('judgeClip：A1/V2 正常镜（std 30–80）→ ok', () => {
    assert.equal(judgeClip([48, 52, 65, 61, 33].map((std) => ({ std, adjRatio: 0.2 }))).verdict, 'ok');
  });

  test('judgeClip：2/5 帧暗场（如淡入/夜景黑场）不拦，3/5 才拦', () => {
    const mk = (arr) => arr.map((std) => ({ std, adjRatio: 0.2 }));
    assert.equal(judgeClip(mk([4, 5, 40, 50, 45])).verdict, 'ok');
    assert.equal(judgeClip(mk([4, 5, 6, 50, 45])).verdict, 'bad');
  });

  test('judgeClip：噪点片（std 正常、相邻差/std ≥ 0.9）→ bad/noise', () => {
    const r = judgeClip([1.1, 1.12, 1.09, 1.1, 1.13].map((adjRatio, i) => ({ std: 70 + i, adjRatio })));
    assert.equal(r.verdict, 'bad');
    assert.equal(r.kind, 'noise');
  });

  test('judgeClip：低对比（10 ≤ std < 20）只记观察', () => {
    const r = judgeClip([12, 14, 15, 18, 13].map((std) => ({ std, adjRatio: 0.3 })));
    assert.equal(r.verdict, 'watch');
  });

  test('judgeClip：阈值可配', () => {
    const s = [12, 14, 15, 18, 13].map((std) => ({ std, adjRatio: 0.3 }));
    assert.equal(judgeClip(s, { minStd: 20 }).verdict, 'bad');
    assert.equal(judgeClip([4, 5, 40, 50, 45].map((std) => ({ std, adjRatio: 0.2 })), { badFraction: 0.4 }).verdict, 'bad');
  });

  test('resolveClipQualityOptions：false 关闭；对象覆盖；非法值忽略', () => {
    assert.equal(resolveClipQualityOptions(false).enabled, false);
    assert.equal(resolveClipQualityOptions(undefined).enabled, true);
    assert.equal(resolveClipQualityOptions(undefined).minStd, CLIP_QUALITY_DEFAULTS.minStd);
    const o = resolveClipQualityOptions({ minStd: 8, samples: 99, failOpen: false, watchStd: 'x' });
    assert.equal(o.minStd, 8);
    assert.equal(o.samples, 20);
    assert.equal(o.failOpen, false);
    assert.equal(o.watchStd, CLIP_QUALITY_DEFAULTS.watchStd);
  });
});

describe('clip-quality 取帧器注入（不调 ffmpeg）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cq-unit-'));
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  const sampler = (frames, dur = 13) => {
    const calls = [];
    return { calls, duration: async () => dur, grayFrame: async (_abs, t) => { calls.push(t); return frames[calls.length - 1] || frames[frames.length - 1]; } };
  };

  test('checkClipQuality：5 帧灰场 → bad，按 13 秒均匀取 5 帧', async () => {
    const s = sampler([flat(110, 3)]);
    const r = await checkClipQuality('x.mp4', {}, s);
    assert.equal(r.verdict, 'bad');
    assert.deepEqual(s.calls, [1.3, 3.9, 6.5, 9.1, 11.7]);
  });

  test('guardClipQuality：坏片 → ok=false，写 _quality.json 与 logs/clip-quality.jsonl，原片不动', async () => {
    fs.mkdirSync(path.join(tmp, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'shots', 'shot1_aa.mp4'), 'orig');
    const r = await guardClipQuality({ projectDirAbs: tmp, relPath: 'shots/shot1_aa.mp4', shotInfo: { label: '第1章 第1镜' }, sampler: sampler([flat(110, 3)]) });
    assert.equal(r.ok, false);
    assert.equal(r.record.verdict, 'bad');
    assert.ok(fs.existsSync(path.join(tmp, 'shots', 'shot1_aa_quality.json')));
    assert.equal(fs.readFileSync(path.join(tmp, 'shots', 'shot1_aa.mp4'), 'utf8'), 'orig');
    const lines = fs.readFileSync(path.join(tmp, 'logs', 'clip-quality.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).verdict, 'bad');
  });

  test('guardClipQuality：正常片 → ok=true，不写 sidecar', async () => {
    fs.writeFileSync(path.join(tmp, 'shots', 'shot2_bb.mp4'), 'orig');
    const r = await guardClipQuality({ projectDirAbs: tmp, relPath: 'shots/shot2_bb.mp4', sampler: sampler([gradient()]) });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(tmp, 'shots', 'shot2_bb_quality.json')), false);
  });

  test('guardClipQuality：取帧出错默认放行（failOpen），可配成拦', async () => {
    const bad = { duration: async () => { throw new Error('ffprobe 启动失败'); }, grayFrame: async () => null };
    const a = await guardClipQuality({ projectDirAbs: tmp, relPath: 'shots/x.mp4', sampler: bad });
    assert.equal(a.ok, true);
    assert.equal(a.record.verdict, 'error');
    const b = await guardClipQuality({ projectDirAbs: tmp, relPath: 'shots/y.mp4', sampler: bad, opts: { failOpen: false } });
    assert.equal(b.ok, false);
  });

  test('guardClipQuality：关闭时不取帧', async () => {
    const s = sampler([flat(110, 3)]);
    const r = await guardClipQuality({ projectDirAbs: tmp, relPath: 'shots/z.mp4', sampler: s, opts: { enabled: false } });
    assert.equal(r.ok, true);
    assert.equal(s.calls.length, 0);
  });
});

// —— 集成：renderShotCandidate 接线（mock ComfyUI 返回 ffmpeg 现造的小片）——
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
describe('出片质量闸门接线（generate_chapter_videos）', { concurrency: 1, skip: hasFfmpeg ? false : '本机没有 ffmpeg' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cq-int-'));
  let core, tools;
  const clips = {};
  before(async () => {
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' },
      comfyui: { baseUrl: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9', provider: 'native' },
      generation: { videosPerShot: 1, refLeakGuard: false },
      agent: { runtime: 'openclaude' },
    }));
    process.env.IC_DATA_DIR = path.join(tmp, 'data');
    process.env.IC_CONFIG = cfgPath;
    process.env.IC_ASSET_PRECHECK = 'off';
    core = await import('../lib/core/index.js');
    tools = await import('../lib/agent/tools.js');
    const mk = (name, src) => {
      const f = path.join(tmp, name + '.mp4');
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      clips[name] = fs.readFileSync(f);
    };
    mk('grey', 'color=c=0x75695c:s=320x180:r=24,noise=alls=4:allf=t');
    mk('good', 'testsrc2=s=320x180:r=24');
  });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  class DummyWS { constructor() {} close() {} set onmessage(_) {} }
  function mockComfy(bytes) {
    const origFetch = globalThis.fetch, origWS = globalThis.WebSocket;
    const calls = [];
    let n = 0;
    globalThis.WebSocket = DummyWS;
    globalThis.fetch = async (url, opts) => {
      const u = String(url); const method = (opts && opts.method) || 'GET';
      calls.push({ url: u, method });
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/upload/')) return json({ name: 'x.png', subfolder: '', type: 'input' });
      if (u.includes('/prompt') && method !== 'GET') { n += 1; return json({ prompt_id: 'pid-cq-' + n }); }
      if (u.includes('/history/')) {
        const pid = u.split('/history/')[1].split('?')[0];
        return json({ [pid]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { '9': { videos: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } } } });
      }
      if (u.includes('/view') || u.includes('filename=')) return new Response(bytes, { status: 200 });
      if (u.endsWith('/queue') && method === 'GET') return json({ queue_running: [], queue_pending: [] });
      return json({});
    };
    return { calls, restore: () => { globalThis.fetch = origFetch; globalThis.WebSocket = origWS; } };
  }
  function mkShot(name) {
    const { Projects, Assets, Shots, projectDir } = core;
    const p = Projects.create({ name });
    const rel = 'assets/character/x.png';
    fs.mkdirSync(path.dirname(path.join(projectDir(p.id), rel)), { recursive: true });
    fs.writeFileSync(path.join(projectDir(p.id), rel), 'x');
    const ch = Assets.create(p.id, { category: 'character', name: '角色' });
    Assets.update(ch.id, { image_path: rel, status: 'done' });
    const s = Shots.create(p.id, { chapter: '第1章', visual: '画面' });
    Shots.update(s.id, { video_prompt: '提示词', character_ids: [ch.id], duration: 13 });
    return { p, shot: Shots.get(s.id) };
  }
  function ctxFor(p, cq) {
    const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'job-cq' });
    ctx.cfg.comfyui.provider = 'native';
    ctx.cfg.generation.videosPerShot = 1;
    ctx.cfg.generation.refLeakGuard = false;
    if (cq !== undefined) ctx.cfg.generation.clipQuality = cq;
    ctx.reports = [];
    ctx.report = (x) => { ctx.reports.push(x); };
    return ctx;
  }
  async function run(bytes, cq) {
    const { p, shot } = mkShot('质量闸门');
    const ctx = ctxFor(p, cq);
    const m = mockComfy(bytes);
    let out;
    try { out = JSON.parse(await tools.runTool(ctx, 'generate_chapter_videos', { chapter: '第1章' })); } finally { m.restore(); }
    return { p, shot: core.Shots.get(shot.id), out, ctx, calls: m.calls };
  }

  test('灰场片 → 分镜标 failed，error 写清原因；原片留在 shots/；不落候选；只提交一次（不自动重提）', async () => {
    const { p, shot, out, ctx, calls } = await run(clips.grey);
    assert.equal(out.failed, 1);
    assert.equal(out.generated, 0);
    assert.equal(shot.status, 'failed');
    assert.match(shot.error, /出片画面异常，判失败不收片/);
    assert.match(shot.error, /近纯色\/灰场/);
    assert.equal(shot.video_path || '', '');
    assert.equal(core.ShotVideos.listByShot(shot.id).length, 0);
    const dir = path.join(core.projectDir(p.id), 'shots');
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => /\.mp4$/.test(f)), '原片保留');
    assert.ok(files.some((f) => /_quality\.json$/.test(f)), '写 sidecar');
    assert.ok(ctx.reports.some((r) => r.phase === '出片质量'));
    assert.equal(calls.filter((c) => c.url.includes('/prompt') && c.method !== 'GET').length, 1);
    assert.equal(calls.some((c) => /:(8188|8189|4610)\b/.test(c.url)), false);
  });

  test('正常片 → done，行为与改前一致', async () => {
    const { shot, out } = await run(clips.good);
    assert.equal(out.generated, 1);
    assert.equal(shot.status, 'done');
    assert.ok(shot.video_path);
  });

  test('clipQuality=false → 灰场片照旧收片（可一键回退到改前行为）', async () => {
    const { shot } = await run(clips.grey, false);
    assert.equal(shot.status, 'done');
  });

  test('下载到的不是视频（ffmpeg 读不出）→ 默认放行，不影响出片', async () => {
    const { p, shot } = await run(Buffer.from('fake-mp4'));
    assert.equal(shot.status, 'done');
    const log = fs.readFileSync(path.join(core.projectDir(p.id), 'logs', 'clip-quality.jsonl'), 'utf8');
    assert.match(log, /"verdict":"error"/);
  });
});