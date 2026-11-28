// 场景三视图审图（手册 13 号；总导 11-28）：美术加工后的平面 / 正 / 左 / 右四张由 IC 审图 Agent 审，过了才写进 scene_master/<scene_id>/art/。
// GET  ?scene_id=…                                              → 该场景各轮状态（登记的新图、宽高比、审图结论、退回意见路径）
// POST { action: 'start', scene_id, candidate_dir, round? }    → 登记一轮（拷进 candidates/<round>/；没交的视图沿用已定稿 art/）并起审图任务
// POST { action: 'review', scene_id, round }                   → 已登记、还没结论的一轮重新起审（上次审图任务没交结论时用）
import { NextResponse } from 'next/server';
import { Projects } from '@/lib/core/index.js';
import { listRounds, loadRound, loadReviewResult } from '@/lib/core/scene-review.js';
import { getSceneMaster } from '@/lib/core/scene-master.js';
import { reviewSceneCandidates, startSceneReview } from '@/lib/agent/scene-review.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const sceneId = new URL(req.url).searchParams.get('scene_id') || '';
  if (!sceneId || !getSceneMaster(id, sceneId)) return NextResponse.json({ error: '要给 scene_id（场景母本）' }, { status: 400 });
  const rounds = listRounds(id, sceneId).map((r) => {
    const res = loadReviewResult(id, sceneId, r);
    return { ...loadRound(id, sceneId, r), result: res ? { verdict: res.verdict, forced: res.forced || [], views: (res.views || []).map((v) => ({ view: v.view, verdict: v.verdict, fix_note: v.fix_note || '' })) } : null };
  });
  return NextResponse.json({ scene_id: sceneId, rounds });
}

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const sceneId = String(body.scene_id || '');
  if (!sceneId) return NextResponse.json({ error: '要给 scene_id' }, { status: 400 });
  try {
    if (action === 'start') {
      const dir = String(body.candidate_dir || '');
      if (!dir) return NextResponse.json({ error: 'start 要给 candidate_dir（含 art_<plan|front|left|right>.png 的目录）' }, { status: 400 });
      const { done, ...r } = reviewSceneCandidates(id, sceneId, dir, { round: String(body.round || '') });
      done.catch(() => {});
      return NextResponse.json(r);
    }
    if (action === 'review') {
      const { done, job_id } = startSceneReview(id, sceneId, String(body.round || ''));
      done.catch(() => {});
      return NextResponse.json({ job_id });
    }
  } catch (e) {
    return NextResponse.json({ error: e.message, code: e.code || '' }, { status: 400 });
  }
  return NextResponse.json({ error: 'action 只能是 start / review' }, { status: 400 });
}
