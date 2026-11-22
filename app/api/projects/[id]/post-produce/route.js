// 成片后期（ic32）：GET 设置 + 本章检查 + 最近报告；PUT 存设置；POST 起一条后期任务。
// 设置存 projects.context.post_settings（Projects.setContextKey 单键写入，界面键，不进 Agent 上下文）。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import {
  Projects, Shots, Chapters, Assets, projectDir, withWriteContext, logSubmitRequest,
  readPostSettings, normalizePostOptions, previewPostPlan, POST_DEFAULTS, POST_SETTINGS_KEY,
} from '@/lib/core/index.js';
import { startChapterPostJob } from '@/lib/agent/index.js';
import { broadcast } from '@/lib/ws.js';

export const dynamic = 'force-dynamic';

function recentReports(id, limit = 10) {
  const dir = path.join(projectDir(id), 'post');
  let out = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, 'report.json');
      if (!fs.existsSync(f)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.push({
          name: path.basename(r.export_path || ''), chapter: r.chapter, created_at: r.created_at, tts_mock: !!r.tts_mock,
          total_before: r.total_before, total_after: r.total_after, removed_sec: r.removed_sec,
          mute_windows: (r.mute_windows || []).length, dubs: (r.dubs || []).length, gaps_cut: (r.gaps_cut || []).length,
          subtitle_cues: r.subtitle_cues, bgm: !!r.bgm, issues: r.issues || [],
        });
      } catch { /* 跳过坏报告 */ }
    }
  } catch { /* 还没有 post 目录 */ }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out.slice(0, limit);
}

export async function GET(req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const url = new URL(req.url);
  const chapter = url.searchParams.get('chapter') || '';
  let check = null;
  if (chapter) {
    const ch = Chapters.list(id).find((c) => c.title === chapter || c.id === chapter);
    if (ch) {
      const shots = Shots.listInNarrativeOrder(id).filter((s) => s.chapter === ch.title && s.video_path && s.status === 'done');
      check = { chapter: ch.title, music: !!(ch.music_path || ch.music_prompt), ...previewPostPlan(shots, Assets.list(id)) };
    }
  }
  // 只列有已完成镜头的章节（大项目有几百章）；缺省选最近一次后期的章，其次第一个「第N章」
  const doneBy = new Map();
  for (const s of Shots.listInNarrativeOrder(id)) if (s.video_path && s.status === 'done') doneBy.set(s.chapter, (doneBy.get(s.chapter) || 0) + 1);
  const chapters = Chapters.list(id).filter((c) => doneBy.has(c.title)).map((c) => ({ title: c.title, done: doneBy.get(c.title) }));
  const reports = recentReports(id);
  const suggested = (reports[0] && chapters.some((c) => c.title === reports[0].chapter) ? reports[0].chapter : '')
    || (chapters.find((c) => /^第\s*[1-9][0-9]*\s*章$/.test(c.title)) || chapters[0] || {}).title || '';
  return NextResponse.json({ settings: readPostSettings(p), defaults: POST_DEFAULTS, chapters, suggested, check, reports });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body.settings !== 'object') return NextResponse.json({ error: '缺少 settings' }, { status: 400 });
  const settings = normalizePostOptions(body.settings);
  return withWriteContext('PUT /api/projects/:id/post-produce', () => {
    Projects.setContextKey(id, POST_SETTINGS_KEY, settings);
    return NextResponse.json({ settings });
  });
}

// body: { chapter, options? }（options 只作用本次，不改项目设置）
export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const chapter = String(body?.chapter || '').trim();
  if (!chapter) return NextResponse.json({ error: '请选择章节' }, { status: 400 });
  const ch = Chapters.list(id).find((c) => c.title === chapter || c.id === chapter);
  if (!ch) return NextResponse.json({ error: '章节不存在：' + chapter }, { status: 404 });
  const done = Shots.listInNarrativeOrder(id).filter((s) => s.chapter === ch.title && s.video_path && s.status === 'done');
  if (!done.length) return NextResponse.json({ error: '章节「' + ch.title + '」没有已完成的镜头' }, { status: 400 });
  logSubmitRequest(req, { route: 'POST /api/projects/:id/post-produce', projectId: id, chapter: ch.title });
  const options = body?.options && typeof body.options === 'object' ? normalizePostOptions({ ...readPostSettings(Projects.get(id)), ...body.options }) : undefined;
  const job = startChapterPostJob({ projectId: id, chapter: ch.title, options, onProgress: (p) => broadcast(p) });
  return NextResponse.json({ ...job, chapter: ch.title, shots: done.length });
}
