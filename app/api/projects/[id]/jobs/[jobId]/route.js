// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, projectDir } from '@/lib/core/index.js';
import { applyDeleteJobPolicy } from '@/lib/agent/index.js';

export const dynamic = 'force-dynamic';

// 删除任务记录。
// - 活动任务（running / queued / adopted）：直接 409「请先取消，等任务结束后再删」。
//   不 stopJob、不打 abortFlags、不 interruptTask、不删记录（软停后再删会让镜头没人收尾）。
// - 最新的、还没被接续的 interrupted 出片任务：409「该任务等待断点续跑，请先在该章点「继续」，续跑开始后再删」。
// - 其余已结束任务（done / failed / cancelled / 已被接续的旧 interrupted / 无章节或非 create 的 interrupted）：只删记录与日志，不删素材/成片。
export async function DELETE(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  const policy = applyDeleteJobPolicy(job);
  if (policy.kind !== 'delete-ok') {
    return NextResponse.json({ error: policy.error }, { status: policy.status });
  }
  // 清掉任务级日志文件
  try { fs.unlinkSync(path.join(projectDir(id), 'logs', jobId + '.log')); } catch {}
  if (job.logPath) { try { fs.unlinkSync(job.logPath); } catch {} }
  Jobs.remove(jobId);
  return NextResponse.json({ ok: true, cancelled: false, id: jobId });
}
