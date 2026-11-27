// 资产出图面板（Andy 11-26：「用 ic 工作流，以后用户在 ic 工作流点按钮他就会根据规则生产我们要的图片」）。
// 按缺图单出图（全部 / 勾选几行）、暂停；每行出图状态、轮次、审图结论（点开看逐件对照表和退回意见）；卡住、需人工显眼；资产分析存疑。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ImagePlay, Pause, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Checkbox } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

const STATUS = {
  idle: ['未派', 'neutral'],
  queued: ['排队', 'info'],
  sent: ['出图中', 'accent'],
  unconfirmed: ['待对账（发送未确认）', 'danger'],
  stale_warn: ['核查中（10 分钟没回图）', 'danger'],
  stale: ['待对账（20 分钟没回图）', 'danger'],
  reviewing: ['待审', 'accent'],
  next_step: ['下一格排队', 'info'],
  review_failed: ['审图没交结论', 'danger'],
  needs_human: ['需人工', 'danger'],
  return_queued: ['排队退回（重审没过）', 'info'],
  passed: ['已通过', 'success'],
};
const ALERT = new Set(['unconfirmed', 'stale_warn', 'stale', 'review_failed', 'needs_human']);
const KIND = { scene: '场景', character: '人物', costume: '服装', prop: '道具', age: '年龄' };
const CHECK_LABEL = { same_space: '同一空间', style_vs_sample: '画风对比样张', ethnicity: '人种长相', base_image: '对照底图', count_orientation: '数量和朝向', no_text: '不带文字' };

function statusOf(r) {
  const [text, tone] = STATUS[r.status] || [r.status, 'neutral'];
  const extra = r.status === 'sent' && r.round > 1 ? '（退回 r' + r.round + '）' : '';
  return { text: text + extra, tone };
}

export default function AssetImagePanel({ projectId, canGenerate = true }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState(null);
  const [onlyOpen, setOnlyOpen] = useState(false);

  const load = useCallback(() => api.get('/api/projects/' + projectId + '/asset-images').then(setData).catch(() => {}), [projectId]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const rows = useMemo(() => (data?.rows || []).filter((r) => !onlyOpen || r.status !== 'passed'), [data, onlyOpen]);
  const alerts = (data?.rows || []).filter((r) => ALERT.has(r.status));

  async function post(body, msg) {
    setBusy(body.action);
    try { await api.post('/api/projects/' + projectId + '/asset-images', body); if (msg) toast.success(msg); await load(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  }
  const startAll = () => post({ action: 'start', allow: [] }, '已开始：按缺图单出图（全部）');
  const startSel = () => post({ action: 'start', allow: [...sel] }, '已开始：只出选中的 ' + sel.size + ' 行');
  const pause = () => post({ action: 'pause' }, '已暂停派新单（在途的照常收图、审图）');
  const openDetail = async (r) => {
    try { setDetail({ row: r, ...(await api.get('/api/projects/' + projectId + '/asset-images/review?asset_id=' + r.asset_id)) }); }
    catch (e) { toast.error(e.message); }
  };
  // 人工指定 D（总导 11-26）：_MV 行的 D 直接取同地点某张已定稿 _MV 的 D 格
  const dSources = (r) => (data?.rows || []).filter((x) => x.asset_id !== r.asset_id && /_MV/.test(x.name) && x.location_id && x.location_id === r.location_id && x.has_image);
  const setD = async (r, from) => {
    if (!from) return;
    setBusy('set_d');
    const body = from.startsWith('v:') ? { action: 'set_d', asset_id: r.asset_id, from_version: from.slice(2) } : { action: 'set_d', asset_id: r.asset_id, from_asset_id: from };
    try { const x = await api.post('/api/projects/' + projectId + '/asset-images', body); toast.success(x.composed ? '已用指定的 D 拼板写回' : '已指定 D，等 A/B/C 审过后拼板'); await load(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };
  // 人工退回（缺口第 18 条）：每行、每格填退回意见，按原线程出 rN+1
  const [ret, setRet] = useState(null);
  const doReturn = async () => {
    if (!ret || !ret.note.trim()) return;
    setBusy('return');
    try { const x = await api.post('/api/projects/' + projectId + '/asset-images', { action: 'return', asset_id: ret.row.asset_id, note: ret.note, step: ret.step }); toast.success('已退回：' + (x.step !== 'main' ? x.step + ' 格 ' : '') + 'r' + x.round); setRet(null); await load(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };
  // 人工审过（缺口第 21 条）：停住的这一格人工判过，写一句理由，接着往下走
  const [apv, setApv] = useState(null);
  const doApprove = async () => {
    if (!apv || !apv.reason.trim()) return;
    setBusy('approve');
    try { const x = await api.post('/api/projects/' + projectId + '/asset-images', { action: 'approve', asset_id: apv.row.asset_id, reason: apv.reason }); toast.success(x.next === 'next_step' ? '已人工审过，排下一格' : x.next === 'compose_review' ? '已人工审过，拼板核对中' : '已人工审过并写回'); setApv(null); await load(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };
  // 重审（总导 11-26）：用现在的审图 Agent 和必核项重审已写回的图；单行 / 选中的 / 手工线导入的全部 / 已写回的全部；不过时标需人工或按原线程退回
  const [rr, setRr] = useState(null);
  const written = (data?.rows || []).filter((x) => x.has_image);
  const doRereview = async () => {
    if (!rr) return;
    const body = { action: 'rereview', on_fail: rr.ret ? 'return' : 'needs_human' };
    if (rr.ids) body.asset_ids = rr.ids; else if (rr.scope === 'sel') body.asset_ids = [...sel]; else body.scope = rr.scope;
    setBusy('rereview');
    try { const x = await api.post('/api/projects/' + projectId + '/asset-images', body); toast.success('已进重审 ' + x.queued.length + ' 张' + (x.skipped.length ? '，跳过 ' + x.skipped.length + ' 张（' + x.skipped.slice(0, 3).map((k) => k.name + '：' + k.why).join('；') + '）' : '')); setRr(null); await load(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(''); }
  };
  const toggle = (id, v) => setSel((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });

  if (!data) return null;
  const noThreads = !(data.threads_config || []).length;
  return (
    <section className="panel flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[13px] font-medium text-[var(--fg)]">资产出图（按缺图单派 am、IC 审图入库）</h2>
        <Badge tone={data.running ? 'accent' : 'neutral'} dot={data.running}>{data.running ? '运行中' : '已暂停'}</Badge>
        {alerts.length ? <Badge tone="danger"><AlertTriangle size={11} /> {alerts.length} 行要人看</Badge> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Checkbox checked={onlyOpen} onChange={setOnlyOpen} label="只看没通过的" />
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw size={12} /></Button>
          {canGenerate ? (
            <>
              <Button variant="secondary" size="sm" disabled={!sel.size || noThreads || !!busy} loading={busy === 'start' && sel.size > 0} onClick={startSel}><ImagePlay size={12} /> 出选中的 {sel.size} 行</Button>
              <Button variant="primary" size="sm" disabled={noThreads || !!busy} loading={busy === 'start' && !sel.size} onClick={startAll}><ImagePlay size={12} /> 按缺图单出图（全部）</Button>
              <Button variant="secondary" size="sm" disabled={!data.running || !!busy} loading={busy === 'pause'} onClick={pause}><Pause size={12} /> 暂停</Button>
              <Button variant="secondary" size="sm" disabled={!written.length || !!busy} onClick={() => setRr({ ids: null, scope: sel.size ? 'sel' : 'imported', ret: false })}><RefreshCw size={12} /> 重审…</Button>
            </>
          ) : null}
        </div>
      </div>
      {noThreads ? <p className="m-0 text-[11.5px] text-[var(--danger)]">还没设 am 线程：到「项目设置 → 图片参数 → am 线程」里填好再出图。</p> : null}

      <div className="max-h-[360px] overflow-auto rounded border border-[var(--line)]">
        <table className="w-full text-[11.5px]">
          <thead className="sticky top-0 bg-[var(--bg-2,#111)] text-[var(--fg-3)]">
            <tr><th className="w-8 p-1.5" /><th className="p-1.5 text-left">资产</th><th className="p-1.5 text-left">类别</th><th className="p-1.5 text-left">状态</th><th className="p-1.5 text-left">格 / 轮</th><th className="p-1.5 text-left">D 格</th><th className="p-1.5 text-left">审图结论</th><th className="p-1.5 text-left">人工</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = statusOf(r);
              return (
                <tr key={r.asset_id} className={'border-t border-[var(--line)] ' + (ALERT.has(r.status) ? 'bg-[color-mix(in_srgb,var(--danger)_8%,transparent)]' : '')}>
                  <td className="p-1.5"><Checkbox checked={sel.has(r.asset_id)} onChange={(v) => toggle(r.asset_id, v)} /></td>
                  <td className="p-1.5 text-[var(--fg)]" title={r.note || ''}>{r.name}{r.base_ref ? <span className="ml-1 text-[var(--fg-4)]">（底图 {r.base_ref.name || ''}）</span> : null}</td>
                  <td className="p-1.5 text-[var(--fg-3)]">{KIND[r.kind] || r.kind}</td>
                  <td className="p-1.5"><Badge tone={st.tone} dot={r.status === 'sent' || r.status === 'reviewing'}>{st.text}</Badge>{r.note && ALERT.has(r.status) ? <div className="mt-0.5 text-[10.5px] text-[var(--danger)]">{r.note}</div> : null}</td>
                  <td className="p-1.5 text-[var(--fg-3)]">{r.step && r.step !== 'main' ? r.step + ' 格 · ' : ''}{r.round ? 'r' + r.round : ''}</td>
                  <td className="p-1.5">{/_MV/.test(r.name) && canGenerate && (dSources(r).length || (r.versions || []).length) ? (
                    <select className="rounded border border-[var(--line)] bg-transparent p-0.5 text-[11px]" value="" disabled={!!busy} onChange={(e) => setD(r, e.target.value)}>
                      <option value="">人工指定 D…</option>
                      {dSources(r).map((x) => <option key={x.asset_id} value={x.asset_id}>取「{x.name}」的 D</option>)}
                      {(r.versions || []).map((v, i) => <option key={v} value={'v:' + v}>取本张{i === 0 ? '当前图' : '旧版 ' + i}的 D</option>)}
                    </select>
                  ) : <span className="text-[var(--fg-4)]">—</span>}</td>
                  <td className="p-1.5">{r.last_verdict || r.round ? <Button variant="ghost" size="sm" onClick={() => openDetail(r)}>{r.last_verdict === 'pass' ? '审过' : r.last_verdict === 'return' ? '退回' : '看记录'}</Button> : <span className="text-[var(--fg-4)]">—</span>}</td>
                  <td className="p-1.5">{canGenerate && ['needs_human', 'review_failed', 'stale'].includes(r.status) ? <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setApv({ row: r, reason: '' })}>人工审过</Button> : null}{canGenerate && r.has_image && !['sent', 'reviewing', 'next_step', 'return_queued', 'unconfirmed', 'stale_warn'].includes(r.status) ? <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setRr({ ids: [r.asset_id], name: r.name, ret: false })}>重审</Button> : null}{canGenerate ? <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setRet({ row: r, note: '', step: /_MV/.test(r.name) ? (r.step && r.step !== 'compose' ? r.step : 'A') : '' })}>人工退回</Button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(data.doubts || []).length ? (
        <div className="flex flex-col gap-1 rounded border border-[var(--line)] p-2">
          <span className="text-[11px] font-medium text-[var(--fg-2)]">资产分析存疑（{data.doubts.length} 条，要拍板的）</span>
          {data.doubts.map((d, i) => (
            <div key={i} className="text-[11px] text-[var(--fg-3)]">· {d.question || JSON.stringify(d)}{d.options ? '（可选：' + [].concat(d.options).join(' / ') + '）' : ''}{d.lean || d.tendency ? '；倾向：' + (d.lean || d.tendency) : ''}</div>
          ))}
        </div>
      ) : null}

      <Modal open={!!rr} onOpenChange={(o) => !o && setRr(null)} title={rr ? (rr.ids ? '重审：' + rr.name : '批量重审已写回的图') : ''} footer={<><Button variant="ghost" size="md" onClick={() => setRr(null)}>取消</Button><Button variant="primary" size="md" disabled={!rr || !!busy || (rr.scope === 'sel' && !sel.size)} loading={busy === 'rereview'} onClick={doRereview}>开始重审</Button></>}>
        {rr ? (
          <div className="flex flex-col gap-2 text-[12px]">
            <p className="m-0 text-[var(--fg-3)]">用现在的审图 Agent 和必核项重审一遍已经写回的图（_MV 按 2×2 逐格核 D 和 A/B/C）。过了图不动。</p>
            {!rr.ids ? (
              <label className="flex items-center gap-2">范围
                <select className="rounded border border-[var(--line)] bg-transparent p-1" value={rr.scope} onChange={(e) => setRr((x) => ({ ...x, scope: e.target.value }))}>
                  <option value="imported">手工线导入的全部（{written.filter((x) => x.imported).length} 张）</option>
                  <option value="all">已写回的全部（{written.length} 张）</option>
                  <option value="sel" disabled={!sel.size}>选中的 {sel.size} 行</option>
                </select>
              </label>
            ) : null}
            <Checkbox checked={rr.ret} onChange={(v) => setRr((x) => ({ ...x, ret: v }))} label="不过时直接按原线程退回那一格（不勾：标「需人工」，图不动）" />
          </div>
        ) : null}
      </Modal>

      <Modal open={!!apv} onOpenChange={(o) => !o && setApv(null)} title={apv ? '人工审过：' + apv.row.name + (apv.row.step && apv.row.step !== 'main' ? '（' + apv.row.step + ' 格）' : '') : ''} footer={<><Button variant="ghost" size="md" onClick={() => setApv(null)}>取消</Button><Button variant="primary" size="md" disabled={!apv || !apv.reason.trim() || !!busy} loading={busy === 'approve'} onClick={doApprove}>判过，接着往下走</Button></>}>
        {apv ? <textarea className="min-h-[100px] w-full rounded border border-[var(--line)] bg-transparent p-2 text-[12px]" placeholder="理由（记成人工审核记录），例：审图误判，C 格和 A 是同一车厢，门在右侧" value={apv.reason} onChange={(e) => setApv((x) => ({ ...x, reason: e.target.value }))} /> : null}
      </Modal>

      <Modal open={!!ret} onOpenChange={(o) => !o && setRet(null)} title={ret ? '人工退回：' + ret.row.name : ''} footer={<><Button variant="ghost" size="md" onClick={() => setRet(null)}>取消</Button><Button variant="primary" size="md" disabled={!ret || !ret.note.trim() || !!busy} loading={busy === 'return'} onClick={doReturn}>退回，原线程出下一轮</Button></>}>
        {ret ? (
          <div className="flex flex-col gap-2 text-[12px]">
            {/_MV/.test(ret.row.name) ? (
              <label className="flex items-center gap-2">退哪一格
                <select className="rounded border border-[var(--line)] bg-transparent p-1" value={ret.step} onChange={(e) => setRet((x) => ({ ...x, step: e.target.value }))}>
                  {['A', 'B', 'C', 'D'].map((s) => <option key={s} value={s}>{s} 格</option>)}
                </select>
              </label>
            ) : null}
            <textarea className="min-h-[120px] rounded border border-[var(--line)] bg-transparent p-2" placeholder="退回意见：哪一处、照什么改（左右先写清机位朝向）" value={ret.note} onChange={(e) => setRet((x) => ({ ...x, note: e.target.value }))} />
          </div>
        ) : null}
      </Modal>

      <Modal open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={detail ? '审图记录：' + detail.row.name : ''} size="lg">
        {detail ? (
          <div className="flex flex-col gap-3 text-[12px]">
            {detail.item?.note ? <p className="m-0 text-[var(--danger)]">{detail.item.note}</p> : null}
            {(detail.reviews || []).length ? detail.reviews.map((rv, i) => (
              <div key={i} className="rounded border border-[var(--line)] p-2">
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={rv.verdict === 'pass' ? 'success' : 'danger'}>{rv.verdict === 'pass' ? '审过' : '退回'}</Badge>
                  <span className="text-[var(--fg-3)]">{rv.step !== 'main' ? rv.step + ' 格 · ' : ''}r{rv.round}</span>
                </div>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {Object.entries(rv.checks || {}).map(([k, c]) => (
                    <li key={k} className={c.ok === false ? 'text-[var(--danger)]' : 'text-[var(--fg-2)]'}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '—'} {CHECK_LABEL[k] || k}：{c.note}</li>
                  ))}
                </ul>
                {(rv.checklist || []).length ? (
                  <table className="mt-1.5 w-full text-[11px]">
                    <thead><tr className="text-[var(--fg-4)]"><th className="text-left">件</th><th className="text-left">应为</th><th className="text-left">图里</th><th /></tr></thead>
                    <tbody>{rv.checklist.map((c, j) => <tr key={j} className={c.ok ? '' : 'text-[var(--danger)]'}><td>{c.item}</td><td>{c.expected}</td><td>{c.seen}</td><td>{c.ok ? '✓' : '✗'}</td></tr>)}</tbody>
                  </table>
                ) : null}
                {rv.return_note ? <p className="m-0 mt-1.5 text-[var(--fg-2)]">退回意见：{rv.return_note}</p> : null}
              </div>
            )) : <p className="m-0 text-[var(--fg-3)]">还没有审图结论。</p>}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
