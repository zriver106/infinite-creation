// ic27 首尾帧衔接（2026-11-22 Andy：相邻镜头接缝处人物站位/道具跳变、画面一闪一闪）。
//
// 分镜卡片上的「首帧」槽位（可选「尾帧」）：
//   - 承接上一镜（source='prev_shot'）：取本章上一镜「当前选中候选」的最后一帧（ffmpeg 抽帧，CPU），
//     存到 <项目>/frames/，并记下来源 shot_id + shot_videos.id。上一镜换了选中候选 / 重新出片 / 中间插了镜
//     → 判「已过期」；真正出片前会自动按上一镜当前选中候选重抽一次（批量出片时上一镜刚出完也能接上）。
//   - 手动指定（source='upload'）：用 /media 上传的图或项目内任一图片相对路径。
// 出片时首/尾帧作为 MiniMaxH3AddGuide 关键帧锚定（frame_idx=0 / -1）叠加在原有参考图/音色之上，
// 不占 9 张参考图上限、不改 mode。见 workflow-runner.js injectKeyframes 与 workflow-specs.js spec.keyframes。
//
// 历史 first_last 模式（插入自定义分镜时上传首+尾帧、first_frame_source=''）保持原样，不经过这里。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Shots, ShotVideos } from './db.js';
import { resolveProjectPath } from './refs.js';
import { runFfmpeg } from './ffmpeg.js';
import { logger } from './logger.js';

export const FRAME_DIR = 'frames';
export const FRAME_SOURCES = ['upload', 'prev_shot'];
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

// 本章上一镜：同章、未作废、idx 比本镜小的里面 idx 最大的一条。
export function prevShotOf(shot, shots) {
  if (!shot) return null;
  let best = null;
  for (const s of shots || []) {
    if (!s || s.id === shot.id || s.status === 'obsolete') continue;
    if ((s.chapter || '') !== (shot.chapter || '')) continue;
    if (!(Number(s.idx) < Number(shot.idx))) continue;
    if (!best || Number(s.idx) > Number(best.idx)) best = s;
  }
  return best;
}

// 上一镜「当前用于成片」的视频：选中候选优先；老数据只有 shots.video_path（无候选行）也认。
function currentVideoOf(prev, selectedFor) {
  if (!prev) return null;
  const sel = selectedFor(prev.id);
  if (sel && sel.video_path) return { video_id: sel.id, video_path: sel.video_path };
  if (prev.video_path) return { video_id: '', video_path: prev.video_path };
  return null;
}

// 抽视频最后一帧为 PNG。-sseof -1 只解码最后 1 秒，-update 1 让输出反复覆盖同一文件 → 留下的就是最后一帧。
// 先写临时文件再 rename，避免半截 PNG 被当成有效首帧。
export async function extractLastFrame(videoAbs, outAbs) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const tmp = outAbs + '.part.png';
  try {
    await runFfmpeg(['-y', '-v', 'error', '-sseof', '-1', '-i', videoAbs, '-an', '-update', '1', tmp], { timeoutMs: 60_000 });
    const st = fs.statSync(tmp);
    if (!st.size) throw new Error('抽帧结果为空文件');
    fs.renameSync(tmp, outAbs);
  } finally {
    try { if (fs.existsSync(tmp)) fs.renameSync(tmp, tmp + '.failed'); } catch {}
  }
  return outAbs;
}

// 首帧槽位状态（给列表接口 / 前端「已过期」提示 / 出片前判断用）。纯函数：只读传入的 shots + 选中候选查询。
export function firstFrameStatus(shot, shots, { selectedFor = (id) => ShotVideos.selectedForShot(id), exists = (rel) => !!rel && fs.existsSync(rel) } = {}) {
  const source = shot?.first_frame_source || '';
  const out = { source, path: shot?.first_frame_path || '', stale: false, reason: '', prev_shot_id: '', prev_idx: null, prev_video_id: '', from_video_id: shot?.first_frame_from_video_id || '' };
  if (!shot || !FRAME_SOURCES.includes(source)) return out;
  if (!out.path) { out.stale = true; out.reason = '首帧文件路径为空'; return out; }
  if (!exists(out.path)) { out.stale = true; out.reason = '首帧图片文件不存在'; }
  if (source !== 'prev_shot') return out;
  const prev = prevShotOf(shot, shots);
  if (!prev) { out.stale = true; out.reason = '本镜已是本章第一镜，没有上一镜可承接'; return out; }
  out.prev_shot_id = prev.id;
  out.prev_idx = prev.idx;
  const cur = currentVideoOf(prev, selectedFor);
  out.prev_video_id = cur ? cur.video_id : '';
  if ((shot.first_frame_from_shot_id || '') !== prev.id) {
    out.stale = true; out.reason ='上一镜已变（插入/删除/调整了镜号），首帧不是当前上一镜（第' + prev.idx + '镜）的画面';
  } else if (!cur) {
    out.stale = true; out.reason = '上一镜（第' + prev.idx + '镜）当前没有可用的视频';
  } else if ((cur.video_id || '') !== (shot.first_frame_from_video_id || '')) {
    out.stale = true; out.reason = '上一镜（第' + prev.idx + '镜）换了选中候选 / 重新出片，首帧已过期';
  }
  return out;
}

function frameFileName(shot, kind, key) {
  const h = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 10);
  return FRAME_DIR + '/shot' + shot.idx + '_' + String(shot.id).slice(0, 8) + '_' + kind + '_' + h + '.png';
}

// 承接上一镜：抽上一镜当前选中候选的最后一帧，写进本镜首帧槽位。同一条源视频抽过就复用（文件名按源视频 id+路径定）。
export async function chainFirstFrameFromPrev(projectId, shotId, { extract = extractLastFrame } = {}) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== projectId) throw new Error('分镜不存在');
  const shots = Shots.list(projectId);
  const prev = prevShotOf(shot, shots);
  if (!prev) throw new Error('第' + shot.idx + '镜是本章第一镜，没有上一镜可承接');
  const cur = currentVideoOf(prev, (id) => ShotVideos.selectedForShot(id));
  if (!cur) throw new Error('上一镜（第' + prev.idx + '镜）还没有选中的候选视频，无法承接');
  const videoAbs = resolveProjectPath(projectId, cur.video_path);
  if (!videoAbs || !fs.existsSync(videoAbs)) throw new Error('上一镜（第' + prev.idx + '镜）选中候选的视频文件不存在：' + cur.video_path);
  const rel = frameFileName(shot, 'first_from_shot' + prev.idx, (cur.video_id || '') + '|' + cur.video_path);
  const outAbs = resolveProjectPath(projectId, rel);
  if (!outAbs) throw new Error('首帧输出路径越界');
  let reused = fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0;
  if (!reused) await extract(videoAbs, outAbs);
  const updated = Shots.setFrameAnchor(shotId, {
    first_frame_path: rel,
    first_frame_source: 'prev_shot',
    first_frame_from_shot_id: prev.id,
    first_frame_from_video_id: cur.video_id || '',
  });
  logger.info('首帧承接上一镜', { shot: shotId, idx: shot.idx, prev: prev.id, prev_idx: prev.idx, video_id: cur.video_id, rel, reused });
  return { shot: updated, prev_shot_id: prev.id, prev_idx: prev.idx, video_id: cur.video_id || '', video_path: cur.video_path, first_frame_path: rel, reused };
}

// 手动指定首帧/尾帧：rel 必须是项目内存在的图片文件（/media 上传返回的 path，或项目里已有的图）。
export function setUploadedFrame(projectId, shotId, which, rel) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== projectId) throw new Error('分镜不存在');
  const abs = resolveProjectPath(projectId, rel);
  if (!abs || !fs.existsSync(abs)) throw new Error('图片不存在或不在项目目录内：' + rel);
  if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) throw new Error('首尾帧只接受图片（png/jpg/webp/bmp）');
  if (which === 'last') return Shots.setFrameAnchor(shotId, { last_frame_path: rel, last_frame_source: 'upload' });
  return Shots.setFrameAnchor(shotId, { first_frame_path: rel, first_frame_source: 'upload', first_frame_from_shot_id: '', first_frame_from_video_id: '' });
}

// 清空槽位：只清数据库引用，图片文件保留（不做不可逆删除）。
export function clearFrame(projectId, shotId, which) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== projectId) throw new Error('分镜不存在');
  if (which === 'last') return Shots.setFrameAnchor(shotId, { last_frame_path: '', last_frame_source: '' });
  return Shots.setFrameAnchor(shotId, { first_frame_path: '', first_frame_source: '', first_frame_from_shot_id: '', first_frame_from_video_id: '' });
}

// 槽位是否由卡片设置（区别于历史 first_last 自定义分镜的上传）。
export function hasFrameSlot(shot) {
  return !!(shot && (FRAME_SOURCES.includes(shot.first_frame_source || '') || shot.last_frame_source === 'upload'));
}

// 出片前解析本镜要锚定的关键帧。返回 [{ rel, abs, frame_idx, label }]（未上传到 ComfyUI）。
// - first_last（历史两图模式）：不经过这里（那条路径自己把两张图当 media 传给 H3 image 模式）。
// - image（图生视频）：上传的参考图本身就是首帧，卡片槽位忽略并提示。
// - 承接上一镜且已过期：自动按上一镜当前选中候选重抽；重抽失败 → 旧图还在就照用并告警，没有就不锚定并告警。
export async function resolveShotKeyframes(projectId, shotId, { mode, report = () => {}, chain = chainFirstFrameFromPrev } = {}) {
  let shot = Shots.get(shotId);
  if (!shot || !hasFrameSlot(shot)) return [];
  if (mode === 'first_last') return [];
  if (mode === 'image') {
    report('图生视频模式：参考图本身就是首帧，卡片上的首/尾帧槽位本次不生效');
    return [];
  }
  const out = [];
  if (FRAME_SOURCES.includes(shot.first_frame_source || '')) {
    if (shot.first_frame_source === 'prev_shot') {
      const st = firstFrameStatus(shot, Shots.list(projectId), { exists: (rel) => { const a = resolveProjectPath(projectId, rel); return !!a && fs.existsSync(a); } });
      if (st.stale) {
        try {
          const r = await chain(projectId, shotId);
          shot = r.shot || Shots.get(shotId);
          report('首帧已过期（' + st.reason + '），已按上一镜（第' + r.prev_idx + '镜）当前选中候选重新抽帧');
        } catch (e) {
          report('首帧已过期（' + st.reason + '），重新承接失败：' + e.message + (shot.first_frame_path ? '；本次仍用旧首帧' : '；本次不锚定首帧'));
        }
      }
    }
    const abs = resolveProjectPath(projectId, shot.first_frame_path);
    if (abs && fs.existsSync(abs)) out.push({ rel: shot.first_frame_path, abs, frame_idx: 0, label: shot.first_frame_source === 'prev_shot' ? '首帧（承接上一镜）' : '首帧' });
    else if (shot.first_frame_path) report('首帧图片不存在（' + shot.first_frame_path + '），本次不锚定首帧');
  }
  if (shot.last_frame_source === 'upload' && shot.last_frame_path) {
    const abs = resolveProjectPath(projectId, shot.last_frame_path);
    if (abs && fs.existsSync(abs)) out.push({ rel: shot.last_frame_path, abs, frame_idx: -1, label: '尾帧' });
    else report('尾帧图片不存在（' + shot.last_frame_path + '），本次不锚定尾帧');
  }
  return out;
}
