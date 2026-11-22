// 交付目录设置（按项目）：projects.context 的 delivery_dir / delivery_enabled 两个键，Projects.setContextKey 单键合并。
// 界面只在「系统设置 - 通用配置」里（带项目选择），项目设置弹窗里不重复放。
// GET 另外带回最近 10 条交付记录（logs/delivery.jsonl），给界面显示「交付失败」。
import { NextResponse } from 'next/server';
import path from 'node:path';
import {
  Projects, withWriteContext, readDeliverySettings, readDeliveryLog,
  DELIVERY_DIR_KEY, DELIVERY_ENABLED_KEY,
} from '@/lib/core/index.js';
import { validateDeliveryDir } from '@/lib/core/delivery-copy.js';

export const dynamic = 'force-dynamic';

function payload(id) {
  const p = Projects.get(id);
  return { ...readDeliverySettings(p), log: readDeliveryLog(id, 10) };
}

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json(payload(id));
}

// body: { dir?: string（空串 = 清空，不交付）, enabled?: boolean }
export async function PUT(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const writes = [];
  if (body && body.dir !== undefined) {
    if (typeof body.dir !== 'string') return NextResponse.json({ error: 'dir 必须是字符串' }, { status: 400 });
    const raw = body.dir.trim();
    if (raw) {
      const v = validateDeliveryDir(raw);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      writes.push([DELIVERY_DIR_KEY, path.resolve(v.dir)]);
    } else {
      writes.push([DELIVERY_DIR_KEY, '']);
    }
  }
  if (body && body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled 只能是 true / false' }, { status: 400 });
    writes.push([DELIVERY_ENABLED_KEY, body.enabled]);
  }
  if (!writes.length) return NextResponse.json({ error: '缺少 dir 或 enabled' }, { status: 400 });
  return withWriteContext('PUT /api/projects/:id/delivery', () => {
    for (const [k, v] of writes) Projects.setContextKey(id, k, v);
    return NextResponse.json(payload(id));
  });
}
