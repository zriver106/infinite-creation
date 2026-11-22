// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, logSubmitRequest } from '@/lib/core/index.js';
import { startChapterVideoJob, submitStoryboardJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 本章重新生成（提交即入全局队列、立即开跑，逐个执行）：
// - videos（默认）：generate_chapter_videos force=true 覆盖本章全部视频，不预先清空分镜/视频；
//   排队中被取消不动数据，执行中取消单镜也会恢复为 done —— 不毁掉已完成结果。
// - full：重新拆分分镜（清空本章分镜）。清空动作延迟到任务真正拿到槽位、开始执行前才做：
//   排队中被取消则一行数据都不动。
//   full 只跑 LLM 文本（renderDisabled=true）：重新拆分镜、写提示词，不提交 ComfyUI、不出图/视频；
//   要出视频请用 mode=videos（或「生成/继续」整条流水线）。
//   full 的提交统一走 submitStoryboardJob（lib/agent/auto-chain.js）：章节卡片「生成分镜」、
//   生成操作里的「重新生成分镜」、自动生成下一章分镜都是这一个入口；同一章已有任务时回 409。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'videos';
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  if (mode === 'videos') {
    const job = startChapterVideoJob({ projectId: id, chapter: ch.title, onProgress: (patch) => broadcast(patch) });
    logSubmitRequest(req, { route: 'POST /api/projects/:id/chapters/:cid/regenerate', projectId: id, chapter: ch.title, jobId: job && job.id });
    return NextResponse.json({ reset: 0, chapter: ch.title, mode, job });
  }
  let r;
  try {
    r = submitStoryboardJob({ projectId: id, chapter: ch, onProgress: (patch) => broadcast(patch) });
  } catch (e) {
    // 项目关闭自动生成剧本且本章剧本为空：重新拆分镜会被前置检查拦下，翻成 400 而不是 500
    if (e && e.code === 'SCRIPT_REQUIRED') return NextResponse.json({ error: '本章还没有剧本，且项目未开启自动生成剧本；请先在章节「剧本」里编写/粘贴，或在项目设置中开启自动生成。' }, { status: 400 });
    // 同一章已有运行中/排队中的任务：不再叠一个（原路由缺这道检查，同一章可被重复提交）
    if (e && e.code === 'CHAPTER_BUSY') return NextResponse.json({ error: e.message, job: e.job }, { status: 409 });
    // 资产齐全检查 A 闸（等补齐再做分镜）：有缺件不建任务
    if (e && e.code === 'ASSETS_MISSING') return NextResponse.json({ error: e.message, code: e.code, gapList: e.gapList || '', missing: e.missing || 0 }, { status: 409 });
    throw e;
  }
  logSubmitRequest(req, { route: 'POST /api/projects/:id/chapters/:cid/regenerate', projectId: id, chapter: ch.title, jobId: r.job && r.job.id });
  return NextResponse.json({ reset: r.reset, chapter: ch.title, mode, job: r.job });
}
