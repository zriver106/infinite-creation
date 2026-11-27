// 承接上一镜 22 帧（Andy 11-26「要接住上一个视频的画面，取上一段最后二十二帧连同声音，钉在下一段的开头」）。
//
// 出片：取本章上一镜当前选中候选的最后 22 帧 + 同一段音频，存成短片段（mov：h264 + pcm，避免 AAC 开头的延迟），
//   用 MiniMaxH3AddGuide 以帧批次 + 音频锚在本镜 frame_idx=0（workflow-runner injectKeyframes 的 clip 分支）。
//   本镜按「总帧数 = 17·round((时长×24 + 22 − 5)/17) + 5」出（H3 的 17k+5 网格），正文 = 总帧数 − 22。
// 导出：凡是带承接的候选（shot_videos.lead_in_frames > 0），合并前先剪掉开头 22 帧、音频剪同样时长（22/24 秒），
//   字幕对时、配乐时间轴、后期都用剪好的文件，自然跟着平移。
// 何时承接：分镜 first_frame_source='prev_clip22' 手动接；'none' 不接；空值按默认规则——
//   和上一镜绑的场景完全相同，且两镜都没写换场 / 跳时 / 闪回，才接。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runFfmpeg, runCapture } from './ffmpeg.js';

export const LEAD_IN_FRAMES = 22;
export const LEAD_IN_FPS = 24;
export const LEAD_IN_SECONDS = LEAD_IN_FRAMES / LEAD_IN_FPS;
export const LEAD_IN_SOURCE = 'prev_clip22';
export const LEAD_IN_OFF = 'none';

/** 承接镜的出片帧数：总帧数对齐 17k+5，正文 = 总帧数 − 22。传给 H3 的 seconds = 总帧数 / 24（Easy 节点四舍五入到网格，正好落在总帧数）。 */
export function leadInRenderPlan(durationSec) {
  const d = Math.max(0.5, Number(durationSec) || 5);
  const k = Math.max(1, Math.round((d * LEAD_IN_FPS + LEAD_IN_FRAMES - 5) / 17));
  const total = k * 17 + 5;
  return { totalFrames: total, contentFrames: total - LEAD_IN_FRAMES, seconds: total / LEAD_IN_FPS, contentSeconds: (total - LEAD_IN_FRAMES) / LEAD_IN_FPS };
}

// 换场 / 跳时 / 闪回的写法（任一镜写了就不自动接）
const BREAK_RE = /换场|转场|切场|跳时|跳切|次日|翌日|第二天|几天后|数日后|几个月后|多年后|半年后|一周后|同一时间|与此同时|另一边|闪回|回忆|梦境|梦里|黑场|淡出|淡入/;
const textOf = (s) => [s.scene_name, s.camera, s.visual, typeof s.sub_shots === 'string' ? s.sub_shots : JSON.stringify(s.sub_shots || '')].join('\n');
const sceneKey = (s) => [...new Set((s.scene_ids || []).map(String))].sort().join('|');

/**
 * 本镜要不要承接上一镜 22 帧。返回 { on, mode:'manual'|'auto'|'off', reason }。
 * prev 是本章上一镜（first-frame.js prevShotOf）。
 */
export function leadInDecision(shot, prev, { samePlace } = {}) {
  const src = String((shot && shot.first_frame_source) || '');
  if (src === LEAD_IN_SOURCE) return prev ? { on: true, mode: 'manual', reason: '分镜设了承接上一镜 22 帧' } : { on: false, mode: 'manual', reason: '本镜是本章第一镜，没有上一镜可承接' };
  if (src === LEAD_IN_OFF) return { on: false, mode: 'off', reason: '分镜设了不承接' };
  if (src) return { on: false, mode: 'off', reason: '分镜用的是首帧图（' + src + '），不叠 22 帧承接' };
  if (!prev) return { on: false, mode: 'auto', reason: '本章第一镜' };
  // 同一地点：调用方给 samePlace（按 binding-check 的地点匹配，_MV 和它的普通场景图算同一地点）；没给就比 scene_ids
  const same = samePlace ? !!samePlace(shot, prev) : (!!sceneKey(shot) && sceneKey(shot) === sceneKey(prev));
  const cross = (prev.chapter || '') !== (shot.chapter || '');
  if (!same) return { on: false, mode: 'auto', reason: '和上一镜' + (cross ? '（上一集末镜）' : '') + '不是同一地点' };
  if (BREAK_RE.test(textOf(shot))) return { on: false, mode: 'auto', reason: '本镜写了换场 / 跳时 / 闪回' };
  if (BREAK_RE.test(textOf(prev))) return { on: false, mode: 'auto', reason: '上一镜写了换场 / 跳时 / 闪回' };
  return { on: true, mode: 'auto', reason: cross ? '跨集：和上一集末镜同一地点、时间连续' : '同一地点、时间连续' };
}

/**
 * 承接用的上一镜：本章里镜号比本镜小的最后一镜；本镜是本章第一镜时，取上一章（按章节顺序）最后一个未作废镜——跨集承接（Andy 11-26）。
 * @param {object} shot  @param {object[]} narrative  Shots.listInNarrativeOrder（已排除作废镜，按章节 seq、镜号排好）
 */
export function leadInPrevOf(shot, narrative) {
  if (!shot) return null;
  const list = (narrative || []).filter((s) => s && s.status !== 'obsolete');
  let best = null;
  for (const s of list) if (s.id !== shot.id && (s.chapter || '') === (shot.chapter || '') && Number(s.idx) < Number(shot.idx) && (!best || Number(s.idx) > Number(best.idx))) best = s;
  if (best) return best;
  const i = list.findIndex((s) => s.id === shot.id);
  if (i <= 0) return null;
  for (let k = i - 1; k >= 0; k--) if ((list[k].chapter || '') !== (shot.chapter || '')) return list[k];
  return null;
}

async function countFrames(videoAbs) {
  const out = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,r_frame_rate', '-of', 'json', videoAbs], { captureStdout: true, timeoutMs: 60_000 });
  const j = JSON.parse(out); const s = (j.streams || [])[0] || {};
  const n = Number(s.nb_read_packets) || 0;
  const m = String(s.r_frame_rate || '').match(/^(\d+)\/(\d+)$/);
  const fps = m ? Number(m[1]) / Number(m[2]) : LEAD_IN_FPS;
  return { n, fps };
}

/** 抽视频最后 22 帧 + 同一段音频，写成 mov（h264 crf 10 + pcm_s16le）。先写临时文件再改名。 */
export async function extractTailClip(videoAbs, outAbs, { frames = LEAD_IN_FRAMES } = {}) {
  const { n, fps } = await countFrames(videoAbs);
  if (n < frames) throw new Error('上一镜视频只有 ' + n + ' 帧，不够取最后 ' + frames + ' 帧');
  const start = n - frames;
  const startSec = start / (fps || LEAD_IN_FPS);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const tmp = outAbs + '.part.mov';
  try {
    await runFfmpeg(['-y', '-v', 'error', '-i', videoAbs,
      '-vf', 'select=gte(n\\,' + start + '),setpts=N/(' + LEAD_IN_FPS + '*TB)', '-fps_mode', 'cfr', '-frames:v', String(frames),
      '-af', 'atrim=start=' + startSec.toFixed(6) + ',asetpts=PTS-STARTPTS',
      '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-r', String(LEAD_IN_FPS), '-c:a', 'pcm_s16le', '-ar', '48000', tmp], { timeoutMs: 120_000 });
    const got = await countFrames(tmp);
    if (got.n !== frames) throw new Error('抽出的片段是 ' + got.n + ' 帧，不是 ' + frames + ' 帧');
    fs.renameSync(tmp, outAbs);
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch {}
  }
  return outAbs;
}

/** 导出用：剪掉开头 lead 帧（视频按帧、音频按同样时长）。按源文件大小 + 修改时间缓存在源文件旁（<名>_lead<N>trim_<hash>.mp4）。 */
export async function trimLeadIn(videoAbs, { frames = LEAD_IN_FRAMES } = {}) {
  const st = fs.statSync(videoAbs);
  const h = crypto.createHash('md5').update(videoAbs + '|' + st.size + '|' + st.mtimeMs + '|' + frames).digest('hex').slice(0, 8);
  const outAbs = videoAbs.replace(/(\.[^./\\]+)?$/, '_lead' + frames + 'trim_' + h + '.mp4');
  if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0) return outAbs;
  const tmp = outAbs + '.part.mp4';
  try {
    await runFfmpeg(['-y', '-v', 'error', '-i', videoAbs,
      '-vf', 'trim=start_frame=' + frames + ',setpts=PTS-STARTPTS',
      '-af', 'atrim=start=' + (frames / LEAD_IN_FPS).toFixed(6) + ',asetpts=PTS-STARTPTS',
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeoutMs: 300_000 });
    fs.renameSync(tmp, outAbs);
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch {}
  }
  return outAbs;
}

/**
 * 合成 / 导出 / 后期的输入：带承接的选中候选换成剪掉开头 22 帧的文件，其余原样。
 * @param {Array<{ video_path:string }>} shots  @param {(rel)=>string} resolve  @param {(shot)=>number} leadOf 该镜选中候选的 lead_in_frames
 */
export async function assemblyInputsFor(shots, resolve, leadOf, { trim = trimLeadIn } = {}) {
  // 和 shots 一一对应（解析不到的位置留原值，调用方照旧 filter / 报缺）
  const out = [];
  for (const s of shots) {
    const abs = resolve(s.video_path);
    const lead = Number(leadOf(s)) || 0;
    out.push(abs && lead > 0 && fs.existsSync(abs) ? await trim(abs, { frames: lead }) : abs);
  }
  return out;
}
