// 用量卡切换（2026-11-26 Andy：「这个是显卡的还是 claude 的 不如做个按钮切换下」「都安排吧」）：Codex 用量、显卡占用。
// 只读：Codex 会话日志只取 token_count 数字，不读正文；ic.db 只读打开。日期窗口函数由 command-overview.mjs 注入（usageInit），口径和 Claude 用量一致。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let ptDayOf, WIN_DEF, winDays, ptMidnightIso, openRo;
export function usageInit(d) { ({ ptDayOf, WIN_DEF, winDays, ptMidnightIso, openRo } = d); }

// --- Codex 用量（2026-11-26 Andy：用量卡加 Claude / Codex / 显卡切换）：~/.codex/sessions/**/*.jsonl 的 event_msg token_count，
// 按文件里 total_token_usage 的增量算（同一条重复上报不重复计），按太平洋时间日汇总；5 分钟刷新。只读数字，不读会话正文。
const CODEX_SESSIONS = process.env.CMD_CODEX_SESSIONS || path.join(process.env.USERPROFILE || 'C:\\Users\\usazr', '.codex', 'sessions');
const cxFiles = new Map(); // file -> { size, offset, rest, prev, days }
let cxState = { at: 0, running: null, data: null, error: null };
async function scanCodexFile(f, st) {
  let c = cxFiles.get(f);
  if (c && c.size === st.size) return;
  if (!c || st.size < c.size) { c = { size: 0, offset: 0, rest: '', prev: null, days: new Map() }; cxFiles.set(f, c); }
  await new Promise((resolve) => {
    const s = fs.createReadStream(f, { start: c.offset, encoding: 'utf8', highWaterMark: 1 << 20 });
    s.on('data', (chunk) => {
      const t = c.rest + chunk; const k = t.lastIndexOf('\n'); if (k < 0) { c.rest = t; return; }
      c.rest = t.slice(k + 1);
      for (const line of t.slice(0, k).split('\n')) {
        if (line.indexOf('"token_count"') < 0 || line.indexOf('total_token_usage') < 0) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j?.payload?.info?.total_token_usage; if (!u || !j.timestamp) continue;
        const p = c.prev || { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
        if ((u.input_tokens || 0) < (p.input_tokens || 0)) { c.prev = u; continue; } // 计数回卷（新线程）：只记基准
        const dIn = (u.input_tokens || 0) - (p.input_tokens || 0); const dCr = (u.cached_input_tokens || 0) - (p.cached_input_tokens || 0);
        const dCc = (u.cache_write_input_tokens || 0) - (p.cache_write_input_tokens || 0); const dOut = (u.output_tokens || 0) - (p.output_tokens || 0);
        c.prev = u;
        if (!(dIn || dOut)) continue;
        const day = ptDayOf(Date.parse(j.timestamp)); let d = c.days.get(day); if (!d) { d = { in: 0, out: 0, cr: 0, cc: 0, n: 0 }; c.days.set(day, d); }
        d.in += Math.max(0, dIn - dCr); d.cr += Math.max(0, dCr); d.cc += Math.max(0, dCc); d.out += Math.max(0, dOut); d.n++;
      }
    });
    s.on('end', resolve); s.on('error', resolve);
  });
  c.size = st.size; c.offset = st.size;
}
export async function codexScan() {
  const since = Date.now() - 31 * 86400e3;
  const names = await fsp.readdir(CODEX_SESSIONS, { recursive: true }).catch(() => null);
  if (!names) return { windows: WIN_DEF.map((w) => ({ id: w.id, label: w.label, in: 0, out: 0, cr: 0, cc: 0, n: 0, total: 0 })), files: 0, note: '读不到 ~/.codex/sessions（本机没跑过 Codex）' };
  let files = 0;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(CODEX_SESSIONS, n); const st = await fsp.stat(f).catch(() => null);
    if (!st || !st.isFile() || st.mtimeMs < since) continue;
    files++; await scanCodexFile(f, st);
  }
  const all = new Map(); for (const c of cxFiles.values()) for (const [d, v] of c.days) { const a = all.get(d) || { in: 0, out: 0, cr: 0, cc: 0, n: 0 }; for (const k in v) a[k] += v[k]; all.set(d, a); }
  const windows = WIN_DEF.map((w) => { const s = { id: w.id, label: w.label, in: 0, out: 0, cr: 0, cc: 0, n: 0 }; for (const d of winDays(w)) { const v = all.get(d); if (v) for (const k in v) s[k] += v[k]; } s.total = s.in + s.out + s.cr + s.cc; return s; });
  return { windows, files, note: '~/.codex/sessions 下 31 天内改过的 *.jsonl，token_count 事件里累计用量的增量按太平洋时间日求和；输入＝input−cached，缓存读＝cached_input；只含本机 Codex' };
}
export function codexNow() {
  if (!cxState.running && Date.now() - cxState.at > 300e3) {
    cxState.running = codexScan().then((d) => { cxState = { at: Date.now(), running: null, data: d, error: null }; }).catch((e) => { cxState = { ...cxState, at: Date.now(), running: null, error: String(e.message || e) }; });
  }
  return cxState.data ? { ...cxState.data, at: new Date(cxState.at).toISOString(), refreshing: !!cxState.running } : cxState.error ? { error: cxState.error } : { pending: true };
}

// --- 显卡占用（同上）：ic.db 只读，jobs 里占 GPU 的任务（出片 regenerate、整章出片 create[gpu]、音色 voice-clone / design-voice、资产出图）
// started_at–finished_at 取并集（重叠只算一次，含所有项目）；按窗口切开。不含绕过 IC 直接交 8189 的任务。5 分钟刷新。
const GPU_TYPES = new Set(['regenerate', 'chapter-video', 'asset-image', 'voice-design', 'voice-clone', 'costume', 'age', 'music']);
let gpuUseState = { at: 0, data: null };
export function _resetUsageCache() { gpuUseState = { at: 0, data: null }; cxState = { at: 0, running: null, data: null, error: null }; cxFiles.clear(); }
export function gpuUseNow() {
  if (gpuUseState.data && Date.now() - gpuUseState.at < 300e3) return gpuUseState.data;
  let d;
  try {
    const db = openRo();
    try {
      const since = Date.now() - 32 * 86400e3;
      const rows = db.prepare("select type, status, started_at, finished_at, json_extract(checkpoint,'$.queue') q from jobs where started_at >= ?").all(since);
      const now = Date.now();
      const iv = []; const jobs = [];
      for (const r of rows) {
        const gpu = GPU_TYPES.has(r.type) || (r.type === 'create' && r.q !== 'text');
        if (!gpu) continue;
        const a = Number(r.started_at); const b = r.finished_at ? Number(r.finished_at) : (r.status === 'running' ? now : null);
        if (!a || !b || b <= a) continue;
        iv.push([a, b]); jobs.push({ a, b, ok: r.type === 'regenerate' && r.status === 'done', fail: r.status === 'failed' });
      }
      iv.sort((x, y) => x[0] - y[0]);
      const merged = []; for (const [a, b] of iv) { const L = merged[merged.length - 1]; if (L && a <= L[1]) L[1] = Math.max(L[1], b); else merged.push([a, b]); }
      const overlap = (from, to) => merged.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
      const windows = WIN_DEF.map((w) => {
        const days = winDays(w); const from = Date.parse(ptMidnightIso(days[days.length - 1])); const last = days[0];
        const nextDay = ptDayOf(Date.parse(ptMidnightIso(last)) + 26 * 3600e3);
        const to = Math.min(now, Date.parse(ptMidnightIso(nextDay)));
        const busy = overlap(from, to); const inWin = jobs.filter((j) => j.a >= from && j.a < to);
        return { id: w.id, label: w.label, busyH: busy / 3600e3, spanH: Math.max(0, to - from) / 3600e3, util: to > from ? busy / (to - from) : 0, renders: inWin.filter((j) => j.ok).length, failed: inWin.filter((j) => j.fail).length, jobs: inWin.length };
      });
      d = { windows, note: 'ic.db jobs 里占显卡的任务（出片、整章出片、音色、资产出图）开始–结束时间取并集，重叠只算一次，含所有项目；占用率＝占用时长÷时段长度（今天算到现在）；不含绕过 IC 直接交 8189 的任务' };
    } finally { try { db.close(); } catch {} }
  } catch (e) { d = { error: 'ic.db：' + String(e.message || e) }; }
  gpuUseState = { at: Date.now(), data: { ...d, at: new Date().toISOString() } };
  return gpuUseState.data;
}

