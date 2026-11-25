// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// 章节配乐解绑（2026-11-18）：DELETE /api/projects/:id/chapters/:cid/music → 清空本章 music_path（主曲），
// caption / cue 表 / 乐句循环点保留；之前绑的曲子记在 music_prompt.unbound.previous。不删任何音频文件。
import { NextResponse } from 'next/server';
import { Chapters, withWriteContext, logSubmitRequest, Assets, projectDir } from '@/lib/core/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { unbindChapterMusic, setChapterMusicPath } from '@/lib/core/chapter-music.js';
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

// 续轮12快（总导 00:35）：PUT /api/projects/:id/chapters/:cid/music  body { music_path, music_prompt? }
// 把本章主曲绑回素材库里已有的一首（music_path 必须是本项目 music 资产的 audio_path 且文件存在）；写进变更日志（force_log）；
// 本章有任务在跑时 409。不复制、不删任何音频文件。
export async function PUT(req, { params }) {
  const { id, cid } = await params;
  const before = Chapters.get(cid);
  if (!before || before.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  if (activeJobOfChapter(id, before.title)) {
    return NextResponse.json({ error: '本章正在运行任务，运行中不可改配乐；请等任务结束' }, { status: 409 });
  }
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  const root = path.resolve(projectDir(id));
  const fileExists = (rel) => { const abs = path.resolve(root, rel); return abs.startsWith(root + path.sep) && fs.existsSync(abs); };
  return withWriteContext('PUT /api/projects/:id/chapters/:cid/music', () => {
    try {
      const r = setChapterMusicPath({ chapterId: cid, musicPath: body && body.music_path, musicPrompt: body ? body.music_prompt : undefined, assets: Assets.list(id), fileExists });
      logSubmitRequest(req, { route: 'PUT /api/projects/:id/chapters/:cid/music', projectId: id, chapter: r.chapter.title });
      return NextResponse.json({ chapter_id: cid, title: r.chapter.title, asset_id: r.asset_id, before: r.before, after: r.after });
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: e.status || 500 });
    }
  });
}
