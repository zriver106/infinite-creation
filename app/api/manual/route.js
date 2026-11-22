import { NextResponse } from 'next/server';
import { listManual, createCategory, ManualError } from '@/lib/core/manual.js';

export const dynamic = 'force-dynamic';

const fail = (e) => NextResponse.json({ error: e.message, ...(e.extra || {}) }, { status: e instanceof ManualError ? e.status : 500 });

// 手册目录：分类 + 文档清单
export async function GET() {
  try {
    return NextResponse.json(listManual());
  } catch (e) {
    return fail(e);
  }
}

// 新增分类 { title, dir?, desc? }
export async function POST(req) {
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json(createCategory(b.title, b.dir, b.desc));
  } catch (e) {
    return fail(e);
  }
}