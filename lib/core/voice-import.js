// 音色导入（Andy 11-26「音色优先拿 v2 的来用」；总导：资产分析重建人物时音色丢了）。
// 给本项目的人物找现成音色：先找本项目里同名、已归档的旧人物（重建前那个），再找登记过的参考项目（V2）里同名人物；
// 找到就把 voice_desc、音色文件复制过来（文件拷进本项目，不引用别的项目的路径）；找不到才交给音色阶段新设计。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';
import { Assets, Projects } from './db.js';
import { referenceProjectsOf } from './reference-assets.js';
import { PROJECT_ASSET_SUBDIRS } from '../shared/index.js';

const hasVoice = (pid, a) => { const r = String((a && a.voice_ref) || '').trim(); return !!r && fs.existsSync(path.join(projectDir(pid), r)); };

/** 同名人物的现成音色来源：本项目已归档的同名旧人物优先，其次参考项目里的同名人物。 */
export function findVoiceSource(projectId, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const arch = new Set((((Projects.get(projectId) || {}).context || {}).archived_asset_ids) || []);
  const own = Assets.list(projectId, 'character').find((a) => a.name === n && arch.has(a.id) && hasVoice(projectId, a));
  if (own) return { project_id: projectId, asset: own, from: '本项目已归档的同名旧人物' };
  for (const pid of referenceProjectsOf(projectId)) {
    const hit = Assets.list(pid, 'character').find((a) => a.name === n && hasVoice(pid, a));
    if (hit) return { project_id: pid, asset: hit, from: '参考项目「' + ((Projects.get(pid) || {}).name || pid) + '」' };
  }
  return null;
}

/** 把来源人物的音色复制给本项目人物（voice_desc、音色文件；文件拷进本项目）。overwrite=false 时已有可用音色的不动。 */
export function importVoice(projectId, aid, { fromAssetId = '', overwrite = false } = {}) {
  const a = Assets.get(aid);
  if (!a || a.project_id !== projectId || a.category !== 'character') throw Object.assign(new Error('只能给本项目的人物导入音色'), { code: 'BAD_TARGET' });
  if (!overwrite && hasVoice(projectId, a)) return { asset_id: aid, name: a.name, skipped: '已有音色' };
  let src = null;
  if (fromAssetId) {
    const s = Assets.get(fromAssetId);
    const allowed = s && (s.project_id === projectId || referenceProjectsOf(projectId).includes(s.project_id));
    if (!allowed || s.category !== 'character' || !hasVoice(s.project_id, s)) throw Object.assign(new Error('来源人物不可用（要本项目或登记过的参考项目里、有音色文件的人物）'), { code: 'BAD_SOURCE' });
    src = { project_id: s.project_id, asset: s, from: '指定的人物' };
  } else src = findVoiceSource(projectId, a.name);
  if (!src) return { asset_id: aid, name: a.name, skipped: '没找到同名的现成音色' };
  const srcAbs = path.join(projectDir(src.project_id), src.asset.voice_ref);
  const ext = path.extname(srcAbs) || '.wav';
  const rel = 'assets/' + (PROJECT_ASSET_SUBDIRS.voice || 'voices') + '/' + String(a.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) + '_imported_' + Date.now().toString(36) + ext;
  const abs = path.join(projectDir(projectId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(srcAbs, abs);
  const desc = String(src.asset.voice_desc || '').trim() || String(a.voice_desc || '');
  Assets.update(aid, { voice_ref: rel, voice_desc: desc, voice_desc_used: desc });
  return { asset_id: aid, name: a.name, imported: true, from: src.from, from_asset_id: src.asset.id, voice_ref: rel };
}

/** 本项目没音色的人物，逐个找现成音色导入（音色阶段开跑前、建资产槽后调用）。 */
export function importMissingVoices(projectId, { onlyIds = null } = {}) {
  const arch = new Set((((Projects.get(projectId) || {}).context || {}).archived_asset_ids) || []);
  const out = [];
  for (const a of Assets.list(projectId, 'character')) {
    if (arch.has(a.id) || (onlyIds && !onlyIds.includes(a.id)) || hasVoice(projectId, a)) continue;
    try { out.push(importVoice(projectId, a.id)); } catch (e) { out.push({ asset_id: a.id, name: a.name, error: e.message }); }
  }
  return out;
}
