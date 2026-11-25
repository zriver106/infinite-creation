// 章节解绑配乐（A_v3，2026-11-18）：把章节的 music_path 清空，music_prompt 里去掉主曲（music_id / music_ref / music_name），
// caption、cue 表、乐句循环点保留；解绑前绑的是哪首记在 music_prompt.unbound.previous，便于核对和重绑。
// 供 DELETE /api/projects/:id/chapters/:cid/music 调用（章节 PATCH 故意不接受 music_* 字段，这是唯一的正规解绑入口）。
// 解绑后合成：没有 cue 表 → 不垫 BGM；有 cue 表 → cue 之外的时间不垫 BGM（与静音章一致）。
import { Chapters } from './db.js';

const MUSIC_EXT = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
/**
 * 续轮12快（总导 00:35）：把章节主曲绑回素材库里已有的一首（music_path 必须是本项目 music 资产的 audio_path，且文件存在）。
 * 可选 music_prompt（JSON 对象字符串）一并写。返回 { chapter, before, after } 或抛错（带 status）。不复制、不删任何音频文件。
 */
export function setChapterMusicPath({ chapterId, musicPath, musicPrompt, assets, fileExists }) {
  const ch = Chapters.get(chapterId);
  if (!ch) throw Object.assign(new Error('章节不存在'), { status: 404 });
  const mp = String(musicPath == null ? '' : musicPath).trim().split(String.fromCharCode(92)).join('/');
  if (!mp || mp.startsWith('/') || /^[a-zA-Z]:/.test(mp) || mp.split('/').includes('..') || !mp.startsWith('assets/music/') || !MUSIC_EXT.test(mp)) {
    throw Object.assign(new Error('music_path 必须是项目内相对路径 assets/music/<文件>（音频文件）：' + mp), { status: 400 });
  }
  const asset = (assets || []).find((a) => a.category === 'music' && String(a.audio_path || '').split(String.fromCharCode(92)).join('/') === mp);
  if (!asset) throw Object.assign(new Error('素材库里没有 audio_path=' + mp + ' 的 music 资产（只能绑已有曲目，不新登记）'), { status: 400 });
  if (fileExists && !fileExists(mp)) throw Object.assign(new Error('音频文件不存在：' + mp), { status: 400 });
  const patch = { music_path: mp };
  if (musicPrompt != null) {
    let o;
    try { o = typeof musicPrompt === 'string' ? JSON.parse(musicPrompt) : musicPrompt; } catch { o = null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw Object.assign(new Error('music_prompt 必须是 JSON 对象（或其字符串）'), { status: 400 });
    patch.music_prompt = JSON.stringify(o);
  }
  const before = { music_path: ch.music_path || '', music_prompt: ch.music_prompt || '' };
  const updated = Chapters.update(ch.id, patch, { meta: { force_log: true, reason: 'PUT 章节配乐：绑回素材库已有曲目' } });
  return { chapter: updated, asset_id: asset.id, before, after: { music_path: updated.music_path || '', music_prompt: updated.music_prompt || '' } };
}

export function unbindChapterMusic(chapterId) {
  const ch = Chapters.get(chapterId);
  if (!ch) return null;
  let p = {};
  try { p = JSON.parse(ch.music_prompt || '{}') || {}; } catch {}
  if (typeof p !== 'object' || Array.isArray(p)) p = {};
  const previous = { music_path: ch.music_path || '', music_id: p.music_id || '', music_name: p.music_name || '' };
  const { music_id, music_ref, music_name, ...rest } = p;
  if (previous.music_path || previous.music_id) rest.unbound = { at: new Date().toISOString(), previous };
  const updated = Chapters.update(ch.id, { music_path: '', music_prompt: JSON.stringify(rest) });
  return { chapter: updated, previous, changed: !!(previous.music_path || previous.music_id) };
}
