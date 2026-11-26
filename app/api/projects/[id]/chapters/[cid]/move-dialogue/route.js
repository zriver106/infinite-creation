// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import { Chapters, Shots, withWriteContext, currentBatchId, txImmediate, projectDir, logger } from '@/lib/core/index.js';
import { appendProjectJsonl } from '@/lib/core/rule-book.js';
import { planDialogueMove, MOVE_DIALOGUE_SOURCE } from '@/lib/core/dialogue-move.js';
import { activeJobOfChapter, submitPromptWriteJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

// 跨镜挪台词（2026-11-26 Andy「心声太迟了，提前一些即可」；主会话 seq2130/seq2133）。
// body: { moves: [{ from: shot_id, to: shot_id, text: "原句（一字不改，含标点）", position?: 'start'|'end' }],
//         rewrite?: 'video_prompt'（缺省）|'visual'|'none', dry_run?: true }
// 规则：只许相邻镜；只动点名的镜；text 必须是 from 台词里同一行完整的一句或几句；整章「说话人+句子」集合不变；
//       镜在生成/排队/作废、或本章有任务在跑/排队 → 拒绝。position 缺省：挪到前一镜放末尾，挪到后一镜放开头。
// 落库：只改 dialogue，一个批次（change_logs source = MOVE_DIALOGUE_SOURCE，可整批回滚）；
//       prompt_history.jsonl 记 action=move_dialogue（旧/新台词、挪的句子、批次号）。
// 挪完缺省交 IC 指定镜重写这几镜的 video_prompt（requirements 写明挪了哪句）；rewrite='none' 只挪不交。
export async function POST(req, { params }) {
  const { id, cid } = await params;
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return NextResponse.json({ error: '章节不存在' }, { status: 404 });
  let body = {};
  try { const t = await req.text(); body = t && t.trim() ? JSON.parse(t) : {}; } catch { return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 }); }
  const rewrite = body.rewrite == null || body.rewrite === '' ? 'video_prompt' : String(body.rewrite);
  if (!['video_prompt', 'visual', 'none'].includes(rewrite)) return NextResponse.json({ error: 'rewrite 只能是 video_prompt / visual / none', code: 'BAD_REWRITE' }, { status: 400 });
  const busy = activeJobOfChapter(id, ch.title);
  if (busy) return NextResponse.json({ error: '「' + ch.title + '」已有任务在跑或排队，请等它结束再挪台词', code: 'CHAPTER_BUSY', job: busy.id }, { status: 409 });

  const shots = Shots.list(id).filter((s) => s.chapter === ch.title);
  const plan = planDialogueMove(shots, body.moves);
  if (!plan.ok) return NextResponse.json({ error: plan.errors.join('；'), code: 'BAD_MOVE' }, { status: 400 });
  const preview = plan.touched.map((sid) => { const s = shots.find((x) => String(x.id) === sid); return { shot_id: sid, idx: s.idx, before: plan.updates[sid].before, after: plan.updates[sid].after }; });
  if (body.dry_run) return NextResponse.json({ dry_run: true, chapter: ch.title, moved: plan.moved, shots: preview });

  let batchId = '';
  try {
    await withWriteContext(MOVE_DIALOGUE_SOURCE, async () => {
      batchId = currentBatchId();
      txImmediate(() => {
        // 事务里再核一次：读到的台词和计划时一致才写（防并发改）
        for (const sid of plan.touched) {
          const now = Shots.get(sid);
          if (String(now?.dialogue || '') !== plan.updates[sid].before) throw Object.assign(new Error('第' + now?.idx + '镜台词刚被别处改过，未写入，请重试'), { code: 'CONFLICT' });
        }
        for (const sid of plan.touched) Shots.update(sid, { dialogue: plan.updates[sid].after });
      });
    });
  } catch (e) {
    if (e && e.code === 'CONFLICT') return NextResponse.json({ error: e.message, code: 'CONFLICT' }, { status: 409 });
    throw e;
  }
  const dir = projectDir(id);
  for (const p of preview) {
    appendProjectJsonl(dir, 'prompt_history.jsonl', { ts: Date.now(), job_id: '', batch_id: batchId, shot_id: p.shot_id, chapter: ch.title, idx: p.idx, action: 'move_dialogue', dialogue: p.before, new_dialogue: p.after, moves: plan.moved.filter((m) => m.from === p.shot_id || m.to === p.shot_id) });
  }

  let job = null; let rewriteError = null;
  if (rewrite !== 'none') {
    const requirements = {};
    for (const p of preview) {
      const out = plan.moved.filter((m) => m.from === p.shot_id).map((m) => '「' + m.text + '」挪到了第' + m.toIdx + '镜');
      const inn = plan.moved.filter((m) => m.to === p.shot_id).map((m) => '从第' + m.fromIdx + '镜挪来「' + m.text + '」（放在本镜台词' + (m.position === 'end' ? '末尾' : '开头') + '）');
      requirements[p.shot_id] = '本镜台词已跨镜调整（原句一字未改）：' + [...inn, ...out].join('；') + '。按当前台词栏重写；画面说明 / 分镜细节里旧的台词时段以台词栏为准，时长不够放下新台词时按规则处理。';
    }
    try {
      const r = submitPromptWriteJob({ projectId: id, chapter: ch, onProgress: (patch) => broadcast(patch), shotIds: plan.touched, requirements, target: rewrite });
      job = r.job;
    } catch (e) {
      rewriteError = { code: e?.code || '', error: e?.message || String(e) };
      logger.warn('move-dialogue: 交 IC 重写失败（台词已挪）', { projectId: id, chapter: ch.title, error: rewriteError.error });
    }
  }
  return NextResponse.json({ chapter: ch.title, batch_id: batchId, moved: plan.moved, shots: preview, rewrite, job: job ? job.id : null, ...(rewriteError ? { rewrite_error: rewriteError } : {}) });
}
