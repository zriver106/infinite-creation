// 资产归档（总导 11-26：V3 旧流程建的资产先不删，归档后资产分析不把它们当已有定稿）。
// GET 列出已归档的资产 id；PUT { ids: [...], archived: true|false } 归档 / 取消归档。只记在项目 context.archived_asset_ids，不删资产、不改资产。
import { NextResponse } from 'next/server';
import { Projects, Assets, withWriteContext } from '@/lib/core/index.js';
import { ARCHIVED_ASSETS_KEY } from '@/lib/agent/asset-analyze-mcp.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ archived: (p.context || {})[ARCHIVED_ASSETS_KEY] || [] });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return NextResponse.json({ error: '缺少 ids' }, { status: 400 });
  const own = new Set(Assets.list(id).map((a) => a.id));
  const bad = ids.filter((x) => !own.has(x));
  if (bad.length) return NextResponse.json({ error: '这些资产不属于本项目：' + bad.join('、') }, { status: 400 });
  const cur = new Set((p.context || {})[ARCHIVED_ASSETS_KEY] || []);
  for (const x of ids) { if (body.archived === false) cur.delete(x); else cur.add(x); }
  return withWriteContext('PUT /api/projects/:id/assets/archive', () => {
    Projects.setContextKey(id, ARCHIVED_ASSETS_KEY, [...cur]);
    return NextResponse.json({ archived: [...cur] });
  });
}
