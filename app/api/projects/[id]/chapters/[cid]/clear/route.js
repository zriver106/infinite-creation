// 本章清理：GET 预览将清掉的数量；POST 先归档核哈希，再删本章分镜 / 候选视频 / 分镜视频 / 成片 / 封面。
// 素材库、剧本文本、章节配乐绑定、交付目录一律不动。本章有任务在跑或排队时返回 409。
// 本路由不提交任何任务。
import { NextResponse } from 'next/server';
import { Chapters, previewChapterClear, clearChapter } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

const SERVER_ERRORS = new Set(['HASH_MISMATCH', 'ARCHIVE_FAILED', 'ARCHIVE_EXISTS', 'BAD_PATH']);

function mapError(e) {
  const code = e && e.code;
  const message = e && e.message ? e.message : String(e);
  if (code === 'NOT_FOUND') return NextResponse.json({ error: message, code }, { status: 404 });
  if (code === 'CHAPTER_BUSY') return NextResponse.json({ error: message, code }, { status: 409 });
  if (code === 'NOTHING_TO_CLEAR') return NextResponse.json({ error: message, code }, { status: 400 });
  if (SERVER_ERRORS.has(code)) return NextResponse.json({ error: message, code, archiveDir: e.archiveDir || '' }, { status: 500 });
  return NextResponse.json({ error: message, code: code || 'CLEAR_FAILED' }, { status: 500 });
}

// 与 /run 单章分支同一个去重口径（job-runner.js activeJobOfChapter），叠加在 chapter-clear 自己的保守检查之上
function extraBusy(id, cid) {
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return [];
  const j = activeJobOfChapter(id, ch.title);
  return j ? [j] : [];
}

export async function GET(_req, { params }) {
  const { id, cid } = await params;
  try {
    return NextResponse.json(previewChapterClear(id, cid, { extraBusy: extraBusy(id, cid) }));
  } catch (e) {
    return mapError(e);
  }
}

export async function POST(_req, { params }) {
  const { id, cid } = await params;
  try {
    // 再查一次活动任务：确认框弹出到点确定之间可能已有任务开跑。clearChapter 全程同步，查完到删库之间不会插进新任务。
    return NextResponse.json(clearChapter(id, cid, { extraBusy: extraBusy(id, cid) }));
  } catch (e) {
    return mapError(e);
  }
}
