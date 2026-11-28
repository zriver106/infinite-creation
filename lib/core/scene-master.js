// 场景结构资产（手册 13 号；总导 11-28）：每个地点一份空间母本 JSON + 同一灰模导出的四视图。
// 存放：<项目目录>/scene_master/<scene_id>.json，导出图在 <项目目录>/scene_master/<scene_id>/（平面图.png、正视图.png、左视图.png、右视图.png 及 *_标注.png；美术加工过的在 art/）。
// 写稿读它：剧本站位照母本写，动作要在母本里够得着、走得通（R-006 第 4 条）。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './index.js';

export const sceneMasterDir = (projectId) => path.join(projectDir(projectId), 'scene_master');
const safeId = (id) => String(id || '').replace(/[\\/:*?"<>|]/g, '_').trim();

/** 列出本项目的场景母本：[{ scene_id, name, items, has_plan }]。 */
export function listSceneMasters(projectId) {
  const dir = sceneMasterDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const id = m.scene_id || f.replace(/\.json$/, '');
      return { scene_id: id, name: m.name || '', items: (m.items || []).length + ((m.workstations && m.workstations.rows) ? m.workstations.rows.length * (m.workstations.cols || []).length : 0), has_plan: fs.existsSync(path.join(dir, safeId(id), '平面图_标注.png')) };
    } catch { return null; }
  }).filter(Boolean);
}

/** 读一份母本：{ master, plan }（plan＝标注版平面图的本机路径，没有为空）。 */
export function getSceneMaster(projectId, sceneId) {
  const dir = sceneMasterDir(projectId);
  const id = safeId(sceneId);
  const f = path.join(dir, id + '.json');
  if (!fs.existsSync(f)) return null;
  const master = JSON.parse(fs.readFileSync(f, 'utf8'));
  const plan = path.join(dir, id, '平面图_标注.png');
  return { master, plan: fs.existsSync(plan) ? plan : '' };
}

export const hasSceneMasters = (projectId) => listSceneMasters(projectId).length > 0;
