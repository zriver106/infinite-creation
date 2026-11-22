// 参考图入画防护网（2026-11-17 Andy/总导：根治全屏三视图）。
// 现象：人物/服装/道具参考图是灰棚全身站姿或三视图合板，MiniMax H3 偶尔在镜头开头（少数在结尾）
// 把这张参考板原样直出 2–31 帧。本模块在单镜 mp4 下载后、落库前做检测：
//   只看首尾 windowSec（默认 1.5 秒）；连续帧「像参考图」或「像灰棚/白底棚拍」，且紧接一个硬切，
//   就把这几帧连同对应音频裁掉，另存为 *_cut.mp4，原片保留不动。
// 不剪断台词：被裁区间（含 guardSec 余量）里有人声能量，就不裁，只记日志、标记待人工复核。
// 只依赖 ffmpeg/ffprobe（与 lib/core/ffmpeg.js 同一套可执行文件），不引入新依赖。
// 任何一步失败都回退原片，绝不让出片中断。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const REF_LEAK_DEFAULTS = Object.freeze({
  windowSec: 1.5,      // 只在首尾 1.5 秒内找
  thumbW: 64,          // 检测用缩略图尺寸（16:9）
  thumbH: 36,
  refSimHi: 0.80,      // 与参考图（cover 裁成画幅）灰度 NCC ≥ 此值 → 像参考图（EP1–11 正片端帧最高 0.43，漏帧最低 0.93）
  studioHi: 0.45,      // 边缘带「低饱和 + 无纹理 + 不黑」像素占比 ≥ 此值 → 像灰棚/白底棚拍（EP1–11 正片端帧最高 0.31，漏帧最低 0.45）
  cutDiff: 14,         // 漏帧段与正片之间的硬切：相邻帧灰度平均绝对差 ≥ 此值（0–255）
  minRunFrames: 1,
  speechGuardSec: 0.12, // 裁切点之后再多看 0.12 秒的人声
  speechAbsDb: -40,     // 人声带（250–3800Hz）20ms 窗 RMS 高于此绝对值……
  speechRelDb: 20,      // ……且高于全镜 p90 减 20dB，才算有声（两条都满足）；宁可多判有声、少裁
  timeoutMs: 90_000,
});

function runBin(bin, args, { timeoutMs = 90_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { reject(e); return; }
    const chunks = [];
    let stderr = '';
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(killer); fn(v); };
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} done(reject, new Error(bin + ' 超时')); }, timeoutMs);
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    p.on('error', (e) => done(reject, new Error(bin + ' 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return done(reject, new Error(bin + ' 退出码 ' + code + '：' + stderr.slice(-800)));
      const buf = Buffer.concat(chunks);
      done(resolve, binary ? buf : buf.toString());
    });
  });
}

export async function probeVideo(abs, o = {}) {
  const out = await runBin('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,width,height', '-show_entries', 'format=duration', '-of', 'json', abs], { timeoutMs: o.timeoutMs || 30_000 });
  const j = JSON.parse(out);
  const st = (j.streams || [])[0] || {};
  const [a, b] = String(st.r_frame_rate || '24/1').split('/').map(Number);
  const fps = (a > 0 && b > 0) ? a / b : 24;
  return { fps, width: Number(st.width) || 0, height: Number(st.height) || 0, duration: Number(j.format?.duration) || 0 };
}

// 整镜解成 W×H rgb24 小图（单镜 4–15 秒，24fps × 6912 字节/帧，几 MB 内）。
async function decodeThumbs(abs, W, H, o) {
  const buf = await runBin('ffmpeg', ['-v', 'error', '-i', abs, '-an', '-vf', 'scale=' + W + ':' + H + ':flags=area,format=rgb24', '-f', 'rawvideo', '-'], { binary: true, timeoutMs: o.timeoutMs });
  const fsz = W * H * 3;
  const frames = [];
  for (let off = 0; off + fsz <= buf.length; off += fsz) frames.push(buf.subarray(off, off + fsz));
  return frames;
}

// 参考图按 H3 常见的「铺满画幅」方式 cover 裁成同尺寸小图（竖图取中段，与 EP4 S33 漏帧一致）。
async function decodeRefThumb(abs, W, H, o) {
  const buf = await runBin('ffmpeg', ['-v', 'error', '-i', abs, '-frames:v', '1', '-vf', 'scale=' + W + ':' + H + ':force_original_aspect_ratio=increase:flags=area,crop=' + W + ':' + H + ',format=rgb24', '-f', 'rawvideo', '-'], { binary: true, timeoutMs: o.timeoutMs });
  return buf.length >= W * H * 3 ? buf.subarray(0, W * H * 3) : null;
}

function toGray(rgb) {
  const n = rgb.length / 3;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2];
  return g;
}

function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  if (saa < 1e-6 || sbb < 1e-6) return 0;
  return sab / Math.sqrt(saa * sbb);
}

function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// 灰棚/白底分：边缘带（上 30%、左右各 22%）里「低饱和 + 局部无纹理 + 亮度 ≥ 70」的像素占比。
// 棚拍板的背景是大片无纹理的灰/白；真实场景的边缘带几乎总有纹理或颜色。
export function studioScore(rgb, W, H) {
  let tot = 0, hit = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const border = y < H * 0.3 || x < W * 0.22 || x >= W * 0.78;
      if (!border) continue;
      tot++;
      const i = 3 * (y * W + x);
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 24) continue;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < 70) continue;
      const j = i + 3, k = i + 3 * W;
      const lr = 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2];
      const ld = 0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2];
      if (Math.abs(l - lr) + Math.abs(l - ld) > 6) continue;
      hit++;
    }
  }
  return tot ? hit / tot : 0;
}

// 逐帧特征：refSim（与各参考图的最大 NCC）、studio、与下一帧的硬切差。
export async function frameFeatures(videoAbs, refPaths = [], opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  const W = o.thumbW, H = o.thumbH;
  const meta = await probeVideo(videoAbs, o);
  const frames = await decodeThumbs(videoAbs, W, H, o);
  const refs = [];
  for (const p of refPaths) {
    try { if (p && fs.existsSync(p)) { const t = await decodeRefThumb(p, W, H, o); if (t) refs.push({ path: p, gray: toGray(t) }); } } catch { /* 参考图解不出来就只靠 studio 分 */ }
  }
  const grays = frames.map(toGray);
  const feats = frames.map((f, i) => {
    let refSim = 0, refPath = '';
    for (const r of refs) { const s = ncc(grays[i], r.gray); if (s > refSim) { refSim = s; refPath = r.path; } }
    return { i, refSim, refPath, studio: studioScore(f, W, H), diffNext: i + 1 < grays.length ? meanAbsDiff(grays[i], grays[i + 1]) : 0 };
  });
  return { meta, feats, refCount: refs.length };
}

function leakLike(f, o) { return f.refSim >= o.refSimHi || f.studio >= o.studioHi; }

// 在一端（head/tail）找漏帧段：从端点起连续 leakLike，段长 ≤ windowSec，且段与正片之间是硬切。
// 返回 { side, start, end(不含), frames, reason } 或 { side, suspect:true, reason }（像漏帧但不满足裁切条件）或 null。
export function findLeakRuns(feats, fps, opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  const n = feats.length;
  const maxN = Math.max(1, Math.round(o.windowSec * fps));
  const out = [];
  const why = (fs) => {
    const r = Math.max(...fs.map((f) => f.refSim)), s = Math.max(...fs.map((f) => f.studio));
    return (r >= o.refSimHi ? '像参考图(NCC ' + r.toFixed(2) + ')' : '') + (r >= o.refSimHi && s >= o.studioHi ? '+' : '') + (s >= o.studioHi ? '灰棚/白底(' + s.toFixed(2) + ')' : '');
  };
  // head
  let k = 0;
  while (k < n && k <= maxN && leakLike(feats[k], o)) k++;
  if (k >= o.minRunFrames) {
    if (k > maxN || k >= n) out.push({ side: 'head', suspect: true, frames: k, reason: '开头 ' + (k > maxN ? '超过 ' + o.windowSec + ' 秒' : '整镜') + '都像棚拍/参考图，不自动裁' });
    else if (feats[k - 1].diffNext >= o.cutDiff) out.push({ side: 'head', start: 0, end: k, frames: k, reason: why(feats.slice(0, k)) + '，硬切差 ' + feats[k - 1].diffNext.toFixed(1) });
    else out.push({ side: 'head', suspect: true, frames: k, reason: '开头 ' + k + ' 帧像棚拍/参考图，但与正片之间没有硬切（差 ' + feats[k - 1].diffNext.toFixed(1) + '），不自动裁' });
  }
  // tail
  let t = 0;
  while (t < n && t <= maxN && leakLike(feats[n - 1 - t], o)) t++;
  if (t >= o.minRunFrames && !(out[0] && out[0].suspect && out[0].frames >= n)) {
    const s0 = n - t;
    if (t > maxN || s0 <= 0) out.push({ side: 'tail', suspect: true, frames: t, reason: '结尾超过 ' + o.windowSec + ' 秒都像棚拍/参考图，不自动裁' });
    else if (feats[s0 - 1].diffNext >= o.cutDiff) out.push({ side: 'tail', start: s0, end: n, frames: t, reason: why(feats.slice(s0)) + '，硬切差 ' + feats[s0 - 1].diffNext.toFixed(1) });
    else out.push({ side: 'tail', suspect: true, frames: t, reason: '结尾 ' + t + ' 帧像棚拍/参考图，但没有硬切（差 ' + feats[s0 - 1].diffNext.toFixed(1) + '），不自动裁' });
  }
  return out;
}

// 人声带 20ms 窗 RMS（dBFS）。无音轨返回 null。
export async function speechEnvelope(videoAbs, opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  let buf;
  try {
    buf = await runBin('ffmpeg', ['-v', 'error', '-i', videoAbs, '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=250,lowpass=f=3800', '-f', 'f32le', '-'], { binary: true, timeoutMs: o.timeoutMs });
  } catch { return null; }
  const n = Math.floor(buf.length / 4);
  if (!n) return null;
  const win = 320; // 20ms @16k
  const db = [];
  for (let s = 0; s + win <= n; s += win) {
    let acc = 0;
    for (let i = s; i < s + win; i++) { const v = buf.readFloatLE(4 * i); acc += v * v; }
    db.push(10 * Math.log10(acc / win + 1e-12));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? -120;
  return { winSec: 0.02, db, p90 };
}

// [t0,t1) 秒内是否有人声（含 guard 余量）。env 为 null（无音轨/解不出）时按「有声」处理——宁可不裁。
export function speechIn(env, t0, t1, opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  if (!env) return { speech: true, peakDb: null, thrDb: null, why: '音轨不可读' };
  const thr = Math.max(o.speechAbsDb, env.p90 - o.speechRelDb);
  const a = Math.max(0, Math.floor(t0 / env.winSec)), b = Math.min(env.db.length, Math.ceil(t1 / env.winSec));
  let peak = -120;
  for (let i = a; i < b; i++) if (env.db[i] > peak) peak = env.db[i];
  return { speech: peak > thr, peakDb: peak, thrDb: thr };
}

// 检测（不改文件）：返回计划裁切的帧段与跳过/待复核项。
// opts.hasDialogue：本镜有台词/旁白文本（默认 true，按有台词保守处理）。
export async function detectRefLeak(videoAbs, refPaths = [], opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  const { meta, feats, refCount } = await frameFeatures(videoAbs, refPaths, o);
  const n = feats.length;
  const fps = meta.fps;
  const runs = findLeakRuns(feats, fps, o);
  const cuts = [], review = [];
  let env;
  for (const r of runs) {
    if (r.suspect) { review.push(r); continue; }
    const t0 = r.start / fps, t1 = r.end / fps;
    let sp;
    if (o.hasDialogue === false) {
      // 本镜没有台词/旁白：没有人声可剪断，直接裁（音频连同棚拍帧一起去掉）。
      sp = { speech: false, peakDb: null, thrDb: null };
    } else {
      if (env === undefined) env = await speechEnvelope(videoAbs, o);
      sp = r.side === 'head' ? speechIn(env, 0, t1 + o.speechGuardSec, o) : speechIn(env, Math.max(0, t0 - o.speechGuardSec), n / fps, o);
    }
    const rec = { ...r, t0: +t0.toFixed(3), t1: +t1.toFixed(3), speechCheck: o.hasDialogue === false ? '本镜无台词/旁白' : '人声带能量', peakDb: sp.peakDb == null ? null : +sp.peakDb.toFixed(1), thrDb: sp.thrDb == null ? null : +sp.thrDb.toFixed(1) };
    if (sp.speech) review.push({ ...rec, suspect: true, reason: rec.reason + '；但裁切区间有人声（峰值 ' + rec.peakDb + 'dB > 阈值 ' + rec.thrDb + 'dB' + (sp.why ? '，' + sp.why : '') + '），不裁，待人工复核' });
    else cuts.push(rec);
  }
  return { fps, frames: n, duration: meta.duration, refCount, cuts, review };
}

// 按帧裁掉 cuts（只会是首段和/或尾段），音频同步裁，输出到 outAbs。
export async function trimFrames(videoAbs, outAbs, cuts, fps, totalFrames, opts = {}) {
  const o = { ...REF_LEAK_DEFAULTS, ...opts };
  let a = 0, b = totalFrames;
  for (const c of cuts) { if (c.side === 'head') a = Math.max(a, c.end); else b = Math.min(b, c.start); }
  if (b - a < Math.round(fps)) throw new Error('裁后不足 1 秒，放弃裁切');
  const ta = a / fps, tb = b / fps;
  const tmp = outAbs + '.part.mp4';
  await runBin('ffmpeg', ['-v', 'error', '-y', '-i', videoAbs,
    '-vf', 'trim=start_frame=' + a + ':end_frame=' + b + ',setpts=PTS-STARTPTS',
    '-af', 'atrim=start=' + ta.toFixed(6) + ':end=' + tb.toFixed(6) + ',asetpts=PTS-STARTPTS',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { timeoutMs: o.timeoutMs * 2 });
  fs.renameSync(tmp, outAbs);
  return { keepStartFrame: a, keepEndFrame: b, keepStartSec: +ta.toFixed(3), keepEndSec: +tb.toFixed(3) };
}

// 单镜送 H3 的人物/服装/年龄/道具参考图本地路径（与 refs.assembleShotReferences 同一优先级：服装 > 年龄 > 人物原图）。
// 场景图不比对：镜头本来就该在场景里，拿场景图比只会误报。
export function shotRefImagePaths(shot, assets, resolve) {
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const out = [];
  const push = (a) => { if (a?.image_path) { const p = resolve(a.image_path); if (p && !out.includes(p)) out.push(p); } };
  const costumes = (shot.costume_ids || []).map((id) => byId.get(id)).filter((a) => a && a.category === 'costume');
  const ages = (shot.age_ids || []).map((id) => byId.get(id)).filter((a) => a && a.category === 'age');
  for (const cid of (shot.character_ids || [])) {
    const c = byId.get(cid);
    if (!c) continue;
    const co = costumes.find((x) => x.parent_id === cid && x.image_path);
    const ag = ages.find((x) => x.parent_id === cid && x.image_path);
    push(co || ag || c);
  }
  for (const pid of (shot.prop_ids || [])) push(byId.get(pid));
  return out;
}

// 出片后防护网主入口：检测 → 必要时裁切另存 → 写 sidecar 与项目级 jsonl。
// 返回 { relPath（落库用）, record }。任何异常都返回原 relPath。
export async function guardShotVideo({ projectDirAbs, relPath, refPaths = [], shotInfo = {}, opts = {}, log = () => {} }) {
  const abs = path.join(projectDirAbs, relPath);
  const rec = { at: new Date().toISOString(), ...shotInfo, src: relPath, refs: refPaths.map((p) => path.relative(projectDirAbs, p)), action: 'none' };
  try {
    const det = await detectRefLeak(abs, refPaths, opts);
    Object.assign(rec, { fps: det.fps, frames: det.frames, refCount: det.refCount, cuts: det.cuts, review: det.review });
    let out = relPath;
    if (det.cuts.length) {
      const cutRel = relPath.replace(/(\.[^./\\]+)?$/, '_cut.mp4');
      const kept = await trimFrames(abs, path.join(projectDirAbs, cutRel), det.cuts, det.fps, det.frames, opts);
      Object.assign(rec, { action: 'trimmed', out: cutRel, ...kept, cutFrames: det.cuts.reduce((s, c) => s + c.frames, 0) });
      out = cutRel;
      log('info', '参考图入画：' + (shotInfo.label || relPath) + ' 已裁 ' + det.cuts.map((c) => (c.side === 'head' ? '开头' : '结尾') + c.frames + '帧（' + c.reason + '）').join('、') + '，原片保留 ' + relPath + '，裁后 ' + cutRel);
    }
    if (det.review.length) {
      if (rec.action === 'none') rec.action = 'review';
      log('warn', '参考图入画待人工复核：' + (shotInfo.label || relPath) + ' ' + det.review.map((r) => (r.side === 'head' ? '开头' : '结尾') + r.frames + '帧：' + r.reason).join('；'));
    }
    writeRecord(projectDirAbs, relPath, rec);
    return { relPath: out, record: rec };
  } catch (e) {
    rec.action = 'error';
    rec.error = String(e && e.message || e).slice(0, 500);
    log('warn', '参考图入画检测失败，保留原片：' + (shotInfo.label || relPath) + '：' + rec.error);
    try { writeRecord(projectDirAbs, relPath, rec); } catch {}
    return { relPath, record: rec };
  }
}

function writeRecord(projectDirAbs, relPath, rec) {
  // 只有动过刀或待复核/出错才写 sidecar；每镜一行写进项目级 jsonl，便于按章统计。
  if (rec.action !== 'none') fs.writeFileSync(path.join(projectDirAbs, relPath.replace(/(\.[^./\\]+)?$/, '_refleak.json')), JSON.stringify(rec, null, 2));
  const dir = path.join(projectDirAbs, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'ref-leak.jsonl'), JSON.stringify({ at: rec.at, label: rec.label, src: rec.src, action: rec.action, out: rec.out, cuts: (rec.cuts || []).map((c) => ({ side: c.side, frames: c.frames, t0: c.t0, t1: c.t1 })), review: (rec.review || []).map((r) => r.reason), error: rec.error }) + '\n');
}
