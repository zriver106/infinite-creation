// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
// ic27 首尾帧衔接：分镜卡片的首帧 / 尾帧槽位。
//   POST { action: 'chain_prev' }                    承接上一镜（抽上一镜当前选中候选的最后一帧，CPU ffmpeg，不碰 GPU）
//   POST { action: 'set', which: 'first'|'last', path } 手动指定（path 为 /media 上传返回的项目内相对路径）
//   POST { action: 'clear', which: 'first'|'last' }  清空槽位（只清引用，图片文件保留）
// 返回更新后的分镜（含 first_frame_status）。
import { NextResponse } from 'next/server';
import { Shots, chainFirstFrameFromPrev, setUploadedFrame, clearFrame, firstFrameStatus, resolveProjectPath, withWriteContext } from '@/lib/core/index.js';
import fs from 'node:fs';

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
      } else {
        return NextResponse.json({ error: 'action 只能是 chain_prev / set / clear' }, { status: 400 });
      }
      const s = Shots.get(sid);
      const status = firstFrameStatus(s, Shots.list(id), { exists: (rel) => { const a = resolveProjectPath(id, rel); return !!a && fs.existsSync(a); } });
      return NextResponse.json({ ...s, first_frame_status: status, ...extra });
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  });
}
