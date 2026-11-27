// 出片口缺绑检查（2026-11-25，主会话 seq1425/1431/1433 口径）：只读，不自动补绑。
// 逐镜查三样：画面里的每个人物绑了本人服装；scene_ids 不为空；多人镜绑了该地点的多视角定义图（_MV）。
// 分级：
//   A 缺场景：scene_ids 为空。
//   B 真漏绑：资产库里该人物有服装资产，这一镜却没绑；或该地点有 _MV 资产，多人镜没绑。→ 由我方 Agent 用 PATCH /shots/:sid 补。
//   C 没资产可绑：该人物没有任何服装资产；或多人镜所在地点没有 _MV。→ 列进资产缺口单交 Muse 补图。
//   W 警告（2026-11-26 主会话 seq2227 第5件，只报不拦）：一地两套场景资产；同场在场人物漏绑（本镜画面/台词里写到了却没绑）；
//     资产不合标准（人物 / 服装图不是横版「左 1/3 脸特写 + 右 2/3 全身三视图」设定板）；多人镜地点有 _MV、但名字没认出来（按资产号 Sxxx 才对上）没绑。
// 缺项总是上报；只有 generation.bindingCheckBlock=true 时才对 A、B 拦截该镜（缺省 false，只报不拦）。W 永不拦。
// 基础形象豁免（2026-11-25，主会话 seq1541）：服装状态轨迹表定这一段该人物用基础形象（BASE）的，
// 不绑服装是对的，不报 B、也不报 C。豁免段存项目 context.costume_base（由我方 Agent 按轨迹表写，
// PUT /api/projects/:id/asset-settings { costume_base: [...] }），每条 { character_id, chapter, from, to, note }：
//   character_id 可写完整 id 或开头 8 位；chapter 写「第3章」或 3；from/to 是镜号（含两端），不写 = 全章。
import fs from 'node:fs';
import { Assets, Projects, Shots, resolveProjectPath } from '../core/index.js';
import { dialogueVoiceSpeakers } from '../core/prompts.js';
import { getLocations, locationForName, locationOfAsset, locationAssetIds } from '../core/locations.js';
import { nameMatches } from '../shared/index.js';

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

// 资产号（描述里「我方资产ID：S095」或名字开头「S095·」）：名字对不上时按它把场景和 _MV 对上（奥迪4S店展厅 S095 ↔ 奥迪展厅·前区 S095_MV）
function sceneCode(a) {
  const m = /我方资产ID[：:]\s*(S\d+)/i.exec(String((a && a.description) || '')) || /^(S\d+)(?:_MV)?[·・_ ]/i.exec(String((a && a.name) || ''));
  return m ? m[1].toUpperCase() : '';
}
/** 宽松匹配：先按地名（findMvForScene），对不上再按资产号。站位表、同场判断用它；缺绑 B 仍只按地名（不因这次改动多拦）。 */
export function findMvForSceneLoose(scene, mvAssets) {
  const byName = findMvForScene(scene, mvAssets);
  if (byName) return byName;
  const code = sceneCode(scene);
  return code ? (mvAssets.find((m) => sceneCode(m) === code) || null) : null;
}

/** 一镜的地点键：绑定场景对应的 _MV id，否则场景的地点名，再否则 scene_name。 */
export function placeOf(shot, byId, mvs) {
  for (const id of shot.scene_ids || []) {
    const s = byId.get(id);
    if (!s) continue;
    const mv = findMvForSceneLoose(s, mvs);
    if (mv) return 'mv:' + mv.id;
    const k = placeKey(s.name);
    if (k) return 'place:' + k;
  }
  return shot.scene_name ? 'name:' + String(shot.scene_name).replace(/^【[^】]*】/, '').trim() : '';
}

// 图片宽高（只读文件头：png / jpg / webp）；读不出返回 null
const dimCache = new Map();
export function imageDims(abs) {
  if (!abs) return null;
  if (dimCache.has(abs)) return dimCache.get(abs);
  let d = null;
  try {
    const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    if (n > 24 && b.readUInt32BE(0) === 0x89504e47) d = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    else if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < n - 9) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) { d = { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; break; } i += 2 + b.readUInt16BE(i + 2); }
    } else if (n > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8X') d = { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      else if (t === 'VP8 ') d = { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      else if (t === 'VP8L') { const v = b.readUInt32LE(21); d = { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    }
  } catch { d = null; }
  if (dimCache.size > 5000) dimCache.clear();
  dimCache.set(abs, d);
  return d;
}
// 标准人物 / 服装设定板是横图（左 1/3 脸特写 + 右 2/3 全身三视图）；宽高比低于这个就报
export const SHEET_MIN_RATIO = 1.3;

/**
 * 查一镜的绑定。assets 可传入（批量时复用），否则按项目读。
 * 返回 { issues: [{ level:'A'|'B'|'C', kind, detail }], blocking: bool(按 A/B 有无) }。
 */
export function checkShotBindings(shot, { assets, projectId, costumeBase, narrative, warnings = true } = {}) {
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
      const loose = hit ? null : scenes.map((s) => findMvForSceneLoose(s, mvs)).find(Boolean);
      if (hit) issues.push({ level: 'B', kind: 'mv', detail: '多人镜地点「' + where + '」已有多视角图「' + hit.name + '」，这一镜没绑' });
      else if (loose) issues.push({ level: 'W', kind: 'mv_name', detail: '多人镜地点「' + where + '」有多视角图「' + loose.name + '」（资产号对得上、名字没认出来），这一镜没绑' });
      else issues.push({ level: 'C', kind: 'mv', detail: '多人镜地点「' + where + '」还没有多视角定义图（_MV），需 Muse 补图' });
    }
  }
  if (warnings) { try { issues.push(...bindingWarnings(shot, { list, byId, charIds, sceneIds, projectId: projectId || shot.project_id, narrative })); } catch { /* 警告出错不影响缺绑结论 */ } }
  return { issues, blocking: issues.some((i) => i.level === 'A' || i.level === 'B') };
}

/** W 警告（只报不拦）：一地两套场景资产、同场在场人物漏绑、人物 / 服装图不是标准设定板。 */
function bindingWarnings(shot, { list, byId, charIds, sceneIds, projectId, narrative }) {
  const out = [];
  const mvs = list.filter(isMvAsset);
  // ⓪ 地点表（J-004 / J-010 第 2a 条，有地点表时才查）：本镜场景名对应的地点 ID 下没有登记本镜绑的场景资产（绑了别的地点、或未登记的资产）；
  //   同一地点名下还有没登记的另一套场景资产
  const table = getLocations(projectId);
  if ((table.rows || []).length) {
    const loc = locationForName(table, shot.scene_name) || sceneIds.map((id) => locationOfAsset(table, id)).find(Boolean) || null;
    if (loc) {
      const reg = new Set(locationAssetIds(loc));
      for (const id of sceneIds) {
        const a = byId.get(id);
        if (!a || a.category !== 'scene' || reg.has(id)) continue;
        const other = locationOfAsset(table, id);
        out.push({ level: 'W', kind: 'loc_mismatch', detail: '本镜地点「' + loc.name + '」（' + loc.id + '）下没登记场景资产「' + a.name + '」' + (other ? '，它登记在地点「' + other.name + '」（' + other.id + '）' : '，它还没进地点表') });
      }
      const extra = list.filter((a) => a.category === 'scene' && !reg.has(a.id) && !locationOfAsset(table, a.id) && locationForName(table, a.name) === loc);
      if (extra.length) out.push({ level: 'W', kind: 'loc_unregistered', detail: '地点「' + loc.name + '」（' + loc.id + '）名下还有 ' + extra.length + ' 套没登记的场景资产（' + extra.map((a) => a.name).slice(0, 5).join('、') + '），一个地点只认一套：登记成变体或改绑' });
    }
  }
  // ① 一地两套：本镜绑的普通场景，库里还有同一地点（去掉资产号后全名相同，或资产号相同）的另一套普通场景（_MV 不算；「正泰百货」和「正泰百货·一楼出口厅」是不同区域，不算）
  const fullKey = (a) => String((a && a.name) || '').replace(/^S\d+[·・_ ]*/i, '').replace(/\s+/g, '').trim();
  for (const id of sceneIds) {
    const s = byId.get(id);
    if (!s || isMvAsset(s) || s.category !== 'scene') continue;
    const k = fullKey(s); const code = sceneCode(s);
    if (k.length < 2) continue;
    const twins = list.filter((a) => a.category === 'scene' && a.id !== s.id && !isMvAsset(a) && (fullKey(a) === k || (code && sceneCode(a) === code)));
    if (twins.length) out.push({ level: 'W', kind: 'scene_dup', detail: '地点「' + k + '」有 ' + (twins.length + 1) + ' 套场景资产（' + [s, ...twins].map((a) => a.name).join('、') + '），本镜绑的是「' + s.name + '」，同一地点各镜要用同一套' });
  }
  // ② 同场在场人物漏绑：同一地点连续几镜出现过的人物，本镜台词说话人或画面里写到了、却没绑
  const all = narrative || Shots.listInNarrativeOrder(projectId);
  const chList = all.filter((s) => s.chapter === shot.chapter);
  const i = chList.findIndex((s) => s.id === shot.id);
  const key = i >= 0 ? placeOf(shot, byId, mvs) : '';
  if (key) {
    let a = i; let b = i;
    while (a > 0 && placeOf(chList[a - 1], byId, mvs) === key) a--;
    while (b < chList.length - 1 && placeOf(chList[b + 1], byId, mvs) === key) b++;
    const bound = new Set(charIds);
    const cast = new Map();
    for (let k = a; k <= b; k++) for (const id of chList[k].character_ids || []) { const c = byId.get(id); if (c && c.category === 'character' && !bound.has(c.id)) cast.set(c.id, c); }
    const speakers = dialogueVoiceSpeakers(shot.dialogue || '').filter((sp) => !sp.kind).map((sp) => sp.name);
    // 画面里写到的：只算写他在画面里的小句（同一小句有「画外 / 不入镜 / 离开 / 背后」这类的不算）
    const OFF = /画外|不入镜|不入画|不在画面|画面外|出画|离开|已走|走后|背后|身后|门外|电话那头|回忆|想起/;
    const clauses = String(shot.visual || '').split(/[。；;！!？?\n]/);
    for (const c of cast.values()) {
      const speaks = speakers.some((n) => nameMatches(n, c.name));
      const seen = c.name.length >= 2 && clauses.some((t) => t.includes(c.name) && !OFF.test(t));
      if (speaks || seen) out.push({ level: 'W', kind: 'cast_unbound', detail: '同场人物「' + c.name + '」' + (speaks ? '在本镜说话' : '在本镜画面里写到了') + '，这一镜没绑' });
    }
  }
  // ③ 人物 / 服装图不是标准设定板（横版：左 1/3 脸特写 + 右 2/3 全身三视图）
  const costumeOf = new Map();
  for (const id of shot.costume_ids || []) { const c = byId.get(id); if (c && c.category === 'costume') costumeOf.set(c.parent_id, c); }
  for (const cid of charIds) {
    const ch = byId.get(cid);
    const img = costumeOf.get(cid) || ch;
    if (!img || !img.image_path) continue;
    const d = imageDims(resolveProjectPath(projectId, img.image_path));
    if (d && d.h > 0 && d.w / d.h < SHEET_MIN_RATIO) out.push({ level: 'W', kind: 'asset_sheet', detail: (img === ch ? '人物' : '服装') + '图「' + img.name + '」是 ' + d.w + '×' + d.h + '，不是标准设定板（横版：左 1/3 脸特写 + 右 2/3 全身三视图）' });
  }
  return out;
}

/** 一行摘要，供任务报告。 */
export function bindingSummary(shot, issues) {
  if (!issues.length) return '';
  return '第' + shot.idx + '镜缺绑：' + issues.map((i) => i.level + '·' + i.detail).join('；');
}

// 站位表（主会话 seq2215，Andy 11-26「人物的站位有很大的问题」「一致性 变来变去」）：
// 每个地点的站位写在该地点 _MV 场景资产的 description（D 平面：每人站/坐在哪、门窗家具在哪侧、多人镜从 A/B/C 哪个方向拍）。
// 写稿 brief 对本镜绑定的场景找对应 _MV，整段带上；单人镜没绑 _MV 但地点有的，也带上（同地点跨镜一致），标 bound:false。
const stripAdminDesc = (t) => String(t || '').replace(/^(?:\s*(?:我方资产ID|审核|挂在角色)[^；;]*[；;])+\s*/, '').trim();
export function sceneBlockingOf(shot, assets) {
  const list = assets || [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const mvs = list.filter(isMvAsset);
  const sceneIds = (shot.scene_ids || []).filter((id) => byId.has(id));
  const bound = new Set(sceneIds);
  const out = []; const seen = new Set();
  for (const id of sceneIds) {
    const s = byId.get(id);
    const mv = findMvForSceneLoose(s, mvs);
    if (!mv || seen.has(mv.id)) continue;
    seen.add(mv.id);
    const blocking = stripAdminDesc(mv.description);
    if (!blocking) continue;
    out.push({ place: placeKey(mv.name) || mv.name, mv_id: mv.id, mv_name: mv.name, bound: bound.has(mv.id), blocking });
  }
  return out;
}
