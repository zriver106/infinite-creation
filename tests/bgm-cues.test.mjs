// 章节 BGM cue 表（lib/core/bgm-cues.js + mergeVideos + set_chapter_music_cues）。
// 临时数据目录 + 临时配置（IC_CONFIG=:9 + 8188/8189 守卫）；ffmpeg 用 lavfi 现造小片，不碰真实 data/ic.db、不碰 ComfyUI。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';
import { normalizeCues, planBgmCues, buildCueBgmFilter, chapterMusicForMerge, CUE_SILENCE, CUE_MAIN, normalizeLoop, planTrackLoop, cueTrackNeeds } from '../lib/core/bgm-cues.js';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bgmcues-'));
writeTempIcConfig(tmp);

const withTrack = (cues, map = {}) => normalizeCues(cues).map((c) => ({ ...c, track: c.music_id === CUE_SILENCE ? CUE_SILENCE : (map[c.music_id] || c.music_id) }));

describe('normalizeCues', () => {
  test('按 start 排序、补默认淡化、「静音」归一成 silence', () => {
    const c = normalizeCues([{ start: 8, end: 10, music_id: '17' }, { start: 0, end: 2, music_id: '静音', fade_in: 0, fade_out: 0.5 }]);
    assert.deepEqual(c.map((x) => x.start), [0, 8]);
    assert.equal(c[0].music_id, CUE_SILENCE);
    assert.equal(c[0].fade_in, 0);
    assert.equal(c[0].fade_out, 0.5);
    assert.equal(c[1].fade_in, 1);
    assert.equal(c[1].source_offset, null);
  });
  test('重叠、end<=start、负数、缺 music_id 都直接报错', () => {
    assert.throws(() => normalizeCues([{ start: 0, end: 5, music_id: '01' }, { start: 4, end: 6, music_id: '02' }]), /重叠/);
    assert.throws(() => normalizeCues([{ start: 3, end: 3, music_id: '01' }]), /end 必须大于 start/);
    assert.throws(() => normalizeCues([{ start: -1, end: 3, music_id: '01' }]), /不能小于 0/);
    assert.throws(() => normalizeCues([{ start: 0, end: 3, music_id: '01', fade_in: -1 }]), /fade_in 不能小于 0/);
    assert.throws(() => normalizeCues([{ start: 0, end: 3 }]), /缺少 music_id/);
    assert.throws(() => normalizeCues({}), /必须是数组/);
  });
  test('首尾相接不算重叠', () => {
    assert.equal(normalizeCues([{ start: 0, end: 2, music_id: 'silence' }, { start: 2, end: 4, music_id: '01' }]).length, 2);
  });
});

describe('planBgmCues', () => {
  test('静音段、插入段结束后，主曲从断点继续放', () => {
    const cues = withTrack([
      { start: 4, end: 6, music_id: 'silence' },
      { start: 10, end: 13, music_id: 'X' },
    ]);
    const { timeline, segments } = planBgmCues({ cues, totalSec: 20, mainKey: CUE_MAIN });
    assert.deepEqual(timeline.map((s) => [s.start, s.end, s.track, s.src]), [
      [0, 4, CUE_MAIN, 0],
      [4, 6, CUE_SILENCE, undefined],
      [6, 10, CUE_MAIN, 4],   // 静音 2 秒期间主曲不走，从 4 秒接着放
      [10, 13, 'X', 0],       // 插入曲从 0 开始
      [13, 20, CUE_MAIN, 8],  // 插入段结束，主曲从 8 秒接着放
    ]);
    assert.equal(segments.length, 4, '静音段不出音频段');
  });
  test('交接：前一段先淡出到段尾，后一段从段头淡入，两段不叠放', () => {
    const cues = withTrack([{ start: 5, end: 9, music_id: 'X', fade_in: 0.5, fade_out: 1.5 }]);
    const { segments } = planBgmCues({ cues, totalSec: 12, mainKey: CUE_MAIN });
    for (let i = 1; i < segments.length; i++) assert.equal(segments[i].start, segments[i - 1].end, '段与段首尾相接，不重叠');
    const [m1, x, m2] = segments;
    assert.equal(m1.fadeIn, 0, '章头不淡入');
    assert.equal(m1.fadeOut, 1, '主曲交给插入曲前先淡出（默认 1 秒）');
    assert.equal(x.fadeIn, 0.5);
    assert.equal(x.fadeOut, 1.5);
    assert.equal(m2.fadeIn, 1);
    assert.equal(m2.fadeOut, 0, '章尾不淡出');
  });
  test('主曲 cue 写了 source_offset 时从该处起放，之后从新位置续放', () => {
    const cues = withTrack([{ start: 2, end: 4, music_id: 'M', source_offset: 30 }], { M: CUE_MAIN });
    const { timeline } = planBgmCues({ cues, totalSec: 6, mainKey: CUE_MAIN });
    assert.deepEqual(timeline.map((s) => s.src), [0, 30, 32]);
  });
  test('没有主曲（静音章）：cue 之外不垫 BGM', () => {
    const cues = withTrack([{ start: 3, end: 5, music_id: 'X' }]);
    const { timeline, segments } = planBgmCues({ cues, totalSec: 8, mainKey: null });
    assert.deepEqual(timeline.map((s) => s.track), [CUE_SILENCE, 'X', CUE_SILENCE]);
    assert.equal(segments.length, 1);
  });
  test('超出成片时长的 cue 被截断或丢弃；淡化总长超过段长时按比例压缩', () => {
    const cues = withTrack([{ start: 8, end: 30, music_id: 'X', fade_in: 3, fade_out: 3 }, { start: 40, end: 50, music_id: 'Y' }]);
    const { segments } = planBgmCues({ cues, totalSec: 10, mainKey: null });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].end, 10);
    assert.equal(segments[0].fadeIn + segments[0].fadeOut, 2);
  });
  test('cue 自带 volume 时按段做音量自动化', () => {
    const cues = withTrack([{ start: 0, end: 2, music_id: 'X', volume: 0.1 }]);
    const { segments } = planBgmCues({ cues, totalSec: 4, mainKey: CUE_MAIN, volume: 0.25 });
    assert.deepEqual(segments.map((s) => s.volume), [0.1, 0.25]);
  });
  test('成片时长未知直接报错，不猜', () => {
    assert.throws(() => planBgmCues({ cues: [], totalSec: 0, mainKey: CUE_MAIN }), /总时长/);
  });
});

describe('buildCueBgmFilter', () => {
  test('同一首用多段时 asplit；每段 atrim + 淡化 + adelay 到时间轴；全部 amix', () => {
    const cues = withTrack([{ start: 4, end: 6, music_id: 'X' }]);
    const { segments } = planBgmCues({ cues, totalSec: 10, mainKey: CUE_MAIN });
    const r = buildCueBgmFilter(segments, { [CUE_MAIN]: 3, X: 4 });
    assert.match(r.filter, /\[3:a\]asplit=2\[ct0_0\]\[ct0_1\]/);
    assert.match(r.filter, /atrim=start=4:end=8/);       // 主曲第二段从断点 4 秒起
    assert.match(r.filter, /adelay=6000:all=1/);
    assert.match(r.filter, /amix=inputs=3:duration=longest:dropout_transition=0:normalize=0\[bgm\]$/);
    assert.equal(r.label, 'bgm');
  });
  test('全是静音段 → null（不垫 BGM）', () => {
    assert.equal(buildCueBgmFilter([], {}), null);
  });
  test('曲目没有对应输入时报错', () => {
    assert.throws(() => buildCueBgmFilter([{ start: 0, end: 1, track: 'Q', src: 0, fadeIn: 0, fadeOut: 0, volume: 0.25 }], {}), /没有对应的输入/);
  });
});

describe('chapterMusicForMerge', () => {
  const files = new Set(['/p/main.mp3', '/p/x.mp3']);
  const deps = { getAsset: (id) => ({ A_MAIN: { audio_path: 'main.mp3' }, A_X: { audio_path: 'x.mp3' }, A_GONE: { audio_path: 'gone.mp3' } })[id] || null, resolvePath: (rel) => '/p/' + rel, exists: (p) => files.has(p) };
  test('没有 cue 表：与原来一致，只看 music_path', () => {
    assert.deepEqual(chapterMusicForMerge({ music_path: 'main.mp3', music_prompt: '{"music_id":"A_MAIN"}' }, deps), { path: '/p/main.mp3', volume: 0.25 });
    assert.equal(chapterMusicForMerge({ music_path: '', music_prompt: '' }, deps), undefined);
    assert.equal(chapterMusicForMerge({ music_path: 'missing.mp3', music_prompt: 'not json' }, deps), undefined);
  });
  test('有 cue 表：主曲 cue 认成主曲，插入曲解析成路径，静音保留', () => {
    const ch = { music_path: 'main.mp3', music_prompt: JSON.stringify({ music_id: 'A_MAIN', cues: [
      { start: 0, end: 2, music_id: 'silence' }, { start: 3, end: 5, music_id: '17', asset_id: 'A_X' }, { start: 6, end: 7, music_id: '01', asset_id: 'A_MAIN' },
    ] }) };
    const m = chapterMusicForMerge(ch, deps);
    assert.equal(m.mainKey, CUE_MAIN);
    assert.deepEqual(m.cues.map((c) => c.track), [CUE_SILENCE, 'A_X', CUE_MAIN]);
    assert.deepEqual(m.tracks, { [CUE_MAIN]: '/p/main.mp3', A_X: '/p/x.mp3' });
  });
  test('cue 曲目文件不在：报错，不悄悄少一段', () => {
    const ch = { music_path: 'main.mp3', music_prompt: JSON.stringify({ cues: [{ start: 0, end: 2, music_id: '09', asset_id: 'A_GONE' }] }) };
    assert.throws(() => chapterMusicForMerge(ch, deps), /音频不存在/);
  });
});

// —— 集成：mergeVideos 真跑 ffmpeg（lavfi 现造 2 段静音小片 + 两首正弦波当 BGM）——
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
describe('mergeVideos 按 cue 表混音', { concurrency: 1, skip: hasFfmpeg ? false : '本机没有 ffmpeg' }, () => {
  let mergeVideos;
  const dir = path.join(tmp, 'media');
  const clip = (name, sec) => {
    const f = path.join(dir, name);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(sec), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return f;
  };
  // gain：插入曲比主曲响 12 dB，按音量就能分清当时放的是哪首。
  const tone = (name, freq, sec, gain = 1) => {
    const f = path.join(dir, name);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=' + freq + ':sample_rate=44100:duration=' + sec, '-af', 'volume=' + gain, '-c:a', 'libmp3lame', '-q:a', '4', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return f;
  };
  // 某个时间窗的最大音量（dB）；整段数字静音时 volumedetect 报 -91 左右。
  const maxDb = (f, ss, t) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', String(t), '-i', f, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
    return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200;
  };
  const durOf = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
  let a, b, main, ins;
  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    ({ mergeVideos } = await import('../lib/core/ffmpeg.js'));
    a = clip('a.mp4', 3); b = clip('b.mp4', 3);
    main = tone('main.mp3', 440, 20); ins = tone('ins.mp3', 1000, 20, 4);
  });

  test('没有 cue 表：原来的整章一首照旧垫入', async () => {
    const out = path.join(dir, 'legacy.mp4');
    await mergeVideos([a, b], out, { music: { path: main, volume: 0.25 } });
    assert.ok(Math.abs(durOf(out) - 6) < 0.3);
    assert.ok(maxDb(out, 1, 1) > -45, '有 BGM');
  });

  test('静音段只留现场声；静音段后主曲续上；插入段有声', async () => {
    const out = path.join(dir, 'cues.mp4');
    const logs = [];
    await mergeVideos([a, b], out, {
      onLog: (s) => logs.push(s),
      music: {
        path: main, volume: 0.25, mainKey: CUE_MAIN, tracks: { [CUE_MAIN]: main, INS: ins },
        cues: withTrack([{ start: 0, end: 2, music_id: 'silence' }, { start: 3.5, end: 5, music_id: 'INS', fade_in: 0.2, fade_out: 0.2 }], { INS: 'INS' }),
      },
    });
    assert.ok(Math.abs(durOf(out) - 6) < 0.3, '时长不被 BGM 拉长');
    assert.ok(maxDb(out, 0.2, 1.5) < -60, '静音段没有 BGM');
    const mainDb = maxDb(out, 2.4, 0.8);
    assert.ok(mainDb > -45 && mainDb < -27, '静音段之后主曲进来（主曲音量）：' + mainDb);
    assert.ok(maxDb(out, 3.9, 0.8) > -27, '插入段放的是插入曲（比主曲响 12 dB）');
    const backDb = maxDb(out, 5.4, 0.5);
    assert.ok(backDb > -45 && backDb < -27, '插入段结束后回到主曲：' + backDb);
    assert.ok(logs.some((s) => s.includes('[bgm-cues]')), '时间线写进日志，便于核对');
  });

  test('cue 全是静音：成片不垫 BGM', async () => {
    const out = path.join(dir, 'allsilent.mp4');
    await mergeVideos([a, b], out, { music: { path: '', volume: 0.25, mainKey: null, tracks: {}, cues: withTrack([{ start: 0, end: 6, music_id: 'silence' }]) } });
    assert.ok(maxDb(out, 0.5, 5) < -60);
  });
});

// —— 工具：set_chapter_music_cues 存表 + assemble 时读回 ——
describe('set_chapter_music_cues', { concurrency: 1 }, () => {
  let core, tools;
  before(async () => {
    core = await import('../lib/core/index.js');
    tools = await import('../lib/agent/tools.js');
  });
  function mk() {
    const p = core.Projects.create({ name: 'cue 表测试', auto_script: false });
    const ch = core.Chapters.create(p.id, { title: '第30章', script: 'x' });
    const put = (rel) => { const abs = path.join(core.projectDir(p.id), rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'ID3'); return rel; };
    const m1 = core.Assets.create(p.id, { category: 'music', name: '主曲甲' });
    core.Assets.update(m1.id, { audio_path: put('assets/music/a.mp3'), status: 'done' });
    const m2 = core.Assets.create(p.id, { category: 'music', name: '插入乙' });
    core.Assets.update(m2.id, { audio_path: put('assets/music/b.mp3'), status: 'done' });
    core.Chapters.update(ch.id, { music_path: 'assets/music/a.mp3', music_prompt: JSON.stringify({ caption: '情绪类别：压抑、受困', music_id: m1.id, music_name: '主曲甲' }) });
    const ctx = tools.createToolRuntime({ projectId: p.id, chapter: '第30章' });
    return { p, ctx, m1, m2 };
  }
  const chapterOf = (pid) => core.Chapters.list(pid).find((c) => c.title === '第30章');

  test('存进 music_prompt.cues，曲目解析成资产 id，主曲与 caption 不动', async () => {
    const { p, ctx, m2 } = mk();
    const out = JSON.parse(await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [
      { start: 10, end: 14, music_id: '静音', note: '诀别句前撤乐' }, { start: 14, end: 20, music_id: '插入乙', fade_in: 0.5 },
    ] }));
    assert.equal(out.cues, 2);
    const ch = chapterOf(p.id);
    assert.equal(ch.music_path, 'assets/music/a.mp3');
    const mp = JSON.parse(ch.music_prompt);
    assert.equal(mp.caption, '情绪类别：压抑、受困');
    assert.equal(mp.cues[0].music_id, 'silence');
    assert.equal(mp.cues[0].asset_id, undefined);
    assert.equal(mp.cues[1].asset_id, m2.id);
    const m = core.chapterMusicForMerge(ch, { getAsset: (id) => core.Assets.get(id), resolvePath: (rel) => core.resolveProjectPath(p.id, rel), exists: (f) => fs.existsSync(f) });
    assert.equal(m.cues.length, 2);
    assert.ok(m.tracks[CUE_MAIN] && m.tracks[m2.id]);
  });

  test('坏表（重叠 / 曲目对不上）当场报错，不存', async () => {
    const { p, ctx } = mk();
    await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [{ start: 0, end: 5, music_id: 'silence' }, { start: 4, end: 6, music_id: '插入乙' }] }), /重叠/);
    await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [{ start: 0, end: 5, music_id: '不存在的曲子xyz' }] }), /背景音乐不存在/);
    assert.equal(JSON.parse(chapterOf(p.id).music_prompt).cues, undefined);
  });

  test('cues=[] 清空，恢复整章一首', async () => {
    const { p, ctx } = mk();
    await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [{ start: 0, end: 2, music_id: 'silence' }] });
    await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [] });
    assert.equal(JSON.parse(chapterOf(p.id).music_prompt).cues, undefined);
  });

  test('工具已登记在 TOOL_DEFINITIONS', () => {
    assert.ok(tools.TOOL_DEFINITIONS.some((d) => d.function.name === 'set_chapter_music_cues'));
  });
});

// —— B_v2（2026-11-18）：cue 模式循环在乐句边界交叉淡化（≥0.5 s，剪辑与配乐基础规范 §4.6），不再从曲尾硬接曲头 ——
describe('乐句循环点（B_v2）', () => {
  test('normalizeLoop：缺省交叉淡化 1 秒；短于 0.5 秒、乐句段太短、负数都报错', () => {
    assert.deepEqual(normalizeLoop({ loop_start: 2, loop_end: 10 }), { loop_start: 2, loop_end: 10, xfade: 1 });
    assert.throws(() => normalizeLoop({ loop_start: 0, loop_end: 10, xfade: 0.3 }), /短于规范下限 0.5/);
    assert.throws(() => normalizeLoop({ loop_start: 0, loop_end: 1.5, xfade: 1 }), /太短/);
    assert.throws(() => normalizeLoop({ loop_start: -1, loop_end: 5 }), /非负/);
  });
  test('planTrackLoop：够长不循环；登记了按乐句点算遍数；没登记切首尾静音后交叉淡化；曲长未知才退回', () => {
    assert.equal(planTrackLoop({ needSec: 3, durSec: 5 }).copies, 1);
    const r = planTrackLoop({ needSec: 5.5, durSec: 3.1, loop: { loop_start: 0.2, loop_end: 2.4, xfade: 0.5 } });
    assert.deepEqual([r.copies, r.loopStart, r.loopEnd, r.xfade, r.registered], [3, 0.2, 2.4, 0.5, true]);
    assert.ok(r.loopEnd + (r.copies - 1) * (r.loopEnd - r.loopStart - r.xfade) >= 5.5, '拼起来够长');
    const u = planTrackLoop({ needSec: 5.5, durSec: 3.1 });
    assert.ok(u.copies > 1 && u.trim && !u.registered && u.xfade >= 0.5);
    assert.equal(planTrackLoop({ needSec: 5.5, durSec: 0 }).copies, 0);
    assert.throws(() => planTrackLoop({ needSec: 9, durSec: 2, loop: { loop_start: 0.5, loop_end: 8 } }), /超出曲长/);
  });
  test('buildCueBgmFilter 带 loops：先拼曲（atrim 到乐句点 + acrossfade qsin），再按段取用', () => {
    const segs = [{ start: 0.5, end: 6, track: CUE_MAIN, src: 0, fadeIn: 1, fadeOut: 0, volume: 0.25 }];
    assert.deepEqual(cueTrackNeeds(segs), { [CUE_MAIN]: 5.5 });
    const lp = planTrackLoop({ needSec: 5.5, durSec: 3.1, loop: { loop_start: 0.2, loop_end: 2.4, xfade: 0.5 } });
    const { filter } = buildCueBgmFilter(segs, { [CUE_MAIN]: 2 }, { loops: { [CUE_MAIN]: lp } });
    assert.match(filter, /atrim=end=2\.4,/);
    assert.equal((filter.match(/atrim=start=0\.2:end=2\.4/g) || []).length, 2);
    assert.equal((filter.match(/acrossfade=d=0\.5:c1=qsin:c2=qsin/g) || []).length, 2);
    assert.doesNotMatch(filter, /stream_loop/);
  });
});

describe('mergeVideos cue 模式循环接缝（真跑 ffmpeg）', { concurrency: 1, skip: hasFfmpeg ? false : '本机没有 ffmpeg' }, () => {
  let mergeVideos;
  const dir = path.join(tmp, 'media-loop');
  let a, b, short;
  const run = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  // 成片某段音频的 50 ms 窗 RMS（dB）
  const rmsWindows = (f, ss, t) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-t', String(t), '-i', f, '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const buf = r.stdout; const n = Math.floor(buf.length / 4); const win = 2205; const out = [];
    for (let i = 0; i + win <= n; i += win) {
      let s = 0; for (let k = 0; k < win; k++) { const v = buf.readFloatLE((i + k) * 4); s += v * v; }
      out.push(10 * Math.log10(s / win + 1e-20));
    }
    return out;
  };
  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    ({ mergeVideos } = await import('../lib/core/ffmpeg.js'));
    for (const [name, sec] of [['a.mp4', 3], ['b.mp4', 3]]) {
      run(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(sec), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(dir, name)]);
    }
    a = path.join(dir, 'a.mp4'); b = path.join(dir, 'b.mp4');
    // 短曲：2.5 秒粉噪 + 0.6 秒数字静音（模拟曲尾）。-stream_loop 硬接会在每次曲尾留 0.6 秒空洞。
    short = path.join(dir, 'short.wav');
    run(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.5:duration=2.5:sample_rate=44100', '-af', 'apad=pad_dur=0.6', '-c:a', 'pcm_s16le', short]);
  });
  const music = (loops) => ({
    path: short, volume: 0.25, mainKey: CUE_MAIN, tracks: { [CUE_MAIN]: short }, loops,
    cues: withTrack([{ start: 0, end: 0.5, music_id: 'silence', fade_in: 0, fade_out: 0 }]),
  });
  const assertSeamless = (out, label) => {
    const w = rmsWindows(out, 1.6, 4.2);
    assert.ok(w.length > 60, label + ' 取到音频');
    assert.ok(Math.min(...w) > -50, label + '：主曲循环处没有空洞，最低 ' + Math.min(...w).toFixed(1) + ' dB');
    let jump = 0; for (let i = 1; i < w.length; i++) jump = Math.max(jump, Math.abs(w[i] - w[i - 1]));
    assert.ok(jump < 12, label + '：相邻 50 ms 窗跳变 ' + jump.toFixed(1) + ' dB（规范 §4.5 自动检查：>12 dB 视为硬切）');
  };
  test('登记乐句点：在 loop_end → loop_start 交叉淡化循环，没有曲尾静音空洞、没有硬切', async () => {
    const out = path.join(dir, 'reg.mp4'); const logs = [];
    await mergeVideos([a, b], out, { onLog: (s) => logs.push(s), music: music({ [CUE_MAIN]: { loop_start: 0.2, loop_end: 2.4, xfade: 0.5 } }) });
    assertSeamless(out, '登记乐句点');
    assert.ok(logs.some((s) => s.includes('乐句 0.2–2.4 秒') && s.includes('交叉淡化 0.5 秒')), '循环计划写进日志');
  });
  test('未登记乐句点：切掉曲尾静音后交叉淡化循环，同样不硬接', async () => {
    const out = path.join(dir, 'unreg.mp4'); const logs = [];
    await mergeVideos([a, b], out, { onLog: (s) => logs.push(s), music: music({}) });
    assertSeamless(out, '未登记乐句点');
    assert.ok(logs.some((s) => s.includes('未登记乐句点')));
  });
});

describe('set_chapter_music_cues 登记乐句循环点', { concurrency: 1 }, () => {
  let core, tools;
  before(async () => {
    core = await import('../lib/core/index.js');
    tools = await import('../lib/agent/tools.js');
  });
  function mk() {
    const p = core.Projects.create({ name: 'cue 循环点测试', auto_script: false });
    const ch = core.Chapters.create(p.id, { title: '第30章', script: 'x' });
    const put = (rel) => { const abs = path.join(core.projectDir(p.id), rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'ID3'); return rel; };
    const m1 = core.Assets.create(p.id, { category: 'music', name: '主曲甲' });
    core.Assets.update(m1.id, { audio_path: put('assets/music/a.mp3'), status: 'done' });
    core.Chapters.update(ch.id, { music_path: 'assets/music/a.mp3', music_prompt: JSON.stringify({ caption: '情绪类别：压抑', music_id: m1.id, music_name: '主曲甲' }) });
    return { p, m1, ctx: tools.createToolRuntime({ projectId: p.id, chapter: '第30章' }) };
  }
  const chapterOf = (pid) => core.Chapters.list(pid).find((c) => c.title === '第30章');
  const deps = (pid) => ({ getAsset: (id) => core.Assets.get(id), resolvePath: (rel) => core.resolveProjectPath(pid, rel), exists: (f) => fs.existsSync(f) });
  test('"main" 登记到主曲资产；合成时按主曲键读出', async () => {
    const { p, m1, ctx } = mk();
    const out = JSON.parse(await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [{ start: 0, end: 2, music_id: 'silence' }], loops: [{ music_id: 'main', loop_start: 4, loop_end: 40, xfade: 0.8 }] }));
    assert.equal(out.loops, 1);
    const mp = JSON.parse(chapterOf(p.id).music_prompt);
    assert.equal(mp.loops[0].asset_id, m1.id);
    const m = core.chapterMusicForMerge(chapterOf(p.id), deps(p.id));
    assert.deepEqual(m.loops[CUE_MAIN], { loop_start: 4, loop_end: 40, xfade: 0.8 });
  });
  test('交叉淡化短于 0.5 秒当场报错不存；不传 loops 保留；传 [] 清空', async () => {
    const { p, ctx } = mk();
    await assert.rejects(() => tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [], loops: [{ music_id: 'main', loop_start: 0, loop_end: 30, xfade: 0.2 }] }), /0\.5/);
    assert.equal(JSON.parse(chapterOf(p.id).music_prompt).loops, undefined);
    await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [], loops: [{ music_id: '主曲', loop_start: 0, loop_end: 30 }] });
    await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [{ start: 0, end: 1, music_id: 'silence' }] });
    assert.equal(JSON.parse(chapterOf(p.id).music_prompt).loops.length, 1);
    await tools.runTool(ctx, 'set_chapter_music_cues', { chapter: '第30章', cues: [], loops: [] });
    assert.equal(JSON.parse(chapterOf(p.id).music_prompt).loops, undefined);
  });
});
