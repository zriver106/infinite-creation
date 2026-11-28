// 场景三视图审图编排（手册 13 号；总导 11-28）：登记一轮候选 → 起审图任务（外部 Agent，scene-review 受限工具集）→ 读结论：
// 过 → 旧 art/ 备份到 art_history/<时间戳>/，四张写进 art/ 并拼白板_2x2.jpg（= 定稿，refs.js 会送参考图）；不过 → 写退回意见，art/ 不动。
// 只管审，不管派 am 出图。
import fs from 'node:fs';
import { Jobs } from '../core/index.js';
import { runParallelText } from '../core/render-gate.js';
import { agentLimit } from '../core/agent-limits.js';
import { loadConfig } from '../core/config.js';
import { registerRound, loadRound, saveRound, reviewResultFile, acceptRound, writeReturnNote } from '../core/scene-review.js';
import { runExternalAgent } from './external/runner.js';
import { promptWriteAgentId } from './prompt-write.js';

export const SCENE_REVIEW_JOB = 'scene-review';

const defaultDeps = () => ({
  runReview: (o) => runExternalAgent(o),
  agentId: promptWriteAgentId(loadConfig()),
});

/**
 * 起一轮审图。round 已登记（registerRound）。返回 { job_id, done }：done 是审完、写回 / 退回之后 resolve 的 Promise（结果见 onSceneReviewDone）。
 * 同一轮在审时不重复起；已有结论的轮次不重审（要重审就登记新一轮）。
 */
export function startSceneReview(projectId, sceneId, round, deps = defaultDeps()) {
  const r = loadRound(projectId, sceneId, round);
  if (!r) throw Object.assign(new Error('这一轮没登记：' + round), { code: 'NO_ROUND' });
  if (fs.existsSync(reviewResultFile(projectId, sceneId, round))) throw Object.assign(new Error('这一轮已经审过（' + r.status + '）；返修后登记新一轮'), { code: 'ALREADY_REVIEWED' });
  if (r.status === 'reviewing' && r.job_id) {
    const j = Jobs.get(r.job_id);
    if (j && j.status === 'running') throw Object.assign(new Error('这一轮正在审（任务 ' + r.job_id + '）'), { code: 'BUSY' });
  }
  const cp = { scene_id: sceneId, round, new_views: r.new_views, sceneReview: true };
  const job = Jobs.create({ projectId, type: SCENE_REVIEW_JOB, checkpoint: cp });
  saveRound(projectId, sceneId, round, { ...r, status: 'reviewing', job_id: job.id });
  Jobs.update(job.id, { status: 'running', phase: '审图', detail: '场景三视图「' + (r.name || sceneId) + '」' + round + '（新图：' + r.new_views.join('、') + '）' });
  const done = runParallelText(() => deps.runReview({ projectId, jobId: job.id, agentId: deps.agentId, sceneReview: true, renderDisabled: true, isAborted: () => false, onProgress: () => {} }), () => false, { jobId: job.id, gateKey: 'review', limit: agentLimit(projectId, 'review') })
    .then(() => null, (e) => e)
    .then((err) => onSceneReviewDone(projectId, sceneId, round, job.id, err));
  return { job_id: job.id, done };
}

/** 审图任务结束：读 review.json，过 → 写回 art/ + 白板；不过 → 退回意见；没交结论 → 任务失败（图不动）。 */
export function onSceneReviewDone(projectId, sceneId, round, jobId, agentErr = null) {
  const r = loadRound(projectId, sceneId, round) || {};
  const f = reviewResultFile(projectId, sceneId, round);
  if (!fs.existsSync(f)) {
    const note = '审图任务没交结论' + (agentErr && agentErr.message ? '：' + agentErr.message : '');
    saveRound(projectId, sceneId, round, { ...r, status: 'review_failed', note });
    Jobs.update(jobId, { status: 'failed', phase: '失败', error: note, finishedAt: Date.now() });
    return { status: 'review_failed', note };
  }
  const res = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (res.verdict === 'pass') {
    try {
      const w = acceptRound(projectId, sceneId, round);
      saveRound(projectId, sceneId, round, { ...r, status: 'accepted', accepted_at: Date.now(), backup: w.backup });
      Jobs.update(jobId, { status: 'done', phase: '完成', detail: '审过：场景三视图「' + (r.name || sceneId) + '」' + round + ' 写进 art/' + (w.backup ? '（旧图备份 ' + w.backup + '）' : ''), finishedAt: Date.now() });
      return { status: 'accepted', verdict: 'pass', backup: w.backup, written: w.written };
    } catch (e) {
      const note = '审过了但写回失败：' + e.message;
      saveRound(projectId, sceneId, round, { ...r, status: 'write_failed', note });
      Jobs.update(jobId, { status: 'failed', phase: '失败', error: note, finishedAt: Date.now() });
      return { status: 'write_failed', note };
    }
  }
  const noteFile = writeReturnNote(projectId, sceneId, round, res);
  const failed = (res.views || []).filter((v) => v.verdict !== 'pass').map((v) => v.view);
  saveRound(projectId, sceneId, round, { ...r, status: 'returned', failed_views: failed, return_note: noteFile });
  Jobs.update(jobId, { status: 'done', phase: '完成', detail: '退回：场景三视图「' + (r.name || sceneId) + '」' + round + ' 不过的视图 ' + failed.join('、') + '——' + (res.views || []).filter((v) => v.verdict !== 'pass').map((v) => v.view + '：' + String(v.fix_note || '').slice(0, 120)).join('；'), finishedAt: Date.now() });
  return { status: 'returned', verdict: 'fail', failed_views: failed, return_note: noteFile };
}

/** 登记 + 起审一步到位（脚本 / 接口用）。 */
export function reviewSceneCandidates(projectId, sceneId, candidateDir, { round = '' } = {}, deps = defaultDeps()) {
  const reg = registerRound(projectId, sceneId, candidateDir, { round });
  const { job_id, done } = startSceneReview(projectId, sceneId, reg.round, deps);
  return { round: reg.round, new_views: reg.new_views, fallback_views: reg.fallback_views, ratio: reg.ratio, job_id, done };
}
