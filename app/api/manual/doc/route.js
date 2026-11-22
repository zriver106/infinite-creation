import { NextResponse } from 'next/server';
import { readDoc, saveDoc, createDoc, updateDocMeta, ManualError } from '@/lib/core/manual.js';

export const dynamic = 'force-dynamic';

const fail = (e) => NextResponse.json({ error: e.message, ...(e.extra || {}) }, { status: e instanceof ManualError ? e.status : 500 });

// 读取一篇文档：?cat=<分类id>&file=<文件名>
export async function GET(req) {
  try {
    const u = new URL(req.url);
    return NextResponse.json(readDoc(u.searchParams.get('cat'), u.searchParams.get('file')));
  } catch (e) {
    return fail(e);
  }
}

// 保存正文 { cat, file, content, baseHash }：保存前备份旧文件到 _backup/，baseHash 不一致返回 409
export async function PUT(req) {
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json(saveDoc(b.cat, b.file, b.content, b.baseHash));
  } catch (e) {
    return fail(e);
  }
}

// 新建文档 { cat, title, file? }
export async function POST(req) {
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json(createDoc(b.cat, b.title, b.file));
  } catch (e) {
    return fail(e);
  }
}

// 改标题 / 现行·草案状态 { cat, file, title?, status? }：改 manual.json，改前备份
export async function PATCH(req) {
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json(updateDocMeta(b.cat, b.file, { title: b.title, status: b.status }));
  } catch (e) {
    return fail(e);
  }
}