// 送 H3 的人物/服装/年龄/道具参考图「只裁不画」（2026-11-17 Andy/总导：根治全屏三视图）。
// 根因：参考图是三视图合板 / 灰棚全身站姿 / Q 版多格板，整张送进 MiniMax H3，H3 会在镜头首尾把这张板直出几帧。
// 做法：上传前把参考图裁成「单人可用图」，裁切结果另存 assets/_videorefs/，原资产图一字节不动；
//   只做矩形裁切（ffmpeg crop，PNG 无损），不缩放、不重绘、不生成——我方上传的图也只会被裁，不会被改画。
//   拿不准（非棚拍背景 / 分块失败 / 裁出来没有人脸肤色等）一律回退原图并打 warn，不让出片中断。
// 版式（从背景模型 + 前景列/行投影分块得出）：
//   · 左特写 + 右三视图（IC 文生图 CHARACTER_T2I_LAYOUT_CONSTRAINT 的版式）→ 只取左侧头肩特写；
//   · 带分隔条/面板边的拼格板（≥90% 行同列同号亮度台阶）→ 取左上面板，面板内再按单人规则裁（面板内特写整块保留）；
//   · 无分隔条的多格合板 / 转身图 / Q 版格子 → 取左上第一格，再按单人规则裁；
//   · 单人灰棚/白底全身 → 按人物包围盒裁头到腰（服装到大腿），去掉大片无纹理棚背景；
//   · 道具：只有白底/灰底上 ≥3 个大小相近的分块（多角度板）才裁最大一块，单个实物图不裁；
//     名字带 Q版/设定/三视 的「道具」其实是人物设定板，按人物处理（videoRefKind）；
//   · 背景模型：左右边带逐行估背景色，从上往下跟踪（跳变 >12 的行不算背景），跳过外圈白边框；
//     两侧颜色差大时取与上边缘多数颜色一致的一侧——左特写面板贴边、竖幅人像手臂碰边都不会误判。
//   · 场景图从不裁（调用方不会传 scene）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const VIDEOREF_ALGO = 'v1';
export const VIDEOREF_DIR = path.join('assets', '_videorefs');
const AW = 480; // 分析图宽度

function runBin(bin, args, { timeoutMs = 60_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { reject(e); return; }
    const chunks = []; let stderr = ''; let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(killer); fn(v); };
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(reject, new Error(bin + ' 超时')); }, timeoutMs);
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    p.on('error', (e) => done(reject, new Error(bin + ' 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return done(reject, new Error(bin + ' 退出码 ' + code + '：' + stderr.slice(-600)));
      const buf = Buffer.concat(chunks); done(resolve, binary ? buf : buf.toString());
    });
  });
}

export function sha256File(abs) { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }

export async function probeImage(abs) {
  const out = await runBin('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', abs], { timeoutMs: 20_000 });
  const [w, h] = String(out).trim().split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error('读不出图片尺寸');
  return { w, h };
}

export async function decodeAnalysis(abs, W, H) {
  const ah = Math.max(2, Math.round(AW * H / W));
  const buf = await runBin('ffmpeg', ['-v', 'error', '-i', abs, '-frames:v', '1', '-vf', 'scale=' + AW + ':' + ah + ':flags=area,format=rgb24', '-f', 'rawvideo', '-'], { binary: true });
  if (buf.length < AW * ah * 3) throw new Error('解码分析图失败');
  return { rgb: buf.subarray(0, AW * ah * 3), w: AW, h: ah };
}

const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };

// 背景模型（按行）：分别看左右两条 3% 宽的边带，一行里边带像素颜色一致（亮度跨度 ≤18、饱和度 ≤30）就算「干净行」。
// 只用干净的那一侧/那几行估计该行背景色，其余行就近沿用——这样「左特写面板贴着左边、右边是白底」的版式、
// 以及竖幅人像手臂碰到左右边缘的情况，都能拿到正确的棚拍背景。
// 返回 { studio, bgRow, stats }；studio=false 表示不是纯色棚拍背景（实景照片），不裁。
export function backgroundModel({ rgb, w, h }) {
  const ew = Math.max(2, Math.round(w * 0.02));
  const L = (i) => 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  const sideRows = (x0, x1) => {
    const rows = [];
    const ls = new Float32Array(x1 - x0), ss = new Float32Array(x1 - x0);
    for (let y = 0; y < h; y++) {
      let sr = 0, sg = 0, sb = 0;
      for (let x = x0; x < x1; x++) {
        const i = 3 * (y * w + x);
        ls[x - x0] = L(i); ss[x - x0] = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) - Math.min(rgb[i], rgb[i + 1], rgb[i + 2]);
        sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2];
      }
      const n = x1 - x0;
      const lsort = Float32Array.from(ls).sort(), ssort = Float32Array.from(ss).sort();
      const p10 = lsort[Math.floor(n * 0.1)], p90 = lsort[Math.min(n - 1, Math.floor(n * 0.9))], s90 = ssort[Math.min(n - 1, Math.floor(n * 0.9))];
      // 用 10%–90% 分位跨度，容忍棚拍渐变/暗角和噪点
      rows.push({ clean: p90 - p10 <= 20 && s90 <= 30, c: [sr / n, sg / n, sb / n], lum: (p10 + p90) / 2, sat: s90 });
    }
    return rows;
  };
  // 从上往下跟踪背景：棚拍背景是缓变的，相邻干净行亮度跳变 >12 的（大片纯色衣服、贴边的人）不算背景
  const track = (rows) => {
    // 起点：上 30% 里干净行的亮度中位数（避开顶上的白边框/分隔条）
    const top = rows.slice(0, Math.round(h * 0.3)).filter((r) => r.clean).map((r) => r.lum);
    let last = top.length ? median(top) : -1;
    for (let y = 0; y < h; y++) {
      const r = rows[y];
      if (!r.clean) continue;
      if (last < 0) { r.clean = false; continue; }
      if (Math.abs(r.lum - last) <= 12) last = r.lum; else r.clean = false;
    }
    return rows;
  };
  // 跳过外圈白边框（拼格板常见）和 1% 细描边，再取 2% 宽的边带
  const whiteCol = (x) => { let c = 0; for (let y = 0; y < h; y++) if (L(3 * (y * w + x)) >= 245) c++; return c >= h * 0.9; };
  let offL = 0, offR = 0;
  while (offL < w * 0.04 && whiteCol(offL)) offL++;
  while (offR < w * 0.04 && whiteCol(w - 1 - offR)) offR++;
  if (offL >= w * 0.04) offL = 0; // 整片白底，不是边框
  if (offR >= w * 0.04) offR = 0;
  const off = Math.max(1, Math.round(w * 0.01));
  const left = track(sideRows(offL + off, offL + off + ew)), right = track(sideRows(w - offR - off - ew, w - offR - off));
  const fracL = left.filter((r) => r.clean).length / h, fracR = right.filter((r) => r.clean).length / h;
  const sides = [];
  if (fracL >= 0.5) sides.push(left);
  if (fracR >= 0.5) sides.push(right);
  if (sides.length === 2) {
    let diff = 0, n = 0;
    for (let y = 0; y < h; y++) if (left[y].clean && right[y].clean) { diff += Math.abs(left[y].lum - right[y].lum); n++; }
    if (n && diff / n > 25) {
      // 两侧颜色差很大（一侧是贴边的特写面板）：选和整条上边缘多数颜色一致的那一侧
      const top = [];
      for (let y = 0; y < Math.max(1, Math.round(h * 0.02)); y++) for (let x = 0; x < w; x++) top.push(L(3 * (y * w + x)));
      const tm = median(top);
      const lm = median(left.filter((r) => r.clean).map((r) => r.lum)), rm = median(right.filter((r) => r.clean).map((r) => r.lum));
      sides.splice(Math.abs(lm - tm) <= Math.abs(rm - tm) ? 1 : 0, 1);
    }
  }
  const bgRow = new Float32Array(h * 3);
  const known = new Int8Array(h);
  for (let y = 0; y < h; y++) {
    const cs = sides.map((sd) => sd[y]).filter((r) => r.clean);
    if (!cs.length) continue;
    for (let k = 0; k < 3; k++) bgRow[3 * y + k] = cs.reduce((t, r) => t + r.c[k], 0) / cs.length;
    known[y] = 1;
  }
  // 没有干净边带的行：沿用最近的干净行
  let last = -1;
  for (let y = 0; y < h; y++) if (known[y]) last = y; else if (last >= 0) for (let k = 0; k < 3; k++) bgRow[3 * y + k] = bgRow[3 * last + k];
  let first = known.indexOf(1);
  if (first > 0) for (let y = 0; y < first; y++) for (let k = 0; k < 3; k++) bgRow[3 * y + k] = bgRow[3 * first + k];
  const cleanRows = sides.length ? Math.max(...sides.map((sd) => sd.filter((r) => r.clean).length)) / h : 0;
  const cleanSat = sides.flatMap((sd) => sd.filter((r) => r.clean).map((r) => r.sat));
  const cleanLum = sides.flatMap((sd) => sd.filter((r) => r.clean).map((r) => r.lum));
  let jumps = 0;
  for (let y = 1; y < h; y++) if (known[y] && known[y - 1]) {
    const d = Math.abs(bgRow[3 * y] - bgRow[3 * (y - 1)]) + Math.abs(bgRow[3 * y + 1] - bgRow[3 * (y - 1) + 1]) + Math.abs(bgRow[3 * y + 2] - bgRow[3 * (y - 1) + 2]);
    if (d > 30) jumps++;
  }
  const satMed = median(cleanSat), lumMed = median(cleanLum);
  const studio = sides.length > 0 && cleanRows >= 0.5 && satMed <= 28 && lumMed >= 60 && jumps <= h * 0.03;
  return { studio, bgRow, stats: { sides: sides.length === 2 ? 'LR' : (sides[0] === left ? 'L' : (sides[0] === right ? 'R' : '-')), fracL: +fracL.toFixed(2), fracR: +fracR.toFixed(2), satMed, lumMed: +lumMed.toFixed(1), jumps } };
}

export function fgMask({ rgb, w, h }, bgRow, thr = 30) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 3 * (y * w + x);
    const d = Math.max(Math.abs(rgb[i] - bgRow[3 * y]), Math.abs(rgb[i + 1] - bgRow[3 * y + 1]), Math.abs(rgb[i + 2] - bgRow[3 * y + 2]));
    m[y * w + x] = d > thr ? 1 : 0;
  }
  return m;
}

// 一维投影切段：prof[i] ≥ on 视为有内容；短于 minGap 的空隙合并，短于 minLen 的段丢弃。
function segments(prof, on, minGap, minLen) {
  const segs = [];
  let s = -1;
  for (let i = 0; i <= prof.length; i++) {
    const v = i < prof.length && prof[i] >= on;
    if (v && s < 0) s = i;
    if (!v && s >= 0) { segs.push([s, i]); s = -1; }
  }
  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && g[0] - last[1] < minGap) last[1] = g[1]; else merged.push([...g]);
  }
  return merged.filter((g) => g[1] - g[0] >= minLen);
}

// 前景分块：先按列切，再在每一列段里按行切，得到格子（分析图坐标）。
export function findCells(mask, w, h, { minGapFrac = 0.012 } = {}) {
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) { let c = 0; for (let y = 0; y < h; y++) c += mask[y * w + x]; col[x] = c / h; }
  const cols = segments(col, 0.012, Math.max(1, Math.round(w * minGapFrac)), Math.round(w * 0.03));
  const cells = [];
  for (const [x0, x1] of cols) {
    const row = new Float32Array(h);
    for (let y = 0; y < h; y++) { let c = 0; for (let x = x0; x < x1; x++) c += mask[y * w + x]; row[y] = c / (x1 - x0); }
    for (const [y0, y1] of segments(row, 0.02, Math.round(h * 0.015), Math.round(h * 0.04))) {
      // 收紧到格内前景的实际包围盒
      let a = x1, b = x0, area = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (mask[y * w + x]) { if (x < a) a = x; if (x + 1 > b) b = x + 1; area++; }
      if (b > a) cells.push({ x0: a, x1: b, y0, y1, area });
    }
  }
  return cells;
}

// 肤色像素占比（YCbCr 经典区间），用来确认裁出来的人物格里确实有脸/皮肤。
function skinFrac({ rgb, w }, box) {
  let s = 0, n = 0;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    const i = 3 * (y * w + x); const R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
    const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B, cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
    n++; if (cr > 135 && cr < 180 && cb > 85 && cb < 135 && R > 60) s++;
  }
  return n ? s / n : 0;
}

const clampBox = (b, w, h) => ({ x0: Math.max(0, Math.floor(b.x0)), y0: Math.max(0, Math.floor(b.y0)), x1: Math.min(w, Math.ceil(b.x1)), y1: Math.min(h, Math.ceil(b.y1)) });

// 单人格 → 头到腰（服装到大腿）。cell 已收紧到前景包围盒。
function personCrop(mask, w, h, cell, kind, inPanel = false) {
  const ch = cell.y1 - cell.y0, cw = cell.x1 - cell.x0;
  if (ch < cw * 1.3) {
    // 已经是半身/头肩：只去掉四周多余背景
    const p = ch * 0.06;
    return { box: clampBox({ x0: cell.x0 - p, x1: cell.x1 + p, y0: cell.y0 - p, y1: cell.y1 + p }, w, h), how: '半身/头肩，去四周背景' };
  }
  // 人物被画框截在下边缘（竖幅半身/七分身）：可见部分本来就短，少裁一点
  const cut = cell.y1 >= h * 0.97;
  // 面板里的特写/半身被截在面板下边：本身就是特写，整块保留，只去左右多余背景
  if (inPanel && cut) {
    const p = cw * 0.06;
    return { box: clampBox({ x0: cell.x0 - p, x1: cell.x1 + p, y0: cell.y0 - ch * 0.04, y1: h }, w, h), how: '面板内特写/半身，整块保留' };
  }
  const ratio = kind === 'costume' ? (cut ? 0.85 : 0.68) : (cut ? 0.7 : 0.55);
  const y0 = cell.y0 - ch * 0.03, y1 = cell.y0 + ch * ratio;
  let a = cell.x1, b = cell.x0;
  for (let y = Math.max(0, Math.floor(cell.y0)); y < Math.min(h, Math.ceil(y1)); y++) for (let x = cell.x0; x < cell.x1; x++) if (mask[y * w + x]) { if (x < a) a = x; if (x + 1 > b) b = x + 1; }
  if (b <= a) { a = cell.x0; b = cell.x1; }
  const p = (y1 - y0) * 0.1;
  return { box: clampBox({ x0: a - p, x1: b + p, y0, y1 }, w, h), how: kind === 'costume' ? '全身 → 头到大腿（服装）' : '全身 → 头到腰' };
}

// 纯分析（不写文件）：返回 { crop:{x,y,w,h}（原图像素）, layout, how, reason } 或 { crop:null, reason, unsure }。
export async function planVideoRefCrop(abs, kind = 'char') {
  const { w: W, h: H } = await probeImage(abs);
  const img = await decodeAnalysis(abs, W, H);
  const r = planCore(img, kind, 0);
  const base = { W, H, bg: r.bg };
  if (!r.box) return { ...base, crop: null, reason: r.reason, unsure: !!r.unsure, layout: r.layout };
  const { w, h } = img, box = r.box;
  const sx = W / w, sy = H / h;
  let x = Math.max(0, Math.floor(box.x0 * sx)), y = Math.max(0, Math.floor(box.y0 * sy));
  let cw = Math.min(W - x, Math.ceil((box.x1 - box.x0) * sx)), chh = Math.min(H - y, Math.ceil((box.y1 - box.y0) * sy));
  cw -= cw % 2; chh -= chh % 2;
  return { ...base, crop: { x, y, w: cw, h: chh }, layout: r.layout, how: r.how, cells: r.cells };
}

// 合板里的面板边界：一条贯穿大部分画面的直线状亮度台阶（面板背景与板子背景不同色、或有分隔条）。
// axis='x' 找竖线（返回列号），'y' 找横线；只在 [lo,hi) 这段垂直方向范围里统计。要求 ≥90% 的行在同一列出现同号台阶，人物轮廓过不了。
export function panelLines(img, axis, region = null) {
  const { rgb, w } = img;
  const R = region || { x0: 0, y0: 0, x1: img.w, y1: img.h };
  const L = (x, y) => { const i = 3 * (y * w + x); return 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]; };
  const n0 = axis === 'x' ? R.x0 : R.y0, n1 = axis === 'x' ? R.x1 : R.y1;
  const m0 = axis === 'x' ? R.y0 : R.x0, m1 = axis === 'x' ? R.y1 : R.x1;
  const f = new Float32Array(n1 - n0);
  for (let k = n0 + 2; k < n1 - 2; k++) {
    let c = 0;
    for (let j = m0; j < m1; j++) {
      const d = axis === 'x' ? L(k + 2, j) - L(k - 2, j) : L(j, k + 2) - L(j, k - 2);
      if (d >= 14) c++; else if (d <= -14) c--;
    }
    f[k - n0] = Math.abs(c) / (m1 - m0); // 同号台阶才算（分隔条/面板边是一条直线，人物轮廓明暗交替）
  }
  const n = n1 - n0, out = [];
  for (let k = Math.round(n * 0.12); k < Math.round(n * 0.88); k++) {
    if (f[k] < 0.9) continue;
    let e = k; while (e + 1 < n && f[e + 1] >= 0.9) e++;
    out.push(n0 + k);
    k = e + Math.round(n * 0.03); // 分隔条两条边算一条
  }
  return out;
}

function subImg(img, b) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) rgb.set(img.rgb.subarray(3 * ((b.y0 + y) * img.w + b.x0), 3 * ((b.y0 + y) * img.w + b.x1)), 3 * y * w);
  return { rgb, w, h };
}

// 返回 { box（分析图坐标）, layout, how, cells, bg } 或 { box:null, reason, unsure, bg }
function planCore(img, kind, depth) {
  const { w, h } = img;
  if (depth === 0) {
    const vx = panelLines(img, 'x');
    if (vx.length) {
      // 带面板边界的合板（左特写面板 / 拼格）：取最左一块面板，再看面板里有没有横向边界，取最上面一格
      const p0 = { x0: 0, y0: 0, x1: vx[0], y1: h };
      const hy = panelLines(img, 'y', p0);
      const panel = { ...p0, y1: hy.length ? hy[0] : h };
      const cellsN = (vx.length + 1) + '×' + (hy.length + 1);
      const sub = subImg(img, panel);
      const inner = planCore(sub, kind, 1);
      const layout = '面板合板（' + cellsN + '）';
      if (inner.box) return { box: { x0: panel.x0 + inner.box.x0, x1: panel.x0 + inner.box.x1, y0: panel.y0 + inner.box.y0, y1: panel.y0 + inner.box.y1 }, layout, how: '取左上面板，' + inner.how, cells: cellsN, bg: inner.bg };
      // 面板里本身就是特写/半身（裁切≈整格）：整格取出
      if (/几乎等于/.test(inner.reason || '')) return finish(img, kind, { box: panel, layout, how: '取左上面板（整格）', cells: cellsN, bg: inner.bg });
      // 面板内拿不准：退回不分面板的常规分块再试一次（下面的流程），仍不行才回退原图
    }
  }
  const bg = backgroundModel(img);
  const base = { bg: bg.stats };
  if (!bg.studio) return { ...base, box: null, reason: '背景不是纯色棚拍（实景/复杂背景），不裁' };
  const mask = fgMask(img, bg.bgRow);
  let fgArea = 0; for (let i = 0; i < mask.length; i++) fgArea += mask[i];
  if (fgArea < w * h * 0.02) return { ...base, box: null, unsure: true, reason: '前景太少，分块不可靠' };
  let cells = findCells(mask, w, h, { minGapFrac: kind === 'prop' ? 0.004 : 0.012 }).filter((c) => c.area >= w * h * 0.004);
  if (!cells.length) return { ...base, box: null, unsure: true, reason: '没有分出前景块' };
  if (cells.length > 12) return { ...base, box: null, unsure: true, reason: '分块过多（' + cells.length + '），不像设定板' };
  let layout, box, how;
  if (kind === 'prop') {
    if (cells.length < 3) return { ...base, box: null, reason: '单个/两个道具实物图，不裁' };
    const hs = cells.map((c) => c.y1 - c.y0);
    if (Math.max(...hs) / Math.min(...hs) > 1.35) return { ...base, box: null, reason: '多块大小不一，不像多角度板，不裁' };
    const big = [...cells].sort((a, b) => b.area - a.area)[0];
    const ws = cells.filter((c) => c !== big).map((c) => c.x1 - c.x0);
    // 最大一块明显比其它块宽：多半是几件挨在一起没分开，拿不准就用原图
    if (big.x1 - big.x0 > 1.6 * median(ws)) return { ...base, box: null, unsure: true, reason: '最大一块像是几件并在一起（宽 ' + (big.x1 - big.x0) + ' vs 其它中位 ' + median(ws) + '），拿不准' };
    const p = (big.y1 - big.y0) * 0.08;
    layout = '道具多角度板（' + cells.length + ' 块）'; how = '取最大一块';
    box = clampBox({ x0: big.x0 - p, x1: big.x1 + p, y0: big.y0 - p, y1: big.y1 + p }, w, h);
  } else if (cells.length === 1) {
    layout = '单人棚拍'; ({ box, how } = personCrop(mask, w, h, cells[0], kind, depth > 0));
  } else {
    const byX = [...cells].sort((a, b) => a.x0 - b.x0);
    const first = byX[0];
    const fw = first.x1 - first.x0, fh = first.y1 - first.y0;
    if (fw >= w * 0.2 && fh >= h * 0.72 && first.y1 >= h * 0.93 && byX.slice(1).every((c) => (c.x1 - c.x0) < fw)) {
      layout = '左特写 + 右多视图（' + cells.length + ' 块）'; how = '只取左侧特写';
      // 特写面板和第一张全身图之间只隔一条窄缝时会并成一块：在块内找第一条近空的竖缝截断
      const colCov = (x) => { let c = 0; for (let y = 0; y < h; y++) c += mask[y * w + x]; return c / h; };
      // 特写自带有色面板（整块都是前景）：面板从左边缘起实心覆盖 ≥80%，面板结束处就是截断位置
      let solidEnd = -1;
      if (first.x0 <= w * 0.02) { let x = first.x0; while (x < first.x1 && colCov(x) >= 0.8) x++; if (x - first.x0 >= w * 0.2 && x < first.x1 - w * 0.03) solidEnd = x; }
      let x1 = first.x1;
      for (let x = Math.round(first.x0 + w * 0.15); x < first.x1; x++) if (colCov(x) < 0.04) { x1 = x; break; }
      if (x1 === first.x1 && solidEnd > 0) { x1 = solidEnd; how = '只取左侧特写面板'; }
      // 特写块宽过 45% 又找不到分界：多半和第一张全身图粘在一起，拿不准就用原图
      if (x1 - first.x0 > w * 0.45) return { ...base, box: null, unsure: true, layout, reason: '左特写和第一张全身图粘连、找不到分界（宽 ' + Math.round(100 * (x1 - first.x0) / w) + '%），拿不准' };
      box = clampBox({ x0: first.x0 - w * 0.01, x1: x1 + w * 0.01, y0: 0, y1: h }, w, h);
    } else {
      const top = Math.min(...cells.map((c) => c.y0));
      const row1 = cells.filter((c) => c.y0 <= top + h * 0.1).sort((a, b) => a.x0 - b.x0);
      layout = '多格合板/转身图（' + cells.length + ' 块）';
      const r = personCrop(mask, w, h, row1[0], kind, depth > 0); box = r.box; how = '取左上第一格，' + r.how;
    }
  }
  return finish(img, kind, { ...base, box, layout, how, cells: cells.length }, depth);
}

function finish(img, kind, r, depth = 0) {
  const { w, h } = img, box = r.box;
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  if (area < w * h * 0.03) return { bg: r.bg, box: null, unsure: true, layout: r.layout, reason: '裁出来太小（' + (100 * area / (w * h)).toFixed(1) + '%）' };
  // 顶层裁切几乎等于原图就直接用原图；格内（depth=1）允许
  if (!depth && area > w * h * 0.92) return { bg: r.bg, box: null, layout: r.layout, reason: '裁切几乎等于原图，直接用原图' };
  if (kind !== 'prop') {
    const top = { ...box, y1: box.y0 + Math.max(1, Math.round((box.y1 - box.y0) * 0.45)) };
    const sk = skinFrac(img, top);
    if (sk < 0.012) return { bg: r.bg, box: null, unsure: true, layout: r.layout, reason: '裁出区域上部没检测到肤色（' + (100 * sk).toFixed(2) + '%），可能裁错' };
  }
  return r;
}
// 主入口：返回 { path（裁切图绝对路径）, cached, record } 或 null（用原图）。不抛错。
// projectDirAbs：项目目录；asset：{ id, name, category }；abs：原图绝对路径；kind：char | costume | prop。
export async function toVideoReferenceImage({ projectDirAbs, asset, abs, kind = 'char', log = () => {} }) {
  try {
    const sha = sha256File(abs);
    const dir = path.join(projectDirAbs, VIDEOREF_DIR);
    const stem = String(asset?.id || 'x').slice(0, 8) + '_' + sha.slice(0, 12) + '_' + VIDEOREF_ALGO;
    const outPng = path.join(dir, stem + '.png');
    const outJson = path.join(dir, stem + '.json');
    if (fs.existsSync(outJson)) {
      const rec = JSON.parse(fs.readFileSync(outJson, 'utf8'));
      if (rec.src_sha256 === sha && rec.algo === VIDEOREF_ALGO) return rec.crop && fs.existsSync(outPng) ? { path: outPng, cached: true, record: rec } : null;
    }
    const plan = await planVideoRefCrop(abs, kind);
    const rec = { algo: VIDEOREF_ALGO, at: new Date().toISOString(), asset_id: asset?.id || '', asset_name: asset?.name || '', category: asset?.category || '', kind,
      src: path.relative(projectDirAbs, abs).split(path.sep).join('/'), src_sha256: sha, src_size: [plan.W, plan.H], crop: plan.crop, layout: plan.layout || '', how: plan.how || '', reason: plan.reason || '', unsure: !!plan.unsure, bg: plan.bg };
    fs.mkdirSync(dir, { recursive: true });
    if (plan.crop) {
      const tmp = outPng + '.part.png';
      await runBin('ffmpeg', ['-v', 'error', '-y', '-i', abs, '-frames:v', '1', '-vf', 'crop=' + plan.crop.w + ':' + plan.crop.h + ':' + plan.crop.x + ':' + plan.crop.y, '-pix_fmt', 'rgb24', tmp]);
      fs.renameSync(tmp, outPng);
      rec.out = path.relative(projectDirAbs, outPng).split(path.sep).join('/');
      rec.out_sha256 = sha256File(outPng);
      log('info', '送 H3 参考图已裁切：' + (asset?.name || rec.src) + ' ' + rec.layout + '，' + rec.how + '，' + plan.crop.w + 'x' + plan.crop.h + '@' + plan.crop.x + ',' + plan.crop.y + '（原图 ' + plan.W + 'x' + plan.H + ' 不动）→ ' + rec.out);
    } else if (plan.unsure) {
      log('warn', '送 H3 参考图裁切拿不准，用原图：' + (asset?.name || rec.src) + '：' + plan.reason);
    } else {
      log('info', '送 H3 参考图不裁：' + (asset?.name || rec.src) + '：' + plan.reason);
    }
    fs.writeFileSync(outJson, JSON.stringify(rec, null, 2));
    return plan.crop ? { path: outPng, cached: false, record: rec } : null;
  } catch (e) {
    log('warn', '送 H3 参考图裁切失败，用原图：' + (asset?.name || abs) + '：' + String(e && e.message || e).slice(0, 300));
    return null;
  }
}

// 给出片后防护网（ref-leak）用：原图已有的裁切缓存（同 sha、同算法版本），没有返回 ''。
export function videoRefCropFor(projectDirAbs, abs) {
  try {
    const dir = path.join(projectDirAbs, VIDEOREF_DIR);
    if (!fs.existsSync(dir)) return '';
    const sha12 = sha256File(abs).slice(0, 12);
    const hit = fs.readdirSync(dir).find((f) => f.endsWith('_' + sha12 + '_' + VIDEOREF_ALGO + '.png'));
    return hit ? path.join(dir, hit) : '';
  } catch { return ''; }
}

// 资产 → 裁切类型。道具里名字带 Q版/设定/三视图 的其实是人物设定板，按人物处理。
export function videoRefKind(asset) {
  const cat = String(asset?.category || ''), name = String(asset?.name || '');
  if (cat === 'prop') return /Q版|q版|设定|三视|转面|转身|角色/.test(name) ? 'char' : 'prop';
  if (cat === 'costume') return 'costume';
  return 'char';
}
