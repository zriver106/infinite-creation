// 交付选用版本：body { name }（组里任意一条）→ 把该组当前「选用」的那条复制成 <交付目录>\EP<N>.mp4。
// 复用 deliverChapterExport（同一套归档 + sha256 校验 + delivery.jsonl 日志），不另写复制逻辑。
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects, projectDir, deliverChapterExport } from '@/lib/core/index.js';
import { readVersions, rootOf, selectedOf, chapterTitleFromExportName } from '@/lib/core/upscale2k.js';

export const dynamic = 'force-dynamic';
const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '');
  if (!name || path.basename(name) !== name || !VIDEO_RE.test(name)) return NextResponse.json({ error: '非法文件名' }, { status: 400 });
  const dir = path.join(projectDir(id), 'exports');
  const existing = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  if (!existing.has(name)) return NextResponse.json({ error: '成片不存在：' + name }, { status: 404 });
  const v = readVersions(id);
  const root = rootOf(v, name);
  const chosen = selectedOf(v, root, existing);
  const chapterTitle = chapterTitleFromExportName(root) || chapterTitleFromExportName(chosen);
  if (!chapterTitle) return NextResponse.json({ error: '文件名里找不到「第N章」，无法确定 EP 号' }, { status: 400 });
  const d = await deliverChapterExport({ projectId: id, chapterTitle, exportRel: 'exports/' + chosen, source: 'exports-selected' });
  const status = d.status === 'failed' ? 500 : 200;
  return NextResponse.json({ ...d, delivered: chosen, chapter: chapterTitle }, { status });
}
