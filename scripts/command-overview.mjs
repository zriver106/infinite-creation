// 指挥系统「总览」（按 总览设计稿.md 46A57B04 实现）。全部只读：
// ic.db 只读打开（worker 线程，限时）；交付目录只用 ffprobe 读；chain.log 增量读；进程表只读；问题描述.txt 只读（桌面正式文件，不写）。
// 缓存只放内存，不落盘。
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { codexNow, gpuUseNow, usageInit } from './command-usage.mjs';
import { gpuQueue, issuesForOverview, writeLead, logCacheStats, issuesCfg, issueItems, readLogLines } from './command-issues.mjs';
import { PRIORITY_RULES, DISPATCH_RULES, MODEL_TABLE, DECISION_RULES, RELEASE_FIELDS, checkRelease, GATE_MD5 } from './command-rules.mjs';
function releaseChecks() { const a = (issuesCfg() || {}).approvals || {}; return Object.entries(a).map(([key, r]) => ({ key, at: r && r.at || null, by: r && (r.decider || r.by) || null, ...checkRelease(r) })); }
import { chatInit, chatRegistry, chatRegistryFile } from './command-chat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.CMD_IC_DB || 'C:/tmp_infinite_creation/infinite-creation/data/ic.db';
const PROJECT = '51ed8141-419f-4cf6-af96-406142970482';
const M = 'C:\\Users\\usazr\\Documents\\moviePro';
const P = path.join(M, 'projects', '我在城市用交易系统修仙');
const CHAT_REG = path.join(M, 'Claude工作区', '指挥聊天测试', 'sessions.json');
const DISPATCH_DIR = path.join(M, 'Claude工作区', '指挥', '派工');
const TZ = 'America/Los_Angeles';

function runDb(mode, timeoutMs, project = PROJECT) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const w = new Worker(path.join(__dirname, 'command-overview-db.mjs'), { workerData: { dbPath: DB, project, mode, now: Date.now() } });
    const tm = setTimeout(() => { w.terminate(); resolve({ error: `ic.db 查询超时（>${timeoutMs / 1000} 秒）` }); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(tm); m.elapsedMs = Date.now() - t0; resolve(m); w.terminate(); });
    w.once('error', (e) => { clearTimeout(tm); resolve({ error: String(e.message || e) }); });
  });
}

// ffprobe：按 文件名+大小+修改时间 缓存，限时、限并发 2
const probeCache = new Map();
function ffprobe(f) {
  return new Promise((res) => execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', f], { timeout: 15000, windowsHide: true }, (e, out) => {
    if (e) return res({ error: String(e.message || e).slice(0, 200) });
    try { const j = JSON.parse(out); res({ w: j.streams?.[0]?.width, h: j.streams?.[0]?.height, dur: Number(j.format?.duration) }); } catch (x) { res({ error: 'ffprobe 输出解析失败' }); }
  }));
}
async function deliveries(dir) {
  const ents = await fsp.readdir(dir).catch(() => null);
  if (!ents) return { error: '交付目录读不到：' + dir };
  const files = ents.filter((n) => /^EP\d+\.mp4$/i.test(n)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const todo = [];
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f); const st = await fsp.stat(full).catch(() => null); if (!st) continue;
    const key = `${full}|${st.size}|${st.mtimeMs}`;
    const rec = { ep: Number(/^EP(\d+)/i.exec(f)[1]), file: f, mtime: st.mtimeMs, size: st.size, key };
    if (probeCache.has(key)) Object.assign(rec, probeCache.get(key)); else todo.push(rec);
    out.push(rec);
  }
  let i = 0; const workers = [0, 1].map(async () => { while (i < todo.length) { const r = todo[i++]; const p = await ffprobe(path.join(dir, r.file)); probeCache.set(r.key, p); Object.assign(r, p); } });
  await Promise.all(workers);
  const subdirs = ents.filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; } });
  const twoK = subdirs.includes('2K') ? (await fsp.readdir(path.join(dir, '2K')).catch(() => [])).length : null;
  return { dir, files: out, twoKSubdirFiles: twoK, probedNow: todo.length };
}

const ptTime = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// 各区缓存（内存）：失败时保留上次值并标采样时间
// 2026-11-25（Andy：总览要能选项目）：缓存按「区 + 项目」分开；sessions 与项目无关
const cache = {};
const inflight = {};
const TTL = { top: 30e3, issues: 60e3, sessions: 60e3, trends: 600e3, metrics: 30e3 };
async function getPart(name, fn, project = PROJECT, force = false) {
  const key = name === 'sessions' ? name : name + '|' + project;
  const c = cache[key];
  if (!force && c && Date.now() - c.computedAt < TTL[name] - 2000) return c;
  if (force && c && Date.now() - c.computedAt < 5000) return c; // 手动刷新连点：5 秒内复用
  if (inflight[key]) return inflight[key]; // 轮询不重叠
  inflight[key] = (async () => {
    try { const data = await fn(project); cache[key] = { ok: true, computedAt: Date.now(), at: new Date().toISOString(), data }; }
    catch (e) { cache[key] = { ...(c || { data: null }), ok: false, error: String(e.message || e), failedAt: new Date().toISOString(), computedAt: Date.now() }; }
    finally { delete inflight[key]; }
    return cache[key];
  })();
  return inflight[key];
}
// 项目列表与项目信息（只读打开 ic.db）；问题表、桌面交付目录目前只有默认项目有
const openRo = () => new DatabaseSync('file:' + DB.replace(/\\/g, '/') + '?mode=ro', { readOnly: true });
function projectList() {
  let db; try { db = openRo();
    return db.prepare("select p.id, p.name, (select count(*) from shots s where s.project_id = p.id) shots, (select count(distinct s2.chapter) from shots s2 where s2.project_id = p.id and coalesce(s2.chapter, '') <> '') chapters, (select count(*) from chapters c2 where c2.project_id = p.id and length(coalesce(c2.novel, '')) > 0) novel_chapters from projects p order by (p.id = ?) desc, p.updated_at desc").all(PROJECT).filter((r) => r.shots > 0 || r.novel_chapters > 0 || r.id === PROJECT).map((r) => ({ id: r.id, name: r.name, shots: r.shots, chapters: r.chapters, isDefault: r.id === PROJECT, hasIssues: r.id === PROJECT })); // 只列有镜头、或已导入原著（有章节正文）的项目（Andy 11-25：工具用的空项目不列；11-26「没更新 v3」：新开还没拆镜的项目也要列）
  } finally { try { db?.close(); } catch {} }
}
function projectInfo(project) {
  let db; try { db = openRo();
    const r = db.prepare('select name, context from projects where id = ?').get(project); if (!r) return null;
    let dd = null; try { dd = JSON.parse(r.context || '{}').delivery_dir || null; } catch {}
    const chapters = db.prepare("select count(distinct chapter) n from shots where project_id = ? and coalesce(chapter, '') <> ''").get(project).n; // chapters 表行数不等于集数，按镜头实际用到的章数
    return { name: r.name, deliveryDir: project === PROJECT ? path.join(P, '交付') : dd, chapters };
  } finally { try { db?.close(); } catch {} }
}

const est = (value, samples, window, method) => ({ value, estimate: true, samples, window, method });
const none = (why) => ({ value: null, missing: '暂无数据：缺' + why });

const EARLY = 10;
const chN = (c) => Number(String(c || '').replace(/\D/g, '')) || null;
let editsCache = { at: 0, v: null };
async function shotEdits() {
  if (Date.now() - editsCache.at < 120000 && editsCache.v) return editsCache.v;
  const r = await runDb('edits', 20000); if (r.error) throw new Error(r.error);
  editsCache = { at: Date.now(), v: r }; return r;
}
const ptMin = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).slice(5, 16) : '—');
// GPU 优先级：第1–10集最先。只看「在跑」和「已挂好」（进程在等上游 / 等待器已挂）的链；停掉或没挂的旧链不拿来判顺序。
function priorityCheck(gpu, iss, edits, missingEps, partial) {
  const unfinished = new Map();
  for (const e of iss?.eps || []) if (e.no <= EARLY && e.items - e.done > 0) unfinished.set(e.no, `问题描述还有 ${e.items - e.done} 条未完成`);
  for (const n of missingEps || []) if (n <= EARLY) unfinished.set(n, (unfinished.get(n) ? unfinished.get(n) + '；' : '') + '还没导出');
  for (const x of partial || []) if (x.ch <= EARLY) unfinished.set(x.ch, (unfinished.get(x.ch) ? unfinished.get(x.ch) + '；' : '') + `镜头出好 ${x.done}/${x.total}`);
  const eps = [...unfinished.entries()].sort((a, b) => a[0] - b[0]).map(([no, why]) => ({ no, why }));
  const andyDone = new Set((iss?.eps || []).filter((e) => e.items > 0 && e.done === e.items).map((e) => e.no));
  const violations = [];
  const qOrder = new Map((gpu.queue || []).map((c, i) => [c.key, i]));
  const isActive = (c) => c.state !== 'done' && (c.pid || c.waiterArmed);
  const active = (gpu.chains || []).filter(isActive).sort((a, b) => (a.state === 'running' ? -1 : b.state === 'running' ? 1 : (qOrder.get(a.key) ?? 99) - (qOrder.get(b.key) ?? 99)));
  const ignored = (gpu.chains || []).filter((c) => !isActive(c) && c.state !== 'done' && c.state !== 'missing').map((c) => `${c.label}（${c.state === 'stopped' ? '已停' : '没挂'}）`);
  const remOf = (c) => (c.shots || []).filter((s) => !s.done).map((s) => ({ n: chN(s.ch), num: s.num })).filter((x) => x.n);
  active.forEach((c, i) => {
    const rem = remOf(c); if (!rem.length) return;
    const pos = c.state === 'running' ? '正在跑的' : '已挂好的';
    const firstLate = rem.findIndex((x) => x.n > EARLY);
    const earlyAfter = firstLate >= 0 ? rem.slice(firstLate).filter((x) => x.n <= EARLY) : [];
    if (earlyAfter.length) violations.push({ rule: 'gpu-ep1-10-first', kind: 'chain', key: c.key, level: 'red', text: `${pos}「${c.label}」链内顺序：第1–10集的 ${earlyAfter.map((x) => `${x.n}#${x.num}`).join('、')} 排在第 ${rem[firstLate].n} 章后面` });
    const later = active.slice(i + 1).filter((x) => remOf(x).some((y) => y.n <= EARLY));
    if (rem.every((x) => x.n > EARLY) && later.length) violations.push({ rule: 'gpu-ep1-10-first', kind: 'chain', key: c.key, level: 'red', text: `${pos}「${c.label}」只有第11集以后的镜头，却排在含第1–10集镜头的「${later.map((x) => x.label).join('」「')}」前面` });
  });
  const activeIds = []; for (const c of active) for (const s of c.shots || []) if (s.id) activeIds.push(s.id);
  const inActive = (id) => activeIds.some((p) => id.startsWith(p) || p.startsWith(id));
  let editNote = null;
  if (edits?.edits) {
    // Andy 已把这一集问题全标完成的，镜头稿再晚于视频也是遗留（已交付、已认可），不再报红，只在说明里记个数
    const all = edits.edits.filter((e) => chN(e.ch) <= EARLY && !inActive(e.id));
    const lead = all.filter((e) => !andyDone.has(chN(e.ch)));
    const legacy = all.length - lead.length;
    const byCh = new Map(); for (const e of lead) { const n = chN(e.ch); if (!byCh.has(n)) byCh.set(n, []); byCh.get(n).push(e); }
    for (const [n, arr] of [...byCh.entries()].sort((a, b) => a[0] - b[0])) {
      arr.sort((a, b) => a.idx - b.idx);
      const lastE = Math.max(...arr.map((e) => e.lastEdit)), lastV = Math.max(...arr.map((e) => e.newestVideo || 0));
      violations.push({ rule: 'gpu-ep1-10-first', kind: 'write', ep: n, level: 'red', shots: arr.map((e) => ({ idx: e.idx, id: e.id, lastEdit: e.lastEdit, fields: e.fields, newestVideo: e.newestVideo })), text: `第${n}集 ${arr.length} 镜改过字段、晚于最新视频，但不在任何在跑或已挂的链里：#${arr.map((e) => e.idx).join('、#')}（最后改字段 ${ptMin(lastE)}，这些镜最新视频最晚 ${ptMin(lastV)}）` });
    }
    editNote = `改字段时间取 IC 改动记录里内容字段（提示词、画面、分镜、台词、运镜、时长）真有变化的最后一次，补绑定不算；${edits.logRows} 条记录、${edits.shotsTotal} 个镜头，2 分钟缓存${legacy ? `；另有 ${legacy} 镜在 Andy 已标问题全修好的集里，算遗留，不报` : ''}`;
  }
  return { decisionRules: DECISION_RULES, releaseFields: RELEASE_FIELDS, gateMd5: GATE_MD5, releaseChecks: releaseChecks(), rules: PRIORITY_RULES, dispatchRules: DISPATCH_RULES, modelTable: MODEL_TABLE.map(({ re, ...m }) => m), unfinishedEarly: eps, activeChains: active.map((c) => ({ key: c.key, label: c.label, state: c.state, pid: c.pid || null, remaining: remOf(c).length })), ignoredChains: ignored, violations, ok: !violations.some((v) => v.level === 'red'), note: '只提醒，系统不改链、不改稿、不提交。判顺序只看在跑和已挂好的链' + (active.length ? `（${active.map((c) => c.label).join('、')}）` : '（现在没有）') + (ignored.length ? `；不参与判断：${ignored.join('、')}` : '') + (editNote ? `；${editNote}` : '') };
}

async function computeTop(project = PROJECT) {
  const t0 = Date.now(); const isMain = project === PROJECT;
  const [db, gpu] = await Promise.all([runDb('core', 12000, project), gpuQueue()]);
  const errs = [];
  if (db.error) errs.push('ic.db：' + db.error);
  const dl = db.deliveryDir ? await deliveries(db.deliveryDir) : { error: '项目没有配置交付目录' };
  if (dl.error) errs.push(dl.error);
  let iss = null; if (isMain) { try { iss = await issuesForOverview(); } catch (e) { errs.push('问题描述：' + e.message); } }
  let lead = null; if (isMain) { try { lead = await writeLead(gpu); } catch (e) { lead = { error: e.message }; } } else lead = { error: '只统计默认项目' };
  const total = db.totalChapters || null;
  const exported = (dl.files || []).filter((f) => !f.error);
  const exportedEps = exported.map((f) => f.ep);
  const maxEp = exportedEps.length ? Math.max(...exportedEps) : 0;
  const missingEps = []; for (let i = 1; i <= maxEp; i++) if (!exportedEps.includes(i)) missingEps.push(i);
  // 做完的集：已导出 且 问题描述该集登记过问题、全部「完成」；整集验收记录还没有，所以另列
  const epDone = iss ? iss.eps.filter((e) => e.items > 0 && e.done === e.items && exportedEps.includes(e.no)).map((e) => e.no) : [];
  const hd = exported.filter((f) => f.h >= 1440), sd = exported.filter((f) => f.h && f.h < 1440);
  // 2K 疑似旧版：2K 文件早于该集最近一次出片（用今天的链 done 记录近似：该集有链今天出完/在出）
  const touched = new Set(); for (const c of gpu.chains) if (c.state !== 'ready' && c.state !== 'missing') for (const s of c.shots || []) if (s.done) touched.add(Number(s.ch.replace(/\D/g, '')));
  const hdStale = hd.filter((f) => touched.has(f.ep)).map((f) => f.ep);
  const exportedMin = exported.reduce((a, f) => a + (f.dur || 0), 0) / 60;
  // GPU 现在
  const R = db.regen || {};
  const run = gpu.running;
  let perShot = null, perSrc = null;
  if (run && run.samples && run.samples.length >= 5) { perShot = median(run.samples); perSrc = { samples: run.samples.length, window: '本链已出完的镜', method: '本链 done 行渲染秒中位数' }; }
  else if (R.median48) { perShot = R.median48; perSrc = { samples: R.n48, window: '近 48 小时', method: 'ic.db 重生成任务（结束−开始）中位数' }; }
  const runRemainMin = run && perShot ? (run.remaining * perShot) / 60 : null;
  // 后面队列：按推出的链序逐条累加
  let tcur = Date.now() + (runRemainMin || 0) * 60e3;
  const queue = gpu.queue.filter((c) => c.state !== 'missing').map((c) => { const mins = perShot ? (c.remaining * perShot) / 60 : null; const start = tcur; if (mins != null) tcur += mins * 60e3; return { label: c.label, key: c.key, state: c.state, remaining: c.remaining, total: c.total, estMin: r1(mins), estStart: mins != null ? new Date(start).toISOString() : null, estEnd: mins != null ? new Date(tcur).toISOString() : null, armed: !!(c.pid && c.state === 'waiting') || !!c.waiterArmed, armedBy: c.pid && c.state === 'waiting' ? '进程已挂起在等上游' : c.waiterArmed ? `已由等待器挂好（${c.waiter.name}，PID ${c.waiter.pid}）` : null, reviewPending: !!c.reviewPending, approvedWaiting: !!c.approvedWaiting, approval: c.approval || null, upstreamLabel: c.upstreamLabel, upstreamSrc: c.upstreamSrc, mismatch: c.mismatch }; });
  const blocks = []; for (const c of gpu.chains) for (const b of c.blocks || []) blocks.push({ chain: c.label, line: b });
  blocks.sort((a, b) => b.line.localeCompare(a.line));
  const g = db.gpuToday || {};
  const longPause = (g.gaps || []).filter((x) => x.min >= 60), shortGaps = (g.gaps || []).filter((x) => x.min < 60);
  // 时间与良率
  const perEpGpuMin = db.avgShotsDoneCh && db.videosPerShot && R.mean48 ? (db.avgShotsDoneCh * db.videosPerShot * R.mean48) / 60 : null;
  const remainingEps = total && db.allDone ? total - db.allDone.length : null;
  const remainHours = perEpGpuMin && remainingEps != null ? (remainingEps * perEpGpuMin) / 60 : null;
  const calTimes = []; if (db.firstShotAt) for (const f of exported) { const s = db.firstShotAt[f.ep]; if (s && isFinite(s) && f.mtime > s) calTimes.push((f.mtime - s) / 3600e3); }
  // 会话数（上首行）从会话区拿
  const ses = await getPart('sessions', computeSessions).catch(() => null);
  const andy = await pendingAndy();
  return {
    projectName: db.projectName || (isMain ? '我在城市用交易系统修仙V2' : project), projectId: project, hasIssues: isMain,
    films: {
      totalChapters: total, chaptersWithShots: db.chaptersWithShots ?? null,
      allShotsDone: db.allDone ? { n: db.allDone.length, list: db.allDone, partial: db.partial } : none('ic.db 读数'),
      exported: { n: exportedEps.length, list: exportedEps, missing: missingEps },
      doneAndy: iss ? { n: epDone.length, list: epDone, note: '已导出 且 问题描述该集登记过问题、全部标「完成」；没登记问题的集不算；不含整集验收（验收记录还没接入）' } : none('问题描述.txt 读数'),
      accepted: none('整集验收记录（审片/验收功能上线后才有）'),
    },
    issues: iss ? { raw: iss.raw, rawDone: iss.rawDone, rawOpen: iss.raw - iss.rawDone, heads: iss.heads, items: iss.eps.reduce((a, e) => a + e.items, 0), itemsDoing: iss.eps.reduce((a, e) => a + e.doing, 0), itemsTodo: iss.eps.reduce((a, e) => a + e.todo, 0), itemsDone: iss.eps.reduce((a, e) => a + e.done, 0), fixing: iss.fixing || none('问题行↔镜头关联（推算失败：' + (iss.linkError || '未知') + '）'), file: iss.file, md5: iss.md5 } : none('问题描述.txt 读数'),
    upscale: dl.error ? none('交付目录读数') : { hd: hd.map((f) => f.ep), sd: sd.map((f) => f.ep), hdStale, twoKSubdirFiles: dl.twoKSubdirFiles, note: '2K＝1440 行高的高清档；「疑似旧版」= 该集今天有链出过新片，2K 可能不是最新；确认要记录 2K 的来源版本（还没有）' },
    minutes: {
      exportedMin: dl.error ? none('交付目录读数') : { value: r1(exportedMin), eps: exported.length, note: 'ffprobe 实测，各集合计；不代表验收通过' },
      todayGenMin: db.error ? none('ic.db 读数') : { value: r1(db.todayGenMin), videos: db.todayVideos, note: '今天新生成视频（含重渲）× 镜头当前计划时长；不是成片' },
      todaySelectedMin: db.error ? none('ic.db 读数') : { value: r1(db.todaySelectedMin), videos: db.todaySelectedN, note: '今天生成且当前被选用' },
      allGenMin: db.error ? none('ic.db 读数') : { value: r1(db.allGenMin), videos: db.allVideos },
      selectedDoneMin: db.error ? none('ic.db 读数') : { value: r1(db.selectedDoneMin), note: '非作废、已出好镜头的计划时长和' },
    },
    gpu: {
      running: run ? { label: run.label, key: run.key, pid: run.pid, done: run.done, total: run.total, current: run.current ? `第${run.current.ch.replace(/\D/g, '')}集 第${run.current.num}镜` : null, currentSince: run.current?.at || null, remainMin: runRemainMin != null ? est(r1(runRemainMin), perSrc.samples, perSrc.window, `剩余 ${run.remaining} 镜 × ${Math.round(perShot)} 秒（${perSrc.method}）`) : none('单镜耗时样本') } : null,
      idleNow: !run, next: gpu.next ? { label: gpu.next.label, armed: gpu.nextArmed, armedBy: gpu.nextArmedBy === 'waiter' ? `已由等待器挂好（${gpu.next.waiter.name}，PID ${gpu.next.waiter.pid}，等「${gpu.running ? gpu.running.label : '上游'}」跑完后启动）` : gpu.nextArmedBy === 'process' ? '已挂好，进程在等上游' : null, reviewPending: !!gpu.next.reviewPending, approvedWaiting: !!gpu.next.approvedWaiting, approval: gpu.next.approval || null, state: gpu.next.state } : null,
      waiters: gpu.waiters, referenceNote: gpu.referenceNote,
      cutoffWarn: run && runRemainMin != null && !gpu.nextArmed ? `下一条未见挂好（进程表里没有在等上游的下一条链，也没有在运行的等待器安排它），约 ${Math.round(runRemainMin)} 分钟后 GPU 可能空闲（估算，未核实是否另有安排）` : null,
      queue, conflicts: gpu.conflicts, derived: gpu.derived,
      today: db.error ? none('ic.db 读数') : { busyH: r1(g.busyMs / 3600e3), occupancy: g.occupancy, longPause: longPause.map((x) => ({ from: ptTime(x.from), min: r1(x.min) })), shortGaps: shortGaps.map((x) => ({ from: ptTime(x.from), min: r1(x.min) })), shortGapsMin: r1(shortGaps.reduce((a, x) => a + x.min, 0)), tinyGapsMin: r1(g.smallGapMin), note: '按 ic.db 任务（重生成 + 新建，含所有项目）运行区间并集；≥60 分钟的空档单列为「长暂停」（可能人为暂停，未核实）' },
      failed: db.error ? none('ic.db 读数') : { total: R.failed, today: R.failedToday },
      exportsToday: db.exportsToday || null,
      blocks: blocks.slice(0, 5),
    },
    times: {
      shotRender: R.median48 ? { median: Math.round(R.median48), p80: Math.round(R.p80_48), n: R.n48, window: '近 48 小时', medianAll: Math.round(R.medianAll), nAll: R.nAll } : none('重生成任务样本'),
      perEpGpuMin: perEpGpuMin ? est(Math.round(perEpGpuMin), R.n48, '镜数：已出完各集均值；次数：全量；耗时：近 48 小时均值', `${r1(db.avgShotsDoneCh)} 镜 × ${r1(db.videosPerShot)} 次 × ${Math.round(R.mean48)} 秒`) : none('镜数或耗时样本'),
      perEpCalendar: calTimes.length ? est(r1(median(calTimes)), calTimes.length, '已导出各集', '首次建镜 → 当前交付文件修改时间（小时，中位数）；首次导出、验收两段没有记录') : none('建镜时间或导出时间'),
      fixTime: none('问题新增/完成时间（可编辑问题页切到正式文件后开始积累，样本 <10 显示样本不足）'),
      rerenderPerShot: db.videosPerShot ? { value: Math.round(db.videosPerShot * 100) / 100, note: `全量 ${db.allVideos} 条视频 ÷ ${db.shotsWithVideo} 个有视频的镜（镜头级重渲次数，不等于每集返修轮次）` } : none('ic.db 读数'),
      remainWork: remainHours ? est(Math.round(remainHours / 24), remainingEps, '剩余集数 × 单集 GPU 时间', `满载约 ${Math.round(remainHours / 24)} 天；按今天占用率 ${g.occupancy ? Math.round(g.occupancy * 100) : '?'}% 约 ${g.occupancy ? Math.round(remainHours / 24 / g.occupancy) : '?'} 天（今天含长暂停，偏悲观）；不含写稿、审片、2K 和返修`) : none('单集 GPU 时间'),
      acceptDate: none('近 7 天「整集验收通过」记录（样本不足）'),
    },
    yield: {
      oneShot: db.shotsWithVideo ? { value: db.shotsOneVideo / db.shotsWithVideo, num: db.shotsOneVideo, den: db.shotsWithVideo, note: '只生成一次的镜头占比（全量，非作废镜）；重渲可能是改稿不是质量问题，所以不叫首次通过率' } : none('ic.db 读数'),
      jobSuccess: R.done != null ? { value: R.done / ((R.done + R.failed) || 1), done: R.done, failed: R.failed, note: '重生成任务没报错的比例，不代表画面合格' } : none('ic.db 读数'),
      firstPass: none('首轮审片结果（审片功能上线后按「首轮审片通过 ÷ 有结果的镜」算）'),
    },
    sessionsCount: ses?.data ? { active: ses.data.active.length, registered: ses.data.registered, working: ses.data.working, unregistered: ses.data.unregistered } : null,
    writeLead: lead && !lead.error ? { value: lead.count, byChapter: lead.byChapter, note: 'IC 里 video_prompt 已改、晚于最新视频、且不在任何未跑完链的镜单里' } : none('IC 镜头读数' + (lead?.error ? `（${lead.error}）` : '')),
    priority: await (async () => { try { let ed = null; try { ed = await shotEdits(); } catch (e) { errs.push('改字段时间（change_logs）：' + e.message); } return priorityCheck(gpu, iss, ed, missingEps, db.partial); } catch (e) { errs.push('排序规则检查：' + e.message); return { decisionRules: DECISION_RULES, releaseFields: RELEASE_FIELDS, gateMd5: GATE_MD5, releaseChecks: releaseChecks(), rules: PRIORITY_RULES, dispatchRules: DISPATCH_RULES, violations: [], error: e.message }; } })(),
    andy,
    errors: errs,
    sources: { db: { path: DB, readOnly: true, elapsedMs: db.elapsedMs, timings: db.timings }, delivery: dl.dir, probedNow: dl.probedNow, chainLogs: logCacheStats().length },
    computeMs: Date.now() - t0,
  };
}

async function pendingAndy() {
  const ents = await fsp.readdir(DISPATCH_DIR).catch(() => null);
  if (!ents) return { items: [], missing: '暂无数据：缺派工目录' };
  const items = [];
  for (const f of ents.filter((n) => n.endsWith('.json'))) {
    try { const d = JSON.parse((await fsp.readFile(path.join(DISPATCH_DIR, f), 'utf8')).replace(/^\uFEFF/, '')); const need = d.需要Andy点头 ?? d.needs_andy; const ok = d.andy_ok ?? d.Andy已点头; if (need && !ok) items.push({ file: f, title: d.范围 || d.说明 || f, since: d.来源时间 || d.issued_at || null, example: !!d.示例 }); } catch {}
  }
  return { items, real: items.filter((x) => !x.example).length, note: '来源：派工目录里「需要Andy点头」且未批的单；目前只有示例单，人工整理的待定事项还没录成派工单' };
}

async function computeIssues(project = PROJECT) {
  if (project !== PROJECT) return { none: true, note: '这个项目还没有问题表（问题描述.txt 目前只对应「我在城市用交易系统修仙V2」）', eps: [] };
  const iss = await issuesForOverview();
  const lk = new Map((iss.linked || []).map((e) => [e.no, e])); return { at: new Date().toISOString(), file: iss.file, md5: iss.md5, icReadAt: iss.icReadAt, icError: iss.icError, fixing: iss.fixing, eps: iss.eps.map((e) => { const L = lk.get(e.no); const open = L ? L.items : []; return { no: e.no, items: e.items, done: e.done, doing: e.doing, todo: e.todo, stage: e.stage?.stage || '未知', chain: e.stage?.chain || null, eta: e.stage?.eta || null, shots: e.stage?.shots || [], open: open.length, fixingN: open.filter((i) => i.links?.fixing).length, linkedN: open.filter((i) => i.links?.shots?.length).length, linkedShots: [...new Set(open.flatMap((i) => (i.links?.shots || []).map((x) => x.idx)))].sort((a, b) => a - b), drift: L?.timeline?.drift ?? null }; }) };
}

let deps = {};
export function overviewInit(d) { deps = d; }
// 桌面会话的名字：jsonl 里最后一条 {"type":"custom-title","customTitle":…}；按文件大小增量扫，只找这一种行
const titleCache = new Map(); // file -> { size, title }
export async function sessionTitle(file) {
  const st = await fsp.stat(file).catch(() => null); if (!st) return null;
  const c = titleCache.get(file) || { size: 0, title: null };
  if (st.size === c.size) return c.title;
  const start = st.size > c.size ? c.size : 0;
  await new Promise((resolve) => {
    let rest = '';
    fs.createReadStream(file, { start, encoding: 'utf8' }).on('data', (chunk) => {
      const lines = (rest + chunk).split('\n'); rest = lines.pop();
      for (const l of lines) if (l.includes('"custom-title"')) { try { const j = JSON.parse(l); if (j.customTitle) c.title = String(j.customTitle).slice(0, 40); } catch {} }
    }).on('end', resolve).on('error', resolve);
  });
  c.size = st.size; titleCache.set(file, c); return c.title;
}
async function computeSessions() {
  // 会话登记表：聊天里的主会话/辅助会话（身份确定）；另外列出没登记、但最近 10 分钟会话文件有新内容的 Claude/Codex 会话（参考）
  await chatInit();
  const reg = chatRegistry();
  const regCli = new Set(reg.map((r) => r.cliSessionId).filter(Boolean));
  const registered = reg.filter((r) => r.status !== 'stopped').map((r) => ({ kind: 'chat', id: r.id, role: r.role, provider: r.provider, title: r.title, status: r.status, lastActivity: r.lastActivity, last: r.lastSnippet ? { text: r.lastSnippet.replace(/\s+/g, ' ').slice(0, 40) } : null, state: ({ idle: '空闲', busy: '正在回复' })[r.status] || r.status }));
  const since = Date.now() - 10 * 60e3;
  const others = [];
  for (const provider of ['claude', 'codex']) {
    const l = await deps.listSessions(provider, 1).catch(() => null);
    for (const s of (l?.sessions || []).filter((x) => new Date(x.mtime).getTime() >= since && ![...regCli].some((c) => String(x.id).includes(c))).slice(0, 8)) {
      // 2026-11-25（Andy：信息太多、太难看）：只给会话名、类别、最后动静时间，不再带对话原文
      const name = provider === 'claude' ? await sessionTitle(path.join(CLAUDE_PROJECTS, s.id)) : null;
      const isIc = /infinite-creation-data-ag/i.test(s.project || '');
      others.push({ kind: 'file', provider, id: s.id, project: s.project, mtime: s.mtime, size: s.size, name: name || (isIc ? 'IC 内部写稿 Agent' : (provider === 'codex' ? 'Codex 会话 ' : 'Claude 会话 ') + String(s.id).split('/').pop().slice(0, 8)), group: isIc ? 'ic' : 'desk', state: '最近 10 分钟有动静' });
    }
  }
  const working = registered.filter((r) => r.status === 'busy' || r.role === 'aux');
  return { registered: reg.length, registeredOpen: registered.length, registryFile: chatRegistryFile, registryMissing: false, chat: registered, active: [...working, ...others], working: working.length, unregistered: others.length, note: '「在工作」= 登记表里正在回复或开着的辅助会话 + 没登记但 10 分钟内会话文件有新内容的会话（后者不等于正在执行）。登记表只覆盖指挥系统聊天里开的会话；外部的 Claude/Codex 会话（如各 Bot 自己的）还没登记' };
}

async function computeTrends(project = PROJECT) {
  const db = await runDb('trends', 20000, project);
  if (db.error) throw new Error(db.error);
  return { days: db.days, elapsedMs: db.elapsedMs };
}

// ======================= 首屏指标（part=metrics）：产能 / 正在做 / 章集进度 / 用量 / 规则 / 问题归类 =======================
const ptDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const ptDayOf = (ms) => ptDayFmt.format(new Date(ms));
const lastDays = (n) => { const out = []; const seen = new Set(); for (let i = 0; out.length < n && i < n + 3; i++) { const d = ptDayOf(Date.now() - i * 86400e3); if (!seen.has(d)) { seen.add(d); out.push(d); } } return out; };
const WIN_DEF = [{ id: 'today', label: '今天', days: 1, skip: 0 }, { id: 'yesterday', label: '昨天', days: 1, skip: 1 }, { id: 'd7', label: '最近 7 天', days: 7, skip: 0 }, { id: 'd30', label: '最近 30 天', days: 30, skip: 0 }];
const ptMidnightIso = (day) => { for (const off of [8, 7]) { const t = Date.parse(`${day}T0${off}:00:00Z`); if (ptDayOf(t) === day && ptDayOf(t - 3600e3) !== day) return new Date(t).toISOString(); } return `${day}T00:00:00-08:00`; };
const winDays =(w) => lastDays(w.days + w.skip).slice(w.skip);
usageInit({ ptDayOf, WIN_DEF, winDays, ptMidnightIso, openRo: () => openRo() });

// --- tokens：~/.claude/projects/**/*.jsonl 的 assistant message.usage，按太平洋时间日汇总；按文件增量读，按 message.id 去重；5 分钟刷新一次
const CLAUDE_PROJECTS = process.env.CMD_CLAUDE_PROJECTS || path.join(process.env.USERPROFILE || 'C:\\Users\\usazr', '.claude', 'projects');
const tokFiles = new Map(); // file -> { size, offset, rest, ids:Set, days:Map }
let tokState = { at: 0, running: null, data: null, error: null };
async function scanTokenFile(f, st) {
  let c = tokFiles.get(f);
  if (c && c.size === st.size) return;
  if (!c || st.size < c.size) { c = { size: 0, offset: 0, rest: '', ids: new Set(), days: new Map() }; tokFiles.set(f, c); }
  await new Promise((resolve) => {
    const s = fs.createReadStream(f, { start: c.offset, encoding: 'utf8', highWaterMark: 1 << 20 });
    s.on('data', (chunk) => {
      const t = c.rest + chunk; const k = t.lastIndexOf('\n'); if (k < 0) { c.rest = t; return; }
      c.rest = t.slice(k + 1);
      for (const line of t.slice(0, k).split('\n')) {
        if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue; // 只碰有用量的行
        let j; try { j = JSON.parse(line); } catch { continue; }
        const u = j?.message?.usage; if (j.type !== 'assistant' || !u || !j.timestamp) continue;
        const id = j.message.id || j.requestId || j.uuid; if (id) { if (c.ids.has(id)) continue; c.ids.add(id); }
        const day = ptDayOf(Date.parse(j.timestamp)); let d = c.days.get(day); if (!d) { d = { in: 0, out: 0, cr: 0, cc: 0, n: 0 }; c.days.set(day, d); }
        d.in += u.input_tokens || 0; d.out += u.output_tokens || 0; d.cr += u.cache_read_input_tokens || 0; d.cc += u.cache_creation_input_tokens || 0; d.n++;
      }
    });
    s.on('end', resolve); s.on('error', resolve);
  });
  c.size = st.size; c.offset = st.size;
}
async function tokenScan() {
  const since = Date.now() - 31 * 86400e3;
  const names = await fsp.readdir(CLAUDE_PROJECTS, { recursive: true }).catch(() => null);
  if (!names) throw new Error('读不到 ' + CLAUDE_PROJECTS);
  let files = 0;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(CLAUDE_PROJECTS, n); const st = await fsp.stat(f).catch(() => null);
    if (!st || !st.isFile() || st.mtimeMs < since) continue;
    files++; await scanTokenFile(f, st);
  }
  const all = new Map(); for (const c of tokFiles.values()) for (const [d, v] of c.days) { const a = all.get(d) || { in: 0, out: 0, cr: 0, cc: 0, n: 0 }; for (const k in v) a[k] += v[k]; all.set(d, a); }
  const windows = WIN_DEF.map((w) => { const s = { id: w.id, label: w.label, in: 0, out: 0, cr: 0, cc: 0, n: 0 }; for (const d of winDays(w)) { const v = all.get(d); if (v) for (const k in v) s[k] += v[k]; } s.total = s.in + s.out + s.cr + s.cc; return s; });
  return { windows, files, note: '~/.claude/projects 下 31 天内改过的 *.jsonl，assistant 消息的 message.usage 按 message.id 去重后按太平洋时间日求和；只含 Claude Code 本机会话，不含 Codex' };
}
function tokensNow() {
  if (!tokState.running && Date.now() - tokState.at > 300e3) {
    tokState.running = tokenScan().then((d) => { tokState = { at: Date.now(), running: null, data: d, error: null }; }).catch((e) => { tokState = { ...tokState, at: Date.now(), running: null, error: String(e.message || e) }; });
  }
  return tokState.data ? { ...tokState.data, at: new Date(tokState.at).toISOString(), refreshing: !!tokState.running } : tokState.error ? { error: tokState.error } : { pending: true };
}

// --- 指挥主会话：最近一条 assistant 第一行 + 花费（cost 字段是累计值，窗口花费 = 窗口内最后值 − 窗口前最后值）
const MAIN_MSGS = path.join(M, 'Claude工作区', '指挥聊天测试', 'sessions', 'main', 'messages.jsonl');
async function mainSession() {
  const L = await readLogLines(MAIN_MSGS).catch(() => null);
  if (!L) return { error: '读不到主会话记录' };
  const rows = []; let last = null;
  for (const l of L) { if (l.indexOf('"assistant"') < 0) continue; let j; try { j = JSON.parse(l); } catch { continue; } if (j.role !== 'assistant') continue; last = j; if (typeof j.cost === 'number') rows.push({ t: Date.parse(j.ts), cost: j.cost }); }
  const spend = WIN_DEF.map((w) => { const ds = new Set(winDays(w)); const inW = rows.filter((r) => ds.has(ptDayOf(r.t))); if (!inW.length) return { id: w.id, label: w.label, usd: 0 }; const before = rows.filter((r) => r.t < inW[0].t).pop(); return { id: w.id, label: w.label, usd: Math.round((inW[inW.length - 1].cost - (before ? before.cost : 0)) * 100) / 100 }; });
  const first = last ? String(last.text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '' : '';
  return { lastAt: last?.ts || null, lastLine: first.slice(0, 60), spend, note: '主会话 messages.jsonl 的 cost 是累计美元数；窗口花费按差值算' };
}

// --- 规则：skills/*/src/*.md 里以〔ID〕开头的标题条目；今天/7 天/30 天对比 git 里窗口起点前最后一次提交的版本
const ROOT = path.resolve(__dirname, '..');
const RULE_HEAD = /^#{1,6}\s*〔([A-Z][A-Z0-9]*-\d{2,4}[a-z]?)〕/;
function ruleEntries(text) {
  const out = new Map(); let cur = null; const body = [];
  const flush = () => { if (cur) out.set(cur, body.join('\n').trim()); body.length = 0; };
  for (const l of String(text).split(/\r?\n/)) { const m = RULE_HEAD.exec(l); if (m) { flush(); cur = m[1]; body.push(l.replace(RULE_HEAD, '')); } else if (/^#{1,6}\s/.test(l) && cur) { flush(); cur = null; } else if (cur) body.push(l); }
  flush(); return out;
}
const git = (args) => new Promise((res) => execFile('git', ['-c', 'core.quotepath=off', '-C', ROOT, ...args], { maxBuffer: 64 << 20, timeout: 20000, windowsHide: true }, (e, out) => res(e ? null : out)));
// 某时刻的规则快照：逐文件取「该时刻前最后一次改它的提交」里的版本（历史有合并，不能只看一条主线）
async function rulesSnapshotAt(before, files) {
  const snap = new Map(); let base = null;
  for (const f of files) {
    const rev = ((await git(['log', '-1', '--format=%H %ct', `--before=${before}`, '--', f])) || '').trim().split(' ');
    if (!rev[0]) continue;
    if (!base || Number(rev[1]) > base.t) base = { h: rev[0], t: Number(rev[1]) };
    const t = await git(['show', `${rev[0]}:${f}`]); if (t == null) continue; // 该提交里删掉了 → 当时不存在
    const sk = f.split('/')[1]; for (const [id, b] of ruleEntries(t)) snap.set(`${sk}|${id}`, b);
  }
  return { snap, base };
}
let rulesState = { at: 0, v: null };
async function rulesStats() {
  if (rulesState.v && Date.now() - rulesState.at < 300e3) return rulesState.v;
  const cur = new Map(); const bySkill = {};
  const skills = await fsp.readdir(path.join(ROOT, 'skills')).catch(() => []);
  for (const sk of skills) { const dir = path.join(ROOT, 'skills', sk, 'src'); const fl = await fsp.readdir(dir).catch(() => []); for (const f of fl.filter((x) => x.endsWith('.md'))) { const t = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => ''); for (const [id, b] of ruleEntries(t)) { cur.set(`${sk}|${id}`, b); bySkill[sk] = (bySkill[sk] || 0) + 1; } } }
  const changes = [];
  const hist = await git(['log', '--format=', '--name-only', '--', 'skills']);
  if (hist == null) changes.push({ missing: '暂无数据：git 读不到' });
  const files = [...new Set([...(hist || '').split('\n')].filter((f) => f && /^skills\/[^/]+\/src\/[^/]+\.md$/.test(f)))];
  for (const w of hist == null ? [] : [{ id: 'today', label: '今天', days: 1 }, { id: 'd7', label: '最近 7 天', days: 7 }, { id: 'd30', label: '最近 30 天', days: 30 }]) {
    const startDay = lastDays(w.days)[w.days - 1]; // 窗口第一天（太平洋时间）
    const { snap: old, base } = await rulesSnapshotAt(ptMidnightIso(startDay), files);
    let added = 0, removed = 0, modified = 0;
    for (const [k, b] of cur) { if (!old.has(k)) added++; else if (old.get(k) !== b) modified++; }
    for (const k of old.keys()) if (!cur.has(k)) removed++;
    changes.push({ id: w.id, label: w.label, added, removed, modified, base: base ? base.h.slice(0, 8) : null, baseEmpty: !old.size });
  }
  const v = { total: cur.size, bySkill, changes, note: `条目＝skills/*/src/*.md 里以〔编号〕开头的标题，正文到下一个标题为止；对比基准＝窗口起点前最后一次提交，当前＝工作区（含未提交改动）；仓库 ${ROOT}` };
  rulesState = { at: Date.now(), v }; return v;
}

// 规则统计要跑上百次 git，后台算、5 分钟一次，请求只拿上次结果
let rulesRun = null, rulesErr = null;
function rulesNow() {
  if (!rulesRun && (!rulesState.v || Date.now() - rulesState.at > 300e3)) rulesRun = rulesStats().then(() => { rulesErr = null; }).catch((e) => { rulesErr = String(e.message || e); rulesState.at = Date.now(); }).finally(() => { rulesRun = null; });
  return rulesState.v ? { ...rulesState.v, at: new Date(rulesState.at).toISOString() } : rulesErr ? { error: rulesErr } : { pending: true };
}

// --- 问题归类：关键词归类（按顺序取第一个命中的类）
const ISSUE_CLASSES = [
  ['心声/嘴动', /心声|嘴动|嘴型|嘴形|口型|张嘴|内心/],
  ['资产（换人/缺图/脸）', /换人|换脸|脸|缺图|资产|定妆|长得|不像|变成了|另一个人/],
  ['服装/人物一致性', /服装|衣服|穿着|外套|发型|头发|人物不一致|穿的/],
  ['场景一致性', /场景|背景|房间|地点|环境|街|门|窗/],
  ['台词/字幕', /台词|字幕|错字|念|读成|对白|说成/],
  ['声音/音色', /声音|音色|声线|配音|男声|女声|音量|听不清/],
  ['BGM/剪辑', /BGM|bgm|配乐|音乐|剪辑|卡顿|黑屏|转场|节奏|拖沓|太长|太短/],
  ['穿帮/机位', /穿帮|机位|镜头|视角|角度|位置|方向|手|道具/],
];
function classifyIssues(eps) {
  const rows = [...ISSUE_CLASSES.map(([k]) => k), '其他'].map((k) => ({ cls: k, done: 0, doing: 0, todo: 0 }));
  for (const e of eps) for (const it of e.items) { const i = ISSUE_CLASSES.findIndex(([, re]) => re.test(it.text)); const r = rows[i < 0 ? rows.length - 1 : i]; r[it.status] = (r[it.status] || 0) + 1; }
  for (const r of rows) r.total = r.done + r.doing + r.todo;
  return rows;
}

async function computeMetrics(project = PROJECT) {
  const errs = []; const isMain = project === PROJECT;
  const info = projectInfo(project) || { name: project, deliveryDir: null, chapters: 0 };
  const [cap, gpu, items, main, rules] = await Promise.all([
    runDb('capacity', 20000, project),
    gpuQueue().catch((e) => { errs.push('GPU：' + e.message); return null; }),
    isMain ? issueItems().catch((e) => { errs.push('问题描述：' + e.message); return null; }) : Promise.resolve(null),
    mainSession(),
    rulesNow(),
  ]);
  if (cap.error) errs.push('ic.db：' + cap.error);
  // 章集进度：交付\EP*.mp4 + 问题描述各集状态；2K＝ffprobe 行高 ≥1440（总览 top 已探测过的缓存）
  const dl = info.deliveryDir ? await deliveries(info.deliveryDir) : { files: [], error: '这个项目没有配置交付目录' };
  const total = isMain ? 30 : (info.chapters || 0);
  const deliv = new Map((dl.files || []).filter((f) => !f.error).map((f) => [f.ep, f]));
  const openBy = new Map(); const anyBy = new Map();
  for (const e of items?.eps || []) { openBy.set(e.no, (openBy.get(e.no) || 0) + e.items.filter((i) => i.status !== 'done').length); anyBy.set(e.no, (anyBy.get(e.no) || 0) + e.items.length); }
  const grid = []; for (let n = 1; n <= total; n++) { const f = deliv.get(n); const open = openBy.get(n) || 0; grid.push({ ep: n, state: open > 0 ? 'open' : f ? 'delivered' : 'none', delivered: !!f, twoK: !!(f && Math.min(f.w || 0, f.h || 0) >= 1440), open }); }
  // 问题表三态
  const st = { todo: 0, doing: 0, done: 0 }; for (const e of items?.eps || []) for (const it of e.items) st[it.status] = (st[it.status] || 0) + 1;
  // 正在做
  const doing = [];
  const nw = gpu?.now;
  if (nw) doing.push(nw.busy && nw.current ? { kind: 'gpu', busy: true, text: `GPU：${shotLabel(nw.current)} 出片中`, since: nw.current.startedAt, src: nw.current.label || nw.current.job } : { kind: 'gpu', busy: false, text: `GPU 空闲${nw.idleMin != null ? ` ${Math.round(nw.idleMin)} 分钟` : ''}`, since: nw.idleSince });
  if (main && !main.error && main.lastLine) doing.push({ kind: 'main', text: `主会话：${main.lastLine}`, since: main.lastAt });
  return {
    project: { id: project, name: info.name, isMain, hasIssues: isMain, deliveryDir: info.deliveryDir },
    capacity: cap.error ? { error: cap.error } : { windows: cap.windows, todayBar: cap.todayBar, hourly: cap.hourly, firstJobAt: cap.firstJobAt, note: '忙＝ic.db 重生成/新建任务 started_at–finished_at 并集（含所有项目，GPU 共用）；闲＝时段内其余时间；早于第一条任务记录的时段算「无数据」。出片＝shot_videos 新建条数（本项目）；有效＝当前 selected=1；无效＝未选用；失败＝本项目失败任务数；有效分钟＝选用视频对应镜头的计划时长（shots.duration，不是 ffprobe 实测）；每镜用时＝本项目重生成任务（结束−开始）中位数。灰片拦截、进了交付的有效条数库里没有字段 → 暂无数据' },
    doing,
    episodes: { total, grid, delivered: [...deliv.keys()].filter((n) => n >= 1 && n <= total).length, extra: [...deliv.keys()].filter((n) => n < 1 || n > total).sort((a, b) => a - b), twoK: grid.filter((g) => g.twoK).length, note: '交付\\EP*.mp4 存在＝已交付；问题描述该集还有未完成条目＝有未完成问题（优先显示）；其余＝未开始/未交付。2K＝ffprobe 短边 ≥1440' },
    issues: !isMain ? { none: true, note: '这个项目还没有问题表' } : items ? { ...st, total: st.todo + st.doing + st.done, classes: classifyIssues(items.eps), md5: items.md5, note: '问题描述.txt（只读）逐条状态；归类是关键词归类（按顺序取第一个命中的类），不准确的会落到别的类或「其他」' } : { error: '问题描述读不到' },
    todayVideos: gpu?.today?.ok ? gpu.today.videos : null,
    gpuNow: nw ? { busy: nw.busy, idleMin: nw.idleMin, current: nw.current, recent: (gpu?.recent || []).slice(0, 8) } : null,
    tokens: tokensNow(),
    tokensCodex: codexNow(),
    gpuUse: gpuUseNow(),
    spend: main.error ? { error: main.error } : { windows: main.spend, note: main.note },
    rules,
    errors: errs,
  };
}

// 「第N章#M」；没有镜号/章号的任务（IC 生成新章节剧本分镜等）写成任务名，不再出现 null（Andy 11-25 截图）
const JOB_ZH = { create: '生成剧本分镜', regenerate: '出片', 'prompt-write': '写提示词', export: '导出' };
function shotLabel(c) { if (!c) return ''; const ch = c.ch != null ? `第${c.ch}章` : ''; if (c.num != null) return `${ch}#${c.num}`; return [ch, JOB_ZH[c.type] || c.type || 'IC 任务'].filter(Boolean).join(' · '); }
export async function handleOverview(req, res, url, send) {
  const part = url.searchParams.get('part') || 'top';
  if (part === 'projects') { try { return send(res, 200, { part, ok: true, at: new Date().toISOString(), data: { projects: projectList(), defaultId: PROJECT } }); } catch (e) { return send(res, 200, { part, ok: false, error: String(e.message || e), data: null }); } }
  const fn = { top: computeTop, issues: computeIssues, sessions: computeSessions, trends: computeTrends, metrics: computeMetrics }[part];
  if (!fn) return send(res, 404, { error: 'unknown part' });
  const qp = url.searchParams.get('project');
  const project = qp && /^[0-9a-f-]{36}$/i.test(qp) ? qp.toLowerCase() : PROJECT;
  const r = await getPart(part, fn, project, url.searchParams.get('force') === '1');
  return send(res, 200, { part, ok: r.ok, at: r.at, failedAt: r.failedAt || null, error: r.error || null, refreshSec: TTL[part] / 1000, data: r.data });
}
