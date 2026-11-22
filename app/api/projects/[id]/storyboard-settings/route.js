// 项目级分镜收尾开关：projects.context.post_storyboard_jobs。
//   queue（缺省，键不存在也是 queue）：afterStoryboardTextJob 收尾仍排资产图/TTS（原行为）
//   none：收尾不排出图、不排 TTS，只把缺图和缺音色清单写进报告
// 只改设置，不提交任何任务。不走 PUT /context（那条只收 bible/style/continuity）。
import { NextResponse } from 'next/server';
import {
  Projects, withWriteContext,
  POST_STORYBOARD_JOBS_KEY, readPostStoryboardJobs,
} from '@/lib/core/index.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ post_storyboard_jobs: readPostStoryboardJobs(p) });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const v = body && body.post_storyboard_jobs;
  if (v !== 'none' && v !== 'queue') {
    return NextResponse.json({ error: 'post_storyboard_jobs 只能是 none / queue' }, { status: 400 });
  }
  return withWriteContext('PUT /api/projects/:id/storyboard-settings', () => {
    Projects.setContextKey(id, POST_STORYBOARD_JOBS_KEY, v);
    return NextResponse.json({ post_storyboard_jobs: readPostStoryboardJobs(Projects.get(id)) });
  });
}
