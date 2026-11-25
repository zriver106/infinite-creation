// 出片口缺绑检查（2026-11-25，主会话 seq1425/1431/1433 口径）：只读，不自动补绑。
// 逐镜查三样：画面里的每个人物绑了本人服装；scene_ids 不为空；多人镜绑了该地点的多视角定义图（_MV）。
// 分级：
//   A 缺场景：scene_ids 为空。
//   B 真漏绑：资产库里该人物有服装资产，这一镜却没绑；或该地点有 _MV 资产，多人镜没绑。→ 由我方 Agent 用 PATCH /shots/:sid 补。
//   C 没资产可绑：该人物没有任何服装资产；或多人镜所在地点没有 _MV。→ 列进资产缺口单交 Muse 补图。
// 缺项总是上报；只有 generation.bindingCheckBlock=true 时才对 A、B 拦截该镜（缺省 false，只报不拦）。
import { Assets } from '../core/index.js';

const MV_RE = /_MV|多视角定义图/;

function isMvAsset(a) { return a && a.category === 'scene' && MV_RE.test(String(a.name || '')); }

// 地点核心名：去掉「·多视角定义图」「Sxxx_MV·」「Sxxx·」这类前后缀，留下地名本身（取 · 分隔的第一段地名）。
export function placeKey(name) {
  let s = String(name || '').trim();
  s = s.replace(/[·・]?多视角定义图$/, '');
  s = s.replace(/^S\d+(_MV)?[·・_ ]*/i, '');
  s = s.replace(/_MV$/i, '');
  return s.split(/[·・]/)[0].trim();
}

/** 找某个场景对应的 _MV 资产：场景本身就是 _MV → 它；否则按地点核心名匹配（相等或互相包含，且至少 2 个字）。 */
export function findMvForScene(scene, mvAssets) {
  if (!scene) return null;
  if (isMvAsset(scene)) return scene;
  const k = placeKey(scene.name);
  if (k.length < 2) return null;
  return mvAssets.find((m) => { const mk = placeKey(m.name); return mk.length >= 2 && (mk === k || mk.includes(k) || k.includes(mk)); }) || null;
}

/**
 * 查一镜的绑定。assets 可传入（批量时复用），否则按项目读。
 * 返回 { issues: [{ level:'A'|'B'|'C', kind, detail }], blocking: bool(按 A/B 有无) }。
 */
export function checkShotBindings(shot, { assets, projectId } = {}) {
  const list = assets || Assets.list(projectId || shot.project_id);
  const byId = new Map(list.map((a) => [a.id, a]));
  const issues = [];
  const charIds = (shot.character_ids || []).filter((id) => byId.get(id) && byId.get(id).category === 'character');
  const sceneIds = (shot.scene_ids || []).filter((id) => byId.has(id));
  const costumeIds = new Set(shot.costume_ids || []);

  if (!sceneIds.length) issues.push({ level: 'A', kind: 'scene', detail: '没绑场景（scene_ids 为空）' });

  // 每个人物：有服装资产却没绑 → B；没有任何服装资产 → C
  for (const cid of charIds) {
    const ch = byId.get(cid);
    const own = list.filter((a) => a.category === 'costume' && a.parent_id === cid);
    if (own.some((a) => costumeIds.has(a.id))) continue;
    if (own.length) issues.push({ level: 'B', kind: 'costume', detail: '人物「' + ch.name + '」库里有服装 ' + own.length + ' 套，这一镜没绑' });
    else issues.push({ level: 'C', kind: 'costume', detail: '人物「' + ch.name + '」没有服装资产，需 Muse 补图' });
  }

  // 多人镜：该地点有 _MV 却没绑 → B；地点没有 _MV → C
  if (charIds.length >= 2 && sceneIds.length) {
    const scenes = sceneIds.map((id) => byId.get(id));
    if (!scenes.some(isMvAsset)) {
      const mvs = list.filter(isMvAsset);
      const hit = scenes.map((s) => findMvForScene(s, mvs)).find(Boolean);
      const where = scenes.map((s) => s.name).join('、');
      if (hit) issues.push({ level: 'B', kind: 'mv', detail: '多人镜地点「' + where + '」已有多视角图「' + hit.name + '」，这一镜没绑' });
      else issues.push({ level: 'C', kind: 'mv', detail: '多人镜地点「' + where + '」还没有多视角定义图（_MV），需 Muse 补图' });
    }
  }
  return { issues, blocking: issues.some((i) => i.level === 'A' || i.level === 'B') };
}

/** 一行摘要，供任务报告。 */
export function bindingSummary(shot, issues) {
  if (!issues.length) return '';
  return '第' + shot.idx + '镜缺绑：' + issues.map((i) => i.level + '·' + i.detail).join('；');
}
