// 重启恢复（2026-11-17 第三轮）：后端重启时 startupCleanup 会把 running 任务一律标 interrupted、且不续跑；
// 外部 Agent（claude.exe）是独立进程，旧后端退出后它照样把这一章做完，但新后端里没有 afterOk，
// 「自动生成下一章」就断在这里。本模块在启动后接手「本次启动刚被标 interrupted 的出片任务」：
//   1. 该任务的外部 Agent 进程还活着 → 轮询等它退出（不插手、不重复提交）；
//   2. 进程不在了，且本章已真正出片（全部分镜有视频 + 有一份晚于任务开始的主成片）
//      → 任务记为 done，补交付（交付日志里没有这份成片的成功记录时），再走正常收尾的自动续章；
//   3. 进程不在了、也没出完 → 等同于点本章「继续」（startSingleChapterRun，自带同章去重，不清已完成分镜）。
// 只处理本次启动时被标 interrupted 的 create 出片任务；「只生成分镜」任务不自动重拆（那会清空本章分镜），只记一笔。
// 不调用不带章节的 /run，不碰别的章节，不写 SQL。
//
// ic25（2026-11-17）：外部 Agent 还活着的任务在启动时就标成 adopted（接管中），不再标 interrupted；本模块同时接手
// 「本次启动 interrupted 的」和「所有 adopted 的」（后者跨重启：后端再重启也接着监视，进程身份见 recovery-adopt.js 的
// 监视检查点）。进程退出后的判定前先现读运行时开关（DATA_DIR/control/restart-recovery.json）：只记录 / 不自动继续 /
// 不触发续章。adopted 任务离开接管时一律落成 done / interrupted / cancelled，不会悬着。
import { spawnSync } from 'node:child_process';
import { Projects, Shots, Jobs, logger, withWriteContext, chapterMainExports, deliverChapterExport, readDeliveryLog } from '../core/index.js';
import { startSingleChapterRun, continueAutoChain } from './auto-chain.js';
import { ADOPTED, WAITING_TEXT, isRecoverableJob, trackedAgentAlive, readRecoveryControl, describeControl, leaveAdopted, getWatchEntry, putWatchEntry, dropWatchEntry, recoveryLog } from './recovery-adopt.js';
export { releaseAdoptedJob, planAdoptionAtBoot, commitAdoption, readRecoveryControl, ADOPTED } from './recovery-adopt.js';
// 孤儿排队任务（重启后 queued 却没有执行者）的收尾在 orphan-jobs.js；这里转出，server.js 统一从本模块取。
export { settleOrphanQueuedJobs, settleOrphanJob, isOrphanQueued } from './orphan-jobs.js';

const POLL_MS = 30 * 1000;
const MAX_WAIT_MS = 24 * 3600 * 1000;
const MAX_PROBE_FAILS = 20;

/** 列出命令行里含 agent-workspaces 的进程命令行（外部 Agent CLI 的 --mcp-config 指向 agent-workspaces/<jobId>/）。失败返回 null（状态不明）。 */
export function listAgentCommandLines() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"CommandLine like '%agent-workspaces%'\" | ForEach-Object { $_.CommandLine }"],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0 || r.error) return null;
      return String(r.stdout || '').split(/\r?\n/).filter(Boolean);
    }
    const r = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0 || r.error) return null;
    return String(r.stdout || '').split('\n').filter((l) => l.includes('agent-workspaces'));
  } catch {
    return null;
  }
}

/** 该任务的外部 Agent 进程是否还活着：true / false / null（查不到进程表）。 */
export function agentAlive(jobId, lister = listAgentCommandLines) {
  const lines = lister();
  if (!Array.isArray(lines)) return null;
  const re = new RegExp('agent-workspaces[\\\\/]+' + String(jobId).replace(/[^0-9a-zA-Z-]/g, '') + '([\\\\/"\\s]|$)');
  return lines.some((l) => re.test(l));
}

/** 本章是否已由该任务真正出片：与 continueAutoChain 的「出片成功」同口径。 */
export function chapterFinishedByJob(projectId, job) {
  const project = Projects.get(projectId);
  const title = String((job.checkpoint && job.checkpoint.chapter) || '');
  if (!project || !title) return { finished: false, reason: '项目或章节不存在' };
  const mine = Shots.list(projectId).filter((s) => s.chapter === title);
  const allRendered = mine.length > 0 && mine.every((s) => s.status === 'done' && s.video_path);
  const latest = chapterMainExports(projectId, project.name, title)[0];
  const fresh = !!latest && latest.mtimeMs >= (Number(job.startedAt) || 0) - 2000;
  return {
    finished: allRendered && fresh,
    latest,
    reason: !mine.length ? '本章没有分镜' : !allRendered ? '本章还有分镜没出视频' : !fresh ? '没有晚于任务开始的主成片' : '',
  };
}

function appendDetail(jobId, text) {
  const cur = Jobs.get(jobId);
  if (!cur) return;
  Jobs.update(jobId, { detail: String(cur.detail || '').slice(0, 1800) + '\n\n【重启恢复】' + text });
}

/** 选出「本次启动刚被 startupCleanup 标 interrupted」的出片任务。since = 启动清理之前取的时间戳。 */
export function pickInterruptedJobs(since) {
  return Jobs.list().filter((j) => j.status === 'interrupted'
    && Number(j.finishedAt || 0) >= since
    && j.type === 'create'
    && j.checkpoint && j.checkpoint.chapter);
}

/** ic25：所有「接管中」的出片任务（不看 since：后端再重启也要接着监视）。 */
export function pickAdoptedJobs() {
  return Jobs.list().filter((j) => j.status === ADOPTED && isRecoverableJob(j));
}

// 判定结束：interrupted 任务只改 detail / 状态；adopted 任务顺带离开接管（删监视检查点、写审计日志）
function finishAs(cur, status, text, extra = {}) {
  if (cur.status === ADOPTED) return leaveAdopted(cur.id, status, text, extra);
  if (status === 'interrupted') { appendDetail(cur.id, text); return Jobs.get(cur.id); }
  return withWriteContext('job:restart-recovery', () => Jobs.update(cur.id, { status, ...extra, detail: String(cur.detail || '').slice(0, 1800) + '\n\n【重启恢复】' + text }));
}

/**
 * 进程已退出后处理一个任务。deps 可注入（单测用）。
 * @returns {Promise<{action:'done'|'resumed'|'skipped', detail:string, next?:object}>}
 */
export async function settleInterruptedJob(job, deps = {}) {
  const startRun = deps.startRun || startSingleChapterRun;
  const autoChain = deps.autoChain || continueAutoChain;
  const deliver = deps.deliver || deliverChapterExport;
  const onProgress = deps.onProgress;
  const projectId = job.projectId;
  const title = String(job.checkpoint.chapter);
  const cur = Jobs.get(job.id);
  if (!cur || (cur.status !== 'interrupted' && cur.status !== ADOPTED)) {
    if (!cur || cur.status !== ADOPTED) dropWatchEntry(job.id);
    return { action: 'skipped', detail: '任务状态已变为 ' + (cur && cur.status) + '，不处理' };
  }
  if (cur.checkpoint && cur.checkpoint.storyboardOnly) {
    finishAs(cur, 'interrupted', '只生成分镜任务被重启打断：不自动重拆（会清空本章分镜），请人工确认');
    return { action: 'skipped', detail: '只生成分镜任务，不自动重拆' };
  }
  // 同章在它之后已经有别的任务（用户手动「继续」过等）→ 不插手
  const newer = Jobs.list(projectId).find((j) => j.id !== job.id && j.type === 'create' && j.checkpoint && j.checkpoint.chapter === title && Number(j.startedAt) > Number(cur.startedAt));
  if (newer) {
    finishAs(cur, 'interrupted', '本章已有更新的任务 ' + newer.id + '（' + newer.status + '），不再处理');
    return { action: 'skipped', detail: '本章已有更新的任务' };
  }

  const st = chapterFinishedByJob(projectId, cur);
  // ic25 运行时开关：每次判定现读，不用重启后端
  const ctl = deps.control || readRecoveryControl(projectId);
  const ctlNote = ctl.source === 'default' || ctl.source === 'disabled' ? '' : '（运行时开关：' + describeControl(ctl) + '）';
  if (ctl.reportOnly) {
    const verdict = st.finished ? '本章已出片（' + st.latest.rel + '）' : '本章未完成（' + st.reason + '）';
    const text = '外部 Agent 已退出，' + verdict + '；运行时开关=只记录：没有自动记完成 / 补交付 / 继续 / 续章，任务保持「已中断」，请人工处理';
    finishAs(cur, 'interrupted', text);
    recoveryLog({ event: 'report-only', jobId: cur.id, projectId, chapter: title, finished: !!st.finished, reason: st.reason || '' });
    logger.info('重启恢复：' + text, { projectId, jobId: job.id });
    return { action: 'reported', detail: text, finished: !!st.finished };
  }
  if (st.finished) {
    let deliverNote = '';
    try {
      const log = readDeliveryLog(projectId, 200);
      const delivered = log.some((e) => e && e.status === 'ok' && e.exportRel === st.latest.rel);
      if (delivered) deliverNote = '交付已在出片时完成';
      else {
        const d = await deliver({ projectId, chapterTitle: title, exportRel: st.latest.rel, source: 'restart-recovery' });
        deliverNote = '补交付：' + (d && d.status) + (d && d.reason ? '（' + d.reason + '）' : '') + (d && d.error ? '（' + d.error + '）' : '');
      }
    } catch (e) {
      deliverNote = '补交付出错：' + (e && e.message ? e.message : String(e));
    }
    const text = '外部 Agent 已退出，本章已出片（' + st.latest.rel + '）→ 记为完成；' + deliverNote + (ctl.chain ? '' : '；运行时开关=不触发续章：没有自动续下一章') + ctlNote;
    finishAs(Jobs.get(job.id), 'done', text, { phase: '完成', error: '', finishedAt: Date.now() });
    logger.info('重启恢复：' + text, { projectId, jobId: job.id });
    recoveryLog({ event: 'done', jobId: job.id, projectId, chapter: title, export: st.latest.rel, chain: !!ctl.chain });
    if (onProgress) { try { onProgress({ projectId, jobId: job.id, type: 'create', phase: '完成', status: 'done', detail: text }); } catch { /* noop */ } }
    let next = null;
    if (ctl.chain) {
      try { next = autoChain({ projectId, job: Jobs.get(job.id), onProgress }); } catch (e) {
        logger.error('重启恢复：自动续章失败', { projectId, jobId: job.id, error: e && e.message });
      }
    }
    return { action: 'done', detail: text, next, chained: !!ctl.chain };
  }

  if (!ctl.resume) {
    const text = '外部 Agent 已退出，本章未完成（' + st.reason + '）；运行时开关=不自动继续：没有重新提交，任务保持「已中断」，需要时人工点本章「继续」' + ctlNote;
    finishAs(cur, 'interrupted', text);
    recoveryLog({ event: 'no-resume', jobId: cur.id, projectId, chapter: title, reason: st.reason });
    logger.info('重启恢复：' + text, { projectId, jobId: job.id });
    return { action: 'held', detail: text };
  }

  // 接管中的任务先退回 interrupted，再按本章「继续」提交：否则同章去重会把它自己当成「本章已有任务」
  if (cur.status === ADOPTED) leaveAdopted(cur.id, 'interrupted', '外部 Agent 已退出，本章未完成（' + st.reason + '）→ 退出接管，按本章「继续」处理');
  let r;
  try {
    r = startRun({ projectId, chapter: title, onProgress });
  } catch (e) {
    const msg = '外部 Agent 已退出，本章未完成（' + st.reason + '），按本章「继续」重新提交失败：' + (e && e.message ? e.message : String(e));
    appendDetail(job.id, msg);
    logger.error('重启恢复：' + msg, { projectId, jobId: job.id });
    return { action: 'skipped', detail: msg };
  }
  const text = '外部 Agent 已退出，本章未完成（' + st.reason + '）→ 已按本章「继续」重新提交' + (r && r.deduped ? '（该章已有任务，未重复提交）' : '') + '：' + (r && r.job ? r.job.id : '');
  appendDetail(job.id, text);
  logger.info('重启恢复：' + text, { projectId, jobId: job.id });
  return { action: 'resumed', detail: text, next: r && r.job };
}

/**
 * 启动入口：server.js 在 startupCleanup 之后调用。since = startupCleanup 之前的时间戳。
 * 对每个任务：进程活着就每 POLL_MS 查一次直到退出，然后 settleInterruptedJob。
 */
export function startRestartRecovery({ since, onProgress, pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS, alive = trackedAgentAlive, deps = {} } = {}) {
  let jobs = [];
  try {
    const seen = new Set();
    jobs = [...pickInterruptedJobs(since), ...pickAdoptedJobs()].filter((j) => !seen.has(j.id) && seen.add(j.id));
  } catch (e) {
    logger.error('重启恢复：读取任务失败', { error: e && e.message });
    return [];
  }
  if (!jobs.length) return [];
  logger.info('重启恢复：接手出片任务 ' + jobs.length + ' 个', { jobs: jobs.map((j) => j.id + ' ' + j.checkpoint.chapter + ' ' + j.status) });
  return jobs.map((job) => new Promise((resolve) => {
    // 等待上限从第一次接管算起（检查点里有就沿用），后端再重启不会把 24 小时重新计时
    const entry0 = getWatchEntry(job.id);
    const t0 = Number(entry0 && entry0.adoptedAt) || Date.now();
    let fails = 0;
    let noted = false;
    let lastMark = 0;
    // 状态被别处改掉（取消接管 / 用户手动处理）→ 不再监视
    const stillMine = () => { const c = Jobs.get(job.id); return !!c && (c.status === 'interrupted' || c.status === ADOPTED); };
    const giveUp = (text, detail) => {
      const c = Jobs.get(job.id);
      if (c && c.status === ADOPTED) leaveAdopted(c.id, 'interrupted', text);
      else appendDetail(job.id, text);
      return resolve({ jobId: job.id, action: 'skipped', detail });
    };
    const tick = async () => {
      try {
        if (!stillMine()) {
          dropWatchEntry(job.id);
          return resolve({ jobId: job.id, action: 'skipped', detail: '任务状态已变为 ' + ((Jobs.get(job.id) || {}).status) + '，不再监视' });
        }
        const a = alive(job.id);
        if (a === null) {
          fails++;
          if (fails >= MAX_PROBE_FAILS) return giveUp('查不到进程表，状态不明，不自动处理', '进程表不可用');
          return setTimeout(tick, pollMs);
        }
        fails = 0;
        if (a) {
          const adopted = (Jobs.get(job.id) || {}).status === ADOPTED;
          if (!noted) {
            noted = true;
            // adopted 的 detail 已由启动时的 commitAdoption 写过，这里不重复
            if (!adopted) appendDetail(job.id, '外部 Agent 进程仍在运行：等它结束后再判定完成 / 继续');
            logger.info('重启恢复：' + WAITING_TEXT + '，等待退出', { jobId: job.id, chapter: job.checkpoint.chapter, status: adopted ? ADOPTED : 'interrupted' });
          }
          if (adopted && Date.now() - lastMark > 5 * 60 * 1000) {
            lastMark = Date.now();
            if (getWatchEntry(job.id)) putWatchEntry(job.id, { lastAliveAt: lastMark });
          }
          if (Date.now() - t0 > maxWaitMs) return giveUp('等待外部 Agent 超时，不自动处理', '等待超时');
          return setTimeout(tick, pollMs);
        }
        const r = await settleInterruptedJob(job, { onProgress, ...deps });
        resolve({ jobId: job.id, ...r });
      } catch (e) {
        logger.error('重启恢复失败', { jobId: job.id, error: e && e.message });
        try {
          const c = Jobs.get(job.id);
          if (c && c.status === ADOPTED) leaveAdopted(c.id, 'interrupted', '判定出错，退出接管，不自动处理：' + (e && e.message));
        } catch { /* noop */ }
        resolve({ jobId: job.id, action: 'skipped', detail: '出错：' + (e && e.message) });
      }
    };
    setTimeout(tick, 0);
  }));
}
