// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters } from '@/lib/core/index.js';
import { submitPromptWriteJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 「提示词撰写」：只给本章补写缺失的分镜视频提示词（不清分镜、不改剧本、不出视频），进分镜（文本）队列。
// 章节由路径 cid 指定（必带章节）；同一章已有任务 → 409；没有分镜 → 400；提示词已齐 → 409（NOTHING_TO_WRITE）。
export async function POST(_req, { params }) {
  const { id, cid } = await params;
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  try {
    const r = submitPromptWriteJob({ projectId: id, chapter: ch, onProgress: (patch) => broadcast(patch) });
    return NextResponse.json({ chapter: ch.title, missing: r.missing, missingWithVideo: r.missingWithVideo, total: r.total, job: r.job });
  } catch (e) {
    if (e && e.code === 'CHAPTER_BUSY') return NextResponse.json({ error: e.message, code: e.code, job: e.job }, { status: 409 });
    if (e && e.code === 'NOTHING_TO_WRITE') return NextResponse.json({ error: e.message, code: e.code, gap: e.gap }, { status: 409 });
    if (e && e.code === 'NO_SHOTS') return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
