// 剧本人名 / 地点名 ↔ 资产名对齐（总导 11-26：剧本和资产都跑完后，资产分析固定做一次；对不上的以剧本叫法为准改资产名，
// 剧本叫法不规范或重名时列存疑）。这里只做比对和改名的底层：比对纯读；改名保留 asset_id，缺图单 / 地点表变体 / 服装子变体前缀同步。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';
import { Assets, Chapters } from './db.js';
import { getGapList, gapKey, renderGapListMd } from './asset-gaps.js';
import { getLocations, saveLocations } from './locations.js';

const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
// 「名字：台词」「名字（情绪）：台词」；列表、表格、标题、[画面] 行不算
const SPEAKER_RE = /^([^\[【\s：:（(|#*>\-]{1,16})(?:[（(][^）)]*[）)])?[：:]/;
const NOT_SPEAKERS = new Set(['出场人物', '画面', '情绪', '音效', '字幕', '镜头', '旁白', '表现点', '台词升级', '备注', '注', '地点', '方式', '切前', '切后', '背景', '服装', '人群', '跨章接续', '在场', '站位', '状态', '时间', '光色', '声音', '要求', '依据', '人数', '场景阶段', '注意', '表演说明', '衔接', '原著', '说明', '结论', '缺图提示', '自检', '依据原文', '背景人数', '道具', '机位', '运镜']);
const SCENE_HEAD_RE = /^#*\s*【第(\d+)场[｜|][^｜|】]*[｜|]([^】]+)】/;
const CAST_RE = /^[-*\s]*(?:在场|出场人物)[：:](.+)$/;

/** 从一章剧本里取：说话人（次数、首行）、各场「在场」原文、场头地点。 */
export function scriptNamesOf(script) {
  const speakers = new Map(); const cast = []; const places = new Map();
  String(script || '').split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim(); if (!l) return;
    let m = l.match(SCENE_HEAD_RE);
    if (m) { const p = m[2].trim(); places.set(p, (places.get(p) || 0) + 1); return; }
    m = l.match(CAST_RE);
    if (m) { if (m[1].trim()) cast.push(m[1].trim().slice(0, 200)); return; }
    m = l.match(SPEAKER_RE);
    if (!m) return;
    const n = m[1].trim().replace(/[（(](OS|os|心声|电话|画外)[）)]$/, '');
    if (!n || NOT_SPEAKERS.has(n) || /^\d/.test(n)) return;
    const s = speakers.get(n) || { name: n, count: 0, first_line: i + 1, sample: l.slice(0, 40) };
    s.count++; speakers.set(n, s);
  });
  return { speakers: [...speakers.values()], cast, places: [...places.entries()].map(([name, scenes]) => ({ name, scenes })) };
}

/** 比对：剧本里的说话人 / 在场人物 / 场头地点，和资产库（未归档）人物、地点表地点名。 */
export function nameAlignment(projectId, { chapters = null, archivedIds = [] } = {}) {
  const arch = new Set(archivedIds);
  const live = Assets.list(projectId).filter((a) => !arch.has(a.id));
  const chars = live.filter((a) => a.category === 'character');
  const charNames = new Set(chars.map((a) => norm(a.name)));
  const loc = getLocations(projectId);
  const placeNames = new Set((loc.rows || []).flatMap((r) => [r.name, ...(r.aliases || [])]).map(norm));
  const noOf = (c) => { const m = String(c.title || '').match(/第s*(d+)s*章/); return m ? Number(m[1]) : Number(c.seq) || 0; };
  const chs = Chapters.list(projectId).filter((c) => String(c.script || '').trim()).map((c) => ({ c, no: noOf(c) }))
    .filter(({ no }) => !chapters || (no >= chapters[0] && no <= chapters[1]));
  const perChapter = []; const seen = new Set(); const castText = [];
  for (const { c, no } of chs) {
    const r = scriptNamesOf(c.script);
    r.speakers.forEach((s) => seen.add(norm(s.name)));
    castText.push(...r.cast);
    perChapter.push({
      chapter: no, title: c.title,
      speakers_not_in_assets: r.speakers.filter((s) => !charNames.has(norm(s.name))),
      places_not_in_location_table: r.places.filter((p) => ![...placeNames].some((n) => norm(p.name).includes(n) || n.includes(norm(p.name)))),
      cast_lines: r.cast.slice(0, 40),
    });
  }
  const allCast = norm(castText.join('、'));
  const assetsNotInScripts = chars.filter((a) => !seen.has(norm(a.name)) && !allCast.includes(norm(a.name)))
    .map((a) => ({ asset_id: a.id, name: a.name }));
  return { chapters: perChapter, character_assets: chars.map((a) => ({ asset_id: a.id, name: a.name })), character_assets_not_in_scripts: assetsNotInScripts };
}

/** 改资产名（asset_id 不变）：子变体名前缀、缺图单行、地点表变体名同步；记 asset_gaps/rename_log.jsonl。 */
export function renameAsset(projectId, assetId, newName, { reason = '', jobId = '', j009 = '' } = {}) {
  const a = Assets.get(assetId);
  if (!a || a.project_id !== projectId) throw Object.assign(new Error('资产不在本项目：' + assetId), { code: 'NO_ASSET' });
  const to = String(newName || '').trim();
  if (!to) throw Object.assign(new Error('新名字为空'), { code: 'BAD_NAME' });
  const from = a.name;
  if (from === to) return { asset_id: assetId, from, to, changed: [] };
  const clash = Assets.list(projectId).find((x) => x.id !== assetId && x.category === a.category && norm(x.name) === norm(to) && String(x.parent_id || '') === String(a.parent_id || ''));
  if (clash) throw Object.assign(new Error('同类已有同名资产「' + clash.name + '」（' + clash.id + '），列存疑，不要改成重名'), { code: 'NAME_CLASH' });
  const changed = [{ asset_id: assetId, from, to }];
  Assets.update(assetId, { name: to });
  // 人物改名：挂在它下面的服装 / 年龄变体「旧名·…」改成「新名·…」
  if (a.category === 'character') {
    for (const k of Assets.list(projectId).filter((x) => x.parent_id === assetId && x.name.startsWith(from + '·'))) {
      const nn = to + k.name.slice(from.length);
      Assets.update(k.id, { name: nn }); changed.push({ asset_id: k.id, from: k.name, to: nn });
    }
  }
  const map = new Map(changed.map((x) => [x.asset_id, x]));
  // 缺图单：按 asset_id 改名，主键跟着换
  const doc = getGapList(projectId); let rows = 0;
  for (const it of doc.items || []) {
    const hit = map.get(it.asset_id) || ((it.status !== 'void' && norm(it.name) === norm(from)) ? map.get(assetId) : null);
    if (hit && it.name !== hit.to) { it.name = hit.to; it.key = gapKey(it); rows++; }
  }
  const d = path.join(projectDir(projectId), 'asset_gaps');
  fs.mkdirSync(d, { recursive: true });
  if (rows) {
    fs.writeFileSync(path.join(d, 'gaps.json'), JSON.stringify({ ...doc, updated_at: Date.now() }, null, 2));
    fs.writeFileSync(path.join(d, '当前缺图单.md'), renderGapListMd(doc, { title: '资产改名同步', j009 }));
  }
  // 地点表变体
  let vars = 0;
  try {
    const loc = getLocations(projectId);
    for (const r of loc.rows || []) for (const v of r.variants || []) { const hit = map.get(v.asset_id) || (norm(v.name) === norm(from) ? map.get(assetId) : null); if (hit && v.name !== hit.to) { v.name = hit.to; vars++; } }
    if (vars) saveLocations(projectId, loc, { source: 'asset-rename', job_id: jobId });
  } catch { /* 地点表写不进去不影响改名 */ }
  fs.appendFileSync(path.join(d, 'rename_log.jsonl'), JSON.stringify({ ts: Date.now(), job_id: jobId, reason, changed, gap_rows: rows, location_variants: vars }) + '\n');
  return { asset_id: assetId, from, to, changed, gap_rows: rows, location_variants: vars };
}
