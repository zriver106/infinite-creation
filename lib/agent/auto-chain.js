// 单章提交入口 + 「自动生成下一章 / 下一章分镜」收尾钩子。
//
// 两个入口，各自是唯一的提交者：
//   startSingleChapterRun —— 单章「生成 / 继续」。/run 单章分支、自动生成下一章都调它（同一条路，不走 startCreateAllJobs）。
//   submitStoryboardJob   —— 只生成分镜（= 原 regenerate?mode=full）。章节卡片「生成分镜」、生成操作里的
//                            「重新生成分镜」、自动生成下一章分镜都调它。
// 两者都把 continueAutoChain 作为 startCreateJob 的 afterOk：本任务收尾之后才决定要不要续，
// 每条队列最多再提交一个任务。双队列（视频队列 = job 闸门；分镜队列 = 文本闸门）由 job-runner 的
// storyboardLane / runJobTask 决定，这里只按队列判忙、挑章。
import { Projects, Chapters, Shots, Jobs, logger, withWriteContext, readAutoNextSettings, chapterMainExports, loadConfig } from '../core/index.js';
import { startCreateJob, activeJobOfChapter, storyboardLane, jobQueueOf } from './job-runner.js';
import { planAutoChain } from './auto-chain-plan.js';
import { guardianEnabled } from './chapter-guardian-plan.js';

// ic25：adopted（重启恢复接管中，外部 Agent 还在跑）也算活动，不当成已结束
const isActive = (j) => j.status === 'running' || j.status === 'queued' || j.status === 'adopted';

export function startSingleChapterRun({ projectId, chapter, onProgress }) {
  const title = String(chapter || '');
  if (!title) throw new Error('缺少章节');
  // 与 /run 单章分支原逻辑一致：同一章已有任务就返回原任务，不重复建
  const active = activeJobOfChapter(projectId, title);
  if (active) return { job: active, deduped: true };
  Projects.update(projectId, { status: 'running' });
  try {
    const job = startCreateJob({
      projectId,
      chapter: title,
      onProgress,
      afterOk: (done) => continueAutoChain({ projectId, job: done, onProgress }),
    });
    return { job, deduped: false };
  } catch (e) {
    Projects.update(projectId, { status: 'idle' });
    throw e;
  }
}

/**
 * 只生成分镜（只跑 LLM 文本，renderDisabled，不提交 ComfyUI）。chapter 是章节行（要有 id、title）。
 * 同一章已有 running/queued 任务（任一队列）时抛 code=CHAPTER_BUSY（路由翻 409）——同一章不能同时在两个队列里。
 * 清空本章旧分镜延迟到真正拿到执行槽时才做；排队中被取消则一行都不动（与原 regenerate?mode=full 同口径）。
 * auto=true（自动续分镜）：本章已有分镜或已出片就拒绝（code=CHAPTER_HAS_OUTPUT）——分镜队列不碰已有产出的章，
 * 只有用户手动点「生成分镜」（auto=false，前端先弹确认）才会重拆。
 */
export function submitStoryboardJob({ projectId, chapter, onProgress, auto = false }) {
  const busy = activeJobOfChapter(projectId, chapter.title);
  if (busy) {
    throw Object.assign(new Error('「' + chapter.title + '」已有任务在跑或排队，请等它结束或先停止'), { code: 'CHAPTER_BUSY', job: busy });
  }
  const shots = Shots.list(projectId).filter((s) => s.chapter === chapter.title);
  if (auto) {
    const project = Projects.get(projectId);
    const exported = project ? chapterMainExports(projectId, project.name, chapter.title).length > 0 : false;
    if (shots.length || exported) {
      throw Object.assign(new Error('「' + chapter.title + '」' + (exported ? '已出片' : '已有分镜') + '，自动续分镜不重拆'), { code: 'CHAPTER_HAS_OUTPUT' });
    }
  }
  const beforeRun = () => withWriteContext('job:regenerate-chapter-full', () => {
    // 清空本章分镜 + 复位章节状态是两次写入：包一个写上下文，日志才能按批定位 / 整批回滚。
    // 按 id 重新取一次：排队期间用户可能已删掉其中几条
    for (const s of shots) if (Shots.get(s.id)) Shots.remove(s.id);
    Chapters.update(chapter.id, { status: 'pending' });
  });
  const job = startCreateJob({
    projectId,
    chapter: chapter.title,
    onProgress,
    beforeRun,
    renderDisabled: true,
    afterOk: (done) => continueAutoChain({ projectId, job: done, onProgress }),
  });
  return { job, reset: shots.length };
}

function lastVideoJobDoneFn(jobs) {
  return (title) => {
    // Jobs.list 按 started_at DESC：第一条已结束的出片任务就是「最近一次」
    const j = jobs.find((x) => x.type === 'create' && !isActive(x) && x.checkpoint && x.checkpoint.chapter === title && !x.checkpoint.storyboardOnly);
    return !!j && j.status === 'done';
  };
}

// 把本次决策写进刚结束任务的 detail 末尾（任务队列卡片里能看到「为什么续 / 为什么停」），并写日志
function note(job, projectId, onProgress, text) {
  logger.info('自动续章：' + text, { projectId, jobId: job.id });
  try {
    const cur = Jobs.get(job.id);
    if (cur) Jobs.update(job.id, { detail: String(cur.detail || '').slice(0, 2000) + '\n\n【自动续章】' + text });
  } catch { /* 写不进去不影响 */ }
  if (onProgress) {
    try { onProgress({ projectId, jobId: job.id, type: 'create', phase: '自动续章', detail: text }); } catch { /* noop */ }
  }
}

/**
 * afterOk 钩子：设置在此刻重新从库里读（中途取消勾选 → 跑完当前章就停）。
 * cancelled 也会走到这里（finishJobOk 发现停止标记时记 cancelled），planAutoNext 会返回「停」。
 */
export function continueAutoChain({ projectId, job, onProgress }) {
  if (!job) return null;
  const project = Projects.get(projectId);
  if (!project) return null;
  const settings = readAutoNextSettings(project);
  if (!settings.video.enabled && !settings.storyboard.enabled) return null; // 都没勾：保持原行为，不写任何东西
  // 续章守护（2026-11-17 Andy 8:27/8:28）：守护开着时，收尾这里不再直接提交——旧规则（视频队列里有任何任务、
  // 哪怕是别的项目的，就不续）随之停用，改由出片守护 / 分镜守护每 60 秒按本项目状态判断；两套机制不会同时提交。
  // 这里只记一笔并让守护 5 秒后多查一轮。config.generation.chapterGuardian=false 时回到下面的旧规则。
  if (guardianEnabled(loadConfig())) {
    note(job, projectId, onProgress, '本任务已收尾（' + job.status + '）；续章交给「续章守护」（出片守护 / 分镜守护每 60 秒检查），收尾这里不直接提交');
    try { const g = globalThis.__icChapterGuardian; if (g && typeof g.kick === 'function') g.kick(job.id); } catch { /* noop */ }
    return null;
  }
  const cp = job.checkpoint || {};
  const title = String(cp.chapter || '');
  if (!title) return null;
  const kind = cp.storyboardOnly ? 'storyboard' : 'video';

  const shots = Shots.list(projectId);
  const shotCount = new Map();
  for (const s of shots) shotCount.set(s.chapter || '', (shotCount.get(s.chapter || '') || 0) + 1);
  const exportCache = new Map();
  const exportsOf = (t) => {
    if (!exportCache.has(t)) exportCache.set(t, chapterMainExports(projectId, project.name, t));
    return exportCache.get(t);
  };

  // 「成功」判定：
  //   分镜任务：done 且本章至少写出一条分镜
  //   出片任务：done、本章全部分镜都出了视频、并且有一份本任务开始之后写出的主成片（出片成功）
  let ok = false;
  let okReason = '';
  if (job.status === 'done') {
    const mine = shots.filter((s) => s.chapter === title);
    if (kind === 'storyboard') {
      ok = mine.length > 0;
      okReason = ok ? '' : '任务结束但没有写出分镜';
    } else {
      const allRendered = mine.length > 0 && mine.every((s) => s.status === 'done' && s.video_path);
      const latest = exportsOf(title)[0];
      const fresh = !!latest && latest.mtimeMs >= (Number(job.startedAt) || 0) - 2000;
      ok = allRendered && fresh;
      okReason = !mine.length ? '本章没有分镜' : !allRendered ? '本章还有分镜没出视频' : !fresh ? '本次任务没有合成出新成片' : '';
    }
  }

  const all = Jobs.list();
  const projectJobs = all.filter((j) => j.projectId === projectId);
  const others = all.filter((j) => j.id !== job.id && isActive(j));
  // 双队列判忙：只看「同一条队列」里有没有活动任务（任意项目，避开排队超时、不插 V2 的队）。
  // dual=false（总开关关 / 本机 LLM 等，分镜任务仍走 job 闸门）时两条链共用一条队，任一活动任务都算忙。
  const dual = storyboardLane(loadConfig()).lane === 'text';
  const chapterBusy = (t) => !!activeJobOfChapter(projectId, t);
  const lastSbJobOk = (t) => {
    // Jobs.list 按 started_at DESC：第一条已结束的只拆分镜任务就是最近一次；没有 = 分镜来自整章生成，算完成
    const j = projectJobs.find((x) => x.type === 'create' && !isActive(x) && x.checkpoint && x.checkpoint.chapter === t && x.checkpoint.storyboardOnly);
    return !j || j.status === 'done';
  };
  const plan = planAutoChain({
    finished: { kind, status: job.status, chapter: title, ok, okReason },
    settings,
    chapters: Chapters.list(projectId).map((c) => c.title),
    shotCountOf: (t) => shotCount.get(t) || 0,
    exportedOf: (t) => exportsOf(t).length > 0,
    lastVideoJobDone: lastVideoJobDoneFn(projectJobs),
    chapterBusy,
    storyboardReady: (t) => (shotCount.get(t) || 0) > 0 && !chapterBusy(t) && lastSbJobOk(t),
    dual,
    videoQueueBusy: others.some((j) => jobQueueOf(j) === 'gpu'),
    textQueueBusy: others.some((j) => jobQueueOf(j) === 'text'),
    projectBusy: others.some((j) => j.projectId === projectId),
  });

  for (const s of plan.stops) note(job, projectId, onProgress, '「' + s.chain + '」' + s.reason);
  const submitted = [];
  for (const sub of plan.submits) {
    try {
      if (sub.kind === 'video') {
        const r = startSingleChapterRun({ projectId, chapter: sub.chapter, onProgress });
        note(job, projectId, onProgress, sub.note + (r.deduped ? '（该章已有任务，未重复提交）' : ''));
        submitted.push(r.job);
        continue;
      }
      const row = Chapters.list(projectId).find((c) => c.title === sub.chapter);
      if (!row) {
        note(job, projectId, onProgress, '「自动生成下一章分镜」「' + sub.chapter + '」已不存在，已停');
        continue;
      }
      const r = submitStoryboardJob({ projectId, chapter: row, onProgress, auto: true });
      note(job, projectId, onProgress, sub.note);
      submitted.push(r.job);
    } catch (e) {
      note(job, projectId, onProgress, '提交「' + sub.chapter + '」失败，已停：' + (e && e.message ? e.message : String(e)));
    }
  }
  return submitted[0] || null;
}
