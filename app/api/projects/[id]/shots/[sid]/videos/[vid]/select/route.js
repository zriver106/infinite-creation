// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Shots, ShotVideos } from '@/lib/core/index.js';
import { staleAfterSelect, staleLeadInText } from '@/lib/agent/lead-in-ctx.js';

export const dynamic = 'force-dynamic';

// 把某个候选视频设为「导出用」：单分镜多候选下，用户勾选一条优质候选用于成片导出。
// 选中态与 shots.video_path 都是渲染产物，不进 changelog；这里只做直接的 DB 写。
export async function POST(_req, { params }) {
  const { id, sid, vid } = await params;
  const shot = Shots.get(sid);
  if (!shot || shot.project_id !== id) return NextResponse.json({ error: '分镜不存在' }, { status: 404 });
  const video = ShotVideos.get(vid);
  if (!video || video.shot_id !== sid) return NextResponse.json({ error: '候选视频不存在' }, { status: 404 });

  ShotVideos.setSelected(sid, vid);
  // 保持 shots.video_path 指向选中候选：导出成片 / 合成 / 打包 / 章节封面等链路零改动即可取用
  Shots.update(sid, { video_path: video.video_path, status: 'done', error: '' });
  // 11-28：换选中片后，承接本镜的下一镜如果因此过期，在响应头里写明（响应体照旧是候选列表，界面不用改）
  let stale = [];
  try { stale = staleAfterSelect(id, Shots.get(sid)); } catch { /* 提醒失败不影响选片 */ }
  const res = NextResponse.json(ShotVideos.listByShot(sid));
  if (stale.length) res.headers.set('X-IC-Lead-In-Stale', encodeURIComponent(staleLeadInText(stale)));
  return res;
}