// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Projects, logSubmitRequest } from '@/lib/core/index.js';
import { startCreateAllJobs, activeJobOfChapter, startSingleChapterRun } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const chapter = body?.chapter ? String(body.chapter) : '';
  const onProgress = (patch) => broadcast(patch);

  // 单章：同一章已有任务就返回原任务，不再重复建（防重复点击/重复扣 LLM）；
  // 其他章节不受影响，可以并行跑。
  // 单章分支抽成 startSingleChapterRun（lib/agent/auto-chain.js），「自动生成下一章」也只调它：同一条路、同一个去重。
  // 行为与原来一致：去重命中返回原任务（deduped:true）；起任务失败复位 idle 回 400。
  if (chapter) {
    try {
      const r = startSingleChapterRun({ projectId: id, chapter, onProgress });
      const job = r.job;
      logSubmitRequest(req, { route: 'POST /api/projects/:id/run', projectId: id, chapter, jobId: job && job.id });
      return NextResponse.json([r.deduped ? { ...job, deduped: true } : job]);
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  // 全部章节：跳过已经在跑的章节，只启动剩下的；全部都在跑时才拒绝。
  const chapters = Chapters.list(id);
  if (!chapters.length) return NextResponse.json({ error: '项目还没有章节' }, { status: 400 });
  const targets = chapters.filter((c) => !activeJobOfChapter(id, c.title));
  if (!targets.length) return NextResponse.json({ error: '所有章节都已有任务在运行' }, { status: 409 });
  Projects.update(id, { status: 'running' });
  try {
    const jobs = startCreateAllJobs({ projectId: id, chapters: targets.map((c) => c.title), onProgress });
    logSubmitRequest(req, {
      route: 'POST /api/projects/:id/run',
      projectId: id,
      chapter: '',
      jobIds: (jobs || []).map((j) => j && j.id).filter(Boolean),
    });
    return NextResponse.json(jobs);
  } catch (e) {
    // 起任务失败（如项目已被删）：复位项目运行态再回 400，而不是留下一个永远「运行中」的项目。
    Projects.update(id, { status: 'idle' });
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
