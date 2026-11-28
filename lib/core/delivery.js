// 交付目录：某章成片导出成功后，按项目设置把主成片（export_path）复制成 <交付目录>\EP<N>.mp4。
// 调用点：lib/agent/tools.js hAssembleVideo（Agent / 阶段任务 / 换配乐重合成都走它）、
//         app/api/projects/[id]/export/route.js（手动「导出」，平行实现）。
// 只报错、不拦：本函数永不抛异常，失败只写日志并返回 status:'failed'，调用方不改合成结果。
// 不提交任务、不碰数据库写入；只读 projects.context 的 delivery_dir / delivery_enabled。
import fs from 'node:fs';
import path from 'node:path';
import { Projects } from './db.js';
import { projectDir } from './config.js';
import { resolveProjectPath } from './refs.js';
import { logger } from './logger.js';
import { readDeliverySettings, chapterNumberFromTitle } from './project-ui-settings.js';
import { deliverFileToDir } from './delivery-copy.js';

export function deliveryLogPath(projectId) {
  return path.join(projectDir(projectId), 'logs', 'delivery.jsonl');
}

function appendLog(projectId, entry) {
  try {
    const file = deliveryLogPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    logger.error('交付日志写入失败', { projectId, error: e && e.message });
  }
}

// 最近 n 条交付记录（新→旧），给「运行状态」卡片显示「交付失败」用
export function readDeliveryLog(projectId, n = 10) {
  let text = '';
  try { text = fs.readFileSync(deliveryLogPath(projectId), 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    try { out.push(JSON.parse(lines[i])); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/**
 * @returns {Promise<{status:'ok'|'failed'|'skipped', ep:number|null, reason?:string, error?:string, result?:object}>}
 */
export async function deliverChapterExport({ projectId, chapterTitle, exportRel, source = '' }) {
  try {
    const project = Projects.get(projectId);
    if (!project) return { status: 'skipped', ep: null, reason: '项目不存在' };
    const settings = readDeliverySettings(project);
    if (!settings.enabled) return { status: 'skipped', ep: null, reason: '交付未启用' };
    if (!settings.dir) return { status: 'skipped', ep: null, reason: '未设置交付目录' };
    const ep = chapterNumberFromTitle(chapterTitle);
    const base = { at: new Date().toISOString(), projectId, projectName: project.name, chapter: String(chapterTitle || ''), ep, exportRel: String(exportRel || ''), source };
    if (ep == null) {
      const entry = { ...base, status: 'skipped', reason: '章名不是「第N章」，不交付' };
      appendLog(projectId, entry);
      logger.info('交付跳过：章名解析不到「第N章」', { projectId, chapter: chapterTitle });
      return { status: 'skipped', ep: null, reason: entry.reason };
    }
    const srcAbs = resolveProjectPath(projectId, exportRel);
    if (!srcAbs) {
      const entry = { ...base, status: 'failed', step: 'validate', error: '成片路径非法：' + exportRel };
      appendLog(projectId, entry);
      logger.error('交付失败', entry);
      return { status: 'failed', ep, error: entry.error };
    }
    // 覆盖下来的旧 EP 归档到 IC 项目自己的 exports\交付归档（交付目录里只放 EPn.mp4）
    const r = await deliverFileToDir({ deliveryDir: settings.dir, ep, srcAbs, archiveDir: path.join(projectDir(projectId), 'exports', '交付归档') });
    const entry = {
      ...base,
      status: r.ok ? 'ok' : 'failed',
      step: r.step,
      deliveryDir: settings.dir,
      target: r.target,
      sourceSha: r.sourceSha,
      previousSha: r.previousSha,
      archivePath: r.archivePath,
      finalSha: r.finalSha,
      unchanged: r.unchanged,
      error: r.error,
    };
    appendLog(projectId, entry);
    if (r.ok) logger.info('交付完成 EP' + ep, { projectId, target: r.target, sha256: r.finalSha, archive: r.archivePath || '', unchanged: r.unchanged });
    else logger.error('交付失败 EP' + ep, { projectId, step: r.step, error: r.error });
    return r.ok ? { status: 'ok', ep, result: r } : { status: 'failed', ep, error: r.error, result: r };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    try { logger.error('交付异常', { projectId, chapter: chapterTitle, error }); } catch { /* noop */ }
    return { status: 'failed', ep: null, error };
  }
}
