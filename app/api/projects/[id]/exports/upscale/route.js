// 成片升级 2K：POST { files: [...], force? } 排队（单条「升2k」与「批量升级2k」共用）；GET 列出本项目的升级任务。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { enqueueUpscale, listUpscaleTasks } from '@/lib/core/upscale2k.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ tasks: listUpscaleTasks(id) });
}

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return NextResponse.json({ error: '缺少要升级的成片' }, { status: 400 });
  try {
    return NextResponse.json(await enqueueUpscale(id, files, { force: body?.force === true }));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
