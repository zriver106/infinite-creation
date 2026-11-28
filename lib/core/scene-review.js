// 场景三视图审图（手册 13 号；总导 11-28 补三条）：美术加工后的四视图（平面 / 正 / 左 / 右）由 IC 审图 Agent 审，过了才写进 art/（= 定稿，refs.js 会送参考图）。
// 这里是不碰 Agent 的部分：① 母本逐件清单（每件在各视图横向应占的百分比）；② 宽高比核对（美术 vs 同视图灰模，整图差 >10% 直接不过）；
// ③ 审图总览图（每视图左灰模右美术 + 最下面四张美术并排）；④ 审图轮次目录（candidates/<round>/）登记、过了写回 art/（旧的进 art_history/）+ 拼 2×2 白板、不过写退回意见。
// 拼图一律用 ffmpeg（仓库现有做法），不加 npm 依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sceneMasterDir, safeId, getSceneMaster, SCENE_VIEWS } from './scene-master.js';

// 审图阈值集中在这里调（总导 11-28 改口径：位置 12%、尺寸只抓差一倍以上、房间留不留灰模的边距不判）；get_scene_review_context 原样给审图 Agent
export const REVIEW_LIMITS = Object.freeze({
  ratio_tol: 0.10, // 美术 / 灰模整图宽高比差超过它 = 这张不过
  pos_tol_pct: 12, // 物件横向位置（中心）和清单差超过画面宽度的这个百分比 = 这件不对
  size_factor: 2, // 物件横向尺寸差到这个倍数（大一倍或小一半）及以上才算不对；小于它不判
  margin_judged: false, // 房间四周留不留灰模那样的边距 / 白边：不作为不过的理由
});
export const RATIO_TOL = REVIEW_LIMITS.ratio_tol;
export const POS_TOL_PCT = REVIEW_LIMITS.pos_tol_pct;

/** 从「17–23%」「40%」这类写法里取数：两个数 = 范围，一个数 = 中心点；取不到返回 null。 */
export function parsePct(s) {
  const n = String(s ?? '').match(/\d+(?:\.\d+)?/g);
  if (!n || !n.length) return null;
  const a = Number(n[0]); const b = n.length > 1 ? Number(n[1]) : null;
  return b == null ? { mid: a, width: null } : { mid: (a + b) / 2, width: Math.abs(b - a) };
}

/** 按阈值核一件：位置中心差 > pos_tol_pct，或横向尺寸差到 size_factor 倍及以上 → 返回原因；没问题 / 量不出返回空。只用来把明显的错改判不过，不会把审图判的不过改成过。 */
export function itemLimitIssue(expected, seen, limits = REVIEW_LIMITS) {
  const e = parsePct(expected); const s = parsePct(seen);
  if (!e || !s) return '';
  const d = Math.abs(e.mid - s.mid);
  if (d > limits.pos_tol_pct) return '位置差 ' + Math.round(d) + '%（超过 ' + limits.pos_tol_pct + '%）';
  // 尺寸：两边都量出了宽度才比；侧面成一条边的门窗（宽 0）不比
  if (e.width >= 2 && s.width >= 1) {
    const k = Math.max(e.width / s.width, s.width / e.width);
    if (k >= limits.size_factor) return '尺寸差 ' + k.toFixed(1) + ' 倍（' + limits.size_factor + ' 倍及以上）';
  }
  return '';
}
// 各视图拿掉的那面墙（离机位最近的一面）、观察方向；门窗在该视图里是正对、侧面（应成一条边）还是被拿掉
export const VIEW_META = {
  plan: { removed_wall: null, how: '正上方垂直俯视，上北下南、左西右东', span_from: '从西数' },
  front: { removed_wall: 'south', how: '从南向北看，画面左西右东', span_from: '从西数' },
  left: { removed_wall: 'west', how: '从西向东看，画面左北右南', span_from: '从北数' },
  right: { removed_wall: 'east', how: '从东向西看，画面左南右北', span_from: '从南数' },
};
const FACE = { front: { north: 'face_on', south: 'removed', east: 'edge_on', west: 'edge_on' }, left: { east: 'face_on', west: 'removed', north: 'edge_on', south: 'edge_on' }, right: { west: 'face_on', east: 'removed', north: 'edge_on', south: 'edge_on' } };
const IMG = /\.(png|jpe?g|webp)$/i;

// ── ① 母本逐件清单 ──
/** 一个水平范围在四个视图里的横向位置（占房间宽 / 深的百分比，从画面左边算）：平面 / 正视 = 西→东；左视 = 从北数；右视 = 从南数。 */
function spanOf(R, xa, xb, ya, yb) {
  const RW = (R.x1 - R.x0) || 1; const RD = (R.y1 - R.y0) || 1;
  const pc = (v) => Math.round(100 * v);
  const x = [pc((xa - R.x0) / RW), pc((xb - R.x0) / RW)];
  return { plan: x, front: x, left: [pc((R.y1 - yb) / RD), pc((R.y1 - ya) / RD)], right: [pc((ya - R.y0) / RD), pc((yb - R.y0) / RD)] };
}
const halfOf = (size, dflt = 0.5) => (Array.isArray(size) ? [Number(size[0]) / 2, Number(size[1]) / 2] : [Number(size ?? dflt) / 2, Number(size ?? dflt) / 2]);
const bboxOfPts = (pts) => pts.reduce((b, [xa, xb, ya, yb]) => [Math.min(b[0], xa), Math.max(b[1], xb), Math.min(b[2], ya), Math.max(b[3], yb)], [Infinity, -Infinity, Infinity, -Infinity]);

/** 母本固定物清单（门窗、家具、隔间、工位组、灯具……逐件），每件带各视图横向应在的百分比，给审图逐张打勾。 */
export function sceneChecklist(m) {
  const R = m && m.room;
  if (!R) return [];
  const rows = [];
  const span = (xa, xb, ya, yb) => spanOf(R, xa, xb, ya, yb);
  for (const o of m.openings || []) {
    const a = Number(o.from); const b = Number(o.to);
    let sp = null;
    if (o.from != null && o.to != null) {
      if (o.side === 'south') sp = span(a, b, R.y0, R.y0);
      else if (o.side === 'north') sp = span(a, b, R.y1, R.y1);
      else if (o.side === 'west') sp = span(R.x0, R.x0, a, b);
      else if (o.side === 'east') sp = span(R.x1, R.x1, a, b);
    }
    const face = { plan: 'gap' };
    for (const v of ['front', 'left', 'right']) face[v] = FACE[v][o.side] || '';
    rows.push({ id: o.id, name: o.name, kind: '门窗', where: (o.side || '') + ' 墙 ' + o.from + '–' + o.to, wall: o.side, span: sp, face });
  }
  for (const it of m.items || []) {
    let sp = null; let count;
    if (Array.isArray(it.box) && it.box.length === 6) { const b = it.box; sp = span(b[0], b[3], b[1], b[4]); }
    else if (Array.isArray(it.center)) { const [sx, sy] = halfOf(it.size); const c = it.center; sp = span(c[0] - sx, c[0] + sx, c[1] - sy, c[1] + sy); }
    else if (Array.isArray(it.centers) && it.centers.length) {
      const [sx, sy] = halfOf(it.size); count = it.centers.length;
      const b = bboxOfPts(it.centers.map((c) => [c[0] - sx, c[0] + sx, c[1] - sy, c[1] + sy])); sp = span(b[0], b[1], b[2], b[3]);
    }
    rows.push({ id: it.id, name: it.name, kind: it.type || '', where: JSON.stringify(it.box || it.center || it.centers || ''), span: sp, ...(count ? { count } : {}) });
  }
  const off = m.office;
  if (off) {
    rows.push({ id: off.id, name: off.name, kind: '隔间', where: '[' + off.x0 + ',' + off.y0 + ']-[' + off.x1 + ',' + off.y1 + ']', span: span(off.x0, off.x1, off.y0, off.y1) });
    const d = off.door;
    if (d) {
      const y = d.side === 'south' ? off.y0 : off.y1;
      rows.push({ id: d.id, name: off.name + '的门', kind: '门窗', where: (d.side || '') + ' ' + (d.x0 ?? '') + '–' + (d.x1 ?? ''), span: d.x0 != null && d.x1 != null ? span(d.x0, d.x1, y, y) : null });
    }
    for (const f of off.furniture || []) {
      const sx = Number(f.w || 0.5) / 2; const sy = Number(f.d || f.w || 0.5) / 2;
      rows.push({ id: f.id, name: f.name, kind: '家具', where: '(' + f.x + ',' + f.y + ')', span: span(f.x - sx, f.x + sx, f.y - sy, f.y + sy) });
    }
  }
  const ws = m.workstations;
  if (ws && Array.isArray(ws.cols) && Array.isArray(ws.rows) && ws.cols.length && ws.rows.length) {
    const desk = ws.desk || {}; const sx = Number(desk.w || 1.4) / 2; const sy = Number(desk.d || 0.7) / 2;
    const pts = [];
    for (const c of ws.cols) for (const r of ws.rows) { pts.push([c.x - sx, c.x + sx, r.y - sy, r.y + sy]); if (r.chair_y != null) pts.push([c.x - 0.3, c.x + 0.3, r.chair_y - 0.3, r.chair_y + 0.3]); }
    const b = bboxOfPts(pts);
    const n = ws.cols.length * ws.rows.length;
    rows.push({ id: 'WS', name: '工位 ' + n + ' 张（' + ws.rows.length + ' 排 × ' + ws.cols.length + ' 列），每张：隔板、桌、显示器、转椅、活动柜', kind: '成组家具', where: ws.seating_rule || '', span: span(b[0], b[1], b[2], b[3]), count: n, grid: { rows: ws.rows.length, cols: ws.cols.length } });
  }
  for (const fx of m.fixtures || []) {
    const g = fx.grid || {}; let sp = null; let count;
    if (Array.isArray(g.cols_x) && Array.isArray(g.rows_y) && g.cols_x.length && g.rows_y.length) {
      const sx = Number(fx.w || 0.6) / 2; const sy = Number(fx.d || 0.6) / 2;
      sp = span(Math.min(...g.cols_x) - sx, Math.max(...g.cols_x) + sx, Math.min(...g.rows_y) - sy, Math.max(...g.rows_y) + sy);
      count = g.cols_x.length * g.rows_y.length;
    }
    rows.push({ id: fx.id, name: fx.name, kind: '灯具/固定件', where: JSON.stringify(fx.grid || ''), span: sp, ...(count ? { count } : {}) });
  }
  return rows;
}

// ── 图片小工具（ffmpeg / ffprobe） ──
export function imageSize(abs) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', abs], { timeout: 30000 }).toString();
  const s = (JSON.parse(out).streams || [])[0] || {};
  if (!s.width || !s.height) throw new Error('读不出图片尺寸：' + abs);
  return { width: s.width, height: s.height };
}

/** 主体包围盒宽高比（和白底差 >18 的像素）；只作参考（背景、天空会让它很吵）。 */
function contentBboxRatio(abs, { width, height }) {
  const w = 256; const h = Math.max(2, Math.round(256 * height / width));
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', abs, '-vf', 'scale=' + w + ':' + h + ',format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (255 - buf[y * w + x] > 18) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return (x1 - x0 + 1) / Math.max(1, y1 - y0 + 1);
}

// ── ② 宽高比 ──
/** 美术图和同视图灰模比整图宽高比：差 >10% 判不过。主体包围盒比例只给参考，不判。 */
export function ratioCheck(grayAbs, artAbs) {
  const g = imageSize(grayAbs); const a = imageSize(artAbs);
  const r = (a.width / a.height) / (g.width / g.height);
  let bbox = null;
  try { const bg = contentBboxRatio(grayAbs, g); const ba = contentBboxRatio(artAbs, a); if (bg && ba) bbox = +(ba / bg).toFixed(3); } catch { /* 参考值，算不出不影响 */ }
  return { gray: [g.width, g.height], art: [a.width, a.height], img_ratio: +r.toFixed(3), bbox_ratio_info: bbox, fail: Math.abs(r - 1) > RATIO_TOL };
}

// ── 拼图（ffmpeg：白底画布 + overlay + drawtext + drawbox） ──
const FONT_CANDIDATES = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc', '/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/wqy-microhei/wqy-microhei.ttc'];
/** 中文字体：IC_CJK_FONT 优先，没有就找常见位置；都没有返回空（拼图照拼，只是不写字）。 */
export function cjkFont() {
  const env = process.env.IC_CJK_FONT;
  if (env && fs.existsSync(env)) return env;
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) || '';
}
const even = (n) => Math.max(2, Math.ceil(n / 2) * 2);
const escFont = (f) => f.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '');

/** 白底画布上贴图、写字、画框。images: [{abs,x,y,w,h}]；texts: [{text,x,y,size}]；boxes: [{x,y,w,h}]。 */
export function composeCanvas(outAbs, { width, height, images = [], texts = [], boxes = [], quality = 3 }) {
  const W = even(width); const H = even(height);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_sr_'));
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=' + W + 'x' + H];
    const parts = ['[0:v]format=rgb24[b0]'];
    let last = 'b0';
    images.forEach((im, i) => {
      args.push('-i', im.abs);
      parts.push('[' + (i + 1) + ':v]scale=' + Math.max(1, Math.round(im.w)) + ':' + Math.max(1, Math.round(im.h)) + ',format=rgb24[s' + i + ']');
      parts.push('[' + last + '][s' + i + ']overlay=' + Math.round(im.x) + ':' + Math.round(im.y) + ':format=rgb[b' + (i + 1) + ']');
      last = 'b' + (i + 1);
    });
    const draws = boxes.map((b) => 'drawbox=x=' + Math.round(b.x) + ':y=' + Math.round(b.y) + ':w=' + Math.round(b.w) + ':h=' + Math.round(b.h) + ':color=0xA0A0A0:t=3');
    const font = cjkFont();
    if (font) {
      texts.forEach((t, i) => {
        fs.writeFileSync(path.join(tmp, 't' + i + '.txt'), String(t.text || ''), 'utf8');
        draws.push("drawtext=fontfile='" + escFont(font) + "':textfile=t" + i + '.txt:expansion=none:x=' + Math.round(t.x) + ':y=' + Math.round(t.y) + ':fontsize=' + (t.size || 30) + ':fontcolor=black');
      });
    }
    parts.push('[' + last + ']' + (draws.length ? draws.join(',') : 'null') + '[out]');
    args.push('-filter_complex', parts.join(';'), '-map', '[out]', '-frames:v', '1');
    if (/\.jpe?g$/i.test(outAbs)) args.push('-q:v', String(quality));
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    args.push(outAbs);
    execFileSync('ffmpeg', args, { cwd: tmp, timeout: 180000 });
    return outAbs;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录删不掉不要紧 */ }
  }
}

// ── 审图轮次目录 ──
export const VIEW_KEYS = SCENE_VIEWS.map((v) => v.key);
export const viewOf = (key) => SCENE_VIEWS.find((v) => v.key === key) || null;
export const sceneDir = (projectId, sceneId) => path.join(sceneMasterDir(projectId), safeId(sceneId));
export const artDir = (projectId, sceneId) => path.join(sceneDir(projectId, sceneId), 'art');
export const candidatesDir = (projectId, sceneId) => path.join(sceneDir(projectId, sceneId), 'candidates');
export const roundDir = (projectId, sceneId, round) => path.join(candidatesDir(projectId, sceneId), safeId(round));
export const roundFile = (projectId, sceneId, round) => path.join(roundDir(projectId, sceneId, round), 'round.json');
export const reviewResultFile = (projectId, sceneId, round) => path.join(roundDir(projectId, sceneId, round), 'review.json');
export const returnNoteFile = (projectId, sceneId, round) => path.join(roundDir(projectId, sceneId, round), '退回意见.md');
export const overviewFile = (projectId, sceneId, round) => path.join(roundDir(projectId, sceneId, round), '审图总览.jpg');
export const WHITEBOARD = '白板_2x2.jpg';

/** 本场景已有的审图轮次（按轮号排）。 */
export function listRounds(projectId, sceneId) {
  const d = candidatesDir(projectId, sceneId);
  if (!fs.existsSync(d)) return [];
  const num = (r) => Number(String(r).replace(/^\D+/, '')) || 0;
  return fs.readdirSync(d).filter((r) => fs.existsSync(path.join(d, r, 'round.json'))).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}
export function loadRound(projectId, sceneId, round) {
  const f = roundFile(projectId, sceneId, round);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
export function saveRound(projectId, sceneId, round, data) {
  fs.writeFileSync(roundFile(projectId, sceneId, round), JSON.stringify(data, null, 2));
  return data;
}
export function loadReviewResult(projectId, sceneId, round) {
  const f = reviewResultFile(projectId, sceneId, round);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function nextRoundName(projectId, sceneId) {
  const n = listRounds(projectId, sceneId).map((r) => Number(String(r).replace(/^r/, '')) || 0);
  return 'r' + ((n.length ? Math.max(...n) : 0) + 1);
}
const findArt = (dir, key) => (fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => IMG.test(f) && f.replace(IMG, '') === 'art_' + key) : null);
function copyAsPng(src, dst) {
  if (/\.png$/i.test(src)) fs.copyFileSync(src, dst);
  else execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', dst], { timeout: 60000 });
}

/**
 * 登记一轮审图：把候选目录里的 art_<plan|front|left|right>.(png|jpg|webp) 和灰模（平面图.png 等，及 *_标注.png）拷进 candidates/<round>/。
 * 只交了几张也行（返修只重出两张时）：没交的视图沿用当前已定稿的 art/<视图>.png，四张一起审画风；没有定稿的视图第一轮必须交。
 * 灰模候选目录里没有的，用母本目录下导出的那份。登记时就算好宽高比、拼好审图总览图。
 */
export function registerRound(projectId, sceneId, srcDir, { round = '' } = {}) {
  const sm = getSceneMaster(projectId, sceneId);
  if (!sm) throw Object.assign(new Error('没有这个场景母本：' + sceneId), { code: 'NO_SCENE_MASTER' });
  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw Object.assign(new Error('候选目录不在：' + srcDir), { code: 'NO_CANDIDATE_DIR' });
  const sd = sceneDir(projectId, sceneId); const ad = artDir(projectId, sceneId);
  const newViews = VIEW_KEYS.filter((k) => findArt(srcDir, k));
  if (!newViews.length) throw Object.assign(new Error('候选目录里没有 art_plan / art_front / art_left / art_right 图'), { code: 'NO_ART' });
  for (const v of SCENE_VIEWS) {
    if (newViews.includes(v.key)) continue;
    if (!fs.existsSync(path.join(ad, v.name + '.png'))) throw Object.assign(new Error(v.name + '还没有定稿（art/' + v.name + '.png），这一轮要交 art_' + v.key), { code: 'MISSING_VIEW' });
  }
  for (const v of SCENE_VIEWS) {
    if (!fs.existsSync(path.join(srcDir, v.name + '.png')) && !fs.existsSync(path.join(sd, v.name + '.png'))) throw Object.assign(new Error('没有' + v.name + '的灰模（候选目录和母本目录都没有 ' + v.name + '.png）'), { code: 'NO_GRAY' });
  }
  const name = safeId(round) || nextRoundName(projectId, sceneId);
  const rd = roundDir(projectId, sceneId, name);
  if (fs.existsSync(path.join(rd, 'round.json'))) throw Object.assign(new Error('这一轮已经登记过：' + name), { code: 'ROUND_EXISTS' });
  fs.mkdirSync(rd, { recursive: true });
  for (const v of SCENE_VIEWS) {
    for (const g of [v.name + '.png', v.name + '_标注.png']) {
      const src = fs.existsSync(path.join(srcDir, g)) ? path.join(srcDir, g) : path.join(sd, g);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(rd, g));
    }
    const f = findArt(srcDir, v.key);
    copyAsPng(f ? path.join(srcDir, f) : path.join(ad, v.name + '.png'), path.join(rd, 'art_' + v.key + '.png'));
  }
  const ratio = {};
  for (const v of SCENE_VIEWS) ratio[v.key] = ratioCheck(path.join(rd, v.name + '.png'), path.join(rd, 'art_' + v.key + '.png'));
  const data = { scene_id: sm.master.scene_id || sceneId, name: sm.master.name || '', round: name, new_views: newViews, fallback_views: VIEW_KEYS.filter((k) => !newViews.includes(k)), source_dir: path.resolve(srcDir), ratio, status: 'registered', at: Date.now() };
  saveRound(projectId, sceneId, name, data);
  buildOverview(rd, overviewFile(projectId, sceneId, name), { newViews });
  return data;
}

// ── ③ 审图总览 ──
/** 每视图一行（左灰模、右美术），最下面一行四张美术并排（画风统一检查）。dir 里要有 平面图.png 等灰模和 art_<view>.png。 */
export function buildOverview(dir, outAbs, { newViews = null } = {}) {
  const W = 900; const GAP = 20; const HEAD = 50; const SH = 420;
  const images = []; const texts = []; let y = 0; let TW = W * 2 + GAP;
  for (const v of SCENE_VIEWS) {
    const g = path.join(dir, v.name + '.png'); const a = path.join(dir, 'art_' + v.key + '.png');
    if (!fs.existsSync(a) || !fs.existsSync(g)) continue;
    const sz = [g, a].map((f) => imageSize(f));
    const hs = sz.map((s) => Math.round(s.height * W / s.width));
    const tag = newViews ? (newViews.includes(v.key) ? '【本轮新图】' : '【沿用已定稿】') : '';
    texts.push({ text: v.name + '（' + VIEW_META[v.key].how + '）  左：灰模底图　右：美术' + tag, x: 10, y: y + 8, size: 30 });
    images.push({ abs: g, x: 0, y: y + HEAD, w: W, h: hs[0] }, { abs: a, x: W + GAP, y: y + HEAD, w: W, h: hs[1] });
    y += Math.max(...hs) + HEAD;
  }
  const arts = SCENE_VIEWS.map((v) => path.join(dir, 'art_' + v.key + '.png')).filter((f) => fs.existsSync(f));
  if (arts.length) {
    texts.push({ text: '四张美术并排（画风统一检查）', x: 10, y: y + 8, size: 30 });
    let x = 0;
    for (const a of arts) { const s = imageSize(a); const w = Math.round(s.width * SH / s.height); images.push({ abs: a, x, y: y + HEAD, w, h: SH }); x += w + GAP; }
    TW = Math.max(TW, x);
    y += SH + HEAD;
  }
  if (!images.length) throw new Error('没有可拼的图：' + dir);
  return composeCanvas(outAbs, { width: TW, height: y, images, texts, quality: 4 });
}

// ── ④ 白板 2×2（左上平面、右上正视、左下左视、右下右视；每格写视图名和观察方向）──
const WB_CAPTION = { plan: '垂直俯视（上北下南、左西右东）', front: '从南向北看（左西右东）', left: '从西向东看（左北右南）', right: '从东向西看（左南右北）' };
export function buildWhiteboard(name, files, outAbs) {
  const CW = 1600; const CH = 1000; const TOP = 70; const GAP = 30;
  const images = []; const boxes = [];
  const texts = [{ text: (name || '') + '：场景三视图及平面图（同一空间母本正交投影，美术加工后审图通过）', x: 20, y: 20, size: 40 }];
  SCENE_VIEWS.forEach((v, i) => {
    const src = files[v.key]; const s = imageSize(src);
    const k = Math.min(CW / s.width, CH / s.height); const w = Math.round(s.width * k); const h = Math.round(s.height * k);
    const x0 = (i % 2) * (CW + GAP); const y0 = 90 + Math.floor(i / 2) * (CH + TOP);
    texts.push({ text: v.name + '　' + WB_CAPTION[v.key], x: x0 + 10, y: y0 + 10, size: 34 });
    images.push({ abs: src, x: x0 + Math.floor((CW - w) / 2), y: y0 + TOP + Math.floor((CH - h) / 2), w, h });
    boxes.push({ x: x0, y: y0, w: CW, h: TOP + CH });
  });
  return composeCanvas(outAbs, { width: CW * 2 + GAP, height: (CH + TOP) * 2 + 110, images, texts, boxes, quality: 2 });
}

/** 审过：旧 art/ 整个备份到 art_history/<时间戳>/，本轮四张写进 art/<视图>.png，再拼白板_2x2.jpg。 */
export function acceptRound(projectId, sceneId, round) {
  const rd = roundDir(projectId, sceneId, round); const ad = artDir(projectId, sceneId);
  const files = Object.fromEntries(VIEW_KEYS.map((k) => [k, path.join(rd, 'art_' + k + '.png')]));
  for (const [k, f] of Object.entries(files)) if (!fs.existsSync(f)) throw new Error('这一轮缺 art_' + k + '.png，不能写回');
  let backup = '';
  if (fs.existsSync(ad) && fs.readdirSync(ad).length) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '_');
    backup = path.join(sceneDir(projectId, sceneId), 'art_history', ts);
    let n = 1; while (fs.existsSync(backup)) backup = path.join(sceneDir(projectId, sceneId), 'art_history', ts + '_' + (++n));
    fs.cpSync(ad, backup, { recursive: true });
  }
  fs.mkdirSync(ad, { recursive: true });
  const written = [];
  for (const v of SCENE_VIEWS) { const dst = path.join(ad, v.name + '.png'); fs.copyFileSync(files[v.key], dst); written.push(dst); }
  const r = loadRound(projectId, sceneId, round) || {};
  const sm = getSceneMaster(projectId, sceneId);
  const wb = buildWhiteboard(r.name || (sm && sm.master.name) || sceneId, files, path.join(ad, WHITEBOARD));
  written.push(wb);
  return { backup, written };
}

/** 不过：每张不过的视图一段退回意见（给返修派单用），合成一份 退回意见.md。 */
export function buildReturnNote(result, { sceneName = '', round = '' } = {}) {
  const lines = ['# ' + (sceneName || '') + ' 场景三视图 ' + (round || '') + ' 退回意见', ''];
  for (const v of result.views || []) {
    if (v.verdict === 'pass') continue;
    const meta = viewOf(v.view) || { name: v.view };
    lines.push('## ' + meta.name + '（' + (VIEW_META[v.view] || {}).how + '）');
    const bad = (v.items || []).filter((x) => x && x.ok === false);
    if (bad.length) lines.push('- 对不上的物件：' + bad.map((x) => x.id + '（应在 ' + x.expected + '，图里 ' + x.seen_pct + '）').join('；'));
    for (const d of v.defects || []) lines.push('- ' + d);
    lines.push('- 怎么改：' + (v.fix_note || ''));
    lines.push('');
  }
  if (result.note) lines.push('总评：' + result.note);
  return lines.join('\n');
}
export function writeReturnNote(projectId, sceneId, round, result) {
  const r = loadRound(projectId, sceneId, round) || {};
  const f = returnNoteFile(projectId, sceneId, round);
  fs.writeFileSync(f, buildReturnNote(result, { sceneName: r.name, round }), 'utf8');
  return f;
}

/** 以前各轮的退回意见（本轮之前、不过的），给审图对照「上次说的改了没有」。 */
export function previousReturns(projectId, sceneId, round) {
  const all = listRounds(projectId, sceneId);
  const idx = all.indexOf(safeId(round));
  return (idx < 0 ? all : all.slice(0, idx)).map((r) => ({ round: r, res: loadReviewResult(projectId, sceneId, r) }))
    .filter((x) => x.res && x.res.verdict !== 'pass')
    .map((x) => ({ round: x.round, views: (x.res.views || []).filter((v) => v.verdict !== 'pass').map((v) => ({ view: v.view, defects: v.defects || [], fix_note: v.fix_note || '' })) }));
}
