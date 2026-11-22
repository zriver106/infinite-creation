// 康康合集曲库：把「曲目编号 / 文件名 / 曲名」解析成曲库文件（纯函数 + 只读文件，无数据库、无渲染）。
// 映射表：lib/shared/bgm_映射.json（2026-11-16 新增；由《康康合集-BGM情绪与使用指南》与 kim-bgm\完整版 清单生成）。
// 供 tools.js 的 set_chapter_music / generate_music / apply_chapter_music 共用，也供离线单元验证。
// 只读原曲：本模块从不写曲库目录；登记进项目时由调用方把文件复制到项目的 assets/music/ 下。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 映射表在仓库里的相对位置；绝对路径由调用方用 ROOT 拼（本模块不碰项目根路径）。 */
export const BGM_MAP_REL = ['lib', 'shared', 'bgm_映射.json'];

let cache = { file: '', mtimeMs: 0, map: null };

/** 读映射表（按 mtime 缓存）。文件不存在或内容不合法返回 null —— 调用方按「没有曲库」处理，不抛错。 */
export function loadBgmMap(file) {
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (cache.map && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.map;
  let map = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.tracks) && doc.tracks.length && typeof doc.library_dir === 'string' && doc.library_dir) map = doc;
  } catch { map = null; }
  cache = { file, mtimeMs: st.mtimeMs, map };
  return map;
}

/** 名字归一：小写、去扩展名与「完整候选」后缀、去空白与常见分隔符，用于编号/曲名/文件名的宽松比较。 */
export function normBgmKey(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/\.(mp3|aac|m4a|wav|flac)$/i, '')
    .replace(/完整候选$/, '')
    .replace(/[\s\-_—–·•・.。,，、:：;；()（）\[\]【】《》「」｜|!！?？'’"“”&＆]+/g, '');
}

function fileStem(f) {
  return (f && f.asset_name) || String((f && f.file) || '').replace(/\.[^.]+$/, '');
}

function defaultFile(track) {
  const files = (track && track.files) || [];
  return files.find((f) => f.default) || files[0] || null;
}

/** 曲名去掉括注：「Life Struggle（二次出现）」→「Life Struggle」。 */
function bareTitle(t) {
  return String((t && t.title) || '').replace(/（.*?）|\(.*?\)/g, '');
}

/**
 * 在映射表里解析一个引用。
 * 返回 { track, file, by }；找不到返回 null；同时命中多个编号返回 { ambiguous: [track...] }。
 * 认的写法：
 *   完整文件名 / 去扩展名 / 去「-完整候选」                       →  精确到文件
 *   "17"、"BGM17"、"17｜Groovy Hammond"、"17-青衣(DJ阿泽版)"      →  编号；后面的文字能唯一对上某个文件就用它，否则用默认文件
 *   "Groovy Hammond"、"囚笼"                                      →  曲名（或文件名里的唯一片段）
 */
export function matchLibraryTrack(map, ref) {
  // 「康康合集 17｜Groovy Hammond」这类带合集名前缀的写法：先去掉前缀
  const raw = String(ref == null ? '' : ref).trim().replace(/^康康合集\s*(?:BGM)?\s*[：:]?\s*/i, '').trim();
  if (!map || !raw) return null;
  const tracks = map.tracks || [];
  const key = normBgmKey(raw);
  if (!key) return null;

  // 1) 文件名精确
  for (const t of tracks) {
    for (const f of (t.files || [])) {
      const stem = fileStem(f);
      if (raw === f.file || raw === stem || key === normBgmKey(f.file)) return { track: t, file: f, by: 'file' };
    }
  }

  // 2) 编号开头（编号后必须是结尾或分隔符，避免把 uuid、「第2章背景音乐」之类误当编号）
  const m = /^(?:bgm|第)?\s*0*(\d{1,2})\s*(?:首|号)?(?:$|[\s\-_—–｜|:：.、·]+(.*)$)/i.exec(raw);
  if (m) {
    const no = String(Number(m[1])).padStart(2, '0');
    const t = tracks.find((x) => String(x.no) === no);
    if (t) {
      const rest = normBgmKey(m[2] || '');
      const files = t.files || [];
      if (rest && files.length > 1) {
        const hit = files.filter((f) => normBgmKey(f.file).includes(rest));
        if (hit.length === 1) return { track: t, file: hit[0], by: 'no+file' };
      }
      const f = defaultFile(t);
      if (f) return { track: t, file: f, by: 'no' };
    }
    return null; // 写了编号却不在 01–38 内：不再按曲名猜
  }

  // 3) 曲名 / 文件名片段（至少 2 个字符，避免单字误撞）
  if (key.length >= 2) {
    // 完整曲名精确优先（「Life Struggle」只指第 03 首；第 28 首的曲名带「（二次出现）」）
    let byTitle = tracks.filter((t) => normBgmKey(t.title) === key);
    if (!byTitle.length) byTitle = tracks.filter((t) => normBgmKey(bareTitle(t)) === key);
    if (byTitle.length === 1) { const f = defaultFile(byTitle[0]); if (f) return { track: byTitle[0], file: f, by: 'title' }; }
    if (byTitle.length > 1) return { ambiguous: byTitle };
    const fileHits = [];
    for (const t of tracks) for (const f of (t.files || [])) if (normBgmKey(f.file).includes(key)) fileHits.push({ track: t, file: f });
    if (fileHits.length === 1) return { ...fileHits[0], by: 'file-part' };
    const hitTracks = [...new Set(fileHits.map((h) => h.track))];
    if (hitTracks.length === 1) { const f = defaultFile(hitTracks[0]); if (f) return { track: hitTracks[0], file: f, by: 'file-part' }; }
    if (hitTracks.length > 1) return { ambiguous: hitTracks };
  }
  return null;
}

/**
 * 从 caption 里认「选曲：17｜Groovy Hammond」这种写法（Agent 只在 caption 里记了选曲、没传 music_id 时的兜底）。
 * 必须同时满足：出现「选曲」二字、编号在曲库内、编号后紧跟的曲名与该编号的曲名对得上 —— 三者缺一即返回 null，
 * 不按模糊文字猜曲。只取第一处（「备选 22｜…」不算）。
 */
export function pickFromCaption(map, caption) {
  const text = String(caption == null ? '' : caption);
  if (!map || !text) return null;
  const m = /选曲[^：:\n]{0,12}[：:]\s*(?:按?康康合集(?:指南)?(?:选定)?\s*[：:]?\s*)?0*(\d{1,2})\s*[｜|]\s*([^\n（(。；;，,]{1,60})/.exec(text);
  if (!m) return null;
  const no = String(Number(m[1])).padStart(2, '0');
  const t = (map.tracks || []).find((x) => String(x.no) === no);
  if (!t) return null;
  const said = normBgmKey(m[2]);
  const want = normBgmKey(bareTitle(t));
  if (!said || !want || !(said === want || said.startsWith(want))) return null;
  const f = defaultFile(t);
  return f ? { track: t, file: f, by: 'caption' } : null;
}

/** 曲库文件的绝对路径；文件名越界（含路径分隔符 / ..）或文件不存在返回 null。 */
export function libraryFileAbs(map, file) {
  const name = String((file && file.file) || '');
  if (!map || !name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) return null;
  const dir = path.resolve(map.library_dir);
  const abs = path.resolve(dir, name);
  if (path.dirname(abs) !== dir) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

export function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** "2:34" / "1:02:03" → 秒；解析不了返回 0。 */
export function durationSeconds(s) {
  const parts = String(s == null ? '' : s).trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 写进素材 description 的标签（情绪 / 适用场景 / 不宜套用），供人在素材库里看、也供 list_assets 读。 */
export function trackDescription(track) {
  const t = track || {};
  let s = '来源：康康合集-BGM情绪与使用指南 第' + t.no + '｜' + t.title + '。情绪：' + (t.emotion || '') + ' 适用场景：' + (t.scenes || '') + ' 不宜套用：' + (t.avoid || '');
  if (t.note) s += ' 版本提醒：' + t.note;
  return s;
}

/** 「17｜Groovy Hammond」。 */
export function trackLabel(track) {
  return track ? (track.no + '｜' + track.title) : '';
}

/** 给报错/提示用的短目录：「01 囚笼、02 try、…」。 */
export function libraryCatalogLine(map) {
  if (!map) return '';
  return (map.tracks || []).map((t) => t.no + ' ' + t.title).join('、');
}
