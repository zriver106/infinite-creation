// 戏份说明（资产分析任务写）：GET 列出；GET ?key=xxx 读一份。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { listSceneNotes, getSceneNote } from '@/lib/core/scene-notes.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const key = new URL(req.url).searchParams.get('key');
  if (key) { const n = getSceneNote(id, key); return n ? NextResponse.json(n) : NextResponse.json({ error: '没有这份戏份说明' }, { status: 404 }); }
  return NextResponse.json(listSceneNotes(id));
}
