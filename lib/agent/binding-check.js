// 出片口缺绑检查（2026-11-25，主会话 seq1425/1431/1433 口径）：只读，不自动补绑。
// 逐镜查三样：画面里的每个人物绑了本人服装；scene_ids 不为空；多人镜绑了该地点的多视角定义图（_MV）。
// 分级：
//   A 缺场景：scene_ids 为空。
//   B 真漏绑：资产库里该人物有服装资产，这一镜却没绑；或该地点有 _MV 资产，多人镜没绑。→ 由我方 Agent 用 PATCH /shots/:sid 补。
//   C 没资产可绑：该人物没有任何服装资产；或多人镜所在地点没有 _MV。→ 列进资产缺口单交 Muse 补图。
// 缺项总是上报；只有 generation.bindingCheckBlock=true 时才对 A、B 拦截该镜（缺省 false，只报不拦）。
// 基础形象豁免（2026-11-25，主会话 seq1541）：服装状态轨迹表定这一段该人物用基础形象（BASE）的，
// 不绑服装是对的，不报 B、也不报 C。豁免段存项目 context.costume_base（由我方 Agent 按轨迹表写，
// PUT /api/projects/:id/asset-settings { costume_base: [...] }），每条 { character_id, chapter, from, to, note }：
//   character_id 可写完整 id 或开头 8 位；chapter 写「第3章」或 3；from/to 是镜号（含两端），不写 = 全章。
import { Assets, Projects } from '../core/index.js';

export const COSTUME_BASE_KEY = 'costume_base';

function chapterNo(c) { const m = String(c == null ? '' : c).match(/\d+/); return m ? Number(m[0]) : NaN; }

/** 校验并规整豁免段；不合格的条目丢掉并在 errors 里说明。 */
export function normalizeCostumeBase(list) {
  const out = []; const errors = [];
  if (!Array.isArray(list)) return { out, errors: ['costume_base 要是数组'] };
  list.forEach((r, i) => {
    const cid = String((r && r.character_id) || '').trim().toLowerCase();
    const ch = chapterNo(r && r.chapter);
    const from = r && r.from != null && r.from !== '' ? Number(r.from) : null;
    const to = r && r.to != null && r.to !== '' ? Number(r.to) : null;
    if (cid.length < 8) { errors.push('第' + (i + 1) + '条 character_id 至少 8 位'); return; }
    if (!Number.isInteger(ch)) { errors.push('第' + (i + 1) + '条 chapter 不对'); return; }
    if ((from != null && !Number.isInteger(from)) || (to != null && !Number.isInteger(to)) || (from != null && to != null && from > to)) { errors.push('第' + (i + 1) + '条 from/to 不对'); return; }
    out.push({ character_id: cid, chapter: ch, from, to, note: String((r && r.note) || '').slice(0, 200) });
  });
  return { out, errors };
}

/** 这一镜里这个人物是否在基础形象豁免段内。 */
export function inCostumeBase(ranges, characterId, shot) {
  if (!ranges || !ranges.length) return false;
  const cid = String(characterId || '').toLowerCase();
  const ch = chapterNo(shot.chapter);
  const idx = Number(shot.idx);
  return ranges.some((r) => cid.startsWith(String(r.character_id || '').toLowerCase())
    && chapterNo(r.chapter) === ch
    && (r.from == null || idx >= r.from) && (r.to == null || idx <= r.to));
}

function costumeBaseOf(projectId) {
  try { const p = Projects.get(projectId); const v = p && p.context && p.context[COSTUME_BASE_KEY]; return Array.isArray(v) ? v : []; } catch { return []; }
}

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
export function checkShotBindings(shot, { assets, projectId, costumeBase } = {}) {
  const list = assets || Assets.list(projectId || shot.project_id);
  const baseRanges = costumeBase || costumeBaseOf(projectId || shot.project_id);
  const byId = new Map(list.map((a) => [a.id, a]));
  const issues = [];
  const charIds = (shot.character_ids || []).filter((id) => byId.get(id) && byId.get(id).category === 'character');
  const sceneIds = (shot.scene_ids || []).filter((id) => byId.has(id));
  const costumeIds = new Set(shot.costume_ids || []);

  if (!sceneIds.length) issues.push({ level: 'A', kind: 'scene', detail: '没绑场景（scene_ids 为空）' });

  // 每个人物：有服装资产却没绑 → B；没有任何服装资产 → C
  for (const cid of charIds) {
    const ch = byId.get(cid);
    if (inCostumeBase(baseRanges, cid, shot)) continue; // 轨迹表定用基础形象：不绑服装是对的
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
