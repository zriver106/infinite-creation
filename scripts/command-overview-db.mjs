// 总览：ic.db 只读统计（在 worker 线程里跑，主线程限时；数据库只读打开）
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const { dbPath, project, mode, now } = workerData;
const TZ = 'America/Los_Angeles';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const ptParts = (ms) => { const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return o; };
const ptDay = (ms) => { const p = ptParts(ms); return `${p.year}-${p.month}-${p.day}`; };
function ptMidnight(ms) { const p = ptParts(ms); for (const off of [8, 7]) { const t = Date.UTC(+p.year, +p.month - 1, +p.day, off); if (ptParts(t).hour === '00' && ptDay(t) === ptDay(ms)) return t; } return Date.UTC(+p.year, +p.month - 1, +p.day, 8); }
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const chNo = (t) => { const m = /第(\d+)章/.exec(t || ''); return m ? Number(m[1]) : null; };
const timings = [];
function q(db, label, sql, ...args) { const t = Date.now(); const r = db.prepare(sql).all(...args); timings.push({ label, ms: Date.now() - t, rows: r.length }); return r; }

function busyUnion(jobs, from, to) {
  const iv = [];
  for (const j of jobs) { const a = Number(j.started_at); const b = j.finished_at ? Number(j.finished_at) : (j.status === 'running' ? to : null); if (!a || !b || b < from || a > to) continue; iv.push([Math.max(a, from), Math.min(b, to)]); }
  iv.sort((x, y) => x[0] - y[0]);
  let busy = 0, cur = null; const gaps = [];
  for (const [a, b] of iv) { if (!cur) { cur = [a, b]; continue; } if (a <= cur[1]) cur[1] = Math.max(cur[1], b); else { busy += cur[1] - cur[0]; gaps.push([cur[1], a]); cur = [a, b]; } }
  if (cur) busy += cur[1] - cur[0];
  if (iv.length && iv[0][0] - from >= 120000) gaps.unshift([from, iv[0][0]]);
  if (cur && to - cur[1] >= 120000) gaps.push([cur[1], to]);
  return { busy, gaps, n: iv.length };
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const out = { mode, timings, at: now };
try {
  const T0 = ptMidnight(now);
  if (mode === 'core') {
    out.totalChapters = q(db, 'chapters', 'select count(*) n from chapters where project_id=?', project)[0].n;
    const shots = q(db, 'shots', 'select id,chapter,status,video_path,duration,created_at from shots where project_id=?', project);
    const by = new Map();
    for (const s of shots) { if (s.status === 'obsolete') continue; const n = chNo(s.chapter); if (!n) continue; if (!by.has(n)) by.set(n, []); by.get(n).push(s); }
    const allDone = [], partial = [];
    for (const [n, L] of by) { const d = L.filter((s) => s.status === 'done' && s.video_path).length; (d === L.length ? allDone : partial).push({ ch: n, done: d, total: L.length }); }
    allDone.sort((a, b) => a.ch - b.ch); partial.sort((a, b) => a.ch - b.ch);
    out.chaptersWithShots = by.size; out.allDone = allDone.map((x) => x.ch); out.partial = partial;
    out.liveShots = shots.filter((s) => s.status !== 'obsolete').length;
    out.shotStatus = {}; for (const s of shots) out.shotStatus[s.status] = (out.shotStatus[s.status] || 0) + 1;
    out.avgShotsDoneCh = allDone.length ? allDone.reduce((a, x) => a + x.total, 0) / allDone.length : null;
    out.selectedDoneMin = shots.filter((s) => s.status === 'done' && s.video_path).reduce((a, s) => a + (Number(s.duration) || 0), 0) / 60;
    out.firstShotAt = {}; for (const [n, L] of by) out.firstShotAt[n] = Math.min(...L.map((s) => Number(s.created_at) || Infinity));
    const live = new Set(shots.filter((s) => s.status !== 'obsolete').map((s) => s.id));
    const dur = new Map(shots.map((s) => [s.id, Number(s.duration) || 0]));
    const sv = q(db, 'shot_videos', 'select shot_id,created_at,selected from shot_videos where project_id=?', project);
    const today = sv.filter((v) => Number(v.created_at) >= T0);
    out.todayVideos = today.length; out.todayGenMin = today.reduce((a, v) => a + (dur.get(v.shot_id) || 0), 0) / 60;
    out.todaySelectedMin = today.filter((v) => Number(v.selected) === 1).reduce((a, v) => a + (dur.get(v.shot_id) || 0), 0) / 60;
    out.todaySelectedN = today.filter((v) => Number(v.selected) === 1).length;
    out.allVideos = sv.length; out.allGenMin = sv.reduce((a, v) => a + (dur.get(v.shot_id) || 0), 0) / 60;
    const per = new Map(); for (const v of sv) { if (!live.has(v.shot_id)) continue; per.set(v.shot_id, (per.get(v.shot_id) || 0) + 1); }
    out.shotsWithVideo = per.size; out.shotsOneVideo = [...per.values()].filter((x) => x === 1).length;
    out.videosPerShot = per.size ? [...per.values()].reduce((a, b) => a + b, 0) / per.size : null;
    const regen = q(db, 'jobs regen', "select status,started_at,finished_at from jobs where project_id=? and type='regenerate'", project);
    const okd = regen.filter((j) => j.status === 'done' && j.started_at && j.finished_at).map((j) => ({ f: Number(j.finished_at), s: (Number(j.finished_at) - Number(j.started_at)) / 1000 }));
    const d48 = okd.filter((x) => x.f >= now - 48 * 3600e3).map((x) => x.s);
    out.regen = { n48: d48.length, median48: median(d48), p80_48: pct(d48, 0.8), mean48: mean(d48), nAll: okd.length, medianAll: median(okd.map((x) => x.s)), done: regen.filter((j) => j.status === 'done').length, failed: regen.filter((j) => j.status === 'failed').length, failedToday: regen.filter((j) => j.status === 'failed' && Number(j.finished_at || j.started_at) >= T0).length, running: regen.filter((j) => j.status === 'running').length };
    const all = q(db, 'jobs all', "select status,started_at,finished_at from jobs where type in ('regenerate','create') and started_at is not null and (finished_at is null or finished_at>=?)", T0 - 86400e3);
    const u = busyUnion(all, T0, now);
    out.gpuToday = { busyMs: u.busy, spanMs: now - T0, occupancy: (now - T0) ? u.busy / (now - T0) : null, gaps: u.gaps.filter(([a, b]) => b - a >= 120000).map(([a, b]) => ({ from: a, min: (b - a) / 60000 })), smallGapMin: u.gaps.filter(([a, b]) => b - a < 120000).reduce((x, [a, b]) => x + (b - a), 0) / 60000 };
    const ex = q(db, 'jobs export', "select status,started_at,finished_at from jobs where project_id=? and type='export' and started_at>=?", project, T0);
    out.exportsToday = { done: ex.filter((j) => j.status === 'done').length, failed: ex.filter((j) => j.status === 'failed').length, times: ex.filter((j) => j.status === 'done').map((j) => Number(j.finished_at || j.started_at)) };
    const ctx = q(db, 'project', 'select name,context from projects where id=?', project)[0];
    out.projectName = ctx?.name; try { out.deliveryDir = JSON.parse(ctx?.context || '{}').delivery_dir || null; } catch { out.deliveryDir = null; }
  } else if (mode === 'edits') {
    // 每个镜头「最后一次改内容字段」的时间（change_logs 里 before/after 真有变化的那次），和最新视频生成时间比
    // 2026-11-25（Andy：规则区一片红是遗留问题，清理干净）：只算会改变画面的内容字段；补绑定（人物/场景/道具/服装…）和分辨率等不算「改过稿」，
    // 否则凌晨那批 B 类补绑会把已交付的集全标成「改过字段、晚于最新视频」。
    const CONTENT = ['scene_name', 'camera', 'visual', 'dialogue', 'narration', 'sub_shots', 'duration', 'video_prompt', 'mode'];
    const shots = q(db, 'shots', 'select id,chapter,idx from shots where project_id=?', project);
    const vmax = new Map(q(db, 'shot_videos max', 'select shot_id, max(created_at) m from shot_videos where project_id=? group by shot_id', project).map((r) => [r.shot_id, Number(r.m)]));
    const t0 = Date.now(); const last = new Map(); let n = 0;
    for (const r of db.prepare("select entity_id, ts, before, after, action from change_logs where project_id=? and entity='shot' order by ts").iterate(project)) {
      n++; let b = {}, a = {}; try { b = JSON.parse(r.before || '{}') || {}; a = JSON.parse(r.after || '{}') || {}; } catch {}
      const ch = r.action === 'create' ? ['create'] : CONTENT.filter((k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      if (ch.length) last.set(r.entity_id, { ts: Number(r.ts), fields: ch });
    }
    timings.push({ label: 'change_logs', ms: Date.now() - t0, rows: n });
    out.edits = shots.map((s) => { const e = last.get(s.id); const v = vmax.get(s.id) || 0; return e && e.ts > v + 1000 ? { id: s.id, ch: s.chapter, idx: s.idx, lastEdit: e.ts, fields: e.fields, newestVideo: v || null } : null; }).filter(Boolean);
    out.shotsTotal = shots.length; out.logRows = n;
  } else if (mode === 'trends') {
    const sv = q(db, 'shot_videos', 'select shot_id,created_at from shot_videos where project_id=? order by created_at', project);
    const days = []; for (let i = 6; i >= 0; i--) { const t = ptMidnight(now - i * 86400e3); days.push({ day: ptDay(t), from: t }); }
    for (let i = 0; i < days.length; i++) days[i].to = i + 1 < days.length ? days[i + 1].from : now;
    const first = new Map(), cnt = new Map();
    for (const v of sv) { const t = Number(v.created_at); if (!first.has(v.shot_id)) first.set(v.shot_id, t); cnt.set(v.shot_id, cnt.get(v.shot_id) || []); cnt.get(v.shot_id).push(t); }
    const jobs = q(db, 'jobs 7d', "select status,started_at,finished_at from jobs where type in ('regenerate','create') and started_at is not null and (finished_at is null or finished_at>=?)", days[0].from - 86400e3);
    out.days = days.map((d) => {
      const videos = sv.filter((v) => Number(v.created_at) >= d.from && Number(v.created_at) < d.to).length;
      // 一次出好（按首次生成日期归属，观察窗 3 天后定格：只数首次生成后 3 天内的重渲）
      const born = [...first.entries()].filter(([, t]) => t >= d.from && t < d.to);
      const one = born.filter(([id, t]) => cnt.get(id).filter((x) => x <= t + 3 * 86400e3).length === 1).length;
      const settled = now - d.to >= 3 * 86400e3;
      const u = busyUnion(jobs, d.from, d.to);
      return { day: d.day, videos, firstGen: born.length, oneShot: one, oneShotRate: born.length ? one / born.length : null, settled, occupancy: (d.to - d.from) ? u.busy / (d.to - d.from) : null };
    });
  } else if (mode === 'gpu') {
    // GPU 面板：IC 里在跑/排队的任务、今天出片、最近 8 条出片（带来源任务 id）、最近 12 小时每小时条数、今天任务并集忙闲
    const shotOf = db.prepare('select chapter,idx,duration from shots where id=?');
    const act = q(db, 'jobs active', "select id,type,status,project_id,detail,started_at,updated_at from jobs where status in ('running','queued','pending') order by started_at");
    out.active = act.map((j) => { let d = {}; try { d = JSON.parse(j.detail || '{}') || {}; } catch {} const s = d.shot_id ? shotOf.get(d.shot_id) : null; return { id: j.id, type: j.type, status: j.status, project: j.project_id, startedAt: Number(j.started_at) || null, shotId: d.shot_id || null, ch: s?.chapter || null, idx: s?.idx ?? d.idx ?? null }; });
    out.lastGenFinished = Number(q(db, 'jobs last done', "select max(finished_at) m from jobs where type in ('regenerate','create') and finished_at is not null")[0].m) || null;
    const sv = q(db, 'shot_videos today', 'select sv.shot_id,sv.created_at,sv.selected,s.chapter,s.idx,s.duration from shot_videos sv left join shots s on s.id=sv.shot_id where sv.project_id=? and sv.created_at>=?', project, Math.min(T0, now - 12 * 3600e3));
    const today = sv.filter((v) => Number(v.created_at) >= T0);
    out.today = { videos: today.length, selected: today.filter((v) => Number(v.selected) === 1).length, unselected: today.filter((v) => Number(v.selected) !== 1).length };
    out.today.failedJobs = q(db, 'jobs failed today', "select count(*) n from jobs where project_id=? and type in ('regenerate','create') and status='failed' and coalesce(finished_at,started_at)>=?", project, T0)[0].n;
    const hours = []; const H0 = Math.floor(now / 3600e3) * 3600e3; for (let i = 11; i >= 0; i--) { const a = H0 - i * 3600e3; hours.push({ from: a, n: sv.filter((v) => Number(v.created_at) >= a && Number(v.created_at) < a + 3600e3).length }); }
    out.hourly = hours;
    const recent = q(db, 'shot_videos recent', 'select sv.id,sv.shot_id,sv.created_at,sv.selected,s.chapter,s.idx,s.duration from shot_videos sv left join shots s on s.id=sv.shot_id where sv.project_id=? order by sv.created_at desc limit 8', project);
    const jobOf = db.prepare("select id from jobs where type in ('regenerate','create') and detail like '%' || ? || '%' and finished_at between ? and ? order by abs(finished_at-?) limit 1");
    out.recent = recent.map((v) => { const t = Number(v.created_at); let job = null; try { job = jobOf.get(v.shot_id, t - 30000, t + 30000, t)?.id || null; } catch {} return { id: v.id, at: t, ch: v.chapter, idx: v.idx, dur: v.duration == null ? null : Number(v.duration), selected: Number(v.selected) === 1, job }; });
    const all = q(db, 'jobs today', "select status,started_at,finished_at from jobs where type in ('regenerate','create') and started_at is not null and (finished_at is null or finished_at>=?)", T0 - 86400e3);
    const u = busyUnion(all, T0, now);
    out.busyToday = { busyMs: u.busy, spanMs: now - T0 };
  } else if (mode === 'capacity') {
    // 产能四档：今天 / 昨天 / 最近 7 天 / 最近 30 天（按太平洋时间分天）
    const Y0 = ptMidnight(T0 - 12 * 3600e3);
    const D7 = ptMidnight(now - 6 * 86400e3), D30 = ptMidnight(now - 29 * 86400e3);
    const wins = [{ id: 'today', label: '今天', from: T0, to: now }, { id: 'yesterday', label: '昨天', from: Y0, to: T0 }, { id: 'd7', label: '最近 7 天', from: D7, to: now }, { id: 'd30', label: '最近 30 天', from: D30, to: now }];
    const jobs = q(db, 'jobs 30d', "select project_id,type,status,started_at,finished_at from jobs where type in ('regenerate','create') and started_at is not null and (finished_at is null or finished_at>=?)", D30 - 86400e3);
    const firstJob = Number(q(db, 'jobs first', "select min(started_at) m from jobs where type in ('regenerate','create') and started_at is not null")[0].m) || null;
    const sv = q(db, 'shot_videos 30d', 'select sv.created_at,sv.selected,s.duration from shot_videos sv left join shots s on s.id=sv.shot_id where sv.project_id=? and sv.created_at>=?', project, D30);
    out.firstJobAt = firstJob;
    out.windows = wins.map((w) => {
      const from = firstJob && firstJob > w.from ? firstJob : w.from; // 早于第一条任务记录的部分算「无数据」，不计入闲
      const u = busyUnion(jobs, from, w.to);
      const span = Math.max(0, w.to - from);
      const v = sv.filter((x) => Number(x.created_at) >= w.from && Number(x.created_at) < w.to);
      const sel = v.filter((x) => Number(x.selected) === 1);
      const mine = jobs.filter((j) => j.project_id === project && Number(j.finished_at || j.started_at) >= w.from && Number(j.finished_at || j.started_at) < w.to);
      const durs = mine.filter((j) => j.status === 'done' && j.finished_at && j.type === 'regenerate').map((j) => (Number(j.finished_at) - Number(j.started_at)) / 1000).filter((x) => x > 0);
      return { id: w.id, label: w.label, from: w.from, to: w.to, noDataMs: from - w.from, busyMs: u.busy, idleMs: Math.max(0, span - u.busy), util: span ? u.busy / span : null, total: v.length, selected: sel.length, unselected: v.length - sel.length, failedJobs: mine.filter((j) => j.status === 'failed').length, effRate: v.length ? sel.length / v.length : null, effMin: sel.reduce((a, x) => a + (Number(x.duration) || 0), 0) / 60, perShotSec: median(durs), perShotN: durs.length };
    });
    // 今天的忙闲时间条：忙段（任务区间并集）
    const iv = []; for (const j of jobs) { const a = Number(j.started_at); const b = j.finished_at ? Number(j.finished_at) : (j.status === 'running' ? now : null); if (!a || !b || b < T0 || a > now) continue; iv.push([Math.max(a, T0), Math.min(b, now)]); }
    iv.sort((x, y) => x[0] - y[0]); const segs = []; for (const [a, b] of iv) { const l = segs[segs.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else segs.push([a, b]); }
    out.todayBar = { from: T0, to: now, dayEnd: ptMidnight(T0 + 36 * 3600e3), busy: segs, noDataBefore: firstJob && firstJob > T0 ? firstJob : null };
    const H0 = Math.floor(now / 3600e3) * 3600e3; out.hourly = []; for (let i = 11; i >= 0; i--) { const a = H0 - i * 3600e3; out.hourly.push({ from: a, n: sv.filter((x) => Number(x.created_at) >= a && Number(x.created_at) < a + 3600e3).length }); }
  }
} catch (e) { out.error = String(e.message || e); }
finally { try { db.close(); } catch {} }
parentPort.postMessage(out);
