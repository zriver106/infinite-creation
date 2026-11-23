import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Activity, BookCheck, ClipboardList, Cpu, Database, FileSearch, Gauge, MessagesSquare, RefreshCw, ScrollText, Send, Film } from 'lucide-react';

// 指挥系统 第一期：只读预览。本页没有任何写操作按钮。
const SUBS = [
  { id: 'overview', label: '总览巡视', icon: Activity, phase: 1 },
  { id: 'issues', label: '问题描述（可编辑）', icon: Pencil, phase: 1 },
  { id: 'episodes', label: '按集返修看板', icon: ClipboardList, phase: 1, jump: 'issues' },
  { id: 'writes', label: '写库与回读核对', icon: Database, phase: 2 },
  { id: 'gpu', label: 'GPU 排链', icon: Cpu, phase: 2 },
  { id: 'delivery', label: '审片与导出', icon: Film, phase: 2 },
  { id: 'rules', label: '规则与 lint', icon: BookCheck, phase: 1 },
  { id: 'sessions', label: 'AI 会话', icon: MessagesSquare, phase: 1 },
  { id: 'usage', label: '用量与计费', icon: Gauge, phase: 1 },
  { id: 'dispatch', label: '派工', icon: Send, phase: 1 },
  { id: 'evidence', label: '证据与日志', icon: ScrollText, phase: 1 },
];
const READY = new Set(['overview', 'issues', 'episodes', 'sessions', 'evidence', 'dispatch']);

const PLACEHOLDER = {
  writes: { phase: '第二期', desc: '写库包 before/after_expected 逐字段 diff、非目标镜漂移检查、回读 md5 对比。第三期才加「确认写库」（人点）。' },
  gpu: { phase: '第二期（只读）/ 第三期（放行按钮）', desc: '链序列表、每链 chain.log/state、上游 PID 是否退出、STOP 标记、脚本 md5 是否与审过的一致。「放行下一链」需人点，且放行权在 Andy 确认前不交给指挥。当前链的只读状态已在「总览巡视」里显示。' },
  delivery: { phase: '第二期', desc: 'Claude + Codex 分工审片：对照原著、分镜、资产绑定和问题描述.txt，查脸漂/重复人物、服装、场景/道具连续性、人物消失、台词串音、剧情跑偏、静止拖沓；按集出问题清单和证据帧，大问题拦交付，小问题记账；ffprobe 时长/分辨率/镜数核对。「确认导出」第三期，需人点。' },
  rules: { phase: '第一期（后续补）', desc: '规则批次（第3批 v4、第4批画风、第5批光幕 v2 草案）状态与 md5、最近 lint 结果。批次上线按钮不做——只能 Andy 本人。' },
  usage: { phase: '第一期（后续补）', desc: '每家 AI 今日 / 单任务用量、上限、剩余。80% 停派新活，100% 做完当前步即停。上限数值待 Andy 定。' },
  dispatch: { phase: '第三期', desc: '派工表：Claude、Codex 现在启用；Muse 经资产管理转派（规矩已立的小活，不只做图）；Kimi 接口预留、默认关闭。每类活写明规矩出处、输入、输出、验收标准。' },
};

function useJson(url) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const load = useCallback(() => {
    if (!url) return;
    setState((s) => ({ ...s, loading: true }));
    fetch(url).then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
      setState({ loading: false, data: j, error: null });
    }).catch((e) => setState({ loading: false, data: null, error: String(e.message || e) }));
  }, [url]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
const fmtSize = (n) => (n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

function Card({ title, right, children }) {
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
function Pill({ tone = 'gray', children }) {
  const c = { green: '#16a34a', yellow: '#d97706', red: '#dc2626', gray: '#6b7280', blue: '#2563eb' }[tone];
  return <span style={{ color: c, borderColor: c }} className="inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium">{children}</span>;
}
function Refresh({ onClick, loading }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs text-[var(--fg-3)] hover:text-[var(--fg)]">
      <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新（只读）
    </button>
  );
}
function Err({ e }) { return e ? <p className="text-xs text-red-500">读取失败：{e}</p> : null; }
const Pre = ({ children, max = 360 }) => (
  <pre style={{ maxHeight: max }} className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] p-2 text-[11px] leading-relaxed">{children}</pre>
);

function Overview() {
  const { data, error, loading, reload } = useJson('/api/command/overview');
  useEffect(() => { const t = setInterval(reload, 20000); return () => clearInterval(t); }, [reload]);
  const h = data?.live4610;
  const q = data?.queue;
  return (
    <div className="flex flex-col gap-4">
      <Card title="服务健康" right={<Refresh onClick={reload} loading={loading} />}>
        <Err e={error} />
        {data ? (
          <div className="grid gap-3 text-xs sm:grid-cols-3">
            <div>IC 后端 4610：{h?.ok ? <Pill tone="green">正常</Pill> : <Pill tone="red">异常</Pill>}<div className="mt-1 text-[var(--fg-3)]">渲染：{h?.health?.render?.provider || '—'} · 并发 {h?.health?.render?.concurrency ?? '—'}</div></div>
            <div>Studio 4710：{data.studio4710?.ok ? <Pill tone="green">正常</Pill> : <Pill tone="red">异常</Pill>}</div>
            <div>巡视时间：{fmtTime(data.at)}<div className="mt-1 text-[var(--fg-3)]">每 20 秒自动刷新</div></div>
          </div>
        ) : null}
      </Card>
      <Card title="IC 队列（GET /api/queue）">
        {q && typeof q === 'object' ? (
          <div className="flex flex-wrap gap-3 text-xs">
            <span>队列开关：{q.enabled ? '开' : '关'}</span><span>运行中 {q.running}</span><span>等待 {q.waiting}</span><span>容量 {q.capacity}</span>
            {q.pausedUntil ? <Pill tone="yellow">暂停至 {fmtTime(q.pausedUntil)} {q.pauseReason}</Pill> : null}
            {q.pools ? Object.entries(q.pools).map(([k, v]) => <span key={k} className="text-[var(--fg-3)]">{k}: 跑 {v.running} / 等 {v.waiting}</span>) : null}
          </div>
        ) : <Pre>{JSON.stringify(q, null, 2)}</Pre>}
      </Card>
      <Card title="当前 GPU 链进程（单一提交者）">
        {data?.gpu?.chains?.length ? (
          <table className="w-full text-xs"><thead><tr className="text-left text-[var(--fg-3)]"><th>PID</th><th>脚本</th><th>参数</th><th>启动</th></tr></thead>
            <tbody>{data.gpu.chains.map((c) => <tr key={c.pid}><td>{c.pid}</td><td className="font-mono">{c.script}</td><td className="font-mono">{c.args}</td><td>{fmtTime(c.started)}</td></tr>)}</tbody></table>
        ) : <p className="text-xs text-[var(--fg-3)]">{data ? '没有正在运行的 gpu_*chain.py' : '…'}</p>}
        {data?.gpu?.chains?.length > 1 ? <p className="mt-2 text-xs text-red-500">⚠ 同时有 {data.gpu.chains.length} 个链进程，违反单一提交者</p> : null}
        {data?.gpu?.comfyProcesses ? <p className="mt-2 text-[11px] text-[var(--fg-3)]">ComfyUI 进程（只看进程表，不连端口）：{data.gpu.comfyProcesses.map((c) => `PID ${c.pid}:${c.port}`).join('，') || '无'}</p> : null}
      </Card>
      <Card title="最近的链运行记录（运行记录\gpu生产，只读）">
        {Array.isArray(data?.chainRuns) ? data.chainRuns.map((r) => (
          <div key={r.name} className="mb-3 border-b border-[var(--line)] pb-2 last:border-0">
            <div className="flex flex-wrap items-center gap-2 text-xs"><b className="font-mono">{r.name}</b><span className="text-[var(--fg-3)]">chain.log 更新 {fmtTime(r.mtime)}</span>{r.stopFile ? <Pill tone="red">有 STOP 标记</Pill> : null}</div>
            {r.tail ? <Pre max={140}>{r.tail.join('\n')}</Pre> : <p className="text-[11px] text-[var(--fg-3)]">无 chain.log</p>}
          </div>
        )) : null}
      </Card>
    </div>
  );
}

const ST = { done: ['完成', 'green'], doing: ['修改中', 'yellow'], todo: ['待修改', 'red'], empty: ['无条目', 'gray'] };
function Episodes() {
  const { data, error, loading, reload } = useJson('/api/command/episodes');
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all');
  const eps = (data?.episodes || []).filter((e) => filter === 'all' || e.status === filter || (filter === 'p1' && e.no <= 10));
  const sum = (data?.episodes || []).reduce((a, e) => { a[e.status] = (a[e.status] || 0) + 1; return a; }, {});
  return (
    <Card title="按集返修看板（只读解析 问题描述.txt）" right={<Refresh onClick={reload} loading={loading} />}>
      <Err e={error} />
      {data ? <p className="mb-2 text-[11px] text-[var(--fg-3)]">{data.file} · 修改时间 {fmtTime(data.mtime)} · {data.note}</p> : null}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {[['all', '全部'], ['p1', '1–10 集（优先）'], ['doing', `修改中 ${sum.doing || 0}`], ['todo', `待修改 ${sum.todo || 0}`], ['done', `完成 ${sum.done || 0}`]].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={'rounded-full border px-2.5 py-0.5 ' + (filter === k ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--fg-3)]')}>{l}</button>
        ))}
      </div>
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[var(--fg-3)]"><th className="py-1">集</th><th>状态</th><th>完成</th><th>修改中</th><th>待修改</th><th>备注</th></tr></thead>
        <tbody>
          {eps.map((e) => (
            <Fragment key={e.no + '-' + e.line}>
              <tr className="cursor-pointer border-t border-[var(--line)] hover:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]" onClick={() => setOpen(open === e.line ? null : e.line)}>
                <td className="py-1.5 font-semibold">第{e.no}集</td>
                <td><Pill tone={ST[e.status][1]}>{ST[e.status][0]}</Pill></td>
                <td>{e.counts.done}</td><td>{e.counts.doing}</td><td>{e.counts.todo}</td>
                <td className="max-w-[360px] truncate text-[var(--fg-3)]">{e.note}</td>
              </tr>
              {open === e.line ? (
                <tr key={'d' + e.line}><td colSpan={6} className="pb-3">
                  <ul className="flex flex-col gap-1">{e.items.map((it, i) => (
                    <li key={i} className="flex gap-2"><Pill tone={ST[it.status][1]}>{ST[it.status][0]}</Pill><span className="flex-1">{it.text}</span>{it.line ? <span className="text-[var(--fg-4)]">L{it.line}</span> : null}</li>
                  ))}</ul>
                  <p className="mt-2 text-[11px] text-[var(--fg-4)]">打钩建议、截止时间、流水线当前步：第二期。打钩本身只能 Andy 本人批。</p>
                </td></tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Sessions() {
  const [provider, setProvider] = useState('claude');
  const [days, setDays] = useState(2);
  const [sel, setSel] = useState(null);
  const [page, setPage] = useState(-1);
  const list = useJson(provider === 'kimi' ? null : `/api/command/sessions?provider=${provider}&days=${days}`);
  const sess = useJson(sel ? `/api/command/session?provider=${provider}&id=${encodeURIComponent(sel)}&page=${page}&size=40` : null);
  return (
    <div className="flex flex-col gap-4">
      <Card title="AI 会话（只读，已脱敏）">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[['claude', 'Claude · 启用'], ['codex', 'Codex · 启用'], ['kimi', 'Kimi · 未启用'], ['muse', 'Muse · 经资产管理']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setProvider(k); setSel(null); setPage(-1); }} className={'rounded-full border px-2.5 py-0.5 ' + (provider === k ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--fg-3)]')}>{l}</button>
          ))}
          <span className="ml-3 text-[var(--fg-3)]">范围：最近</span>
          {[1, 2, 3, 7].map((d) => <button key={d} type="button" onClick={() => setDays(d)} className={'rounded border px-1.5 ' + (days === d ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)]')}>{d} 天</button>)}
        </div>
        {provider === 'kimi' ? <p className="mt-3 text-xs">Kimi：接口预留，<b>未启用</b>（默认关闭；启用后只用一个固定长期会话 + 深度思考；启用需 Andy 本人批）。</p> : null}
        {provider === 'muse' ? <p className="mt-3 text-xs">Muse（Mac）：不直连，派单经资产管理转派；会话查看在第三期接入。</p> : null}
        {provider === 'claude' || provider === 'codex' ? (
          <div className="mt-3">
            <Err e={list.error} />
            {list.data ? <p className="mb-1 text-[11px] text-[var(--fg-3)]">共 {list.data.total} 个会话（最多显示 300，按更新时间倒序）</p> : null}
            <div className="max-h-[260px] overflow-auto">
              <table className="w-full text-[11px]"><tbody>
                {(list.data?.sessions || []).map((s) => (
                  <tr key={s.id} className={'cursor-pointer border-t border-[var(--line)] ' + (sel === s.id ? 'text-[var(--accent)]' : '')} onClick={() => { setSel(s.id); setPage(-1); }}>
                    <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(s.mtime)}</td><td className="pr-2 whitespace-nowrap">{fmtSize(s.size)}</td><td className="break-all font-mono">{s.id}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        ) : null}
      </Card>
      {sel ? (
        <Card title={`会话上下文 · ${sel}`} right={sess.data ? (
          <div className="flex items-center gap-1 text-xs">
            <button type="button" className="rounded border border-[var(--line)] px-2" disabled={sess.data.page <= 0} onClick={() => setPage(0)}>首页</button>
            <button type="button" className="rounded border border-[var(--line)] px-2" disabled={sess.data.page <= 0} onClick={() => setPage(sess.data.page - 1)}>上一页</button>
            <span>{sess.data.page + 1} / {sess.data.pages}（{sess.data.total} 条）</span>
            <button type="button" className="rounded border border-[var(--line)] px-2" disabled={sess.data.page >= sess.data.pages - 1} onClick={() => setPage(sess.data.page + 1)}>下一页</button>
            <button type="button" className="rounded border border-[var(--line)] px-2" onClick={() => setPage(-1)}>末页</button>
          </div>
        ) : null}>
          {sess.loading ? <p className="text-xs text-[var(--fg-3)]">读取中…（大文件需要几秒）</p> : null}
          <Err e={sess.error} />
          <div className="flex flex-col gap-2">
            {(sess.data?.messages || []).map((m) => (
              <div key={m.i} className="rounded-lg border border-[var(--line)] p-2">
                <div className="mb-1 flex gap-2 text-[10px] text-[var(--fg-3)]"><b>#{m.i}</b><span>{m.role}</span><span>{fmtTime(m.ts)}</span></div>
                <Pre max={240}>{m.text}</Pre>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Evidence() {
  const list = useJson('/api/command/evidence');
  const [sel, setSel] = useState({ root: 'cmd', name: '日志.md' });
  const file = useJson(`/api/command/evidence/file?root=${sel.root}&name=${encodeURIComponent(sel.name)}&lines=400`);
  const group = (k, title) => (
    <div className="mb-3">
      <p className="section-label mb-1">{title}</p>
      <p className="mb-1 break-all text-[10px] text-[var(--fg-4)]">{list.data?.[k]?.dir}</p>
      <ul className="flex flex-col gap-0.5 text-[11px]">
        {(list.data?.[k]?.files || []).map((f) => (
          <li key={f.name}><button type="button" onClick={() => setSel({ root: k, name: f.name })} className={'text-left hover:underline ' + (sel.root === k && sel.name === f.name ? 'text-[var(--accent)]' : '')}>{f.name}</button> <span className="text-[var(--fg-4)]">{fmtSize(f.size)} · {fmtTime(f.mtime)}</span></li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="lg:w-[300px]"><Card title="文件（只读，不删）" right={<Refresh onClick={list.reload} loading={list.loading} />}><Err e={list.error} />{group('cmd', '指挥日志 M\\Claude工作区\\指挥')}{group('link', '共享记录 P\\问题链路记录')}</Card></div>
      <div className="min-w-0 flex-1">
        <Card title={sel.name} right={<Refresh onClick={file.reload} loading={file.loading} />}>
          <Err e={file.error} />
          {file.data ? <p className="mb-1 text-[11px] text-[var(--fg-3)]">{file.data.path} · {fmtSize(file.data.size)} · {fmtTime(file.data.mtime)} · 显示末尾 {file.data.tailLines} 行</p> : null}
          <Pre max={640}>{file.data?.content}</Pre>
        </Card>
      </div>
    </div>
  );
}


function Hash({ md5, sha256 }) {
  if (md5) return <span className="font-mono text-[10px]">md5 {md5}</span>;
  if (sha256) return <span className="font-mono text-[10px]">sha256 {sha256.slice(0, 16)}…</span>;
  return <span className="text-[10px] text-[var(--fg-4)]">无哈希</span>;
}
function PartyCol({ p }) {
  return (
    <section className="panel flex min-w-0 flex-col gap-2 p-3 text-[11px]">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{p.name}</h3>{p.found ? <Pill tone="green">有数据源</Pill> : <Pill tone="gray">暂无数据源</Pill>}</div>
      {p.sources?.length ? <p className="break-all text-[10px] text-[var(--fg-4)]">来源：{p.sources.join('；')}</p> : null}
      {p.sourceNote ? <p className="text-[10px] text-[var(--fg-3)]">{p.sourceNote}</p> : null}
      {!p.found ? <p className="text-xs">{p.missing}{p.missingNote ? <span className="mt-1 block text-[10px] text-[var(--fg-3)]">{p.missingNote}</span> : null}</p> : (
        <>
          <div><p className="section-label mb-1">当前在做</p><ul className="flex flex-col gap-1">{p.current.map((c, i) => <li key={i} className="break-all">{c}</li>)}</ul></div>
          <div>
            <p className="section-label mb-1">最近的交付</p>
            {p.deliveriesNote ? <p className="mb-1 text-[10px] text-[var(--fg-4)]">{p.deliveriesNote}</p> : null}
            <ul className="flex flex-col gap-1.5">
              {(p.deliveries || []).map((d, i) => (
                <li key={i} className="rounded border border-[var(--line)] p-1.5">
                  <div className="flex flex-wrap gap-2 text-[10px] text-[var(--fg-3)]"><span>{d.at}</span><span className="truncate">{d.title}</span></div>
                  {d.path ? <div className="break-all font-mono text-[10px]">{d.path}</div> : <div className="break-all text-[10px]">{d.raw}</div>}
                  <Hash md5={d.md5} sha256={d.sha256} />
                </li>
              ))}
              {(p.extraDeliveries || []).map((d, i) => (
                <li key={'x' + i} className="rounded border border-[var(--line)] p-1.5">
                  <div className="text-[10px] text-[var(--fg-3)]">{fmtTime(d.at)} · <b>{d.title}</b></div>
                  <div className="break-all font-mono text-[10px] text-[var(--fg-4)]">{d.path}</div>
                  {d.items.length ? d.items.map((it, k) => <div key={k} className="break-all font-mono text-[10px]">{it.md5} {it.path.slice(d.path.length + 1)}</div>) : <div className="text-[10px] text-[var(--fg-4)]">{d.note}</div>}
                </li>
              ))}
              {!(p.deliveries || []).length && !(p.extraDeliveries || []).length ? <li className="text-[var(--fg-4)]">暂无</li> : null}
            </ul>
          </div>
          <div><p className="section-label mb-1">在等什么</p>{p.waitingNote ? <p className="mb-1 text-[10px] text-[var(--fg-4)]">{p.waitingNote}</p> : null}<ul className="flex flex-col gap-1">{p.waiting.map((w, i) => <li key={i} className="break-all">{w}</li>)}</ul></div>
        </>
      )}
    </section>
  );
}
const ORDER_FIELDS = ['编号', '来源', '接单方', '范围', '验收标准', '截止时间', '状态', '交付物', '需要Andy点头'];
function showVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? `${x['路径'] || x.path || ''}${x.md5 ? '  md5 ' + x.md5 : '  md5 —'}` : String(x))).join('\n') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function Dispatch() {
  const { data, error, loading, reload } = useJson('/api/command/dispatch');
  return (
    <div className="flex flex-col gap-4">
      <div className="panel border-l-4 p-3 text-xs" style={{ borderLeftColor: '#d97706' }}>
        <b>只读，没有发单按钮。</b>真正发单属于上线，要 Andy 批；在此之前各方照现在的分工干。手册和剧情改动、花钱、上线、导出、改 GPU 脚本仍要 Andy 本人点头。
      </div>
      <Card title="五方状态（只读解析 agent1 上的现有记录）" right={<Refresh onClick={reload} loading={loading} />}>
        <Err e={error} />
        {data ? <p className="mb-2 text-[11px] text-[var(--fg-3)]">读取时间 {fmtTime(data.at)}</p> : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{(data?.parties || []).map((p) => <PartyCol key={p.id} p={p} />)}</div>
      </Card>
      <Card title="派工单草稿（只读）">
        {data ? <p className="mb-2 break-all text-[11px] text-[var(--fg-3)]">目录：{data.orders.dir}{data.orders.exists ? '' : '（不存在）'} · 共 {data.orders.orders.length} 张</p> : null}
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead><tr className="text-left text-[var(--fg-3)]"><th className="pr-2">文件</th>{ORDER_FIELDS.map((f) => <th key={f} className="pr-2">{f}</th>)}</tr></thead>
            <tbody>
              {(data?.orders.orders || []).map((o) => (
                <tr key={o.file} className="border-t border-[var(--line)] align-top">
                  <td className="py-1.5 pr-2"><div className="font-mono">{o.file}</div><div className="font-mono text-[9px] text-[var(--fg-4)]">md5 {o.md5}</div>{o.data?.['示例'] ? <Pill tone="blue">示例</Pill> : null}</td>
                  {o.error ? <td colSpan={ORDER_FIELDS.length} className="text-red-500">{o.error}</td> : ORDER_FIELDS.map((f) => <td key={f} className="whitespace-pre-wrap break-all pr-2">{showVal(o.data[f])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ======================= 问题描述（可编辑）+ 返修环节 + GPU 状态栏 =======================
const STAGE_TONE = { 已完成: 'green', '待 Andy 点头': 'blue', 待导出: 'blue', 审片: 'blue', 出片中: 'yellow', 排队出片: 'yellow', 写库: 'yellow', 复审: 'yellow', 改稿中: 'yellow', 待改稿: 'red', 未知: 'gray' };
const fmtEta = (s) => (s ? new Date(s).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
const CH_STATE = { running: ['在跑', 'yellow'], waiting: ['已挂起等上游', 'blue'], ready: ['脚本就绪未启动', 'gray'], done: ['已跑完', 'green'], stopped: ['有日志但进程不在', 'red'], missing: ['待建', 'gray'] };
function GpuBar({ g }) {
  if (!g) return null;
  const r = g.running;
  return (
    <section className="panel p-3 text-xs" data-gpu-bar>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-sm">GPU 状态</b>
        {g.idle ? <Pill tone="red">进程表里没有在跑的链（GPU 可能空闲）</Pill> : null}
        <span className="text-[10px] text-[var(--fg-4)]">单镜耗时（估算）：{g.perShotSec ? `${Math.round(g.perShotSec)} 秒，取今天最近 ${g.sampleCount} 个 done 的中位数` : '没有样本'} · {g.note}</span>
      </div>
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">当前</p>{r ? <><b className="font-mono">{r.key}</b> PID {r.pid} · 进度 {r.done}/{r.total}{r.current ? ` · 正在出 ${r.current.ch || ''}#${r.current.num}（${r.current.id.slice(0, 8)}，提交于 ${r.current.at.slice(11)}）` : ''} · 预计跑完 {fmtEta(r.eta)}（估算）</> : '没有在跑的链'}</div>
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">下一条</p>{g.next ? <><b className="font-mono">{g.next.key}</b> · {CH_STATE[g.next.state]?.[0]}{g.next.after ? ` · --after=${g.next.after}` : ''} · {g.next.total} 镜</> : '队列里没有下一条'}</div>
      </div>
      <table className="w-full text-[11px]"><thead><tr className="text-left text-[var(--fg-3)]"><th>顺序</th><th>链</th><th>状态</th><th>进度</th><th>镜单</th><th>上游</th><th>预计跑完（估算）</th></tr></thead>
        <tbody>{g.chains.map((c, i) => (
          <tr key={c.key} className="border-t border-[var(--line)] align-top">
            <td>{i + 1}</td><td className="font-mono">{c.key}{c.unlisted && <span className="ml-1 text-[10px] text-amber-400">（今天新出现，不在参考顺序里，位置待定）</span>}</td><td><Pill tone={CH_STATE[c.state]?.[1]}>{CH_STATE[c.state]?.[0]}</Pill></td>
            <td>{c.placeholder ? '—' : `${c.done}/${c.total}`}</td>
            <td className="max-w-[320px] break-all">{(c.shots || []).map((s) => `${s.ch.replace('第', '').replace('章', '')}#${s.num}${s.done ? '✓' : ''}`).join(' ') || '—'}</td>
            <td>{c.pid ? `PID ${c.pid} --after=${c.after}` : '—'}</td><td>{c.state === 'done' ? `完成于 ${String(c.doneAt).slice(11)}` : fmtEta(c.eta)}</td>
          </tr>))}</tbody></table>
    </section>
  );
}
function Issues() {
  const [operator, setOperator] = useState('Andy');
  const { data, error, loading, reload } = useJson('/api/issues');
  const log = useJson('/api/issues/log');
  const [open, setOpen] = useState({});
  const [edit, setEdit] = useState(null);
  const [add, setAdd] = useState({ episode: '', text: '', status: 'todo' });
  const [msg, setMsg] = useState(null);
  const human = operator === 'Andy' || operator === '总导';
  const post = async (url, body) => {
    setMsg(null);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operator, baseMd5: data?.file.md5, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) setMsg({ tone: 'red', text: '拒写：' + j.error });
    else if (!r.ok && r.status !== 202) setMsg({ tone: 'red', text: j.error || 'HTTP ' + r.status });
    else setMsg({ tone: 'green', text: j.suggested ? 'AI 不能直接改：已进待确认队列，等 Andy 或总导确认' : j.made != null ? `生成了 ${j.made} 条建议，已进待确认队列` : `已写入（备份 ${j.backup || '—'}，新 md5 ${j.afterMd5 || '—'}）` });
    reload(); log.reload();
  };
  const op = (o, extra = {}) => post('/api/issues/op', { op: o, ...extra });
  return (
    <div className="flex flex-col gap-3" data-issues>
      <GpuBar g={data?.gpu} />
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
        <b>问题描述（可编辑）</b>
        {data ? (data.config.isTestCopy ? <Pill tone="yellow">测试副本</Pill> : <Pill tone="red">真文件</Pill>) : null}
        <span className="break-all font-mono text-[10px]">{data?.config.target}</span>
        <span className="text-[10px] text-[var(--fg-4)]">md5 {data?.file.md5} · {data?.file.bom ? 'UTF-8 BOM' : 'UTF-8'} · {data?.file.eol}</span>
        <span className="flex-1" />
        <span>操作人：</span>
        <select value={operator} onChange={(e) => setOperator(e.target.value)} className="rounded border border-[var(--line)] bg-transparent" data-operator>
          {['Andy', '总导', 'AI-Claude', 'AI-Codex'].map((o) => <option key={o}>{o}</option>)}
        </select>
        <Refresh onClick={() => { reload(); log.reload(); }} loading={loading} />
        <p className="w-full text-[10px] text-[var(--fg-4)]">「操作人」只是预览里的演示切换，不是真正的身份认证。只有 Andy、总导能直接改；AI 只能提交建议，进待确认队列。每次写之前自动备份到 {data?.config.backupDir}，并写只追加的修改记录。文件在你打开后被外部改过就拒写。桌面真文件 {data?.config.realFile} 在 Andy 点头前不写。</p>
      </div>
      {msg ? <div className="panel p-2 text-xs" style={{ color: msg.tone === 'red' ? '#dc2626' : '#16a34a' }} data-msg>{msg.text}</div> : null}
      <Err e={error} />
      {data?.suggestions?.length ? (
        <Card title={`待确认建议（${data.suggestions.length}）`}>
          {data.suggestions.map((s) => (
            <div key={s.id} className="mb-1 flex flex-wrap items-center gap-2 border-b border-[var(--line)] pb-1 text-[11px]" data-suggestion={s.id}>
              <b>{s.by}</b><span>第{s.episode}集</span><span className="flex-1">{s.op?.op === 'status' ? `「${s.itemText}」 ${s.from || ''} → ${s.to}` : s.op?.op === 'add' ? `新增：${s.op.text}` : `改正文：${s.op?.text}`}<span className="block text-[10px] text-[var(--fg-4)]">{s.reason}</span></span>
              <button type="button" disabled={!human} className="rounded border border-[var(--line)] px-2 disabled:opacity-40" onClick={() => post(`/api/issues/suggestions/${s.id}/confirm`, {})}>确认写入</button>
              <button type="button" disabled={!human} className="rounded border border-[var(--line)] px-2 disabled:opacity-40" onClick={() => post(`/api/issues/suggestions/${s.id}/reject`, {})}>驳回</button>
            </div>
          ))}
        </Card>
      ) : null}
      <Card title="按集返修（Andy 的正式状态 + 系统推算的环节）" right={<button type="button" className="rounded border border-[var(--line)] px-2 text-xs" onClick={() => post('/api/issues/suggest-auto', {})}>根据出片/导出生成状态建议</button>}>
        <p className="mb-2 text-[10px] text-[var(--fg-4)]">环节是系统推算的建议值（{(data?.stages || []).join(' → ')}），按「第N章 = 第N集」对应，依据链脚本镜单、chain.log 提交/done 行（按 shot_id 对回）、IC 镜头 updated_at 与视频时间（GET 只读，读取于 {fmtTime(data?.icReadAt)}）、审片目录、交付目录。条目还没对应到镜头，单条环节一律显示「未知」，只给本集环节。预计时间=剩余镜数×单镜耗时中位数，是估算。</p>
        <table className="w-full text-xs"><thead><tr className="text-left text-[var(--fg-3)]"><th className="py-1">集</th><th>Andy 状态（完成/修改中/待修改）</th><th>推算环节</th><th>链 / 镜号</th><th>预计完成（估算）</th></tr></thead>
          <tbody>{(data?.episodes || []).map((e) => {
            const c = { done: 0, doing: 0, todo: 0 }; e.items.forEach((i) => c[i.status]++);
            return (
              <Fragment key={e.no}>
                <tr className="cursor-pointer border-t border-[var(--line)]" onClick={() => setOpen((o) => ({ ...o, [e.no]: !o[e.no] }))} data-ep={e.no}>
                  <td className="py-1.5 font-semibold">第{e.no}集</td><td>{c.done} / {c.doing} / {c.todo}</td>
                  <td><Pill tone={STAGE_TONE[e.stage.stage] || 'gray'}>{e.stage.stage}</Pill></td>
                  <td className="font-mono text-[10px]">{e.stage.chain || '—'} {e.stage.shots?.length ? '#' + e.stage.shots.join(' #') : ''}</td>
                  <td>{e.stage.stage === '已完成' ? '—' : e.stage.eta ? fmtEta(e.stage.eta) + '（估算）' : '未知'}</td>
                </tr>
                {open[e.no] ? (
                  <tr><td colSpan={5} className="pb-3">
                    <p className="mb-1 text-[10px] text-[var(--fg-4)]">推算依据：{e.stage.evidence.join('；')}</p>
                    {e.items.map((it) => (
                      <div key={it.key} className="mb-1 flex flex-wrap items-center gap-2 text-[11px]" data-item={it.key}>
                        <select value={it.status} onChange={(ev) => op({ op: 'status', start: it.start, orig: it.orig, status: ev.target.value }, { episode: e.no, itemText: it.text, from: STATUS_TXT[it.status] })} className="rounded border border-[var(--line)] bg-transparent">
                          <option value="todo">待修改</option><option value="doing">修改中</option><option value="done">完成</option>
                        </select>
                        {edit?.key === it.key ? (
                          <>
                            <input className="min-w-[300px] flex-1 rounded border border-[var(--line)] bg-transparent px-1" value={edit.text} onChange={(ev) => setEdit({ ...edit, text: ev.target.value })} />
                            <button type="button" className="rounded border border-[var(--line)] px-2" onClick={() => { op({ op: 'edit', start: it.start, orig: it.orig, text: edit.text }, { episode: e.no, itemText: it.text }); setEdit(null); }}>保存</button>
                            <button type="button" className="rounded border border-[var(--line)] px-2" onClick={() => setEdit(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <span className="flex-1">{it.text}</span>
                            <span className="text-[10px] text-[var(--fg-4)]">环节：{it.status === 'done' ? '已完成' : '未知（条目未对应到镜头）'} · 预计：{it.status === 'done' ? '—' : e.stage.eta ? '按本集 ' + fmtEta(e.stage.eta) + '（估算）' : '未知'} · L{it.start + 1}</span>
                            <button type="button" className="rounded border border-[var(--line)] px-1.5 text-[10px]" onClick={() => setEdit({ key: it.key, text: it.text })}>改</button>
                          </>
                        )}
                      </div>
                    ))}
                  </td></tr>
                ) : null}
              </Fragment>
            );
          })}</tbody></table>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2 text-xs" data-add>
          <b>新增问题</b>
          第<input className="w-12 rounded border border-[var(--line)] bg-transparent px-1" value={add.episode} onChange={(e) => setAdd({ ...add, episode: e.target.value })} />集
          <input className="min-w-[320px] flex-1 rounded border border-[var(--line)] bg-transparent px-1" placeholder="例如：1分05秒 主角衣服颜色不对" value={add.text} onChange={(e) => setAdd({ ...add, text: e.target.value })} />
          <select value={add.status} onChange={(e) => setAdd({ ...add, status: e.target.value })} className="rounded border border-[var(--line)] bg-transparent"><option value="todo">待修改</option><option value="doing">修改中</option><option value="done">完成</option></select>
          <button type="button" className="rounded border border-[var(--accent)] px-2 text-[var(--accent)]" onClick={() => { op({ op: 'add', episode: Number(add.episode), text: add.text, status: add.status }, { episode: Number(add.episode) }); setAdd({ episode: '', text: '', status: 'todo' }); }}>{human ? '写入' : '提交建议'}</button>
        </div>
      </Card>
      <Card title={`修改记录（只追加，最近 50 条 / 共 ${log.data?.total ?? 0} 条）`}>
        <p className="mb-1 break-all text-[10px] text-[var(--fg-4)]">{log.data?.file}</p>
        <div className="max-h-[320px] overflow-auto">{(log.data?.entries || []).map((r, i) => (
          <div key={i} className="mb-1 border-b border-[var(--line)] pb-1 text-[11px]" data-log>
            <b>{fmtTime(r.at)}</b> · {r.operator} · <Pill tone={r.result === 'written' ? 'green' : r.result === 'suggested' ? 'blue' : r.result?.startsWith('rejected') || r.result === 'refused' ? 'red' : 'gray'}>{r.result}</Pill> {r.via ? <span className="text-[10px]">{r.via}</span> : null}
            {r.reason ? <span className="text-[10px] text-[var(--fg-3)]"> {r.reason}</span> : null}
            {r.diff ? <Pre max={120}>{r.diff.join('\n')}</Pre> : null}
            {r.backup ? <div className="break-all text-[10px] text-[var(--fg-4)]">备份 {r.backup} · {r.beforeMd5} → {r.afterMd5}</div> : null}
          </div>))}</div>
      </Card>
    </div>
  );
}
const STATUS_TXT = { done: '完成', doing: '修改中', todo: '待修改' };

function Placeholder({ sub }) {
  const p = PLACEHOLDER[sub.id];
  return (
    <Card title={sub.label}>
      <p className="mb-2 text-xs"><Pill tone="blue">{p.phase}做</Pill> <span className="ml-1 text-[var(--fg-3)]">本预览版未实现</span></p>
      <p className="text-xs leading-relaxed">{p.desc}</p>
    </Card>
  );
}

export default function CommandPage() {
  const init = new URLSearchParams(window.location.search).get('sub');
  const [sub, setSub] = useState(init === 'episodes' ? 'issues' : SUBS.some((s) => s.id === init) ? init : 'overview');
  const go = (id) => {
    setSub(id);
    const q = new URLSearchParams(window.location.search); q.set('mode', 'command'); q.set('sub', id);
    window.history.replaceState(null, '', '/?' + q.toString());
  };
  const cur = SUBS.find((s) => s.id === sub);
  return (
    <div className="flex flex-col gap-4">
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
        <FileSearch size={14} className="text-[var(--accent)]" />
        <b>指挥系统 · 预览</b>
        <Pill tone="yellow">没有任何写库 / 放行 / 导出 / 提交 GPU 按钮；问题描述编辑只写测试副本</Pill>
        <span className="text-[var(--fg-3)]">AI：Claude 启用 · Codex 启用 · Muse 经资产管理 · Kimi 未启用 · 派工页只读（发单要 Andy 批上线）</span>
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <nav className="panel p-2 lg:w-[180px] lg:shrink-0">
          {SUBS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.id} type="button" data-active={sub === s.id} className="nav-item w-full" onClick={() => go(s.jump || s.id)}>
                <Icon size={14} className={sub === s.id ? 'text-[var(--accent)]' : 'text-[var(--fg-3)]'} />
                <span className="flex-1 text-left">{s.label}</span>
                {s.jump ? <span className="text-[9px] text-[var(--fg-4)]">跳转</span> : READY.has(s.id) ? null : <span className="text-[9px] text-[var(--fg-4)]">占位</span>}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1">
          {sub === 'overview' ? <Overview /> : null}
          {sub === 'issues' ? <Issues /> : null}
          {sub === 'sessions' ? <Sessions /> : null}
          {sub === 'evidence' ? <Evidence /> : null}
          {sub === 'dispatch' ? <Dispatch /> : null}
          {!READY.has(sub) ? <Placeholder sub={cur} /> : null}
        </div>
      </div>
    </div>
  );
}
