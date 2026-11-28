// 场景结构资产（手册 13 号；总导 11-28）：每个地点一份空间母本 JSON + 同一灰模导出的四视图。
// 存放：<项目目录>/scene_master/<scene_id>.json，导出图在 <项目目录>/scene_master/<scene_id>/（平面图.png、正视图.png、左视图.png、右视图.png 及 *_标注.png；美术加工过的在 art/）。
// 写稿读它：剧本站位照母本写，动作要在母本里够得着、走得通（R-006 第 4 条）。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './index.js';

export const sceneMasterDir = (projectId) => path.join(projectDir(projectId), 'scene_master');
export const safeId = (id) => String(id || '').replace(/[\\/:*?"<>|]/g, '_').trim();

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

/** 本资产属于哪个场景母本（母本 JSON 的 asset_ids 里有它）。 */
export function sceneMasterForAsset(projectId, assetId) {
  const dir = sceneMasterDir(projectId);
  if (!assetId || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if ((m.asset_ids || []).includes(assetId)) return m;
    } catch { /* 坏文件跳过 */ }
  }
  return null;
}

export const SCENE_VIEWS = [
  { key: 'plan', name: '平面图', how: '正交俯视，上北下南、左西右东' },
  { key: 'front', name: '正视图', how: '正交，从南向北看，画面左西右东' },
  { key: 'left', name: '左视图', how: '正交，从西向东看，画面左北右南' },
  { key: 'right', name: '右视图', how: '正交，从东向西看，画面左南右北' },
];

/** 审过的四视图美术图（<scene_id>/art/平面图.png 等）；四张缺一张就返回 null。 */
// 审过记录（总导 11-28「art/ 只放过了审的，不过审的不准进出片链路」）：只有场景三视图审图审过写入时（scene-review acceptRound）才写这个文件。
// 四张图都在、而且有审过记录，才送进出片参考；手工放进 art/ 的、或审过记录对不上图的，一律不送。
export const ART_ACCEPTED_FILE = '_审过记录.json';
export function sceneMasterArtViews(projectId, sceneId) {
  const dir = path.join(sceneMasterDir(projectId), safeId(sceneId), 'art');
  const out = SCENE_VIEWS.map((v) => ({ ...v, abs: path.join(dir, v.name + '.png') }));
  if (!out.every((v) => fs.existsSync(v.abs))) return null;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, ART_ACCEPTED_FILE), 'utf8')); } catch { return null; }
  if (!rec || rec.verdict !== 'pass' || !rec.sizes) return null;
  // 图被换过（大小对不上审过时记下的）就不算审过
  for (const v of out) { try { if (fs.statSync(v.abs).size !== rec.sizes[v.key]) return null; } catch { return null; } }
  return out;
}

/** 写稿用的空间锚点摘要：门窗、成组家具的排法和坐法、每件固定物的编号和中心坐标。 */
export function sceneMasterAnchors(m) {
  if (!m) return null;
  const c = (b) => b && b.length === 6 ? [+((b[0] + b[3]) / 2).toFixed(2), +((b[1] + b[4]) / 2).toFixed(2)] : null;
  const ws = m.workstations;
  return {
    scene_id: m.scene_id, name: m.name, location_id: m.location_id || '',
    axes: 'X 向东、Y 向北、单位米（坐标只给写稿推理用，提示词里翻成「第三排、小过道东侧紧挨过道那张」这类自然语言锚点）',
    room: m.room,
    openings: (m.openings || []).map((o) => ({ id: o.id, name: o.name, wall: o.side, span: [o.from, o.to] })),
    zones: (m.zones || []).map((z) => ({ id: z.id, name: z.name })),
    workstations: ws ? { seating_rule: ws.seating_rule, rows: ws.rows, cols: ws.cols, highlight: ws.highlight || [] } : undefined,
    fixtures: (m.items || []).filter((it) => !/^MUL|^UPW|^AC\d/.test(it.id)).map((it) => ({ id: it.id, name: it.name, at: it.center || c(it.box), yaw: it.yaw ?? it.front_yaw })),
    lights: m.lights || [],
  };
}
