// 承接上一镜 22 帧的上下文（lib/core/lead-in.js 的纯函数 + 本项目数据）：上一镜（含跨集）、要不要接、本镜已出的片承接是否过期。
// 「同一地点」按 binding-check 的地点匹配：_MV 和它的普通场景图算同一地点（主会话 / 总导 11-26）。
import { Shots, ShotVideos, Assets, loadConfig } from '../core/index.js';
import { leadInDecision, leadInPrevOf } from '../core/lead-in.js';
import { placeOf } from './binding-check.js';

const isMv = (a) => a && a.category === 'scene' && /_MV|多视角定义图/.test(String(a.name || ''));

/** 上一镜当前用于成片的视频标识：选中候选 id；老数据没有候选行时用视频路径。 */
export function currentVideoKey(prev) {
  if (!prev) return '';
  const sel = ShotVideos.selectedForShot(prev.id);
  return (sel && sel.id) || prev.video_path || '';
}

export function leadInContext(projectId, shot, { narrative, assets } = {}) {
  const list = narrative || Shots.listInNarrativeOrder(projectId);
  const as = assets || Assets.list(projectId);
  const byId = new Map(as.map((a) => [a.id, a]));
  const mvs = as.filter(isMv);
  const prev = leadInPrevOf(shot, list);
  const samePlace = (x, y) => { const a = placeOf(x, byId, mvs); const b = placeOf(y, byId, mvs); return !!a && a === b; };
  let decision = leadInDecision(shot, prev, { samePlace });
  // 系统设置关了自动承接：自动判断的「接」不生效，显示也按不接（手动设的「接」照常）
  if (decision.on && decision.mode === 'auto') {
    let auto = true; try { auto = !((loadConfig().generation || {}).leadInAuto === false); } catch {}
    if (!auto) decision = { on: false, mode: 'auto', reason: '自动承接已关（系统设置）；按规则本可接：' + decision.reason };
  }
  const info = ShotVideos.leadInInfoOfShot(shot);
  const cur = currentVideoKey(prev);
  const stale = !!(info.frames > 0 && prev && info.from && cur && info.from !== cur);
  return {
    prev, decision, cross: !!(prev && (prev.chapter || '') !== (shot.chapter || '')),
    lead_in_frames: info.frames, stale,
    ...(stale ? { stale_reason: '承接的上一镜（' + (prev.chapter !== shot.chapter ? prev.chapter : '') + '第' + prev.idx + '镜）换了选中片或重出了，本镜开头钉的是旧画面，需要重出本镜' } : {}),
  };
}

/** 给接口用的精简版（不带整条上一镜）。 */
export function leadInView(ctx) {
  const { prev, decision, cross, lead_in_frames, stale, stale_reason } = ctx;
  return { ...decision, cross, prev_idx: prev ? prev.idx : null, prev_chapter: prev ? prev.chapter : '', lead_in_frames, stale, ...(stale_reason ? { stale_reason } : {}) };
}
