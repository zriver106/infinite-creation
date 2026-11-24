import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Pencil, Activity, BookCheck, ClipboardList, Cpu, Database, FileSearch, Gauge, MessagesSquare, RefreshCw, ScrollText, Send, Film } from 'lucide-react';

// 指挥系统 第一期：只读预览。本页没有任何写操作按钮。
const SUBS = [
  { id: 'overview', label: '总览', icon: Activity, phase: 1 },
  { id: 'issues', label: '问题描述（可编辑）', icon: Pencil, phase: 1 },
  { id: 'chat', label: '聊天', icon: MessageCircle, phase: 1 },
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
const READY = new Set(['overview', 'issues', 'chat', 'episodes', 'sessions', 'evidence', 'dispatch']);

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

// ---------------- 总览（按 总览设计稿.md 46A57B04） ----------------
function usePoll(url, sec) {
  const [st, setSt] = useState({ data: null, at: null, error: null, ok: null, loading: true });
  useEffect(() => {
    let alive = true, timer = null;
    const tick = async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' }); const j = await r.json();
        if (!alive) return;
        setSt((s) => ({ data: j.data ?? s.data, at: j.at, ok: j.ok, error: j.ok ? null : (j.error || '读取失败'), loading: false }));
      } catch (e) { if (alive) setSt((s) => ({ ...s, ok: false, error: String(e.message || e), loading: false })); }
      if (alive) timer = setTimeout(tick, sec * 1000); // 上一轮完了才排下一轮，不重叠
    };
    tick();
    return () => { alive = false; clearTimeout(timer); }; // 离开页面停止轮询
  }, [url, sec]);
  return st;
}
const ptHM = (s) => (s ? new Date(s).toLocaleTimeString('zh-CN', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
const pctTxt = (x, d = 1) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
function Missing({ m }) { return <span className="text-[11px] text-[var(--fg-4)]">{m?.missing || '暂无数据'}</span>; }
function Est({ e, unit = '' }) {
  const [open, setOpen] = useState(false);
  if (!e || e.value == null) return <Missing m={e} />;
  return (
    <span className="relative">
      <b>{e.value}</b>{unit}
      <button type="button" onClick={() => setOpen((o) => !o)} className="ml-1 rounded border border-[var(--line)] px-1 text-[10px] text-[var(--fg-4)]" title={`样本 ${e.samples} · ${e.window} · ${e.method}`}>估算</button>
      {open ? <span className="absolute left-0 top-5 z-10 w-[320px] rounded border border-[var(--line)] bg-[var(--bg-1,#111)] p-2 text-[11px] leading-5 shadow">样本数：{e.samples}<br />时间窗：{e.window}<br />算法：{e.method}</span> : null}
    </span>
  );
}
function Stamp({ p, sec }) {
  const [, f] = useState(0); useEffect(() => { const t = setInterval(() => f((x) => x + 1), 5000); return () => clearInterval(t); }, []);
  const ago = p.at ? Math.max(0, Math.round((Date.now() - new Date(p.at).getTime()) / 1000)) : null;
  return <span className="text-[10px] text-[var(--fg-4)]">数据采样于 {ptHM(p.at)}{ago != null ? `（${ago} 秒前）` : ''} · 每 {sec} 秒刷新{p.error ? <span className="ml-1 text-red-400">暂时读不到：{p.error}（保留上次值）</span> : null}</span>;
}
function Bar({ v }) { return <div className="mt-1 h-1.5 w-full rounded bg-[var(--line)]"><div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${Math.min(100, (v || 0) * 100)}%` }} /></div>; }
function Tile({ title, children }) { return <div className="panel min-w-0 p-3"><div className="mb-1 text-[11px] text-[var(--fg-3)]">{title}</div>{children}</div>; }
function MiniBars({ rows, field, fmt = (x) => x, max }) {
  const m = max ?? Math.max(1, ...rows.map((r) => r[field] || 0));
  return (
    <div className="flex h-24 items-end gap-1">
      {rows.map((r) => (
        <div key={r.day} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${r.day}：${r[field] == null ? '无' : fmt(r[field])}`}>
          <span className="text-[9px] text-[var(--fg-3)]">{r[field] == null ? '—' : fmt(r[field])}</span>
          <div className={'w-full rounded-t ' + (r.settled === false && field === 'oneShotRate' ? 'bg-[var(--fg-4)]' : 'bg-[var(--accent)]')} style={{ height: `${r[field] == null ? 0 : Math.max(2, (r[field] / m) * 64)}px` }} />
          <span className="text-[9px] text-[var(--fg-4)]">{r.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
function Overview({ go }) {
  const top = usePoll('/api/command/ov?part=top', 30);
  const iss = usePoll('/api/command/ov?part=issues', 60);
  const ses = usePoll('/api/command/ov?part=sessions', 60);
  const tr = usePoll('/api/command/ov?part=trends', 600);
  const d = top.data;
  if (!d) return <Card title="总览">{top.loading ? <p className="text-xs text-[var(--fg-3)]">读取中…</p> : <Err e={top.error} />}</Card>;
  const T = d.films.totalChapters;
  const sesActive = ses.data?.active || [];
  return (
    <div className="flex flex-col gap-4">
      <div className="panel flex flex-wrap items-center justify-between gap-2 p-3">
        <h2 className="text-base font-semibold">我在城市用交易系统修仙 · 总览</h2>
        <div className="flex flex-col items-end gap-0.5 text-[11px] text-[var(--fg-3)]"><span>按太平洋时间 {ptHM(new Date().toISOString())}</span><Stamp p={top} sec={30} /></div>
      </div>
      {d.errors?.length ? <p className="text-xs text-red-400">部分数据源读取失败：{d.errors.join('；')}</p> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile title="做完的集（Andy 口径）">
          {d.films.doneAndy.value === null ? <Missing m={d.films.doneAndy} /> : <><div className="text-xl font-semibold">{d.films.doneAndy.n} <span className="text-xs font-normal">/ {T}</span></div><Bar v={d.films.doneAndy.n / T} /><div className="mt-1 text-[10px] text-[var(--fg-4)]" title={d.films.doneAndy.note}>第 {d.films.doneAndy.list.join('、') || '—'} 集 · 已导出且登记问题全修好；整集验收：<Missing m={d.films.accepted} /></div></>}
        </Tile>
        <Tile title="镜头全部出好的集">
          {d.films.allShotsDone.value === null ? <Missing m={d.films.allShotsDone} /> : <><div className="text-xl font-semibold">{d.films.allShotsDone.n} <span className="text-xs font-normal">/ {T}</span></div><Bar v={d.films.allShotsDone.n / T} /><div className="mt-1 text-[10px] text-[var(--fg-4)]">已出分镜 {d.films.chaptersWithShots} 集 · 已导出交付 {d.films.exported.n} 集{d.films.exported.missing.length ? `（缺 EP${d.films.exported.missing.join('、EP')}）` : ''}</div></>}
        </Tile>
        <Tile title="问题（原文行）">
          {d.issues.value === null ? <Missing m={d.issues} /> : <><div className="text-xl font-semibold">{d.issues.raw} <span className="text-xs font-normal">行</span></div><div className="text-[11px]">已修 {d.issues.rawDone} · 未完成 {d.issues.rawOpen}</div><div className="text-[10px] text-[var(--fg-4)]">正在修复：{d.issues.fixing?.value != null ? <><b>{d.issues.fixing.value}</b> 条（估算：未完成 {d.issues.fixing.open} 条里关联到镜头 {d.issues.fixing.linked} 条，未关联 {d.issues.fixing.unlinked} 条）</> : <Missing m={d.issues.fixing} />}<br />Andy 标「修改中」{d.issues.itemsDoing} 条 ·「待修改」{d.issues.itemsTodo} 条</div></>}
        </Tile>
        <Tile title="2K 高清档">
          {d.upscale.value === null ? <Missing m={d.upscale} /> : <><div className="text-xl font-semibold">{d.upscale.hd.length} <span className="text-xs font-normal">集</span></div><div className="text-[11px]">还有 {d.upscale.sd.length} 集是预览档</div><div className="text-[10px] text-[var(--fg-4)]" title={d.upscale.note}>2K：EP{d.upscale.hd.join('、')}{d.upscale.hdStale.length ? ` · 疑似旧版 EP${d.upscale.hdStale.join('、')}` : ''}</div></>}
        </Tile>
        <Tile title="已导出成片">
          {d.minutes.exportedMin.value === null ? <Missing m={d.minutes.exportedMin} /> : <div className="text-xl font-semibold">{d.minutes.exportedMin.value} <span className="text-xs font-normal">分钟</span></div>}
          <div className="text-[11px]">今天生成素材 {d.minutes.todayGenMin.value ?? '—'} 分钟</div>
          <div className="text-[10px] text-[var(--fg-4)]">今天生成且被选用 {d.minutes.todaySelectedMin.value ?? '—'} 分钟 · 累计生成 {d.minutes.allGenMin.value ?? '—'} 分钟 · 选用版合计 {d.minutes.selectedDoneMin.value ?? '—'} 分钟</div>
        </Tile>
        <Tile title="在工作的会话">
          <div className="text-xl font-semibold">{ses.data ? sesActive.length : '—'} <span className="text-xs font-normal">个</span></div>
          <div className="text-[10px] text-[var(--fg-4)]">{ses.data ? <>登记表里在工作 {ses.data.working} 个（共登记 {ses.data.registered} 个）+ 没登记但 10 分钟内有动静 {ses.data.unregistered} 个（参考）</> : '读取中'}</div>
          <div className="mt-1 text-[11px]">剩余生成工作量 <Est e={d.times.remainWork} unit=" 天" /></div>
        </Tile>
      </div>

      <Card title="GPU 现在" right={<Stamp p={top} sec={30} />}>
        <div className="flex flex-col gap-1 text-xs">
          {d.gpu.running ? <div>● 正在出：<b>{d.gpu.running.current || '（在等提交）'}</b>（<span title={d.gpu.running.key}>{d.gpu.running.label}</span> {d.gpu.running.done}/{d.gpu.running.total}）· 本链还差 <Est e={d.gpu.running.remainMin} unit=" 分钟" /></div> : <div className="text-red-400">● 进程表里没有在跑的出片链</div>}
          {d.gpu.next ? <div>下一条：<b>{d.gpu.next.label}</b>（{d.gpu.next.armed ? d.gpu.next.armedBy : d.gpu.next.approvedWaiting ? (d.gpu.next.approval?.note || '已放行，待挂') : d.gpu.next.reviewPending ? '待审' : '还没挂好'}）</div> : <div>下一条：<Missing m={{ missing: '暂无数据：缺下一条链' }} /></div>}
          {d.gpu.cutoffWarn ? <div className="text-amber-400">⚠ {d.gpu.cutoffWarn}</div> : null}
          {(d.gpu.waiters || []).filter((w, _i, all) => w.alive || (w.aborted && !all.some((x) => x.alive))).map((w) => <div key={w.name} className={w.aborted ? 'text-red-400' : 'text-[var(--fg-3)]'}>等待器 {w.name}{w.pid ? `（PID ${w.pid}）` : ''}：{w.aborted ? `已中止 · ${w.aborted.slice(20)}` : w.steps.map((x) => `${x.kind === 'wait' ? '等' : '起'}「${x.label}」${x.kind === 'wait' ? '跑完' : ''}${x.after ? `（--after=${x.after}）` : ''}·${({ waiting: '等待中', armed: '已挂好', done: '已完成', started: '已启动', dead: '不会再执行' })[x.status] || x.status}`).join(' → ')}</div>)}
          {d.gpu.today.value === null ? <Missing m={d.gpu.today} /> : <div title={d.gpu.today.note}>今天有任务 <b>{d.gpu.today.busyH}</b> 小时 · 任务占用率 <b>{pctTxt(d.gpu.today.occupancy)}</b> · 长暂停 {d.gpu.today.longPause.map((x) => `${x.from} 起 ${x.min} 分钟`).join('、') || '无'} · 其余 ≥2 分钟空档共 {d.gpu.today.shortGapsMin} 分钟（{d.gpu.today.shortGaps.length} 段）· 2 分钟以下碎空档约 {d.gpu.today.tinyGapsMin} 分钟</div>}
          <div>失败任务：累计 {d.gpu.failed.total ?? '—'}，今天 {d.gpu.failed.today ?? '—'} · 今天导出任务 {d.gpu.exportsToday?.done ?? '—'} 次（导出次数≠集数）· 写库领先量 {d.writeLead.value ?? <Missing m={d.writeLead} />} 镜<span className="text-[10px] text-[var(--fg-4)]">（{d.writeLead.note || ''}）</span></div>
          <div className="mt-1 text-[11px] text-[var(--fg-3)]">后面的队列（按脚本默认上游推出；时间是估算，单镜耗时同上）：</div>
          <table className="w-full text-[11px]"><tbody>
            {d.gpu.queue.map((q, i) => (
              <tr key={q.key} className="border-t border-[var(--line)]"><td className="pr-2">{i + 1}</td><td className="pr-2" title={q.key}><b>{q.label}</b>{q.mismatch ? <span className="ml-1 text-red-400">与参考顺序不一致</span> : null}</td><td className="pr-2" title={q.upstreamSrc || ''}>{q.armed ? (q.armedBy && q.armedBy.startsWith('已由等待器') ? <span className="text-green-400">已由等待器挂好</span> : '已挂好') : q.approvedWaiting ? <span className="text-sky-400" title={q.approval ? `${q.approval.by} ${q.approval.at} 放行` : ''}>{q.approval?.note || '已放行，待挂'}</span> : q.reviewPending ? <span className="text-amber-400">待审</span> : ({ ready: '脚本就绪未启动', waiting: '在等上游', stopped: '有日志但进程不在' })[q.state] || q.state}</td><td className="pr-2">{q.remaining} 镜</td><td className="pr-2">接在：{q.upstreamLabel || '—'}</td><td>约 {q.estMin ?? '—'} 分钟 · {ptHM(q.estStart)}–{ptHM(q.estEnd)}（估算）</td></tr>
            ))}
          </tbody></table>
          {d.gpu.conflicts?.length ? <div className="text-red-400">⚠ {d.gpu.conflicts.map((c) => `「${c.upstreamLabel}」后面接了 ${c.childLabels.join('、')} 两条以上`).join('；')}</div> : null}
          {d.gpu.blocks?.length ? <div className="text-[11px]">最近的拦截/停止：{d.gpu.blocks.map((b, i) => <div key={i} className="font-mono text-[10px] text-[var(--fg-3)]">{b.chain}：{b.line}</div>)}</div> : <div className="text-[11px] text-[var(--fg-4)]">今天各链日志里没有拦截或停止记录</div>}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="问题和返修（按集，点集跳到可编辑问题页）" right={<Stamp p={iss} sec={60} />}>
          {!iss.data ? <Missing m={{ missing: iss.error ? '暂时读不到：' + iss.error : '读取中…' }} /> : (
            <div className="max-h-[420px] overflow-auto"><table className="w-full text-[11px]"><thead><tr className="text-[var(--fg-3)]"><th className="text-left">集</th><th>条目</th><th>已修</th><th>修改中</th><th>待修改</th><th>正在修（估算）</th><th className="text-left">卡在哪个环节（推算）</th><th className="text-left">预计完成</th></tr></thead><tbody>
              {iss.data.eps.map((e) => (
                <tr key={e.no} className="cursor-pointer border-t border-[var(--line)] hover:bg-[var(--line)]" onClick={() => go('issues')}>
                  <td>第{e.no}集</td><td className="text-center">{e.items}</td><td className="text-center">{e.done}</td><td className="text-center">{e.doing}</td><td className="text-center">{e.todo}</td><td className="text-center" title={e.linkedShots?.length ? '关联镜头：#' + e.linkedShots.join(' #') + (e.drift != null ? `；时间轴与交付文件相差 ${e.drift} 秒` : '') : ''}>{e.open ? `${e.fixingN}/${e.open}` : '—'}{e.open && e.linkedN < e.open ? <span className="text-[var(--fg-4)]">（{e.open - e.linkedN} 未关联）</span> : null}</td>
                  <td><Pill tone={STAGE_TONE[e.stage] || 'gray'}>{e.stage}</Pill> <span className="text-[var(--fg-4)]">{e.chain || ''}</span></td><td>{e.eta ? `${ptHM(e.eta)}（估算）` : e.stage === '已完成' ? '—' : '未知'}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          <p className="mt-1 text-[10px] text-[var(--fg-4)]">来源：桌面 问题描述.txt（只读，md5 {iss.data?.md5?.slice(0, 8)}）+ 链镜单 + IC 镜头（只 GET）。「正在修」= 该条关联的镜头在未跑完的链里、已写库待排链、或导出后有新片（估算：按问题行时间点对到镜头；人工关联优先）。</p>
        </Card>
        <Card title="会话（登记的点一行跳到聊天页）" right={<Stamp p={ses} sec={60} />}>
          <p className="mb-2 text-[11px]">在工作 <b>{sesActive.length}</b> 个（最近 10 分钟会话文件有新内容；不等于正在执行，长时间工具调用可能不写文件 → 状态「未知」）</p>
          {(ses.data?.chat || []).map((s) => <div key={'c' + s.id} className="cursor-pointer border-t border-[var(--line)] py-1 text-[11px] hover:bg-[var(--line)]" onClick={() => go('chat', { sid: s.id })}>{s.role === 'main' ? '★ 主会话' : '◆ 辅助'} · {s.title} · {s.provider === 'claude' ? 'Claude' : 'Codex'} · {s.state} · {ptHM(s.lastActivity)}{s.last ? ` · ${s.last.text}` : ''}</div>)}
          {ses.data ? <p className="mt-1 text-[10px] text-[var(--fg-4)]">登记表：{ses.data.registryFile}（只覆盖指挥系统聊天里的会话）。下面是没登记、10 分钟内有动静的会话，点开到 AI 会话页：</p> : null}
          {sesActive.filter((s) => s.kind !== 'chat').length ? sesActive.filter((s) => s.kind !== 'chat').map((s) => (
            <div key={s.provider + s.id} className="cursor-pointer border-t border-[var(--line)] py-1 text-[11px] hover:bg-[var(--line)]" onClick={() => go('sessions', { provider: s.provider, sid: s.id })}>
              ● {s.provider === 'claude' ? 'Claude' : 'Codex'} · {ptHM(s.mtime)} · {s.last ? `最近（${s.last.role === 'user' ? '收到' : '回复'}）：${s.last.text}` : '最近消息读不到'}
            </div>
          )) : <p className="text-[11px] text-[var(--fg-4)]">最近 10 分钟没有会话文件更新。</p>}
        </Card>
      </div>

      <Card title="时间和良率（每项标自己的时间窗）" right={<Stamp p={tr} sec={600} />}>
        <div className="grid gap-2 text-xs md:grid-cols-2">
          <div>单镜渲染：中位 <b>{d.times.shotRender.median ?? '—'}</b> 秒、80 分位 {d.times.shotRender.p80 ?? '—'} 秒（{d.times.shotRender.window}，样本 {d.times.shotRender.n}；全量中位 {d.times.shotRender.medianAll} 秒，样本 {d.times.shotRender.nAll}）</div>
          <div>完整做一集的 GPU 时间：<Est e={d.times.perEpGpuMin} unit=" 分钟" /></div>
          <div>每集制作日历时间：<Est e={d.times.perEpCalendar} unit=" 小时" /></div>
          <div>修复时间：<Missing m={d.times.fixTime} /></div>
          <div>每镜平均出片次数：<b>{d.times.rerenderPerShot.value}</b> <span className="text-[10px] text-[var(--fg-4)]">（{d.times.rerenderPerShot.note}）</span></div>
          <div>预计验收完成日期：<Missing m={d.times.acceptDate} /></div>
          <div>只生成一次的镜头占比：<b>{pctTxt(d.yield.oneShot.value)}</b>（{d.yield.oneShot.num}/{d.yield.oneShot.den}，全量）<span className="text-[10px] text-[var(--fg-4)]"> {d.yield.oneShot.note}</span></div>
          <div>重生成任务成功率：<b>{pctTxt(d.yield.jobSuccess.value)}</b>（{d.yield.jobSuccess.done}/{d.yield.jobSuccess.done + d.yield.jobSuccess.failed}）<span className="text-[10px] text-[var(--fg-4)]"> {d.yield.jobSuccess.note}</span></div>
          <div>首次通过率：<Missing m={d.yield.firstPass} /></div>
        </div>
        {tr.data ? (
          <div className="mt-3 grid gap-4 md:grid-cols-3">
            <div><div className="text-[11px] text-[var(--fg-3)]">每日出片条数（近 7 天）</div><MiniBars rows={tr.data.days} field="videos" /></div>
            <div><div className="text-[11px] text-[var(--fg-3)]">只生成一次占比（按首次生成日期；灰色＝3 天观察窗未满）</div><MiniBars rows={tr.data.days} field="oneShotRate" fmt={(x) => Math.round(x * 100) + '%'} max={1} /></div>
            <div><div className="text-[11px] text-[var(--fg-3)]">每日 GPU 任务占用率</div><MiniBars rows={tr.data.days} field="occupancy" fmt={(x) => Math.round(x * 100) + '%'} max={1} /></div>
          </div>
        ) : <Missing m={{ missing: tr.error ? '暂时读不到：' + tr.error : '趋势计算中…' }} />}
      </Card>

      <Card title={`等 Andy 点头（${d.andy.real ?? 0} 项）`}>
        {d.andy.missing ? <Missing m={d.andy} /> : null}
        {(d.andy.items || []).map((x) => <div key={x.file} className="text-[11px]">{x.example ? <Pill tone="gray">示例</Pill> : null} {x.title}</div>)}
        <p className="mt-1 text-[10px] text-[var(--fg-4)]">{d.andy.note}</p>
      </Card>
      <p className="text-[10px] text-[var(--fg-4)]">全部只读：ic.db 只读打开（本轮 {d.sources.db.elapsedMs} 毫秒）· 交付目录只用 ffprobe 读 · chain.log 增量读（{d.sources.chainLogs} 个）· 问题描述.txt 只读。估算值点「估算」看样本数、时间窗和算法。</p>
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
  const q0 = new URLSearchParams(window.location.search);
  const [provider, setProvider] = useState(['claude', 'codex'].includes(q0.get('provider')) ? q0.get('provider') : 'claude');
  const [days, setDays] = useState(2);
  const [sel, setSel] = useState(q0.get('sid') || null);
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
  const lab = (c) => <span title={c.key}>{c.label || c.key}</span>;
  return (
    <section className="panel p-3 text-xs" data-gpu-bar>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-sm">GPU 状态</b>
        {g.idle ? <Pill tone="red">进程表里没有在跑的链（GPU 可能空闲）</Pill> : null}
        <span className="text-[10px] text-[var(--fg-4)]">单镜耗时（估算）：{g.perShotSec ? `${Math.round(g.perShotSec)} 秒，取今天最近 ${g.sampleCount} 个 done 的中位数` : '没有样本'} · {g.note}</span>
      </div>
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">当前</p>{r ? <><b>{lab(r)}</b> PID {r.pid} · 进度 {r.done}/{r.total}{r.current ? ` · 正在出 ${r.current.ch ? r.current.ch.replace('章', '集') : ''} 第${r.current.num}镜（提交于 ${r.current.at.slice(11)}）` : ''} · 预计跑完 {fmtEta(r.eta)}（估算）</> : '没有在跑的链'}</div>
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">下一条</p>{g.next ? <><b>{lab(g.next)}</b> · {g.nextArmed ? (g.nextArmedBy === 'waiter' ? `已由等待器挂好（${g.next.waiter?.name}，PID ${g.next.waiter?.pid}）` : '已挂好在等上游') : g.next.approvedWaiting ? (g.next.approval?.note || '已放行，待挂') : g.next.reviewPending ? '待审' : CH_STATE[g.next.state]?.[0]} · {g.next.total} 镜</> : '队列里没有下一条'}</div>
      </div>
      <div className="mb-2 grid gap-2 sm:grid-cols-2 text-[11px]">
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">推出的链序（脚本默认 --after，在跑的看命令行）</p>{(g.derived || []).map((d) => d.label).join(' → ') || '—'}{g.conflicts?.length ? <div className="text-red-400">⚠ {g.conflicts.map((c) => `「${c.upstreamLabel}」后面接了 ${c.childLabels.join('、')}`).join('；')}</div> : null}{g.superseded?.length ? <div className="text-[var(--fg-4)]">被新版取代、不计入：{g.superseded.map((x) => `${x.label}（${x.key} → ${x.by}）`).join('、')}</div> : null}</div>
        <div className="rounded border border-[var(--line)] p-2"><p className="section-label">参考顺序（以等待器为准）</p>{(g.reference || []).map((x) => x.label).join(' → ')}<div className="text-[10px] text-[var(--fg-4)]">{g.referenceNote}</div></div>
      </div>
      {(g.waiters || []).length ? <div className="mb-2 rounded border border-[var(--line)] p-2 text-[11px]"><p className="section-label">等待器（只读：进程命令行 + 脚本 + 它自己的日志）</p>{g.waiters.map((w) => <div key={w.file} className={w.alive ? '' : (w.aborted && !g.waiters.some((x) => x.alive)) ? 'text-red-400' : 'text-[var(--fg-4)]'}><b>{w.name}</b> · {w.alive ? `在运行 PID ${w.pid}` : '进程不在'} · {({ alive: '工作中', finished: '已跑完', aborted: '已中止', gone: '已结束' })[w.state]}{w.stopPresent ? ' · ⚠ 停止开关 arm_waiter.STOP 存在' : ''}<div>{w.steps.map((x) => `${x.kind === 'wait' ? '等' : '起'}「${x.label}」${x.kind === 'wait' ? '跑完' : ''}${x.after ? `（--after=${x.after}）` : ''}：${({ waiting: '等待中', armed: '已挂好', done: '已完成', started: '已启动', dead: '不会再执行' })[x.status] || x.status}${x.at ? ` ${x.at.slice(11)}` : ''}`).join(' → ')}</div><div className="text-[10px] text-[var(--fg-4)]" title={w.log}>日志末行：{w.lastLine || '—'}</div>{w.aborted ? <div>中止：{w.aborted}{g.waiters.some((x) => x.alive) ? '（已有在运行的等待器接替）' : ''}</div> : null}</div>)}</div> : null}
      <table className="w-full text-[11px]"><thead><tr className="text-left text-[var(--fg-3)]"><th>顺序</th><th>链</th><th>状态</th><th>进度</th><th>镜单</th><th>脚本上游</th><th>参考上游</th><th>预计跑完（估算）</th></tr></thead>
        <tbody>{g.chains.map((c, i) => (
          <tr key={c.key} className={'border-t border-[var(--line)] align-top ' + (c.mismatch ? 'bg-red-500/10' : '')}>
            <td>{i + 1}</td><td>{lab(c)}{c.unlisted && <span className="ml-1 text-[10px] text-amber-400">（不在参考顺序里）</span>}{c.logNote ? <div className="text-[10px] text-[var(--fg-4)]">{c.logNote}</div> : null}</td><td>{c.waiterArmed ? <Pill tone="green">已由等待器挂好</Pill> : c.approvedWaiting ? <><Pill tone="blue">已放行，待挂</Pill><div className="text-[10px] text-[var(--fg-4)]">{c.approval?.note}{c.approval ? ` · ${c.approval.by} ${String(c.approval.at).slice(11, 16)} 放行` : ''}</div></> : c.reviewPending ? <Pill tone="yellow">待审</Pill> : <Pill tone={CH_STATE[c.state]?.[1]}>{CH_STATE[c.state]?.[0]}</Pill>}{c.waiter && !c.waiterArmed ? <div className="text-[10px] text-[var(--fg-4)]">等待器：{({ waiting: '在等它跑完', done: '已确认跑完', started: '已由等待器启动', dead: '等待器不会再执行' })[c.waiter.status] || c.waiter.status}</div> : null}</td>
            <td>{c.placeholder ? '—' : `${c.done}/${c.total}`}</td>
            <td className="max-w-[320px] break-all">{(c.shots || []).map((s) => `${s.ch.replace('第', '').replace('章', '')}#${s.num}${s.done ? '✓' : ''}`).join(' ') || '—'}</td>
            <td>{c.upstreamLabel || '—'}<div className="text-[10px] text-[var(--fg-4)]">{c.upstreamSrc}{c.pid ? ` · PID ${c.pid}` : ''}</div></td>
            <td className={c.mismatch ? 'text-red-400' : ''}>{c.refPrev === undefined ? '（不在参考里）' : c.refPrevLabel || '—'}{c.mismatch ? ' · 不一致' : ''}</td>
            <td>{c.state === 'done' ? `完成于 ${String(c.doneAt).slice(11)}` : fmtEta(c.eta)}</td>
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
    else setMsg({ tone: 'green', text: j.key ? `已保存关联（只写预览目录）：${j.value ? '#' + j.value.shots.join(' #') : '已清除，回到按时间点推算'}` : j.suggested ? 'AI 不能直接改：已进待确认队列，等 Andy 或总导确认' : j.made != null ? `生成了 ${j.made} 条建议，已进待确认队列` : `已写入（备份 ${j.backup || '—'}，新 md5 ${j.afterMd5 || '—'}）` });
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
                            <span className="text-[10px] text-[var(--fg-4)]">{it.status === 'done' ? '已完成' : it.links?.shots?.length ? <>镜头 {it.links.shots.map((x) => <span key={x.idx} className={x.fixing ? 'text-sky-400' : ''} title={x.chain || ''}>#{x.idx}·{x.step}{x.how ? `（${x.how}）` : ''} </span>)}{it.links.src === 'auto' ? <span title={'按时间点 ' + it.links.times.join('、') + ' 对到镜头'}>（估算）</span> : <span>（人工关联 {it.links.manual?.by}）</span>}</> : <span className="text-amber-400">未关联：{it.links?.why || '—'}</span>} · 预计：{it.status === 'done' ? '—' : e.stage.eta ? '按本集 ' + fmtEta(e.stage.eta) + '（估算）' : '未知'} · L{it.start + 1}</span>
                            {it.status !== 'done' ? <button type="button" className="rounded border border-[var(--line)] px-1.5 text-[10px]" onClick={() => { const v = window.prompt(`第${e.no}集：输入关联镜号（如 3 5 12），留空 = 清除人工关联、回到按时间点推算`, it.links?.src === 'manual' ? it.links.manual.shots.join(' ') : (it.links?.shots || []).map((x) => x.idx).join(' ')); if (v === null) return; post('/api/issues/links', { episode: e.no, text: it.text, shots: v }); }}>关联镜头</button> : null}
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

// ======================= 聊天（主会话 + 辅助会话） =======================
const MAX_OPEN = 2; // 同时展开的会话不超过 2 个（§8.2）
const KEEP_MSGS = 120; // 每个展开的会话内存里最多留 120 条，超出就卸载另一头
const ROLE_LABEL = { user: '指令', assistant: '回复', system: '系统' };
function ChatPanel({ sid, summary, onClose }) {
  const [msgs, setMsgs] = useState([]);
  const [info, setInfo] = useState({ total: 0, hasMore: false, hasNewer: false });
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timing, setTiming] = useState(null);
  const ctrl = useRef(null);
  const boxRef = useRef(null);
  const msgsRef = useRef([]);
  msgsRef.current = msgs;
  const req = useCallback(async (url, opts = {}) => {
    const ac = new AbortController(); ctrl.current = ac;
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }, []);
  const loadLatest = useCallback(async () => {
    const t0 = performance.now(); setLoading(true);
    try {
      const j = await req(`/api/chat/sessions/${sid}/messages`);
      setMsgs(j.messages); setInfo({ total: j.total, hasMore: j.hasMore, hasNewer: false, from: j.from });
      setTiming({ kind: '首屏', ms: Math.round(performance.now() - t0), n: j.messages.length });
      requestAnimationFrame(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; });
    } catch (e) { if (e.name !== 'AbortError') setErr(String(e.message)); } finally { setLoading(false); }
  }, [sid, req]);
  const loadOlder = useCallback(async () => {
    const cur = msgsRef.current; if (!cur.length || loading) return;
    const t0 = performance.now(); setLoading(true);
    try {
      const j = await req(`/api/chat/sessions/${sid}/messages?before=${cur[0].seq}&limit=30`);
      const prevH = boxRef.current ? boxRef.current.scrollHeight : 0;
      let next = [...j.messages, ...cur]; let trimmed = false;
      if (next.length > KEEP_MSGS) { next = next.slice(0, KEEP_MSGS); trimmed = true; }
      setMsgs(next); setInfo((i) => ({ ...i, hasMore: j.hasMore, hasNewer: i.hasNewer || trimmed }));
      setTiming({ kind: '上翻', ms: Math.round(performance.now() - t0), n: j.messages.length });
      requestAnimationFrame(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight - prevH; });
    } catch (e) { if (e.name !== 'AbortError') setErr(String(e.message)); } finally { setLoading(false); }
  }, [sid, req, loading]);
  const pollNew = useCallback(async () => {
    const cur = msgsRef.current; if (info.hasNewer) return;
    const last = cur.length ? cur[cur.length - 1].seq : -1;
    try {
      const j = await req(`/api/chat/sessions/${sid}/messages?after=${last}&limit=30`);
      if (j.messages.length) {
        let next = [...cur, ...j.messages]; if (next.length > KEEP_MSGS) next = next.slice(next.length - KEEP_MSGS);
        setMsgs(next); setInfo((i) => ({ ...i, total: j.total, hasMore: i.hasMore || next[0].seq > 0 }));
        requestAnimationFrame(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; });
      }
    } catch {}
  }, [sid, req, info.hasNewer]);
  useEffect(() => { loadLatest(); return () => { ctrl.current?.abort(); setMsgs([]); }; }, [loadLatest]); // 折叠/离开时卸载
  useEffect(() => { const t = setInterval(pollNew, summary?.status === 'busy' ? 2500 : 6000); return () => clearInterval(t); }, [pollNew, summary?.status]);
  const expand = async (m) => {
    try { const full = await req(`/api/chat/sessions/${sid}/messages/${m.seq}`); setMsgs((cur) => cur.map((x) => (x.seq === m.seq ? { ...full, expanded: true } : x))); } catch (e) { setErr(String(e.message)); }
  };
  const sendMsg = async () => {
    setErr(null);
    try { await req(`/api/chat/sessions/${sid}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); setText(''); setTimeout(pollNew, 300); }
    catch (e) { setErr(String(e.message)); }
  };
  const stop = async () => { try { await req(`/api/chat/sessions/${sid}/stop`, { method: 'POST' }); } catch (e) { setErr(String(e.message)); } };
  const busy = summary?.status === 'busy'; const stopped = summary?.status === 'stopped';
  return (
    <section className="panel flex min-w-0 flex-1 flex-col p-3 text-xs" data-chat-panel={sid}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-sm">{summary?.title || sid}</b>
        <Pill tone={summary?.role === 'main' ? 'blue' : 'gray'}>{summary?.role === 'main' ? '主会话' : '辅助'}</Pill>
        <Pill tone="gray">{summary?.provider}</Pill>
        <Pill tone={busy ? 'yellow' : stopped ? 'red' : 'green'}>{busy ? '回复中' : stopped ? '已停' : '空闲'}</Pill>
        <span className="text-[10px] text-[var(--fg-4)]">共 {info.total} 条 · 内存里 {msgs.length} 条{timing ? ` · ${timing.kind} ${timing.ms}ms` : ''}</span>
        <span className="flex-1" />
        {summary?.role === 'aux' && !stopped ? <button type="button" className="rounded border border-[var(--line)] px-2" onClick={stop}>停止</button> : null}
        <button type="button" className="rounded border border-[var(--line)] px-2" onClick={onClose}>折叠（卸载）</button>
      </div>
      <div ref={boxRef} className="flex h-[460px] flex-col gap-1.5 overflow-auto rounded-lg border border-[var(--line)] p-2" onScroll={(e) => { if (e.currentTarget.scrollTop < 40 && info.hasMore) loadOlder(); }}>
        {info.hasMore ? <button type="button" className="self-center text-[10px] text-[var(--accent)]" onClick={loadOlder}>{loading ? '加载中…' : '↑ 加载更早的 30 条'}</button> : <span className="self-center text-[10px] text-[var(--fg-4)]">— 会话开头 —</span>}
        {msgs.map((m) => (
          <div key={m.seq} data-seq={m.seq} className={'rounded-lg p-1.5 ' + (m.role === 'user' ? 'self-end bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]' : m.role === 'system' ? 'self-center text-[10px] text-[var(--fg-3)]' : 'self-start bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]')} style={{ maxWidth: '92%' }}>
            {m.role !== 'system' ? <div className="mb-0.5 text-[9px] text-[var(--fg-4)]">#{m.seq} {ROLE_LABEL[m.role] || m.role}{m.from ? ' · ' + m.from : ''} · {fmtTime(m.ts)}{m.ms ? ` · ${Math.round(m.ms / 1000)}s` : ''}</div> : null}
            <div className="whitespace-pre-wrap break-all">{m.text}</div>
            {m.truncated ? <button type="button" className="text-[10px] text-[var(--accent)]" onClick={() => expand(m)}>展开全文（{m.fullLength} 字，点开才加载）</button> : null}
          </div>
        ))}
        {info.hasNewer ? <button type="button" className="self-center text-[10px] text-[var(--accent)]" onClick={loadLatest}>↓ 回到最新（较新的消息已卸载）</button> : null}
      </div>
      <Err e={err} />
      <div className="mt-2 flex gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={busy || stopped} placeholder={stopped ? '会话已停' : busy ? '等它答完' : summary?.role === 'main' ? '给主会话发指令（只读问答、写派工单草稿）' : '直接给这个辅助会话发指令（同时抄送主会话记录）'} className="flex-1 rounded-lg border border-[var(--line)] bg-transparent p-2" />
        <button type="button" disabled={busy || stopped || !text.trim()} onClick={sendMsg} className="rounded-lg border border-[var(--accent)] px-3 text-[var(--accent)] disabled:opacity-40">发送</button>
      </div>
    </section>
  );
}
function Chat() {
  const list = useJson('/api/chat/sessions');
  const [open, setOpen] = useState(() => { const sid = new URLSearchParams(window.location.search).get('sid'); return sid && sid !== 'main' ? ['main', sid] : ['main']; });
  const [form, setForm] = useState({ title: '', provider: 'claude', instruction: '' });
  const [msg, setMsg] = useState(null);
  useEffect(() => { const t = setInterval(list.reload, 5000); return () => clearInterval(t); }, [list.reload]);
  const byId = Object.fromEntries((list.data?.sessions || []).map((s) => [s.id, s]));
  const toggle = (id) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id].slice(-MAX_OPEN)));
  const openAux = async () => {
    setMsg(null);
    const r = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, parent: 'Andy（手动）' }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? (j.queued ? `已排队：${j.reason}` : `已开启 ${j.id}`) : j.error); list.reload();
    if (r.ok && j.id) setOpen((o) => [...o, j.id].slice(-MAX_OPEN));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="panel p-3 text-xs">
        <b>聊天（预览）</b>：一个固定主会话统一接收 Andy 的指令；辅助会话由主会话按需开启（回复里写 [[开辅助:标题:指令]]），用完停。
        辅助会话上限 <b>{list.data?.maxAux ?? '—'}</b> 个（现开 {list.data?.activeAux ?? '—'}），空闲 <b>{list.data?.idleMinutes ?? '—'}</b> 分钟自动停；同时最多展开 {MAX_OPEN} 个会话，折叠即卸载。
        会话只有只读工具（Read/Grep/Glob），工作目录限在聊天沙箱；不写库、不提交 GPU。各方分工照旧，真实工作不切到这里。
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="panel p-2 lg:w-[250px] lg:shrink-0">
          <p className="section-label px-1 pb-1">会话（只拉摘要）</p>
          {(list.data?.sessions || []).map((s) => (
            <button key={s.id} type="button" onClick={() => toggle(s.id)} data-session={s.id} className={'mb-1 w-full rounded-lg border p-1.5 text-left text-[11px] ' + (open.includes(s.id) ? 'border-[var(--accent)]' : 'border-[var(--line)]')}>
              <div className="flex items-center gap-1"><b className="flex-1 truncate">{s.title}</b><span className="text-[9px]">{s.role === 'main' ? '主' : '辅'}·{s.provider}</span></div>
              <div className="text-[9px] text-[var(--fg-4)]">{s.status === 'busy' ? '回复中' : s.status === 'stopped' ? '已停' : '空闲'} · {s.msgCount} 条 · {fmtTime(s.lastActivity)}</div>
              <div className="truncate text-[10px] text-[var(--fg-3)]">{s.lastSnippet}</div>
            </button>
          ))}
          {list.data?.pending?.length ? <div className="mt-1 text-[10px] text-[#d97706]">排队中：{list.data.pending.map((q) => `「${q.title}」${q.reason}`).join('；')}</div> : null}
          <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px]">
            <p className="section-label pb-1">手动开辅助会话（演示用）</p>
            <input className="mb-1 w-full rounded border border-[var(--line)] bg-transparent px-1" placeholder="标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <select className="mb-1 w-full rounded border border-[var(--line)] bg-transparent" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="claude">Claude</option><option value="codex" disabled>Codex（聊天里暂停：缺读取限制）</option><option value="kimi">Kimi（未启用）</option></select>
            <textarea className="mb-1 w-full rounded border border-[var(--line)] bg-transparent px-1" rows={2} placeholder="第一条指令（可空）" value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} />
            <button type="button" className="rounded border border-[var(--line)] px-2" onClick={openAux}>开启</button>
            {msg ? <p className="mt-1 text-[10px]">{msg}</p> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 xl:flex-row">
          {open.map((id) => <ChatPanel key={id} sid={id} summary={byId[id]} onClose={() => toggle(id)} />)}
          {!open.length ? <p className="text-xs text-[var(--fg-3)]">点左边的会话展开。</p> : null}
        </div>
      </div>
    </div>
  );
}

export default function CommandPage() {
  const init = new URLSearchParams(window.location.search).get('sub');
  const [sub, setSub] = useState(init === 'episodes' ? 'issues' : SUBS.some((s) => s.id === init) ? init : 'overview');
  const go = (id, extra) => {
    setSub(id);
    const q = new URLSearchParams(); q.set('mode', 'command'); q.set('sub', id);
    if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v);
    window.history.replaceState(null, '', '/?' + q.toString());
  };
  const cur = SUBS.find((s) => s.id === sub);
  return (
    <div className="flex flex-col gap-4">
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
        <FileSearch size={14} className="text-[var(--accent)]" />
        <b>指挥系统 · 预览</b>
        <Pill tone="yellow">没有任何写库 / 放行 / 导出 / 提交 GPU 按钮；问题描述编辑只写测试副本；聊天只写聊天沙箱、AI 只有只读工具</Pill>
        <span className="text-[var(--fg-3)]">AI：Claude 启用 · Codex 启用（聊天里暂停：缺读取限制） · Muse 经资产管理 · Kimi 未启用 · 派工页只读（发单要 Andy 批上线）</span>
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
          {sub === 'overview' ? <Overview go={go} /> : null}
          {sub === 'issues' ? <Issues /> : null}
          {sub === 'chat' ? <Chat /> : null}
          {sub === 'sessions' ? <Sessions /> : null}
          {sub === 'evidence' ? <Evidence /> : null}
          {sub === 'dispatch' ? <Dispatch /> : null}
          {!READY.has(sub) ? <Placeholder sub={cur} /> : null}
        </div>
      </div>
    </div>
  );
}
