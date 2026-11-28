// 导出后的插帧任务（11-28 跟进2 报：第 1 章重导时主成片收尾没走完——RIFE 失败后退回只裁，临时文件又没换回去，主文件还是 736 / 24 帧，
// 导出任务照样报 done。原因之一是网页导出路由里的 withGpuAccess 不在文本通道，直接放行，RIFE 和正在出片的第 2 章同时占卡）。
// 现在：导出当场只裁边（CPU），插到 30 帧另起一个「export-interp」任务，走视频任务闸门排在出片后面（同一时刻只有一家用卡），
// 插完换回原文件、再交付一次；任何一份没插成，这个任务记失败（任务列表里看得见），不报完成。
import path from 'node:path';
import { resolveProjectPath, deliverChapterExport, logger } from '../core/index.js';
import { finalizeExport, interpModeOf, rifeAvailable } from '../core/fps-finalize.js';
import { runExclusiveVideo } from '../core/render-gate.js';
import { runInlineJob } from './job-runner.js';
import { pruneOlderChapterExports } from '../core/export-prune.js';

/** 这个项目导出后要不要插帧（项目设置不插、RIFE 独立版不在，就不排任务）。 */
export function exportNeedsInterp(projectId) {
  const mode = interpModeOf(projectId);
  return mode === 'rife' && rifeAvailable();
}

/**
 * 排一个插帧任务（不等它跑完）。rels：要插帧的导出文件（项目内相对路径，主成片在前）；chapter 有值时插完重新交付主成片。
 * 返回任务的 promise（调用方一般不等；测试里可以等）。
 */
export function startExportInterp(projectId, { chapter = '', rels = [], onProgress } = {}, deps = {}) {
  const { finalize = finalizeExport, gate = runExclusiveVideo, deliver = deliverChapterExport, run = runInlineJob, prune = pruneOlderChapterExports } = deps;
  const files = rels.filter(Boolean);
  const p = run({ projectId, type: 'export-interp', checkpoint: { subject: chapter, files }, onProgress }, (emit) => gate(async () => {
    const notes = [];
    for (const rel of files) {
      const f = await finalize(projectId, resolveProjectPath(projectId, rel), { report: (d) => emit(d) });
      notes.push(path.basename(rel) + '：' + f.note);
      if (f.failed) throw new Error(path.basename(rel) + ' 插帧失败：' + f.note);
    }
    if (chapter && files[0]) {
      const d = await deliver({ projectId, chapterTitle: chapter, exportRel: files[0], source: 'export-interp' });
      notes.push('交付：' + (d.status === 'skipped' ? '没交付（' + (d.reason || '未说明') + '）' : d.status) + (d.error ? '（' + d.error + '）' : ''));
      if (d.status === 'failed') throw new Error('插帧完成，但重新交付失败：' + (d.error || ''));
      // 插帧、交付都成了：同一章更早的导出清掉，只留这一版（Andy 11-28）
      const pr = prune(projectId, files[0]);
      if (pr.deleted.length) notes.push('清掉旧导出 ' + pr.deleted.length + ' 个文件');
      if (pr.skipped.length) notes.push('留下 ' + pr.skipped.map((x) => x.stem + '（' + x.why + '）').join('、'));
    }
    return notes.join('；');
  }, () => false, {}));
  p.catch((e) => logger.error('导出插帧任务失败', { projectId, chapter, files, error: e.message }));
  return p;
}
