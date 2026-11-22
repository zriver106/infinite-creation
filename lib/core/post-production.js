// 成片后期（ic32，2026-11-22 Andy：后期也由 IC 做，不另搭流程、不用外部脚本）。
//
// 一条流水线把一章的分镜视频做成可交付的成片：
//   ① 按镜序拼接（mergeVideos，与「导出 / assemble_video」同一套 scale/pad/fps/aresample）
//   ② 心声（OS）及其它画外台词：时间窗内的原声静音（H3 会在心声窗里自己出含混人声），
//      再按窗口放入说话人本人克隆声线合成的心声（合成由调用方注入：真 TTS 走 clone_voice 同一个 tts_clone 工作流，开发/单测用 mock）
//   ③ 空档：既不在任何台词/心声窗口内、音轨安静、画面也几乎不动的段落，剪到不超过 maxGapSec（默认 2 秒）；
//      绝不剪进台词或心声窗口（窗口两侧再留 padSec 保护）
//   ④ 字幕：一句一条（按台词窗口 + 实测有声区间定时；心声按配音实际长度定时），时间轴随③重映射
//   ⑤ BGM：沿用 chapterMusicForMerge（曲库选曲 / cue 切曲 / 循环交叉淡化），cue 时间随③重映射后交给 mergeVideos
//
// 本文件前半部分是纯函数（有单测，不碰 ffmpeg），后半部分是 ffmpeg 执行体。
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, runFfmpegCapture, probeVideoInfo, mergeVideos } from './ffmpeg.js';
import { parseDialogue, voiceSampleFor } from './offscreen-lines.js';
import { srtTime } from './srt.js';

export const POST_DEFAULTS = Object.freeze({
  os_mute: true,          // 画外台词（心声/电话/广播/系统/旁白）窗口内静音原声
  os_dub: true,           // 按窗口配上说话人克隆声音
  subtitles: true,        // 一句一条字幕（烧录 + 另出无字幕版与 SRT）
  trim_gaps: true,        // 剪空档
  max_gap_sec: 2,         // 空档保留上限（秒）
  pad_sec: 0.15,          // 台词/心声窗口两侧的保护边
  silence_db: -32,        // 低于此电平算安静（dBFS）
  motion_check: true,     // 剪空档前确认画面也几乎不动（「没有表演」）
  motion_threshold: 2.5,  // 帧差平均亮度（0–255）低于此值算静止
  bgm: true,              // 垫 BGM（本章选曲 / cue 表）
  dub_gain_db: 0,         // 心声配音增益
  deliver: true,          // 完成后按项目交付设置复制成 EP<N>.mp4（项目未启用交付时自动跳过）
});

// 项目「后期设置」（projects.context.post_settings）
export function readPostSettings(project) {
  const c = (project && project.context) || {};
  return normalizePostOptions(c.post_settings && typeof c.post_settings === 'object' ? c.post_settings : {});
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

export function normalizePostOptions(o = {}) {
  const src = o || {};
  return {
    os_mute: bool(src.os_mute, POST_DEFAULTS.os_mute),
    os_dub: bool(src.os_dub, POST_DEFAULTS.os_dub),
    subtitles: bool(src.subtitles, POST_DEFAULTS.subtitles),
    trim_gaps: bool(src.trim_gaps, POST_DEFAULTS.trim_gaps),
    max_gap_sec: Math.min(10, Math.max(0.5, num(src.max_gap_sec, POST_DEFAULTS.max_gap_sec))),
    pad_sec: Math.min(1, Math.max(0, num(src.pad_sec, POST_DEFAULTS.pad_sec))),
    silence_db: Math.min(-10, Math.max(-80, num(src.silence_db, POST_DEFAULTS.silence_db))),
    motion_check: bool(src.motion_check, POST_DEFAULTS.motion_check),
    motion_threshold: Math.min(50, Math.max(0.1, num(src.motion_threshold, POST_DEFAULTS.motion_threshold))),
    bgm: bool(src.bgm, POST_DEFAULTS.bgm),
    dub_gain_db: Math.min(12, Math.max(-24, num(src.dub_gain_db, POST_DEFAULTS.dub_gain_db))),
    deliver: bool(src.deliver, POST_DEFAULTS.deliver),
  };
}

// ---------- 时间窗解析 ----------
// 「0-3s」「1.8-4.3秒」「3.5~5 秒」；s 后面不能紧跟字母（避免吃掉英文单词）
const RANGE_RE = /(\d+(?:\.\d+)?)\s*[-~—–至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?![a-zA-Z]))/g;
const INLINE_RANGE_RE = /[(（]\s*(\d+(?:\.\d+)?)\s*[-~—–至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[)）]\s*$/i;
const PUNCT = /[\s，。、,.!！?？…—\-~～“”"'‘’：:；;()（）【】]/g;

// 台词行末尾的「(a-b秒)」：返回 { text（去掉时间窗）, window }
export function splitInlineWindow(text) {
  const t = String(text || '').trim();
  const m = t.match(INLINE_RANGE_RE);
  if (!m) return { text: t, window: null };
  const a = parseFloat(m[1]); const b = parseFloat(m[2]);
  return { text: t.slice(0, m.index).trim(), window: b > a ? { start: a, end: b } : null };
}

function locateLine(s, text) {
  const t = String(text || '').replace(/^[\s，。、,.!！?？…“”"']+/, '');
  if (!t) return -1;
  for (const n of [12, 8, 6, 4]) {
    const key = t.slice(0, Math.min(n, t.length));
    if (key.length < 2) continue;
    const i = s.indexOf(key);
    if (i >= 0) return i;
  }
  // 数字被改写成汉字等：退而用句尾 6 / 4 字定位
  const core = t.replace(/[。！？!?…，,]+$/, '');
  for (const n of [6, 4]) {
    if (core.length < n) continue;
    const key = core.slice(-n);
    const i = s.indexOf(key);
    if (i >= 0) return Math.max(0, i - (core.length - n));
  }
  return -1;
}

// 子分镜文本里，这句台词前面最近的一个时间窗（「心声（1.8-4.3秒，画外音）：……」「0-3s：……」）
export function findLineWindow(subShots, text) {
  const s = String(subShots || '');
  const at = locateLine(s, text);
  if (at < 0) return null;
  let win = null;
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(s)) !== null && m.index <= at) {
    const a = parseFloat(m[1]); const b = parseFloat(m[2]);
    if (b > a) win = { start: a, end: b };
  }
  return win;
}

const clampWin = (w, dur) => {
  if (!w) return null;
  const start = Math.max(0, w.start);
  const end = dur > 0 ? Math.min(dur, w.end) : w.end;
  return end - start > 0.05 ? { start, end } : null;
};

// 一镜里的全部台词：入画台词、画外台词（心声等）、旁白字段。窗口是镜内秒数。
export function shotLines(shot, dur) {
  const out = [];
  const sub = shot && shot.sub_shots;
  const push = (l, src) => {
    const { text, window: inl } = splitInlineWindow(l.text);
    if (!text) return;
    const found = inl || findLineWindow(sub, text);
    out.push({
      speaker: l.speaker || '', text, kind: l.kind || null, source: src,
      window: clampWin(found, dur), window_found: !!found,
    });
  };
  for (const l of parseDialogue(shot && shot.dialogue)) push(l, 'dialogue');
  for (const raw of String((shot && shot.narration) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    const p = parseDialogue(raw)[0] || { speaker: '', text: raw, kind: null };
    // 旁白字段里的「名字：」按说话人算；没写名字的整行按旁白（画外）
    push({ speaker: p.speaker || '旁白', text: p.speaker ? p.text : raw, kind: p.kind || (p.speaker ? null : 'narration') }, 'narration');
  }
  return out;
}

// 整章计划：每镜在拼接时间轴上的偏移 + 全部台词（全局秒）
export function buildPostPlan(shots, durations) {
  const lines = [];
  const shotSpans = [];
  let t = 0;
  (shots || []).forEach((shot, i) => {
    const dur = Number(durations[i]) || 0;
    shotSpans.push({ shot_id: shot.id, idx: shot.idx, start: t, end: t + dur });
    for (const l of shotLines(shot, dur)) {
      // 入画台词找不到窗口：整镜保护（宁可少剪），字幕按镜内顺序排
      const local = l.window || (l.kind ? null : { start: 0, end: dur });
      lines.push({
        ...l, shot_id: shot.id, shot_idx: shot.idx,
        local_window: l.window,
        start: local ? t + local.start : null,
        end: local ? t + local.end : null,
      });
    }
    t += dur;
  });
  return { total: t, shots: shotSpans, lines };
}

// 起任务前的检查（不跑 ffmpeg，按分镜写的时长估算）：每条画外台词的时间窗、有没有说话人声线；台词总数
export function previewPostPlan(shots, assets = []) {
  const plan = buildPostPlan(shots, (shots || []).map((s) => Number(s.duration) || 0));
  const off = plan.lines.filter((l) => l.kind).map((l) => {
    const vs = voiceSampleFor(l.speaker, assets);
    return { shot_idx: l.shot_idx, speaker: l.speaker, kind: l.kind, text: l.text, window: l.local_window, voice: !!(vs && vs.voice_ref) };
  });
  const sentences = plan.lines.reduce((a, l) => a + splitSentences(l.text).length, 0);
  return {
    shots: plan.shots.length, est_total: +plan.total.toFixed(1), lines: plan.lines.length, sentences,
    offscreen: off, offscreen_no_window: off.filter((x) => !x.window).length, offscreen_no_voice: off.filter((x) => !x.voice).length,
  };
}

// ---------- 区间工具 ----------
export function mergeIntervals(list) {
  const xs = (list || []).filter((x) => x && x.end > x.start).map((x) => ({ start: x.start, end: x.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

export function subtractIntervals(base, minus) {
  let cur = mergeIntervals(base);
  for (const m of mergeIntervals(minus)) {
    const next = [];
    for (const b of cur) {
      if (m.end <= b.start || m.start >= b.end) { next.push(b); continue; }
      if (m.start > b.start) next.push({ start: b.start, end: m.start });
      if (m.end < b.end) next.push({ start: m.end, end: b.end });
    }
    cur = next;
  }
  return cur;
}

export function complementIntervals(list, total) {
  return subtractIntervals([{ start: 0, end: total }], list);
}

// 空档剪辑点：安静 ∩ 不在任何台词/心声窗口（含保护边）∩（可选）画面静止，长于 maxGap 的只留 maxGap（前后各一半）
export function computeGapCuts({ total, protect = [], silences = [], moving = null, maxGap = 2, pad = 0.15, minCut = 0.3 }) {
  const guarded = protect.map((w) => ({ start: w.start - pad, end: w.end + pad }));
  let quiet = subtractIntervals(silences.map((s) => ({ start: Math.max(0, s.start), end: Math.min(total, s.end) })), guarded);
  if (Array.isArray(moving)) quiet = subtractIntervals(quiet, moving);
  const cuts = [];
  for (const q of quiet) {
    const len = q.end - q.start;
    if (len - maxGap < minCut) continue;
    cuts.push({ start: q.start + maxGap / 2, end: q.end - maxGap / 2, gap_start: q.start, gap_end: q.end });
  }
  return cuts;
}

export function keepRanges(total, cuts) {
  return complementIntervals(cuts, total).filter((r) => r.end - r.start > 0.02);
}

// 剪掉 cuts 后，原时间 t 落在新时间轴的哪里（落在被剪段里的点归到剪点）
export function remapTime(t, cuts) {
  let shift = 0;
  for (const c of cuts || []) {
    if (t <= c.start) break;
    shift += Math.min(t, c.end) - c.start;
  }
  return t - shift;
}

// ---------- 字幕 ----------
// 一句一条：按句末标点切；句尾的「。，」去掉，「！？」保留
export function splitSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = t.match(/[^。！？!?；;…]+[。！？!?；;…]*/g) || [t];
  return parts.map((p) => p.trim().replace(/[。，,；;]+$/, '').trim()).filter((p) => p.replace(PUNCT, '').length > 0);
}

// 有声区间（静音区间的补集）里，落在 [a,b] 内的最早开始 / 最晚结束
function speechBounds(a, b, voiced) {
  let s = null; let e = null;
  for (const v of voiced || []) {
    if (v.end <= a || v.start >= b) continue;
    const vs = Math.max(a, v.start); const ve = Math.min(b, v.end);
    if (s == null || vs < s) s = vs;
    if (e == null || ve > e) e = ve;
  }
  return s != null && e - s >= 0.6 ? { start: s, end: e } : null;
}

// 计划里的台词 → 字幕 cue（成片拼接时间轴；剪空档前）。dubs: { [lineIndex]: { start, dur } }
export function buildSubtitleCues(plan, { voiced = [], dubs = {} } = {}) {
  const cues = [];
  const groups = new Map(); // 同一窗口的多句按字数分配
  plan.lines.forEach((l, i) => {
    if (l.start == null) return;
    let span;
    if (l.kind) {
      const d = dubs[i];
      span = d ? { start: d.start, end: Math.min(l.end, d.start + d.dur) } : { start: l.start, end: l.end };
    } else {
      span = speechBounds(l.start, l.end, voiced) || { start: l.start, end: l.end };
    }
    const key = l.kind ? 'line' + i : (span.start.toFixed(3) + '-' + span.end.toFixed(3));
    if (!groups.has(key)) groups.set(key, { span, items: [] });
    groups.get(key).items.push(l);
  });
  for (const { span, items } of groups.values()) {
    const sents = [];
    for (const l of items) for (const s of splitSentences(l.text)) sents.push(s);
    if (!sents.length) continue;
    const weights = sents.map((s) => Math.max(2, s.replace(PUNCT, '').length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = span.start;
    const len = span.end - span.start;
    sents.forEach((s, k) => {
      const d = len * weights[k] / total;
      cues.push({ start: t, end: t + d, text: s });
      t += d;
    });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function remapCues(cues, cuts) {
  return cues
    .map((c) => ({ ...c, start: remapTime(c.start, cuts), end: remapTime(c.end, cuts) }))
    .filter((c) => c.end - c.start > 0.05);
}

export function cuesToSrt(cues) {
  return cues.map((c, i) => (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}

// BGM cue 表的时间随空档剪辑重映射（没有 cue 表的整章一首不用动：按成片长度循环）
export function remapMusic(music, cuts) {
  if (!music || !Array.isArray(music.cues) || !music.cues.length || !cuts.length) return music;
  return { ...music, cues: music.cues.map((c) => ({ ...c, start: remapTime(Number(c.start), cuts), end: remapTime(Number(c.end), cuts) })).filter((c) => c.end > c.start) };
}

// ---------- ffmpeg 执行体 ----------
const enableExpr = (wins) => wins.map((w) => 'between(t,' + w.start.toFixed(3) + ',' + w.end.toFixed(3) + ')').join('+');

export function parseSilences(stderr, total) {
  const out = [];
  let open = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?[0-9.]+)/);
    if (m) { open = Math.max(0, parseFloat(m[1])); continue; }
    m = line.match(/silence_end:\s*([0-9.]+)/);
    if (m && open != null) { out.push({ start: open, end: parseFloat(m[1]) }); open = null; }
  }
  if (open != null && total > open) out.push({ start: open, end: total });
  return out;
}

// 安静区间（先把要静音的窗口静音，再检测）
export async function detectSilences(input, { total, mute = [], noiseDb = -32, minDur = 0.4, isAborted } = {}) {
  const af = (mute.length ? "volume=volume=0:enable='" + enableExpr(mute) + "'," : '') + 'silencedetect=n=' + noiseDb + 'dB:d=' + minDur;
  const err = await runFfmpegCapture(['-hide_banner', '-nostats', '-i', input, '-vn', '-af', af, '-f', 'null', '-'], { captureStderr: true, isAborted, timeoutMs: 10 * 60 * 1000 });
  return parseSilences(err, total);
}

// 帧差（tblend difference 的 YAVG）→ 运动区间。返回 moving 区间（不静止的段）
export function parseMotion(text, { threshold = 2.5, minStatic = 0.5, total = 0 } = {}) {
  const frames = [];
  let t = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = line.match(/pts_time:([0-9.]+)/);
    if (m) { t = parseFloat(m[1]); continue; }
    m = line.match(/signalstats\.YAVG=([0-9.]+)/);
    if (m && t != null) { frames.push({ t, y: parseFloat(m[1]) }); t = null; }
  }
  const statics = [];
  let s0 = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.y < threshold) { if (s0 == null) s0 = f.t; }
    else if (s0 != null) { if (f.t - s0 >= minStatic) statics.push({ start: s0, end: f.t }); s0 = null; }
  }
  const end = total || (frames.length ? frames[frames.length - 1].t : 0);
  if (s0 != null && end - s0 >= minStatic) statics.push({ start: s0, end });
  return { frames: frames.length, moving: complementIntervals(statics, end), statics };
}

export async function detectMotion(input, { total, threshold, isAborted } = {}) {
  const out = await runFfmpegCapture(['-hide_banner', '-nostats', '-i', input, '-an',
    '-vf', 'fps=12,scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { captureStdout: true, isAborted, timeoutMs: 10 * 60 * 1000 });
  return parseMotion(out, { threshold, total });
}

async function probeDur(p) { try { return (await probeVideoInfo(p)).duration || 0; } catch { return 0; } }

// 静音 + 配音 + 剪空档（一次重编码）
export function buildEditArgs({ base, out, total, muteWindows = [], dubs = [], keeps = [], dubGainDb = 0 }) {
  const args = ['-y', '-i', base];
  dubs.forEach((d) => args.push('-i', d.path));
  const chains = [];
  chains.push('[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo' + (muteWindows.length ? ",volume=volume=0:enable='" + enableExpr(muteWindows) + "'" : '') + '[am]');
  const mixIn = ['[am]'];
  dubs.forEach((d, i) => {
    const win = Math.max(0.1, d.winLen);
    let c = '[' + (i + 1) + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
    if (d.tempo && d.tempo > 1.001) c += ',atempo=' + d.tempo.toFixed(4);
    c += ',atrim=0:' + win.toFixed(3) + ',asetpts=PTS-STARTPTS';
    if (dubGainDb) c += ',volume=' + dubGainDb + 'dB';
    c += ',afade=t=out:st=' + Math.max(0, Math.min(win, d.dur) - 0.06).toFixed(3) + ':d=0.06';
    c += ',adelay=' + Math.round(d.start * 1000) + ':all=1[d' + i + ']';
    chains.push(c);
    mixIn.push('[d' + i + ']');
  });
  let aLabel = '[am]';
  if (dubs.length) { chains.push(mixIn.join('') + 'amix=inputs=' + mixIn.length + ':duration=first:dropout_transition=0:normalize=0[amx]'); aLabel = '[amx]'; }
  const ks = keeps.length ? keeps : [{ start: 0, end: total }];
  const K = ks.length;
  if (K === 1 && ks[0].start <= 0.001 && ks[0].end >= total - 0.001) {
    chains.push('[0:v]null[vout]');
    chains.push(aLabel + 'anull[aout]');
  } else {
    chains.push('[0:v]split=' + K + ks.map((_, i) => '[vs' + i + ']').join(''));
    chains.push(aLabel + 'asplit=' + K + ks.map((_, i) => '[as' + i + ']').join(''));
    const cat = [];
    ks.forEach((k, i) => {
      chains.push('[vs' + i + ']trim=' + k.start + ':' + k.end + ',setpts=PTS-STARTPTS[v' + i + ']');
      chains.push('[as' + i + ']atrim=' + k.start + ':' + k.end + ',asetpts=PTS-STARTPTS[a' + i + ']');
      cat.push('[v' + i + '][a' + i + ']');
    });
    chains.push(cat.join('') + 'concat=n=' + K + ':v=1:a=1[vout][aout]');
  }
  args.push('-filter_complex', chains.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-r', '24', '-movflags', '+faststart', out);
  return args;
}

// 整条后期流水线。synthesize({speaker,text,kind,winLen,shot_idx}) → 音频绝对路径或 null（不配）
export async function runChapterPost({ inputs, shots, music, options, workDir, outAbs, nosubAbs, srtAbs, synthesize, report = () => {}, isAborted }) {
  const o = normalizePostOptions(options);
  if (!inputs.length) throw new Error('没有可后期的分镜视频');
  fs.mkdirSync(workDir, { recursive: true });
  const durations = [];
  for (const p of inputs) durations.push(await probeDur(p));
  if (durations.some((d) => !(d > 0))) throw new Error('有分镜视频探测不到时长');
  report({ phase: '后期', detail: '① 拼接 ' + inputs.length + ' 镜' });
  const base = path.join(workDir, '01_concat.mp4');
  await mergeVideos(inputs, base, { isAborted });
  const total = await probeDur(base) || durations.reduce((a, b) => a + b, 0);
  const plan = buildPostPlan(shots, durations);

  // ② 画外台词窗口
  const offLines = plan.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind);
  const muteWindows = o.os_mute ? mergeIntervals(offLines.filter(({ l }) => l.start != null).map(({ l }) => ({ start: l.start, end: l.end }))) : [];
  const issues = [];
  for (const { l } of offLines) if (l.start == null) issues.push('第' + l.shot_idx + '镜画外台词没找到时间窗，未静音/配音：' + l.speaker + '：' + l.text);
  const dubs = [];
  const dubByLine = {};
  if (o.os_dub && synthesize) {
    for (const { l, i } of offLines) {
      if (l.start == null) continue;
      if (isAborted && isAborted()) throw new Error('已停止');
      const winLen = l.end - l.start;
      report({ phase: '后期', detail: '② 心声配音 第' + l.shot_idx + '镜 ' + l.speaker });
      let p = null;
      try { p = await synthesize({ speaker: l.speaker, text: l.text, kind: l.kind, winLen, shot_idx: l.shot_idx }); }
      catch (e) { issues.push('第' + l.shot_idx + '镜心声配音失败：' + (e && e.message ? e.message : e)); }
      if (!p) { if (!issues.some((x) => x.includes(l.text))) issues.push('第' + l.shot_idx + '镜「' + l.speaker + '」没有可用声线，心声只静音未配音'); continue; }
      const raw = await probeDur(p);
      if (!(raw > 0)) { issues.push('第' + l.shot_idx + '镜配音文件无效'); continue; }
      const tempo = raw > winLen ? Math.min(1.25, raw / winLen) : 1;
      const dur = Math.min(winLen, raw / tempo);
      if (raw / tempo > winLen + 0.05) issues.push('第' + l.shot_idx + '镜心声配音 ' + raw.toFixed(2) + 's 超出窗口 ' + winLen.toFixed(2) + 's，已加速 ' + tempo.toFixed(2) + ' 倍并截断');
      const d = { path: p, start: l.start, winLen, dur, tempo, line: i, shot_idx: l.shot_idx, speaker: l.speaker, text: l.text };
      dubs.push(d); dubByLine[i] = { start: l.start, dur };
    }
  }

  // ③ 空档
  report({ phase: '后期', detail: '③ 检测空档（静音 + 画面静止）' });
  const silences = await detectSilences(base, { total, mute: muteWindows, noiseDb: o.silence_db, isAborted });
  const voiced = complementIntervals(silences, total);
  let motion = null;
  if (o.trim_gaps && o.motion_check) motion = await detectMotion(base, { total, threshold: o.motion_threshold, isAborted });
  const protect = plan.lines.filter((l) => l.start != null).map((l) => ({ start: l.start, end: l.end }));
  const cuts = o.trim_gaps ? computeGapCuts({ total, protect, silences, moving: motion ? motion.moving : null, maxGap: o.max_gap_sec, pad: o.pad_sec }) : [];
  const keeps = keepRanges(total, cuts);

  report({ phase: '后期', detail: '④ 静音心声窗 ' + muteWindows.length + ' 处、配音 ' + dubs.length + ' 条、剪空档 ' + cuts.length + ' 处' });
  const edited = path.join(workDir, '02_edited.mp4');
  await runFfmpeg(buildEditArgs({ base, out: edited, total, muteWindows, dubs, keeps, dubGainDb: o.dub_gain_db }), { isAborted, timeoutMs: 60 * 60 * 1000 });

  // ④ 字幕
  const cues = o.subtitles ? remapCues(buildSubtitleCues(plan, { voiced, dubs: dubByLine }), cuts) : [];
  const srt = cues.length ? cuesToSrt(cues) : '';
  // ⑤ BGM + 烧字幕
  const m = o.bgm ? remapMusic(music, cuts) : undefined;
  report({ phase: '后期', detail: '⑤ 合成成片' + (m ? '（BGM）' : '') + (srt ? '（字幕 ' + cues.length + ' 条）' : '') });
  await mergeVideos([edited], outAbs, { music: m, subtitles: srt, isAborted });
  if (srt && nosubAbs) await mergeVideos([edited], nosubAbs, { music: m, isAborted });
  if (srt && srtAbs) fs.writeFileSync(srtAbs, srt, 'utf8');
  const outDur = await probeDur(outAbs);
  const removed = cuts.reduce((a, c) => a + (c.end - c.start), 0);
  return {
    options: o,
    total_before: +total.toFixed(3), total_after: +outDur.toFixed(3), removed_sec: +removed.toFixed(3),
    shots: plan.shots.map((s) => ({ idx: s.idx, start: +s.start.toFixed(3), end: +s.end.toFixed(3), start_after: +remapTime(s.start, cuts).toFixed(3) })),
    mute_windows: muteWindows.map((w) => ({ start: +w.start.toFixed(3), end: +w.end.toFixed(3), start_after: +remapTime(w.start, cuts).toFixed(3), end_after: +remapTime(w.end, cuts).toFixed(3) })),
    dubs: dubs.map((d) => ({ shot_idx: d.shot_idx, speaker: d.speaker, text: d.text, start: +d.start.toFixed(3), dur: +d.dur.toFixed(3), window_sec: +d.winLen.toFixed(3), tempo: +d.tempo.toFixed(3), start_after: +remapTime(d.start, cuts).toFixed(3), file: path.basename(d.path) })),
    gaps_cut: cuts.map((c) => ({ gap_start: +c.gap_start.toFixed(3), gap_end: +c.gap_end.toFixed(3), cut_start: +c.start.toFixed(3), cut_end: +c.end.toFixed(3) })),
    subtitle_cues: cues.length,
    bgm: !!m,
    motion_frames: motion ? motion.frames : 0,
    issues,
  };
}
