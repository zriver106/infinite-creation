// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { Shots, Projects, Chapters, Assets, resolveProjectPath, slugify, uid, mergeVideos, resolveSubtitles, deliverChapterExport, chapterMusicForMerge, logSubmitRequest } from '@/lib/core/index.js';
import { runInlineJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';
import { assertAssembleGate, assembleGateReport, assembleGateReportNeeded, assembleGateWarnText, pendingChaptersText, ASSEMBLE_GATE_CODE } from '@/lib/core/dialogue-d-gate.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const chapter = body?.chapter || url.searchParams.get('chapter') || '';
    // 顺序：先章节 seq 再章内 idx（多章合并按全局 idx 会交叉成「第1章第1镜、第2章第1镜…」）
    let done = Shots.listInNarrativeOrder(id).filter((s) => s.video_path && s.status === 'done');
    if (chapter) done = done.filter((s) => s.chapter === chapter);
    // T2 第3批 v6（总导 14:45 第1条、15:00、15:12 裁定，草案）：手动「导出」是 hAssembleVideo 的平行实现，同样要过合成闸，
    // 而且在登记任务、字幕识别、ffmpeg 合并、交付复制之前。口径与 tools.js hAssembleVideo 完全相同（同一个函数）：
    // ①、按章的 ③ 拦下回 409；整片导出时没出完的章整章跳过不拼残片；② 和跳过的章只提醒，导出后写 <成片名>.合成闸提醒.json。
    let gateRes;
    try {
      gateRes = assertAssembleGate(Shots.list(id).filter((s) => !chapter || s.chapter === chapter), done, '导出（export）', { whole: !chapter });
    } catch (ge) {
      if (ge && ge.code === ASSEMBLE_GATE_CODE) return NextResponse.json({ error: ge.message, code: ge.code, blocked: ge.blocked }, { status: 409 });
      throw ge;
    }
    done = gateRes.assemble;
    // v6：闸挪到「没有已完成的镜头」检查之前（整章没出完时按章报 409）；原来的 400 文字不变。
    if (!done.length) return NextResponse.json({ error: chapter ? ('章节「' + chapter + '」没有已完成的镜头') : ('没有已完成的分镜' + (gateRes.pendingChapters.length ? '。' + pendingChaptersText(gateRes.pendingChapters) : '')) }, { status: 400 });
    const inputs = done.map((s) => resolveProjectPath(id, s.video_path)).filter(Boolean);
    const p = Projects.get(id);
    const base = chapter ? slugify(p.name) + '_' + slugify(chapter) : slugify(p.name);
    const outRel = 'exports/' + base + '_' + uid().slice(0, 8) + '.mp4';
    // 背景音乐：仅按章导出时，把该章已生成的 BGM 垫底混入
    let music;
    if (chapter) {
      const ch = Chapters.list(id).find((c) => c.title === chapter || c.id === chapter);
      // 与 hAssembleVideo 同一个函数：没有 cue 表时只认 music_path；有 cue 表时按 cue 切曲 / 撤乐。
      if (ch) music = chapterMusicForMerge(ch, { getAsset: (aid) => Assets.get(aid), resolvePath: (rel) => resolveProjectPath(id, rel), exists: (p) => fs.existsSync(p) });
    }
    // 字幕：项目开启「自动添加字幕」时生成。文本只取镜头 dialogue 字段；
    // whisper 只用于对时，失败必须停下，不得回退 ASR / <d> / narration。
    // 字幕是烧进画面的，无法从成片里再去掉 → 同时单独合一份不带字幕的版本，供下载时二选一。
    const nosubRel = outRel.replace(/(\.[^.]+)$/, '_nosub$1');
    const srtRel = outRel.replace(/\.[^.]+$/, '.srt');
    const gateReportRel = assembleGateReportNeeded(gateRes) ? outRel.replace(/\.[^.]+$/, '.合成闸提醒.json') : '';
    let subtitles = '';
    // 记成一条任务，使其出现在任务列表（识别 + ffmpeg 拼接都可能耗时数分钟）
    logSubmitRequest(req, { route: 'POST /api/projects/:id/export', projectId: id, chapter });
    await runInlineJob(
      { projectId: id, type: 'export', checkpoint: { subject: chapter || '' }, onProgress: (p) => broadcast(p) },
      async (emit) => {
        if (p.enable_subtitles !== false) {
          const r = await resolveSubtitles({
            projectId: id,
            chapter,
            inputs,
            shots: done,
            onProgress: (d) => emit({ phase: '字幕', detail: d }),
          });
          subtitles = r.srt;
          if (!subtitles) {
            emit({ phase: '字幕', detail: 'dialogue 为空，成片不烧录字幕' });
          }
        }
        if (gateRes.pendingChapters.length) emit({ phase: '待补镜', detail: pendingChaptersText(gateRes.pendingChapters) });
        if (gateRes.warnings.length) emit({ phase: '台词门提醒', detail: assembleGateWarnText(gateRes.warnings) });
        emit({ phase: '合并', detail: '合成成片' + (subtitles ? '（烧录字幕）' : '') });
        await mergeVideos(inputs, resolveProjectPath(id, outRel), { music, subtitles });
        if (subtitles) {
          await mergeVideos(inputs, resolveProjectPath(id, nosubRel), { music });
          // 附带一份 SRT 字幕文件：不进成片列表，只作为「下载字幕」按钮的素材
          fs.writeFileSync(resolveProjectPath(id, srtRel), subtitles, 'utf8');
        }
        if (gateReportRel) fs.writeFileSync(resolveProjectPath(id, gateReportRel), JSON.stringify(assembleGateReport({ chapter, exportPath: outRel, warnings: gateRes.warnings, pendingChapters: gateRes.pendingChapters }), null, 1), 'utf8');
      },
    );
    // 交付目录（与 hAssembleVideo 同一个函数）：只在按章导出时、且项目启用了交付才复制；失败只报错不拦
    let delivery = null;
    if (chapter) {
      const d = await deliverChapterExport({ projectId: id, chapterTitle: chapter, exportRel: outRel, source: 'export-route' });
      if (d.status !== 'skipped') {
        delivery = { status: d.status, ep: d.ep, error: d.error || '' };
        if (d.status === 'failed') broadcast({ projectId: id, type: 'export', phase: '交付失败', detail: 'EP' + (d.ep == null ? '?' : d.ep) + '：' + (d.error || '未知错误') });
      }
    }
    return NextResponse.json({ export_path: outRel, url: '/files/projects/' + id + '/' + outRel, shots: done.length, chapter, music: !!music, subtitled: !!subtitles, nosub_path: subtitles ? nosubRel : '', srt_path: subtitles ? srtRel : '', delivery, ...(gateRes.warnings.length ? { dialogue_gate_warnings: gateRes.warnings.map((w) => ({ chapter: w.chapter, idx: w.idx, shot_id: w.shot_id })) } : {}), ...(gateRes.pendingChapters.length ? { pending_chapters: gateRes.pendingChapters.map((p) => ({ chapter: p.chapter, count: p.count, idx: p.shots.map((b) => b.idx) })) } : {}), ...(gateReportRel ? { dialogue_gate_report: gateReportRel } : {}) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
