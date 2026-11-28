// 首尾帧控制（总导 11-28；临时规则 docs/临时规则/首尾帧控制审图_临时规则.md）：一镜的机位落位、灰模、首尾帧出图与审图。
//   GET                                               → { camera_rig, keyframe_review, validation, running }
//   POST { action: 'set', rig }                        手工写机位（校验过才存）
//   POST { action: 'plan' }                            LLM 落机位（读镜头说明 + 场景母本），校验不过重写一次
//   POST { action: 'run', seeds?: [7,11], apply?: true } 后台：渲灰模 → 出首/尾帧 → 审图 → 审过挂槽位（承接 22 帧的镜只挂尾帧）
import { NextResponse } from 'next/server';
import { Shots, withWriteContext } from '@/lib/core/index.js';
import { loadConfig } from '@/lib/core/config.js';
import { getSceneMaster } from '@/lib/core/scene-master.js';
import { rigOf, keyframeReviewOf, validateRig } from '@/lib/core/camera-rig.js';
import { planRig, runKeyframeRig, leadInOf } from '@/lib/agent/keyframe-rig.js';

export const dynamic = 'force-dynamic';

const running = globalThis.__icKeyframeRigRunning || (globalThis.__icKeyframeRigRunning = new Map());

function view(id, shot) {
  const rig = rigOf(shot);
  let validation = null;
  if (rig && rig.scene_id) {
    const sm = getSceneMaster(id, rig.scene_id);
    const li = leadInOf(id, shot, loadConfig());
    validation = sm ? validateRig(sm.master, rig, { prevRig: li.on ? li.prevRig : null }) : { ok: false, errors: ['场景母本不存在：' + rig.scene_id], warnings: [] };
  }
  return { shot_id: shot.id, idx: shot.idx, camera_rig: rig, keyframe_review: keyframeReviewOf(shot), validation, running: running.get(shot.id) || null };
}

export async function GET(req, { params }) {
  const { id, sid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  return NextResponse.json(view(id, shot));
}

export async function POST(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  if (shot.status === 'generating' || shot.status === 'queued') return NextResponse.json({ error: '第' + shot.idx + '镜正在出片，等出完再动首尾帧' }, { status: 409 });
  if (running.get(sid)) return NextResponse.json({ error: '这一镜的首尾帧流程正在跑', running: running.get(sid) }, { status: 409 });
  const action = String(body.action || '');
  const cfg = loadConfig();
  const ctx = { projectId: id, cfg, report: () => {} };
  return withWriteContext('POST /api/projects/:id/shots/:sid/rig', async () => {
    try {
      if (action === 'set') {
        const rig = body.rig;
        if (!rig || !rig.scene_id) return NextResponse.json({ error: '缺 rig 或 rig.scene_id' }, { status: 400 });
        const sm = getSceneMaster(id, rig.scene_id);
        if (!sm) return NextResponse.json({ error: '场景母本不存在：' + rig.scene_id }, { status: 400 });
        const li = leadInOf(id, shot, cfg);
        const v = validateRig(sm.master, rig, { prevRig: li.on ? li.prevRig : null });
        if (!v.ok) return NextResponse.json({ error: '机位校验没过', validation: v }, { status: 400 });
        Shots.setRigFields(sid, { camera_rig: { ...rig, set_at: Date.now(), validation: v } });
        return NextResponse.json(view(id, Shots.get(sid)));
      }
      if (action === 'plan') {
        running.set(sid, { action: 'plan', at: Date.now() });
        try { await planRig(ctx, sid); } finally { running.delete(sid); }
        return NextResponse.json(view(id, Shots.get(sid)));
      }
      if (action === 'run') {
        const seeds = Array.isArray(body.seeds) && body.seeds.length ? body.seeds.map(Number).filter(Number.isFinite).slice(0, 4) : [7, 11];
        const log = [];
        running.set(sid, { action: 'run', at: Date.now(), log });
        ctx.report = (r) => { log.push((r && r.detail) || String(r)); if (log.length > 50) log.shift(); };
        runKeyframeRig(ctx, sid, { seeds, apply: body.apply !== false })
          .catch((e) => { Shots.setRigFields(sid, { keyframe_review: { verdict: 'error', error: e.message, at: Date.now() } }); })
          .finally(() => running.delete(sid));
        return NextResponse.json({ started: true, seeds });
      }
      return NextResponse.json({ error: 'action 只能是 set / plan / run' }, { status: 400 });
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  });
}
