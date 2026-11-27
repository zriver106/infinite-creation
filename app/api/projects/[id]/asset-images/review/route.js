// 资产出图：某资产各轮的审图结论（界面点开看逐件对照表和退回意见）。GET ?asset_id=
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { Projects } from '@/lib/core/index.js';
import { roundsDir, loadWork } from '@/lib/core/asset-image-work.js';

export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const aid = new URL(req.url).searchParams.get('asset_id') || '';
  if (!/^[\w-]{8,}$/.test(aid)) return NextResponse.json({ error: '缺 asset_id' }, { status: 400 });
  const dir = roundsDir(id, aid);
  const reviews = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^review_.+\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0))
    : [];
  const it = (loadWork(id).items || {})[aid] || null;
  return NextResponse.json({ asset_id: aid, item: it ? { status: it.status, step: it.step, round: it.round, note: it.note || '', history: it.history || [] } : null, reviews });
}
