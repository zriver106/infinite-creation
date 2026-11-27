// 合并缺图单（站位会话 V3 资产打分，总导 11-26）：每次资产分析（含局部重跑）都并进同一份完整缺图单，
// 同名同类的行用新的替换；要作废的旧行标「作废」并写原因，不留互相冲突的两行。
// 覆盖检查：写了戏份说明的资产（scene_notes 的每个 key）都要在缺图单里——要出图的写要画什么，不出图的写 need_image:false 和原因。
// 存储：<项目>/asset_gaps/gaps.json（结构化）+ 当前缺图单.md（给人看 / 派 am）；每次合并前旧版存 gaps_history.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';
import { listSceneNotes } from './scene-notes.js';

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
    map.set(x.key, x);
  }
  const voided = [];
  for (const v of voids || []) {
    if (!v || !String(v.name || '').trim()) continue;
    const hit = [...map.values()].filter((x) => norm(x.name) === norm(v.name) && (!v.kind || norm(x.kind) === norm(v.kind)) && x.status !== 'void');
    for (const x of hit) { x.status = 'void'; x.void_reason = String(v.reason || '').trim() || '作废'; x.updated_by_job = meta.job_id || ''; x.updated_at = now; voided.push(x.name); }
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
  return { missing: notes.map((n) => n.key).filter((k) => !has(k)), notes: notes.length };
}

/** 渲染给人看 / 派 am 的完整缺图单 md。 */
export function renderGapListMd(doc, { title = '', j009 = '' } = {}) {
  const items = doc.items || [];
  const active = items.filter((x) => x.status !== 'void');
  const need = active.filter((x) => x.need_image !== false);
  const noNeed = active.filter((x) => x.need_image === false);
  const voids = items.filter((x) => x.status === 'void');
  const row = (x, i) => '| ' + (i + 1) + ' | ' + x.kind + ' | ' + x.name + ' | ' + (x.location_id || '') + ' | ' + (x.note_key || '') + ' | ' + String(x.requirement || '').replace(/\n/g, ' ') + ' |';
  return [
    '# 当前缺图单' + (title ? '（' + title + '）' : ''), '', '更新：' + new Date(doc.updated_at || Date.now()).toISOString() + (doc.job_id ? '，资产分析任务 ' + String(doc.job_id).slice(0, 8) : ''), '',
    '## 要出图（' + need.length + ' 项）', '', '| # | 类别 | 名称 | 地点 ID | 戏份说明 | 要画什么 |', '|---|---|---|---|---|---|', ...need.map(row), '',
    ...(noNeed.length ? ['## 不出图（' + noNeed.length + ' 项，写了戏份说明但这次不出图）', '', '| # | 类别 | 名称 | 原因 |', '|---|---|---|---|', ...noNeed.map((x, i) => '| ' + (i + 1) + ' | ' + x.kind + ' | ' + x.name + ' | ' + (x.reason || '') + ' |'), ''] : []),
    ...(voids.length ? ['## 已作废（' + voids.length + ' 项，不要再按这些出图）', '', '| 类别 | 名称 | 作废原因 |', '|---|---|---|', ...voids.map((x) => '| ' + x.kind + ' | ' + x.name + ' | ' + (x.void_reason || '') + ' |'), ''] : []),
    '---', '', '## 出图与验收标准（adapt J-009 原文）', '', j009 || '（没读到 J-009 原文）',
  ].join('\n');
}
