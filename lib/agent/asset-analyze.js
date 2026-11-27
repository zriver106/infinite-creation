// 资产分析任务（Andy 11-26；adapt J-004 / J-009 / J-010；做法照章节配乐任务 music-score.js）。
// POST /api/projects/:id/assets/analyze { chapters:[起,止], requirement? } 起一个 IC Agent 只做资产分析：
// 读规则（J 段 + 戏份说明模板 + 虚构示例）→ 检索 / 读本项目原著 → 写地点表、戏份说明、缺图单。不出图、不出片、不改分镜。
// 走写稿文本队列（lane 'write'），不占 GPU；换规则书的 rules_hold.STOP 在时排着等。同一项目同时只跑一个资产分析。
import { Jobs, Chapters, logger, loadConfig } from '../core/index.js';
import { isAborted, markProjectRunning, settleProject, runJobTask } from './job-runner.js';
import { runExternalAgent } from './external/index.js';
import { promptWriteAgentId, promptWriteLane } from './prompt-write.js';
import { getLocations } from '../core/locations.js';
import { listSceneNotes, getSceneNote, isRedirectNote } from '../core/scene-notes.js';
import { gapCoverage } from '../core/asset-gaps.js';

export const ASSET_ANALYZE_JOB_TYPE = 'asset-analyze';

function activeAnalyzeJob(projectId) {
  return Jobs.list(projectId).find((j) => j.type === ASSET_ANALYZE_JOB_TYPE && ['queued', 'running', 'pending'].includes(j.status)) || null;
}

/** @returns {{ job, lane:string, range:[number,number]|null }} */
export function submitAssetAnalyzeJob({ projectId, chapters, requirement, onProgress, runAgentFn = runExternalAgent }) {
  const all = Chapters.list(projectId);
  if (!all.length) throw Object.assign(new Error('项目没有章节'), { code: 'NO_CHAPTERS' });
  let range = null;
  if (chapters != null) {
    if (!Array.isArray(chapters) || chapters.length !== 2 || !chapters.every((n) => Number.isInteger(Number(n)) && Number(n) > 0) || Number(chapters[0]) > Number(chapters[1])) {
      throw Object.assign(new Error('chapters 要写成 [起章号, 止章号]，如 [1, 12]'), { code: 'BAD_RANGE' });
    }
    range = [Number(chapters[0]), Number(chapters[1])];
  }
  const req = requirement == null ? '' : String(requirement);
  if (req.length > 4000) throw Object.assign(new Error('requirement 不能超过 4000 字'), { code: 'BAD_REQUIREMENT' });
  const busy = activeAnalyzeJob(projectId);
  if (busy) throw Object.assign(new Error('本项目已有资产分析任务在跑或排队，请等它结束'), { code: 'PROJECT_BUSY', job: busy });
  const cfg = loadConfig();
  const agentId = promptWriteAgentId(cfg);
  if (!agentId) throw Object.assign(new Error('资产分析只支持外部 Agent 运行时（设置 → Agent 运行时）'), { code: 'NO_AGENT' });
  const lane = promptWriteLane(cfg);
  const subject = range ? '资产分析 第' + range[0] + '–' + range[1] + '章' : '资产分析 全书';
  const job = Jobs.create({ projectId, type: ASSET_ANALYZE_JOB_TYPE, checkpoint: { subject, assetAnalyze: true, chapters: range, queue: lane.lane, writer: 'agent:' + agentId, ...(req.trim() ? { requirement: req.trim() } : {}) } });
  markProjectRunning(projectId);
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type: job.type, ...patch }); };
  const aborted = isAborted(job.id);
  const before = { loc: JSON.stringify(getLocations(projectId)), notes: JSON.stringify(listSceneNotes(projectId)) };

  const task = async () => {
    let agentErr = null;
    try {
      await runAgentFn({
        projectId, chapter: '', jobId: job.id, agentId,
        assetAnalyze: true, assetAnalyzeRange: range, assetAnalyzeRequirement: req.trim(), renderDisabled: true,
        isAborted: aborted,
        onProgress: (patch) => { Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined }); emit(patch); },
      });
    } catch (e) { agentErr = e; }
    if (aborted()) return '已取消';
    const loc = getLocations(projectId); const notes = listSceneNotes(projectId);
    const changedLoc = JSON.stringify(loc) !== before.loc; const changedNotes = JSON.stringify(notes) !== before.notes;
    const summary = subject + '：地点表 ' + (loc.rows || []).length + ' 个地点、存疑 ' + (loc.doubts || []).length + ' 条' + (changedLoc ? '（本次更新）' : '（未改）') + '；戏份说明 ' + notes.length + ' 份' + (changedNotes ? '（本次有写）' : '（未改）')
      + (agentErr ? '；Agent 报错：' + (agentErr.message || String(agentErr)) : '');
    if (!changedLoc && !changedNotes) throw new Error(summary + '；没有写入任何分析结果');
    // J-011：每份戏份说明开头答四问（生命周期 / 范围 / 功能 / 状态），缺的列出来（只提示）
    const lack = [];
    for (const n of notes) {
      const t = (getSceneNote(projectId, n.key) || {}).text || '';
      if (isRedirectNote(t)) continue;
      const miss = ['生命周期', '范围', '功能', '状态'].filter((k) => !t.includes(k));
      if (miss.length) lack.push(n.key + '（缺 ' + miss.join('、') + '）');
    }
    // 缺图单覆盖：写了戏份说明的都要在合并缺图单里（只提示）
    const cov = gapCoverage(projectId);
    const covTxt = cov.missing.length ? '；还没进缺图单的戏份说明 ' + cov.missing.length + ' 份：' + cov.missing.slice(0, 10).join('、') : '；缺图单已覆盖全部戏份说明';
    if (lack.length) return summary + covTxt + '；J-011 四问没答全的戏份说明 ' + lack.length + ' 份：' + lack.slice(0, 10).join('，');
    return summary + covTxt;
    return summary;
  };
  const onQueue = (st) => { const phase = st === 'queued' ? '排队中' : '准备'; Jobs.update(job.id, { status: st, phase, detail: '' }); emit({ phase, status: st }); };
  runJobTask(task, aborted, { jobId: job.id, onQueue, lane: lane.lane === 'text' ? 'write' : lane.lane })
    .then((summary) => {
      const cancelled = aborted();
      settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'done', phase: cancelled ? '已取消' : '完成', detail: String(summary || '').slice(0, 2000), error: cancelled ? '已取消' : '', finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '完成', detail: summary, status: cancelled ? 'cancelled' : 'done' });
    })
    .catch((e) => {
      const cancelled = aborted();
      settleProject(projectId, job.id, false);
      const detail = cancelled ? '已取消' : (e && e.message ? e.message : String(e));
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: detail, finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '失败', detail, status: cancelled ? 'cancelled' : 'failed' });
      if (!cancelled) logger.error('job: 资产分析失败', { projectId, error: e && e.message });
    });
  return { job, lane: lane.lane, range };
}
