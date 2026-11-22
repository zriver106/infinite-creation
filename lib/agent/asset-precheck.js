// 开渲前资产检查（2026-11-17 Andy 定规矩：IC 生成的图尽量不用，有我方自制定稿的一律用我方的）。
//
// 时机（两处，同一个模块）：
//   - 起出片任务时（job-runner.startCreateJob，非 renderDisabled）：mode=list，只扫、只出清单、不换图。
//     /run 单章、续章守护、重启恢复、自动续章都经过这里。此时可能有别章正在渲染、且共用同一资产，
//     这时换图会让在跑那章的 ref-leak 对比集失准（第14章教训），所以起任务时只列不换。
//   - 真正开渲前（tools.js generate_chapter_videos，在一次性 prepare / 上传参考图之前；单镜 generate_shot_video 同理）：
//     mode=swap，按下面规则换图，换完再 prepare，本章就用我方图出片。
// 扫描范围：本章（或单镜）分镜引用的 character / scene / prop / costume / age 资产，只看 source=generated 的。
// 匹配（保守）：
//   1) 映射表（显式，只读 <asset_root>\资产\IC定稿映射.csv）：IC 资产 id → 我方定稿资产 id（同项目素材库里那条我方资产），可带定稿 sha256 锁定；
//      映射表的目标名/分类与库里对不上、定稿不是 final、sha 变了，一律不换、上清单。
//   2) 同分类、名称逐字相同（只去首尾空白，不做 normalizeName / 包含 / 模糊）且唯一的我方定稿资产。
//   其余（别名表提示、名称相近）只作为「可能对应」写进清单给总导 / 资产管理，不换。
// 我方定稿：source≠generated、status=done、有图且文件在、描述带「我方资产ID：X」；有资产表（asset_root\资产\assets.csv）
//   时要求该行 review=final，且有 sha.csv 时文件 sha256 与 sha.csv 一致；没有资产表时退回描述里「审核：final」。
// 换图做法与素材库 upload 路由一致：写新文件 assets/<子目录>/<名>_<8位uid><扩展名>，Assets.update(image_path, source=uploaded,
//   status=done)；之前先把旧图复制归档并核 hash，写新文件后核 sha == 定稿 sha，不一致就不改库（新文件留着，不删）。
//   资产有 asset:/voice: 活跃任务时（路由会 409）不换，上清单。不写 SQL、不删任何文件。
// 不挡出片：缺定稿只列清单 + 写日志，照常开渲（理由见报告）；检查自身出错也只记日志。
// 开关：环境变量 IC_ASSET_PRECHECK=off|list|swap 优先，其次 config.generation.assetPrecheck，缺省 swap。
//   只对 asset_mode=gap-list 的项目生效（与 asset-check 同口径），其他项目不动。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Projects, Shots, Assets, Queue, projectDir, resolveProjectPath, slugify, uid, logger, withWriteContext, loadConfig, DATA_DIR } from '../core/index.js';
import { PROJECT_ASSET_SUBDIRS, normalizeName } from '../shared/index.js';
import { readAssetCheckSettings, parseCsv, loadAliases } from './asset-check.js';

export const PRECHECK_SCHEMA = 'ic.asset-precheck/v1';
export const IMAGE_REF_FIELDS = [['character_ids', 'character'], ['scene_ids', 'scene'], ['prop_ids', 'prop'], ['costume_ids', 'costume'], ['age_ids', 'age']];
export const MAP_FILE_NAME = 'IC定稿映射.csv';
export const OUT_DIR_NAME = 'IC开渲前资产检查';
export const MAP_COLUMNS = ['target_id', 'target_name', 'category', 'final_asset_id', 'final_pid', 'final_name', 'final_sha256', 'basis', 'shot_id'];
const MODES = ['off', 'list', 'swap'];

// ---------------- 开关 ----------------
export function assetPrecheckMode(cfg, env = process.env) {
  const e = String((env && env.IC_ASSET_PRECHECK) || '').trim().toLowerCase();
  if (MODES.includes(e)) return e;
  const c = cfg && cfg.generation ? cfg.generation.assetPrecheck : undefined;
  if (c === false) return 'off';
  if (typeof c === 'string' && MODES.includes(c.toLowerCase())) return c.toLowerCase();
  return 'swap';
}

// ---------------- 小工具 ----------------
const readText = (f) => { try { return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
function csvObjects(text) {
  const rows = parseCsv(text).filter((r) => !String(r[0] || '').startsWith('#'));
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : String(r[i]).trim()])));
}
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCsv(rows, cols) { return '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n'; }

const shaCache = new Map(); // abs → { size, mtimeMs, sha }
export function sha256Of(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const c = shaCache.get(abs);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha;
    const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    shaCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, sha });
    return sha;
  } catch { return null; }
}
export function ourAssetId(a) { const m = /我方资产ID[：:]\s*([A-Za-z0-9_\-]+)/.exec(String((a && a.description) || '')); return m ? m[1] : ''; }
function reviewInDesc(a) { const m = /审核[：:]\s*([A-Za-z]+)/.exec(String((a && a.description) || '')); return m ? m[1].toLowerCase() : ''; }
function bigrams(s) { const t = normalizeName(s); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); if (t.length === 1) out.add(t); return out; }
export function nameSimilarity(a, b) {
  const x = normalizeName(a); const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 0.95;
  if (x.includes(y) || y.includes(x)) return 0.6 + 0.3 * Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const A = bigrams(x); const B = bigrams(y); let n = 0; for (const g of A) if (B.has(g)) n++;
  const u = A.size + B.size - n; return u ? n / u : 0;
}
function stamp(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function safeFile(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'chapter'; }

// ---------------- 映射表 ----------------
export function parseFinalMap(text, file = '') {
  const entries = []; const errors = []; const seen = new Set();
  if (text == null) return { exists: false, file, entries, errors };
  csvObjects(text).forEach((r, i) => {
    const target = String(r.target_id || '').trim(); const fin = String(r.final_asset_id || '').trim();
    const shotId = String(r.shot_id || '').trim();
    if (!target && !fin && !shotId) return;
    if (!target || !fin) { errors.push('第' + (i + 2) + '行缺 target_id 或 final_asset_id'); return; }
    const key = target + '\0' + shotId;
    if (seen.has(key)) {
      errors.push(shotId
        ? '第' + (i + 2) + '行 target_id + shot_id 重复：' + target + ' / ' + shotId + '（同一镜头只能映射一个定稿；重复的整条都不用）'
        : '第' + (i + 2) + '行 target_id 重复默认行：' + target + '（同一 IC 资产只能有一条默认映射；重复的整条都不用）');
      entries.forEach((e) => { if (e.target_id === target && e.shot_id === shotId) e.conflict = true; });
      return;
    }
    seen.add(key);
    entries.push({
      target_id: target, target_name: r.target_name || '', category: r.category || '', final_asset_id: fin,
      final_pid: r.final_pid || '', final_name: r.final_name || '', final_sha256: String(r.final_sha256 || '').toLowerCase(), basis: r.basis || '', shot_id: shotId, line: i + 2,
    });
  });
  return { exists: true, file, entries, errors };
}
/** r18 §2.14：shot_id 只认 IC 镜头 UUID。先精确匹配该 target 的覆盖行，否则用默认行（shot_id 为空），否则不替换。不把「章号#镜号」当作 shot_id。 */
export function resolveMapEntry(map, targetId, shotId) {
  const tid = String(targetId || '').trim();
  const sid = String(shotId || '').trim();
  const entries = (map && map.entries) || [];
  if (!tid) return { entry: null, conflict: false, kind: 'none' };
  if (sid) {
    const ov = entries.filter((e) => e.target_id === tid && e.shot_id === sid);
    if (ov.length) return { entry: ov[0], conflict: ov.length > 1 || ov.some((e) => e.conflict), kind: 'override' };
  }
  const def = entries.filter((e) => e.target_id === tid && !e.shot_id);
  if (def.length) return { entry: def[0], conflict: def.length > 1 || def.some((e) => e.conflict), kind: 'default' };
  return { entry: null, conflict: false, kind: 'none' };
}
// 映射表只认一个文件：<asset_root>\资产\IC定稿映射.csv（总导 2026-11-17 定：资产管理加行，IC 只读）。
// 没有 asset_root 或文件不存在 = 空表（只剩同名精确匹配）。
export function finalMapFiles(projectId, settings) {
  return settings && settings.root ? [path.join(settings.root, '资产', MAP_FILE_NAME)] : [];
}
export function loadFinalMap(projectId, settings) {
  for (const f of finalMapFiles(projectId, settings)) {
    const t = readText(f);
    if (t != null) return parseFinalMap(t, f);
  }
  return { exists: false, file: '', entries: [], errors: [] };
}

// ---------------- 资产表（我方定稿判定用）----------------
export function loadOurSheet(settings) {
  const root = settings && settings.root;
  if (!root) return null;
  const sheetText = readText(path.join(root, '资产', 'assets.csv'));
  if (sheetText == null) return null;
  const rows = new Map();
  for (const r of csvObjects(sheetText)) if (r.id) rows.set(r.id, { review: (r.review || '').toLowerCase(), file: r.file || '', name: r.name || '' });
  const shaText = readText(path.join(root, '资产', 'sha.csv'));
  const sha = new Map();
  if (shaText != null) for (const r of csvObjects(shaText)) if (r.file) sha.set(r.file, String(r.sha256 || '').toLowerCase());
  return { rows, sha: shaText != null ? sha : null };
}

// ---------------- 纯决策 ----------------
/**
 * 给定本章分镜 + 素材库 + 映射表，算出每个被引用的 IC 生成资产该换还是该列。纯函数（IO 由 deps 注入）。
 * deps.fileSha(rel) → sha|null；deps.busy(assetId) → 活跃任务 id|null；deps.sheet：loadOurSheet 结果或 null；deps.aliases：loadAliases 结果或 null。
 */
export function planAssetPrecheck({ chapter, shots, assets, map, deps }) {
  const fileSha = deps.fileSha; const busy = deps.busy || (() => null);
  const sheet = deps.sheet || null; const aliases = deps.aliases || null;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const refs = new Map(); // id → { idx:Set, fields:Set, shots:[{id, idx}] }
  for (const s of shots) {
    for (const [f] of IMAGE_REF_FIELDS) {
      for (const id of s[f] || []) {
        const r = refs.get(id) || { idx: new Set(), fields: new Set(), shots: [] };
        r.idx.add(s.idx); r.fields.add(f);
        if (s.id && !r.shots.some((x) => x.id === s.id)) r.shots.push({ id: s.id, idx: s.idx });
        refs.set(id, r);
      }
    }
  }
  const finalOf = (a) => {
    if (!a) return { ok: false, why: '定稿资产不存在' };
    if (a.source === 'generated') return { ok: false, why: '对应资产本身是 IC 生成（source=generated）' };
    if (a.status !== 'done' || !a.image_path) return { ok: false, why: '对应资产没有可用图（status=' + a.status + '）' };
    const sha = fileSha(a.image_path);
    if (!sha) return { ok: false, why: '对应资产图文件不存在：' + a.image_path };
    const pid = ourAssetId(a);
    if (!pid) return { ok: false, why: '对应资产描述里没有「我方资产ID」，不算我方定稿', sha };
    if (sheet) {
      const row = sheet.rows.get(pid);
      if (!row) return { ok: false, why: '资产表里找不到 ' + pid, sha, pid };
      if (row.review !== 'final') return { ok: false, why: pid + ' 在资产表里 review=' + (row.review || '空') + '，不是 final', sha, pid };
      if (sheet.sha && row.file) {
        const want = sheet.sha.get(row.file);
        if (want && want !== sha) return { ok: false, why: pid + ' 素材库图与资产表 sha.csv 不一致（库 ' + sha.slice(0, 12) + ' / 表 ' + want.slice(0, 12) + '）', sha, pid };
      }
    } else if (reviewInDesc(a) !== 'final') return { ok: false, why: '对应资产描述里审核不是 final', sha, pid };
    return { ok: true, sha, pid };
  };
  const finalBrief = (a, fo) => (a ? { asset_id: a.id, name: a.name, pid: (fo && fo.pid) || ourAssetId(a), image_path: a.image_path, sha256: (fo && fo.sha) || '' } : null);
  const ourFinals = assets.filter((a) => a.source !== 'generated' && a.image_path && ourAssetId(a));
  const suggest = (a) => {
    const out = [];
    if (aliases && aliases.icToSheet) {
      const alt = aliases.icToSheet.get(normalizeName(a.name));
      if (alt) for (const b of ourFinals) if (b.category === a.category && b.name === alt) out.push({ asset_id: b.id, name: b.name, pid: ourAssetId(b), score: 1, why: '别名表 ' + a.name + '→' + alt });
    }
    const scored = ourFinals.filter((b) => b.category === a.category && !out.some((o) => o.asset_id === b.id))
      .map((b) => ({ asset_id: b.id, name: b.name, pid: ourAssetId(b), score: Math.round(nameSimilarity(a.name, b.name) * 100) / 100, why: '名称相近' }))
      .filter((x) => x.score >= 0.2).sort((x, y) => y.score - x.score).slice(0, 3);
    return out.concat(scored);
  };
  const items = []; let nonGenerated = 0; let dangling = 0;
  const order = [...refs.entries()].sort((x, y) => Math.min(...x[1].idx) - Math.min(...y[1].idx));
  for (const [id, r] of order) {
    const a = byId.get(id);
    if (!a) { dangling++; continue; }
    if (!PROJECT_ASSET_SUBDIRS[a.category] || ['voice', 'music', 'sfx', 'other'].includes(a.category)) continue;
    if (a.source !== 'generated') { nonGenerated++; continue; }
    const curSha = a.image_path ? fileSha(a.image_path) : null;
    const base = { asset_id: a.id, name: a.name, category: a.category, image_path: a.image_path || '', cur_sha256: curSha || '', shots: [...r.idx].sort((x, y) => x - y) };
    const list = (code, reason, extra = {}) => items.push({ ...base, action: 'list', code, reason, ...extra, suggestions: extra.suggestions || suggest(a) });
    const replaceWith = (f, fo, basis, extra = {}) => {
      if (curSha && curSha === fo.sha) return items.push({ ...base, action: 'ok', code: 'same-bytes', reason: '现图字节已与我方定稿一致（只是 source 仍是 generated），不重复换', basis, final: finalBrief(f, fo), ...extra });
      const b = busy(a.id);
      if (b) return list('busy', '该资产有出图/音色任务 ' + String(b).slice(0, 8) + ' 在跑或排队（upload 路由会 409），本次不换', { basis, final: finalBrief(f, fo) });
      items.push({ ...base, action: 'replace', code: basis, reason: basis === 'mapping' ? '映射表第' + extra.line + '行' + (extra.mapBasis ? '（' + extra.mapBasis + '）' : '') : '同分类、名称逐字相同且唯一的我方定稿', basis, final: finalBrief(f, fo) });
    };
    const shotList = (r.shots && r.shots.length) ? r.shots : [...r.idx].sort((x, y) => x - y).map((idx) => ({ id: '', idx }));
    const resolved = shotList.map((sh) => {
      const rv = resolveMapEntry(map, a.id, sh.id);
      let key = 'none';
      if (rv.conflict) key = 'conflict';
      else if (rv.entry) key = 'map:' + [rv.entry.final_asset_id, rv.entry.final_pid, rv.entry.final_sha256, String(rv.entry.line)].join('|');
      return { sh, rv, key };
    });
    const keySet = new Set(resolved.map((x) => x.key));
    const hasMap = [...keySet].some((k) => k.startsWith('map:'));
    const hasConflict = keySet.has('conflict');
    const resolutionRows = () => resolved.map((x) => ({
      shot_id: x.sh.id, idx: x.sh.idx, kind: x.rv.kind, conflict: !!x.rv.conflict,
      final_pid: (x.rv.entry && x.rv.entry.final_pid) || '',
      final_asset_id: (x.rv.entry && x.rv.entry.final_asset_id) || '',
      final_sha256: (x.rv.entry && x.rv.entry.final_sha256) || '',
      line: x.rv.entry ? x.rv.entry.line : null,
    }));
    const applyMapped = (m) => {
      if (m.conflict) { list('mapping-conflict', '映射表里该资产出现多次，冲突，不换'); return; }
      if (m.category && m.category !== a.category) { list('mapping-stale', '映射表分类 ' + m.category + ' 与库里 ' + a.category + ' 不一致'); return; }
      if (m.target_name && m.target_name !== a.name) { list('mapping-stale', '映射表目标名「' + m.target_name + '」与库里「' + a.name + '」不一致（资产可能被改名），不换'); return; }
      const f = byId.get(m.final_asset_id);
      if (!f) { list('final-not-found', '映射表第' + m.line + '行的定稿资产 ' + m.final_asset_id + ' 不在本项目素材库'); return; }
      if (f.category !== a.category) { list('category-mismatch', '定稿资产分类 ' + f.category + ' 与目标 ' + a.category + ' 不同'); return; }
      const fo = finalOf(f);
      if (!fo.ok) { list('final-not-ready', '映射表第' + m.line + '行：' + fo.why, { final: finalBrief(f, fo) }); return; }
      if (m.final_pid && m.final_pid !== fo.pid) { list('final-pid-changed', '映射表记的我方 ID ' + m.final_pid + '，库里现在是 ' + fo.pid, { final: finalBrief(f, fo) }); return; }
      if (m.final_sha256 && m.final_sha256 !== fo.sha) { list('final-sha-changed', '定稿图 sha 已变（表 ' + m.final_sha256.slice(0, 12) + ' / 现 ' + fo.sha.slice(0, 12) + '），需人工确认后更新映射表', { final: finalBrief(f, fo) }); return; }
      replaceWith(f, fo, 'mapping', { line: m.line, mapBasis: m.basis });
    };
    if (hasConflict || hasMap) {
      if (keySet.size === 1 && hasMap) { applyMapped(resolved[0].rv.entry); continue; }
      if (hasConflict) { list('mapping-conflict', '映射表里该资产的默认行或镜头覆盖行冲突，不换', { resolutions: resolutionRows() }); continue; }
      list('mapping-per-shot', '同一资产在不同镜头映射到不同定稿（或仅部分镜头有覆盖），不能整条资产换图', { resolutions: resolutionRows() });
      continue;
    }
    const cands = assets.filter((b) => b.id !== a.id && b.category === a.category && String(b.name || '').trim() === String(a.name || '').trim() && b.source !== 'generated');
    if (cands.length) {
      const fins = cands.map((b) => ({ b, fo: finalOf(b) })).filter((x) => x.fo.ok);
      if (fins.length === 1) { replaceWith(fins[0].b, fins[0].fo, 'exact-name'); continue; }
      if (fins.length > 1) { list('ambiguous-exact-name', '同名我方定稿有 ' + fins.length + ' 个：' + fins.map((x) => x.fo.pid + '/' + x.b.id.slice(0, 8)).join('、') + '，不猜'); continue; }
      list('exact-name-not-final', '有同名资产但不是我方定稿：' + cands.map((b) => b.id.slice(0, 8) + '（' + finalOf(b).why + '）').join('；'));
      continue;
    }
    list('no-final', '映射表里没有、也没有同名我方定稿');
  }
  const summary = {
    referenced: refs.size, generated: items.length, non_generated: nonGenerated, dangling,
    replace: items.filter((x) => x.action === 'replace').length,
    list: items.filter((x) => x.action === 'list').length,
    ok: items.filter((x) => x.action === 'ok').length,
  };
  const digest = crypto.createHash('sha1').update(JSON.stringify(items.map((x) => [x.asset_id, x.action, x.code, x.cur_sha256, x.final && x.final.sha256]))).digest('hex').slice(0, 16);
  return { schema: PRECHECK_SCHEMA, chapter, items, summary, digest, map: { file: (map && map.file) || '', entries: ((map && map.entries) || []).length, errors: (map && map.errors) || [] } };
}

// ---------------- 换图（与 upload 路由同做法）----------------
function archiveDir(projectId, settings) {
  return settings && settings.root ? path.join(settings.root, '草稿', OUT_DIR_NAME, '旧图') : path.join(projectDir(projectId), 'asset-precheck', '旧图');
}
function archiveOld(projectId, settings, a, oldAbs, oldSha) {
  const dir = archiveDir(projectId, settings);
  fs.mkdirSync(dir, { recursive: true });
  const baseName = a.id.slice(0, 8) + '_' + path.basename(oldAbs);
  let dst = path.join(dir, baseName);
  for (let k = 2; fs.existsSync(dst); k++) {
    if (sha256Of(dst) === oldSha) return dst; // 已归档过同一张，复用
    dst = path.join(dir, baseName.replace(/(\.[^.]+)?$/, '_' + k + '$1'));
  }
  fs.copyFileSync(oldAbs, dst, fs.constants.COPYFILE_EXCL);
  if (sha256Of(dst) !== oldSha) throw new Error('旧图归档后 hash 不一致：' + dst);
  return dst;
}

export function executeReplace(projectId, settings, item, { now = new Date() } = {}) {
  const a = Assets.get(item.asset_id);
  if (!a) throw new Error('资产已不存在');
  if (a.source !== 'generated' || (a.image_path || '') !== item.image_path) return { skipped: true, reason: '检查后资产已被改动（source=' + a.source + '，image_path=' + a.image_path + '），本次不动' };
  const b = Queue.activeByDedupe('asset:' + a.id) || Queue.activeByDedupe('voice:' + a.id);
  if (b) return { skipped: true, reason: '资产有任务 ' + String(b.jobId || b.id).slice(0, 8) + ' 在跑或排队' };
  const f = Assets.get(item.final.asset_id);
  const finalAbs = f && resolveProjectPath(projectId, f.image_path);
  if (!finalAbs || f.image_path !== item.final.image_path) throw new Error('定稿资产图已变动，本次不换');
  const finalSha = sha256Of(finalAbs);
  if (finalSha !== item.final.sha256) throw new Error('定稿图 sha 与检查时不一致');
  let archived = '';
  const oldAbs = a.image_path ? resolveProjectPath(projectId, a.image_path) : null;
  const oldSha = oldAbs ? sha256Of(oldAbs) : null;
  if (oldAbs && oldSha) archived = archiveOld(projectId, settings, a, oldAbs, oldSha);
  const subdir = PROJECT_ASSET_SUBDIRS[a.category] || 'other';
  const ext = (path.extname(finalAbs) || '.png').toLowerCase();
  const rel = 'assets/' + subdir + '/' + slugify(a.name) + '_' + uid().slice(0, 8) + ext;
  const abs = resolveProjectPath(projectId, rel);
  if (!abs) throw new Error('新路径越界');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(finalAbs, abs, fs.constants.COPYFILE_EXCL);
  const newSha = sha256Of(abs);
  if (newSha !== finalSha) throw new Error('新文件 sha 与定稿不一致（' + String(newSha).slice(0, 12) + ' ≠ ' + finalSha.slice(0, 12) + '），未改库；新文件留在 ' + rel);
  withWriteContext('asset-precheck', () => Assets.update(a.id, { image_path: rel, source: 'uploaded', status: 'done' }));
  const back = Assets.get(a.id);
  if (!back || back.image_path !== rel || back.source !== 'uploaded') throw new Error('改库后读回不一致');
  return { ok: true, at: now.toISOString(), old_path: a.image_path, old_sha256: oldSha || '', archived, new_path: rel, new_sha256: newSha };
}

// ---------------- 清单 / 日志 ----------------
export function precheckLogFile() { return path.join(DATA_DIR, 'logs', 'asset-precheck.log'); }
function appendLog(rec) {
  try { const f = precheckLogFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* 写不进不影响 */ }
}
export function outDirOf(projectId, settings) {
  return settings && settings.root ? path.join(settings.root, '草稿', OUT_DIR_NAME) : path.join(projectDir(projectId), 'asset-precheck');
}
const ACTION_CN = { replace: '换成我方定稿', list: '缺定稿 / 待确认', ok: '已一致' };
export function renderPrecheckMd(r) {
  const L = [];
  L.push('# ' + r.chapter + ' 开渲前资产检查（' + r.trigger + '，' + r.mode + '）', '');
  L.push('- 时间：' + r.local + '；映射表：' + (r.map.file || '（无）') + '（' + r.map.entries + ' 条' + (r.map.errors.length ? '，错误 ' + r.map.errors.length + ' 条' : '') + '）');
  L.push('- 引用资产 ' + r.summary.referenced + ' 个，其中 IC 生成 ' + r.summary.generated + ' 个：换 ' + r.summary.replaced + '，列清单 ' + r.summary.listed + '，已一致 ' + r.summary.ok);
  L.push('- 不挡出片：清单里的资产本次仍用 IC 图出片；补好定稿（或在映射表加一行）后重生成下列镜头。', '');
  const listed = r.items.filter((x) => x.action === 'list' || x.result_error);
  if (listed.length) {
    L.push('## 缺定稿 / 待确认（交资产管理）', '', '| IC 资产 | 分类 | id | 引用镜头 | 原因 | 可能对应（未替换，需人工确认） |', '|---|---|---|---|---|---|');
    for (const x of listed) L.push('| ' + x.name + ' | ' + x.category + ' | ' + x.asset_id + ' | ' + x.shots.join(',') + ' | ' + String(x.result_error || x.reason).replace(/\|/g, '/') + ' | ' + ((x.suggestions || []).map((s) => (s.pid || '?') + ' ' + s.name + '（' + s.why + ' ' + s.score + '）').join('；') || '—') + ' |');
    L.push('');
  }
  const done = r.items.filter((x) => x.action === 'replace' || x.action === 'ok');
  if (done.length) {
    L.push('## 换图 / 已一致', '', '| IC 资产 | id | 依据 | 我方定稿 | 结果 |', '|---|---|---|---|---|');
    for (const x of done) {
      const res = x.result ? (x.result.ok ? '已换 ' + x.result.new_path + '（sha ' + x.result.new_sha256.slice(0, 12) + ' = 定稿；旧图归档 ' + x.result.archived + '）' : '未换：' + (x.result.reason || '')) : (r.mode === 'swap' ? ACTION_CN[x.action] : '（' + r.mode + ' 模式：将换）');
      L.push('| ' + x.name + ' | ' + x.asset_id + ' | ' + x.reason + ' | ' + (x.final ? (x.final.pid + ' ' + x.final.name + ' ' + x.final.asset_id.slice(0, 8)) : '') + ' | ' + res + ' |');
    }
  }
  return L.join('\n') + '\n';
}
function writeOutputs(projectId, settings, r, outDirOverride) {
  const dir = outDirOverride || outDirOf(projectId, settings);
  fs.mkdirSync(dir, { recursive: true });
  const latestF = path.join(dir, safeFile(r.chapter) + '_latest.json');
  let last = null; try { last = JSON.parse(fs.readFileSync(latestF, 'utf8')); } catch { /* 无 */ }
  const anyChange = r.items.some((x) => x.result && x.result.ok);
  if (last && last.digest === r.digest && !anyChange && last.md && fs.existsSync(last.md)) return { json: last.json, md: last.md, reused: true };
  const base = path.join(dir, safeFile(r.chapter) + '_开渲前资产检查_' + stamp(new Date(r.at)));
  fs.writeFileSync(base + '.json', JSON.stringify(r, null, 1));
  fs.writeFileSync(base + '.md', renderPrecheckMd(r));
  const tmp = latestF + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ json: base + '.json', md: base + '.md', at: r.at, digest: r.digest, listed: r.summary.listed, replaced: r.summary.replaced }, null, 1));
  fs.renameSync(tmp, latestF);
  return { json: base + '.json', md: base + '.md', reused: false };
}

// ---------------- 入口 ----------------
/**
 * runAssetPrecheck(projectId, chapterTitle, { trigger, mode, shotIds, write, outDir, cfg })
 *   mode：'swap' | 'list' | 'dry'（dry = 不改库不写项目，只把结果写到 outDir）；缺省按 assetPrecheckMode。
 *   shotIds：只查这几镜（单镜生成用）；缺省本章全部分镜。
 * 同步执行；永不抛（出错返回 { error }）。非 gap-list 项目 / 开关 off 返回 null。
 */
export function runAssetPrecheck(projectId, chapterTitle, opts = {}) {
  const { trigger = 'manual', shotIds = null, write = true, outDir = '', force = false } = opts;
  let mode = opts.mode || assetPrecheckMode(opts.cfg || safeConfig());
  if (mode === 'off') return null;
  try {
    const project = Projects.get(projectId);
    const settings = readAssetCheckSettings(project);
    if (settings.mode !== 'gap-list' && !force) return null;
    const allShots = Shots.list(projectId).filter((s) => s.chapter === chapterTitle);
    const shots = shotIds ? allShots.filter((s) => shotIds.includes(s.id)) : allShots;
    const map = loadFinalMap(projectId, settings);
    const sheet = loadOurSheet(settings);
    const aliases = settings.root ? loadAliases(path.join(settings.root, '资产', '别名表.csv')) : null;
    const plan = planAssetPrecheck({
      chapter: chapterTitle, shots, assets: Assets.list(projectId), map,
      deps: {
        fileSha: (rel) => { const abs = resolveProjectPath(projectId, rel); return abs ? sha256Of(abs) : null; },
        busy: (id) => { const q = Queue.activeByDedupe('asset:' + id) || Queue.activeByDedupe('voice:' + id); return q ? (q.jobId || q.id) : null; },
        sheet, aliases,
      },
    });
    const at = Date.now();
    const r = { ...plan, project_id: projectId, trigger, mode, scope: shotIds ? 'shots' : 'chapter', shot_count: shots.length, at, local: new Date(at).toLocaleString('zh-CN', { hour12: false }) };
    if (mode === 'swap') {
      for (const x of r.items) {
        if (x.action !== 'replace') continue;
        try { x.result = executeReplace(projectId, settings, x); }
        catch (e) { x.result = { ok: false, reason: e && e.message ? e.message : String(e) }; x.result_error = '换图失败：' + x.result.reason; }
      }
    }
    r.summary.replaced = r.items.filter((x) => x.result && x.result.ok).length;
    r.summary.replace_failed = r.items.filter((x) => x.result && !x.result.ok).length;
    r.summary.listed = r.items.filter((x) => x.action === 'list').length + r.summary.replace_failed;
    if (mode !== 'swap') r.summary.replaced = 0;
    r.line = '开渲前资产检查（' + mode + '）' + chapterTitle + '：IC 生成 ' + r.summary.generated + ' 个，'
      + (mode === 'swap' ? '换成我方定稿 ' + r.summary.replaced : '可换 ' + r.summary.replace) + '，缺定稿/待确认 ' + r.summary.listed + '，已一致 ' + r.summary.ok;
    let files = null;
    const wantFile = write && r.summary.generated > 0 && (mode === 'dry' ? !!outDir : true) && !shotIds;
    if (wantFile) {
      try { files = writeOutputs(projectId, settings, r, mode === 'dry' ? outDir : ''); } catch (e) { logger.warn('开渲前资产检查：清单写不出（不挡出片）', { projectId, chapter: chapterTitle, error: e && e.message }); }
    }
    r.files = files;
    if (mode !== 'dry') {
      appendLog({
        t: new Date(at).toISOString(), local: r.local, projectId, chapter: chapterTitle, trigger, mode, scope: r.scope, summary: r.summary, digest: r.digest,
        replaced: r.items.filter((x) => x.result && x.result.ok).map((x) => ({ id: x.asset_id, name: x.name, final: x.final && x.final.pid, new_path: x.result.new_path, new_sha256: x.result.new_sha256, archived: x.result.archived })),
        listed: r.items.filter((x) => x.action === 'list' || x.result_error).map((x) => ({ id: x.asset_id, name: x.name, code: x.result_error ? 'replace-failed' : x.code, shots: x.shots })),
        file: files ? files.md : '',
      });
      if (r.summary.generated) logger.info(r.line + (files ? '；清单 ' + files.md : ''), { projectId });
    }
    return r;
  } catch (e) {
    logger.warn('开渲前资产检查出错（不挡出片）', { projectId, chapter: chapterTitle, error: e && e.message });
    if (mode !== 'dry') appendLog({ t: new Date().toISOString(), projectId, chapter: chapterTitle, trigger, mode, error: e && e.message ? e.message : String(e) });
    return { error: e && e.message ? e.message : String(e), line: '开渲前资产检查出错（不挡出片）：' + (e && e.message) };
  }
}
function safeConfig() { try { return loadConfig(); } catch { return {}; } }

/** 给任务 checkpoint / 工具返回值用的短摘要 */
export function precheckBrief(r) {
  if (!r) return null;
  if (r.error) return { error: r.error };
  return { mode: r.mode, generated: r.summary.generated, replaced: r.summary.replaced, replace: r.summary.replace, listed: r.summary.listed, ok: r.summary.ok, file: r.files ? r.files.md : '' };
}
