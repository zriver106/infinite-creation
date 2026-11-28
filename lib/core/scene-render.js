// 首尾帧控制 S2：按 camera_rig 从场景母本渲首尾灰模 + 深度 + 线稿（tools/scene_render/rig_render.py，CPU，不碰显卡）。
// 输出：<项目>/frames/rig/<shotId>/{first,last}/{灰模,深度,线稿}.png，rig.json（这次用的机位），meta.json（占位在画面里的位置）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveProjectPath } from './refs.js';
import { sceneMasterDir, safeId } from './scene-master.js';
import { rigRel } from './camera-rig.js';

const RENDERER = path.join(process.cwd(), 'tools', 'scene_render', 'rig_render.py');

/** 渲染器用哪个 python：配置 keyframeRig.python（要装 numpy、Pillow），没配用 PATH 里的 python。 */
export function rigPython(cfg) {
  return (cfg && cfg.keyframeRig && cfg.keyframeRig.python) || process.env.IC_RIG_PYTHON || 'python';
}

export function masterFileFor(projectId, sceneId) {
  const f = path.join(sceneMasterDir(projectId), safeId(sceneId) + '.json');
  return fs.existsSync(f) ? f : '';
}

function runPython(py, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, ['-X', 'utf8', ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = ''; let err = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('灰模渲染超时（' + Math.round(timeoutMs / 1000) + ' 秒）')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(new Error('启动 python 失败（' + py + '）：' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error('灰模渲染失败（退出码 ' + code + '）：' + (err || out).slice(-800)));
      resolve(out);
    });
  });
}

/**
 * 渲染一镜的首尾灰模。返回 { dir（相对路径）, first:{gray,depth,edge}, last:{...}|null, meta }，路径都是项目内相对路径。
 * @param deps.run  测试注入（替代真正起 python）
 */
export async function renderRig(projectId, shotId, rig, { cfg = null, run = runPython } = {}) {
  if (!rig || !rig.first) throw new Error('没有首帧机位，不能渲染');
  if (!rig.scene_id) throw new Error('机位没写 scene_id（场景母本）');
  const master = masterFileFor(projectId, rig.scene_id);
  if (!master) throw new Error('场景母本不存在：' + rig.scene_id);
  const dirRel = rigRel(shotId);
  const dir = resolveProjectPath(projectId, dirRel);
  if (!dir) throw new Error('输出路径越界');
  fs.mkdirSync(dir, { recursive: true });
  const rigFile = path.join(dir, 'rig.json');
  fs.writeFileSync(rigFile, JSON.stringify(rig, null, 1));
  await run(rigPython(cfg), [RENDERER, master, rigFile, dir]);
  const views = {};
  for (const k of ['first', 'last']) {
    if (!rig[k]) { views[k] = null; continue; }
    const one = { gray: rigRel(shotId, k, '灰模.png'), depth: rigRel(shotId, k, '深度.png'), edge: rigRel(shotId, k, '线稿.png') };
    for (const rel of Object.values(one)) if (!fs.existsSync(resolveProjectPath(projectId, rel))) throw new Error('渲染器没产出 ' + rel);
    views[k] = one;
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {}
  return { dir: dirRel, ...views, meta };
}
