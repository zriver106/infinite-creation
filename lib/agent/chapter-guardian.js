// 续章守护（2026-11-17 Andy 8:27 / 8:28 定）：出片守护 + 分镜守护，各管各的，每 60 秒查一次所有勾了开关的项目。
// 决策是纯函数（chapter-guardian-plan.js）；这里只读库、提交、写日志、记状态。
//   - 提交只走现有入口：出片 = startSingleChapterRun（= 单章 /run，自带同章去重），分镜 = submitStoryboardJob(auto=true)。
//   - 不调用不带章节的 /run，不写 SQL，不停 / 不取消任何任务。
//   - 每次触发、每次跳过都写日志（data/logs/chapter-guardian.log，JSON 一行一条 + logger）；同样的跳过原因连续出现时
//     10 分钟内只记一次（状态里照常显示，并累计次数）。
//   - 状态挂 globalThis：server.js 与各 route 的打包实例共享（GET /api/projects/:id/auto-next 读它给界面）。
//   - 循环用 setTimeout 链，每轮 try/catch，出错照样排下一轮；重启后 server.js 重新拉起。
//   - 总开关 config.generation.chapterGuardian === false：守护不提交，任务收尾钩子回到旧的「收尾即续」规则（auto-chain.js）。
import fs from 'node:fs';
import path from 'node:path';
import { Projects, Chapters, Shots, Jobs, logger, readAutoNextSettings, chapterMainExports, loadConfig, DATA_DIR } from '../core/index.js';
import { activeJobOfChapter } from './job-runner.js';
import { startSingleChapterRun, submitStoryboardJob } from './auto-chain.js';
import { planVideoGuard, planStoryboardGuard, guardianEnabled, GUARDIAN_INTERVAL_MS } from './chapter-guardian-plan.js';
import { chainHoldReason } from './recovery-adopt.js';

export { guardianEnabled, GUARDIAN_INTERVAL_MS };

const KEY = '__icChapterGuardian';
const G = (globalThis[KEY] = globalThis[KEY] || {
  started: false, timer: null, kickTimer: null, running: false,
  intervalMs: GUARDIAN_INTERVAL_MS, lastTickAt: 0, ticks: 0,
  status: {}, // projectId → { video, storyboard }
  lastLog: {}, // projectId:kind → { sig, at, repeats }
  kick: null, onProgress: null,
});

const LABEL = { video: '出片守护', storyboard: '分镜守护' };
const THROTTLE_MS = 10 * 60 * 1000;

export function guardianLogFile() { return path.join(DATA_DIR, 'logs', 'chapter-guardian.log'); }

function hhmm(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function writeLog(rec) {
  try {
    const f = guardianLogFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 写不进去不影响守护 */ }
  const msg = '续章守护 ' + rec.guard + ' [' + rec.projectName + '] ' + rec.action + '：' + rec.reason + (rec.jobId ? ' job=' + rec.jobId : '');
  if (rec.action === 'error') logger.error(msg, { projectId: rec.projectId }); else logger.info(msg, { projectId: rec.projectId });
}

function record(project, kind, r, extra = {}) {
  const now = Date.now();
  const st = (G.status[project.id] = G.status[project.id] || {});
  const prevSt = st[kind] || {};
  const lastSubmit = r.action === 'submit' && extra.jobId ? { chapter: r.chapter, jobId: extra.jobId, at: now } : prevSt.lastSubmit || null;
  st[kind] = { action: r.action, code: r.code, reason: r.reason, chapter: r.chapter || '', at: now, lastSubmit, ...extra };
  st[kind].line = statusLine(kind, st[kind]);
  if (r.action === 'off') { delete G.lastLog[project.id + ':' + kind]; return; }
  const lk = project.id + ':' + kind;
  const sig = r.action + '|' + r.code + '|' + r.reason;
  const last = G.lastLog[lk];
  if (r.action === 'skip' && last && last.sig === sig && now - last.at < THROTTLE_MS) { last.repeats++; return; }
  const repeats = last && last.sig === sig ? last.repeats : 0;
  G.lastLog[lk] = { sig, at: now, repeats: 0 };
  writeLog({
    t: new Date(now).toISOString(), local: hhmm(now), projectId: project.id, projectName: project.name, guard: LABEL[kind], kind,
    action: r.action, code: r.code, chapter: r.chapter || '', reason: r.reason, ...(repeats ? { repeatedSinceLastLog: repeats } : {}), ...extra,
  });
  if (G.onProgress && r.action !== 'skip') {
    try { G.onProgress({ projectId: project.id, type: 'guardian', phase: LABEL[kind], detail: st[kind].line }); } catch { /* noop */ }
  }
}

function chapterNo(title) { const m = /第\s*(\d+)\s*章/.exec(String(title || '')); return m ? m[1] : String(title || ''); }

/** 界面一行：「出片守护：正常 / 已续第N章 / 跳过：原因」 */
export function statusLine(kind, s) {
  const head = LABEL[kind] + '：';
  if (!s) return head + '还没检查过';
  if (s.action === 'off') return head + '未开启';
  const tail = s.lastSubmit && s.action !== 'submit' ? '（上次已续第' + chapterNo(s.lastSubmit.chapter) + '章 ' + hhmm(s.lastSubmit.at).slice(6, 11) + '）' : '';
  if (s.action === 'submit') return head + '已续第' + chapterNo(s.chapter) + '章（' + String(s.jobId || '').slice(0, 8) + ' ' + hhmm(s.at).slice(6, 11) + '）';
  if (s.action === 'error') return head + '出错：' + s.reason + tail;
  if (s.code === 'project-busy' || s.code === 'sb-busy' || s.code === 'recovery-waiting') return head + '正常（' + s.reason + '）' + tail;
  return head + '跳过：' + s.reason + tail;
}

/** 给 GET /auto-next：两个守护的状态（server 实例写、route 实例读，经 globalThis 共享） */
export function guardianStatus(projectId) {
  const st = G.status[projectId] || {};
  const on = guardianEnabled(loadConfig());
  return {
    enabled: on, started: !!G.started, intervalMs: G.intervalMs, lastTickAt: G.lastTickAt || 0,
    video: st.video || null, storyboard: st.storyboard || null,
    lines: on
      ? [st.video ? st.video.line : statusLine('video', null), st.storyboard ? st.storyboard.line : statusLine('storyboard', null)]
      : ['续章守护已关闭（config.generation.chapterGuardian=false，收尾钩子按旧规则续章）'],
  };
}

function inputsFor(project) {
  const shots = Shots.list(project.id);
  const shotCount = new Map();
  for (const s of shots) shotCount.set(s.chapter || '', (shotCount.get(s.chapter || '') || 0) + 1);
  const cache = new Map();
  const exportedOf = (t) => {
    if (!cache.has(t)) cache.set(t, chapterMainExports(project.id, project.name, t).length > 0);
    return cache.get(t);
  };
  return {
    settings: readAutoNextSettings(project),
    chapters: Chapters.list(project.id).map((c) => c.title),
    jobs: Jobs.list(project.id),
    shotCountOf: (t) => shotCount.get(t) || 0,
    exportedOf,
    chapterBusy: (t) => !!activeJobOfChapter(project.id, t),
    chainHold: (() => { try { return chainHoldReason(project.id); } catch { return ''; } })(),
  };
}

function submitVideo(project, r) {
  const res = startSingleChapterRun({ projectId: project.id, chapter: r.chapter, onProgress: G.onProgress || undefined });
  if (res.deduped) return { action: 'skip', code: 'deduped', chapter: r.chapter, reason: '「' + r.chapter + '」已有任务 ' + res.job.id.slice(0, 8) + '，未重复提交' };
  const pc = res.job && res.job.checkpoint && res.job.checkpoint.assetPrecheck;
  return { ...r, jobId: res.job.id, ...(pc ? { assetPrecheck: pc } : {}) };
}

function submitStoryboard(project, r) {
  const row = Chapters.list(project.id).find((c) => c.title === r.chapter);
  if (!row) return { action: 'skip', code: 'gone', chapter: r.chapter, reason: '「' + r.chapter + '」已不存在' };
  const res = submitStoryboardJob({ projectId: project.id, chapter: row, onProgress: G.onProgress || undefined, auto: true });
  return { ...r, jobId: res.job.id };
}

function runOne(project, kind) {
  const inp = inputsFor(project); // 每个守护各读一次：出片守护刚提交的任务，分镜守护这次就能看到
  const r = kind === 'video' ? planVideoGuard(inp) : planStoryboardGuard(inp);
  if (r.action !== 'submit') return record(project, kind, r);
  let out;
  try {
    out = kind === 'video' ? submitVideo(project, r) : submitStoryboard(project, r);
  } catch (e) {
    return record(project, kind, { action: 'error', code: (e && e.code) || 'submit-failed', chapter: r.chapter, reason: '提交「' + r.chapter + '」失败：' + (e && e.message ? e.message : String(e)) });
  }
  if (out.action !== 'submit') return record(project, kind, out);
  const { jobId, assetPrecheck, ...rest } = out;
  record(project, kind, rest, { jobId, ...(assetPrecheck ? { assetPrecheck } : {}) });
}

/** 查一轮。reason 只用于日志。 */
export function guardianTick(reason = 'timer') {
  if (G.running) return;
  G.running = true;
  try {
    G.lastTickAt = Date.now();
    G.ticks++;
    if (!guardianEnabled(loadConfig())) return;
    for (const p of Projects.list()) {
      const s = readAutoNextSettings(p);
      if (!s.video.enabled && !s.storyboard.enabled) {
        if (G.status[p.id]) { record(p, 'video', { action: 'off', code: 'off', reason: '' }); record(p, 'storyboard', { action: 'off', code: 'off', reason: '' }); }
        continue;
      }
      for (const kind of ['video', 'storyboard']) {
        try { runOne(Projects.get(p.id) || p, kind); } catch (e) {
          try { record(p, kind, { action: 'error', code: 'tick-error', reason: '检查出错：' + (e && e.message ? e.message : String(e)) }); } catch { /* noop */ }
        }
      }
    }
  } catch (e) {
    logger.error('续章守护：本轮检查出错（下一轮照常）', { reason, error: e && e.message });
  } finally {
    G.running = false;
  }
}

/** server.js 启动时调用一次。首轮在 intervalMs 后（给重启恢复先接手被打断的任务）。 */
export function startChapterGuardian({ onProgress, intervalMs = GUARDIAN_INTERVAL_MS } = {}) {
  if (G.started) return;
  G.started = true;
  G.intervalMs = intervalMs;
  G.onProgress = onProgress || null;
  const loop = () => {
    try { guardianTick('timer'); } catch (e) { logger.error('续章守护：循环出错', { error: e && e.message }); }
    G.timer = setTimeout(loop, G.intervalMs);
  };
  G.timer = setTimeout(loop, intervalMs);
  // 任务收尾时（auto-chain.js）调用：5 秒后多查一轮，不改 60 秒的固定节奏
  G.kick = (why) => {
    if (G.kickTimer) return;
    G.kickTimer = setTimeout(() => { G.kickTimer = null; try { guardianTick('kick:' + (why || '')); } catch { /* noop */ } }, 5000);
  };
  writeLog({ t: new Date().toISOString(), local: hhmm(Date.now()), projectId: '', projectName: '-', guard: '续章守护', kind: 'start', action: 'start', code: 'start', reason: '已启动，每 ' + Math.round(intervalMs / 1000) + ' 秒检查一次；总开关 ' + (guardianEnabled(loadConfig()) ? '开' : '关（旧规则）') });
}
