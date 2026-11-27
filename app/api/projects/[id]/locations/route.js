// 项目地点表（adapt J-004 / J-010 第 2a 条）：GET 读；PUT { rows, doubts } 整份覆盖（旧版留档在 locations_history.jsonl）。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { getLocations, saveLocations } from '@/lib/core/locations.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json(getLocations(id));
}

export async function PUT(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: '请求体要是 { rows, doubts }' }, { status: 400 });
  try { return NextResponse.json(saveLocations(id, body, { source: 'PUT /api/projects/:id/locations' })); }
  catch (e) { if (e && e.code === 'BAD_LOCATIONS') return NextResponse.json({ error: e.message, errors: e.errors }, { status: 400 }); throw e; }
}
