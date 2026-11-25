// 问题行 ↔ 镜头关联（只读推算 + 人工改正文件）
// 推算：问题行里的时间点（如「1分17秒」「38秒」「3分09」）→ 该集当前选用镜头按顺序拼起来的时间轴（ffprobe 实测每条选用视频时长）→ 落在哪一镜。
// 只读 ic.db（readOnly）、只读视频文件；人工改正只写预览自己的目录（LINKS_FILE）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/tmp_infinite_creation/infinite-creation/data/ic.db';
const PROJ_DIR = 'C:\\tmp_infinite_creation\\infinite-creation\\data\\projects';
const PROJECT = '51ed8141-419f-4cf6-af96-406142970482';

// ---------- ffprobe（按 路径+大小+修改时间 缓存） ----------
const probeCache = new Map(); let running = 0; const waitQ = [];
function probe(f) {
  return new Promise(async (resolve) => {
    const st = await fsp.stat(f).catch(() => null); if (!st) return resolve(null);
    const k = `${f}|${st.size}|${st.mtimeMs}`; if (probeCache.has(k)) return resolve(probeCache.get(k));
    const go = () => { running++; execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { timeout: 15000, windowsHide: true }, (e, out) => { running--; const d = e ? null : Number(String(out).trim()) || null; if (d) probeCache.set(k, d); resolve(d); const n = waitQ.shift(); if (n) n(); }); };
    if (running >= 3) waitQ.push(go); else go();
  });
}

// ---------- 时间点解析 ----------
export function parseTimes(text) {
  const out = []; const t = String(text);
  const re = /(\d{1,2})\s*分\s*(\d{1,2})?\s*秒?|(\d{1,3})\s*秒/g; let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 2), m.index);
    if (m[3] && /[\d\-–~]$/.test(before)) continue; // 「多3-4秒」这类是时长，不是时间点
    if (m[3] && /(多|延长|短|长)\s*$/.test(t.slice(Math.max(0, m.index - 3), m.index))) continue;
    const sec = m[3] != null ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] || 0);
    out.push({ sec, raw: m[0].trim() });
  }
  if (!out.length && /^(开头|开场|一开始)/.test(t.trim())) out.push({ sec: 0, raw: '开头' });
  else if (/开头/.test(t) && !out.some((x) => x.sec === 0)) out.unshift({ sec: 0, raw: '开头' });
  return out;
}

// ---------- 每集时间轴 ----------
let db = null;
function q(sql, ...a) { if (!db) db = new DatabaseSync(DB, { readOnly: true }); return db.prepare(sql).all(...a); }
const tlCache = new Map(); // ep -> { at, v }
export async function timeline(ep, deliveryDir) {
  const c = tlCache.get(ep); if (c && Date.now() - c.at < 120000) return c.v;
  const rows = q(`SELECT s.id, s.idx, s.status, s.duration, s.video_path sp, s.updated_at, v.video_path vp, v.created_at vat
    FROM shots s LEFT JOIN shot_videos v ON v.shot_id = s.id AND v.selected = 1
    WHERE s.project_id = ? AND s.chapter = ? AND s.status != 'obsolete' ORDER BY s.idx`, PROJECT, `第${ep}章`);
  const shots = []; let t = 0; let probed = 0, planned = 0;
  for (const r of rows) {
    const rel = r.vp || r.sp; const f = rel ? path.join(PROJ_DIR, PROJECT, rel) : null;
    let d = f ? await probe(f) : null; let src = 'ffprobe'; if (d) probed++; else { d = Number(r.duration) || 0; planned++; src = '计划时长'; }
    shots.push({ idx: r.idx, id: r.id, status: r.status, start: t, end: t + d, dur: d, durSrc: src, selectedAt: r.vat || null });
    t += d;
  }
  let epFile = null, epDur = null, epMtime = null;
  if (deliveryDir) { const f = path.join(deliveryDir, `EP${ep}.mp4`); const st = await fsp.stat(f).catch(() => null); if (st) { epFile = f; epMtime = st.mtimeMs; epDur = await probe(f); } }
  const changedAfterExport = epMtime ? shots.filter((s) => s.selectedAt && s.selectedAt > epMtime).map((s) => s.idx) : [];
  const v = { ep, shots, total: t, probed, planned, epFile, epDur, epMtime, drift: epDur != null ? Math.round((epDur - t) * 10) / 10 : null, changedAfterExport };
  tlCache.set(ep, { at: Date.now(), v }); return v;
}

// ---------- 人工改正 ----------
let linksFile = null; let manual = {}; let manualMtime = 0;
export function linksInit(f) { linksFile = f; }
async function loadManual() { if (!linksFile) return; const st = await fsp.stat(linksFile).catch(() => null); if (!st) { manual = {}; return; } if (st.mtimeMs === manualMtime) return; manualMtime = st.mtimeMs; try { manual = JSON.parse((await fsp.readFile(linksFile, 'utf8')).replace(/^\uFEFF/, '')); } catch { manual = {}; } }
export const linkKey = (ep, text) => `${ep}|${String(text).replace(/\s*-{2,}\s*(完成☑️|完成|修改中|待修改).*$/, '').trim()}`;
export async function setManual(ep, text, shots, by, note) {
  if (!linksFile) throw new Error('关联文件未配置');
  await loadManual();
  const k = linkKey(ep, text);
  const arr = (Array.isArray(shots) ? shots : String(shots).split(/[\s,，、#]+/)).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0 && x < 1000);
  if (arr.length) manual[k] = { shots: [...new Set(arr)].sort((a, b) => a - b), by, at: new Date().toISOString(), note: note || '' }; else delete manual[k];
  await fsp.mkdir(path.dirname(linksFile), { recursive: true });
  if (fs.existsSync(linksFile)) await fsp.copyFile(linksFile, linksFile + '.bak');
  await fsp.writeFile(linksFile, JSON.stringify(manual, null, 2)); manualMtime = 0;
  return { key: k, value: manual[k] || null };
}

// ---------- 每个关联镜头现在在哪一步 ----------
function shotState(ep, s, tl, gpu, ic) {
  const ch = `第${ep}章`;
  for (const c of gpu?.chains || []) {
    const hit = (c.shots || []).find((x) => (x.id && s.id && (s.id.startsWith(x.id) || x.id.startsWith(s.id.slice(0, 8)))) || (x.ch === ch && x.num === s.idx));
    if (!hit || c.state === 'done' && hit.done) continue;
    if (hit.done) continue;
    if (c.state === 'running') return { step: c.current && c.current.ch === ch && c.current.num === s.idx ? '出片中' : '排队出片', chain: c.label, fixing: true };
    if (['waiting', 'ready'].includes(c.state) || c.waiterArmed || c.approvedWaiting) return { step: '排队出片', chain: c.label, fixing: true, how: c.waiterArmed ? '已由等待器挂好' : c.approvedWaiting ? '已放行待挂' : c.reviewPending ? '待审' : c.state === 'waiting' ? '已挂起' : '脚本就绪未启动' };
  }
  const icS = ic?.v ? ic.v.find((x) => x.id === s.id) : null;
  if (icS && icS.promptChanged && icS.updated > icS.newestVideo) return { step: '已写库待排链', fixing: true };
  if (icS && tl.epMtime && icS.newestVideo > tl.epMtime) return { step: '有新片待审/导出', fixing: true };
  return { step: '没在修', fixing: false };
}

// eps: [{ no, items: [{ text, status }] }]；返回同结构，每条加 links
export async function linkEpisodes(eps, { gpu, ic, deliveryDir, onlyOpen = false }) {
  await loadManual();
  const out = [];
  for (const e of eps) {
    const needTl = e.items.some((it) => (!onlyOpen || it.status !== 'done'));
    const tl = needTl ? await timeline(e.no, deliveryDir).catch((err) => ({ error: String(err.message || err), shots: [] })) : null;
    const items = [];
    for (const it of e.items) {
      if (onlyOpen && it.status === 'done') { items.push({ ...it, links: null }); continue; }
      const k = linkKey(e.no, it.text); const man = manual[k];
      let shots = [], src = null, times = [], why = null;
      if (man) { src = 'manual'; shots = man.shots; }
      else {
        times = parseTimes(it.text);
        if (!times.length) why = '问题行里没有时间点（缺时间点，可人工关联）';
        else if (!tl || !tl.shots.length) why = tl?.error ? `时间轴读取失败：${tl.error}` : '本集还没有镜头';
        else { src = 'auto'; for (const tm of times) { const hit = tl.shots.filter((s) => tm.sec >= s.start - 0.8 && tm.sec < s.end + 0.8); for (const h of hit) if (!shots.includes(h.idx)) shots.push(h.idx); if (!hit.length) why = `时间点 ${tm.raw} 超出本集时间轴（共 ${Math.round(tl.total)} 秒）`; } }
      }
      const det = shots.map((n) => { const s = tl?.shots.find((x) => x.idx === n) || { idx: n, id: null }; return { idx: n, id: s.id, ...shotState(e.no, s, tl || {}, gpu, ic) }; });
      items.push({ ...it, links: { key: k, src, shots: det, times: times.map((x) => x.raw), why, manual: man || null, estimate: src === 'auto', fixing: det.some((d) => d.fixing) } });
    }
    out.push({ ...e, items, timeline: tl ? { total: Math.round(tl.total * 10) / 10, shots: tl.shots.length, probed: tl.probed, planned: tl.planned, epDur: tl.epDur ? Math.round(tl.epDur * 10) / 10 : null, drift: tl.drift, changedAfterExport: tl.changedAfterExport, error: tl.error || null } : null });
  }
  return out;
}
