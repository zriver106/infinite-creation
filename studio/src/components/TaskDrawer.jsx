import { useState } from 'react';
import { Ban, ClipboardList, ListChecks, Trash2 } from 'lucide-react';
import { Drawer } from './overlays.jsx';
import { Badge, Button, EmptyState, Progress } from './ui.jsx';
import { JobTypeIcon } from './visuals.jsx';
import { jobStageLabel, jobStagePercent } from './ProgressPanel.jsx';
import { CANCELLABLE, JOB_LABEL, JOB_STATUS_META, fmtDuration, fmtRelative } from '../lib/format.js';

const KIND_LABEL = {
  t2i: '资产图', i2i: '资产图', image: '资产图',
  r2v: '分镜视频', i2v: '分镜视频', video: '分镜视频',
  tts: '音色', voice: '音色', music: '背景音乐', export: '合成/导出',
};

// 任务详情（工具参数等）超过这么多行，或超过这么多字时默认折叠，给「展开全部」。
// 行数按换行符计；字数兜底是为了没有换行的一整段 JSON：后端现在最多写 4000 字，
// 470px 宽的抽屉里一行约 50 字，2000 字 ≈ 40 行。
const DETAIL_COLLAPSE_LINES = 40;
const DETAIL_COLLAPSE_CHARS = 2000;

function collapseDetail(raw) {
  const lines = raw.split('\n');
  if (lines.length > DETAIL_COLLAPSE_LINES) return lines.slice(0, DETAIL_COLLAPSE_LINES).join('\n');
  if (raw.length > DETAIL_COLLAPSE_CHARS) return raw.slice(0, DETAIL_COLLAPSE_CHARS);
  return null;
}

// 高度随内容撑开：不设 max-h、不设 overflow，所以块内不会出现滚动条；只改显示，不改 j.detail。
function JobDetailBlock({ text, textClassName = 'text-[11px] text-[var(--fg-3)]' }) {
  const [open, setOpen] = useState(false);
  const raw = text == null ? '' : String(text);
  if (!raw) return null;
  const head = collapseDetail(raw);
  const shown = head != null && !open ? head : raw;
  return (
    <div className="min-w-0">
      <p className={'m-0 whitespace-pre-wrap break-all leading-relaxed ' + textClassName}>
        {shown}
        {head != null && !open ? '…' : null}
      </p>
      {head != null ? (
        <button
          type="button"
          className="mt-1 bg-transparent p-0 text-[10.5px] text-[var(--accent)] underline-offset-2 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '展开全部'}
        </button>
      ) : null}
    </div>
  );
}

// 「整体进度」只在有活动任务时显示（数值仍是 /api/projects/:id/progress 的项目完成度，本次不改算法）。
// 没有活动任务：最近结束的那条若是「已取消」就显示「已取消」，否则整块隐藏，不再把项目完成度当成任务进度挂着。
function overallState(shownJobs, runningCount, queuedCount) {
  if (runningCount + queuedCount > 0) return 'active';
  let latest = null;
  for (const j of shownJobs || []) {
    if (j.status === 'running' || j.status === 'queued' || j.status === 'adopted') continue;
    const t = j.finishedAt || j.startedAt || 0;
    if (!latest || t > (latest.finishedAt || latest.startedAt || 0)) latest = j;
  }
  return latest && latest.status === 'cancelled' ? 'cancelled' : 'hidden';
}

export default function TaskDrawer({
  open,
  onOpenChange,
  jobs,
  progress,
  queue,
  runningCount,
  queuedCount,
  finishedCount,
  shownJobs,
  readOnly = false,
  onStopAll,
  onClearFinished,
  onCancel,
  onRemove,
}) {
  // 每个任务在渲染队列里的排位（同一条流水线同时只会有一个等待中的渲染）
  // 管理员能拿到全局 items；普通用户只有自己的 mine。
  const queueItems = queue?.items?.length ? queue.items : (queue?.mine || []);
  const queueByJob = new Map();
  for (const it of queueItems) {
    if (!it.jobId) continue;
    const rank = (x) => (x.status === 'running' ? -1 : (x.position || Number.MAX_SAFE_INTEGER));
    const prev = queueByJob.get(it.jobId);
    if (!prev || rank(it) < rank(prev)) queueByJob.set(it.jobId, it);
  }
  const queueLabel = (it) => {
    const chapter = it.chapter || it.payload?.chapter || '';
    const subject = it.subject || it.payload?.subject || '';
    const parts = [chapter, subject].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return KIND_LABEL[it.kind] || it.kind || '渲染任务';
  };
  const queueKnown = !!queue?.enabled;
  const description = queueKnown
    ? (queue.running || 0) + '/' + queue.capacity + ' 个渲染槽在用' + (queue.waiting ? ' · ' + queue.waiting + ' 个渲染排队' : '')
    : runningCount || queuedCount
      ? runningCount + ' 个执行中' + (queuedCount ? ' · ' + queuedCount + ' 个排队中' : '')
      : finishedCount
        ? finishedCount + ' 条已结束记录'
        : '当前没有任务';
  const overall = overallState(shownJobs, runningCount, queuedCount);
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="任务队列"
      description={description}
      width={470}
      bodyClassName="flex flex-col gap-3"
      footer={
        readOnly ? null : (
          <>
            {finishedCount > 0 ? (
              <Button variant="ghost" size="md" onClick={onClearFinished}>
                <ListChecks size={14} /> 清除已结束
              </Button>
            ) : null}
            {runningCount + queuedCount > 0 ? (
              <Button variant="danger" size="md" onClick={onStopAll}>
                <Ban size={14} /> 全部停止
              </Button>
            ) : null}
          </>
        )
      }
    >
      {overall === 'active' && progress ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[var(--fg-3)]">整体进度</span>
            <span className="font-mono text-[12px] text-[var(--accent)]">{progress.overall?.percent ?? 0}%</span>
          </div>
          <Progress value={progress.overall?.percent ?? 0} height={3} />
        </div>
      ) : overall === 'cancelled' ? (
        <div className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-white/[0.015] p-3">
          <span className="text-[11px] text-[var(--fg-3)]">整体进度</span>
          <span className="text-[12px] text-[var(--fg-3)]">已取消</span>
        </div>
      ) : null}

      {shownJobs.length === 0 ? (
        <EmptyState icon={ClipboardList} title="暂无任务" description="在章节页点击「生成」后，任务会实时出现在这里。" />
      ) : (
        <>
          <p className="m-0 rounded-lg border border-[var(--line)] bg-white/[0.015] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
            两条队列各自一次跑一个任务，可以同时进行：分镜队列只跑文本（拆分镜、写提示词），视频队列占显卡（出图、音色、出片）。
            分镜任务万一要用显卡，会先排到视频队列后面等它空出来，不会和出片同时占卡。同一章不会同时出现在两条队列里。
          </p>
          {[
            { key: 'storyboard', title: '分镜队列', hint: '只跑文本，不占显卡', list: shownJobs.filter(isTextQueueJob) },
            { key: 'video', title: '视频队列', hint: '出片及其他占显卡的任务', list: shownJobs.filter((j) => !isTextQueueJob(j)) },
          ].map((g) => {
            const activeN = g.list.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'adopted').length;
            return (
              <section key={g.key} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2 px-0.5">
                  <span className="text-[12px] font-semibold text-[var(--fg)]">{g.title}</span>
                  <span className="text-[10.5px] text-[var(--fg-4)]">
                    {g.hint} · {activeN ? activeN + ' 个进行中' : '空闲'}
                  </span>
                </div>
                {g.list.length === 0 ? (
                  <p className="m-0 px-0.5 text-[11px] text-[var(--fg-4)]">暂无</p>
                ) : (
                  g.list.map((j) => renderJob(j))
                )}
              </section>
            );
          })}
        </>
      )}
    </Drawer>
  );

  function renderJob(j) {
          const meta = JOB_STATUS_META[j.status] || { label: j.status, tone: 'neutral' };
          // ic25：adopted（接管中）算进行中，可「取消」（= 放弃接管，不杀外部进程），不给删
          const isActive = j.status === 'running' || j.status === 'queued' || j.status === 'adopted';
          const qi = queueByJob.get(j.id);
          const cp = j.checkpoint || {};
          const chapterLabel = cp.chapter || (Array.isArray(cp.stages) ? cp.stages.join('、') : '');
          const canCancel = isActive && CANCELLABLE.has(j.type) && !readOnly;
          const canRemove = !readOnly && j.status !== 'adopted' && !(j.status === 'running' && !CANCELLABLE.has(j.type));
          return (
            <div key={j.id} className="panel-flat flex flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={meta.tone} dot={isActive}>
                      {meta.label}
                    </Badge>
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--fg)]">
                      <JobTypeIcon type={j.type} size={13} className="text-[var(--fg-3)]" />
                      {JOB_LABEL[j.type] || j.type}
                    </span>
                  </div>
                  {(j.subjectLabel || chapterLabel) ? (
                    <p className="m-0 mt-1 truncate text-[11.5px] text-[var(--fg-3)]">{j.subjectLabel || chapterLabel}</p>
                  ) : null}
                  {isStoryboardOnly(j) && !isTextQueueJob(j) ? (
                    <p className="m-0 mt-0.5 text-[10.5px] text-[var(--fg-4)]">
                      只拆分镜，但排在视频队列里{cp.queueReason ? '（' + cp.queueReason + '）' : '（提交于双队列之前）'}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {canCancel ? (
                    <Button variant="ghost" size="iconSm" aria-label="取消任务" title="取消任务" onClick={() => onCancel(j.id)}>
                      <Ban size={13} />
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button variant="ghost" size="iconSm" aria-label="删除任务记录" title="删除任务记录" onClick={() => onRemove(j.id)}>
                      <Trash2 size={13} />
                    </Button>
                  ) : null}
                </div>
              </div>

              {qi ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(232,177,92,.28)] bg-[rgba(232,177,92,.07)] px-2.5 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--accent)]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-soft" />
                    <span className="truncate">
                      {qi.status === 'running' ? '正在渲染：' : '排队第 ' + (qi.position || '—') + ' 位 · '}
                      {queueLabel(qi)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10.5px] text-[var(--fg-3)]">
                    {qi.status === 'running' ? (KIND_LABEL[qi.kind] || qi.kind || '') : (qi.etaMs ? '预计 ' + fmtEta(qi.etaMs) : '等待空闲槽位')}
                  </span>
                </div>
              ) : isActive ? (
                (() => {
                  const pct = jobStagePercent(progress, j);
                  const label = jobStageLabel(progress, j);
                  return (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1 rounded-lg border border-[var(--line)] bg-white/[0.02] px-2.5 py-1.5">
                        <span className="flex min-w-0 items-start gap-1.5 text-[10.5px] text-[var(--fg-2)]">
                          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] animate-pulse-soft" />
                          <span className="min-w-0 whitespace-normal break-words">当前步骤：{j.phase || '准备中'}</span>
                        </span>
                        {j.detail ? (
                          <div className="min-w-0 flex-1 basis-[12rem]">
                            <JobDetailBlock text={j.detail} textClassName="text-[10px] text-[var(--fg-4)]" />
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--fg-4)]">
                        <span className="truncate">{label}</span>
                        <span className="shrink-0 font-mono">{pct == null ? '进行中' : pct + '%'}</span>
                      </div>
                      {pct == null ? <div className="skeleton h-[3px] rounded-full" /> : <Progress value={pct} height={3} />}
                    </div>
                  );
                })()
              ) : null}

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--fg-4)]">
                <span>{fmtRelative(j.startedAt)}</span>
                {j.finishedAt ? <span>· 用时 {fmtDuration(j.startedAt, j.finishedAt)}</span> : null}
                {j.phase ? <span className="min-w-0 whitespace-normal break-all">· {j.phase}</span> : null}
              </div>
              {/* 活动任务且没有渲染队列条时，detail 已在上面「当前步骤」那一行完整显示，这里不再重复一遍 */}
              {isActive && !qi ? null : <JobDetailBlock text={j.detail} />}
              {j.error ? (
                <p className="m-0 whitespace-pre-wrap break-all rounded-lg border border-[color-mix(in_srgb,var(--danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--danger)]">
                  {j.error}
                </p>
              ) : null}
            </div>
          );
  }
}

// 分栏 = 真正的执行队列：startCreateJob 把判定结果写进 checkpoint.queue（'text' = 文本闸门 / 'gpu' = 原 job 闸门）。
// 只拆分镜但仍走 job 闸门的（总开关关、本机 LLM、双队列之前提交的）如实显示在「视频队列」，卡片上注明原因。
function isTextQueueJob(j) {
  // 「提示词撰写」（prompt-write）同样按 checkpoint.queue 分栏
  return (j.type === 'create' || j.type === 'prompt-write') && !!(j.checkpoint && j.checkpoint.queue === 'text');
}
function isStoryboardOnly(j) {
  return j.type === 'create' && !!(j.checkpoint && j.checkpoint.storyboardOnly);
}

// 预计等待：队列按池统计的平均耗时 × 前方任务数 / 槽位（服务端已算好 etaMs，这里只做展示格式化）
function fmtEta(ms) {
  const m = Math.ceil(Number(ms) / 60000);
  if (!Number.isFinite(m) || m <= 0) return '不到 1 分钟';
  if (m < 60) return '约 ' + m + ' 分钟';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return '约 ' + h + ' 小时' + (r ? ' ' + r + ' 分钟' : '');
}
