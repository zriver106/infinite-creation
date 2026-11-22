// ic32 成片后期：纯函数单测 + 一条用 lavfi 合成素材的 ffmpeg 端到端（本机没有 ffmpeg 时跳过）
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  splitInlineWindow, findLineWindow, shotLines, buildPostPlan, computeGapCuts, keepRanges, remapTime,
  splitSentences, buildSubtitleCues, remapCues, cuesToSrt, remapMusic, parseSilences, parseMotion,
  buildEditArgs, normalizePostOptions, previewPostPlan, mergeIntervals, subtractIntervals, runChapterPost, POST_DEFAULTS,
} from '../lib/core/post-production.js';

// 第5章真实写法（镜3 / 镜5 / 镜28 / 镜1）
const SHOT3 = {
  id: 's3', idx: 3, dialogue: '江澈（OS）：都能让我想起大学时的许曼宁。',
  sub_shots: '镜头：0-1.5s 唐知夏特写（江澈视角，缓推）→1.5s 切入回忆\n0-1.5s：餐厅。唐知夏特写，闭嘴，无人声。\n1.5-5s：回忆。两人相视而笑。心声（1.8-4.3秒，画外音）：都能让我想起大学时的许曼宁。',
};
const SHOT5 = {
  id: 's5', idx: 5,
  dialogue: '江澈（OS）：一起吃泡面时的开心是真的，今天看不上我也是真的。\n江澈（OS）：三百九十九一位，两小时限时，吃饭可不能再亏！',
  sub_shots: '0-5s：江澈闭眼再睁开。心声一（0.5-5秒，画外音）：一起吃泡面时的开心是真的，今天看不上我也是真的。\n5-7.5s：无心声。\n7.5-12s：江澈中近景。心声二（7.8-11.2秒，画外音）：399一位，两小时限时，吃饭可不能再亏！',
};
const SHOT28 = {
  id: 's28', idx: 28, dialogue: '江澈（OS）：原本想吃回399，\n江澈（OS）：现在倒好，还免费给人吵了一架。',
  sub_shots: '0-2.5s：江澈把小汤锅放回电磁炉上，闭嘴。\n2.5-4.5s：江澈视角低头看锅。心声一（2.7-4.3秒，画外音）：原本想吃回399，\n4.5-8s：江澈正面特写。心声二（4.7-7.2秒，画外音）：现在倒好，还免费给人吵了一架。6.5-8s：赵景程起身。',
};
const SHOT1 = {
  id: 's1', idx: 1, dialogue: '江澈：嗯？你刚刚说什么？\n唐知夏：我说你是饿了多久，这老板见到你，估计都要考虑涨价了。',
  sub_shots: '镜头：0-1s 全景交代→1s 双人中景→4s 唐知夏特写\n0-3s：江澈猛地抬头看向唐知夏：嗯？你刚刚说什么？\n3-9s：唐知夏憋着笑：我说你是饿了多久，这老板见到你，估计都要考虑涨价了。',
};

test('splitInlineWindow：台词行末的 (a-b秒)', () => {
  assert.deepEqual(splitInlineWindow('都能让我想起许曼宁。(1.8-4.3秒)'), { text: '都能让我想起许曼宁。', window: { start: 1.8, end: 4.3 } });
  assert.deepEqual(splitInlineWindow('都能让我想起许曼宁（2-3s）'), { text: '都能让我想起许曼宁', window: { start: 2, end: 3 } });
  assert.equal(splitInlineWindow('没有窗口').window, null);
});

test('findLineWindow：心声窗 / 子分镜窗（秒与 s 两种写法），数字改写成汉字也能用句尾定位', () => {
  assert.deepEqual(findLineWindow(SHOT3.sub_shots, '都能让我想起大学时的许曼宁。'), { start: 1.8, end: 4.3 });
  assert.deepEqual(findLineWindow(SHOT5.sub_shots, '三百九十九一位，两小时限时，吃饭可不能再亏！'), { start: 7.8, end: 11.2 });
  assert.deepEqual(findLineWindow(SHOT28.sub_shots, '现在倒好，还免费给人吵了一架。'), { start: 4.7, end: 7.2 });
  assert.deepEqual(findLineWindow(SHOT1.sub_shots, '嗯？你刚刚说什么？'), { start: 0, end: 3 });
  assert.deepEqual(findLineWindow(SHOT1.sub_shots, '我说你是饿了多久，这老板见到你，估计都要考虑涨价了。'), { start: 3, end: 9 });
  assert.equal(findLineWindow(SHOT1.sub_shots, '完全不存在的一句话'), null);
});

test('shotLines / buildPostPlan：心声标 kind=os，全局时间按实际时长累加，窗口不超出镜长', () => {
  const ls = shotLines(SHOT5, 11.5);
  assert.equal(ls.length, 2);
  assert.ok(ls.every((l) => l.kind === 'os' && l.speaker === '江澈'));
  assert.deepEqual(ls[1].window, { start: 7.8, end: 11.2 });
  const plan = buildPostPlan([SHOT1, SHOT3, SHOT5], [8.7, 5.2, 11.5]);
  assert.equal(plan.total.toFixed(1), '25.4');
  const os3 = plan.lines.find((l) => l.shot_idx === 3);
  assert.equal(os3.start.toFixed(2), (8.7 + 1.8).toFixed(2));
  assert.equal(os3.end.toFixed(2), (8.7 + 4.3).toFixed(2));
  const clipped = shotLines({ ...SHOT3 }, 3.0)[0];
  assert.deepEqual(clipped.window, { start: 1.8, end: 3.0 });
});

test('旁白字段：无名字的整行按旁白（画外），有名字的按说话人', () => {
  const ls = shotLines({ id: 'n', idx: 1, dialogue: '', narration: '夜色渐深（0-2秒）\n江澈：走吧', sub_shots: '0-3s：走吧' }, 4);
  assert.equal(ls[0].kind, 'narration');
  assert.deepEqual(ls[0].window, { start: 0, end: 2 });
  assert.equal(ls[1].kind, null);
});

test('区间工具', () => {
  assert.deepEqual(mergeIntervals([{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 0.5, end: 2 }]), [{ start: 0, end: 2 }, { start: 3, end: 4 }]);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 5, end: 6 }]), [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 10 }]);
});

test('computeGapCuts：只剪安静且静止、且不在台词/心声窗（含保护边）里的段；留 maxGap 秒', () => {
  const protect = [{ start: 1, end: 3 }, { start: 12, end: 14 }];
  const silences = [{ start: 0, end: 1.2 }, { start: 3, end: 11 }, { start: 14, end: 15 }];
  const cuts = computeGapCuts({ total: 15, protect, silences, moving: null, maxGap: 2, pad: 0.15 });
  assert.equal(cuts.length, 1);
  assert.ok(Math.abs(cuts[0].start - (3.15 + 1)) < 1e-9);
  assert.ok(Math.abs(cuts[0].end - (11 - 1)) < 1e-9);
  for (const c of cuts) for (const p of protect) assert.ok(c.end <= p.start - 0.15 || c.start >= p.end + 0.15, '剪进了保护窗');
  // 画面在动（表演）的那一段不剪
  const withMotion = computeGapCuts({ total: 15, protect, silences, moving: [{ start: 4, end: 10 }], maxGap: 2 });
  assert.equal(withMotion.length, 0);
  const keeps = keepRanges(15, cuts);
  const kept = keeps.reduce((a, k) => a + k.end - k.start, 0);
  assert.ok(Math.abs(kept - (15 - (cuts[0].end - cuts[0].start))) < 1e-9);
});

test('remapTime：剪掉区间后时间前移，落在剪段里的点归到剪点', () => {
  const cuts = [{ start: 4, end: 6 }, { start: 10, end: 11 }];
  assert.equal(remapTime(3, cuts), 3);
  assert.equal(remapTime(5, cuts), 4);
  assert.equal(remapTime(8, cuts), 6);
  assert.equal(remapTime(12, cuts), 9);
});

test('splitSentences：一句一条，句尾句号逗号去掉，问号叹号保留', () => {
  assert.deepEqual(splitSentences('不是这句，上一句。帅哥？有眼光！'), ['不是这句，上一句', '帅哥？', '有眼光！']);
  assert.deepEqual(splitSentences('原本想吃回三百九十九，'), ['原本想吃回三百九十九']);
});

test('buildSubtitleCues：入画台词按有声区间定时，心声按配音长度定时，一句一条，不越出窗口', () => {
  const plan = buildPostPlan([SHOT1, SHOT28], [8.7, 8]);
  const voiced = [{ start: 0.6, end: 2.4 }, { start: 3.3, end: 8.2 }];
  const osIdx = plan.lines.findIndex((l) => l.kind && l.text.startsWith('现在'));
  const dubs = { [osIdx]: { start: plan.lines[osIdx].start, dur: 2.0 } };
  const cues = buildSubtitleCues(plan, { voiced, dubs });
  // 「嗯？」「你刚刚说什么？」「我说你是饿了多久…」+ 两条心声 = 5 句
  assert.equal(cues.length, 5);
  assert.equal(cues[0].text, '嗯？');
  assert.ok(cues[0].start >= 0.6 - 1e-9);
  const os = cues.find((c) => c.text.startsWith('现在倒好'));
  assert.ok(Math.abs(os.start - (8.7 + 4.7)) < 1e-9 && Math.abs(os.end - (8.7 + 6.7)) < 1e-9);
  for (const c of cues) assert.ok(c.end > c.start);
  const srt = cuesToSrt(remapCues(cues, [{ start: 2.5, end: 2.9 }]));
  assert.equal(srt.split('-->').length - 1, 5);
});

test('remapMusic：cue 表随剪辑重映射；没有 cue 表原样返回', () => {
  const m = { path: '', cues: [{ start: 10, end: 20, track: 'a' }] };
  assert.deepEqual(remapMusic(m, [{ start: 2, end: 4 }]).cues[0], { start: 8, end: 18, track: 'a' });
  const plain = { path: 'x.mp3', volume: 0.25 };
  assert.equal(remapMusic(plain, [{ start: 2, end: 4 }]), plain);
});

test('parseSilences / parseMotion', () => {
  const err = '[silencedetect @ 0x] silence_start: 1.5\n[silencedetect @ 0x] silence_end: 3.25 | silence_duration: 1.75\n[silencedetect @ 0x] silence_start: 9\n';
  assert.deepEqual(parseSilences(err, 10), [{ start: 1.5, end: 3.25 }, { start: 9, end: 10 }]);
  const lines = [];
  for (let i = 0; i < 24; i++) { lines.push('frame:' + i + ' pts:' + i + ' pts_time:' + (i / 12)); lines.push('lavfi.signalstats.YAVG=' + (i < 12 ? '0.4' : '9')); }
  const m = parseMotion(lines.join('\n'), { threshold: 2.5, total: 2 });
  assert.equal(m.frames, 24);
  assert.equal(m.statics.length, 1);
  assert.deepEqual(m.moving, [{ start: 1, end: 2 }]);
});

test('buildEditArgs：静音窗表达式、配音延时放置、剪辑拼接', () => {
  const args = buildEditArgs({ base: 'b.mp4', out: 'o.mp4', total: 20, muteWindows: [{ start: 1.8, end: 4.3 }], dubs: [{ path: 'd.wav', start: 1.8, winLen: 2.5, dur: 2.2, tempo: 1 }], keeps: [{ start: 0, end: 10 }, { start: 12, end: 20 }] });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /volume=volume=0:enable='between\(t,1\.800,4\.300\)'/);
  assert.match(fc, /adelay=1800:all=1/);
  assert.match(fc, /concat=n=2:v=1:a=1\[vout\]\[aout\]/);
  assert.ok(args.includes('d.wav'));
});

test('normalizePostOptions：缺省值与范围收敛', () => {
  assert.deepEqual(normalizePostOptions({}), { ...POST_DEFAULTS });
  const o = normalizePostOptions({ max_gap_sec: 99, silence_db: 5, os_dub: false });
  assert.equal(o.max_gap_sec, 10);
  assert.equal(o.silence_db, -10);
  assert.equal(o.os_dub, false);
});

test('previewPostPlan：列出画外台词、时间窗、有没有声线', () => {
  const r = previewPostPlan([{ ...SHOT3, duration: 5 }, { ...SHOT1, duration: 9 }], [{ category: 'character', name: '江澈', voice_ref: 'assets/voice/j.wav' }]);
  assert.equal(r.offscreen.length, 1);
  assert.deepEqual(r.offscreen[0].window, { start: 1.8, end: 4.3 });
  assert.equal(r.offscreen[0].voice, true);
  assert.equal(r.offscreen_no_window, 0);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

function rmsDb(file, start, dur) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-af', 'astats=measure_overall=RMS_level:measure_perchannel=0', '-f', 'null', '-']);
  const m = String(r.stderr).match(/RMS level dB:\s*(-?[0-9.]+|-inf)/);
  return m ? (m[1] === '-inf' ? -200 : parseFloat(m[1])) : NaN;
}

test('runChapterPost 端到端（lavfi 素材）：心声窗静音+配音、空档剪到 2 秒、一句一条字幕', { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic32-post-'));
  try {
    // 镜A 8s：0-2s 有人声（400Hz），2-8s 静音 + 静止画面 → 空档 6s
    // 镜B 6s：1-4s 心声窗（原声里有 H3 乱出的 300Hz「含混人声」）
    const a = path.join(dir, 'a.mp4'); const b = path.join(dir, 'b.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=24:d=8', '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,2),0.5*sin(2*PI*400*t),0)':s=44100:d=8", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
    ff(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=6', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,4),0.5*sin(2*PI*300*t),0.02*sin(2*PI*100*t))':s=44100:d=6", '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', b]);
    const dub = path.join(dir, 'dub.wav');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=2', dub]);
    const shots = [
      { id: 'A', idx: 1, dialogue: '甲：你好。今天来了？', sub_shots: '0-2s：甲：你好。今天来了？\n2-8s：甲坐着不动。' },
      { id: 'B', idx: 2, dialogue: '甲（OS）：原来如此。', sub_shots: '0-6s：甲看窗外。心声（1-4秒，画外音）：原来如此。' },
    ];
    const out = path.join(dir, 'out.mp4'); const srt = path.join(dir, 'out.srt');
    const r = await runChapterPost({
      inputs: [a, b], shots, music: undefined, options: { motion_check: true, deliver: false, silence_db: -35 },
      workDir: path.join(dir, 'work'), outAbs: out, nosubAbs: path.join(dir, 'out_nosub.mp4'), srtAbs: srt,
      synthesize: async () => dub,
    });
    assert.equal(r.gaps_cut.length, 1, JSON.stringify(r.gaps_cut));
    assert.ok(Math.abs((r.gaps_cut[0].gap_end - r.gaps_cut[0].gap_start) - (r.gaps_cut[0].cut_end - r.gaps_cut[0].cut_start) - 2) < 1e-6);
    assert.ok(r.total_after < r.total_before - 3, r.total_before + '→' + r.total_after);
    assert.equal(r.dubs.length, 1);
    assert.equal(r.subtitle_cues, 3);
    assert.equal(fs.readFileSync(srt, 'utf8').split('-->').length - 1, 3);
    // 心声窗（剪辑后时间轴）里：原来的 300Hz 被静音、只剩 880Hz 配音
    const ed = path.join(dir, 'work', '02_edited.mp4');
    const w0 = r.mute_windows[0].start_after;
    const r300 = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(w0 + 0.2), '-t', '1.5', '-i', ed, '-vn', '-af', 'bandpass=f=300:width_type=h:w=40,astats=measure_overall=RMS_level:measure_perchannel=0', '-f', 'null', '-']);
    const r880 = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(w0 + 0.2), '-t', '1.5', '-i', ed, '-vn', '-af', 'bandpass=f=880:width_type=h:w=40,astats=measure_overall=RMS_level:measure_perchannel=0', '-f', 'null', '-']);
    const db = (x) => { const m = String(x.stderr).match(/RMS level dB:\s*(-?[0-9.]+|-inf)/); return m ? (m[1] === '-inf' ? -200 : parseFloat(m[1])) : NaN; };
    const base = path.join(dir, 'work', '01_concat.mp4');
    const w0b = r.mute_windows[0].start;
    const r300b = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(w0b + 0.2), '-t', '1.5', '-i', base, '-vn', '-af', 'bandpass=f=300:width_type=h:w=40,astats=measure_overall=RMS_level:measure_perchannel=0', '-f', 'null', '-']);
    assert.ok(db(r300) < db(r300b) - 25, '300Hz 应被静音：' + db(r300b) + ' → ' + db(r300));
    assert.ok(db(r880) > -30, '880Hz 配音应存在：' + db(r880));
    assert.ok(rmsDb(out, 0.3, 1) > -40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
