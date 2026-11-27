// 只写剧本任务入口（总导 11-26：V3 第 1–5 章按新规则重写剧本，只要剧本）
// POST /api/projects/:id/chapters/:cid/script/rewrite  body { requirement?: "这次的要求（可空，≤4000 字）" }
// 起一个 IC Agent 只重写本章剧本：先读规则（不给旧剧本），按 R-004～R-008 写，存盘自检。不拆分镜、不出片。
// 本章有任务 → 409 CHAPTER_BUSY；没配外部 Agent → 400 NO_AGENT；本章没原著 → 400 NO_NOVEL。
import { NextResponse } from 'next/server';
import { Chapters, logSubmitRequest } from '@/lib/core/index.js';
import { submitScriptWriteJob } from '@/lib/agent/script-write.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, cid } = await params;
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  let body = {};
  try { const t = await req.text(); body = t && t.trim() ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  if (body.requirement != null && typeof body.requirement !== 'string') return NextResponse.json({ error: 'requirement 必须是文本', code: 'BAD_REQUIREMENT' }, { status: 400 });
  try {
    const r = submitScriptWriteJob({ projectId: id, chapter: ch, requirement: body.requirement, onProgress: (patch) => broadcast(patch) });
    try { logSubmitRequest(req, { route: 'POST /api/projects/:id/chapters/:cid/script/rewrite', projectId: id, chapter: ch.title, jobId: r.job.id }); } catch { /* 记录失败不影响 */ }
    return NextResponse.json({ chapter: ch.title, job: r.job, lane: r.lane });
  } catch (e) {
    if (e && e.code === 'CHAPTER_BUSY') return NextResponse.json({ error: e.message, code: e.code, job: e.job }, { status: 409 });
    if (e && ['NO_AGENT', 'BAD_REQUIREMENT', 'NO_NOVEL'].includes(e.code)) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
