// 本章资产齐全检查（2026-11-17 最小版，总导定案）：
//   - 按本章剧本 / 分镜列出需要的人物、场景、道具、服装、年龄、Q版设定、音色，逐项对素材库（同名优先，不做包含式模糊匹配）；
//   - 有缺件就写缺件单（JSON + md）到 <asset_root>\草稿\IC缺件单\，由总导转资产管理制作入库；IC 不出图；
//   - 音色例外（Andy 定）：资产表里没有该人物音色源文件、且本章有台词的龙套/群像，允许 IC 只为本章生成音色；
//     资产表里有音色源文件（如 C001_V）的必须登记我方文件，不准新造；
//   - 素材库里已有「同名、唯一、精确」的 voice 资产时，用官方 register_voice 自动登记；有歧义只列出来、不写库。
// 只对 projects.context.asset_mode === 'gap-list' 的项目生效（V2）；其他项目 auto，行为不变。
// 本模块不改资产图、不改 source、不写 SQL；只写缺件单文件、本项目目录下的 asset-checks.json，以及（可选）register_voice。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Projects, Chapters, Shots, Assets, projectDir, resolveProjectPath, logger } from '../core/index.js';
import { normalizeName } from '../shared/index.js';
import { parseDialogueLine } from '../core/offscreen-lines.js';
import { loadConfig } from '../core/config.js';

export const ASSET_MODE_KEY = 'asset_mode';   // 'gap-list' | 'auto'（缺省 auto）
export const ASSET_GATE_KEY = 'asset_gate';   // 'B'（先做分镜、出片前拦）| 'A'（等补齐再做分镜）；缺省 B
export const ASSET_ROOT_KEY = 'asset_root';   // 项目资料根目录（下有 资产\assets.csv、资产\别名表.csv、草稿\IC缺件单\）
export const GAP_LIST_SCHEMA = 'ic.asset-gap/v1';
const CHARACTER_VIEWS = ['正面全身', '侧面全身', '背面全身'];
const GROUP_RE = /(们|群众|众人|人群|路人|围观|若干|等人|一众|观众)/;
const BACKGROUND_NOTE_RE = /无台词|背影/;
const AGE_PREFIX_RE = /^(少年|童年|幼年|青年|年轻|小时候的?|年少的?)(.+)$/;
const SCENE_HEAD_RE = /^【第(\d+)场[｜|][^｜|】]*[｜|]([^】]+)】/;
const CAST_RE = /^出场人物[：:](.+)$/;
const SPEAKER_RE = /^([^\[【\s：:（(]{1,16})(?:[（(][^）)]*[）)])?[：:]/;
const CHIBI_RE = /Q版|两头身/;
const NOT_SPEAKERS = new Set(['出场人物', '画面', '情绪', '音效', '字幕', '镜头', '旁白', '表现点', '台词升级', '备注', '注']);
const SKIP_VOICE = new Set(['旁白']);
// 只做分镜任务里 create_asset 被拦的类别（IC 不建这些资产，记进缺件单）
export const GAP_BLOCKED_CREATE_CATEGORIES = new Set(['character', 'scene', 'prop', 'costume', 'age', 'voice']);

// ---------------- 设置 ----------------
export function readAssetCheckSettings(project) {
  const c = (project && project.context) || {};
  // 项目单独设过 asset_mode 就按项目；没设时按系统设置「资产出图方式」：muse（缺省）→ 缺件单模式，ic → auto。
  let mode;
  if (c[ASSET_MODE_KEY] === 'gap-list' || c[ASSET_MODE_KEY] === 'auto') mode = c[ASSET_MODE_KEY];
  else mode = assetImageSource() === 'ic' ? 'auto' : 'gap-list';
  const gate = c[ASSET_GATE_KEY] === 'A' ? 'A' : 'B';
  let root = String(c[ASSET_ROOT_KEY] || '').trim();
  if (!root && c.delivery_dir) {
    const d = String(c.delivery_dir).replace(/[\\/]+$/, '');
    if (path.basename(d) === '交付') root = path.dirname(d);
  }
  return { mode, gate, root };
}
/** 系统设置「资产出图方式」：'muse'（缺省，资产由 Muse 出图）| 'ic'（IC 自带生图）。 */
export function assetImageSource(cfg) {
  try { return ((cfg || loadConfig()).generation || {}).assetImageSource === 'ic' ? 'ic' : 'muse'; } catch { return 'muse'; }
}
export function gapListOn(projectId) {
  try { const p = projectId ? Projects.get(projectId) : null; if (!p) return false; return readAssetCheckSettings(p).mode === 'gap-list'; } catch { return false; }
}
export function assetPaths(projectId, settings) {
  const root = settings.root;
  return {
    root,
    sheet: root ? path.join(root, '资产', 'assets.csv') : '',
    alias: root ? path.join(root, '资产', '别名表.csv') : '',
    sheetBase: root ? path.join(root, '资产') : '',
    toc: root ? path.join(root, '项目数据', '原著索引', 'toc.csv') : '',
    gapDir: root ? path.join(root, '草稿', 'IC缺件单') : path.join(projectDir(projectId), 'asset-gaps'),
  };
}

// ---------------- CSV ----------------
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
function csvObjects(text) {
  const rows = parseCsv(text).filter((r) => !String(r[0] || '').startsWith('#'));
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : String(r[i])])));
}
const readText = (f) => { try { return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };

// 别名表：两列 IC名,资产表名；文件不存在 = 空表
export function loadAliases(file) {
  const t = readText(file);
  const icToSheet = new Map(); const sheetToIc = new Map();
  if (t == null) return { exists: false, file, icToSheet, sheetToIc, rows: [] };
  const rows = [];
  for (const r of parseCsv(t)) {
    const a = String(r[0] || '').trim(); const b = String(r[1] || '').trim();
    if (!a || !b || a === 'IC名') continue;
    rows.push([a, b]);
    icToSheet.set(normalizeName(a), b); sheetToIc.set(normalizeName(b), a);
  }
  return { exists: true, file, icToSheet, sheetToIc, rows };
}

// 资产表（资产管理维护）：读 type/pid/name/file/ch/review/miss/描述
export function loadSheet(file) {
  const t = readText(file);
  if (t == null) return { exists: false, file, rows: [] };
  return { exists: true, file, rows: csvObjects(t) };
}

function chHit(spec, n) {
  for (const part of String(spec || '').split(/[;；,，]/)) {
    const p = part.trim(); if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m && +m[1] <= n && n <= +m[2]) return true;
    if (/^\d+$/.test(p) && +p === n) return true;
  }
  return false;
}

// 括号内的顿号不拆（「唐知夏（C005，电话）」）
function splitNames(text) {
  const out = []; let buf = ''; let depth = 0;
  for (const ch of String(text || '')) {
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === '、' || ch === '，' || ch === ',') && depth === 0) { out.push(buf); buf = ''; } else buf += ch;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}
const speakerOf = (line) => {
  const t = String(line || '').trim();
  if (!t || t.startsWith('[') || t.startsWith('【')) return '';
  const m = t.match(SPEAKER_RE);
  if (!m) return '';
  const n = m[1].trim();
  return NOT_SPEAKERS.has(n) ? '' : n;
};
const parseIds = (v) => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v || '[]'); } catch { return []; } })());

// ---------------- 文件判定 ----------------
function fileOk(projectId, rel) {
  if (!rel) return false;
  try { const abs = resolveProjectPath(projectId, rel); return !!(abs && fs.existsSync(abs)); } catch { return false; }
}
export function imageState(projectId, a) {
  if (!a.image_path) return 'no_image';
  if (!fileOk(projectId, a.image_path)) return 'image_file_missing';
  if (a.status !== 'done') return 'not_done';
  return 'ok';
}
export function voiceRefState(projectId, a) {
  const refs = String(a.voice_ref || '').split(/[\n,;，；]+/).map((s) => s.trim()).filter(Boolean);
  if (!refs.length) return 'no_voice';
  const bad = refs.filter((r) => !/^assets[\\/]voice[\\/]/.test(r) || !fileOk(projectId, r));
  return bad.length ? 'voice_file_missing' : 'ok';
}

// 同名优先：精确 → 别名 → 规范化唯一；多个命中 = ambiguous
function finder(list, aliases) {
  return (name) => {
    const want = String(name || '').trim();
    if (!want) return { hit: null, how: 'not_found', cands: [] };
    const ex = list.filter((a) => a.name === want);
    if (ex.length === 1) return { hit: ex[0], how: 'exact', cands: [] };
    if (ex.length > 1) return { hit: null, how: 'ambiguous', cands: ex };
    const alt = aliases.icToSheet.get(normalizeName(want)) || aliases.sheetToIc.get(normalizeName(want));
    if (alt) {
      const ax = list.filter((a) => a.name === alt || normalizeName(a.name) === normalizeName(alt));
      if (ax.length === 1) return { hit: ax[0], how: 'alias', cands: [] };
    }
    const nz = list.filter((a) => normalizeName(a.name) && normalizeName(a.name) === normalizeName(want));
    if (nz.length === 1) return { hit: nz[0], how: 'normalized', cands: [] };
    if (nz.length > 1) return { hit: null, how: 'ambiguous', cands: nz };
    return { hit: null, how: 'not_found', cands: [] };
  };
}

// 资产表里人物的音色源：同 pid 的 voice 行。file 非空且文件存在 = 有我方源文件；有行无文件 = 资产管理待制作
export function sheetVoiceOf(sheet, aliases, icName, sheetBase) {
  const want = [normalizeName(icName)];
  const al = aliases.icToSheet.get(normalizeName(icName));
  if (al) want.push(normalizeName(al));
  const rows = sheet.rows || [];
  const pids = new Set(rows.filter((r) => (r.type === 'char') && want.includes(normalizeName(r.name))).map((r) => r.pid).filter(Boolean));
  const voices = rows.filter((r) => r.type === 'voice' && ((r.pid && pids.has(r.pid)) || want.includes(normalizeName(r.name))));
  if (!voices.length) return { status: 'none', rows: [], pids: [...pids] };
  const withFile = voices.filter((r) => r.file && sheetBase && fs.existsSync(path.join(sheetBase, r.file)));
  if (withFile.length) return { status: 'source_file', rows: withFile.map((r) => ({ id: r.id, file: path.join(sheetBase, r.file), review: r.review })), pids: [...pids] };
  return { status: 'row_no_file', rows: voices.map((r) => ({ id: r.id, file: r.file || '', miss: r.miss || '' })), pids: [...pids] };
}

// ---------------- 本章需求清单 ----------------
function buildNeeds({ chapter, shots, byId, sheet, toc, enableChibi, requests }) {
  const need = new Map();
  const add = (type, name, src, extra = {}) => {
    const nm = String(name || '').trim(); if (!nm) return null;
    const owner = extra.owner || '';
    const key = type + '|' + owner + '|' + normalizeName(nm);
    let d = need.get(key);
    if (!d) { d = { key, type, name: nm, owner, sources: new Set(), shots: new Set(), scenes: new Set(), evidence: [], assetId: '' }; need.set(key, d); }
    d.sources.add(src);
    if (extra.shot != null) d.shots.add(extra.shot);
    if (extra.scene) d.scenes.add(extra.scene);
    if (extra.assetId && !d.assetId) d.assetId = extra.assetId;
    if (extra.ev && d.evidence.length < 3) d.evidence.push(extra.ev);
    return d;
  };
  const n = Number(chapter.seq) || 0;
  // L0：原著索引 + 资产表 ch 列（只作参考）
  if (toc) {
    const tr = toc.find((r) => String(r['章号']) === String(n));
    if (tr) {
      for (const p of splitNames(tr['出场人物'])) add('character', p.replace(/（[^）]*）$/, ''), 'toc', { ev: { src: 'toc', text: p } });
      for (const s of splitNames(tr['主要场景'])) add('scene', s, 'toc', { ev: { src: 'toc', text: s } });
    }
  }
  const typeMap = { char: 'character', outfit: 'costume', scene: 'scene', prop: 'prop' };
  for (const r of sheet.rows || []) {
    if (!typeMap[r.type] || !chHit(r.ch, n)) continue;
    if (r.type === 'char' && r.var && r.var !== 'B') continue; // 只要人物主图行；Q版等变体按剧本/分镜要
    add(typeMap[r.type], r.name, 'sheet', { ev: { src: 'sheet', id: r.id, text: r.name } });
  }
  // L1：剧本
  const script = String(chapter.script || '');
  let scene = '';
  script.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim(); if (!l) return;
    let m = l.match(SCENE_HEAD_RE);
    if (m) { scene = '第' + m[1] + '场'; add('scene', m[2].trim(), 'script', { scene, ev: { src: 'script', line: i + 1, text: l.slice(0, 60) } }); return; }
    m = l.match(CAST_RE);
    if (m) { for (const nm of splitNames(m[1])) add('character', nm, 'script', { scene, ev: { src: 'script', line: i + 1, text: l.slice(0, 60) } }); return; }
    const sp = speakerOf(l);
    if (sp && !SKIP_VOICE.has(sp)) add('voice', sp, 'script', { owner: sp, scene, ev: { src: 'script', line: i + 1, text: l.slice(0, 50) } });
    if (enableChibi && CHIBI_RE.test(l)) {
      const who = sp || '';
      if (who) add('chibi', who + '·Q版设定', 'script', { owner: who, scene, ev: { src: 'script', line: i + 1, text: l.slice(0, 60) } });
    }
  });
  // L2：分镜
  const cols = [['character_ids', 'character'], ['scene_ids', 'scene'], ['prop_ids', 'prop'], ['costume_ids', 'costume'], ['age_ids', 'age']];
  for (const s of shots) {
    const names = [];
    for (const [col, cat] of cols) {
      for (const id of parseIds(s[col])) {
        const a = byId.get(id);
        if (!a) { add(cat, '（已删除资产 ' + String(id).slice(0, 8) + '）', 'storyboard', { shot: s.idx, assetId: id }); continue; }
        const owner = (cat === 'costume' || cat === 'age') && byId.get(a.parent_id) ? byId.get(a.parent_id).name : '';
        add(cat, a.name, 'storyboard', { owner, shot: s.idx, assetId: a.id });
        if (cat === 'character') names.push(a.name);
      }
    }
    for (const line of String(s.dialogue || '').split(/\r?\n/)) {
      // 说话人名同 offscreen-lines 解析：「江澈OS」「电话里的王总」取本人名（江澈 / 王总）——心声/电话声 2026-11-22 起由 H3 直出、
      // 要本人音色；括号舞台提示照旧剥掉。普通「人物：台词」结果与原先逐字相同。
      const sp = parseDialogueLine(line).speaker;
      if (sp && !SKIP_VOICE.has(sp) && !NOT_SPEAKERS.has(sp)) add('voice', sp, 'storyboard', { owner: sp, shot: s.idx });
    }
    const vis = String(s.visual || '') + '\n' + String(s.sub_shots || '');
    if (enableChibi && /【表现】[^\n]*Q版/.test(vis) && names[0]) add('chibi', names[0] + '·Q版设定', 'storyboard', { owner: names[0], shot: s.idx });
  }
  // Agent 在只做分镜任务里想建、被拦下的资产
  for (const r of requests || []) add(r.category === 'voice' ? 'voice' : r.category, r.name, 'agent_request', { owner: r.category === 'voice' ? r.name : '' });
  return need;
}

// ---------------- 检查（纯读） ----------------
export function checkChapterAssets(projectId, chapterRef, { trigger = 'manual', settings: sOverride } = {}) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  const chapter = Chapters.list(projectId).find((c) => c.id === chapterRef || c.title === chapterRef);
  if (!chapter) throw new Error('章节不存在：' + chapterRef);
  const settings = sOverride || readAssetCheckSettings(project);
  const paths = assetPaths(projectId, settings);
  const aliases = loadAliases(paths.alias);
  const sheet = loadSheet(paths.sheet);
  const tocText = readText(paths.toc);
  const toc = tocText == null ? null : csvObjects(tocText);
  const assets = Assets.list(projectId);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const byCat = (cat) => assets.filter((a) => a.category === cat);
  const shots = Shots.list(projectId).filter((s) => s.chapter === chapter.title).sort((a, b) => a.idx - b.idx);
  const store = readStore(projectId);
  const requests = (store.requests && store.requests[chapter.title]) || [];
  const needs = buildNeeds({ chapter, shots, byId, sheet, toc, enableChibi: !!project.enable_chibi, requests });
  const phase = shots.length ? 'storyboard' : (String(chapter.script || '').trim() ? 'script' : 'pre-script');
  const primary = phase === 'storyboard' ? 'storyboard' : phase === 'script' ? 'script' : null;

  const find = {
    character: finder(byCat('character'), aliases), scene: finder(byCat('scene'), aliases), prop: finder(byCat('prop'), aliases),
    costume: finder(byCat('costume'), aliases), age: finder(byCat('age'), aliases), voice: finder(byCat('voice'), aliases),
  };
  // 每个人物出现在哪些镜（剧本来源的条目据此补镜号）
  const charShots = new Map();
  for (const d of needs.values()) {
    if ((d.type === 'character' || d.type === 'voice') && d.shots.size) {
      const k = normalizeName(d.name);
      const set = charShots.get(k) || new Set(); for (const x of d.shots) set.add(x); charShots.set(k, set);
    }
  }
  const missing = []; const ok = []; const review = []; const linkable = []; const advisory = []; const groupRoles = []; const voicePlan = [];
  const sheetSpec = (name) => (sheet.rows || []).filter((r) => normalizeName(r.name) === normalizeName(name) || normalizeName(r.name) === normalizeName(aliases.icToSheet.get(normalizeName(name)) || ''))
    .slice(0, 3).map((r) => ({ id: r.id, type: r.type, file: r.file, review: r.review, desc: String(r['描述'] || '').slice(0, 120) }));
  const specOf = (type, name) => {
    const sp = {};
    if (type === 'character' || type === 'age') sp.views = CHARACTER_VIEWS.slice();
    if (type === 'scene') sp.views = ['场景主图（无人物）'];
    if (type === 'prop' || type === 'chibi') sp.views = ['主图'];
    if (type === 'chibi') sp.h3_rules = ['Q版设定须作为道具绑到镜头（h3 手册 3b）'];
    if (type === 'character') sp.h3_rules = ['参考图只作身份参考，不得出现在画面（h3 手册第8条）'];
    const sh = sheetSpec(name); if (sh.length) sp.sheet = sh;
    return sp;
  };

  for (const d of needs.values()) {
    const rec = { key: d.key, type: d.type, name: d.name, owner: d.owner, sources: [...d.sources].sort(), shots: [...d.shots].sort((a, b) => a - b), scenes: [...d.scenes].sort(), evidence: d.evidence };
    if (!rec.shots.length && (d.type === 'character' || d.type === 'voice')) rec.shots = [...(charShots.get(normalizeName(d.name)) || [])].sort((a, b) => a - b);
    const binding = primary ? d.sources.has(primary) || d.sources.has('agent_request') : false;
    if (!binding) {
      // 剧本前（L0）只作参考；有剧本/分镜时，只在索引/资产表里出现的条目也只作参考
      if (d.type === 'voice') continue;
      advisory.push({ ...rec, note: primary ? '只在原著索引/资产表出现，本章' + (primary === 'storyboard' ? '分镜' : '剧本') + '未用到' : '剧本前清单，只作参考，不拦' });
      continue;
    }
    if (d.type === 'character' && !AGE_PREFIX_RE.test(normalizeName(d.name)) && (GROUP_RE.test(normalizeName(d.name)) || BACKGROUND_NOTE_RE.test(d.name))) {
      const hit = find.character(d.name).hit;
      if (!hit) { groupRoles.push({ name: d.name, shots: rec.shots, note: '群像/背景人物：不单独要求资产；如有台词另列音色' }); continue; }
    }
    if (d.type === 'voice') {
      const name = d.name;
      const ch = find.character(name === '系统' ? '交易系统' : name);
      const vlist = byCat('voice');
      const vf = finder(vlist, aliases);
      if (name === '系统') {
        const sv = vf('系统音色');
        if (sv.hit && (sv.hit.audio_path || sv.hit.voice_ref) && fileOk(projectId, sv.hit.audio_path || sv.hit.voice_ref)) { ok.push({ ...rec, asset_id: sv.hit.id, asset_name: sv.hit.name, match: sv.how, via: 'voice 资产' }); continue; }
      }
      if (ch.hit) {
        const st = voiceRefState(projectId, ch.hit);
        if (st === 'ok') { ok.push({ ...rec, asset_id: ch.hit.id, asset_name: ch.hit.name, match: ch.how, via: 'character.voice_ref', source: ch.hit.source }); continue; }
        // 库里同名 voice 资产：唯一 + 精确 → 可自动登记；歧义只列
        const exact = vlist.filter((v) => (v.name === name + '音色' || v.name === name) && v.status === 'done' && (v.audio_path || v.voice_ref) && fileOk(projectId, v.audio_path || v.voice_ref));
        if (exact.length === 1 && st === 'no_voice') {
          linkable.push({ ...rec, character_id: ch.hit.id, voice_asset_id: exact[0].id, voice_asset_name: exact[0].name, voice_ref: exact[0].audio_path || exact[0].voice_ref });
          continue;
        }
        const sv = sheetVoiceOf(sheet, aliases, ch.hit.name, paths.sheetBase);
        const item = { ...rec, reason: st, character_id: ch.hit.id, candidates: exact.length > 1 ? exact.map((v) => ({ id: v.id, name: v.name })) : [],
          spec: { voice_traits: ch.hit.voice_desc || '', sheet_voice: sv.rows } };
        if (exact.length > 1) { item.reason = 'ambiguous'; item.voice_policy = 'list_only'; }
        else if (sv.status === 'source_file') { item.voice_policy = 'register_ours'; item.note = '资产表有我方音色源文件，必须登记我方文件，IC 不新造'; }
        else if (sv.status === 'row_no_file') { item.voice_policy = 'asset_mgmt'; item.note = '资产表已有音色行但无源文件（资产管理待制作），IC 不新造'; }
        else { item.voice_policy = 'ic_generate'; item.note = '资产表无该人物音色源文件、本章有台词：允许 IC 只为本章生成音色'; voicePlan.push({ asset_id: ch.hit.id, name: ch.hit.name, shots: rec.shots, voice_desc: ch.hit.voice_desc || '' }); }
        missing.push(item);
        continue;
      }
      missing.push({ ...rec, reason: ch.how === 'ambiguous' ? 'ambiguous' : 'no_character', candidates: (ch.cands || []).map((c) => ({ id: c.id, name: c.name })), voice_policy: 'list_only', note: '说话人在素材库里没有对应人物资产' });
      continue;
    }
    // 图片类：分镜里已经是资产 id
    let hit = d.assetId ? byId.get(d.assetId) : null; let how = hit ? 'id' : '';
    let cands = [];
    if (!hit) {
      const cat = d.type === 'chibi' ? 'prop' : d.type;
      const f = (find[cat] || find.prop)(d.name);
      hit = f.hit; how = f.how; cands = f.cands || [];
      if (!hit && d.type === 'chibi') { const f2 = find.character(d.name); if (f2.hit) { hit = f2.hit; how = f2.how + '(character)'; } }
      if (!hit && d.type === 'scene' && d.name.includes('·')) { const f2 = find.scene(d.name.split('·')[0]); if (f2.hit) { hit = f2.hit; how = 'parent_scene'; } }
      if (!hit && d.type === 'character') {
        const m = normalizeName(d.name).match(AGE_PREFIX_RE);
        if (m) {
          const base = find.character(m[2]).hit;
          if (base) {
            const ag = byCat('age').filter((a) => a.parent_id === base.id);
            if (ag.length === 1) { hit = ag[0]; how = 'age_variant_of:' + base.name; }
            else { missing.push({ ...rec, type: 'age', owner: base.name, reason: ag.length > 1 ? 'ambiguous' : 'not_found', candidates: ag.map((a) => ({ id: a.id, name: a.name })), spec: { ...specOf('age', d.name), age_state: m[1], parent_asset_id: base.id } }); continue; }
          }
        }
      }
    }
    if (!hit) { missing.push({ ...rec, reason: how || 'not_found', candidates: cands.map((c) => ({ id: c.id, name: c.name, source: c.source, status: c.status })), spec: specOf(d.type, d.name) }); continue; }
    const st = imageState(projectId, hit);
    const okRec = { ...rec, asset_id: hit.id, asset_name: hit.name, match: how, source: hit.source || 'none' };
    if (st !== 'ok') { missing.push({ ...rec, reason: st, candidates: [{ id: hit.id, name: hit.name, source: hit.source, status: hit.status }], spec: specOf(d.type, d.name) }); continue; }
    ok.push(okRec);
    if (hit.source === 'generated') review.push({ ...okRec, note: 'IC 自生成：先算齐，待资产管理复核' });
  }

  const byType = {}; const byReason = {}; const affected = new Set();
  for (const m of missing) { byType[m.type] = (byType[m.type] || 0) + 1; byReason[m.reason] = (byReason[m.reason] || 0) + 1; for (const x of m.shots || []) affected.add(x); }
  const report = {
    schema: GAP_LIST_SCHEMA,
    project: { id: projectId, name: project.name, enable_chibi: !!project.enable_chibi },
    chapter: { id: chapter.id, title: chapter.title, seq: chapter.seq },
    generated_at: localIso(new Date()),
    trigger, phase, mode: settings.mode, gate: settings.gate,
    inputs: { script_len: String(chapter.script || '').length, novel_len: String(chapter.novel || '').length, shots: shots.length,
      sheet: sheet.exists ? paths.sheet : '', sheet_rows: (sheet.rows || []).length, alias_table: aliases.exists ? paths.alias : '', alias_rows: aliases.rows.length },
    summary: { required: ok.length + missing.length + linkable.length, ok: ok.length, missing: missing.length, review: review.length, linkable: linkable.length,
      group_roles: groupRoles.length, advisory: advisory.length, missing_by_type: byType, missing_by_reason: byReason, affected_shots: [...affected].sort((a, b) => a - b) },
    missing, review, linkable, voice_plan: voicePlan, group_roles: groupRoles, advisory, ok,
  };
  report.state = phase === 'pre-script' ? 'reference' : missing.length ? 'missing' : 'complete';
  report.digest = crypto.createHash('sha1').update(JSON.stringify([missing.map((m) => [m.key, m.reason, m.shots]), review.map((r) => r.key)])).digest('hex').slice(0, 16);
  return report;
}

function localIso(d) {
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const p = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + sign + p(off / 60) + ':' + p(off % 60);
}
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
const safeFile = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

// ---------------- 存储（项目目录 asset-checks.json，不动 ic.db 表结构） ----------------
const storeFile = (projectId) => path.join(projectDir(projectId), 'asset-checks.json');
export function readStore(projectId) {
  try { const j = JSON.parse(fs.readFileSync(storeFile(projectId), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function writeStore(projectId, mut) {
  const f = storeFile(projectId);
  const cur = readStore(projectId);
  const next = mut(cur) || cur;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, f);
  return next;
}
export function chapterAssetStatus(projectId, chapterId) {
  const s = readStore(projectId);
  return (s.chapters && s.chapters[chapterId]) || null;
}
// 只做分镜任务里被拦下的 create_asset：记下来，下一次检查当作本章需求
export function recordAgentAssetRequest(projectId, chapterTitle, { category, name }) {
  if (!chapterTitle || !name) return;
  try {
    writeStore(projectId, (s) => {
      s.requests = s.requests || {};
      const list = s.requests[chapterTitle] || [];
      if (!list.some((r) => r.category === category && r.name === name)) list.push({ category, name, at: Date.now() });
      s.requests[chapterTitle] = list.slice(-200);
      return s;
    });
  } catch (e) { logger.warn('资产检查：记录 Agent 建资产请求失败', { projectId, error: e && e.message }); }
}

// ---------------- 缺件单 ----------------
export function renderGapMd(r) {
  const L = [];
  L.push('# ' + r.chapter.title + ' 缺件单（IC 资产齐全检查）', '');
  L.push('- 生成：' + r.generated_at + '　触发：' + r.trigger + '　阶段：' + r.phase + '　分镜 ' + r.inputs.shots + ' 镜');
  L.push('- 需要 ' + r.summary.required + ' 项：齐 ' + r.summary.ok + '，缺 ' + r.summary.missing + '，可自动登记音色 ' + r.summary.linkable + '，待资产管理复核 ' + r.summary.review);
  L.push('- 受影响镜号：' + (r.summary.affected_shots.join(',') || '无'));
  L.push('- IC 只出缺件单，不出图；人物要三视图（正面/侧面/背面全身）。', '');
  L.push('## 缺件', '', '| 类型 | 名称 | 归属 | 原因 | 镜号 | 音色处理 | 规格 / 说明 |', '|---|---|---|---|---|---|---|');
  for (const m of r.missing) {
    const spec = m.spec || {};
    const bits = [];
    if (spec.views) bits.push('视图：' + spec.views.join('/'));
    if (spec.voice_traits) bits.push('声线：' + spec.voice_traits);
    if (spec.age_state) bits.push('年龄：' + spec.age_state);
    if (spec.sheet && spec.sheet.length) bits.push('资产表：' + spec.sheet.map((s) => s.id + (s.file ? '(' + s.file + ')' : '(无图)')).join('、'));
    if (spec.sheet_voice && spec.sheet_voice.length) bits.push('资产表音色：' + spec.sheet_voice.map((s) => s.id + (s.file ? ' ' + s.file : '')).join('、'));
    if (m.candidates && m.candidates.length) bits.push('候选：' + m.candidates.map((c) => c.name).join('、'));
    if (m.note) bits.push(m.note);
    L.push('| ' + [m.type, m.name, m.owner || '', m.reason, (m.shots || []).join(',') || '-', m.voice_policy || '', bits.join('；').replace(/\|/g, '/')].join(' | ') + ' |');
  }
  L.push('', '## 待资产管理复核（IC 自生成，先算齐）', '', '| 类型 | 名称 | 资产 | 镜号 |', '|---|---|---|---|');
  for (const x of r.review) L.push('| ' + [x.type, x.name, x.asset_name, (x.shots || []).join(',') || '-'].join(' | ') + ' |');
  if (r.linkable.length || (r.registered || []).length) {
    L.push('', '## 音色自动登记（库里同名唯一）', '');
    for (const x of r.linkable) L.push('- ' + x.name + ' ← ' + x.voice_asset_name + '（' + x.voice_ref + '）');
    for (const x of r.registered || []) L.push('- 已登记：' + x.name + ' ← ' + x.voice_ref + (x.error ? '（失败：' + x.error + '）' : ''));
  }
  if (r.voice_plan.length) {
    L.push('', '## 允许 IC 为本章生成音色（资产表无源文件、本章有台词）', '');
    for (const v of r.voice_plan) L.push('- ' + v.name + '（镜 ' + (v.shots.join(',') || '-') + '）');
  }
  if (r.group_roles.length) { L.push('', '## 群像 / 背景人物（不单独要求资产）', ''); for (const g of r.group_roles) L.push('- ' + g.name); }
  if (r.advisory.length) { L.push('', '## 仅供参考（剧本前清单 / 原著索引、资产表提到但本章未用）', ''); for (const a of r.advisory) L.push('- ' + a.type + '：' + a.name); }
  return L.join('\n') + '\n';
}

export function writeGapList(projectId, report, settings) {
  const paths = assetPaths(projectId, settings || readAssetCheckSettings(Projects.get(projectId)));
  const last = chapterAssetStatus(projectId, report.chapter.id);
  if (last && last.digest === report.digest && last.gapFile && fs.existsSync(last.gapFile)) return { file: last.gapFile, md: last.gapMd || '', reused: true };
  fs.mkdirSync(paths.gapDir, { recursive: true });
  const base = path.join(paths.gapDir, safeFile(report.chapter.title) + '_' + stamp(new Date()));
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 1));
  fs.writeFileSync(base + '.md', renderGapMd(report));
  const latest = path.join(paths.gapDir, safeFile(report.chapter.title) + '_latest.json');
  const tmp = latest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ file: base + '.json', md: base + '.md', at: report.generated_at, missing: report.summary.missing }, null, 1)); fs.renameSync(tmp, latest);
  return { file: base + '.json', md: base + '.md', reused: false };
}

// 检查 + （可选）自动登记同名唯一音色 + 写缺件单 + 记状态。register 走官方 register_voice 工具。
export async function runAssetCheck(projectId, chapterRef, { trigger = 'manual', register = true, write = true } = {}) {
  const settings = readAssetCheckSettings(Projects.get(projectId));
  let report = checkChapterAssets(projectId, chapterRef, { trigger, settings });
  const registered = [];
  if (register && report.linkable.length) {
    const { createToolRuntime, runTool } = await import('./tools.js');
    const ctx = createToolRuntime({ projectId, chapter: report.chapter.title, onProgress: () => {}, isAborted: () => false, renderDisabled: true });
    for (const x of report.linkable) {
      try { await runTool(ctx, 'register_voice', { asset_id: x.character_id, voice_ref: x.voice_ref }); registered.push({ name: x.name, asset_id: x.character_id, voice_ref: x.voice_ref }); }
      catch (e) { registered.push({ name: x.name, asset_id: x.character_id, voice_ref: x.voice_ref, error: e && e.message }); }
    }
    report = checkChapterAssets(projectId, chapterRef, { trigger, settings });
  }
  report.registered = registered;
  let gap = null;
  const needFile = report.summary.missing > 0 || report.summary.review > 0 || report.summary.linkable > 0;
  if (write && needFile) gap = writeGapList(projectId, report, settings);
  if (write) {
    writeStore(projectId, (s) => {
      s.chapters = s.chapters || {};
      const prev = s.chapters[report.chapter.id] || {};
      s.chapters[report.chapter.id] = {
        title: report.chapter.title, state: report.state, phase: report.phase, missing: report.summary.missing, review: report.summary.review,
        affectedShots: report.summary.affected_shots, missingKeys: report.missing.map((m) => m.key), voicePlan: report.voice_plan.map((v) => v.asset_id),
        digest: gap ? report.digest : (needFile ? prev.digest || '' : ''), gapFile: gap ? gap.file : (needFile ? prev.gapFile || '' : ''), gapMd: gap ? gap.md : (needFile ? prev.gapMd || '' : ''),
        checkedAt: Date.now(), trigger,
      };
      return s;
    });
  }
  return { report, gap, registered };
}

// 起任务前的检查（job-runner startCreateJob 调）。只对 gap-list 项目生效；永不因检查自身出错而挡任务。
// 返回 { report } ；A 闸且有缺件时抛 code=ASSETS_MISSING（不建任务）。
export function assetGateBeforeRun(projectId, chapterTitle, { trigger = 'run' } = {}) {
  let settings;
  try { settings = readAssetCheckSettings(Projects.get(projectId)); } catch { return null; }
  if (settings.mode !== 'gap-list' || !chapterTitle) return null;
  let report;
  try { report = checkChapterAssets(projectId, chapterTitle, { trigger, settings }); } catch (e) {
    logger.warn('资产检查：起任务前检查失败（不挡任务）', { projectId, chapter: chapterTitle, error: e && e.message });
    return null;
  }
  if (settings.gate === 'A' && report.phase !== 'pre-script' && report.summary.missing > 0) {
    let gap = null;
    try { gap = writeGapList(projectId, report, settings); } catch { /* 写不出也照样拦 */ }
    throw Object.assign(new Error('「' + chapterTitle + '」缺件 ' + report.summary.missing + ' 项，按「等补齐再做分镜」不建任务' + (gap ? '；缺件单：' + gap.file : '')), { code: 'ASSETS_MISSING', gapList: gap && gap.file, missing: report.summary.missing });
  }
  // B：不挡；异步跑一次完整检查（自动登记 + 写缺件单），失败只记日志
  runAssetCheck(projectId, chapterTitle, { trigger }).catch((e) => logger.warn('资产检查：任务前异步检查失败', { projectId, chapter: chapterTitle, error: e && e.message }));
  return { report };
}
