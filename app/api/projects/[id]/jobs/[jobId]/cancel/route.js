// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Jobs, loadConfig, interruptTask } from '@/lib/core/index.js';
import { dispatchCancel } from '@/lib/agent/index.js';
import { releaseAdoptedJob } from '@/lib/agent/recovery-adopt.js';

export const dynamic = 'force-dynamic';

// 取消单个任务：排队中的立即出队中止；执行中的打停止标记（工具/ComfyUI 收到后中断）。
// 取消不会破坏已完成结果——已 done 的分镜/资产保持原状（见 tools.js 的恢复逻辑）。
// 可取消的任务 = 走渲染闸门的任务（界面 CANCELLABLE 同一口径）；行内任务见下。
export async function POST(_req, { params }) {
  const { id, jobId } = await params;
  const job = Jobs.get(jobId);
  if (!job || job.projectId !== id) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  // ic25：接管中（后端重启时外部 Agent 还活着）的任务没有本进程执行者：取消 = 放弃接管、落 cancelled。
  // 不打停止标记、不打断 ComfyUI（那会误伤别的渲染）、不杀外部进程。
  if (job.status === 'adopted') {
    const r = releaseAdoptedJob(job, { reason: '取消：放弃接管', source: 'cancel' });
    return NextResponse.json({ ok: true, id: jobId, adopted: true, settled: r.action === 'cancelled' ? 'cancelled' : null, note: '外部 Agent 进程没有被终止' });
  }
  // 策略与副作用（软停止 / 409 / 出队 / 硬停止标记）都在 dispatchCancel 里。
  // 只有真正的行内任务（type=llm / export）才 409。create 的取消 = 软停止（不 stopJob、不 /interrupt）。
  // /stop（停止本章/全部）仍是硬停止，本路由不改变它。
  const result = await dispatchCancel(job);
  if (result.kind === 'reject-inline' || result.kind === 'finished' || result.kind === 'missing') {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  if (result.kind === 'soft-stop') {
    return NextResponse.json({ ok: true, id: jobId, mode: result.mode, note: result.note });
  }
  if (result.kind === 'orphan-queued') {
    return NextResponse.json({ ok: true, id: jobId, orphan: true, settled: result.settled });
  }
  // 只有「硬停」分支能走到这里。下面这行与 v4 相同、未改：
  // running create 软停、queued create 出队、running llm/export 409 都已在上面 return。
  // dispatchCancel / stopJob 本身不调用 interruptTask，也不 fetch /interrupt。
  if (result.shouldInterrupt) {
    try { const cfg = loadConfig(); await interruptTask(cfg); } catch {}
  }
  return NextResponse.json({ ok: true, id: jobId });
}
