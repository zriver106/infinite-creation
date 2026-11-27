// 跨项目只读参考资产（总导 11-26：Andy「用 v2 的场景图做基础去做多视角」「人物、道具也可以用 v2 的」）。
// 资产分析看 V2 定稿资产的描述和图，按底图对齐布局表 / 戏份说明 / 缺图单。只读：不写、不改参考项目；
// 只能读本项目登记过的参考项目（config.json assetAnalyze.referenceProjects[本项目 id] = [参考项目 id, …]）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, projectDir } from './config.js';
import { Assets, Projects } from './db.js';

export function referenceProjectsOf(projectId, cfg = loadConfig()) {
  const m = (cfg && cfg.assetAnalyze && cfg.assetAnalyze.referenceProjects) || {};
  return (Array.isArray(m[projectId]) ? m[projectId] : []).map(String).filter((id) => id && id !== projectId && Projects.get(id));
}

const MAX_SIDE = 1568;
// 图缩到长边 1568 的 jpg 再给模型看（原图 2K/4K png 太大）；ffmpeg 不可用时给原图（超过 4.5MB 不给图）
export function imagePayload(abs) {
  try {
    const out = path.join(os.tmpdir(), 'ic_ref_' + process.pid + '_' + Date.now() + '.jpg');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-vf', `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', out], { timeout: 60000 });
    const data = fs.readFileSync(out).toString('base64'); fs.rmSync(out, { force: true });
    return { data, mimeType: 'image/jpeg' };
  } catch {
    const st = fs.statSync(abs);
    if (st.size > 4.5 * 1024 * 1024) return null;
    const ext = path.extname(abs).toLowerCase();
    return { data: fs.readFileSync(abs).toString('base64'), mimeType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  }
}

/**
 * 读参考项目里的资产。asset_id 精确；name 先精确、再按「编号前缀」（如 S434_MV、S179）、再按包含匹配。
 * 命中一个：返回描述 + 图（with_image 默认 true）；命中多个：只列清单（最多 30）让调用方挑。
 */
export function viewReferenceAsset(projectId, { project_id = '', asset_id = '', name = '', with_image = true } = {}, cfg = loadConfig()) {
  const allowed = referenceProjectsOf(projectId, cfg);
  if (!allowed.length) throw Object.assign(new Error('本项目没有登记可读的参考项目（config.json assetAnalyze.referenceProjects）'), { code: 'NO_REF_PROJECT' });
  if (project_id && !allowed.includes(String(project_id))) throw Object.assign(new Error('参考项目 ' + project_id + ' 没登记，只能读：' + allowed.join('、')), { code: 'REF_NOT_ALLOWED' });
  const pids = project_id ? [String(project_id)] : allowed;
  const all = pids.flatMap((pid) => Assets.list(pid).map((a) => ({ ...a, _pid: pid })));
  let hits = [];
  if (asset_id) hits = all.filter((a) => a.id === String(asset_id));
  else {
    const n = String(name || '').trim();
    if (!n) throw Object.assign(new Error('要给 asset_id 或 name'), { code: 'BAD_ARGS' });
    hits = all.filter((a) => a.name === n);
    if (!hits.length) hits = all.filter((a) => a.name.split('·')[0] === n);
    if (!hits.length) hits = all.filter((a) => a.name.includes(n));
  }
  const brief = (a) => ({ project_id: a._pid, project: (Projects.get(a._pid) || {}).name || '', asset_id: a.id, name: a.name, category: a.category, parent_id: a.parent_id || '', has_image: !!a.image_path });
  if (!hits.length) return { found: 0, note: '参考项目里没有叫「' + (name || asset_id) + '」的资产' };
  if (hits.length > 1) return { found: hits.length, candidates: hits.slice(0, 30).map(brief), note: '命中多个：用 asset_id 再调一次' };
  const a = hits[0];
  const parent = a.parent_id ? Assets.get(a.parent_id) : null;
  const res = { found: 1, ...brief(a), parent_name: parent ? parent.name : '', description: String(a.description || '').slice(0, 6000), prompt: String(a.prompt || '').slice(0, 3000), image_path: a.image_path || '' };
  if (!with_image || !a.image_path) return res;
  const abs = path.join(projectDir(a._pid), a.image_path);
  if (!abs.startsWith(projectDir(a._pid)) || !fs.existsSync(abs)) return { ...res, image_note: '图文件不在' };
  const img = imagePayload(abs);
  return img ? { text: JSON.stringify(res), images: [img] } : { ...res, image_note: '图太大没附上' };
}

/** base_ref 规整：{ project_id, asset_id, name, cell }，缺 asset_id 视为没有。 */
export function normBaseRef(v) {
  if (!v || typeof v !== 'object') return null;
  const r = { project_id: String(v.project_id || '').trim(), asset_id: String(v.asset_id || '').trim(), name: String(v.name || '').trim(), cell: String(v.cell || '').trim() };
  return r.asset_id ? r : null;
}
