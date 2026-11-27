// 资产分析任务入口（Andy 11-26「V3 不用从头再分析，但是要掌握这个技能」；adapt J-004 / J-009 / J-010）
// POST /api/projects/:id/assets/analyze  body { chapters?: [起章号, 止章号], requirement?: "这次的要求（可空，≤4000 字）" }
// 起一个 IC Agent 只做资产分析：先读规则，再检索 / 读本项目原著，写地点表、戏份说明、缺图单。不出图、不出片、不改分镜。
// 本项目已有资产分析在跑 → 409 PROJECT_BUSY；没配外部 Agent → 400 NO_AGENT；范围写错 → 400 BAD_RANGE。
import { NextResponse } from 'next/server';
import { Projects, logSubmitRequest } from '@/lib/core/index.js';
import { submitAssetAnalyzeJob } from '@/lib/agent/asset-analyze.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  let body = {};
  try { const t = await req.text(); body = t && t.trim() ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  if (body.requirement != null && typeof body.requirement !== 'string') return NextResponse.json({ error: 'requirement 必须是文本', code: 'BAD_REQUIREMENT' }, { status: 400 });
  try {
    const r = submitAssetAnalyzeJob({ projectId: id, chapters: body.chapters, requirement: body.requirement, onProgress: (patch) => broadcast(patch) });
    try { logSubmitRequest(req, { route: 'POST /api/projects/:id/assets/analyze', projectId: id, jobId: r.job.id }); } catch { /* 记录失败不影响 */ }
    return NextResponse.json({ job: r.job, lane: r.lane, chapters: r.range });
  } catch (e) {
    if (e && e.code === 'PROJECT_BUSY') return NextResponse.json({ error: e.message, code: e.code, job: e.job }, { status: 409 });
    if (e && ['NO_AGENT', 'BAD_REQUIREMENT', 'BAD_RANGE', 'NO_CHAPTERS'].includes(e.code)) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
