// 系统设置 →「升级2K」：升级方式（火山 / 本地-暂未开放）与火山 MediaKit API Key。
// 单独存 DATA_DIR/upscale2k.json，不进 config.json（/api/config 的 GET 会原样下发 config.json）。
// GET / PUT 都只返回「是否已配置」，任何时候都不把 key 发回浏览器。
import { NextResponse } from 'next/server';
import { publicUpscaleSettings, saveUpscaleSettings } from '@/lib/core/upscale2k.js';

export const dynamic = 'force-dynamic';
const PUBLIC_MODE = process.env.IC_PUBLIC === '1';

export async function GET() {
  return NextResponse.json(publicUpscaleSettings());
}

export async function PUT(req) {
  if (PUBLIC_MODE) return NextResponse.json({ error: '公开模式下不允许通过接口修改配置' }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '请求体为空' }, { status: 400 });
  try {
    return NextResponse.json(saveUpscaleSettings(body));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.status || 500 });
  }
}
