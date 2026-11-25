// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters } from '@/lib/core/index.js';
import { submitPromptWriteJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 「提示词撰写」：只给本章补写缺失的分镜视频提示词（不清分镜、不改剧本、不出视频），进分镜（文本）队列。
// 章节由路径 cid 指定（必带章节）；同一章已有任务 → 409；没有分镜 → 400；提示词已齐 → 409（NOTHING_TO_WRITE）。
// 服装规则会话：body 再带 target:'visual' = 分镜 visual 指定镜重写（只写 visual，配合 shot_ids + requirements；旧 visual 存档 prompt_history.jsonl action=rewrite_visual）。
// 续轮12快：body 可带 { shot_ids: [...] } = 指定镜重写（只写这些镜的 video_prompt，旧提示词先存档到 prompt_history.jsonl）。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  let body = {};
  try { const t = await req.text(); body = t && t.trim() ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  if (body.shot_ids != null && !Array.isArray(body.shot_ids)) return NextResponse.json({ error: 'shot_ids 必须是数组' }, { status: 400 });
  // 续轮13 R：可带 { requirements: { <shot_id>: "这一镜的修改要求" } }，只能配合 shot_ids 用；写手在 brief 里逐镜看到
  if (body.requirements != null && (typeof body.requirements !== 'object' || Array.isArray(body.requirements))) return NextResponse.json({ error: 'requirements 必须是 { shot_id: 文本 } 对象', code: 'BAD_REQUIREMENTS' }, { status: 400 });
  try {
    const r = submitPromptWriteJob({ projectId: id, chapter: ch, onProgress: (patch) => broadcast(patch), shotIds: body.shot_ids, requirements: body.requirements, target: body.target });
    return NextResponse.json({ chapter: ch.title, missing: r.missing, missingWithVideo: r.missingWithVideo, total: r.total, rewrite: r.rewrite || 0, requirements: r.requirements || 0, target: body.target === 'visual' ? 'visual' : 'video_prompt', job: r.job });
  } catch (e) {
    if (e && e.code === 'CHAPTER_BUSY') return NextResponse.json({ error: e.message, code: e.code, job: e.job }, { status: 409 });
    if (e && e.code === 'NOTHING_TO_WRITE') return NextResponse.json({ error: e.message, code: e.code, gap: e.gap }, { status: 409 });
    if (e && e.code === 'BAD_TARGET') return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    if (e && e.code === 'BAD_REQUIREMENTS') return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    if (e && e.code === 'BAD_SHOT_IDS') return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    if (e && e.code === 'NO_SHOTS') return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}
