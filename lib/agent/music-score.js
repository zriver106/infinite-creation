// 章节配乐任务（2026-11-26 Andy「32集都bgm 怎么乱配」；主会话 seq2179/seq2181）。
// POST /api/projects/:id/chapters/:cid/music/score 起一个 IC Agent 只做配乐：读 ai-music-studio 和曲库指南、本章剧本和成片时间轴，
// 写主曲 + cue 表（含静音段）。外面只发起任务，不直接写 cue 表。
// 走写稿文本队列（lane 'write'，和提示词撰写同一个并行闸门）：不碰出片、不占 GPU；换规则书的 rules_hold.STOP 在时一样排着等。
import { agentLimit } from '../core/agent-limits.js';
import { Jobs, Chapters, logger, loadConfig } from '../core/index.js';
import { activeJobOfChapter, isAborted, markProjectRunning, settleProject, runJobTask } from './job-runner.js';
import { runExternalAgent } from './external/index.js';
import { promptWriteAgentId, promptWriteLane } from './prompt-write.js';
import { musicScoreWritesOfJob } from './music-score-mcp.js';

export const MUSIC_SCORE_JOB_TYPE = 'music-score';

/**
 * @param {{ projectId:string, chapter:{id,title}, requirement?:string, onProgress?:Function, runAgentFn?:Function }} p
 * @returns {{ job, lane:string }}
 */
export function submitMusicScoreJob({ projectId, chapter, requirement, onProgress, runAgentFn = runExternalAgent }) {
  const title = String((chapter && chapter.title) || '');
  if (!title) throw Object.assign(new Error('缺少章节'), { code: 'CHAPTER_REQUIRED' });
  const req = requirement == null ? '' : String(requirement);
  if (req.length > 4000) throw Object.assign(new Error('requirement 不能超过 4000 字'), { code: 'BAD_REQUIREMENT' });
  const busy = activeJobOfChapter(projectId, title);
  if (busy) throw Object.assign(new Error('「' + title + '」已有任务在跑或排队，请等它结束再配乐'), { code: 'CHAPTER_BUSY', job: busy });
  const cfg = loadConfig();
  const agentId = promptWriteAgentId(cfg);
  if (!agentId) throw Object.assign(new Error('章节配乐只支持外部 Agent 运行时（设置 → Agent 运行时）'), { code: 'NO_AGENT' });
  const lane = promptWriteLane(cfg);
  const checkpoint = { subject: title, chapter: title, musicScore: true, queue: lane.lane, queueReason: lane.reason, writer: 'agent:' + agentId, ...(req.trim() ? { requirement: req.trim() } : {}) };
  const job = Jobs.create({ projectId, type: MUSIC_SCORE_JOB_TYPE, checkpoint });
  markProjectRunning(projectId);
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type: job.type, chapter: title, ...patch }); };
  const aborted = isAborted(job.id);

  const task = async () => {
    let agentErr = null;
    try {
      await runAgentFn({
        projectId, chapter: title, jobId: job.id, agentId,
        musicScore: true, musicRequirement: req.trim(), renderDisabled: true,
        isAborted: aborted,
        onProgress: (patch) => { Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined }); emit(patch); },
      });
    } catch (e) { agentErr = e; }
    if (aborted()) return '已取消';
    const writes = musicScoreWritesOfJob(projectId, job.id);
    const cueWrites = writes.filter((w) => w.action === 'set_chapter_music_cues').length;
    const mainWrites = writes.filter((w) => w.action === 'set_chapter_music').length;
    const ch = Chapters.list(projectId).find((c) => c.title === title);
    let cues = []; try { const p = JSON.parse((ch && ch.music_prompt) || '{}'); cues = Array.isArray(p.cues) ? p.cues : []; } catch {}
    const summary = '「' + title + '」章节配乐：主曲写了 ' + mainWrites + ' 次，cue 表写了 ' + cueWrites + ' 次，现在 ' + cues.length + ' 段 cue（静音 ' + cues.filter((c) => c.music_id === 'silence').length + ' 段）'
      + (agentErr ? '；Agent 报错：' + (agentErr.message || String(agentErr)) : '');
    // 一次配乐都没写成（如 CLI 未登录、被拒后放弃）→ 失败
    if (!cueWrites && !mainWrites) throw new Error(summary + '；没有写入任何配乐');
    return summary;
  };

  const onQueue = (st) => {
    const phase = st === 'queued' ? '排队中' : '准备';
    Jobs.update(job.id, { status: st, phase, detail: '' });
    emit({ phase, status: st });
  };

  // 文本通道（外部 Agent 云端模型）进写稿并行闸门；否则按 lane 原样（本机模型会和出片串行）
  runJobTask(task, aborted, { jobId: job.id, onQueue, lane: lane.lane === 'text' ? 'write' : lane.lane, gateKey: 'prompt', limit: agentLimit(projectId, 'prompt') })
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
      if (!cancelled) logger.error('job: 章节配乐失败', { projectId, chapter: title, error: e && e.message });
    });

  return { job, lane: lane.lane };
}
