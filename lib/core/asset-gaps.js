// 合并缺图单（站位会话 V3 资产打分，总导 11-26）：每次资产分析（含局部重跑）都并进同一份完整缺图单，
// 同名同类的行用新的替换；要作废的旧行标「作废」并写原因，不留互相冲突的两行。
// 覆盖检查：写了戏份说明的资产（scene_notes 的每个 key）都要在缺图单里——要出图的写要画什么，不出图的写 need_image:false 和原因。
// 存储：<项目>/asset_gaps/gaps.json（结构化）+ 当前缺图单.md（给人看 / 派 am）；每次合并前旧版存 gaps_history.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';
import { listSceneNotes, getSceneNote, isRedirectNote } from './scene-notes.js';
import { Assets } from './db.js';
import { styleWithAnchor } from '../shared/index.js';
import { getLocations, saveLocations } from './locations.js';

const DIR = 'asset_gaps';
const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
export const gapKey = (x) => norm(x.kind) + '|' + norm(x.name);

export function getGapList(projectId) {
  try { const f = path.join(projectDir(projectId), DIR, 'gaps.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] }; } catch { return { items: [] }; }
}

/**
 * 合并一批缺图项：items 里同名同类的替换旧行（active）；voids 里点名的旧行标作废（写原因）。
 * @param {{ items?: object[], voids?: {name:string, kind?:string, reason?:string}[] }} input
 */
export function mergeGapList(projectId, { items = [], voids = [] } = {}, meta = {}) {
  const doc = getGapList(projectId);
  const map = new Map((doc.items || []).map((x) => [x.key || gapKey(x), x]));
  const now = Date.now();
  for (const raw of items) {
    if (!raw || !String(raw.name || '').trim()) continue;
    const x = {
      kind: String(raw.kind || '').trim(), name: String(raw.name).trim(), location_id: String(raw.location_id || '').trim(),
      note_key: String(raw.note_key || '').trim(), requirement: String(raw.requirement || '').trim(),
      need_image: raw.need_image !== false, reason: String(raw.reason || '').trim(),
      status: 'active', updated_by_job: meta.job_id || '', updated_at: now,
    };
    x.key = gapKey(x);
    // 同名同类替换旧行时，已建好的资产槽（asset_id 等）保留——资产 ID 不变，站位会话按它上传
    const prev = map.get(x.key);
    if (prev) for (const k of ['asset_id', 'parent_asset_id', 'base_image_from', 'base_image_asset_id']) if (prev[k] && !raw[k]) x[k] = prev[k];
    if (raw.asset_id) x.asset_id = String(raw.asset_id);
    map.set(x.key, x);
  }
  const voided = [];
  for (const v of voids || []) {
    if (!v || !String(v.name || '').trim()) continue;
    const hit = [...map.values()].filter((x) => norm(x.name) === norm(v.name) && (!v.kind || norm(x.kind) === norm(v.kind)) && x.status !== 'void');
    // J-011：被替代的行写「作废，由「新行」替代」
    const by = String(v.replaced_by || '').trim();
    for (const x of hit) { x.status = 'void'; x.void_reason = (by ? '作废，由「' + by + '」替代' : '作废') + (String(v.reason || '').trim() ? '：' + String(v.reason).trim() : ''); x.replaced_by = by; x.updated_by_job = meta.job_id || ''; x.updated_at = now; voided.push(x.name); }
  }
  const out = { updated_at: now, job_id: meta.job_id || '', items: [...map.values()] };
  const d = path.join(projectDir(projectId), DIR);
  fs.mkdirSync(d, { recursive: true });
  if ((doc.items || []).length) fs.appendFileSync(path.join(d, 'gaps_history.jsonl'), JSON.stringify({ ts: now, replaced_by_job: meta.job_id || '', old: doc }) + '\n');
  fs.writeFileSync(path.join(d, 'gaps.json'), JSON.stringify(out, null, 2));
  return { doc: out, voided };
}

/** 写了戏份说明、却不在缺图单（有效行）里的 key。按 note_key 或名字对上都算在。 */
export function gapCoverage(projectId, doc = getGapList(projectId)) {
  const active = (doc.items || []).filter((x) => x.status !== 'void');
  const has = (k) => active.some((x) => norm(x.note_key) === norm(k) || norm(x.name) === norm(k) || norm(x.location_id) === norm(k) || norm(x.name).includes(norm(k)));
  const notes = listSceneNotes(projectId);
  const redirect = (k) => isRedirectNote((getSceneNote(projectId, k) || {}).text);
  return { missing: notes.map((n) => n.key).filter((k) => !has(k) && !redirect(k)), notes: notes.length };
}

// —— 按缺图单建 IC 资产槽（总导 11-26：V3 资产导入）——
// 每条有效、要出图的行建一条资产（只建行，不出图）；服装 / 状态变体（「角色·…」）挂在角色下（costume，parent_id 指角色），
// 「系统」这类角色的光幕版式同理。同名同类（变体再加同一角色）且没归档的复用；已归档的不复用。行上写回 asset_id。
const SLOT_KIND = { character: 'character', scene: 'scene', prop: 'prop', costume: 'costume', age: 'age' };
export function slotPlanOf(row) {
  const kind = String(row.kind || '').trim().toLowerCase();
  const name = String(row.name || '').trim();
  const dot = name.indexOf('·');
  // 角色名·变体：服装 / 年龄，或人物类里带「·」的状态变体（如 系统·光幕A版）
  if ((kind === 'costume' || kind === 'age' || kind === 'character') && dot > 0) {
    return { category: kind === 'age' ? 'age' : 'costume', name, owner: name.slice(0, dot) };
  }
  if (kind === 'costume' || kind === 'age') return { error: '服装/年龄行要写成「角色名·…」才知道挂在谁下面' };
  return { category: SLOT_KIND[kind] || 'other', name, owner: '' };
}

export function createAssetSlots(projectId, { archivedIds = [], jobId = '' } = {}) {
  const doc = getGapList(projectId);
  const arch = new Set(archivedIds);
  const live = () => Assets.list(projectId).filter((a) => !arch.has(a.id));
  const find = (category, name, parent = '') => live().find((a) => a.category === category && norm(a.name) === norm(name) && String(a.parent_id || '') === parent);
  const noteText = (k) => { const t = (getSceneNote(projectId, k) || {}).text || ''; return isRedirectNote(t) ? '' : t; };
  const created = []; const reused = []; const skipped = []; const firstChild = new Map(); const parentRows = [];
  const ensure = (category, name, description, parent = '') => {
    const hit = find(category, name, parent);
    if (hit) { if (!reused.some((r) => r.asset_id === hit.id)) reused.push({ name, category, asset_id: hit.id }); return hit.id; }
    const a = Assets.create(projectId, { category, name, description: String(description || '').slice(0, 4000), parent_id: parent });
    created.push({ name, category, asset_id: a.id, ...(parent ? { parent_id: parent } : {}) });
    return a.id;
  };
  for (const row of doc.items || []) {
    if (row.status === 'void') continue;
    if (row.need_image === false) { skipped.push({ name: row.name, reason: '不出图：' + (row.reason || '') }); continue; }
    const plan = slotPlanOf(row);
    if (plan.error) { skipped.push({ name: row.name, reason: plan.error }); continue; }
    const desc = [row.requirement, row.note_key ? '戏份说明：' + row.note_key : ''].filter(Boolean).join('\n');
    let parent = '';
    if (plan.owner) parent = ensure('character', plan.owner, noteText(plan.owner).slice(0, 4000) || ('角色「' + plan.owner + '」（由缺图单「' + row.name + '」建槽）'));
    row.asset_id = ensure(plan.category, plan.name, desc, parent);
    if (parent) { row.parent_asset_id = parent; if (!firstChild.has(parent)) firstChild.set(parent, { owner: plan.owner, child: row.name, child_id: row.asset_id }); }
  }
  // 父角色行（总导 11-26）：服装 / 光幕版式挂在角色下时，角色本身也进缺图单——不单独出图，基础形象就是它的第一张服装板（或光幕 A 版），
  // 免得父行没图被当缺图。已有有效的同名人物行就不加。
  for (const [pid, f] of firstChild) {
    const has = (doc.items || []).some((x) => x.status !== 'void' && norm(x.kind) === 'character' && norm(x.name) === norm(f.owner));
    if (has) continue;
    const r = { kind: 'character', name: f.owner, location_id: '', note_key: f.owner, asset_id: pid, need_image: false, base_image_from: f.child, base_image_asset_id: f.child_id,
      requirement: '基础形象＝「' + f.child + '」', reason: '基础形象＝「' + f.child + '」：不单独出图，用这张图', status: 'active', updated_by_job: jobId, updated_at: Date.now() };
    r.key = gapKey(r);
    doc.items.push(r); parentRows.push(f.owner);
  }
  const d = path.join(projectDir(projectId), DIR);
  fs.mkdirSync(d, { recursive: true });
  const out = { ...doc, updated_at: Date.now(), slots_job_id: jobId };
  fs.writeFileSync(path.join(d, 'gaps.json'), JSON.stringify(out, null, 2));
  // 地点表变体名对上的，也写上 asset_id（绑定、站位按它找）
  let locFilled = 0;
  try {
    const loc = getLocations(projectId);
    const byName = new Map((out.items || []).filter((x) => x.asset_id && x.status !== 'void').map((x) => [norm(x.name), x.asset_id]));
    for (const r of loc.rows || []) for (const v of r.variants || []) { const id = byName.get(norm(v.name)); if (id && v.asset_id !== id) { v.asset_id = id; locFilled++; } }
    if (locFilled) saveLocations(projectId, loc, { source: 'asset-slots', job_id: jobId });
  } catch { /* 地点表写不进去不影响建槽 */ }
  return { doc: out, created, reused, skipped, parent_rows: parentRows, location_variants_filled: locFilled };
}

/** 渲染给人看 / 派 am 的完整缺图单 md。 */
export function renderGapListMd(doc, { title = '', j009 = '', style = '' } = {}) {
  const items = doc.items || [];
  const active = items.filter((x) => x.status !== 'void');
  const need = active.filter((x) => x.need_image !== false);
  const noNeed = active.filter((x) => x.need_image === false);
  const voids = items.filter((x) => x.status === 'void');
  const row = (x, i) => '| ' + (i + 1) + ' | ' + x.kind + ' | ' + x.name + ' | ' + (x.asset_id || '') + ' | ' + (x.location_id || '') + ' | ' + (x.note_key || '') + ' | ' + String(x.requirement || '').replace(/\n/g, ' ') + ' |';
  return [
    '# 当前缺图单' + (title ? '（' + title + '）' : ''), '', '更新：' + new Date(doc.updated_at || Date.now()).toISOString() + (doc.job_id ? '，资产分析任务 ' + String(doc.job_id).slice(0, 8) : ''), '',
    // 画风（派单照抄这一段，不抄项目风格名——风格名里的「动漫」会把图往二次元推，11-26 Andy 连退场景图）
    ...(style ? ['## 画风（派单照抄这一段，不要抄项目风格名）', '', '- 场景：' + styleWithAnchor(style, 'scene'), '- 人物 / 服装：' + styleWithAnchor(style, 'character'), '- 道具：' + styleWithAnchor(style, 'prop'), ''] : []),
    '## 要出图（' + need.length + ' 项）', '', '| # | 类别 | 名称 | 资产 ID | 地点 ID | 戏份说明 | 要画什么 |', '|---|---|---|---|---|---|---|', ...need.map(row), '',
    ...(noNeed.length ? ['## 不出图（' + noNeed.length + ' 项，写了戏份说明但这次不出图）', '', '| # | 类别 | 名称 | 原因 |', '|---|---|---|---|', ...noNeed.map((x, i) => '| ' + (i + 1) + ' | ' + x.kind + ' | ' + x.name + ' | ' + (x.reason || '') + ' |'), ''] : []),
    ...(voids.length ? ['## 已作废（' + voids.length + ' 项，不要再按这些出图）', '', '| 类别 | 名称 | 作废原因 |', '|---|---|---|', ...voids.map((x) => '| ' + x.kind + ' | ' + x.name + ' | ' + (x.void_reason || '') + ' |'), ''] : []),
    '---', '', '## 出图与验收标准（adapt J-009 原文）', '', j009 || '（没读到 J-009 原文）',
  ].join('\n');
}
