// 成片插帧（项目设置，总导 11-26）：GET → { interp, rife_available }；PUT { interp: none | rife | rife-comfyui }。
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { EXPORT_INTERP_KEY, INTERP_MODES, interpModeOf, rifeAvailable } from '@/lib/core/fps-finalize.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ interp: interpModeOf(id), rife_available: rifeAvailable(), comfyui_available: false });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!INTERP_MODES.includes(body.interp)) return NextResponse.json({ error: 'interp 只能是 ' + INTERP_MODES.join(' / ') }, { status: 400 });
  return withWriteContext('PUT /api/projects/:id/export-settings', () => {
    Projects.setContextKey(id, EXPORT_INTERP_KEY, body.interp);
    return NextResponse.json({ interp: interpModeOf(id) });
  });
}
