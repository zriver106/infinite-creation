// 设为选用：同一条成片的原片与升级版里只有一条是「选用」，交付 / 导出用选用的那一条。body: { name }
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { setSelected } from '@/lib/core/upscale2k.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(setSelected(id, String(body?.name || '')));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
