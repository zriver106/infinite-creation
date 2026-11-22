// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 章节配乐解绑（2026-11-18）：DELETE /api/projects/:id/chapters/:cid/music → 清空本章 music_path（主曲），
// caption / cue 表 / 乐句循环点保留；之前绑的曲子记在 music_prompt.unbound.previous。不删任何音频文件。
import { NextResponse } from 'next/server';
import { Chapters, withWriteContext, logSubmitRequest } from '@/lib/core/index.js';
import { unbindChapterMusic } from '@/lib/core/chapter-music.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

export async function DELETE(req, { params }) {
  const { id, cid } = await params;
  const before = Chapters.get(cid);
  if (!before || before.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  // 本章正在跑（合成 / 配乐）：中途换掉 music_path 会让本轮读到一半旧一半新，先等任务结束。
  if (activeJobOfChapter(id, before.title)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可解绑配乐；请等任务结束或先停止本章' }, { status: 409 });
  }
  return withWriteContext('DELETE /api/projects/:id/chapters/:cid/music', () => {
    const r = unbindChapterMusic(cid);
    if (!r) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
    logSubmitRequest(req, { route: 'DELETE /api/projects/:id/chapters/:cid/music', projectId: id, chapter: r.chapter.title });
    return NextResponse.json({ chapter_id: cid, title: r.chapter.title, music_path: '', unbound: r.changed, previous: r.previous });
  });
}
