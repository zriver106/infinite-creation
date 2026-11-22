// 出片质量闸门（2026-11-18 第三批提案，摩天轮 5184dd11 灰片事故）。
// 现象：1080P 二次采样超分链路偶发整段棕灰纹理片（采样帧灰度标准差 1.4–3.3），ComfyUI 不报错，
// IC 按成功收片；ref-leak 只把首尾当「像棚拍」记复核，仍收片。
// 本模块在单镜 mp4 下载后、ref-leak 之前做 CPU 抽帧检查（ffmpeg，不碰 GPU）：
//   在片长内均匀抽 samples 帧（默认 5），缩成 160×90 灰度，算每帧标准差 std 与「相邻像素差 / std」比 adjRatio。
//   - 近纯色/灰场：std < minStd（默认 10，总导口径）的帧数 ≥ ceil(samples × badFraction)（默认 0.6 → 5 帧里 3 帧）→ 判坏片。
//   - 纯噪点（雪花）：std 正常但 adjRatio ≥ noiseAdjRatio（默认 0.9；白噪声理论值约 1.13，真实画面远低于此）的帧数达到同样比例 → 判坏片。
//   - std < watchStd（默认 20）的帧达到比例只记「观察」，不拦。
// 判坏片：写 shots/<原名>_quality.json + 项目 logs/clip-quality.jsonl，抛错让该候选失败（原片保留不删），
//   由调用方按现有失败流程把分镜标 failed，error 里写清原因。
// 检查本身出错（ffmpeg 不可用、文件读不出等）默认放行（failOpen），只记日志，不让出片中断；可配置成拦。
// 配置：config.generation.clipQuality = false 关闭；或对象覆盖下列默认值。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CLIP_QUALITY_DEFAULTS = Object.freeze({
  enabled: true,
  samples: 5,          // 均匀抽帧数（取各段中点，避开首尾第 0 帧/最后一帧）
  thumbW: 160,
  thumbH: 90,
  minStd: 10,          // 灰度标准差 < 此值 = 近纯色/灰场（0–255 灰度）
  watchStd: 20,        // < 此值只记观察
  noiseAdjRatio: 0.9,  // 相邻像素平均绝对差 / std ≥ 此值 = 像噪点
  badFraction: 0.6,    // 达到该比例的抽样帧异常才判坏片
  failOpen: true,      // 检查出错时放行
  timeoutMs: 60_000,
});

export function resolveClipQualityOptions(cfgValue) {
  if (cfgValue === false) return { ...CLIP_QUALITY_DEFAULTS, enabled: false };
  const o = { ...CLIP_QUALITY_DEFAULTS };
  if (cfgValue && typeof cfgValue === 'object') {
    for (const k of Object.keys(CLIP_QUALITY_DEFAULTS)) {
      if (cfgValue[k] === undefined) continue;
      if (typeof CLIP_QUALITY_DEFAULTS[k] === 'boolean') o[k] = cfgValue[k] !== false;
      else if (Number.isFinite(Number(cfgValue[k]))) o[k] = Number(cfgValue[k]);
    }
  }
  o.samples = Math.max(1, Math.min(20, Math.floor(o.samples)));
  o.badFraction = Math.min(1, Math.max(0.01, o.badFraction));
  return o;
}

// 灰度帧统计：均值、标准差、相邻像素（水平+垂直）平均绝对差与 std 之比。
export function frameStats(gray, W, H) {
  const n = W * H;
  let m = 0;
  for (let i = 0; i < n; i++) m += gray[i];
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) { const d = gray[i] - m; s += d * d; }
  const std = Math.sqrt(s / n);
  let adj = 0, cnt = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x + 1 < W) { adj += Math.abs(gray[i] - gray[i + 1]); cnt++; }
      if (y + 1 < H) { adj += Math.abs(gray[i] - gray[i + W]); cnt++; }
    }
  }
  const adjMean = cnt ? adj / cnt : 0;
  return { mean: round2(m), std: round2(std), adjRatio: std > 1e-6 ? round2(adjMean / std) : 0 };
}

function round2(x) { return Math.round(x * 100) / 100; }

// 抽帧时刻：把片长切成 n 段取各段中点。
export function sampleTimes(duration, n) {
  const d = Number(duration) > 0 ? Number(duration) : 0;
  if (!d) return [0];
  return Array.from({ length: n }, (_, i) => round2(((i + 0.5) / n) * d));
}

// 判定：输入每个抽样帧的 { std, adjRatio }，输出 verdict = ok / watch / bad。
export function judgeClip(stats, opts = {}) {
  const o = { ...CLIP_QUALITY_DEFAULTS, ...opts };
  const n = stats.length;
  if (!n) return { verdict: 'ok', reason: '', flat: 0, noise: 0, watch: 0, n };
  const need = Math.max(1, Math.ceil(n * o.badFraction));
  const flat = stats.filter((s) => s.std < o.minStd).length;
  const noise = stats.filter((s) => s.std >= o.minStd && s.adjRatio >= o.noiseAdjRatio).length;
  const watch = stats.filter((s) => s.std < o.watchStd).length;
  const stds = stats.map((s) => s.std);
  const range = Math.min(...stds) + '–' + Math.max(...stds);
  if (flat >= need) {
    return { verdict: 'bad', kind: 'flat', flat, noise, watch, n, need,
      reason: '整段近纯色/灰场：抽样 ' + n + ' 帧中 ' + flat + ' 帧灰度标准差 < ' + o.minStd + '（各帧 std ' + range + '）' };
  }
  if (noise >= need || flat + noise >= need) {
    return { verdict: 'bad', kind: flat ? 'flat+noise' : 'noise', flat, noise, watch, n, need,
      reason: '整段像噪点/雪花：抽样 ' + n + ' 帧中 ' + (flat + noise) + ' 帧异常（相邻像素差/std ≥ ' + o.noiseAdjRatio + ' 或 std < ' + o.minStd + '）' };
  }
  if (watch >= need) {
    return { verdict: 'watch', kind: 'low', flat, noise, watch, n, need,
      reason: '画面对比偏低：抽样 ' + n + ' 帧中 ' + watch + ' 帧灰度标准差 < ' + o.watchStd + '（各帧 std ' + range + '），只记观察' };
  }
  return { verdict: 'ok', reason: '', flat, noise, watch, n, need };
}

function runBin(bin, args, { timeoutMs = 60_000, binary = false } = {}) {
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
      if (code !== 0) return done(reject, new Error(bin + ' 退出码 ' + code + '：' + stderr.slice(-400)));
      const buf = Buffer.concat(chunks);
      done(resolve, binary ? buf : buf.toString());
    });
  });
}

// 默认取帧器：ffprobe 读时长，ffmpeg -ss 逐帧解一张 W×H 灰度图（CPU）。测试里可注入假实现。
export const ffmpegSampler = {
  async duration(abs, o) {
    const out = await runBin('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', abs], { timeoutMs: o.timeoutMs });
    return Number(JSON.parse(out).format?.duration) || 0;
  },
  async grayFrame(abs, t, o) {
    const buf = await runBin('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-an',
      '-vf', 'scale=' + o.thumbW + ':' + o.thumbH + ':flags=area,format=gray', '-f', 'rawvideo', '-'], { binary: true, timeoutMs: o.timeoutMs });
    if (buf.length < o.thumbW * o.thumbH) throw new Error('抽帧失败（t=' + t + 's，只读到 ' + buf.length + ' 字节）');
    return buf.subarray(0, o.thumbW * o.thumbH);
  },
};

export async function checkClipQuality(abs, opts = {}, sampler = ffmpegSampler) {
  const o = { ...CLIP_QUALITY_DEFAULTS, ...opts };
  const duration = await sampler.duration(abs, o);
  const times = sampleTimes(duration, o.samples);
  const stats = [];
  for (const t of times) {
    const g = await sampler.grayFrame(abs, t, o);
    stats.push({ t, ...frameStats(g, o.thumbW, o.thumbH) });
  }
  return { duration, stats, ...judgeClip(stats, o) };
}

// 出片后闸门主入口。返回 { ok, record }；ok=false 时调用方应把该候选判失败（record.reason 写清原因）。
export async function guardClipQuality({ projectDirAbs, relPath, shotInfo = {}, opts = {}, log = () => {}, sampler = ffmpegSampler }) {
  const o = { ...CLIP_QUALITY_DEFAULTS, ...opts };
  const rec = { at: new Date().toISOString(), ...shotInfo, src: relPath, verdict: 'ok' };
  if (!o.enabled) return { ok: true, record: { ...rec, verdict: 'skipped' } };
  try {
    const r = await checkClipQuality(path.join(projectDirAbs, relPath), o, sampler);
    Object.assign(rec, { verdict: r.verdict, kind: r.kind || '', reason: r.reason, duration: r.duration, stats: r.stats,
      thresholds: { minStd: o.minStd, watchStd: o.watchStd, noiseAdjRatio: o.noiseAdjRatio, badFraction: o.badFraction, samples: o.samples } });
    if (r.verdict === 'bad') log('warn', '出片质量闸门：' + (shotInfo.label || relPath) + ' 判坏片——' + r.reason + '；原片保留 ' + relPath);
    else if (r.verdict === 'watch') log('info', '出片质量观察：' + (shotInfo.label || relPath) + ' ' + r.reason);
    writeRecord(projectDirAbs, relPath, rec);
    return { ok: r.verdict !== 'bad', record: rec };
  } catch (e) {
    rec.verdict = 'error';
    rec.error = String(e && e.message || e).slice(0, 500);
    log('warn', '出片质量检查失败' + (o.failOpen ? '，按配置放行' : '，按配置拦下') + '：' + (shotInfo.label || relPath) + '：' + rec.error);
    try { writeRecord(projectDirAbs, relPath, rec); } catch {}
    return { ok: !!o.failOpen, record: rec };
  }
}

function writeRecord(projectDirAbs, relPath, rec) {
  // 坏片 / 观察 / 出错才写 sidecar；每镜一行写进项目级 jsonl。
  if (rec.verdict !== 'ok') fs.writeFileSync(path.join(projectDirAbs, relPath.replace(/(\.[^./\\]+)?$/, '_quality.json')), JSON.stringify(rec, null, 2));
  const dir = path.join(projectDirAbs, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'clip-quality.jsonl'), JSON.stringify({ at: rec.at, label: rec.label, src: rec.src, verdict: rec.verdict, kind: rec.kind, reason: rec.reason, stds: (rec.stats || []).map((s) => s.std), error: rec.error }) + '\n');
}