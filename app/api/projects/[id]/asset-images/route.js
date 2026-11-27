// 资产出图（总导 11-26：Andy「制作资产也是要走 ic 工作流」）：派 am、收图、审图、写回 / 退回都在 IC 里。
// GET  → 状态（各资产当前格、轮次、状态；线程）
// POST { action: 'plan' }                      → 要（重）出图的行：没图的、或缺图单行在图之后改过的（纯读，列给总导确认）
// POST { action: 'threads', threads: [...] }   → 设 am 线程表 [{ name, session, lane: person|scene|prop }]（项目设置；线程数 = 表长）
// POST { action: 'start', allow?: [asset_id] } → 开始（allow 给了就只派这些）
// POST { action: 'pause' }                     → 暂停派新单（在途的照常收图、审图）
// POST { action: 'tick' }                      → 立刻走一拍（平时每分钟自动一拍）
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { loadWork, staleRows, threadsOf, THREADS_KEY } from '@/lib/core/asset-image-work.js';
import { setRunning, ensureLoop, tick, summary } from '@/lib/agent/asset-image.js';

export const dynamic = 'force-dynamic';
const LANES = ['person', 'scene', 'prop'];

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  ensureLoop(id);
  const w = loadWork(id);
  const items = Object.entries(w.items || {}).map(([aid, it]) => ({ asset_id: aid, name: it.name, lane: it.lane, thread: it.thread, step: it.step, round: it.round, status: it.status, note: it.note || '', approved: Object.keys(it.approved || {}), review_job: it.review_job || '' }));
  return NextResponse.json({ ...summary(w), threads_config: threadsOf(id), items });
}

export async function POST(req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  if (action === 'plan') return NextResponse.json({ rows: staleRows(id) });
  if (action === 'threads') {
    const t = Array.isArray(body.threads) ? body.threads : null;
    if (!t || !t.length) return NextResponse.json({ error: 'threads 要给数组 [{name, session, lane}]' }, { status: 400 });
    const bad = t.filter((x) => !x || !String(x.name || '').trim() || !String(x.session || '').trim() || !LANES.includes(x.lane));
    if (bad.length) return NextResponse.json({ error: '每个线程要有 name、session，lane 只能是 ' + LANES.join('/') }, { status: 400 });
    return withWriteContext('POST /api/projects/:id/asset-images threads', () => {
      Projects.setContextKey(id, THREADS_KEY, t.map((x) => ({ name: String(x.name).trim(), session: String(x.session).trim(), lane: x.lane })));
      return NextResponse.json({ threads: threadsOf(id) });
    });
  }
  if (action === 'start') {
    if (!threadsOf(id).length) return NextResponse.json({ error: '还没设 am 线程（action: threads）' }, { status: 400 });
    return NextResponse.json(setRunning(id, true, { allow: Array.isArray(body.allow) ? body.allow : null }));
  }
  if (action === 'pause') return NextResponse.json(setRunning(id, false));
  if (action === 'tick') return NextResponse.json(await tick(id));
  return NextResponse.json({ error: 'action 只能是 plan / threads / start / pause / tick' }, { status: 400 });
}
