import { Jobs, Projects, Assets, Chapters, Shots, Queue, logger, loadConfig } from '../core/index.js';
import { queueEnabled, cancelJobQueue } from '../core/scheduler.js';
import { createToolRuntime, runTool } from './tools.js';
import { runAgent, runOpuscarAgent, runNovelAgent } from './agent-runtime.js';
import { decideStoryboardLane, jobQueueOf } from './queue-lane.js';
import { assetGateBeforeRun } from './asset-check.js';
import { runAssetPrecheck, precheckBrief, assetPrecheckMode } from './asset-precheck.js';
import { runExclusiveVideo, runExclusiveText, cancelQueuedJob as cancelRenderQueue, holdsRenderSlot as holdsRenderSlotBase, concurrencyLimit, concurrencyEnabled } from '../core/render-gate.js';
import { isOrphanQueued, settleOrphanJob } from './orphan-jobs.js';

// 停止标记必须挂在 globalThis 上：Next.js（尤其 dev 模式）会为不同 route
// 各自打包一份本模块，模块级 Set 会导致 stop 路由设置的标记，运行中的 job
// 永远读不到（「点了停止按钮但分镜还在继续跑」的根因）。globalThis 跨模块实例共享。
const abortFlags = (globalThis.__infiniteCreationAbortFlags = globalThis.__infiniteCreationAbortFlags || new Set());
// 软停止（跑完当前镜再停）：与 abortFlags 分开，避免 generate() 轮询到标记后对 8189 发 /interrupt。
// 同样挂 globalThis，原因同上。
const softStopFlags = (globalThis.__infiniteCreationSoftStopFlags = globalThis.__infiniteCreationSoftStopFlags || new Set());
/** 真正的行内任务：请求内同步执行、不进闸门、也不读停止标记。不能用「此刻没占渲染槽」来推断。 */
export function isInlineJob(job) {
  return !!job && (job.type === 'llm' || job.type === 'export');
}
export function requestSoftStop(jobId) {
  if (jobId) softStopFlags.add(jobId);
}
export function isSoftStopped(jobId) {
  return !!(jobId && softStopFlags.has(jobId));
}
/** 供 generate_chapter_videos 在镜间把软停止升级为硬停止标记：此时已不在 generate() 里，不会打 8189。 */
export function promoteSoftStop(jobId) {
  if (!jobId) return;
  softStopFlags.add(jobId);
  abortFlags.add(jobId);
}
export function isJobUserCancelled(jobId) {
  return isAborted(jobId)() || isSoftStopped(jobId);
}
export function cancelledJobMessage(jobId) {
  return isSoftStopped(jobId) ? '已取消（软停止：当前镜已跑完，后续镜未开）' : '已取消';
}
const INLINE_CANCEL_ERROR = '该任务在请求内同步执行（不占渲染队列），不支持取消，请等它结束';
const SOFT_STOP_NOTE = '已打镜间停止标记：当前镜会跑完并落库，不会向 ComfyUI 发送 /interrupt；下一镜开始前收尾为已取消';
/** 取消策略（供取消路由与单测共用）：只决定「409 / 软停止 / 交给路由做硬停止」，不发 /interrupt。 */
export function applyCancelPolicy(job) {
  if (!job) return { kind: 'missing', status: 404, error: '任务不存在' };
  if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'adopted') {
    return { kind: 'finished', status: 409, error: '任务已结束' };
  }
  if (job.status === 'running' && isInlineJob(job)) {
    return { kind: 'reject-inline', status: 409, error: INLINE_CANCEL_ERROR };
  }
  if (job.status === 'running' && job.type === 'create') {
    requestSoftStop(job.id);
    return { kind: 'soft-stop', status: 200, ok: true, id: job.id, mode: 'after-shot', note: SOFT_STOP_NOTE };
  }
  return { kind: 'hard-stop' };
}
/** cancel 路由硬停止之后是否应调用 interruptTask。queued / 软停止 / 行内 409 均为 false。 */
export function cancelShouldInterrupt(job) {
  if (!job || job.status !== 'running') return false;
  const selfManaged = job.type === 'opuscar' || job.type === 'novel';
  if (selfManaged || job.type === 'prompt-write') return false;
  return holdsRenderSlot(job.id);
}
/**
 * 取消的副作用（供路由与单测共用）。
 * 不默认调用 interruptTask：路由只在本函数返回 shouldInterrupt 之后才走那一行；
 * 单测可传入 deps.interruptTask 作间谍，断言调用次数。本函数自身绝不 fetch /interrupt。
 */
export async function dispatchCancel(job, deps = {}) {
  const policy = applyCancelPolicy(job);
  if (policy.kind === 'reject-inline' || policy.kind === 'finished' || policy.kind === 'missing') {
    return { ...policy, shouldInterrupt: false };
  }
  if (policy.kind === 'soft-stop') {
    return { ...policy, shouldInterrupt: false };
  }
  stopJob(job.id);
  if (job.status === 'queued' && isOrphanQueued(job)) {
    const r = settleOrphanJob(job, { reason: '取消：排队中的任务没有执行者（服务重启前提交），已作废（未重新提交）', source: 'cancel' });
    return { kind: 'orphan-queued', status: 200, ok: true, id: job.id, settled: r.action === 'cancelled' ? 'cancelled' : null, shouldInterrupt: false };
  }
  const selfManaged = job.type === 'opuscar' || job.type === 'novel';
  if (selfManaged) {
    try {
      const subject = job.checkpoint && job.checkpoint.subject;
      const asset = job.type === 'opuscar' && subject ? Assets.get(subject) : null;
      if (asset && asset.status === 'generating') Assets.update(asset.id, { status: asset.video_path ? 'done' : 'cancelled' });
      Jobs.update(job.id, { status: 'cancelled', phase: '已取消', error: '已取消', finishedAt: Date.now() });
    } catch { /* 状态更新失败不影响停止标记 */ }
  }
  const shouldInterrupt = cancelShouldInterrupt(job);
  if (shouldInterrupt && typeof deps.interruptTask === 'function') {
    try {
      const cfg = (deps.loadConfig || loadConfig)();
      await deps.interruptTask(cfg);
    } catch {}
  }
  return { kind: 'hard-stop', status: 200, ok: true, id: job.id, shouldInterrupt };
}

/** 活动（非终态）任务：running / queued / adopted。cancelled / failed / done 视为已结束。
 * interrupted 默认也可删；但「最新的、还没被接续的」出片 interrupted 要保留，见 isPendingResumeInterrupted。 */
const ACTIVE_JOB_STATUSES = new Set(['running', 'queued', 'adopted']);
export const DELETE_ACTIVE_ERROR = '请先取消，等任务结束后再删';
export const DELETE_INTERRUPTED_RESUME_ERROR = '该任务等待断点续跑，请先在该章点「继续」，续跑开始后再删';
export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(status);
}
/**
 * 同章在它之后是否已有更新的 create 任务。
 * 口径与 lib/agent/restart-recovery.js settleInterruptedJob 的 newer 判定一致（约 L116）：
 * 同一项目、type===create、同一 checkpoint.chapter、startedAt 更大即视为已被接续。
 */
export function hasNewerCreateJob(job, jobs) {
  if (!job || job.type !== 'create') return false;
  const title = String((job.checkpoint && job.checkpoint.chapter) || '');
  if (!title) return false;
  const list = Array.isArray(jobs) ? jobs : Jobs.list(job.projectId);
  return list.some((j) => j.id !== job.id && j.type === 'create' && j.checkpoint && j.checkpoint.chapter === title && Number(j.startedAt) > Number(job.startedAt));
}
/**
 * 最新的、还没被接续的 interrupted 出片任务。重启恢复（pickInterruptedJobs / settleInterruptedJob）
 * 要靠这条记录拿到章节并决定是否自动「继续」；出片守护把 interrupted 当「结果不明」从而不自动重提。
 * 只覆盖 type=create 且带 checkpoint.chapter 的 interrupted（与 pickInterruptedJobs 同范围）；
 * 无章节、非 create、以及已被更新 create 接续的旧 interrupted，仍可删。
 */
export function isPendingResumeInterrupted(job, jobs) {
  if (!job || job.status !== 'interrupted') return false;
  if (job.type !== 'create') return false;
  const title = String((job.checkpoint && job.checkpoint.chapter) || '');
  if (!title) return false;
  return !hasNewerCreateJob(job, jobs);
}
/** 删除单条任务记录的策略：活动任务与待续跑 interrupted 一律 409，不做 stopJob / 不打 abortFlags / 不 interrupt。 */
export function applyDeleteJobPolicy(job, jobs) {
  if (!job) return { kind: 'missing', status: 404, error: '任务不存在' };
  if (isActiveJobStatus(job.status)) {
    return { kind: 'reject-active', status: 409, error: DELETE_ACTIVE_ERROR };
  }
  if (isPendingResumeInterrupted(job, jobs)) {
    return { kind: 'reject-pending-resume', status: 409, error: DELETE_INTERRUPTED_RESUME_ERROR };
  }
  return { kind: 'delete-ok', status: 200 };
}
/** 删除整个项目的策略：有活动任务或待续跑 interrupted 就 409，无副作用。活动优先于待续跑。 */
export function applyDeleteProjectPolicy(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const active = list.filter((j) => isActiveJobStatus(j.status));
  if (active.length) {
    return { kind: 'reject-active', status: 409, error: DELETE_ACTIVE_ERROR, activeCount: active.length };
  }
  const pending = list.filter((j) => isPendingResumeInterrupted(j, list));
  if (pending.length) {
    return { kind: 'reject-pending-resume', status: 409, error: DELETE_INTERRUPTED_RESUME_ERROR, pendingCount: pending.length };
  }
  return { kind: 'delete-ok', status: 200 };
}
/**
 * 供路由与单测共用的删除执行入口。活动任务直接拒绝，绝不调用 stopJob / interruptTask。
 * 终态任务在 deps.removeJob 提供时才删记录（路由负责清日志；单测可注入间谍）。
 */
export function executeDeleteJob(job, deps = {}) {
  const policy = applyDeleteJobPolicy(job);
  if (policy.kind !== 'delete-ok') return { ...policy, deleted: false };
  if (typeof deps.removeJob === 'function') deps.removeJob(job);
  return { kind: 'delete-ok', status: 200, deleted: true, id: job && job.id };
}
export function executeDeleteProject(jobs, deps = {}) {
  const policy = applyDeleteProjectPolicy(jobs);
  if (policy.kind !== 'delete-ok') return { ...policy, deleted: false };
  if (typeof deps.removeProject === 'function') deps.removeProject(jobs);
  return { kind: 'delete-ok', status: 200, deleted: true };
}
export function stopJob(jobId) {
  abortFlags.add(jobId);
  // 若任务还在排队等视频槽位，立即从队列摘除并中止——否则要等它「轮到自己」才生效，
  // 期间它的 DB 状态仍是 running，会继续挡住后续任务（见 runExclusiveVideo 注释）。
  cancelQueuedJob(jobId);
}
// 导出给 stages.js：阶段 job 必须共用这一个注册表，否则 /api/projects/[id]/stop
// 只认 job-runner 建的 job，阶段 job 停不下来。
export function isAborted(jobId) { return () => abortFlags.has(jobId); }

// 起任务即置项目运行态：前端据此显示「■ 停止」按钮（project.status==='running'）。
// 此前只有 /run、/stages 置运行态，单镜重生成/素材类任务没置 —— 提交后前端看不到停止按钮，
// 长视频/出图任务无法中止。统一到 runner 内，任何起任务的入口都生效。
export function markProjectRunning(projectId) { Projects.update(projectId, { status: 'running' }); }
// 任务收尾复位项目运行态：停止按钮随之消失。被用户停止的任务复位为 idle（而非 failed），
// 避免「主动停止」在项目卡片上显示成失败。
export function settleProject(projectId, jobId, ok) {
  // 队列里还有别的任务在跑/排队时，保持项目运行态（否则停止按钮会提前消失）
  const more = Jobs.list(projectId).some((j) => j.id !== jobId && (j.status === 'running' || j.status === 'queued'));
  if (more) return;
  const aborted = isJobUserCancelled(jobId);
  Projects.update(projectId, { status: aborted ? 'idle' : (ok ? 'done' : 'failed') });
}

// 排队态回调：任务进队时落库/广播为 queued（前端显示「排队中」），拿到槽位改回 running。
// 判据只有「前面是否真有任务在跑」——不探测 LLM/ComfyUI 是否在运行（服务由用户手动启停，
// 应用不能拿服务状态当开关；没有任务时新任务必须立刻开跑，不排队）。
function queueState(job, emit) {
  return (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase, detail: '' });
    emit({ phase, status: st });
  };
}

// 阶段任务收尾：同 settleProject，但复位为 idle（阶段只是批处理的一部分，不该显示 done/failed）。
export function releaseProject(projectId, jobId) {
  const more = Jobs.list(projectId).some((j) => j.id !== jobId && (j.status === 'running' || j.status === 'queued'));
  if (more) return;
  Projects.update(projectId, { status: 'idle' });
}

// 行内任务：把「在请求内同步跑完、但属于 LLM/渲染」的操作也记成一条 Job，
// 使其出现在任务列表里。不占视频队列、不改变项目运行态（这类操作由发起请求同步等待）。
export async function runInlineJob({ projectId, type, checkpoint = {}, onProgress }, fn) {
  const job = Jobs.create({ projectId, type, checkpoint });
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type, ...patch }); };
  emit({ phase: '准备', status: 'running' });
  try {
    // emit 传给任务本体：字幕识别这类长流程需要自己推进度（jobId/projectId/type 已由 emit 补齐）
    const r = await fn(emit);
    Jobs.update(job.id, { status: 'done', phase: '完成', detail: String(r ?? '').slice(0, 500), error: '', finishedAt: Date.now() });
    emit({ phase: '完成', detail: String(r ?? '').slice(0, 200), status: 'done' });
    return r;
  } catch (e) {
    Jobs.update(job.id, { status: 'failed', phase: '失败', error: e.message, finishedAt: Date.now() });
    emit({ phase: '失败', detail: e.message, status: 'failed' });
    throw e;
  }
}

// 失败/取消统一收尾：区分「用户取消」与「真失败」——取消状态记 cancelled、不写 error 日志。
function finishJobError(job, projectId, emit, e, logMsg, logExtra) {
  const cancelled = isJobUserCancelled(job.id);
  settleProject(projectId, job.id, false);
  const detail = cancelled ? cancelledJobMessage(job.id) : (e && e.message ? e.message : String(e));
  Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: detail, finishedAt: Date.now() });
  emit({ phase: cancelled ? '已取消' : '失败', detail, status: cancelled ? 'cancelled' : 'failed' });
  if (!cancelled) logger.error(logMsg, logExtra);
}

// 任务正常收尾。必须和 finishJobError 同口径检查停止标记：批量工具被用户停止时是**正常返回**
// （以 {aborted:true} 收尾、不抛错 —— generate_chapter_videos / apply_chapter_music / 阶段任务都是这样），
// 若无条件记 done，前端收到 status:'done' 会弹「✅ 任务完成」，而实际后面几镜/几章根本没跑。
function finishJobOk(job, projectId, emit, r) {
  const cancelled = isJobUserCancelled(job.id);
  const detail = cancelled ? cancelledJobMessage(job.id) : String(r == null ? '' : r);
  settleProject(projectId, job.id, true);
  Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'done', phase: cancelled ? '已取消' : '完成', detail: detail.slice(0, 2000), error: cancelled ? cancelledJobMessage(job.id) : '', finishedAt: Date.now() });
  emit({ phase: cancelled ? '已取消' : '完成', detail, status: cancelled ? 'cancelled' : 'done' });
}

// 渲染槽位闸门已抽到 lib/core/render-gate.js（供 workflow-runner 复用，避免 core↔agent 循环依赖）。
// 槽位现在是渲染项级的：每次 runWorkflow 提交占一个，所以一个任务内多个镜头也能并行。
export { runExclusiveVideo, concurrencyLimit, concurrencyEnabled };

// 停止/取消时同时摘除「渲染项闸门」和 RunningHub 的 DB 公平队列。
export function cancelQueuedJob(jobId) {
  const fromDb = cancelJobQueue(jobId);
  const fromRender = cancelRenderQueue(jobId);
  return fromDb || fromRender;
}

// 该任务此刻是否有渲染正在提交/等待（本地渲染闸门或 RunningHub DB 队列）。
export function holdsRenderSlot(jobId) {
  if (!jobId) return false;
  return holdsRenderSlotBase(jobId) || Queue.hasRunning(jobId);
}

// 任务级闸门的选择：
//   本地 ComfyUI  → 整批串行（一次只有一个 job 提交渲染，避免显存互相踩）
//   RunningHub + 队列开启 → 不再整批占槽：真正的渲染由 workflow-runner 按「单次生成」进公平队列
// 否则多用户时「一个人的整条流水线」会占住唯一槽位数小时，后面的人全部干等。
//   opts.lane === 'text'（双队列：只拆分镜的纯文本 job，由 storyboardLane 判定）→ 文本闸门 runExclusiveText，
//     不占任务闸门；任务体里任何碰 GPU 的底层调用由 render-gate.withGpuAccess 按次重新过任务闸门。
export function runJobTask(task, isAbortedFn, opts = {}) {
  if (queueEnabled(loadConfig())) return Promise.resolve().then(task);
  const { lane, ...rest } = opts;
  if (lane === 'text') return runExclusiveText(task, isAbortedFn, rest);
  return runExclusiveVideo(task, isAbortedFn, rest);
}

// 只拆分镜的 job 能不能进文本闸门（和出片并行）：判据见 lib/agent/queue-lane.js（纯函数，有单测）。
export function storyboardLane(cfg = loadConfig()) {
  return decideStoryboardLane(cfg, queueEnabled(cfg));
}
export { jobQueueOf };

// 剧本就绪检查：项目关闭「自动生成剧本」且目标章节剧本为空时，直接拦在起任务前，
// 避免任务跑完却一镜未拆（Agent 按提示词跳过无剧本章节）。
export function assertScriptsReady(projectId, chapterTitles) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  if (project.auto_script !== false) return;
  const all = Chapters.list(projectId);
  const wanted = Array.isArray(chapterTitles) && chapterTitles.length
    ? all.filter((c) => chapterTitles.includes(c.title) || chapterTitles.includes(c.id))
    : all;
  const missing = wanted.filter((c) => !String(c.script || '').trim());
  if (!missing.length) return;
  throw Object.assign(
    new Error('以下章节还没有剧本，且项目未开启自动生成剧本：' + missing.map((c) => '「' + c.title + '」').join('、') + '。请先在章节「剧本」里编写/粘贴，或在项目设置中开启自动生成。'),
    { code: 'SCRIPT_REQUIRED' },
  );
}

// 后台任务：创建成片（全自动流水线）
// renderDisabled=true 时本批只跑 LLM 文本（如「重新生成本章分镜」= 清空本章分镜后重新拆分、
// 只写分镜/提示词），绝不提交 ComfyUI。
//
// afterOk(jobRow)：任务**正常收尾之后**（finishJobOk 已把终态写库，status 为 done 或 cancelled）调用一次，
// 给单章入口挂「自动生成下一章 / 下一章分镜」（lib/agent/auto-chain.js）。failed 不会走到这里。
// 它在 try/catch 里执行：回调出错只记日志，绝不把已经 done 的任务改判成 failed。
// 闸门：出片 / 整章生成走 job 闸门（视频槽位）；renderDisabled 的只拆分镜 job 按 storyboardLane 进文本闸门或 job 闸门。
// afterOk 在本任务收尾（终态已写库）之后才发生。
export function startCreateJob({ projectId, chapter, onProgress, beforeRun, renderDisabled, afterOk }) {
  const project = Projects.get(projectId);
  if (!project) throw new Error('项目不存在');
  assertScriptsReady(projectId, chapter ? [chapter] : undefined);
  // 本章资产齐全检查（2026-11-17 最小版）：只对 asset_mode=gap-list 的项目生效。B 闸（缺省）不挡任务、异步写缺件单；
  // A 闸有缺件时抛 ASSETS_MISSING，不建任务。检查自身出错一律不挡。整章生成 / 生成分镜 / 自动续章 / 重启恢复都经过这里。
  const assetGate = chapter ? assetGateBeforeRun(projectId, chapter, { trigger: renderDisabled ? 'storyboard' : 'run' }) : null;
  // 曾经的「两侧服务都在本机时禁用整条流水线」已删除：那是拿服务状态当开关、替你决定能不能跑。
  // 用户点了整条流水线就该跑；服务由用户手动启停，任务之间的协调只由视频槽位队列完成。
  // storyboardOnly：标记「只拆分镜、不出片」的任务（renderDisabled），任务队列据此分组显示、自动续章据此区分两条链。
  const checkpoint = chapter ? { subject: chapter, chapter } : {};
  if (renderDisabled) checkpoint.storyboardOnly = true;
  if (assetGate && assetGate.report) checkpoint.assetGap = { state: assetGate.report.state, phase: assetGate.report.phase, missing: assetGate.report.summary.missing };
  // 开渲前资产检查（起出片任务时，2026-11-17）：只扫、只出清单（mode=list），不换图——此刻别章可能正在渲染且共用资产，
  // 换图放到本章真正开渲前（generate_chapter_videos）。不挡任务，出错只记日志。
  if (chapter && !renderDisabled) {
    let pc = null;
    try { pc = assetPrecheckMode(loadConfig()) === 'off' ? null : runAssetPrecheck(projectId, chapter, { trigger: 'submit', mode: 'list' }); } catch { pc = null; }
    if (pc && (pc.error || (pc.summary && pc.summary.generated))) checkpoint.assetPrecheck = precheckBrief(pc);
  }
  // 双队列：只拆分镜的 job 按 storyboardLane 判定进文本闸门（queue='text'）还是仍走任务闸门（queue='gpu'）。
  // 判定结果写进 checkpoint，任务队列面板和自动续章都按它分栏 / 判忙，不再各自猜。
  const lane = renderDisabled ? storyboardLane(loadConfig()) : { lane: 'gpu', reason: '' };
  checkpoint.queue = lane.lane;
  if (renderDisabled) checkpoint.queueReason = lane.reason;
  const job = Jobs.create({ projectId, type: 'create', checkpoint });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, ...patch };
    if (onProgress) onProgress(p);
  };

  const task = async () => {
    // 「重置类」副作用（如重新生成分镜前清空本章分镜）放到真正拿到槽位、开始执行前才做：
    // 排队中被取消则一行数据都不动，已 done 的结果得以保留。
    if (beforeRun) await beforeRun();
    const summary = await runAgent({
      projectId, chapter, jobId: job.id,
      onProgress: (patch) => {
        Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
        emit(patch);
      },
      isAborted: isAborted(job.id),
      renderDisabled: !!renderDisabled,
    });
    // 只做分镜：Agent 常因拿不到 shot_id 而漏写 video_prompt。收尾时用现有 write_shot_video_prompt
    // 补上缺口，并把待做资产图/音色排进视频队列（FIFO，不另起提交器，不打断正在出的视频）。
    if (renderDisabled && chapter && !isAborted(job.id)()) {
      try {
        const { afterStoryboardTextJob } = await import('./prompt-write.js');
        const extra = await afterStoryboardTextJob({
          projectId, chapter, jobId: job.id, onProgress: emit, isAborted: isAborted(job.id),
        });
        if (extra) return (summary ? String(summary) + '\n' : '') + extra;
      } catch (e) {
        logger.warn('job: 分镜收尾补提示词/排资产失败（不影响已写入的分镜）', { projectId, jobId: job.id, error: e && e.message });
      }
    }
    return summary;
  };

  // openclaude（@gitlawb/openclaude）作为 Agent 运行时：SDK 进程内驱动，工具直接走本工程 runTool。
  // 整条流水线本身是串行的，但用户可能同时手动重生成单个分镜，故整job 也走视频闸门。
  // 纯 LLM 批次同样要走闸门：它虽然不提交 ComfyUI，但会把 27B 权重常驻显存，与正在跑的渲染 job
  // 并发时两者同时占用显存。闸门只按「是否有任务在跑」排队，不探测服务状态。
  // 双队列（2026-11-16 总导批准）：LLM 不在本机显卡上时（storyboardLane 判定），只拆分镜的 job 改走文本闸门，
  // 与出片 job 并行；它内部任何碰 GPU 的底层调用仍会按次重新过任务闸门（render-gate.withGpuAccess）。
  runJobTask(task, isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit), lane: lane.lane })
    .then((summary) => {
      finishJobOk(job, projectId, emit, summary);
      if (typeof afterOk === 'function') {
        try {
          afterOk(Jobs.get(job.id) || job);
        } catch (e) {
          logger.error('job: 收尾回调失败（不影响本任务结果）', { projectId, jobId: job.id, error: e && e.message });
        }
      }
    })
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 创建失败', { projectId, error: e.message });
    });

  return job;
}

// 后台任务：为项目每个章节各起一个「生成」任务（一个章节一个任务）。
// 视频闸门保证同一时刻只有一个在跑，其余排队；每章分镜编号独立从 1 开始。
export function startCreateAllJobs({ projectId, onProgress, chapters: only }) {
  let chapters = Chapters.list(projectId);
  if (Array.isArray(only)) {
    const set = new Set(only.map(String));
    chapters = chapters.filter((c) => set.has(c.title));
  }
  if (!chapters.length) throw new Error('没有需要启动的章节');
  // 批量启动前一次性列出所有缺剧本的章节，避免只报第一条
  assertScriptsReady(projectId, chapters.map((c) => c.title));
  const jobs = [];
  try {
    for (const c of chapters) jobs.push(startCreateJob({ projectId, chapter: c.title, onProgress }));
    return jobs;
  } catch (e) {
    // 多章节批量启动：后面某章启动失败时，把已经建好的任务停掉，
    // 避免“只启动了一半、用户还以为全在跑”。
    for (const j of jobs) {
      try { stopJob(j.id); } catch {}
      Jobs.update(j.id, { status: 'cancelled', phase: '已取消', error: '批量启动中止：' + e.message, finishedAt: Date.now() });
    }
    throw e;
  }
}

// 后台任务：重生成某章全部视频（用 generate_chapter_videos force=true 覆盖，不预先清空分镜/视频）。
// 非破坏性：排队中被取消不动数据；执行中取消，已完成的镜头仍是 done（generateShotVideo 会恢复）。
export function startChapterVideoJob({ projectId, chapter, onProgress }) {
  const job = Jobs.create({ projectId, type: 'chapter-video', checkpoint: { subject: chapter, chapter } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, chapter, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id, chapter,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'generate_chapter_videos', { chapter, force: true }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 章节视频重生成失败', { projectId, chapter, error: e.message });
    });
  return job;
}

// 后台任务：单分镜重生成（render=false 只做 LLM 改写提示词，不提交 ComfyUI）。
// append=true 时把新视频追加为该分镜的新候选（保留旧候选），默认 false 替换整批候选。
// skill=true 时不渲染、也不改写既有提示词，而是按 h3-prompt-writing 技能从零写一条（手工插入的分镜用）。
export function startRegenerateJob({ projectId, shotId, feedback, render, append, skill, onProgress }) {
  // 曾经的「带反馈 + 要渲染、两侧服务都在本机时拒绝」已删除：先 LLM 改写再渲染是该按钮的语义，
  // 用户点了就该跑；LLM/ComfyUI 的启停由用户自己掌握，应用不该拿服务状态拦人。
  const job = Jobs.create({ projectId, type: 'regenerate', checkpoint: { subject: shotId, render: render !== false && !skill, feedback: !!feedback, skill: !!skill } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, shotId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  const task = () => (skill
    ? runTool(ctx, 'write_shot_video_prompt', { shot_id: shotId })
    : runTool(ctx, 'regenerate_shot', { shot_id: shotId, feedback: feedback || undefined, render: render !== false, append: !!append }));
  // 纯 LLM 改写（render=false）也走闸门：它要拉起 LLM（27B 常驻显存），与并发渲染 job 抢显存。
  runJobTask(task, isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 重生成失败', { projectId, shotId, error: e.message });
    });
  return job;
}

// 后台任务：单个资产生成图片（确定性，复用 generate_asset_image 工具）
export function startAssetImageJob({ projectId, assetId, mode = 't2i', prompt, referenceImagePath, onProgress }) {
  const job = Jobs.create({ projectId, type: 'asset-image', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    // 渲染 job：本批零 LLM（换装/年龄的视觉精修等 LLM 步骤在此跳过），避免与 ComfyUI 抢显存
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  const toolName = mode === 'i2i' ? 'edit_asset_image' : 'generate_asset_image';
  const toolArgs = { asset_id: assetId, prompt: prompt || undefined };
  if (mode === 'i2i' && referenceImagePath) toolArgs.reference_image_path = referenceImagePath;
  runJobTask(() => runTool(ctx, toolName, toolArgs), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.image_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 资产图生成失败', { projectId, assetId, mode, error: e.message });
    });
  return job;
}

// 后台任务：单个资产设计音色（确定性，复用 design_voice 工具）
export function startAssetVoiceJob({ projectId, assetId, text, voiceDescription, onProgress }) {
  const job = Jobs.create({ projectId, type: 'voice-design', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'design_voice', { asset_id: assetId, text, voice_description: voiceDescription }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.audio_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 音色设计失败', { projectId, assetId, error: e.message });
    });
  return job;
}

// 后台任务：单个资产音色克隆（确定性，复用 clone_voice 工具）
export function startAssetVoiceCloneJob({ projectId, assetId, text, refAudio, refAudioProjectId, onProgress }) {
  const job = Jobs.create({ projectId, type: 'voice-clone', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'clone_voice', { asset_id: assetId, text, ref_audio: refAudio, ref_audio_project_id: refAudioProjectId || '' }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.audio_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 音色克隆失败', { projectId, assetId, error: e.message });
    });
  return job;
}

// 后台任务：人物换装（复用 change_outfit 工具，产出服装资产）
export function startCostumeJob({ projectId, characterId, outfit, prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'costume', checkpoint: { subject: characterId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, characterId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'change_outfit', { character_id: characterId, outfit, prompt: prompt || undefined }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 换装失败', { projectId, characterId, error: e.message });
    });
  return job;
}

// 后台任务：人物年龄变体（复用 change_age 工具，产出 age 资产）
export function startAgeJob({ projectId, characterId, age, prompt, onProgress }) {
  const job = Jobs.create({ projectId, type: 'age', checkpoint: { subject: characterId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, characterId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'change_age', { character_id: characterId, age, prompt: prompt || undefined }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 年龄变体失败', { projectId, characterId, error: e.message });
    });
  return job;
}

// 后台任务：为一条已创建的背景音乐资产生成音频（资产已在路由里建好、状态 generating）
export function startMusicJob({ projectId, assetId, onProgress }) {
  const job = Jobs.create({ projectId, type: 'music', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'generate_music_asset', { asset_id: assetId }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      // 工具还没跑起来就结束了（排队期间被停止 / 排队超时 / 工具在写状态之前抛错）时，资产会永远停在
      // 「生成中」：路由发起任务前把状态置成了 generating，只有工具内部才会改成 done/failed。
      // 兜底复位：已有音频（重新生成失败）时回到 done，否则才是 failed —— 不能让一次失败把
      // 上一版可用音频也变成「不可应用」（列表里「应用到」只对 done 显示）。
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.audio_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 背景音乐生成失败', { projectId, error: e.message });
    });
  return job;
}

// 后台任务：独立视频资产生成（简单模式页「视频生成 / 数字人」，非分镜流水线）
export function startVideoJob({ projectId, assetId, mode, prompt, seconds, resolution, aspectRatio, references, onProgress }) {
  const job = Jobs.create({ projectId, type: 'video', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'generate_video_asset', { asset_id: assetId, mode, prompt, seconds, resolution, aspect_ratio: aspectRatio, references }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      // 与 startMusicJob 同口径：工具没跑起来就结束时，资产会停在「生成中」，这里兜底复位。
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.video_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 视频生成失败', { projectId, error: e.message });
    });
  return job;
}

// 后台任务：数字人语音驱动（先语音克隆生成语音，再把语音作为驱动音频跑 r2v 数字人）
export function startDigitalHumanTtsJob({ projectId, assetId, text, prompt, seconds, resolution, aspectRatio, avatar, refAudio, refAudioProjectId, onProgress }) {
  const job = Jobs.create({ projectId, type: 'digital-human-tts', checkpoint: { subject: assetId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runExclusiveVideo(() => runTool(ctx, 'generate_digital_human', { asset_id: assetId, text, prompt, seconds, resolution, aspect_ratio: aspectRatio, avatar, ref_audio: refAudio, ref_audio_project_id: refAudioProjectId || '' }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.video_path ? 'done' : 'failed' });
      finishJobError(job, projectId, emit, e, 'job: 数字人生成失败', { projectId, error: e.message });
    });
  return job;
}

// 后台任务：把选定背景音乐应用到多个章节并重新合成成片
export function startMusicApplyJob({ projectId, chapters, musicId, onProgress }) {
  const job = Jobs.create({ projectId, type: 'music-apply', checkpoint: { subject: (chapters || []).join('、') || projectId } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, chapters, ...patch };
    if (onProgress) onProgress(p);
  };
  const ctx = createToolRuntime({
    projectId, jobId: job.id,
    llmDisabled: true,
    isAborted: isAborted(job.id),
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });
  runJobTask(() => runTool(ctx, 'apply_chapter_music', { music_id: musicId, chapters }), isAborted(job.id), { jobId: job.id, onQueue: queueState(job, emit) })
    .then((r) => finishJobOk(job, projectId, emit, r))
    .catch((e) => {
      finishJobError(job, projectId, emit, e, 'job: 应用背景音乐失败', { projectId, chapters, error: e.message });
    });
  return job;
}

// 后台任务：无限・秩影（lemo-opuscar 代码渲染，脱离 ComfyUI，走本地 node/ffmpeg/python）
export function startOpuscarJob({ projectId, assetId, styleSlug, styleInfo, prompt, materials, history, continueMessage, turn = 0, onProgress }) {
  const job = Jobs.create({ projectId, type: 'opuscar', checkpoint: { subject: assetId, style_slug: styleSlug, turn } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, assetId, ...patch };
    if (onProgress) onProgress(p);
  };
  const task = () => runOpuscarAgent({
    projectId, jobId: job.id, assetId, styleSlug, styleInfo, prompt, materials, history, continueMessage,
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
    isAborted: isAborted(job.id),
  });
  // 每一轮对话的产出写回 params.chat[turn]（前端按轮次展示该轮的成片与状态）。
  // Assets.video_path 只保留最新一版，若不按轮次记录，历史轮次就看不到自己那一版的成片。
  const recordTurn = (patch) => {
    const a = Assets.get(assetId);
    if (!a) return;
    const params = a.params || {};
    const chat = Array.isArray(params.chat) ? params.chat.slice() : [];
    if (!chat[turn]) return;
    chat[turn] = { ...chat[turn], ...patch };
    Assets.update(assetId, { params: { ...params, chat } });
  };
  // 本地 node/ffmpeg 渲染，不提交 ComfyUI：既不需要渲染槽位（与显存无关），
  // 也不该占用 ComfyUI 的排队闸门，直接起跑；并发由 Agent 槽位（acquireAgentSlot）控制。
  Promise.resolve()
    .then(task)
    .then((r) => {
      const saved = Assets.get(assetId);
      recordTurn({ status: 'done', video_path: (saved && saved.video_path) || '', job_id: job.id, finished_at: Date.now() });
      finishJobOk(job, projectId, emit, r);
    })
    .catch((e) => {
      const cancelled = isAborted(job.id)();
      recordTurn({ status: cancelled ? 'cancelled' : 'failed', error: cancelled ? '已取消' : (e && e.message ? e.message : String(e)), job_id: job.id, finished_at: Date.now() });
      const a = Assets.get(assetId);
      if (a && a.status === 'generating') Assets.update(assetId, { status: a.video_path ? 'done' : (cancelled ? 'cancelled' : 'failed') });
      finishJobError(job, projectId, emit, e, 'job: 无限・秩影生成失败', { projectId, assetId, error: e.message });
    });
  return job;
}

// 后台任务：无限・卷轴（小说结构大纲生成，不碰 ComfyUI）
// autoContinueLeft：整本生成时，Agent 单次会话可能没写完所有章节正文，
// 结束后若仍有章节缺正文，自动接着起下一个 job，直到全部写完（上限防死循环）。
export function startNovelJob({ projectId, step, chapter, message, onProgress, autoContinueLeft }) {
  const job = Jobs.create({ projectId, type: 'novel', checkpoint: { subject: projectId, step: String(step || 'all').toLowerCase(), chapter: chapter || undefined } });
  markProjectRunning(projectId);
  const emit = (patch) => {
    const p = { jobId: job.id, projectId, type: job.type, ...patch };
    if (onProgress) onProgress(p);
  };
  const task = () => runNovelAgent({
    projectId, jobId: job.id, step, chapter, message,
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
    isAborted: isAborted(job.id),
  });
  // 纯 LLM 任务，不占 ComfyUI 渲染槽位
  Promise.resolve()
    .then(task)
    .then((r) => {
      finishJobOk(job, projectId, emit, r);
      // 整本生成：仍有章节缺正文就自动续跑（被用户停止时不再续跑）
      const left = (typeof autoContinueLeft === 'number' ? autoContinueLeft : 30) - 1;
      const isWholeBook = String(step || '').toLowerCase() === 'start' || String(step || '').toLowerCase() === 'extend';
      if (!isAborted(job.id)() && left > 0 && isWholeBook) {
        const pending = Chapters.list(projectId).filter((c) => !String(c.novel || '').trim());
        if (pending.length) {
          emit({ phase: '自动继续', detail: '还有 ' + pending.length + ' 章未写正文，自动继续生成' });
          startNovelJob({ projectId, step: 'start', onProgress, autoContinueLeft: left });
        }
      }
    })
    .catch((e) => {
      const cancelled = isAborted(job.id)();
      finishJobError(job, projectId, emit, e, 'job: 无限・卷轴生成失败', { projectId, error: e.message, cancelled });
    });
  return job;
}

export function activeJobOf(projectId) {
  // queued 也算「在跑」：排队中的任务已经占用该项目（等视频槽位，最长可等到 videoQueueTimeoutMinutes），
  // 它会继续往分镜/章节行上回写。只看 running 会让「已有运行中的任务」这道闸门在排队期间失效：
  // 期间可以再起一条流水线（同一章被两遍生成），也能删掉排队任务稍后要写的章节/分镜
  // （回写静默落空，成片与界面对不上）。job-runner 内部、jobs 路由、cancel 路由一律把
  // queued 视为活动状态，这里与它们对齐。
  // ic25：adopted（后端重启时外部 Agent 还活着、重启恢复在等它退出）同样占着项目 / 章节，防止同章被再提交一遍。
  return Jobs.list(projectId).find((j) => j.status === 'running' || j.status === 'queued' || j.status === 'adopted');
}

// 任务是否占用某一章。用于「不同章节可以并行、同一章节必须去重」。
// - create / stage / chapter-video：看 checkpoint.chapter；没有 chapter = 整项目/全部章节。
// - regenerate：checkpoint.subject 是分镜 id，按分镜所属章节判断。
// - 资产图 / 音色 / 换装 / 年龄 / 音乐：资源级任务，不按章节阻塞（共享素材由队列去重）。
export function jobTouchesChapter(job, chapter) {
  if (!job) return false;
  const want = String(chapter || '');
  if (!want) return true;
  const cp = job.checkpoint || {};
  let jc = String(cp.chapter || '');
  if (!jc && job.type === 'regenerate' && cp.subject) {
    jc = String(Shots.get(cp.subject)?.chapter || '');
  }
  if (jc) return jc === want;
  return job.type === 'create' || job.type === 'stage';
}

export function activeJobOfChapter(projectId, chapter) {
  const want = String(chapter || '');
  if (!want) return activeJobOf(projectId);
  return Jobs.list(projectId).find(
    (j) => (j.status === 'running' || j.status === 'queued' || j.status === 'adopted') && jobTouchesChapter(j, want),
  );
}
