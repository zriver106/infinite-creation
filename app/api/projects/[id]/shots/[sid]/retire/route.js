// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, withWriteContext } from '@/lib/core/index.js';
import { activeJobOfChapter } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 分镜「作废 / 恢复」：不删除、只把这一镜排除出生成与合成（重写分镜后的残留旧镜用）。
//   POST   → 作废（status=obsolete；行、候选视频、视频文件全部保留）
//   DELETE → 恢复（有视频回到 done，没有回到 pending；同章同 idx 已被新镜占用时 409）
// 两个方向都留 change_logs（action=retire / restore），也可以用 /logs/rollback 撤销。
// 与 DELETE /shots/:sid 同口径：本章有任务在跑时不改，避免任务回写与这里打架。
async function guard(id, sid) {
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return { res: NextResponse.json({ error: '分镜不存在' }, { status: 404 }) };
  if (activeJobOfChapter(id, shot.chapter)) {
    return { res: NextResponse.json({ error: '本章正在运行任务，运行中不可作废/恢复分镜；请等任务结束' }, { status: 409 }) };
  }
  return { shot };
}

export async function POST(req, { params }) {
  const { id, sid } = await params;
  const g = await guard(id, sid);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const reason = String(body?.reason || '').slice(0, 200);
  try {
    return await withWriteContext('POST /api/projects/:id/shots/:sid/retire', async () => NextResponse.json(Shots.retire(sid, { reason })));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e && e.code === 'SHOT_BUSY' ? 409 : 500 });
  }
}

export async function DELETE(_req, { params }) {
  const { id, sid } = await params;
  const g = await guard(id, sid);
  if (g.res) return g.res;
  try {
    return await withWriteContext('DELETE /api/projects/:id/shots/:sid/retire', async () => NextResponse.json(Shots.restore(sid)));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e && e.code === 'IDX_TAKEN' ? 409 : 500 });
  }
}