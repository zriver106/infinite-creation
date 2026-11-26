// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, logSubmitRequest } from '@/lib/core/index.js';
import { submitMusicScoreJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 章节配乐任务入口（2026-11-26 Andy「32集都bgm 怎么乱配」；主会话 seq2179/seq2181）
// POST /api/projects/:id/chapters/:cid/music/score  body { requirement?: "这次配乐的要求（可空，≤4000 字）" }
// 起一个 IC Agent 只做配乐：读 ai-music-studio 和曲库指南、本章剧本和成片时间轴，写主曲 + cue 表（切曲 / 静音）。
// 外面只发起任务，不直接写 cue 表。走写稿文本队列，不碰出片、不占 GPU；rules_hold 在时排着等。
// 本章有任务在跑/排队 → 409 CHAPTER_BUSY；没配外部 Agent 运行时 → 400 NO_AGENT。合成/导出照现有 cue 逻辑执行。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  let body = {};
  try { const t = await req.text(); body = t && t.trim() ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  if (body.requirement != null && typeof body.requirement !== 'string') return NextResponse.json({ error: 'requirement 必须是文本', code: 'BAD_REQUIREMENT' }, { status: 400 });
  try {
    const r = submitMusicScoreJob({ projectId: id, chapter: ch, requirement: body.requirement, onProgress: (patch) => broadcast(patch) });
    try { logSubmitRequest(req, { route: 'POST /api/projects/:id/chapters/:cid/music/score', projectId: id, chapter: ch.title, jobId: r.job.id }); } catch { /* 记录失败不影响 */ }
    return NextResponse.json({ chapter: ch.title, job: r.job, lane: r.lane });
  } catch (e) {
    if (e && e.code === 'CHAPTER_BUSY') return NextResponse.json({ error: e.message, code: e.code, job: e.job }, { status: 409 });
    if (e && (e.code === 'NO_AGENT' || e.code === 'BAD_REQUIREMENT')) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
