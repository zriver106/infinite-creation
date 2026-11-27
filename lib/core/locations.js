// 项目级地点表（adapt J-004 / J-010 第 2a 条；Andy 11-26「金店场景都换了好几个，原著也没有去这么多数量的金店」）。
// 一个地点全剧只认一个地点 ID：地点名（全剧唯一写法）｜生命周期首末章｜内外景、门口、昼夜等变体｜对应的场景资产 ID。
// 剧本场头锁定的「地点」、分镜的场景名、绑定，都只用这张表里的名字和资产。拿不准是不是同一个地方的，进「存疑」，由负责人拍板。
// 存储：<项目目录>/locations.json；每次覆盖前旧版追加进 locations_history.jsonl。
import { normBaseRef } from './reference-assets.js';
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';

const FILE = 'locations.json';
const HISTORY = 'locations_history.jsonl';
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const int = (v) => { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();

/** 校验并规整；有错返回 errors（id / 名字为空或重复、首末章颠倒）。 */
export function normalizeLocations(input) {
  const errors = [];
  const rows = list(input && input.rows).map((r, i) => {
    const o = r && typeof r === 'object' ? r : {};
    const row = {
      id: String(o.id || '').trim(),
      name: String(o.name || '').trim(),
      aliases: list(o.aliases).map((x) => String(x).trim()).filter(Boolean),
      first_chapter: int(o.first_chapter),
      last_chapter: int(o.last_chapter),
      kind: String(o.kind || '').trim(),
      variants: list(o.variants).filter((v) => v && typeof v === 'object').map((v) => ({ name: String(v.name || '').trim(), asset_id: String(v.asset_id || '').trim(), note: String(v.note || '').trim(), ...(normBaseRef(v.base_ref) ? { base_ref: normBaseRef(v.base_ref) } : {}) })).filter((v) => v.name || v.asset_id),
      asset_ids: list(o.asset_ids).map((x) => String(x).trim()).filter(Boolean),
      note: String(o.note || '').trim(),
    };
    if (!row.id) errors.push('第' + (i + 1) + '行缺地点 ID');
    if (!row.name) errors.push('第' + (i + 1) + '行缺地点名');
    if (row.first_chapter && row.last_chapter && row.first_chapter > row.last_chapter) errors.push(row.name + '：首章 ' + row.first_chapter + ' 晚于末章 ' + row.last_chapter);
    return row;
  });
  const dup = (key) => { const seen = new Set(); for (const r of rows) { const k = key(r); if (!k) continue; if (seen.has(k)) errors.push('重复：' + k); seen.add(k); } };
  dup((r) => r.id); dup((r) => r.name);
  const doubts = list(input && input.doubts).map((d) => (typeof d === 'string' ? { question: d } : { question: String((d && d.question) || '').trim(), chapters: list(d && d.chapters).map(String), options: list(d && d.options).map(String), decided: String((d && d.decided) || '') })).filter((d) => d.question);
  return { rows, doubts, errors };
}

export function getLocations(projectId) {
  try { const f = path.join(projectDir(projectId), FILE); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { rows: [], doubts: [] }; } catch { return { rows: [], doubts: [] }; }
}

export function saveLocations(projectId, input, meta = {}) {
  const n = normalizeLocations(input);
  if (n.errors.length) throw Object.assign(new Error('地点表有误：' + n.errors.slice(0, 10).join('；')), { code: 'BAD_LOCATIONS', errors: n.errors });
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const old = getLocations(projectId);
  if ((old.rows || []).length || (old.doubts || []).length) fs.appendFileSync(path.join(dir, HISTORY), JSON.stringify({ ts: Date.now(), replaced_by: meta.source || '', job_id: meta.job_id || '', old }) + '\n');
  const doc = { version: 1, updated_at: Date.now(), source: meta.source || '', job_id: meta.job_id || '', rows: n.rows, doubts: n.doubts };
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(doc, null, 2));
  return doc;
}

/** 名字（场头锁定的地点、分镜场景名、资产名）对应的地点：先全名 / 别名相等，再看名字里含地点名（取最长的）。 */
export function locationForName(table, name) {
  const rows = (table && table.rows) || [];
  const n = norm(String(name || '').replace(/^【[^】]*】/, '').replace(/^S\d+(_MV)?[·・_ ]*/i, '').replace(/[·・]?多视角定义图$/, ''));
  if (!n) return null;
  const exact = rows.find((r) => norm(r.name) === n || r.aliases.some((a) => norm(a) === n));
  if (exact) return exact;
  let best = null; let len = 0;
  for (const r of rows) for (const k of [r.name, ...r.aliases]) { const kn = norm(k); if (kn.length >= 2 && n.includes(kn) && kn.length > len) { best = r; len = kn.length; } }
  return best;
}

/** 资产登记在哪个地点下（asset_ids 或变体里的 asset_id）。 */
export function locationOfAsset(table, assetId) {
  const id = String(assetId || '');
  if (!id) return null;
  return ((table && table.rows) || []).find((r) => r.asset_ids.includes(id) || r.variants.some((v) => v.asset_id === id)) || null;
}

/** 地点下登记的全部资产 ID。 */
export function locationAssetIds(row) {
  if (!row) return [];
  return [...new Set([...(row.asset_ids || []), ...(row.variants || []).map((v) => v.asset_id).filter(Boolean)])];
}
