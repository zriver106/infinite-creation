// 孤儿任务收尾（2026-11-17 第四轮，方案见 草稿/三视图排查_20261117/20_孤儿任务恢复方案/方案.md）。
// 背景：任务的执行者是建它那个后端进程里的 Promise（runJobTask / 渲染闸门 waiter）。后端重启后：
//   - running 的任务由 startupCleanup 标 interrupted（再由 restart-recovery 按外部 Agent 进程判定）；
//   - queued 的任务 jobs 行原样留着 queued，但已没有任何人会来跑它或给它落终态 —— 成了孤儿，
//     出片守护按「项目有排队任务」一直判忙，不再自动续章（2026-11-17 V2 的 8e430498）。
//   - cancel 路由只打停止标记 + 摘队列，对孤儿是空操作，却回 {ok:true}（假成功）。
// 本模块：把「本进程启动前建的、仍是 queued、本进程没有执行者」的任务落成 cancelled（从没跑过、无产物 →
// 语义是作废而不是失败；守护对 cancelled/failed 同为 failed 类，create 任务不会被自动重提）。
// 不重新提交、不删记录、不写裸 SQL（走 Jobs/Assets/Projects 接口）、不动 running / interrupted 任务。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Assets, Projects, logger, withWriteContext, DATA_DIR, sweepStaleRenderLocks, renderLockDisabled } from '../core/index.js';

/** 本进程启动时刻（ms）。server.js 用自己的 bootAt；路由里没有 bootAt，用进程启动时间。 */
export function processBootAt() { return Date.now() - Math.round(process.uptime() * 1000); }

/** 多实例保护：任务最后一次更新必须早于启动时刻至少这么久，防止把另一个活着的后端实例的排队任务误判成孤儿。 */
export const ORPHAN_GUARD_MS = 5000;

const ASSET_JOB_TYPES = new Set(['voice-design', 'voice-clone', 'asset-image', 'costume', 'age', 'music', 'video', 'digital-human-tts']);

export function orphanLogFile() { return path.join(DATA_DIR, 'logs', 'orphan-jobs.jsonl'); }

function appendLog(entry) {
  try {
    const f = orphanLogFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    logger.warn('孤儿任务：写 orphan-jobs.jsonl 失败', { error: e && e.message });
  }
}

/**
 * 是否孤儿排队任务。纯判定（deps 可注入，单测用）。
 * 条件同时满足：status=queued；startedAt < since；updatedAt < since - guardMs；本进程没有执行者。
 */
export function isOrphanQueued(job, { since = processBootAt(), guardMs = ORPHAN_GUARD_MS, isLive = (id) => Jobs.isLive(id) } = {}) {
  if (!job || job.status !== 'queued') return false;
  if (!(Number(job.startedAt || 0) < since)) return false;
  if (!(Number(job.updatedAt || job.startedAt || 0) < since - guardMs)) return false;
  return !isLive(job.id);
}

/** 资产卡在 generating 时复位（与各 start*Job 的 catch 同口径）；别的活动任务占着同一资产时不动。 */
function resetSubjectAsset(job) {
  if (!ASSET_JOB_TYPES.has(job.type)) return '';
  const aid = job.checkpoint && job.checkpoint.subject;
  if (!aid) return '';
  const a = Assets.get(aid);
  if (!a || a.status !== 'generating') return '';
  const busy = Jobs.list(job.projectId).some((j) => j.id !== job.id
    && (j.status === 'running' || j.status === 'queued')
    && j.checkpoint && j.checkpoint.subject === aid
    && (Jobs.isLive(j.id) || j.status === 'running'));
  if (busy) return 'asset-busy';
  const st = (a.audio_path || a.image_path || a.video_path) ? 'done' : 'failed';
  Assets.update(aid, { status: st });
  return st;
}

/**
 * 把一个孤儿排队任务落成 cancelled。调用方负责先用 isOrphanQueued 判定。
 * @returns {{jobId:string, action:'cancelled'|'skipped', assetReset?:string, detail:string}}
 */
export function settleOrphanJob(job, { reason = '服务重启：排队中的任务没有执行者，已作废（未重新提交）', source = 'startup', onProgress } = {}) {
  const cur = Jobs.get(job.id);
  if (!cur || cur.status !== 'queued') return { jobId: job.id, action: 'skipped', detail: '状态已是 ' + (cur && cur.status) };
  let assetReset = '';
  withWriteContext('job:orphan-settle', () => {
    Jobs.update(job.id, {
      status: 'cancelled', phase: '已取消', error: reason, finishedAt: Date.now(),
      detail: String(cur.detail || '').slice(0, 1800) + '\n\n【孤儿任务】' + reason,
    });
    try { assetReset = resetSubjectAsset(cur); } catch (e) { assetReset = 'error:' + (e && e.message); }
    // 项目里没有别的活动任务了 → 复位为空闲（停止按钮消失；与 releaseProject 同口径）
    try {
      const more = Jobs.list(cur.projectId).some((j) => j.id !== job.id && (j.status === 'running' || j.status === 'queued'));
      const p = Projects.get(cur.projectId);
      if (!more && p && p.status === 'running') Projects.update(cur.projectId, { status: 'idle' });
    } catch { /* noop */ }
  });
  const subject = (cur.checkpoint && cur.checkpoint.subject) || '';
  const entry = { at: new Date().toISOString(), source, pid: process.pid, jobId: cur.id, projectId: cur.projectId, type: cur.type, subject, startedAt: cur.startedAt, updatedAt: cur.updatedAt, action: 'cancelled', assetReset, reason };
  appendLog(entry);
  logger.warn('孤儿任务已作废（' + source + '）', { jobId: cur.id, projectId: cur.projectId, type: cur.type, subject, startedAt: cur.startedAt, assetReset });
  if (onProgress) { try { onProgress({ projectId: cur.projectId, jobId: cur.id, type: cur.type, phase: '已取消', status: 'cancelled', detail: reason }); } catch { /* noop */ } }
  return { jobId: cur.id, action: 'cancelled', assetReset, detail: reason };
}

/**
 * ic23：启动时顺手清渲染租约锁（lib/core/render-lock.js）。持有者进程已不在 / 心跳过期的锁删掉，
 * 记到 data/logs/render-locks.jsonl（不写 orphan-jobs.jsonl，那里只记任务）；持有者还活着的
 * （例如重启后仍在跑的外部 Agent 的 MCP 子进程）保留，只打日志。锁本身也会在下次拿锁时被判死接管，
 * 这里只是让「重启后第一时间干净」。IC_DISABLE_CHAPTER_RENDER_LOCK=1 时不动。
 */
export function sweepRenderLocksAtStartup() {
  if (renderLockDisabled()) return [];
  let res = [];
  try {
    res = sweepStaleRenderLocks({ jobStatus: (id) => { const j = Jobs.get(id); return j ? j.status : 'missing'; } });
  } catch (e) {
    logger.warn('渲染锁：启动清理失败', { error: e && e.message });
    return [];
  }
  const released = res.filter((r) => r.action === 'released');
  const kept = res.filter((r) => r.action === 'kept');
  if (released.length) logger.warn('重启恢复：清掉失效渲染锁 ' + released.length + ' 把', { locks: released.map((r) => r.key + ' ' + r.reason + ' job=' + ((r.owner && r.owner.jobId) || '') + '/' + (r.ownerJob || '')) });
  if (kept.length) logger.info('重启恢复：渲染锁持有者仍在运行，保留 ' + kept.length + ' 把', { locks: kept.map((r) => r.key + ' pid=' + ((r.owner && r.owner.pid) || '') + ' job=' + ((r.owner && r.owner.jobId) || '') + '/' + (r.ownerJob || '')) });
  return res;
}

/** 启动入口：server.js 在 startupCleanup 之后、startScheduler 之前同步调用。since = 启动清理前的 bootAt。 */
export function settleOrphanQueuedJobs({ since, guardMs = ORPHAN_GUARD_MS, onProgress } = {}) {
  sweepRenderLocksAtStartup();
  let jobs = [];
  try {
    jobs = Jobs.list().filter((j) => isOrphanQueued(j, { since, guardMs }));
  } catch (e) {
    logger.error('孤儿任务：读取任务失败', { error: e && e.message });
    return [];
  }
  if (!jobs.length) return [];
  logger.info('重启恢复：孤儿排队任务 ' + jobs.length + ' 个', { jobs: jobs.map((j) => j.id + ' ' + j.type) });
  const out = [];
  for (const j of jobs) {
    try { out.push(settleOrphanJob(j, { source: 'startup', onProgress })); } catch (e) {
      logger.error('孤儿任务收尾失败', { jobId: j.id, error: e && e.message });
      out.push({ jobId: j.id, action: 'skipped', detail: '出错：' + (e && e.message) });
    }
  }
  return out;
}
