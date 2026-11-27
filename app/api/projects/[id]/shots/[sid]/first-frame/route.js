// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// ic27 首尾帧衔接：分镜卡片的首帧 / 尾帧槽位。
//   POST { action: 'chain_prev' }                    承接上一镜（抽上一镜当前选中候选的最后一帧，CPU ffmpeg，不碰 GPU）
//   POST { action: 'set', which: 'first'|'last', path } 手动指定（path 为 /media 上传返回的项目内相对路径）
//   POST { action: 'clear', which: 'first'|'last' }  清空槽位（只清引用，图片文件保留）
//   POST { action: 'lead_in', value: 'on'|'off'|'auto' } 承接上一镜 22 帧（含声音）：on=接，off=不接，auto=按默认规则（同场景、时间连续才接）
// 返回更新后的分镜（含 first_frame_status）。
import { NextResponse } from 'next/server';
import { Shots, chainFirstFrameFromPrev, setUploadedFrame, clearFrame, firstFrameStatus, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';
import fs from 'node:fs';
import { LEAD_IN_SOURCE, LEAD_IN_OFF, leadInDecision } from '@/lib/core/lead-in.js';
import { prevShotOf } from '@/lib/core/first-frame.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id, sid } = await params;
  const body = await req.json().catch(() => ({}));
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  if (shot.status === 'generating' || shot.status === 'queued') {
    return NextResponse.json({ error: '第' + shot.idx + '镜正在生成中，等出完再改首/尾帧' }, { status: 409 });
  }
  if (shot.mode === 'first_last') {
    return NextResponse.json({ error: '本镜是「首尾帧」模式（插入时上传的两张图），不使用卡片首帧槽位' }, { status: 400 });
  }
  const action = String(body.action || '');
  const which = body.which === 'last' ? 'last' : 'first';
  return withWriteContext('POST /api/projects/:id/shots/:sid/first-frame', async () => {
    try {
      let extra = {};
      if (action === 'chain_prev') {
        const r = await chainFirstFrameFromPrev(id, sid);
        extra = { chained: { prev_shot_id: r.prev_shot_id, prev_idx: r.prev_idx, video_id: r.video_id, reused: r.reused } };
      } else if (action === 'set') {
        if (!body.path) return NextResponse.json({ error: '缺少 path' }, { status: 400 });
        setUploadedFrame(id, sid, which, String(body.path));
      } else if (action === 'clear') {
        clearFrame(id, sid, which);
      } else if (action === 'lead_in') {
        const v = String(body.value || '');
        if (!['on', 'off', 'auto'].includes(v)) return NextResponse.json({ error: 'value 只能是 on / off / auto' }, { status: 400 });
        Shots.setFrameAnchor(sid, { first_frame_source: v === 'on' ? LEAD_IN_SOURCE : v === 'off' ? LEAD_IN_OFF : '', first_frame_path: '', first_frame_from_shot_id: '', first_frame_from_video_id: '' });
      } else {
        return NextResponse.json({ error: 'action 只能是 chain_prev / set / clear / lead_in' }, { status: 400 });
      }
      const s = Shots.get(sid);
      const status = firstFrameStatus(s, Shots.list(id), { exists: (rel) => { const a = resolveProjectPath(id, rel); return !!a && fs.existsSync(a); } });
      const list = Shots.list(id);
      return NextResponse.json({ ...s, first_frame_status: status, lead_in: leadInDecision(s, prevShotOf(s, list)), ...extra });
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  });
}
