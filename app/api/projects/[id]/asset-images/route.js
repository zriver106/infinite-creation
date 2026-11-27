// 资产出图（总导 11-26：Andy「制作资产也是要走 ic 工作流」）：派 am、收图、审图、写回 / 退回都在 IC 里。
// GET  → 状态（各资产当前格、轮次、状态；线程）
// POST { action: 'plan' }                      → 要（重）出图的行：没图的、或缺图单行在图之后改过的（纯读，列给总导确认）
// POST { action: 'threads', threads: [...] }   → 设 am 线程表 [{ name, session, lane: person|scene|prop }]（项目设置；线程数 = 表长）
// POST { action: 'start', allow?: [asset_id] } → 开始（allow 给了就只派这些）
// POST { action: 'pause' }                     → 暂停派新单（在途的照常收图、审图）
// POST { action: 'tick' }                      → 立刻走一拍（平时每分钟自动一拍）
// POST { action: 'rereview', asset_ids? | scope: imported|all, on_fail: needs_human|return } → 重审已写回的图：过了不动，不过标需人工或按原线程退回那一格
// POST { action: 'approve', asset_id, reason, step? } → 人工审过：停住的这一格人工判过（记人工审核记录），接着下一格 / 拼板 / 写回
// POST { action: 'set_d', ..., from_version }   → D 取本张旧版本（只改局部重出时）
// POST { action: 'return', asset_id, note, step? } → 人工退回：在原线程出 rN+1（step 是 A/B/C/D 或空）
// POST { action: 'set_d', asset_id, from_asset_id } → 人工指定 D：取同地点那张已定稿 _MV 的 D 格，A/B/C 都审过就拼板写回
// POST { action: 'revoke', asset_id, reason }  → 撤图：恢复上一版（没有就清空），这一行标需人工
// POST { action: 'broadcast', text }           → 口径变了，给每个线程发一句「之前的 X 作废，以本条为准」
import { NextResponse } from 'next/server';
import { Projects, withWriteContext } from '@/lib/core/index.js';
import { loadWork, staleRows, threadsOf, rowsWithStatus, THREADS_KEY } from '@/lib/core/asset-image-work.js';
import { getLocations } from '@/lib/core/locations.js';
import { setRunning, ensureLoop, tick, summary, broadcast, revokeImage, setManualD, manualReturn, manualApprove, reReview } from '@/lib/agent/asset-image.js';

export const dynamic = 'force-dynamic';
const LANES = ['person', 'scene', 'prop'];

export async function GET(_req, { params }) {
  const { id } = await params;
  if (!Projects.get(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  ensureLoop(id);
  const w = loadWork(id);
  const items = Object.entries(w.items || {}).map(([aid, it]) => ({ asset_id: aid, name: it.name, lane: it.lane, thread: it.thread, step: it.step, round: it.round, status: it.status, note: it.note || '', approved: Object.keys(it.approved || {}), review_job: it.review_job || '' }));
  // 资产分析的存疑（没定的）也给界面显示（总导 11-26）
  const doubts = (getLocations(id).doubts || []).filter((d) => d && !String(d.decided || '').trim());
  return NextResponse.json({ ...summary(w), threads_config: threadsOf(id), items, rows: rowsWithStatus(id, w), doubts });
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
  if (action === 'rereview') {
    try { const r = await reReview(id, { asset_ids: Array.isArray(body.asset_ids) ? body.asset_ids : null, scope: String(body.scope || ''), on_fail: String(body.on_fail || 'needs_human') }); ensureLoop(id); return NextResponse.json(r); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (action === 'approve') {
    try { return NextResponse.json(manualApprove(id, String(body.asset_id || ''), { reason: String(body.reason || ''), step: String(body.step || '') })); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (action === 'return') {
    try { return NextResponse.json(await manualReturn(id, String(body.asset_id || ''), { note: String(body.note || ''), step: String(body.step || '') })); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (action === 'set_d') {
    try { return NextResponse.json(setManualD(id, String(body.asset_id || ''), String(body.from_asset_id || ''), undefined, { fromVersion: String(body.from_version || '') })); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (action === 'revoke') {
    const aid = String(body.asset_id || '');
    if (!aid) return NextResponse.json({ error: 'revoke 要给 asset_id' }, { status: 400 });
    try { return NextResponse.json(revokeImage(id, aid, String(body.reason || ''))); } catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  }
  if (action === 'broadcast') {
    const text = String(body.text || '').trim();
    if (!text) return NextResponse.json({ error: 'broadcast 要给 text（例：之前的「国漫」段作废，以本条为准）' }, { status: 400 });
    return NextResponse.json({ sent: await broadcast(id, text) });
  }
  return NextResponse.json({ error: 'action 只能是 plan / threads / start / pause / tick / broadcast / revoke / set_d / return / approve / rereview' }, { status: 400 });
}
