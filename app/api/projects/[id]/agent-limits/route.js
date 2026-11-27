// 写稿类 Agent 同时运行数（项目设置，总导 11-26）：GET → 各类型上限（含默认值）；PUT { limits: { script, storyboard, prompt, asset, review } }（1–8 的整数）。
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { AGENT_LIMITS_KEY, AGENT_LIMIT_KINDS, agentLimitsOf, normalizeAgentLimits } from '@/lib/core/agent-limits.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  return NextResponse.json({ limits: agentLimitsOf(id), kinds: AGENT_LIMIT_KINDS });
}

export async function PUT(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { limits, bad } = normalizeAgentLimits(body.limits);
  if (bad.length) return NextResponse.json({ error: '这些项不对（类型只能是 ' + Object.keys(AGENT_LIMIT_KINDS).join('/') + '，值 1–8 的整数）：' + bad.join('、') }, { status: 400 });
  return withWriteContext('PUT /api/projects/:id/agent-limits', () => {
    const cur = ((Projects.get(id) || {}).context || {})[AGENT_LIMITS_KEY] || {};
    Projects.setContextKey(id, AGENT_LIMITS_KEY, { ...cur, ...limits });
    return NextResponse.json({ limits: agentLimitsOf(id) });
  });
}
