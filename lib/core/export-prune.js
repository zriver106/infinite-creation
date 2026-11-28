// 导出自动清旧版（Andy 11-28「最终版出来后这个文件夹也要清理下」）：某章导出成功（插帧做完、交付没失败）后，
// 同一章更早的导出整组删掉，只留最新一版：<旧>.mp4、<旧>_nosub.mp4、<旧>.srt、<旧>.fps_tmp.mp4、<旧>.合成闸提醒.json。
// 不碰：交付目录；别的章、整片导出；有 2K 放大版从它派生的旧导出（.ic-versions.json 里 upscaled_from 指向它）——这种跳过并写明。
// 导出失败、插帧失败、交付失败时调用方不调本函数，旧版保留。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';
import { logger } from './logger.js';

const SUFFIXES = ['.mp4', '_nosub.mp4', '.srt', '.fps_tmp.mp4', '.合成闸提醒.json'];

/** exports/<base>_<8 位 hex>.mp4 → { base, id }；不是这种名字返回 null。 */
export function exportNameParts(rel) {
  const name = path.basename(String(rel || ''));
  const m = name.match(/^(.+)_([0-9a-f]{8})\.mp4$/);
  return m ? { base: m[1], id: m[2], stem: m[1] + '_' + m[2] } : null;
}

function upscaledSources(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.ic-versions.json'), 'utf8'));
    return new Set(Object.values((j && j.files) || {}).map((m) => m && m.upscaled_from).filter(Boolean).map((n) => path.basename(String(n))));
  } catch { return new Set(); }
}

/**
 * 删掉 keepRel 同一章（同一 base）更早的导出。返回 { deleted:[文件名], skipped:[{stem, why}] }。
 * fsx 测试注入。
 */
export function pruneOlderChapterExports(projectId, keepRel, { dir = path.join(projectDir(projectId), 'exports'), fsx = fs } = {}) {
  const keep = exportNameParts(keepRel);
  const out = { deleted: [], skipped: [] };
  if (!keep) return out;
  let names = [];
  try { names = fsx.readdirSync(dir); } catch { return out; }
  const stems = new Set();
  for (const n of names) {
    const m = n.match(/^(.+)_([0-9a-f]{8})(?:_nosub)?(?:\.fps_tmp)?\.(?:mp4|srt|合成闸提醒\.json)$/);
    if (m && m[1] === keep.base && m[2] !== keep.id) stems.add(m[1] + '_' + m[2]);
  }
  const up = upscaledSources(dir);
  for (const stem of stems) {
    if (up.has(stem + '.mp4') || up.has(stem + '_nosub.mp4')) { out.skipped.push({ stem, why: '有 2K 放大版从它派生，留着' }); continue; }
    for (const suf of SUFFIXES) {
      const f = path.join(dir, stem + suf);
      try { if (fsx.existsSync(f)) { fsx.rmSync(f, { force: true }); out.deleted.push(stem + suf); } }
      catch (e) { out.skipped.push({ stem: stem + suf, why: '删不掉：' + e.message }); }
    }
  }
  if (out.deleted.length || out.skipped.length) logger.info('导出清旧版', { projectId, keep: path.basename(String(keepRel)), deleted: out.deleted, skipped: out.skipped });
  return out;
}
