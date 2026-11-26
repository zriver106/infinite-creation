// 「提示词撰写」：只给某一章补写缺失的分镜视频提示词（shot.video_prompt）。
// 2026-11-17 第二轮：Agent 运行时是外部 CLI（如 claude）时，改走外部 Agent（Claude CLI + skill(h3-prompt-writing)），
//   MCP 只给受限工具集（读工具 + save_shot_video_prompt，见 prompt-write-mcp.js），不再调内置 llm.js（DeepSeek 未配置）。
//   只有运行时为内置 openclaude 时才保留下面「逐镜 write_shot_video_prompt」的旧路径。
// - 不清分镜、不改剧本、不出图/不出视频：逐镜复用现有工具 write_shot_video_prompt
//   （= 单镜「按技能写提示词」同一入口，参考素材只解析不上传，已有资产直接复用）。
// - 必须带章节；同一章已有 running/queued 任务（任一队列）时抛 CHAPTER_BUSY（路由翻 409），与 submitStoryboardJob 同口径。
// - 进文本闸门（分镜队列）：本任务的 LLM 走 cfg.llm（内置 llmChat），所以按「内置运行时」口径判定 lane；
//   LLM 在本机 / 总开关关 / RunningHub 队列模式时如实退回视频队列（写在 checkpoint.queueReason）。
// - 已出视频但没有提示词的分镜不写（写了会让下一次「生成」判为提示词已改而重渲染），只在结果里报数。
import { Jobs, Shots, Projects, logger, loadConfig, readPostStoryboardJobs } from '../core/index.js';
import { queueEnabled } from '../core/scheduler.js';
import { createToolRuntime, runTool } from './tools.js';
import { decideStoryboardLane } from './queue-lane.js';
import { activeJobOfChapter, isAborted, markProjectRunning, settleProject, runJobTask } from './job-runner.js';
import { findAgentDef, runExternalAgent } from './external/index.js';
import { shotNeedsPrompt, shotNeedsPromptForJob, rewriteIdsOfJob, rewrittenIdsOfJob, lockedFieldsMd5 } from './prompt-write-mcp.js';
import { projectDir } from '../core/config.js';

export const PROMPT_WRITE_JOB_TYPE = 'prompt-write';

const hasPrompt = (s) => !!String((s && s.video_prompt) || '').trim();
const hasVideo = (s) => !!(s && s.status === 'done' && s.video_path);

/** 该分镜是否需要「提示词撰写」补写：没有提示词，且还没出视频（单一口径在 prompt-write-mcp.js）。 */
export { shotNeedsPrompt };

/** 本章提示词缺口：missing = 需要补写的镜数；missingWithVideo = 没提示词但已出视频（不补写）。 */
export function chapterPromptGap(shotsOfChapter) {
  const list = Array.isArray(shotsOfChapter) ? shotsOfChapter : [];
  let missing = 0;
  let missingWithVideo = 0;
  for (const s of list) {
    if (hasPrompt(s)) continue;
    if (hasVideo(s)) missingWithVideo++;
    else missing++;
  }
  return { total: list.length, missing, missingWithVideo };
}

/** 外部 Agent 运行时（claude / codex / … / custom）→ 提示词撰写走外部 Agent；否则返回 ''（内置 openclaude）。 */
export function promptWriteAgentId(cfg = loadConfig()) {
  const rt = String((cfg && cfg.agent && cfg.agent.runtime) || 'openclaude');
  if (rt === 'openclaude') return '';
  if (rt === 'custom' || findAgentDef(rt)) return rt;
  return '';
}

/** 本任务进哪条队列：外部 Agent 时与「只拆分镜」同口径（云端 CLI → 文本队列）；内置运行时按 cfg.llm 判定。 */
export function promptWriteLane(cfg = loadConfig()) {
  if (promptWriteAgentId(cfg)) return decideStoryboardLane(cfg, queueEnabled(cfg));
  return decideStoryboardLane({ ...cfg, agent: { ...(cfg && cfg.agent), runtime: 'openclaude' } }, queueEnabled(cfg));
}

// 续轮12快：重写模式（job.checkpoint.rewriteShotIds）按名单 + 本任务存档算剩余；否则原口径。
const chapterMissing = (projectId, title, jobId) => {
  const rw = rewriteIdsOfJob(jobId);
  const done = rw ? rewrittenIdsOfJob(projectDir(projectId), jobId) : null;
  return Shots.list(projectId).filter((s) => s.chapter === title && shotNeedsPromptForJob(s, rw, done)).length;
};

/**
 * 外部 Agent 补写本章提示词：最多跑 2 轮（第 1 轮有进展但没写完时再补一轮）。
 * 只经 MCP 受限工具集写 video_prompt；不清分镜、不改剧本、不出图出视频。
 */
export async function fillChapterVideoPromptsViaAgent({ projectId, title, agentId, jobId, isAborted: abortedFn, onProgress, runAgentFn = runExternalAgent }) {
  const start = chapterMissing(projectId, title, jobId);
  let remaining = start;
  let lastErr = null;
  let rounds = 0;
  let lastTick = 0;
  const progressPatch = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 1500) return;
    lastTick = now;
    remaining = chapterMissing(projectId, title, jobId);
    if (jobId) Jobs.update(jobId, { progress: { done: Math.max(0, start - remaining), total: start } });
  };
  for (let round = 1; round <= 2 && remaining > 0; round++) {
    if (abortedFn && abortedFn()) break;
    rounds = round;
    const before = remaining;
    try {
      await runAgentFn({
        projectId, chapter: title, jobId, agentId,
        promptWrite: true, promptWriteMissing: before, renderDisabled: true,
        isAborted: abortedFn,
        onProgress: (patch) => {
          if (onProgress) onProgress(patch);
          progressPatch(false);
        },
      });
      lastErr = null;
    } catch (e) {
      lastErr = e;
      logger.warn('prompt-write: 外部 Agent 第 ' + round + ' 轮出错', { projectId, jobId, error: e && e.message });
    }
    progressPatch(true);
    if (abortedFn && abortedFn()) break;
    if (remaining >= before) break; // 本轮没有任何进展：不再重试
  }
  const written = Math.max(0, start - remaining);
  const summary = '「' + title + '」提示词撰写（外部 Agent ' + agentId + '，' + rounds + ' 轮）：写入 ' + written + '/' + start + ' 镜'
    + (remaining ? '，仍缺 ' + remaining + ' 镜' : '')
    + (lastErr ? '；Agent 报错：' + (lastErr.message || String(lastErr)) : '');
  return { start, written, remaining, rounds, error: lastErr, summary };
}

/**
 * 给某一章缺 video_prompt 且未出视频的分镜逐镜补写（复用 write_shot_video_prompt）。
 * 单镜失败不中断整章。不清分镜、不改剧本。
 */
export async function fillChapterVideoPrompts({ ctx, projectId, title, isAborted, jobId, onProgress }) {
  const todo = Shots.list(projectId)
    .filter((s) => s.chapter === title && shotNeedsPrompt(s))
    .sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  const n = todo.length;
  let ok = 0;
  let skipped = 0;
  const failed = [];
  for (let i = 0; i < n; i++) {
    if (isAborted && isAborted()) break;
    const s = Shots.get(todo[i].id);
    if (!shotNeedsPrompt(s)) { skipped++; continue; }
    const phase = '提示词撰写';
    const detail = '第 ' + (i + 1) + '/' + n + ' 镜（分镜 ' + s.idx + '）';
    if (jobId) Jobs.update(jobId, { phase, detail, progress: { done: i, total: n } });
    if (onProgress) onProgress({ phase, detail, status: 'running' });
    try {
      await runTool(ctx, 'write_shot_video_prompt', { shot_id: s.id });
      ok++;
    } catch (e) {
      failed.push('分镜 ' + s.idx + '：' + (e && e.message ? e.message : String(e)));
      logger.warn('prompt-write: 单镜失败（继续下一镜）', { projectId, jobId, shotId: s.id, error: e && e.message });
    }
  }
  if (jobId) Jobs.update(jobId, { progress: { done: ok + skipped + failed.length, total: n } });
  const summary = n
    ? ('「' + title + '」提示词补写：写入 ' + ok + ' 镜'
      + (skipped ? '，跳过 ' + skipped + ' 镜（已有提示词）' : '')
      + (failed.length ? '，失败 ' + failed.length + ' 镜：' + failed.join('；') : ''))
    : '';
  return { ok, skipped, failed, total: n, summary };
}

/**
 * 若还有待出的资产图/音色，用现有 startStageJob 排入视频队列（FIFO，不另起 GPU 提交器，
 * 不会挤掉正在跑的出片任务）。已有同类阶段任务在跑或排队则不重复提交。
 */
// 缺件单模式（asset_mode=gap-list，V2）：不再起「全项目 image+tts」任务。
// 先跑本章资产检查（自动登记同名唯一音色 + 写缺件单），图片缺件只进缺件单（IC 不出图）；
// 只有「资产表无音色源文件、本章有台词」的人物（voice_plan）才排一个只含 tts、只管这些资产的阶段任务。
async function enqueueChapterScopedGapList({ projectId, title, onProgress }) {
  const { runAssetCheck } = await import('./asset-check.js');
  const { report, gap } = await runAssetCheck(projectId, title, { trigger: 'after-prompts' });
  const ids = report.voice_plan.map((v) => v.asset_id);
  const base = { chapterScoped: true, gapList: gap ? gap.file : '', missing: report.summary.missing, voiceTodo: ids.length };
  if (!ids.length) return base;
  const active = Jobs.list(projectId).find((j) => (j.status === 'running' || j.status === 'queued') && j.type === 'stage'
    && Array.isArray(j.checkpoint && j.checkpoint.stages) && (j.checkpoint.stages.includes('tts') || j.checkpoint.stages.includes('image')));
  if (active) return { ...base, skipped: true, job: active };
  const { startStageJob } = await import('./stages.js');
  const job = startStageJob({ projectId, stages: ['tts'], chapter: title, onProgress, assetIds: ids });
  return { ...base, job };
}

export async function enqueuePendingAssetsIfNeeded({ projectId, chapter, onProgress }) {
  const title = String(chapter || '');
  const { gapListOn } = await import('./asset-check.js');
  if (title && gapListOn(projectId)) return enqueueChapterScopedGapList({ projectId, title, onProgress });
  const { pendingByStage, startStageJob } = await import('./stages.js');
  const pending = pendingByStage(projectId, title);
  const imageTodo = (pending.image && pending.image.todo) || 0;
  const ttsTodo = (pending.tts && pending.tts.todo) || 0;
  if (imageTodo + ttsTodo === 0) return null;
  const active = Jobs.list(projectId).find((j) => {
    if (j.status !== 'running' && j.status !== 'queued') return false;
    if (j.type !== 'stage') return false;
    const stages = (j.checkpoint && j.checkpoint.stages) || [];
    return Array.isArray(stages) && (stages.includes('image') || stages.includes('tts'));
  });
  if (active) return { skipped: true, job: active };
  const job = startStageJob({
    projectId,
    stages: ['image', 'tts'],
    chapter: title,
    onProgress,
  });
  return { job, imageTodo, ttsTodo };
}

function assetNoneNote(pending) {
  const img = (pending && pending.image) || { todo: 0, items: [] };
  const tts = (pending && pending.tts) || { todo: 0, items: [] };
  const pack = (label, p) => {
    const n = Number(p.todo) || 0;
    const items = Array.isArray(p.items) ? p.items : [];
    const extra = n > items.length ? '…' : '';
    return label + ' ' + n + ' 项' + (items.length ? '（' + items.join('；') + extra + '）' : '');
  };
  return '；未排入资产图/音色（post_storyboard_jobs=none）；' + pack('缺图', img) + '；' + pack('缺音色', tts);
}

function assetEnqueueNote(enq) {
  if (!enq) return '';
  if (enq.chapterScoped) {
    let s = '；本章资产检查：缺件 ' + enq.missing + ' 项' + (enq.gapList ? '（缺件单 ' + enq.gapList + '）' : '');
    if (enq.job && !enq.skipped) s += '；已把本章 ' + enq.voiceTodo + ' 个无音色源文件的台词角色排入音色队列（只管本章）';
    else if (enq.skipped) s += '；已有资产图/音色任务在跑或排队，未重复提交';
    return s;
  }
  if (enq.job && !enq.skipped) return '；已把待做的资产图/音色排入视频队列（不会打断正在出的视频）';
  if (enq.skipped) return '；资产图/音色已有任务在跑或排队，未重复提交';
  return '';
}

/**
 * 只做分镜的文本任务收尾：先补还没写上的 video_prompt，再把待做资产排进 IC 自己的视频队列。
 * 提示词失败不把整章分镜任务改判失败（分镜已落库）；资产排队失败只记日志。
 */
export async function afterStoryboardTextJob({ projectId, chapter, jobId, onProgress, isAborted }) {
  const title = String(chapter || '');
  if (!title) return '';
  // 2026-11-17 第三轮：Agent 运行时是外部 CLI（claude 等）时，与「提示词撰写」按钮走同一个受限入口
  // （fillChapterVideoPromptsViaAgent → runExternalAgent promptWrite=true：MCP 受限工具集 + 显式 --model opus），
  // 不再调内置 llm.js；只有内置 openclaude 运行时才保留逐镜 write_shot_video_prompt 旧路径。
  const agentId = promptWriteAgentId(loadConfig());
  let fill;
  if (agentId) {
    const r = chapterMissing(projectId, title, jobId)
      ? await fillChapterVideoPromptsViaAgent({ projectId, title, agentId, jobId, isAborted: isAborted || (() => false), onProgress })
      : { start: 0, summary: '' };
    fill = { summary: r.start ? r.summary : '', total: r.start };
  } else {
    const ctx = createToolRuntime({
      projectId, jobId, chapter: title,
      renderDisabled: true,
      isAborted: isAborted || (() => false),
      onProgress: onProgress || (() => {}),
    });
    fill = await fillChapterVideoPrompts({
      ctx, projectId, title, isAborted, jobId, onProgress,
    });
  }
  let assetNote = '';
  try {
    if (readPostStoryboardJobs(Projects.get(projectId)) === 'none') {
      const { pendingByStage } = await import('./stages.js');
      assetNote = assetNoneNote(pendingByStage(projectId, title));
    } else {
      const enq = await enqueuePendingAssetsIfNeeded({ projectId, chapter: title, onProgress });
      assetNote = assetEnqueueNote(enq);
    }
  } catch (e) {
    logger.warn('prompt-write: 排队资产生成失败', { projectId, chapter: title, error: e && e.message });
    assetNote = '；排入资产生成失败：' + (e && e.message ? e.message : String(e));
  }
  return (fill.summary || (fill.total === 0 ? '「' + title + '」视频提示词已齐' : '')) + assetNote;
}

/**
 * 提交「提示词撰写」任务。chapter 是章节行（要有 title）。
 * @returns {{ job: object, missing: number, missingWithVideo: number, total: number }}
 */
export function submitPromptWriteJob({ projectId, chapter, onProgress, shotIds, requirements, target }) {
  const title = String((chapter && chapter.title) || '');
  if (!title) throw Object.assign(new Error('缺少章节'), { code: 'CHAPTER_REQUIRED' });
  const busy = activeJobOfChapter(projectId, title);
  if (busy) {
    throw Object.assign(new Error('「' + title + '」已有任务在跑或排队，请等它结束或先停止'), { code: 'CHAPTER_BUSY', job: busy });
  }
  const shots = Shots.list(projectId).filter((s) => s.chapter === title);
  if (!shots.length) throw Object.assign(new Error('「' + title + '」还没有分镜，请先「生成分镜」'), { code: 'NO_SHOTS' });
  let gap = chapterPromptGap(shots);
  // 续轮12快：显式给 shot_ids = 指定镜重写（已有提示词/已出视频也写，旧提示词先存档；视频文件不动、不出片）
  const wantIds = Array.isArray(shotIds) ? [...new Set(shotIds.map((x) => String(x || '').trim()).filter(Boolean))] : [];
  let rewriteShotIds = null;
  if (wantIds.length) {
    const byId = new Map(shots.map((s) => [String(s.id), s]));
    const bad = wantIds.filter((id) => !byId.has(id));
    if (bad.length) throw Object.assign(new Error('这些分镜不属于「' + title + '」：' + bad.join('、')), { code: 'BAD_SHOT_IDS' });
    const busyIds = wantIds.filter((id) => ['generating', 'queued', 'obsolete'].includes(String(byId.get(id).status || '')));
    if (busyIds.length) throw Object.assign(new Error('这些分镜正在生成/排队或已作废，不能重写提示词：' + busyIds.map((id) => '第' + byId.get(id).idx + '镜').join('、')), { code: 'BAD_SHOT_IDS' });
    rewriteShotIds = wantIds;
    gap = { ...gap, missing: wantIds.length, rewrite: wantIds.length };
  }
  // 续轮13 R：每镜修改要求 { shot_id: 文本 }。只能配合 shot_ids；键必须在 shot_ids 里；值是非空文本（≤ 4000 字）。
  let rewriteRequirements = null;
  if (requirements != null) {
    if (typeof requirements !== 'object' || Array.isArray(requirements)) throw Object.assign(new Error('requirements 必须是 { shot_id: 文本 } 对象'), { code: 'BAD_REQUIREMENTS' });
    const keys = Object.keys(requirements);
    if (keys.length) {
      if (!rewriteShotIds) throw Object.assign(new Error('requirements 只能和 shot_ids（指定镜重写）一起用'), { code: 'BAD_REQUIREMENTS' });
      const inList = new Set(rewriteShotIds);
      const notIn = keys.filter((k) => !inList.has(String(k).trim()));
      if (notIn.length) throw Object.assign(new Error('requirements 里这些镜不在 shot_ids 里：' + notIn.join('、')), { code: 'BAD_REQUIREMENTS' });
      const bad = keys.filter((k) => typeof requirements[k] !== 'string' || !requirements[k].trim() || requirements[k].length > 4000);
      if (bad.length) throw Object.assign(new Error('requirements 的值必须是非空文本且不超过 4000 字：' + bad.join('、')), { code: 'BAD_REQUIREMENTS' });
      rewriteRequirements = {};
      for (const k of keys) rewriteRequirements[String(k).trim()] = requirements[k].trim();
      gap = { ...gap, requirements: keys.length };
    }
  }
  // 服装规则会话（总导 2026-11-24 03:09）：target='visual' = 分镜 visual 指定镜重写（只写 visual，其余字段不动），必须配合 shot_ids
  const rewriteTarget = target == null || target === '' || target === 'video_prompt' ? 'video_prompt' : String(target);
  if (rewriteTarget !== 'video_prompt' && rewriteTarget !== 'visual') throw Object.assign(new Error('target 只能是 video_prompt 或 visual'), { code: 'BAD_TARGET' });
  if (rewriteTarget === 'visual' && !rewriteShotIds) throw Object.assign(new Error('target=visual（分镜 visual 重写）必须带 shot_ids'), { code: 'BAD_TARGET' });
  if (!gap.missing) {
    throw Object.assign(
      new Error('「' + title + '」的分镜提示词已齐' + (gap.missingWithVideo ? '（另有 ' + gap.missingWithVideo + ' 镜已出视频但没有提示词，不补写）' : '')),
      { code: 'NOTHING_TO_WRITE', gap },
    );
  }

  const cfg = loadConfig();
  const agentId = promptWriteAgentId(cfg);
  const lane = promptWriteLane(cfg);
  if (rewriteShotIds && !agentId) throw Object.assign(new Error('指定镜重写只支持外部 Agent 运行时（读规则 + ranges_ack 那条路径）'), { code: 'BAD_SHOT_IDS' });
  const checkpoint = { subject: title, chapter: title, promptWrite: true, queue: lane.lane, queueReason: lane.reason, total: gap.missing, writer: agentId ? 'agent:' + agentId : 'llm', ...(rewriteShotIds ? { rewriteShotIds } : {}), ...(rewriteRequirements ? { rewriteRequirements } : {}), ...(rewriteTarget === 'visual' ? { rewriteTarget: 'visual', lockedFieldsMd5: Object.fromEntries(rewriteShotIds.map((id) => [id, lockedFieldsMd5(shots.find((x) => String(x.id) === id))])) } : {}) };
  const job = Jobs.create({ projectId, type: PROMPT_WRITE_JOB_TYPE, checkpoint });
  markProjectRunning(projectId);
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type: job.type, chapter: title, ...patch }); };
  const aborted = isAborted(job.id);
  const ctx = createToolRuntime({
    projectId, jobId: job.id, chapter: title,
    // 只跑文本：渲染类工具一律跳过（本任务只调用 write_shot_video_prompt，这里是双保险）
    renderDisabled: true,
    isAborted: aborted,
    onProgress: (patch) => {
      Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
      emit(patch);
    },
  });

  const task = async () => {
    if (agentId) {
      const r = await fillChapterVideoPromptsViaAgent({
        projectId, title, agentId, jobId: job.id, isAborted: aborted,
        onProgress: (patch) => {
          Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined });
          emit(patch);
        },
      });
      const summary = r.summary + (gap.missingWithVideo ? '；另有 ' + gap.missingWithVideo + ' 镜已出视频但没有提示词，未补写' : '');
      if (aborted()) return summary;
      // 一镜都没写成 → 失败（如 CLI 未登录 / 未安装）；部分写成 → 完成并在详情里报剩余数
      if (!r.written && r.start) throw new Error(summary);
      // 分镜 visual 重写：只改字，不排资产图/音色
      if (rewriteTarget === 'visual') return summary.replace('提示词撰写', '分镜 visual 重写');
      try {
        // 续轮12快：与分镜收尾同口径，post_storyboard_jobs=none 时不排资产图/音色
        if (readPostStoryboardJobs(Projects.get(projectId)) === 'none') return summary + '；未排入资产图/音色（post_storyboard_jobs=none）';
        const enq = await enqueuePendingAssetsIfNeeded({ projectId, chapter: title, onProgress });
        return summary + assetEnqueueNote(enq);
      } catch (e) {
        logger.warn('prompt-write: 排队资产生成失败', { projectId, chapter: title, error: e && e.message });
        return summary + '；排入资产生成失败：' + (e && e.message ? e.message : String(e));
      }
    }
    // 内置运行时（openclaude）：拿到槽位时再取一次：排队期间别的任务可能已经写好了部分提示词
    const fill = await fillChapterVideoPrompts({
      ctx, projectId, title, isAborted: aborted, jobId: job.id, onProgress: emit,
    });
    const summary = (fill.summary || ('「' + title + '」提示词撰写：写入 0 镜'))
      + (gap.missingWithVideo ? '；另有 ' + gap.missingWithVideo + ' 镜已出视频但没有提示词，未补写' : '');
    if (!fill.ok && fill.failed.length && !aborted()) throw new Error(summary);
    try {
      if (readPostStoryboardJobs(Projects.get(projectId)) === 'none') return summary + '；未排入资产图/音色（post_storyboard_jobs=none）';
      const enq = await enqueuePendingAssetsIfNeeded({ projectId, chapter: title, onProgress });
      return summary + assetEnqueueNote(enq);
    } catch (e) {
      logger.warn('prompt-write: 排队资产生成失败', { projectId, chapter: title, error: e && e.message });
      return summary + '；排入资产生成失败：' + (e && e.message ? e.message : String(e));
    }
  };

  const onQueue = (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase, detail: '' });
    emit({ phase, status: st });
  };

  // 2026-11-26 Andy：写稿任务不同章并行（文本闸门容量见 render-gate.textConcurrencyLimit），同一章按 key 互斥
  runJobTask(task, aborted, { jobId: job.id, onQueue, lane: lane.lane, key: 'ch:' + projectId + ':' + title })
    .then((summary) => {
      const cancelled = aborted();
      settleProject(projectId, job.id, true);
      const detail = String(summary == null ? '' : summary);
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'done', phase: cancelled ? '已取消' : '完成', detail: detail.slice(0, 2000), error: cancelled ? '已取消' : '', finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '完成', detail, status: cancelled ? 'cancelled' : 'done' });
    })
    .catch((e) => {
      const cancelled = aborted();
      settleProject(projectId, job.id, false);
      const detail = cancelled ? '已取消' : (e && e.message ? e.message : String(e));
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: detail, finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '失败', detail, status: cancelled ? 'cancelled' : 'failed' });
      if (!cancelled) logger.error('job: 提示词撰写失败', { projectId, chapter: title, error: e && e.message });
    });

  return { job, ...gap };
}
