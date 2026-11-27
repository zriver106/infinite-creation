// 戏份说明（adapt J-010；资产分析任务写）：按资产或地点 ID 一份 md，存 IC 项目内（<项目目录>/scene_notes/<key>.md）。
// 写场所需求分析（逐章出场、功能区、人数峰值、动线、规模口径、原著明写 / 想象补写、存疑、布局表）。覆盖前旧版存 scene_notes/_history/。
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './config.js';

const DIR = 'scene_notes';
export const SCENE_NOTE_MAX_CHARS = 60000;
const safeKey = (k) => String(k || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(0, 80);

export function listSceneNotes(projectId) {
  const d = path.join(projectDir(projectId), DIR);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => { const st = fs.statSync(path.join(d, f)); return { key: f.slice(0, -3), chars: fs.readFileSync(path.join(d, f), 'utf8').length, updated_at: st.mtimeMs }; }).sort((a, b) => a.key.localeCompare(b.key));
}

export function getSceneNote(projectId, key) {
  const k = safeKey(key);
  if (!k) return null;
  const f = path.join(projectDir(projectId), DIR, k + '.md');
  return fs.existsSync(f) ? { key: k, text: fs.readFileSync(f, 'utf8') } : null;
}

/** 正文以「见：」开头的是跳转说明（内容在另一份里）。 */
export const isRedirectNote = (text) => /^\s*(#[^\n]*\n\s*)?见[：:]/.test(String(text || ''));

export function saveSceneNote(projectId, key, text) {
  const k = safeKey(key);
  if (!k) throw Object.assign(new Error('戏份说明要给 key（地点 ID 或资产名）'), { code: 'BAD_NOTE' });
  const t = String(text || '');
  if (!t.trim()) throw Object.assign(new Error('戏份说明内容为空'), { code: 'BAD_NOTE' });
  if (t.length > SCENE_NOTE_MAX_CHARS) throw Object.assign(new Error('戏份说明超过 ' + SCENE_NOTE_MAX_CHARS + ' 字'), { code: 'BAD_NOTE' });
  const d = path.join(projectDir(projectId), DIR);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, k + '.md');
  if (fs.existsSync(f)) {
    const h = path.join(d, '_history');
    fs.mkdirSync(h, { recursive: true });
    fs.copyFileSync(f, path.join(h, k + '_' + Date.now() + '.md'));
  }
  fs.writeFileSync(f, t);
  return { key: k, chars: t.length };
}
