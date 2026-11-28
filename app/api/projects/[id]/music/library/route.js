// 曲库导入（Andy 11-28：背景音乐页要能看到曲库曲目、能试听、能「应用到」章节）。
// POST：把 kim-bgm 曲库全部曲目登记成本项目 music 资产（硬链接，不复制；首选标出来），已登记的复用。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { importBgmLibrary } from '@/lib/agent/tools.js';

export const dynamic = 'force-dynamic';

export async function POST(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  try { return NextResponse.json(importBgmLibrary(id)); }
  catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
