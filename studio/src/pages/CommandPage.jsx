import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Pencil, Activity, BookCheck, ClipboardList, Cpu, Database, FileSearch, Gauge, MessagesSquare, RefreshCw, ScrollText, Send, Film, Settings as SettingsIcon } from 'lucide-react';

// 指挥系统 第一期：只读预览。本页没有任何写操作按钮。
// 2026-11-25 Andy：「老的都迭代下，没必要的就删了，信息太多」——菜单只留在用的 5 页；占位页、旧派工/证据页、重复的按集看板去掉
const SUBS = [
  { id: 'overview', label: '总览', icon: Activity, phase: 1 },
  { id: 'issues', label: '问题', icon: Pencil, phase: 1 },
  { id: 'chat', label: '会话', icon: MessagesSquare, phase: 1 }, // 聊天和会话合成一页（Andy 11-26）
  { id: 'settings', label: '设置', icon: SettingsIcon, phase: 1 },
];
const READY = new Set(['overview', 'issues', 'chat', 'settings']);

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
      <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
    </button>
  );
}
function Err({ e }) { return e ? <p className="text-xs text-red-500">读取失败：{e}</p> : null; }
const Pre = ({ children, max = 360 }) => (
  <pre style={{ maxHeight: max }} className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] p-2 text-[11px] leading-relaxed">{children}</pre>
);

// ---------------- 总览（按 总览设计稿.md 46A57B04） ----------------
function usePoll(url, sec, refreshKey = 0) {
  const [st, setSt] = useState({ data: null, at: null, error: null, ok: null, loading: true });
  useEffect(() => {
    let alive = true, timer = null, first = refreshKey > 0;
    const tick = async () => {
      try {
        const u = first ? url + (url.includes('?') ? '&' : '?') + 'force=1' : url; first = false;
        if (alive) setSt((s) => ({ ...s, loading: true }));
        const r = await fetch(u, { cache: 'no-store' }); const j = await r.json();
        if (!alive) return;
        setSt((s) => ({ data: j.data ?? s.data, at: j.at, ok: j.ok, error: j.ok ? null : (j.error || '读取失败'), loading: false }));
      } catch (e) { if (alive) setSt((s) => ({ ...s, ok: false, error: String(e.message || e), loading: false })); }
      if (alive) timer = setTimeout(tick, sec * 1000); // 上一轮完了才排下一轮，不重叠
    };
    tick();
    return () => { alive = false; clearTimeout(timer); }; // 离开页面停止轮询
  }, [url, sec, refreshKey]);
  return st;
}
// 总览选的项目（记在本机浏览器里）；默认是后台的默认项目
function useOverviewProject() {
  const list = usePoll('/api/command/ov?part=projects', 300);
  const [pid, setPid] = useState(() => { try { return localStorage.getItem('cmd.overview.project') || ''; } catch { return ''; } });
  const projects = list.data?.projects || [];
  const cur = projects.find((x) => x.id === pid) || projects.find((x) => x.isDefault) || null;
  const choose = (id) => { setPid(id); try { localStorage.setItem('cmd.overview.project', id); } catch {} };
  return { projects, cur, id: cur?.id || '', choose };
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
// 看门狗卡片（CLA-34）：心跳正常绿；心跳 >25 秒没更新红「看门狗停了」；有严重告警也红
function WatchdogCard() {
  const w = usePoll('/api/command/watchdog', 5);
  const [open, setOpen] = useState(false);
  const [moreLog, setMoreLog] = useState(false);
  const d = w.data;
  const [, f] = useState(0); useEffect(() => { const t = setInterval(() => f((x) => x + 1), 5000); return () => clearInterval(t); }, []);
  const age = d?.heartbeat?.at ? Math.round((Date.now() - new Date(d.heartbeat.at).getTime()) / 1000) : null;
  const stale = !d || age == null || age > (d.staleAfterSec || 25) || w.ok === false;
  const errs = (d?.alerts || []).filter((a) => a.level === 'ERROR');
  const tone = stale || errs.length ? 'red' : (d?.alerts || []).some((a) => a.level !== 'INFO') ? 'yellow' : 'green';
  const label = stale ? '看门狗停了' : errs.length ? `${errs.length} 个严重告警` : (d?.alerts || []).length ? `${d.alerts.length} 个注意` : '正常';
  const alerts = d?.alerts || [];
  const hb = d?.heartbeat ? `心跳 ${ptHM(d.heartbeat.at)}（${age} 秒前）· 第 ${d.heartbeat.round} 轮 · ${d.heartbeat.ms} 毫秒 · 每 ${d.heartbeat.intervalSec} 秒一轮 · 自动恢复 ${d.config?.recoveryMode === 'live' ? '开' : 'dry'}` : '没有心跳';
  return (
    <section data-watchdog={tone} className="panel px-3 py-2" style={{ borderColor: tone === 'red' ? '#dc2626' : tone === 'green' ? '#16a34a' : undefined }}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <b className="text-sm">看门狗</b><Info t={hb + (w.error ? ` · 接口读不到：${w.error}` : '') + (stale ? ' · 心跳超过 2 个周期没更新，保活任务每分钟会拉起它' : '')} />
        <Pill tone={tone}>{stale ? '看门狗停了' : errs.length ? `${errs.length} 个严重` : alerts.some((a) => a.level !== 'INFO') ? `${alerts.filter((a) => a.level !== 'INFO').length} 个注意` : '正常'}</Pill>{d?.heartbeat?.at ? <span className="text-[10px] text-[var(--fg-4)]">最近检查 {ptMDHM(d.heartbeat.at)}</span> : null}
        {/* 同类告警合并成一个标签 + ×N（例如补绑定的几十条「外部 PATCH 改镜头」），首屏不铺满 */}
        {Object.values(alerts.reduce((g, a) => { const k = a.level + '|' + String(a.title || '').replace(/[（(][^）)]*[）)]\s*$/, '').replace(/\d+/g, 'N'); (g[k] = g[k] || { a, n: 0 }).n++; return g; }, {})).slice(0, 6).map(({ a, n }) => <span key={a.key} className={'rounded px-1.5 py-0.5 text-[11px] ' + (a.level === 'ERROR' ? 'bg-red-500/15 text-red-400' : a.level === 'INFO' ? 'bg-sky-500/15 text-sky-400' : 'bg-amber-500/15 text-amber-400')} title={`${a.text}（${ptMDHM(a.since)} 起）`}>{ptHM(a.since)} {shortTxt(a.title, 26)}{n > 1 ? ` ×${n}` : ''}</span>)}
        <button type="button" className="ml-auto rounded border border-[var(--line)] px-2 text-[11px] text-[var(--fg-3)]" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '原文'}</button>
      </div>
      {open ? <div className="mt-2 flex flex-col gap-0.5 text-[11px]">{alerts.map((a) => <div key={a.key} className={a.level === 'ERROR' ? 'text-red-400' : a.level === 'INFO' ? 'text-sky-400' : 'text-amber-400'}><span className="mr-1 font-mono text-[var(--fg-3)]">{ptMDHM(a.since)}（{agoTxt(a.since)}）</span>{a.level === 'ERROR' ? '严重' : a.level === 'INFO' ? '信息' : '注意'} · {a.title}<div className="ml-4 text-[var(--fg-3)]">{a.text}</div></div>)}</div> : null}
      {open ? <div className="mt-2 flex flex-col gap-0.5 text-[11px] text-[var(--fg-3)]"><div className="font-sans text-[11px] text-[var(--fg-4)]">最近的变化：</div>
        {(d?.changes || []).slice(0, moreLog ? 50 : 10).map((c, i) => <div key={i} className="border-t border-[var(--line)] py-0.5 first:border-t-0">{c.msg}</div>)}
        {(d?.changes || []).length > 10 ? <button type="button" className="self-start text-[var(--accent)]" onClick={() => setMoreLog((x) => !x)}>{moreLog ? '只看最近 10 条' : `更多（共 ${(d?.changes || []).length} 条）`}</button> : null}
        <div className="mt-1 font-sans text-[11px]">自动恢复记录：</div>
        {(d?.recoveries || []).length ? d.recoveries.map((r, i) => <div key={'r' + i}>{ptHM(r.at)} {r.chain} {r.ok ? (r.live ? (r.started ? '已重启' : '重启失败') : '条件满足（dry，没执行）') : '不满足：' + (r.reasons || []).join('；')} · {r.cmd}</div>) : <div>无</div>}
      </div> : null}
    </section>
  );
}
// ---------- 图形小件（总览 / GPU 面板共用） ----------
const C = { green: '#16a34a', amber: '#d97706', red: '#dc2626', blue: '#2563eb', gray: '#6b7280' };
// 「第N章#M」；没有镜号的任务（IC 生成新章节剧本分镜等）写任务名，不显示 null
const JOB_ZH = { create: '生成剧本分镜', regenerate: '出片', 'prompt-write': '写提示词', export: '导出' };
const shotLabel = (c) => { if (!c) return ''; const ch = c.ch != null ? `第${c.ch}章` : ''; if (c.num != null) return `${ch}#${c.num}`; return [ch, JOB_ZH[c.type] || c.type || 'IC 任务'].filter(Boolean).join(' · '); };
const ptMDHM = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const agoTxt = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟前` : `${Math.floor(m / 1440)} 天前`; };
const shortTxt = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hm = (ms) => { if (ms == null) return '—'; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const mmss = (sec) => { if (sec == null || !isFinite(sec)) return '—'; const s = Math.max(0, Math.round(sec)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`; };
const tok = (n) => (n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n));
const pct0 = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
function Info({ t }) { return t ? <span className="cursor-help text-[11px] text-[var(--fg-4)]" title={t}>ⓘ</span> : null; }
function Dot({ c }) { return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />; }
function Big({ v, unit, sub, c }) { return <div><div className="text-2xl font-semibold leading-tight" style={c ? { color: c } : undefined}>{v}{unit ? <span className="ml-0.5 text-xs font-normal text-[var(--fg-3)]">{unit}</span> : null}</div>{sub ? <div className="text-[11px] text-[var(--fg-3)]">{sub}</div> : null}</div>; }
function NoData() { return <span className="text-[11px] text-[var(--fg-4)]">暂无数据</span>; }
function Head({ t, info, right }) { return <div className="mb-2 flex items-center gap-1.5"><b className="shrink-0 whitespace-nowrap text-sm">{t}</b><Info t={info} />{right ? <span className="ml-auto">{right}</span> : null}</div>; }
// 横向分段条：segs = [{ n, c, label }]
function Stack({ segs, h = 8, showN = true }) {
  const tot = segs.reduce((a, s) => a + (s.n || 0), 0);
  return (
    <div className="flex w-full overflow-hidden rounded" style={{ height: h, background: 'var(--line)' }} title={segs.map((s) => `${s.label} ${s.n}`).join(' · ')}>
      {tot ? segs.filter((s) => s.n).map((s) => <div key={s.label} style={{ width: `${(s.n / tot) * 100}%`, background: s.c }} className="flex items-center justify-center text-[9px] leading-none text-white">{showN && h >= 12 && s.n / tot > 0.06 ? s.n : ''}</div>) : null}
    </div>
  );
}
function Prog({ done, total, c = 'var(--accent)' }) { return <div className="h-1.5 w-full rounded bg-[var(--line)]"><div className="h-1.5 rounded" style={{ width: `${total ? Math.min(100, (done / total) * 100) : 0}%`, background: c }} /></div>; }
// 每小时柱（纯 CSS）：rows = [{ at, n }]
function HourBars({ rows, h = 40 }) {
  const m = Math.max(1, ...rows.map((r) => r.n || 0));
  return (
    <div className="flex items-end gap-[2px]" style={{ height: h + 12 }}>
      {rows.map((r) => { const t = new Date(r.at ?? r.from); const hh = t.toLocaleTimeString('zh-CN', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit' }); return (
        <div key={String(r.at ?? r.from)} className="flex flex-1 flex-col items-center justify-end" title={`${hh} 点：出片 ${r.n} 镜`}>
          {r.n ? <span className="text-[9px] leading-3 text-[var(--fg-3)]">{r.n}</span> : null}
          <div className="w-full rounded-t" style={{ height: r.n ? Math.max(2, (r.n / m) * h) : 1, background: r.n ? 'var(--accent)' : 'var(--line)' }} />
          <span className="text-[8px] leading-3 text-[var(--fg-4)]">{hh}</span>
        </div>); })}
    </div>
  );
}
// 实时计时（mm:ss）
function Ticker({ since }) {
  const [, f] = useState(0); useEffect(() => { const t = setInterval(() => f((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  if (!since) return null;
  return <span className="font-mono tabular-nums">{mmss((Date.now() - new Date(since).getTime()) / 1000)}</span>;
}
// 今天的忙闲时间条（太平洋时间 0 点到 24 点；忙＝绿，闲＝灰，无数据＝斜纹，未来＝空）
function DayBar({ bar }) {
  if (!bar) return <NoData />;
  const span = bar.dayEnd - bar.from; const x = (t) => `${((t - bar.from) / span) * 100}%`; const w = (a, b) => `${((b - a) / span) * 100}%`;
  return (
    <div>
      <div className="relative h-4 w-full overflow-hidden rounded" style={{ background: 'color-mix(in srgb, var(--fg) 4%, transparent)' }}>
        <div className="absolute inset-y-0" style={{ left: 0, width: w(bar.from, bar.to), background: 'color-mix(in srgb, var(--fg) 14%, transparent)' }} title="闲" />
        {bar.noDataBefore ? <div className="absolute inset-y-0" style={{ left: 0, width: w(bar.from, bar.noDataBefore), background: 'repeating-linear-gradient(45deg, var(--line) 0 3px, transparent 3px 6px)' }} title="无数据" /> : null}
        {(bar.busy || []).map(([a, b]) => <div key={a} className="absolute inset-y-0" style={{ left: x(a), width: w(a, b), minWidth: 1, background: C.green }} title={`忙 ${ptHM(a)}–${ptHM(b)}`} />)}
        <div className="absolute inset-y-0 w-px bg-[var(--fg-3)]" style={{ left: x(bar.to) }} title="现在" />
      </div>
      <div className="flex justify-between text-[9px] text-[var(--fg-4)]">{[0, 6, 12, 18, 24].map((h) => <span key={h}>{h}</span>)}</div>
    </div>
  );
}
const EP_C = { delivered: C.green, open: C.amber, none: 'var(--line)' };
function EpGrid({ grid, onPick }) {
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
      {grid.map((g) => <div key={g.ep} onClick={onPick ? () => onPick(g.ep) : undefined} className={'flex h-5 items-center justify-center rounded-sm text-[9px]' + (onPick ? ' cursor-pointer hover:opacity-80' : '')} style={{ background: g.twoK && g.state === 'delivered' ? C.blue : EP_C[g.state], color: g.state === 'none' ? 'var(--fg-4)' : '#fff', boxShadow: g.twoK && g.state !== 'delivered' ? `inset 0 0 0 1.5px ${C.blue}` : undefined }} title={`EP${g.ep}：${g.state === 'delivered' ? '已交付' : g.state === 'open' ? `有 ${g.open} 条未完成问题${g.delivered ? '（已交付）' : ''}` : '未交付'}${g.twoK ? ' · 2K' : ''}${onPick ? ' · 点开看这一集的问题' : ''}`}>{g.ep}</div>)}
    </div>
  );
}
const ISS_SEG = (x) => [{ label: '待修改', n: x.todo || 0, c: C.red }, { label: '修改中', n: x.doing || 0, c: C.amber }, { label: '完成', n: x.done || 0, c: C.green }];
function Legend({ items }) { return <div className="flex flex-wrap gap-2 text-[10px] text-[var(--fg-3)]">{items.map(([l, c]) => <span key={l} className="flex items-center gap-1"><Dot c={c} />{l}</span>)}</div>; }

// ---------- 总览（首屏：产能 → 大数字 → 正在做 → 看门狗 → 用量 / 规则 / 问题归类；其余折叠） ----------
// 会话卡（2026-11-25 重做）：只列名字、在不在干活、最后动静时间；不贴对话原文
function SessionsMini({ go, rk = 0 }) {
  const ses = usePoll('/api/command/ov?part=sessions', 60, rk);
  const d = ses.data;
  const chat = (d?.chat || []).filter((s) => s.role === 'main' || s.status === 'busy');
  const files = (d?.active || []).filter((s) => s.kind === 'file');
  const desk = files.filter((s) => s.group !== 'ic'); const ic = files.filter((s) => s.group === 'ic');
  const Row = ({ dot, name, sub, at, onClick }) => (
    <div className={'flex items-center gap-2 border-t border-[var(--line)] py-1 text-[11px] first:border-t-0 ' + (onClick ? 'cursor-pointer hover:bg-[var(--line)]' : '')} onClick={onClick}>
      <Dot c={dot} /><span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>{sub ? <span className="shrink-0 text-[10px] text-[var(--fg-4)]">{sub}</span> : null}<span className="shrink-0 tabular-nums text-[var(--fg-3)]">{at ? ptHM(at) : '—'}</span>
    </div>);
  return (
    <section className="panel col-span-2 p-3">
      <Head t="会话" info="最近 10 分钟有动静的会话。绿点＝正在回复/在干活；时间＝最后一次动静（太平洋时间）。点主会话进聊天。" right={d ? <span className="text-xl font-semibold">{chat.length + desk.length}<span className="text-xs font-normal text-[var(--fg-3)]"> 个在动{ic.length ? ` · IC 写稿 ${ic.length}` : ''}</span></span> : null} />
      {!d ? <NoData /> : (
        <div className="flex flex-col">
          {chat.map((s) => <Row key={'c' + s.id} dot={s.status === 'busy' ? C.green : C.gray} name={s.role === 'main' ? '主会话（指挥）' : s.title} sub={s.status === 'busy' ? '正在回复' : '空闲'} at={s.lastActivity} onClick={() => go('chat', { sid: s.id })} />)}
          {desk.slice(0, 6).map((s) => <Row key={s.id} dot={C.green} name={s.name} at={s.mtime} onClick={() => go('chat', { live: `${s.provider}:${s.id}` })} />)}
          {ic.length ? <Row dot={C.blue} name={`IC 内部写稿 Agent × ${ic.length}`} sub="IC 自带" at={ic.map((x) => x.mtime).sort().pop()} /> : null}
          {!chat.length && !desk.length && !ic.length ? <span className="text-[11px] text-[var(--fg-4)]">最近 10 分钟没有会话在动</span> : null}
        </div>)}
    </section>
  );
}
// GPU 现在（2026-11-25 重做）：现在在出什么 + IC 在跑/排队 + 最近出片；不再读旧链脚本
function GpuNow({ g: n }) {
  const recent = (n?.recent || []).slice(0, 8);
  if (!n) return null;
  const cur = n?.current;
  return (
    <section className="panel p-3 text-xs" data-gpu-now>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <Head t="GPU 现在" info="8189 显卡队列 + IC 在跑的任务" />
          {n?.busy ? <><div className="flex items-center gap-1.5"><Dot c={C.green} /><b className="text-base">出片中</b><span className="ml-auto text-sm"><Ticker since={cur?.startedAt} /></span></div><div className="mt-0.5 text-lg font-semibold">{shotLabel(cur)}</div></>
            : <div className="flex items-center gap-1.5"><Dot c={C.gray} /><b className="text-base">空闲</b><span className="ml-auto text-lg font-semibold">{n?.idleMin == null ? '—' : hm(n.idleMin * 60000)}</span></div>}
        </div>
        <div>
          <div className="mb-1 text-[11px] text-[var(--fg-3)]">最近出片</div>
          {recent.length ? <div className="grid gap-x-4 xl:grid-cols-2">{recent.map((r, i) => <div key={i} className="flex items-center gap-2 whitespace-nowrap border-t border-[var(--line)] py-0.5 tabular-nums"><span className="text-[var(--fg-3)]">{ptHM(r.at)}</span><b>{shotLabel(r)}</b><span className="text-[var(--fg-3)]">{r.dur != null ? `${r.dur} 秒` : ''}</span><span className="ml-auto" title={r.selected ? '已选用' : '还没选用'} style={{ color: r.selected ? C.green : 'var(--fg-4)' }}>{r.selected ? '✓ 选用' : '未选'}</span></div>)}</div> : <NoData />}
        </div>
      </div>
    </section>
  );
}
function Overview({ go }) {
  const proj = useOverviewProject();
  const [rk, setRk] = useState(0);
  const q = proj.id ? `&project=${proj.id}` : '';
  const top = usePoll('/api/command/ov?part=top' + q, 30, rk);
  const mt = usePoll('/api/command/ov?part=metrics' + q, 30, rk);
  const [more, setMore] = useState(false);
  const m = mt.data; const d = top.data;
  const cap = m?.capacity; const W = cap?.windows || [];
  const today = W.find((w) => w.id === 'today');
  const viol = d?.priority?.violations || [];
  const g = m?.gpuNow;
  return (
    <div className="flex flex-col gap-3" data-overview="v2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <select value={proj.id} onChange={(e) => { proj.choose(e.target.value); setMore(false); }} className="max-w-[320px] rounded border border-[var(--line)] bg-transparent px-1 py-0.5 text-base font-semibold" title="选项目（记在这台电脑的浏览器里）" data-ov-project>
            {proj.projects.length ? proj.projects.map((x) => <option key={x.id} value={x.id}>{x.name}{x.shots ? `（${x.shots} 镜）` : '（还没有镜头）'}</option>) : <option value="">{m?.project?.name || '我在城市用交易系统修仙V2'}</option>}
          </select>
          <span>· 总览</span>
          {m?.project && !m.project.hasIssues ? <span className="text-[11px] font-normal text-[var(--fg-4)]">这个项目还没有问题表和交付目录统计，只显示 IC 里的出片数据</span> : null}
        </h2>
        <span className="flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
          <span title="页面每 30 秒自动取一次新数据，有新出片、新问题会自己更新">更新于 {mt.at ? ptHM(mt.at) : '—'} · 每 30 秒自动刷新</span>
          <button type="button" onClick={() => setRk((x) => x + 1)} disabled={mt.loading || top.loading} className="rounded border border-[var(--line)] px-2 py-0.5 disabled:opacity-50" data-ov-refresh>{mt.loading || top.loading ? '刷新中…' : '刷新'}</button>
          <Info t={`首屏数据采样 ${ptHM(mt.at)}，每 30 秒自动刷新；点「刷新」立刻重新计算${mt.error ? `；暂时读不到：${mt.error}（保留上次值）` : ''}${m?.errors?.length ? `；部分数据源失败：${m.errors.join('；')}` : ''}`} />{mt.error || m?.errors?.length ? <Dot c={C.red} /> : null}
        </span>
      </div>

      {/* 产能 */}
      <section className="panel p-3" data-capacity>
        <Head t="产能" info={cap?.note || (cap?.error ? '读取失败：' + cap.error : '读取中')} />
        {!cap ? <NoData /> : cap.error ? <p className="text-xs text-red-400">ic.db 读不到</p> : (
          <div className="flex flex-col gap-3">
            <div className="grid items-center gap-3 md:grid-cols-[1fr_auto]">
              <div><div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--fg-3)]">今天忙闲 <Legend items={[['忙', C.green], ['闲', 'color-mix(in srgb, var(--fg) 14%, transparent)'], ['无数据', 'var(--line)']]} /></div><DayBar bar={cap.todayBar} /></div>
              <div className="flex gap-5">
                <Big v={hm(today?.busyMs)} sub="今天 GPU 忙（时:分）" c={C.green} />
                <Big v={hm(today?.idleMs)} sub="今天 GPU 闲（时:分）" />
                <Big v={pct0(today?.util)} sub="利用率（忙÷总时长）" />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead><tr className="text-[11px] text-[var(--fg-3)]"><th className="text-left font-normal" />{W.map((w) => <th key={w.id} className="px-2 text-right font-medium">{w.label}{w.noDataMs > 0 ? <span className="ml-0.5 text-[var(--fg-4)]" title={`前 ${hm(w.noDataMs)} 没有任务记录（无数据，不计入闲）`}>*</span> : null}</th>)}</tr></thead>
                <tbody>
                  {[
                    ['GPU 忙（时长）', (w) => hm(w.busyMs)],
                    ['GPU 闲（时长）', (w) => hm(w.idleMs)],
                    ['利用率（忙÷总时长）', (w) => <span className="inline-flex items-center gap-1"><span className="inline-block h-1.5 w-10 rounded bg-[var(--line)] align-middle"><span className="block h-1.5 rounded" style={{ width: `${(w.util || 0) * 100}%`, background: C.green }} /></span>{pct0(w.util)}</span>],
                    ['总共出片（镜头）', (w) => <b>{w.total} 镜</b>],
                    ['有效（已选用的镜头）', (w) => <b style={{ color: C.green }}>{w.selected} 镜</b>],
                    ['无效（出了没选用的镜头）', (w) => `${w.unselected} 镜`],
                    ['失败任务（出片任务次数）', (w) => (w.failedJobs ? <span style={{ color: C.red }}>{w.failedJobs} 次</span> : '0 次')],
                    ['有效率（选用÷出片）', (w) => pct0(w.effRate)],
                    ['有效时长（选用镜头的成片时长）', (w) => (w.effMin == null ? '—' : `${w.effMin.toFixed(1)} 分钟`)],
                    ['平均每镜出片用时（分:秒）', (w) => (w.perShotSec == null ? <NoData /> : mmss(w.perShotSec))],
                  ].map(([k, f]) => <tr key={k} className="border-t border-[var(--line)]"><td className="py-0.5 text-[11px] text-[var(--fg-3)]">{k}</td>{W.map((w) => <td key={w.id} className="px-2 text-right">{f(w)}</td>)}</tr>)}
                  <tr className="border-t border-[var(--line)]"><td className="py-0.5 text-[11px] text-[var(--fg-3)]">进了交付的有效镜头</td>{W.map((w) => <td key={w.id} className="px-2 text-right"><NoData /></td>)}</tr>
                </tbody>
              </table>
            </div>
            <div><div className="mb-1 text-[11px] text-[var(--fg-3)]">最近 12 小时每小时出片（镜头数，柱上是数量）</div><HourBars rows={cap.hourly || []} /></div>
          </div>
        )}
      </section>

      {/* 大数字 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <section className="panel col-span-2 p-3">
          <Head t="章集进度" info={m?.episodes?.note} right={m?.episodes ? <span className="text-xl font-semibold">{m.episodes.delivered}<span className="text-xs font-normal text-[var(--fg-3)]"> / {m.episodes.total} 已交付</span>{m.episodes.twoK ? <span className="ml-2 rounded px-1.5 text-xs font-normal" style={{ background: 'color-mix(in srgb, ' + C.blue + ' 22%, transparent)', color: C.blue }} title="交付目录里短边 ≥1440 的集（ffprobe 实测）">2K {m.episodes.twoK} 集</span> : null}{m.episodes.extra?.length ? <span className="ml-1 text-[10px] font-normal text-[var(--fg-4)]" title={`交付目录里还有 ${m.episodes.total} 集以外的文件：` + m.episodes.extra.map((n) => 'EP' + n).join('、')}>+EP{m.episodes.extra.length > 2 ? `${Math.min(...m.episodes.extra)}–${Math.max(...m.episodes.extra)}` : m.episodes.extra.join('、')}</span> : null}</span> : null} />
          {m?.episodes ? <><EpGrid grid={m.episodes.grid} onPick={(ep) => go('issues', { ep })} /><div className="mt-1.5"><Legend items={[['已交付', C.green], ['2K', C.blue], ['有未完成问题', C.amber], ['未交付', 'var(--line)']]} /></div></> : <NoData />}
        </section>
        <section className="panel p-3">
          <Head t="问题表" info="问题描述.txt（只读）逐条状态" />
          {m?.issues?.none ? <span className="text-[11px] text-[var(--fg-4)]">{m.issues.note}</span> : m?.issues && !m.issues.error ? <><Big v={m.issues.todo + m.issues.doing} unit="条没修完" sub={`共 ${m.issues.total} 条`} /><div className="mt-2"><Stack segs={ISS_SEG(m.issues)} h={14} /></div><div className="mt-1"><Legend items={[[`待修改 ${m.issues.todo}`, C.red], [`修改中 ${m.issues.doing}`, C.amber], [`完成 ${m.issues.done}`, C.green]]} /></div></> : <NoData />}
        </section>
        <SessionsMini go={go} rk={rk} />
      </div>

      <GpuNow g={mt.data?.gpuNow} />

      {/* 「正在做」去掉：和 GPU 卡重复，还会贴主会话原话（Andy 11-25：信息太多） */}
      <WatchdogCard />

      <div className="grid gap-3 lg:grid-cols-3">
        {/* 用量 */}
        <section className="panel p-3">
          <Head t="用量（tokens）" info={(m?.tokens?.note || '') + (m?.spend?.note ? '；' + m.spend.note : '') + (m?.tokens?.at ? `；统计于 ${ptHM(m.tokens.at)}，5 分钟刷新` : '')} />
          {m?.tokens?.windows ? (
            <table className="w-full text-xs tabular-nums"><thead><tr className="text-[11px] text-[var(--fg-3)]"><th />{m.tokens.windows.map((w) => <th key={w.id} className="px-1 text-right font-medium">{w.label.replace('最近 ', '')}</th>)}</tr></thead><tbody>
              {[['合计', 'total', true], ['输出', 'out'], ['缓存读', 'cr'], ['缓存写', 'cc'], ['输入', 'in']].map(([k, f, b]) => <tr key={k} className="border-t border-[var(--line)]"><td className="text-[11px] text-[var(--fg-3)]">{k}</td>{m.tokens.windows.map((w) => <td key={w.id} className="px-1 text-right">{b ? <b>{tok(w[f])}</b> : tok(w[f])}</td>)}</tr>)}
              <tr className="border-t border-[var(--line)]"><td className="text-[11px] text-[var(--fg-3)]">主会话 $</td>{m.tokens.windows.map((w) => { const s = (m.spend?.windows || []).find((x) => x.id === w.id); return <td key={w.id} className="px-1 text-right">{s ? s.usd.toFixed(2) : '—'}</td>; })}</tr>
            </tbody></table>
          ) : m?.tokens?.pending ? <span className="text-[11px] text-[var(--fg-4)]">统计中…</span> : <NoData />}
        </section>
        {/* 规则 */}
        <section className="panel p-3">
          <Head t="规则条目" info={m?.rules?.note || m?.rules?.error} right={m?.rules?.total != null ? <span className="text-xl font-semibold">{m.rules.total}</span> : null} />
          {m?.rules?.bySkill ? (() => { const mx = Math.max(1, ...Object.values(m.rules.bySkill)); return (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">{Object.entries(m.rules.bySkill).map(([k, n]) => <div key={k} className="flex items-center gap-2 text-[11px]"><span className="w-32 shrink-0 truncate text-[var(--fg-3)]" title={k}>{k}</span><div className="h-1.5 flex-1 rounded bg-[var(--line)]"><div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${(n / mx) * 100}%` }} /></div><span className="w-7 text-right tabular-nums">{n}</span></div>)}</div>
              <div className="grid grid-cols-3 gap-1 text-center text-[11px]">{(m.rules.changes || []).map((c) => <div key={c.id || 'x'} className="rounded border border-[var(--line)] py-1" title={c.missing || (c.baseEmpty ? '窗口起点时还没有编号条目，新增数＝当前全部' : `基准 ${c.base}`)}><div className="text-[10px] text-[var(--fg-4)]">{c.label || ''}</div>{c.missing ? <NoData /> : <div className="tabular-nums"><span style={{ color: C.green }}>+{c.added}</span> <span style={{ color: C.red }}>−{c.removed}</span> <span style={{ color: C.amber }}>~{c.modified}</span>{c.baseEmpty ? <span className="text-[var(--fg-4)]">*</span> : null}</div>}</div>)}</div>
            </div>); })() : m?.rules?.pending ? <span className="text-[11px] text-[var(--fg-4)]">统计中…</span> : <NoData />}
        </section>
        {/* 问题归类 */}
        <section className="panel p-3">
          <Head t="问题归类" info={m?.issues?.note} right={<Legend items={[['待修改', C.red], ['修改中', C.amber], ['完成', C.green]]} />} />
          {m?.issues?.classes ? (() => { const mx = Math.max(1, ...m.issues.classes.map((c) => c.total)); return (
            <div className="flex flex-col gap-1">{m.issues.classes.map((c) => <div key={c.cls} className="flex items-center gap-2 text-[11px]"><span className="w-28 shrink-0 truncate text-[var(--fg-3)]" title={c.cls}>{c.cls}</span><div className="flex-1"><div style={{ width: `${Math.max(4, (c.total / mx) * 100)}%` }}><Stack segs={ISS_SEG(c)} h={10} /></div></div><span className="w-7 text-right tabular-nums">{c.total}</span></div>)}</div>); })() : <NoData />}
        </section>
      </div>

      {/* 「规则与违规明细」去掉：是 11-23 的旧出片顺序规则，1–30 集修完后已无意义（Andy 11-25） */}
      {/* 2026-11-25 Andy：「更多明细（原总览各卡）」和上面新总览重复、数据也旧（读 11-23 的旧链），已去掉 */}
    </div>
  );
}
// 规则与违规明细（原总览首屏的规则卡，原样保留，挪进折叠）
function RulesCard({ d, go }) {
  return (
      <Card title="规则（排序规则 + 派工规则；只显示和提醒，不自动改链、不自动派单）" right={<button type="button" className="rounded border border-[var(--line)] px-2 text-xs" onClick={() => go('dispatch')}>看派工单 →</button>}>
        <div className="flex flex-col gap-1 text-xs">
          <div className="text-[11px] font-semibold text-[var(--fg-3)]">排序规则（越靠上越优先）</div>
          {(d.priority?.rules || []).map((r, i) => <div key={r.id} className="font-semibold">{i + 1}. ★ {r.text}<span className="ml-1 text-[10px] font-normal text-[var(--fg-4)]">（{r.check}；{r.source}）</span></div>)}
          {d.priority?.activeChains ? <div className="text-[11px] text-[var(--fg-3)]">参与判断的链（在跑 / 已挂好）：{d.priority.activeChains.length ? d.priority.activeChains.map((c) => `${c.label}${c.state === 'running' ? '（在跑' : '（已挂'}，剩 ${c.remaining} 镜）`).join('、') : '没有'}</div> : null}
          {d.priority?.unfinishedEarly?.length ? <div className="text-[11px] text-[var(--fg-3)]">第1–10集还没做完：{d.priority.unfinishedEarly.map((e) => `第${e.no}集（${e.why}）`).join('；')}</div> : null}
          {(d.priority?.violations || []).map((v, i) => <div key={i} className={v.level === 'red' ? 'font-semibold text-red-500' : 'text-amber-400'}>{v.level === 'red' ? '✖ 违反：' : '⚠ 注意：'}{v.text}</div>)}
          {d.priority && !(d.priority.violations || []).length ? <div className="text-green-500">✔ 在跑和已挂好的链都符合「第1–10集最先」，第1–10集也没有改过字段却没进链的镜头</div> : null}
          {d.priority?.note ? <div className="text-[10px] text-[var(--fg-4)]">{d.priority.note}</div> : null}
          <div className="mt-2 text-[11px] font-semibold text-[var(--fg-3)]">派工规则</div>
          {(d.priority?.dispatchRules || []).map((r) => <div key={r.id}>· {r.text}<span className="ml-1 text-[10px] text-[var(--fg-4)]">（{r.check}；{r.source}）</span></div>)}
          <div className="mt-2 text-[11px] font-semibold text-[var(--fg-3)]" data-decision-rules="1">拍板规则</div>
          {(d.priority?.decisionRules || []).map((r) => <div key={r.id}>· {r.text}<span className="ml-1 text-[10px] text-[var(--fg-4)]">（{r.check}；{r.source}）</span></div>)}
          {d.priority?.releaseFields ? <div className="text-[11px] text-[var(--fg-3)]">放行记录必须带：{d.priority.releaseFields.join('、')}；门禁 md5 固定 {String(d.priority.gateMd5 || '').slice(0, 8)}</div> : null}
          {(d.priority?.releaseChecks || []).map((c) => <div key={c.key} className={c.level === 'red' ? 'font-semibold text-red-500' : c.level === 'amber' ? 'text-amber-400' : 'text-green-500'}>{c.level === 'red' ? '✖' : c.level === 'amber' ? '⚠' : '✔'} 放行记录 {c.key}{c.kindLabel ? `（${c.kindLabel}）` : ''}：{c.msgs.length ? c.msgs.join('；') : '各栏齐全'}</div>)}
        </div>
      </Card>
  );
}
// 原总览的明细卡（数据和写法不变），收进折叠、展开时才挂载
function OverviewMore({ go, top, q = '', rk = 0 }) {
  const iss = usePoll('/api/command/ov?part=issues' + q, 60, rk);
  const ses = usePoll('/api/command/ov?part=sessions', 60, rk);
  const tr = usePoll('/api/command/ov?part=trends' + q, 600, rk);
  const d = top.data;
  if (!d) return null;
  const T = d.films.totalChapters;
  const sesActive = ses.data?.active || [];
  return (
    <div className="flex flex-col gap-4">
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
      <Card title="会话">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[['claude', 'Claude'], ['codex', 'Codex']].map(([k, l]) => (
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
            {(() => {
              const all = list.data?.sessions || []; const ic = all.filter((x) => x.group === 'ic');
              const desk = all.filter((x) => x.group !== 'ic' && (x.name || provider === 'codex')); const noname = all.filter((x) => x.group !== 'ic' && !x.name && provider !== 'codex');
              const row = (x, label) => (
                <tr key={x.id} className={'cursor-pointer border-t border-[var(--line)] hover:bg-[var(--line)] ' + (sel === x.id ? 'text-[var(--accent)]' : '')} onClick={() => { setSel(x.id); setPage(-1); }} title={x.id}>
                  <td className="py-1 pr-3 font-medium">{label}</td><td className="w-24 whitespace-nowrap pr-3 tabular-nums text-[var(--fg-3)]">{ptMDHM(x.mtime)}</td><td className="w-16 whitespace-nowrap text-right tabular-nums text-[var(--fg-4)]">{fmtSize(x.size)}</td>
                </tr>);
              return <>
                <table className="w-full text-[11px]"><tbody>{desk.map((x) => row(x, x.name || (provider === 'codex' ? 'Codex 会话 ' : '会话 ') + x.id.split('/').pop().slice(0, 8)))}</tbody></table>
                {!desk.length && list.data ? <p className="text-[11px] text-[var(--fg-4)]">这段时间没有桌面会话</p> : null}
                {noname.length ? <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-[var(--fg-3)]">没起名的会话（{noname.length} 个，多是脚本调用的一次性会话）</summary><div className="max-h-[220px] overflow-auto"><table className="w-full"><tbody>{noname.map((x) => row(x, '会话 ' + x.id.split('/').pop().slice(0, 8)))}</tbody></table></div></details> : null}
                {ic.length ? <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-[var(--fg-3)]">IC 内部写稿 Agent（{ic.length} 个，IC 写提示词时自己起的）</summary><div className="max-h-[220px] overflow-auto"><table className="w-full"><tbody>{ic.map((x) => row(x, '写稿 Agent ' + x.id.split('/').pop().slice(0, 8)))}</tbody></table></div></details> : null}
              </>;
            })()}
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
const ORDER_FIELDS = ['编号', '来源', '接单方', '范围', '模型', '选它的理由', '验收标准', '截止时间', '状态', '交付物', '需要Andy点头'];
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
      <Card title="派工规则：模型分配表（Andy 17:04）">
        <div className="flex flex-col gap-1 text-xs">
          {(data?.orders.rules || []).map((r) => <div key={r.id} className="font-semibold">· {r.text.split('：')[0]}<span className="ml-1 text-[10px] font-normal text-[var(--fg-4)]">（{r.check}）</span></div>)}
          <table className="mt-1 text-[11px]"><thead><tr className="text-left text-[var(--fg-3)]"><th className="pr-4">活</th><th>模型</th></tr></thead><tbody>{(data?.orders.modelTable || []).map((m) => <tr key={m.kind} className="border-t border-[var(--line)]"><td className="py-1 pr-4">{m.label}</td><td>{m.model}</td></tr>)}</tbody></table>
        </div>
      </Card>
      <Card title="派工单草稿（只读）">
        {data ? <p className="mb-2 break-all text-[11px] text-[var(--fg-3)]">目录：{data.orders.dir}{data.orders.exists ? '' : '（不存在）'} · 共 {data.orders.orders.length} 张</p> : null}
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead><tr className="text-left text-[var(--fg-3)]"><th className="pr-2">文件</th><th className="pr-2">模型规则</th>{ORDER_FIELDS.map((f) => <th key={f} className="pr-2">{f}</th>)}</tr></thead>
            <tbody>
              {(data?.orders.orders || []).map((o) => (
                <tr key={o.file} className="border-t border-[var(--line)] align-top">
                  <td className="py-1.5 pr-2"><div className="font-mono">{o.file}</div><div className="font-mono text-[9px] text-[var(--fg-4)]">md5 {o.md5}</div>{o.data?.['示例'] ? <Pill tone="blue">示例</Pill> : null}</td><td className={'pr-2 ' + (o.rule?.level === 'red' ? 'font-semibold text-red-500' : o.rule?.level === 'amber' ? 'text-amber-400' : 'text-green-500')}>{o.rule ? <>{o.rule.level === 'red' ? '✖ 不许派出' : o.rule.level === 'amber' ? '⚠ 模型要再看' : '✔ 合规'}{o.rule.msgs.map((m, i) => <div key={i} className="text-[10px]">{m}</div>)}<div className="text-[10px] text-[var(--fg-4)]">活：{o.rule.task.label}{o.rule.suggested ? ` · 默认：${o.rule.suggested}` : ''}</div></> : null}</td>
                  {o.error ? <td colSpan={ORDER_FIELDS.length + 1} className="text-red-500">{o.error}</td> : ORDER_FIELDS.map((f) => <td key={f} className="whitespace-pre-wrap break-all pr-2">{showVal(o.data[f])}</td>)}
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
function GpuShots({ u }) {
  const [lv, setLv] = useState(0); // 0 收起 1 前 6 个 2 全部
  const all = u.allShots || u.shots || [];
  const show = lv === 2 ? all : (u.shots || []);
  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 flex-1 truncate text-left" title={u.key} onClick={() => setLv((x) => (x ? 0 : 1))}>{lv ? '▾' : '▸'} {u.label}</button>
        <span className="w-16"><Prog done={u.done} total={u.total} c={u.state === 'running' ? C.green : 'var(--accent)'} /></span>
        <span className="w-10 text-right tabular-nums text-[var(--fg-3)]">{u.done}/{u.total}</span>
      </div>
      {lv ? <div className="mt-0.5 flex flex-wrap gap-1 pl-3">{show.map((s, i) => <span key={i} className={'rounded px-1 ' + (s.done ? 'text-[var(--fg-4)] line-through' : 'bg-[var(--line)]')}>{s.ch}#{s.num}</span>)}{lv === 1 && u.more ? <button type="button" className="text-[var(--accent)]" onClick={() => setLv(2)}>…共 {all.length} 镜</button> : null}</div> : null}
    </div>
  );
}
function GpuBar({ g }) {
  if (!g) return null;
  const n = g.now || {}; const t = g.today || {}; const cur = n.current;
  const DIAG_ST = { running: ['在跑', 'green'], waiting: ['在等', 'blue'], ready: ['未启动', 'gray'], stopped: ['进程不在', 'red'] };
  return (
    <section className="panel p-3 text-xs" data-gpu-bar>
      <Head t="GPU 状态" info={`${g.note || ''}；现在＝出片链进程 + ic.db 在跑任务 + 8189 队列；今天＝ic.db；接下来＝最近 6 小时改过、没跑完、没被取代、没有 .STOP 的链脚本（最多 3 条）`} />
      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded border border-[var(--line)] p-2" data-gpu-now>
          <div className="mb-1 text-[11px] text-[var(--fg-3)]">现在</div>
          {n.busy ? <>
            <div className="flex items-center gap-1.5"><Dot c={C.green} /><b className="text-base">出片中</b><span className="ml-auto text-sm"><Ticker since={cur?.startedAt} /></span></div>
            {cur ? <div className="mt-0.5"><b className="text-lg">{shotLabel(cur)}</b> <span className="text-[11px] text-[var(--fg-3)]" title={cur.job || ''}>{cur.label || cur.chain || (cur.job ? cur.job.slice(0, 8) : '')}</span></div> : null}
          </> : <div className="flex items-center gap-1.5"><Dot c={C.gray} /><b className="text-base">空闲</b><span className="ml-auto text-lg font-semibold" title={n.idleSince ? `上一条出片任务 ${ptHM(n.idleSince)} 结束` : ''}>{n.idleMin == null ? '—' : hm(n.idleMin * 60000)}</span></div>}
          <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
            <span className="rounded bg-[var(--line)] px-1.5" title="8189 /queue：▶ running · ⏸ pending">8189 {n.comfy?.ok ? `▶${n.comfy.running} ⏸${n.comfy.pending}` : '查不到'}</span>
            {n.ic?.ok ? [...(n.ic.running || []).map((j) => ['▶', j]), ...(n.ic.queued || []).map((j) => ['⏸', j])].map(([k, j]) => <span key={j.job} className="rounded bg-[var(--line)] px-1.5" title={`IC 任务 ${j.job}`}>{k} {j.type}{j.ch ? ` ${j.ch}#${j.idx}` : ''}</span>) : <span className="rounded bg-[var(--line)] px-1.5">IC 查不到</span>}
          </div>
        </div>
        <div className="rounded border border-[var(--line)] p-2" data-gpu-today>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--fg-3)]">今天<Info t={t.note || t.error} /></div>
          {t.ok ? <>
            <div className="flex items-end gap-3">
              <Big v={t.videos} unit="条" />
              <div className="flex flex-1 flex-col gap-0.5 pb-1 text-[11px]"><span><span style={{ color: C.green }}>✓ {t.selected}</span> · 未选 {t.unselected}{t.failedJobs ? <span style={{ color: C.red }}> · 失败 {t.failedJobs}</span> : null}</span><span className="text-[var(--fg-3)]" title={`今天 ${t.sampleCount} 个 done 的中位数（chain.log）`}>每镜 {t.perShotSec ? mmss(t.perShotSec) : '—'}{t.idleMin != null ? ` · 闲 ${hm(t.idleMin * 60000)}` : ''}</span></div>
            </div>
            <HourBars rows={t.hourly || []} h={26} />
          </> : <NoData />}
        </div>
        <div className="rounded border border-[var(--line)] p-2" data-gpu-next>
          <div className="mb-1 text-[11px] text-[var(--fg-3)]">接下来</div>
          {(g.upcoming || []).length ? <div className="flex flex-col gap-1">{g.upcoming.map((u) => <GpuShots key={u.key} u={u} />)}</div> : <span className="text-[11px] text-[var(--fg-4)]">没有待跑的链</span>}
        </div>
      </div>
      <div className="mt-2 rounded border border-[var(--line)] p-2" data-gpu-recent>
        <div className="mb-1 text-[11px] text-[var(--fg-3)]">最近出片</div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {(g.recent || []).map((r, i) => <div key={i} className="flex items-center gap-2 border-t border-[var(--line)] py-0.5 tabular-nums"><span className="text-[var(--fg-3)]">{ptHM(r.at)}</span><b>{shotLabel(r)}</b><span>{r.dur != null ? `${r.dur}s` : '—'}</span><span style={{ color: r.selected ? C.green : 'var(--fg-4)' }}>{r.selected ? '✓' : '·'}</span><span className="ml-auto truncate text-[10px] text-[var(--fg-4)]" title={r.job ? `IC 任务 ${r.job}` : ''}>{r.source || ''}</span></div>)}
          {!(g.recent || []).length ? <NoData /> : null}
        </div>
      </div>
      {/* 「排链诊断（旧）」去掉：读的是不再使用的旧链脚本（Andy 11-25） */}
    </section>
  );
}
function Issues() {
  const [operator, setOperator] = useState('Andy');
  const { data, error, loading, reload } = useJson('/api/issues');
  const log = useJson('/api/issues/log');
  const initEp = Number(new URLSearchParams(window.location.search).get('ep')) || null; // 总览章集格子点进来的那一集
  const [open, setOpen] = useState(() => (initEp ? { [initEp]: true } : {}));
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (initEp && data) { const el = document.querySelector(`[data-ep="${initEp}"]`); if (el) el.scrollIntoView({ block: 'center' }); } }, [initEp, !!data]);
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
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
        <b className="text-sm">问题</b>
        <span className="text-[11px] text-[var(--fg-3)]" title={`${data?.config.target || ''} · md5 ${data?.file.md5 || ''}`}>桌面「问题描述.txt」· 改状态直接写进去（写前自动备份；文件被别人改过会拒写，刷新再改）</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-[11px] text-[var(--fg-3)]"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />显示已全部修完的集</label>
        <Refresh onClick={() => { reload(); log.reload(); }} loading={loading} />
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
      <Card title="按集">
        <table className="w-full text-xs"><thead><tr className="text-left text-[var(--fg-3)]"><th className="w-16 py-1">集</th><th className="w-48">进度</th><th>完成 / 修改中 / 待修改</th></tr></thead>
          <tbody>{(data?.episodes || []).filter((e) => showAll || e.items.some((i) => i.status !== 'done') || open[e.no]).map((e) => {
            const c = { done: 0, doing: 0, todo: 0 }; e.items.forEach((i) => c[i.status]++);
            return (
              <Fragment key={e.no}>
                <tr className="cursor-pointer border-t border-[var(--line)]" onClick={() => setOpen((o) => ({ ...o, [e.no]: !o[e.no] }))} data-ep={e.no}>
                  <td className="py-1.5 font-semibold">第{e.no}集</td><td className="pr-3"><Stack segs={ISS_SEG(c)} h={8} showN={false} /></td><td className="tabular-nums"><span style={{ color: C.green }}>{c.done}</span> / <span style={{ color: C.amber }}>{c.doing}</span> / <span style={{ color: C.red }}>{c.todo}</span>{!c.doing && !c.todo ? <span className="ml-2 text-[10px] text-[var(--fg-4)]">全部修完</span> : null}</td>
                </tr>
                {open[e.no] ? (
                  <tr><td colSpan={3} className="pb-3">
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
                            <span className="min-w-0 flex-1 break-words" title={`第 ${it.start + 1} 行`}>{it.text}</span>
                            {it.status !== 'done' ? <span className="shrink-0 text-[10px] text-[var(--fg-4)]" title={it.links?.shots?.length ? (it.links.src === 'auto' ? '按时间点 ' + (it.links.times || []).join('、') + ' 对到镜头（估算）' : '人工关联 ' + (it.links.manual?.by || '')) : (it.links?.why || '')}>{it.links?.shots?.length ? it.links.shots.map((x) => <span key={x.idx} className={x.fixing ? 'text-sky-400' : ''}>#{x.idx}·{x.step} </span>) : <span className="text-amber-400">未关联镜头</span>}</span> : null}
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
        {data && !showAll && !(data.episodes || []).some((e) => e.items.some((i) => i.status !== 'done')) ? <p className="py-2 text-[11px] text-[var(--fg-3)]">所有集的问题都修完了。勾右上角「显示已全部修完的集」可以看全部。</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2 text-xs" data-add>
          <b>新增问题</b>
          第<input className="w-12 rounded border border-[var(--line)] bg-transparent px-1" value={add.episode} onChange={(e) => setAdd({ ...add, episode: e.target.value })} />集
          <input className="min-w-[320px] flex-1 rounded border border-[var(--line)] bg-transparent px-1" placeholder="例如：1分05秒 主角衣服颜色不对" value={add.text} onChange={(e) => setAdd({ ...add, text: e.target.value })} />
          <select value={add.status} onChange={(e) => setAdd({ ...add, status: e.target.value })} className="rounded border border-[var(--line)] bg-transparent"><option value="todo">待修改</option><option value="doing">修改中</option><option value="done">完成</option></select>
          <button type="button" className="rounded border border-[var(--accent)] px-2 text-[var(--accent)]" onClick={() => { op({ op: 'add', episode: Number(add.episode), text: add.text, status: add.status }, { episode: Number(add.episode) }); setAdd({ episode: '', text: '', status: 'todo' }); }}>{human ? '写入' : '提交建议'}</button>
        </div>
      </Card>
      <details className="panel p-3 text-xs">
        <summary className="cursor-pointer text-[var(--fg-3)]">修改记录（最近 50 条 / 共 {log.data?.total ?? 0} 条）</summary>
        <p className="my-1 break-all text-[10px] text-[var(--fg-4)]">{log.data?.file}</p>
        <div className="max-h-[320px] overflow-auto">{(log.data?.entries || []).map((r, i) => (
          <div key={i} className="mb-1 border-b border-[var(--line)] pb-1 text-[11px]" data-log>
            <b>{fmtTime(r.at)}</b> · {r.operator} · <Pill tone={r.result === 'written' ? 'green' : r.result === 'suggested' ? 'blue' : r.result?.startsWith('rejected') || r.result === 'refused' ? 'red' : 'gray'}>{r.result}</Pill> {r.via ? <span className="text-[10px]">{r.via}</span> : null}
            {r.reason ? <span className="text-[10px] text-[var(--fg-3)]"> {r.reason}</span> : null}
            {r.diff ? <Pre max={120}>{r.diff.join('\n')}</Pre> : null}
            {r.backup ? <div className="break-all text-[10px] text-[var(--fg-4)]">备份 {r.backup} · {r.beforeMd5} → {r.afterMd5}</div> : null}
          </div>))}</div>
      </details>
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
// 会话记录里的一条（2026-11-26 Andy：「该折叠的折叠」）：工具调用/工具结果默认收成一行，点开看原文；对话照常显示
function toolHead(text) {
  const m = /^\[工具调用 ([^\]]+)\]\s*([\s\S]*)$/.exec(text || ''); if (!m) return null;
  let desc = ''; try { const j = JSON.parse(m[2]); desc = j.description || j.query || j.file_path || j.pattern || j.url || (j.command ? String(j.command).split('\n')[0] : '') || ''; } catch { const g = (k) => { const r = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(m[2]); return r ? r[1].replace(/\\n/g, ' ') : ''; }; desc = g('description') || g('file_path') || g('pattern') || g('command').split(' ').slice(0, 8).join(' ') || (((/"command"\s*:\s*"(.{0,60})/.exec(m[2]) || [])[1] || '').replace(/\\n.*$/, '') + '…'); }
  return { tool: m[1], desc: String(desc).slice(0, 90) };
}
function LiveMsg({ m }) {
  const t = String(m.text || '');
  const call = toolHead(t);
  const isResult = t.startsWith('[工具结果]');
  if (call || isResult) {
    const body = isResult ? t.replace(/^\[工具结果\]\s*/, '') : t;
    return (
      <details className="group mb-0.5 rounded px-1.5 text-[11px] text-[var(--fg-3)] hover:bg-[var(--line)]">
        <summary className="cursor-pointer list-none truncate py-0.5">{call ? <><span className="text-[var(--accent)]">🔧 {call.tool}</span>{call.desc ? `：${call.desc}` : ''}</> : <span className="text-[var(--fg-4)]">↳ 结果（{body.length} 字）</span>}<span className="float-right text-[9px] text-[var(--fg-4)]">{m.ts ? ptHM(m.ts) : ''}</span></summary>
        <div className="mb-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--line)] p-1.5 font-mono text-[10px]">{body}</div>
      </details>);
  }
  const who = ({ user: 'Andy / 指令', assistant: '会话', summary: '摘要', meta: '开始' })[m.role] || m.role;
  const mine = m.role === 'user';
  return (
    <div className={'my-1.5 rounded-lg px-2.5 py-1.5 ' + (mine ? 'ml-8 bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]' : 'mr-8 bg-[var(--panel-2,var(--line))]')}>
      <div className="mb-0.5 text-[9px] text-[var(--fg-4)]">{who} · {m.ts ? ptHM(m.ts) : ''}</div>
      <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{t}</div>
    </div>);
}
function LivePanel({ s, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [first, setFirst] = useState(null);
  const t0 = useRef(performance.now());
  const boxRef = useRef(null);
  const sinceRef = useRef('');
  const q = `provider=${encodeURIComponent(s.provider)}&id=${encodeURIComponent(s.id)}&n=60`;
  useEffect(() => {
    let alive = true; t0.current = performance.now(); sinceRef.current = ''; setD(null); setFirst(null); setErr(null);
    const load = async (initial) => {
      try {
        const r = await fetch(`/api/command/live/session?${q}${sinceRef.current ? `&since=${encodeURIComponent(sinceRef.current)}` : ''}`, { cache: 'no-store' });
        const j = await r.json(); if (!alive) return;
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        if (j.unchanged) { setD((x) => (x ? { ...x, status: j.status } : x)); return; }
        sinceRef.current = `${j.size}|${j.mtime}`; setD(j);
        if (initial) requestAnimationFrame(() => { setFirst({ ms: Math.round(performance.now() - t0.current), server: j.serverMs, cached: j.cached }); });
        requestAnimationFrame(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; });
      } catch (e) { if (alive) setErr(String(e.message || e)); }
    };
    load(true);
    const t = setInterval(() => load(false), 3000);
    return () => { alive = false; clearInterval(t); };
  }, [q]);
  const st = d?.status;
  return (
    <div className="panel flex min-w-0 flex-1 flex-col p-2 text-xs" data-live-panel={s.id} data-live-ready={d ? '1' : '0'}>
      <div className="mb-1 flex items-center gap-2">
        <b className="flex-1 truncate" title={s.id}>{s.title}</b>
        <Pill tone="blue">只读</Pill>
        <span className="text-[10px] text-[var(--fg-4)]">{s.provider}</span>
        <button type="button" className="rounded border border-[var(--line)] px-1.5 text-[10px]" onClick={onClose}>关</button>
      </div>
      <div className={'mb-1 rounded px-2 py-1 text-[11px] ' + (st?.busy ? 'bg-[rgba(34,197,94,0.12)]' : 'bg-[var(--line)]')}>
        {st ? <>状态：<b>{st.state}</b> · 最后写入 {st.ageSec} 秒前</> : '读取中…'}
        {d ? <span className="ml-2 text-[10px] text-[var(--fg-4)]">文件 {(d.size / 1048576).toFixed(1)} MB · 只读了尾部 {(d.tailBytes / 1048576).toFixed(1)} MB{d.olderNotLoaded ? '（更早的没加载）' : ''} · 每 3 秒刷新</span> : null}
        {first ? <span className="ml-2 text-[10px] text-[var(--fg-4)]" data-first-ms={first.ms}>首屏 {first.ms} ms（服务端 {first.server} ms{first.cached ? '，缓存' : ''}）</span> : null}
      </div>
      <Err e={err} />
      <div ref={boxRef} className="max-h-[70vh] overflow-auto">
        {(d?.messages || []).map((m, i) => <LiveMsg key={i} m={m} />)}
      </div>
    </div>
  );
}

// 会话（2026-11-26 Andy：「聊天和会话合并」「做的漂亮一些」「会话要能直接聊天发信息」「选中只能选中一个，不要多选」）
// 左：一列会话（指挥聊天在上、能直接发消息；桌面/Codex 会话在下、只读看；IC 内部写稿 Agent 和更早的会话收起）。右：只显示选中的那一个。
function Chat() {
  const q0 = new URLSearchParams(window.location.search);
  const list = useJson('/api/chat/sessions');
  const live = useJson('/api/command/live');
  const hist = useJson('/api/command/sessions?provider=claude&days=3');
  useEffect(() => { const t = setInterval(list.reload, 5000); return () => clearInterval(t); }, [list.reload]);
  useEffect(() => { const t = setInterval(live.reload, 10000); return () => clearInterval(t); }, [live.reload]);
  const [sel, setSel] = useState(() => {
    const v = q0.get('live'); if (v) { const i = v.indexOf(':'); if (i > 0) return { kind: 'live', provider: v.slice(0, i), id: v.slice(i + 1) }; }
    return { kind: 'chat', id: q0.get('sid') || 'main' };
  });
  const [form, setForm] = useState({ title: '', provider: 'claude', instruction: '' });
  const [msg, setMsg] = useState(null);
  const chats = (list.data?.sessions || []).filter((s) => s.status !== 'stopped');
  const liveAll = live.data?.sessions || [];
  const liveDesk = liveAll.filter((x) => !x.chat && x.group !== 'ic');
  const liveIc = liveAll.filter((x) => x.group === 'ic');
  const liveIds = new Set(liveAll.map((x) => x.id));
  const older = (hist.data?.sessions || []).filter((x) => x.group !== 'ic' && x.name && !liveIds.has(x.id)).slice(0, 20);
  const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;
  const openAux = async () => {
    setMsg(null);
    const r = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...form, parent: 'Andy（手动）' }) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? (j.queued ? `已排队：${j.reason}` : '已开启') : j.error); list.reload();
    if (r.ok && j.id) setSel({ kind: 'chat', id: j.id });
  };
  const Row = ({ on, dot, name, sub, at, onClick, tag }) => (
    <button type="button" onClick={onClick} className={'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ' + (on ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--fg)]' : 'hover:bg-[var(--line)]')}>
      <Dot c={dot} />
      <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={name}>{name}</span>{sub ? <span className="block truncate text-[10px] text-[var(--fg-4)]">{sub}</span> : null}</span>
      {tag ? <span className="shrink-0 rounded border border-[var(--line)] px-1 text-[9px] text-[var(--fg-3)]">{tag}</span> : null}
      <span className="shrink-0 tabular-nums text-[10px] text-[var(--fg-3)]">{at ? ptHM(at) : ''}</span>
    </button>);
  const Group = ({ t, children, right }) => <div className="mb-2"><div className="mb-0.5 flex items-center px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-4)]">{t}<span className="ml-auto font-normal normal-case">{right}</span></div>{children}</div>;
  const selLive = sel?.kind === 'live' ? (liveAll.find((x) => x.id === sel.id) || (hist.data?.sessions || []).find((x) => x.id === sel.id) || sel) : null;
  return (
    <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]" data-sessions-merged>
      <aside className="panel flex max-h-[calc(100vh-180px)] flex-col overflow-auto p-2">
        <Group t="指挥聊天 · 可以发消息">
          {chats.map((s) => <Row key={s.id} on={isSel('chat', s.id)} dot={s.status === 'busy' ? C.green : C.gray} name={s.role === 'main' ? '主会话（指挥）' : s.title} sub={s.status === 'busy' ? '正在回复' : `空闲 · ${s.msgCount} 条`} at={s.lastActivity} onClick={() => setSel({ kind: 'chat', id: s.id })} />)}
          {list.data && !chats.length ? <p className="px-2 text-[10px] text-[var(--fg-4)]">没有开着的聊天会话</p> : null}
        </Group>
        <Group t="正在干活 · 只读" right={liveAll.length ? `10 分钟内 ${liveDesk.length + liveIc.length}` : ''}>
          {liveDesk.map((x) => <Row key={x.provider + x.id} on={isSel('live', x.id)} dot={x.status?.busy ? C.green : C.gray} name={x.title} sub={x.status ? x.status.state : ''} tag={x.provider === 'codex' ? 'Codex' : null} at={x.mtime} onClick={() => setSel({ kind: 'live', provider: x.provider, id: x.id })} />)}
          {liveIc.length ? <details className="px-2 text-[11px]"><summary className="cursor-pointer py-1 text-[var(--fg-3)]">IC 内部写稿 Agent × {liveIc.length}</summary>{liveIc.map((x) => <Row key={x.id} on={isSel('live', x.id)} dot={x.status?.busy ? C.blue : C.gray} name={'写稿 Agent ' + x.id.split('/').pop().slice(0, 8)} sub={x.status ? x.status.state : ''} at={x.mtime} onClick={() => setSel({ kind: 'live', provider: x.provider, id: x.id })} />)}</details> : null}
          {live.data && !liveDesk.length && !liveIc.length ? <p className="px-2 text-[10px] text-[var(--fg-4)]">10 分钟内没有会话在动</p> : null}
        </Group>
        {older.length ? <details className="mb-2 px-0.5"><summary className="cursor-pointer px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-4)]">更早的会话（3 天内 · {older.length}）</summary>
          {older.map((x) => <Row key={x.id} on={isSel('live', x.id)} dot={C.gray} name={x.name} sub={ptMDHM(x.mtime)} onClick={() => setSel({ kind: 'live', provider: 'claude', id: x.id })} />)}
        </details> : null}
        <details className="mt-auto border-t border-[var(--line)] px-2 pt-2 text-[11px]">
          <summary className="cursor-pointer text-[var(--fg-3)]">＋ 开一个辅助会话</summary>
          <div className="mt-1 flex flex-col gap-1">
            <input className="rounded border border-[var(--line)] bg-transparent px-1.5 py-0.5" placeholder="标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <select className="rounded border border-[var(--line)] bg-transparent" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="claude">Claude</option><option value="codex">Codex</option></select>
            <textarea className="rounded border border-[var(--line)] bg-transparent px-1.5" rows={2} placeholder="第一条指令（可空）" value={form.instruction} onChange={(e) => setForm({ ...form, instruction: e.target.value })} />
            <button type="button" className="self-start rounded border border-[var(--accent)] px-2 text-[var(--accent)]" onClick={openAux}>开启</button>
            {msg ? <p className="text-[10px]">{msg}</p> : null}
          </div>
        </details>
      </aside>
      <section className="min-w-0">
        {sel?.kind === 'chat' ? <ChatPanel key={'c' + sel.id} sid={sel.id} summary={chats.find((s) => s.id === sel.id)} onClose={() => setSel({ kind: 'chat', id: 'main' })} /> : null}
        {selLive ? <LivePanel key={'l' + selLive.id} s={selLive} onClose={() => setSel({ kind: 'chat', id: 'main' })} /> : null}
      </section>
    </div>
  );
}


export default function CommandPage() {
  const init = new URLSearchParams(window.location.search).get('sub');
  const [sub, setSub] = useState(init === 'episodes' ? 'issues' : init === 'sessions' ? 'chat' : SUBS.some((s) => s.id === init) ? init : 'overview'); // 旧链接（派工/证据/占位页）一律回总览
  const go = (id, extra) => {
    setSub(id);
    const q = new URLSearchParams(); q.set('mode', 'command'); q.set('sub', id);
    if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v);
    window.history.replaceState(null, '', '/?' + q.toString());
  };
  const cur = SUBS.find((s) => s.id === sub);
  return (
    <div className="flex flex-col gap-4" data-cmd-root>
      {/* 2026-11-26 Andy：「菜单考虑换个地方」「这个长期在这里有点占空间」——子菜单从左侧竖列改成顶部一排标签，内容区用满宽度 */}
      <div className="flex flex-col gap-3">
        <nav className="flex flex-wrap items-center gap-1 border-b border-[var(--line)] pb-1" data-cmd-tabs>
          {SUBS.map((s) => {
            const Icon = s.icon; const on = sub === s.id;
            return (
              <button key={s.id} type="button" data-active={on} onClick={() => go(s.jump || s.id)}
                className={'flex items-center gap-1.5 rounded-t px-3 py-1.5 text-sm transition-colors ' + (on ? 'border-b-2 border-[var(--accent)] font-semibold text-[var(--fg)]' : 'border-b-2 border-transparent text-[var(--fg-3)] hover:text-[var(--fg)]')}>
                <Icon size={14} className={on ? 'text-[var(--accent)]' : ''} />{s.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0">
          {sub === 'overview' ? <Overview go={go} /> : null}
          {sub === 'issues' ? <Issues /> : null}
          {sub === 'chat' ? <Chat /> : null}
          {sub === 'settings' ? <Settings /> : null}
        </div>
      </div>
    </div>
  );
}

// ---------- 设置：Claude API 密钥 + Codex 只读试用 ----------
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j;
}
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
export function ApiKeyCard() {
  const { data, error, reload: load } = useJson('/api/command/settings/claude-api'); // useJson 返回的是 reload（原先解构 load 拿到 undefined，存/清除后卡片报错且不刷新）
  const sess = useJson('/api/chat/sessions');
  const [val, setVal] = useState(''); const [editing, setEditing] = useState(false); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [test, setTest] = useState(null);
  const act = async (fn) => { setBusy(true); setMsg(null); try { await fn(); load(); } catch (e) { setMsg('✖ ' + e.message); } finally { setBusy(false); } };
  const k = data?.key; const rt = data?.routing;
  const save = () => act(async () => { await postJson('/api/command/settings/claude-api/key', { key: val }); setVal(''); setEditing(false); setMsg('✔ 已保存'); });
  const modeSel = (cur, onChange, withDefault) => (
    <select className="rounded border border-[var(--line)] bg-transparent px-1 text-xs" value={cur} disabled={busy} onChange={(e) => act(() => onChange(e.target.value))}>
      {withDefault ? <option value="default">跟角色默认</option> : null}
      <option value="cc">Claude Code（照旧）</option>
      <option value="api">API</option>
    </select>
  );
  return (
    <Card title="Claude API 密钥">
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {data ? <div className="flex flex-col gap-2 text-xs" data-apikey-card="1">
        <div>状态：{k.set ? <b data-apikey-last4="1">已设置 ••••{k.last4}</b> : <b>未设置</b>}{k.savedAt ? <span className="ml-2 text-[var(--fg-4)]">保存于 {ptHM(k.savedAt)}（太平洋时间）</span> : null}</div>
        {!k.set || editing ? <div className="flex flex-wrap items-center gap-2">
          <input type="password" autoComplete="new-password" spellCheck={false} className="w-[360px] rounded border border-[var(--line)] bg-transparent px-2 py-1 font-mono" placeholder="sk-ant-…" value={val} onChange={(e) => setVal(e.target.value)} />
          <button type="button" disabled={busy || !val} className="rounded border border-[var(--line)] px-2 py-1" onClick={save}>保存</button>
          {editing ? <button type="button" className="rounded border border-[var(--line)] px-2 py-1" onClick={() => { setEditing(false); setVal(''); }}>取消</button> : null}
        </div> : <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="rounded border border-[var(--line)] px-2 py-1" onClick={() => setEditing(true)}>更换</button>
          <button type="button" disabled={busy} className="rounded border border-[var(--line)] px-2 py-1" onClick={() => { if (window.confirm('确定清除已保存的 Claude API 密钥？')) act(async () => { await postJson('/api/command/settings/claude-api/clear', {}); setMsg('✔ 已清除'); }); }}>清除</button>
          <button type="button" disabled={busy} className="rounded border border-[var(--line)] px-2 py-1" onClick={() => act(async () => setTest(await postJson('/api/command/settings/claude-api/test', {})))}>测试连接</button>
          {test ? <span data-apikey-test="1" className={test.ok ? 'text-green-500' : 'text-red-500'}>{test.ok ? 'OK' : 'FAIL'}{test.status ? `（HTTP ${test.status}）` : `（${test.msg}）`}</span> : null}
        </div>}
        {msg ? <div>{msg}</div> : null}
        <div className="text-[10px] text-[var(--fg-4)]">密钥只存在 agent1 本机：{k.file}（不在任何 git 仓库里{k.acl ? `；文件夹权限：${k.acl}` : ''}）。页面和接口只回「有没有」和末 4 位；不写日志、聊天记录、会话登记表。测试连接只在服务端调 Anthropic 的模型列表接口，只显示通不通和 HTTP 状态码。</div>
        <div className="mt-2 font-semibold text-[var(--fg-3)]">哪些会话走 API（默认全部照旧走 Claude Code；选了 API 但没存密钥时也照旧走 Claude Code）</div>
        <div className="flex flex-wrap items-center gap-3">
          <span>主会话：{modeSel(rt.roles.main, (v) => postJson('/api/command/settings/claude-api/routing', { role: 'main', mode: v }))}</span>
          <span>辅助会话（默认）：{modeSel(rt.roles.aux, (v) => postJson('/api/command/settings/claude-api/routing', { role: 'aux', mode: v }))}</span>
        </div>
        {(sess.data?.sessions || []).filter((s) => s.provider === 'claude' && s.status !== 'stopped').map((s) => <div key={s.id} className="flex items-center gap-2"><span className="w-[280px] truncate">{s.title}</span><span className="text-[var(--fg-4)]">{s.id}</span>{modeSel(rt.sessions[s.id] || 'default', (v) => postJson('/api/command/settings/claude-api/routing', { session: s.id, mode: v }), true)}</div>)}
        <div className="text-[10px] text-[var(--fg-4)]">已接通：指挥系统聊天页新发的每一轮都会按这里的选择决定走 API 还是 Claude Code（下一条消息起生效）。别的机器人和 4610 那边的任务不受这里影响。{rt.changedAt ? `最后改动：${ptHM(rt.changedAt)} ${rt.changedBy || ''}` : ''}</div>
        <div className="mt-2 font-semibold text-[var(--fg-3)]">API 用量（我们自己记的 token 数）</div>
        {data.usage.days.length ? <table className="text-[11px]"><thead><tr className="text-left text-[var(--fg-3)]"><th className="pr-4">日期（太平洋）</th><th className="pr-4">次数</th><th className="pr-4">输入 token</th><th>输出 token</th></tr></thead><tbody>{data.usage.days.map((d) => <tr key={d.day} className="border-t border-[var(--line)]"><td className="pr-4">{d.day}</td><td className="pr-4">{d.calls}</td><td className="pr-4">{fmtN(d.input)}</td><td>{fmtN(d.output)}</td></tr>)}</tbody></table> : <div className="text-[var(--fg-3)]">还没有走 API 的调用</div>}
        <div className="text-[10px] text-[var(--fg-4)]">{data.usage.note}</div>
      </div> : null}
    </Card>
  );
}
const ptDT = (x) => (x ? new Date(x).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
function CodexTrialCard() {
  const { data, error } = useJson('/api/command/codex-trial');
  if (error) return <Card title="Codex 只读试用"><p className="text-xs text-red-400">{error}</p></Card>;
  if (!data) return null;
  const s = data.state || {};
  return (
    <Card title="Codex 只读试用（Andy 17:27「可以，Codex 按只读巡视对账试一天」）">
      <div className="flex flex-col gap-1 text-xs" data-codex-trial="1">
        <div>状态：{s.enabled ? <b className="text-green-500">试用中</b> : <b>{s.autoOffAt ? '已到期自动关' : s.stoppedAt ? '已手动关' : '未开始'}</b>}{s.start ? `　开始 ${ptDT(s.start)}　自动关 ${ptDT(s.end)}（太平洋时间）` : ''}{s.everyMin ? `　每 ${s.everyMin} 分钟跑一轮` : ''}</div>
        <div>只做：{data.tasks.map((t) => `${t.label}${t.wired ? '' : `（未接：${t.why}）`}`).join('；')}。聊天页里 Codex 仍然关着。</div>
        <div>结果：{data.runs} 次{data.agreePct != null ? `，和脚本结果一致 ${data.agreePct}%` : ''}，漏报 {data.missedAlarms}，写文件 {data.fileWrites}，越界读 {data.outOfScopeReads}，Codex 用工具 {data.toolEvents} 次{data.pass == null ? '' : data.pass ? ' → 目前达标' : ' → 目前不达标'}</div>
        <div className="text-[10px] text-[var(--fg-4)]">Codex 不给任何读文件、跑命令、浏览器、看图工具（-s read-only，并关掉 shell_tool / unified_exec 等）；材料由指挥系统按白名单取好、过读取限制（.claude、.codex、.credentials*、local_secrets、P\项目数据\封存\、*.env）后放进提示词。逐次记录：{data.runsFile}</div>
        {(data.last || []).slice(0, 6).map((r, i) => <div key={i} className="text-[11px] text-[var(--fg-3)]">{ptHM(r.at)} {r.event ? `【${r.event}】` : r.canary ? `【读取限制测试】${r.leaked ? '✖ 读到了' : '✔ 没读到'}` : r.skipped ? `${r.task} 跳过：${r.skipped}` : `${r.task}：${r.agree ? '✔ 一致' : '✖ 不一致'}${r.missedAlarm ? '（漏报）' : ''}`}</div>)}
      </div>
    </Card>
  );
}
function Settings() {
  return <div className="flex flex-col gap-4"><ApiKeyCard /><details className="panel p-3 text-xs"><summary className="cursor-pointer text-[var(--fg-3)]">Codex 只读试用（11-24 至 11-25，已结束；点开看结果）</summary><div className="mt-2"><CodexTrialCard /></div></details></div>; // 试用已到期（Andy 11-25：旧的收起来）
}
