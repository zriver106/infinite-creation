// 项目级「资产齐全检查」设置（2026-11-17 最小版）：存 projects.context 的扁平键，Projects.setContextKey 单键合并写入。
//   asset_mode ：'gap-list'（缺件单模式：IC 只出缺件单、不出图；自动资产任务只管本章音色）| 'auto'（原行为，缺省）
//   asset_gate ：'B'（先做分镜，缺件镜头出片前再拦；缺省）| 'A'（等补齐再做分镜）
//   asset_root ：项目资料根目录（下有 资产\assets.csv、资产\别名表.csv、草稿\IC缺件单\）
// 只改设置，不提交任何任务。
import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { readAssetCheckSettings, ASSET_MODE_KEY, ASSET_GATE_KEY, ASSET_ROOT_KEY, ASSET_BINDING_KEY } from '@/lib/agent/asset-check.js';
import { COSTUME_BASE_KEY, normalizeCostumeBase } from '@/lib/agent/binding-check.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ ...readAssetCheckSettings(p), costume_base: (p.context || {})[COSTUME_BASE_KEY] || [] });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const writes = [];
  if (body.mode !== undefined) {
    if (!['gap-list', 'auto'].includes(body.mode)) return NextResponse.json({ error: 'mode 只能是 gap-list / auto' }, { status: 400 });
    writes.push([ASSET_MODE_KEY, body.mode]);
  }
  // 2026-11-25：项目级资产绑定方式（'ag' = 我方 Agent 绑定 | 'ic' = IC 按名字自动绑定），不设按系统设置。
  if (body.binding !== undefined) {
    if (!['ag', 'ic'].includes(body.binding)) return NextResponse.json({ error: 'binding 只能是 ag / ic' }, { status: 400 });
    writes.push([ASSET_BINDING_KEY, body.binding]);
  }
  if (body.gate !== undefined) {
    if (!['A', 'B'].includes(body.gate)) return NextResponse.json({ error: 'gate 只能是 A / B' }, { status: 400 });
    writes.push([ASSET_GATE_KEY, body.gate]);
  }
  if (body.root !== undefined) {
    const r = String(body.root || '').trim();
    if (r && !fs.existsSync(r)) return NextResponse.json({ error: 'root 目录不存在：' + r }, { status: 400 });
    writes.push([ASSET_ROOT_KEY, r]);
  }
  // 2026-11-25：基础形象豁免段（整份替换），缺绑检查据此不报 B/C。格式见 lib/agent/binding-check.js 文件头。
  if (body.costume_base !== undefined) {
    const { out, errors } = normalizeCostumeBase(body.costume_base);
    if (errors.length) return NextResponse.json({ error: errors.slice(0, 10).join('；') }, { status: 400 });
    writes.push([COSTUME_BASE_KEY, out]);
  }
  if (!writes.length) return NextResponse.json({ error: '没有要保存的项' }, { status: 400 });
  return withWriteContext('PUT /api/projects/:id/asset-settings', () => {
    for (const [k, v] of writes) Projects.setContextKey(id, k, v);
    const np = Projects.get(id);
    return NextResponse.json({ ...readAssetCheckSettings(np), costume_base: (np.context || {})[COSTUME_BASE_KEY] || [] });
  });
}
