// 从参考项目导入音色（Andy 11-26「音色优先拿 v2 的来用」）。
// POST {}                                       → 本项目没音色的人物，逐个按同名找现成音色导入（本项目已归档的旧人物 → 登记过的参考项目）
// POST { asset_id, from_asset_id?, overwrite? } → 给一个人物导入（可指定来源人物；overwrite=true 覆盖已有音色）
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { importVoice, importMissingVoices } from '@/lib/core/voice-import.js';

export const dynamic = 'force-dynamic';

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  return withWriteContext('POST /api/projects/:id/voices/import', () => {
    try {
      if (body.asset_id) return NextResponse.json({ results: [importVoice(id, String(body.asset_id), { fromAssetId: String(body.from_asset_id || ''), overwrite: body.overwrite === true })] });
      return NextResponse.json({ results: importMissingVoices(id) });
    } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  });
}
