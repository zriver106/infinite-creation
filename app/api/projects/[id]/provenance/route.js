// 每镜来源审计（只读；主会话 seq2227）：GET /api/projects/:id/provenance[?chapter=第N章][&flagged=1][&ok_from=rules-xxxx]
// 按章列每镜 video_prompt / visual 现值的写入来源（IC 写稿 / 外部 PATCH / 旧流程 Agent）和写时规则书版本，标出落后、外部写、旧流程写的镜。
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { shotProvenance } from '@/lib/core/shot-provenance.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const u = new URL(req.url);
  const chapter = u.searchParams.get('chapter') || '';
  const r = shotProvenance(id, { ...(chapter ? { chapter } : {}), okFrom: u.searchParams.get('ok_from') || '' });
  if (u.searchParams.get('flagged') === '1') for (const c of r.chapters) c.shots = c.shots.filter((s) => s.flags.length);
  return NextResponse.json(r);
}
