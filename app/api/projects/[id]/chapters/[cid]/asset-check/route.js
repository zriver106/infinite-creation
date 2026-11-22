// 本章资产齐全检查（2026-11-17 最小版）。
//   GET  ：读最近一次结果；?fresh=1 当场重算（只读：不登记、不写文件、不改状态）
//   POST ：重算 + 自动登记同名唯一音色（官方 register_voice）+ 写缺件单（内容没变不重写）+ 记状态。
//          不提交任何任务、不出图、不造音色；只回报「本章允许 IC 生成音色的角色」（voice_plan）供核对。
import { NextResponse } from 'next/server';
import { Chapters, Projects, withWriteContext } from '@/lib/core/index.js';
import { checkChapterAssets, runAssetCheck, chapterAssetStatus, readAssetCheckSettings } from '@/lib/agent/asset-check.js';

export const dynamic = 'force-dynamic';

const brief = (r, gap) => ({
  state: r.state, phase: r.phase, mode: r.mode, gate: r.gate, generated_at: r.generated_at,
  summary: r.summary, missing: r.missing, review: r.review, linkable: r.linkable, voice_plan: r.voice_plan,
  group_roles: r.group_roles, registered: r.registered || [], inputs: r.inputs,
  gapFile: gap ? gap.file : '', gapMd: gap ? gap.md : '', gapReused: gap ? !!gap.reused : false,
});

function load(id, cid) {
  const p = Projects.get(id);
  if (!p) return { err: NextResponse.json({ error: '项目不存在' }, { status: 404 }) };
  const ch = Chapters.get(cid);
  if (!ch || ch.project_id !== id) return { err: NextResponse.json({ error: '章节不存在' }, { status: 404 }) };
  return { p, ch };
}

export async function GET(req, { params }) {
  const { id, cid } = await params;
  const { p, ch, err } = load(id, cid);
  if (err) return err;
  const settings = readAssetCheckSettings(p);
  const last = chapterAssetStatus(id, ch.id);
  const fresh = new URL(req.url).searchParams.get('fresh') === '1';
  if (!fresh) return NextResponse.json({ chapter: ch.title, settings, last: last || { state: 'unchecked' } });
  try {
    const r = checkChapterAssets(id, ch.id, { trigger: 'preview', settings });
    return NextResponse.json({ chapter: ch.title, settings, last: last || { state: 'unchecked' }, preview: brief(r, null) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function POST(_req, { params }) {
  const { id, cid } = await params;
  const { ch, err } = load(id, cid);
  if (err) return err;
  try {
    const { report, gap } = await withWriteContext('POST /api/projects/:id/chapters/:cid/asset-check', () => runAssetCheck(id, ch.id, { trigger: 'manual' }));
    return NextResponse.json({ chapter: ch.title, ...brief(report, gap) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
