// 章节解绑配乐（A_v3，2026-11-18）：把章节的 music_path 清空，music_prompt 里去掉主曲（music_id / music_ref / music_name），
// caption、cue 表、乐句循环点保留；解绑前绑的是哪首记在 music_prompt.unbound.previous，便于核对和重绑。
// 供 DELETE /api/projects/:id/chapters/:cid/music 调用（章节 PATCH 故意不接受 music_* 字段，这是唯一的正规解绑入口）。
// 解绑后合成：没有 cue 表 → 不垫 BGM；有 cue 表 → cue 之外的时间不垫 BGM（与静音章一致）。
import { Chapters } from './db.js';

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
