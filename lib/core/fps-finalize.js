// 成片帧率收尾（Andy：要 30 帧，加 RIFE 插帧，默认用独立版；总导 11-26：出片照旧 24 帧，导出整章时插到 30，1088 裁成 1080）。
// 项目设置 projects.context.export_interp：none（不插，24）| rife（RIFE 独立版 rife-ncnn-vulkan，缺省）| rife-comfyui（ComfyUI 版，没装时退回不插并写明）。
// 只在导出整章的最后一步做：先裁 1088→1080（居中），再插帧；音轨原样带上。原地替换（先写临时文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';
import { Projects } from './db.js';

export const EXPORT_INTERP_KEY = 'export_interp';
export const INTERP_MODES = ['none', 'rife', 'rife-comfyui'];
export const TARGET_FPS = 30;

export function interpModeOf(projectId) {
  const v = (((Projects.get(projectId) || {}).context || {})[EXPORT_INTERP_KEY]) || '';
  return INTERP_MODES.includes(v) ? v : 'rife';
}

export function rifePaths(cfg = loadConfig()) {
  const r = (cfg && cfg.rife) || {};
  const root = r.root || 'C:/tmp_infinite_creation/tools/rife/rife-ncnn-vulkan-20221029-windows';
  return { exe: r.exe || path.join(root, 'rife-ncnn-vulkan.exe'), model: r.model || path.join(root, 'rife-v4.6'), gpu: r.gpu == null ? 0 : Number(r.gpu) };
}
export const rifeAvailable = (cfg) => { const p = rifePaths(cfg); return fs.existsSync(p.exe) && fs.existsSync(p.model); };

function run(bin, args, timeout = 3600000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-600))) : resolve(String(stdout || ''))));
  });
}

export async function probe(abs) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', abs], 60000);
  const s = (JSON.parse(out).streams || [])[0] || {};
  const [a, b] = String(s.r_frame_rate || '0/1').split('/').map(Number);
  return { width: Number(s.width) || 0, height: Number(s.height) || 0, fps: b ? a / b : 0 };
}

/**
 * 导出文件收尾：裁 1088→1080、按项目设置插到 30 帧。返回 { cropped, interp, mode, note }。
 * runGpu：拿 GPU 的包装（RIFE 用显卡，和出片抢卡时排队）；不给就直接跑。
 */
export async function finalizeExport(projectId, abs, { report = () => {}, runGpu = (fn) => fn(), isAborted = () => false } = {}) {
  const mode = interpModeOf(projectId);
  const info = await probe(abs);
  const crop = info.height === 1088;
  const wantInterp = mode !== 'none' && info.fps > 0 && Math.abs(info.fps - TARGET_FPS) > 0.5;
  if (!crop && !wantInterp) return { cropped: false, interp: false, mode, note: '不用处理（' + info.height + 'p ' + info.fps.toFixed(2) + 'fps）' };
  const cropVf = crop ? 'crop=iw:1080:0:(ih-1080)/2' : '';
  const tmpOut = abs.replace(/(\.[^.]+)$/, '.fps_tmp$1');
  let rifeErr = '';
  if (wantInterp && mode === 'rife' && rifeAvailable()) {
    const p = rifePaths();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_rife_'));
    const inDir = path.join(work, 'in'); const outDir = path.join(work, 'out');
    fs.mkdirSync(inDir); fs.mkdirSync(outDir);
    try {
      report({ phase: '插帧', detail: '拆帧' + (crop ? '（同时裁 1088→1080）' : '') });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, ...(cropVf ? ['-vf', cropVf] : []), '-fps_mode', 'passthrough', path.join(inDir, '%08d.png')]);
      const n = fs.readdirSync(inDir).length;
      const target = Math.round(n * TARGET_FPS / info.fps);
      if (isAborted()) throw new Error('已停止');
      report({ phase: '插帧', detail: 'RIFE 独立版 ' + n + ' → ' + target + ' 帧' });
      await runGpu(() => run(p.exe, ['-i', inDir, '-o', outDir, '-m', p.model, '-g', String(p.gpu), '-n', String(target), '-f', '%08d.png']));
      report({ phase: '插帧', detail: '编码 30fps' });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(TARGET_FPS), '-i', path.join(outDir, '%08d.png'), '-i', abs, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', tmpOut]);
      fs.renameSync(tmpOut, abs);
      return { cropped: crop, interp: true, mode, note: 'RIFE 独立版插到 30fps' + (crop ? '，裁 1088→1080' : '') };
    } catch (e) {
      // 插帧没跑成（只跑文本的任务里不许用显卡、RIFE 出错等）：退回只裁，写明原因，成片照样出
      rifeErr = String((e && e.message) || e).slice(0, 200);
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* 没有临时文件 */ }
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响成片 */ } }
  }
  // 不插帧 / RIFE 不可用（ComfyUI 版没装、独立版文件不在）：只裁 1088→1080，帧率不动，写明原因
  const why = rifeErr ? 'RIFE 插帧没跑成（' + rifeErr + '），这次没插帧' : mode === 'none' ? '项目设置为不插帧' : mode === 'rife-comfyui' ? 'RIFE ComfyUI 版还没装，这次没插帧' : 'RIFE 独立版文件不在，这次没插帧';
  if (!crop) return { cropped: false, interp: false, mode, note: why };
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vf', cropVf, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', tmpOut]);
  fs.renameSync(tmpOut, abs);
  return { cropped: true, interp: false, mode, note: why + '；裁 1088→1080' };
}
