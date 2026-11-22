// 「自动生成下一章」「自动生成下一章分镜」两个开关 + 各自的「到第 __ 章为止」（默认 13）。
// 存 projects.context 的 auto_next / auto_next_until / auto_next_storyboard / auto_next_storyboard_until，
// 走 Projects.setContextKey 单键合并；不走 PUT /context（那条只收 bible/style/continuity 且会落盘 context/*.md）。
// 只改设置，不提交任何任务：续章只发生在任务成功收尾时（lib/agent/auto-chain.js）。
import { NextResponse } from 'next/server';
import {
  Projects, withWriteContext, readAutoNextSettings, parseUntilInput,
  AUTO_NEXT_KEY, AUTO_NEXT_UNTIL_KEY, AUTO_NEXT_STORYBOARD_KEY, AUTO_NEXT_STORYBOARD_UNTIL_KEY,
} from '@/lib/core/index.js';
import { guardianStatus } from '@/lib/agent/chapter-guardian.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // guardian：出片守护 / 分镜守护的最近一次检查结果（界面「运行状态」两行显示）
  return NextResponse.json({ ...readAutoNextSettings(p), guardian: guardianStatus(id) });
}

// body: { video?: { enabled?, until? }, storyboard?: { enabled?, until? } }
export async function PUT(req, { params }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const p = Projects.get(id);
  if (!p) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const writes = [];
  const take = (part, enabledKey, untilKey, label) => {
    if (!part || typeof part !== 'object') return '';
    if (part.enabled !== undefined) {
      if (typeof part.enabled !== 'boolean') return label + '：enabled 只能是 true / false';
      writes.push([enabledKey, part.enabled]);
    }
    if (part.until !== undefined) {
      const n = parseUntilInput(part.until);
      if (n == null) return label + '：「到第 __ 章为止」必须是 ≥1 的整数';
      writes.push([untilKey, n]);
    }
    return '';
  };
  const err = take(body && body.video, AUTO_NEXT_KEY, AUTO_NEXT_UNTIL_KEY, '自动生成下一章')
    || take(body && body.storyboard, AUTO_NEXT_STORYBOARD_KEY, AUTO_NEXT_STORYBOARD_UNTIL_KEY, '自动生成下一章分镜');
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  if (!writes.length) return NextResponse.json({ error: '没有要保存的项' }, { status: 400 });
  return withWriteContext('PUT /api/projects/:id/auto-next', () => {
    for (const [k, v] of writes) Projects.setContextKey(id, k, v);
    return NextResponse.json(readAutoNextSettings(Projects.get(id)));
  });
}
