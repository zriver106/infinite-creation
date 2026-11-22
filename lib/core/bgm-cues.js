// 章节 BGM cue 表（2026-11-18）：一章内按时间段切曲、撤乐（静音）、做音量自动化。
//
// cue 记在 chapters.music_prompt（JSON）的 cues 字段里，每条：
//   { start, end, music_id | "silence", fade_in, fade_out, source_offset, volume?, note? }
//   start / end：成片时间轴上的秒数（与 mergeVideos 拼接后的音轨一致）。
//   music_id："silence"（或「静音」）= 这段撤掉全部 BGM，只留现场声和对白；其他值 = 曲目（set_chapter_music_cues 写入时解析成 asset_id）。
//   fade_in / fade_out：本段进、出的淡化秒数。交接时先让前一段淡出到 0，再让后一段从 0 淡入（两首不叠放）。
//   source_offset：从曲子的第几秒开始放；不写时，主曲从断点接着放，插入曲从 0 开始。
// 主曲 = 本章 set_chapter_music 绑定的曲子（music_path）。cue 没覆盖到的时间段放主曲；
// 主曲只在真正播放时前进，静音段 / 插入段结束后从断点继续放。本章没有主曲（静音章）时，空档就是无 BGM。
// 没有 cue 表时 mergeVideos 走原来的整章一首循环逻辑，行为不变。
//
// 循环（B_v2，2026-11-18）：cue 模式下曲子比要放的长度短时，不再用 -stream_loop -1 从曲尾硬接曲头，
// 而是在乐句边界交叉淡化循环（≥ 0.5 秒）。依据：M\docs\剪辑与配乐基础规范.md §4.6「主曲比需要的长度短时，
// 在乐句边界上交叉淡化循环，不能从曲尾硬接曲头……循环点取登记的乐句终点和乐句起点，交叉淡化 ≥ 0.5 秒」，
// §4.5 表「主曲循环接缝｜在乐句边界交叉淡化，≥ 0.5 秒」，§8 D6，§7.3 DEV04。
// 乐句点登记在 music_prompt.loops（set_chapter_music_cues 的 loops 参数）：{ loop_start, loop_end, xfade }，
// 第一遍从 0 放到 loop_end，之后每遍从 loop_start 放到 loop_end，接缝处 acrossfade（qsin 等功率）。
// 没登记乐句点的曲子：先切掉曲头静音和曲尾淡出/静音，再在曲尾与曲头之间交叉淡化（仍不硬接），日志里注明「未登记乐句点」。
// 只有探测不到曲长时才退回 -stream_loop（日志注明）。
//
// 本文件只放纯函数（不碰数据库、不起 ffmpeg），便于单测；数据库查询由调用方以 deps 注入。

export const CUE_SILENCE = 'silence';
export const CUE_MAIN = '__main__';
export const CUE_DEFAULT_FADE = 1;
const SILENCE_WORDS = new Set(['silence', '静音']);

export function isCueSilence(v) {
  return SILENCE_WORDS.has(String(v == null ? '' : v).trim().toLowerCase());
}

function num(v, name, idx, { def, min = 0 } = {}) {
  if (v == null || v === '') {
    if (def !== undefined) return def;
    throw new Error('cue 第 ' + (idx + 1) + ' 条缺少 ' + name);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('cue 第 ' + (idx + 1) + ' 条的 ' + name + ' 不是数字：' + v);
  if (n < min) throw new Error('cue 第 ' + (idx + 1) + ' 条的 ' + name + ' 不能小于 ' + min + '：' + v);
  return n;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

export const CUE_LOOP_XFADE = 1;        // 缺省交叉淡化秒数
export const CUE_LOOP_XFADE_MIN = 0.5;  // 规范 §4.5 / §4.6：循环接缝交叉淡化 ≥ 0.5 秒
export const CUE_LOOP_TAIL_DB = -40;    // 未登记乐句点时：曲尾低于此电平的淡出/静音先切掉
export const CUE_LOOP_TRIM_MARGIN = 8;  // 未登记乐句点时：切掉的长度未知，估份数按这么多秒保守扣减

// 校验一条乐句循环点：{ loop_start, loop_end, xfade? }。坏值直接抛。
export function normalizeLoop(raw, label = '') {
  const tag = label ? ('「' + label + '」') : '';
  if (!raw || typeof raw !== 'object') throw new Error('循环点' + tag + '必须是对象 { loop_start, loop_end, xfade }');
  const n = (v, k, def) => {
    if (v == null || v === '') { if (def !== undefined) return def; throw new Error('循环点' + tag + '缺少 ' + k); }
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new Error('循环点' + tag + '的 ' + k + ' 必须是非负数字：' + v);
    return x;
  };
  const loop_start = r3(n(raw.loop_start, 'loop_start'));
  const loop_end = r3(n(raw.loop_end, 'loop_end'));
  const xfade = r3(n(raw.xfade, 'xfade', CUE_LOOP_XFADE));
  if (xfade < CUE_LOOP_XFADE_MIN) throw new Error('循环点' + tag + '的交叉淡化 ' + xfade + ' 秒短于规范下限 ' + CUE_LOOP_XFADE_MIN + ' 秒（剪辑与配乐基础规范 §4.6）');
  if (!(loop_end - loop_start > xfade * 2)) throw new Error('循环点' + tag + '的乐句段 ' + loop_start + '–' + loop_end + ' 秒太短：至少要比两倍交叉淡化（' + (xfade * 2) + ' 秒）长');
  return { loop_start, loop_end, xfade };
}

// 每条曲目最多要放到曲内第几秒（段的 src + 段长的最大值）。
export function cueTrackNeeds(segments) {
  const need = {};
  for (const s of segments || []) need[s.track] = Math.max(need[s.track] || 0, r3(s.src + (s.end - s.start)));
  return need;
}

// 一条曲目怎么铺够长度。返回 { copies, loopStart, loopEnd, xfade, registered, trim }：
//   copies=1：曲子够长，不循环；copies>1：拼 copies 遍、接缝交叉淡化；copies=0：曲长未知，调用方退回 -stream_loop。
// 「虚拟时间」= 拼好后的连续曲子上的秒数；planBgmCues 的 src 就落在这条虚拟时间上。
export function planTrackLoop({ needSec, durSec = 0, loop = null }) {
  const need = Number(needSec) || 0;
  const dur = Number(durSec) || 0;
  if (loop) {
    const l = normalizeLoop(loop);
    const loopEnd = dur > 0 ? Math.min(l.loop_end, dur) : l.loop_end;
    if (!(loopEnd - l.loop_start > l.xfade * 2)) throw new Error('登记的循环点超出曲长：' + l.loop_start + '–' + l.loop_end + ' 秒，曲长 ' + dur + ' 秒');
    if (need <= loopEnd + 1e-6) return { copies: 1, registered: true, trim: false };
    const copies = 1 + Math.ceil((need - loopEnd) / (loopEnd - l.loop_start - l.xfade));
    return { copies, loopStart: l.loop_start, loopEnd: r3(loopEnd), xfade: l.xfade, registered: true, trim: false };
  }
  if (!(dur > 0)) return { copies: need > 0 ? 0 : 1, registered: false, trim: false };
  if (need <= dur + 1e-6) return { copies: 1, registered: false, trim: false };
  const xfade = CUE_LOOP_XFADE;
  const est = Math.max(dur - Math.min(CUE_LOOP_TRIM_MARGIN, dur * 0.3), xfade * 2 + 0.1);
  const copies = 1 + Math.ceil((need - est) / (est - xfade));
  return { copies, loopStart: 0, loopEnd: null, xfade, registered: false, trim: true };
}

// 校验并规范 cue 表：按 start 排序；不允许重叠；end 必须大于 start。出错直接抛（写入时当场改正，不把坏表存下来）。
export function normalizeCues(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('cues 必须是数组');
  const out = raw.map((c, i) => {
    if (!c || typeof c !== 'object') throw new Error('cue 第 ' + (i + 1) + ' 条不是对象');
    const start = num(c.start, 'start', i);
    const end = num(c.end, 'end', i);
    if (!(end > start)) throw new Error('cue 第 ' + (i + 1) + ' 条 end 必须大于 start：' + start + '–' + end);
    const id = String(c.music_id == null ? '' : c.music_id).trim();
    if (!id) throw new Error('cue 第 ' + (i + 1) + ' 条缺少 music_id（曲目编号，或 "silence" 表示静音）');
    const silence = isCueSilence(id);
    const cue = {
      start: r3(start), end: r3(end),
      music_id: silence ? CUE_SILENCE : id,
      fade_in: r3(num(c.fade_in, 'fade_in', i, { def: CUE_DEFAULT_FADE })),
      fade_out: r3(num(c.fade_out, 'fade_out', i, { def: CUE_DEFAULT_FADE })),
      source_offset: (c.source_offset == null || c.source_offset === '') ? null : r3(num(c.source_offset, 'source_offset', i)),
    };
    if (c.volume != null && c.volume !== '') cue.volume = num(c.volume, 'volume', i);
    if (c.asset_id) cue.asset_id = String(c.asset_id);
    if (c.music_name) cue.music_name = String(c.music_name);
    if (c.note) cue.note = String(c.note);
    return cue;
  });
  out.sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end - 1e-6) {
      throw new Error('cue 时间重叠：' + out[i - 1].start + '–' + out[i - 1].end + 's 与 ' + out[i].start + '–' + out[i].end + 's');
    }
  }
  return out;
}

// 把 cue 表展开成整章时间线。
// cues：normalizeCues 的结果，每条再带 track（CUE_SILENCE / CUE_MAIN / 其他曲目键）。
// 返回 { timeline, segments }：timeline 含静音段（便于核对），segments 只含真正要垫的曲段：
//   { start, end, track, src, fadeIn, fadeOut, volume }，src = 该曲从第几秒开始放。
export function planBgmCues({ cues, totalSec, mainKey = null, volume = 0.25, defaultFade = CUE_DEFAULT_FADE }) {
  if (!(totalSec > 0)) throw new Error('cue 表合成需要成片总时长（探测失败）');
  const list = (cues || []).filter((c) => c.start < totalSec).map((c) => ({ ...c, end: Math.min(c.end, totalSec) }));
  const timeline = [];
  let t = 0;
  let mainPos = 0;
  const pushMain = (a, b) => {
    if (!(b - a > 1e-6)) return;
    if (mainKey) { timeline.push({ start: a, end: b, track: mainKey, src: mainPos, implicit: true }); mainPos += b - a; }
    else timeline.push({ start: a, end: b, track: CUE_SILENCE, implicit: true });
  };
  for (const c of list) {
    pushMain(t, c.start);
    const len = c.end - c.start;
    const track = c.track || (isCueSilence(c.music_id) ? CUE_SILENCE : c.music_id);
    if (track === CUE_SILENCE) {
      timeline.push({ start: c.start, end: c.end, track: CUE_SILENCE, cue: c });
    } else if (track === mainKey) {
      const src = c.source_offset != null ? c.source_offset : mainPos;
      timeline.push({ start: c.start, end: c.end, track, src, cue: c });
      mainPos = src + len;
    } else {
      timeline.push({ start: c.start, end: c.end, track, src: c.source_offset != null ? c.source_offset : 0, cue: c });
    }
    t = c.end;
  }
  pushMain(t, totalSec);

  // 淡化：cue 段用自己的 fade_in / fade_out；cue 没覆盖的主曲段，前后挨着别的段时用默认淡化，章头章尾不淡。
  const segments = [];
  for (let i = 0; i < timeline.length; i++) {
    const s = timeline[i];
    if (s.track === CUE_SILENCE) continue;
    const len = s.end - s.start;
    let fi = s.cue ? s.cue.fade_in : (i > 0 ? defaultFade : 0);
    let fo = s.cue ? s.cue.fade_out : (i < timeline.length - 1 ? defaultFade : 0);
    if (fi + fo > len) { const k = len / (fi + fo); fi *= k; fo *= k; }
    const v = s.cue && s.cue.volume != null ? s.cue.volume : volume;
    segments.push({ start: r3(s.start), end: r3(s.end), track: s.track, src: r3(s.src), fadeIn: r3(fi), fadeOut: r3(fo), volume: v });
  }
  return {
    timeline: timeline.map((s) => ({ start: r3(s.start), end: r3(s.end), track: s.track, ...(s.src != null ? { src: r3(s.src) } : {}) })),
    segments,
  };
}

// segments → ffmpeg filter 片段。inputIndex：曲目键 → ffmpeg 输入序号。
// loops：曲目键 → planTrackLoop 结果（copies>1 的才需要）：先把该曲拼成够长的一条（接缝交叉淡化），再按段取用。
// 每段：atrim 取曲子 [src, src+len) → 淡入淡出 → 音量 → adelay 放到成片时间轴 start；再 amix 合成一条 [bgm]。
// 没有要垫的段时返回 null（整章静音）。
export function loopChainFilter(inLabel, lp, tag) {
  const parts = [];
  for (let i = 0; i < lp.copies; i++) parts.push('[lp' + tag + '_' + i + ']');
  let f = inLabel + 'aresample=44100';
  if (lp.trim) {
    f += ',silenceremove=start_periods=1:start_threshold=-50dB'
      + ',areverse,silenceremove=start_periods=1:start_threshold=' + CUE_LOOP_TAIL_DB + 'dB,areverse';
  }
  const chains = [f + ',asplit=' + lp.copies + parts.join('')];
  const pieces = parts.map((p, i) => {
    if (!lp.registered) return p;
    const q = '[lq' + tag + '_' + i + ']';
    chains.push(p + 'atrim=' + (i === 0 ? 'end=' + lp.loopEnd : 'start=' + lp.loopStart + ':end=' + lp.loopEnd) + ',asetpts=PTS-STARTPTS' + q);
    return q;
  });
  let cur = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    const next = (i === pieces.length - 1) ? '[lt' + tag + ']' : '[lx' + tag + '_' + i + ']';
    chains.push(cur + pieces[i] + 'acrossfade=d=' + lp.xfade + ':c1=qsin:c2=qsin' + next);
    cur = next;
  }
  return { filter: chains.join(';'), label: cur };
}

export function buildCueBgmFilter(segments, inputIndex, { outLabel = 'bgm', loops = {} } = {}) {
  if (!segments || !segments.length) return null;
  const byTrack = new Map();
  segments.forEach((s, i) => { if (!byTrack.has(s.track)) byTrack.set(s.track, []); byTrack.get(s.track).push(i); });
  const chains = [];
  const srcLabel = new Array(segments.length);
  let ti = 0;
  for (const [track, idxs] of byTrack) {
    const inIdx = inputIndex[track];
    if (inIdx == null) throw new Error('cue 曲目没有对应的输入：' + track);
    let src = '[' + inIdx + ':a]';
    const lp = loops && loops[track];
    if (lp && lp.copies > 1) { const lc = loopChainFilter(src, lp, String(ti)); chains.push(lc.filter); src = lc.label; }
    if (idxs.length === 1) { srcLabel[idxs[0]] = src; ti++; continue; }
    const outs = idxs.map((_, k) => '[ct' + ti + '_' + k + ']');
    chains.push(src + 'asplit=' + idxs.length + outs.join(''));
    idxs.forEach((segIdx, k) => { srcLabel[segIdx] = outs[k]; });
    ti++;
  }
  const segLabels = [];
  segments.forEach((s, i) => {
    const len = s.end - s.start;
    let f = srcLabel[i] + 'aresample=44100,atrim=start=' + s.src + ':end=' + r3(s.src + len) + ',asetpts=PTS-STARTPTS';
    if (s.fadeIn > 0) f += ',afade=t=in:st=0:d=' + s.fadeIn;
    if (s.fadeOut > 0) f += ',afade=t=out:st=' + r3(len - s.fadeOut) + ':d=' + s.fadeOut;
    f += ',volume=' + s.volume;
    const ms = Math.round(s.start * 1000);
    if (ms > 0) f += ',adelay=' + ms + ':all=1';
    const lab = '[cs' + i + ']';
    chains.push(f + lab);
    segLabels.push(lab);
  });
  if (segLabels.length === 1) chains.push(segLabels[0] + 'anull[' + outLabel + ']');
  else chains.push(segLabels.join('') + 'amix=inputs=' + segLabels.length + ':duration=longest:dropout_transition=0:normalize=0[' + outLabel + ']');
  return { filter: chains.join(';'), label: outLabel };
}

// 章节 → mergeVideos 的 music 参数。deps：{ getAsset(id), resolvePath(rel), exists(abs) }（调用方注入，便于单测）。
// 没有 cue 表：与原来一样，只有主曲（music_path 文件在）时返回 { path, volume }，否则 undefined。
// 有 cue 表：返回 { path, volume, cues（带 track）, tracks（曲目键 → 绝对路径）, mainKey }。
// cue 里的曲目文件找不到时直接抛错，不悄悄少一段音乐。
export function chapterMusicForMerge(ch, deps, { volume = 0.25 } = {}) {
  const { getAsset, resolvePath, exists } = deps;
  const mainAbs = ch && ch.music_path ? resolvePath(ch.music_path) : null;
  const mainOk = !!(mainAbs && exists(mainAbs));
  let prompt = {};
  try { prompt = JSON.parse((ch && ch.music_prompt) || '{}') || {}; } catch {}
  if (typeof prompt !== 'object' || Array.isArray(prompt)) prompt = {};
  const raw = Array.isArray(prompt.cues) ? prompt.cues : [];
  if (!raw.length) return mainOk ? { path: mainAbs, volume } : undefined;
  const cues = normalizeCues(raw);
  const tracks = {};
  if (mainOk) tracks[CUE_MAIN] = mainAbs;
  const out = cues.map((c) => {
    if (c.music_id === CUE_SILENCE) return { ...c, track: CUE_SILENCE };
    if (mainOk && c.asset_id && c.asset_id === prompt.music_id) return { ...c, track: CUE_MAIN };
    const a = c.asset_id ? getAsset(c.asset_id) : null;
    const abs = a && a.audio_path ? resolvePath(a.audio_path) : null;
    if (!abs || !exists(abs)) throw new Error('cue 表里的曲目音频不存在：' + c.music_id + '（' + c.start + '–' + c.end + 's）。请重新 set_chapter_music_cues。');
    tracks[c.asset_id] = abs;
    return { ...c, track: c.asset_id };
  });
  // 登记的乐句循环点（music_prompt.loops：[{ asset_id, loop_start, loop_end, xfade }]）→ 按曲目键
  const loops = {};
  for (const l of Array.isArray(prompt.loops) ? prompt.loops : []) {
    if (!l || !l.asset_id) continue;
    const key = (mainOk && l.asset_id === prompt.music_id) ? CUE_MAIN : l.asset_id;
    if (tracks[key]) loops[key] = normalizeLoop(l, l.music_name || l.asset_id);
  }
  return { path: mainOk ? mainAbs : '', volume, cues: out, tracks, mainKey: mainOk ? CUE_MAIN : null, loops };
}
