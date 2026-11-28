// 成片帧率收尾（Andy：要 30 帧，加 RIFE 插帧，默认用独立版；总导 11-26：出片照旧 24 帧，导出整章时插到 30，1088 裁成 1080）。
// 项目设置 projects.context.export_interp：none（不插，24）| rife（RIFE 独立版 rife-ncnn-vulkan，缺省）| rife-comfyui（ComfyUI 版，没装时退回不插并写明）。
// 只在导出整章的最后一步做：先把高度居中裁到标准档（1088→1080、736→720 等，见 cropTargetHeight），再插帧；音轨原样带上。原地替换（先写临时文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';
import { Projects } from './db.js';
import { logger } from './logger.js';

/**
 * 临时文件换回原文件（11-28 跟进2 报：主成片收尾生成了 .fps_tmp，但没换回去，主文件还是 736 / 24 帧，也没报错）。
 * Windows 上原文件正被读（预览、下载、交付复制）时改名会 EPERM / EBUSY：等一会儿重试，仍不行就整份拷过去再删临时文件；都不行才抛错。
 */
export async function replaceFile(tmp, abs, { tries = 20, waitMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fsx = fs } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { fsx.renameSync(tmp, abs); return 'rename'; }
    catch (e) { last = e; if (!/EPERM|EBUSY|EACCES/.test(String(e && e.code) + String(e && e.message))) break; await sleep(waitMs); }
  }
  try { fsx.copyFileSync(tmp, abs); try { fsx.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不影响成片 */ } return 'copy'; }
  catch (e) { throw new Error('收尾结果换不回原文件（' + ((last && last.message) || '') + '；拷贝也失败：' + e.message + '），临时文件留在 ' + tmp); }
}

export const EXPORT_INTERP_KEY = 'export_interp';
export const INTERP_MODES = ['none', 'rife', 'rife-comfyui'];
export const TARGET_FPS = 30;
// 标准高度档（11-28 跟进2 报：720P 出片高 736 没裁）。H3 出片高度对齐到 16 的倍数，会比标准档多出几行（1088、736、496）：
// 高度不在档上、且比下面最近一档多出不超过 32 行时，居中裁到那一档；在档上或差太多（不是对齐造成的）就不动。
export const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 576, 480, 360];
export function cropTargetHeight(h) {
  h = Number(h) || 0;
  if (!h || STANDARD_HEIGHTS.includes(h)) return 0;
  const t = STANDARD_HEIGHTS.find((x) => x < h);
  return t && h - t <= 32 ? t : 0;
}

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
 * 导出文件收尾：高度裁到标准档（1088→1080、736→720）、按项目设置插到 30 帧。返回 { cropped, interp, mode, note }。
 * runGpu：拿 GPU 的包装（RIFE 用显卡，和出片抢卡时排队）；不给就直接跑。
 */
export async function finalizeExport(projectId, abs, { report = () => {}, runGpu = (fn) => fn(), isAborted = () => false, interp = true } = {}) {
  // interp=false：只裁边不插帧（网页导出先只裁，插帧另起后台任务排在出片后面，见 export 路由）
  const mode = interp ? interpModeOf(projectId) : 'none';
  const info = await probe(abs);
  const cropH = cropTargetHeight(info.height);
  const crop = cropH > 0;
  const cropTxt = crop ? '裁 ' + info.height + '→' + cropH : '';
  const wantInterp = mode !== 'none' && info.fps > 0 && Math.abs(info.fps - TARGET_FPS) > 0.5;
  if (!crop && !wantInterp) return { cropped: false, interp: false, mode, note: '不用处理（' + info.height + 'p ' + info.fps.toFixed(2) + 'fps）' };
  const cropVf = crop ? 'crop=iw:' + cropH + ':0:(ih-' + cropH + ')/2' : '';
  const tmpOut = abs.replace(/(\.[^.]+)$/, '.fps_tmp$1');
  let rifeErr = '';
  if (wantInterp && mode === 'rife' && rifeAvailable()) {
    const p = rifePaths();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ic_rife_'));
    const inDir = path.join(work, 'in'); const outDir = path.join(work, 'out');
    fs.mkdirSync(inDir); fs.mkdirSync(outDir);
    try {
      report({ phase: '插帧', detail: '拆帧' + (crop ? '（同时' + cropTxt + '）' : '') });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, ...(cropVf ? ['-vf', cropVf] : []), '-fps_mode', 'passthrough', path.join(inDir, '%08d.png')]);
      const n = fs.readdirSync(inDir).length;
      const target = Math.round(n * TARGET_FPS / info.fps);
      if (isAborted()) throw new Error('已停止');
      report({ phase: '插帧', detail: 'RIFE 独立版 ' + n + ' → ' + target + ' 帧' });
      await runGpu(() => run(p.exe, ['-i', inDir, '-o', outDir, '-m', p.model, '-g', String(p.gpu), '-n', String(target), '-f', '%08d.png']));
      report({ phase: '插帧', detail: '编码 30fps' });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(TARGET_FPS), '-i', path.join(outDir, '%08d.png'), '-i', abs, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', tmpOut]);
      await replaceFile(tmpOut, abs);
      return { cropped: crop, interp: true, mode, failed: false, note: 'RIFE 独立版插到 30fps' + (crop ? '，' + cropTxt : '') };
    } catch (e) {
      // 插帧没跑成（只跑文本的任务里不许用显卡、RIFE 出错等）：退回只裁，写明原因，成片照样出
      rifeErr = String((e && e.message) || e).slice(0, 200);
      logger.warn('RIFE 插帧失败，退回只裁', { projectId, file: path.basename(abs), error: rifeErr });
      try { fs.rmSync(tmpOut, { force: true }); } catch { /* 没有临时文件 */ }
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响成片 */ } }
  }
  // 不插帧 / RIFE 不可用（ComfyUI 版没装、独立版文件不在）：只裁到标准档，帧率不动，写明原因
  const why = rifeErr ? 'RIFE 插帧没跑成（' + rifeErr + '），这次没插帧' : mode === 'none' ? '项目设置为不插帧' : mode === 'rife-comfyui' ? 'RIFE ComfyUI 版还没装，这次没插帧' : 'RIFE 独立版文件不在，这次没插帧';
  const failed = !!rifeErr;   // 要插帧却没插成：调用方要当失败处理，不能报完成
  if (!crop) return { cropped: false, interp: false, mode, failed, note: why };
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vf', cropVf, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', tmpOut]);
  await replaceFile(tmpOut, abs);
  return { cropped: true, interp: false, mode, failed, note: why + '；' + cropTxt };
}
