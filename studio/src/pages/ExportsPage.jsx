import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, CaptionsOff, Wand2, CheckCircle2, Download, Film, Play, RefreshCw, Send, Subtitles, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { exportTitle, fmtBytes, fmtTime, withSession } from '../lib/format.js';
import { Badge, Button, Checkbox, EmptyState, Spinner } from '../components/ui.jsx';
import { Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useToast } from '../components/toast.jsx';
import PostProduceDialog from '../components/PostProduceDialog.jsx';

const UP_ACTIVE = new Set(['queued', 'uploading', 'submitting', 'running', 'downloading', 'remuxing']);

export default function ExportsPage({ projectId, readOnly = false, canExport = true, features = {} }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [player, setPlayer] = useState(null);
  // ic31：批量模式分两种——删除 / 升级2k，共用同一套勾选
  const [batchKind, setBatchKind] = useState('delete');
  const [upBusy, setUpBusy] = useState(false);
  // ic32：后期成片
  const [postOpen, setPostOpen] = useState(false);
  const [postWatch, setPostWatch] = useState(0);

  // 2026-11-26（Andy「成片 / 分镜审查 只能看到当前项目的」）：切项目时上一个项目的请求可能晚到（V2 成片 189 条要逐条 ffprobe），
  // 回来时项目已经换了就丢掉，不能把别的项目的列表盖到当前项目上；切项目先清空列表。
  const pidRef = useRef(projectId);
  pidRef.current = projectId;
  const load = useCallback(() => {
    const pid = projectId;
    return api.get('/api/projects/' + pid + '/exports')
      .then((r) => { if (pidRef.current === pid) setFiles(r.files || []); })
      .catch((e) => { if (pidRef.current === pid) toast.error(e.message); });
  }, [projectId]);

  useEffect(() => { setFiles([]); }, [projectId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // 有升级任务在跑时每 4 秒刷新一次状态（上传 / 火山处理 / 下载 / 合音轨）
  const anyActive = files.some((f) => f.upscale_task && UP_ACTIVE.has(f.upscale_task.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  // 后期任务起了之后每 5 秒刷新一次列表，最多 30 分钟（新成片落盘即出现）
  useEffect(() => {
    if (!postWatch) return undefined;
    const t = setInterval(() => { if (Date.now() - postWatch > 30 * 60 * 1000) setPostWatch(0); else load(); }, 5000);
    return () => clearInterval(t);
  }, [postWatch, load]);

  const canUpscale = (f) => !f.res_tier && !(f.upscaled_to && f.upscaled_to.length) && !(f.upscale_task && UP_ACTIVE.has(f.upscale_task.status));
  const upscalable = files.filter(canUpscale);

  async function upscale(names) {
    if (!names.length) return;
    const tip = names.length === 1 ? '把「' + exportTitle(names[0]) + '」提交火山升级 2K？' : '把选中的 ' + names.length + ' 条成片提交火山升级 2K？';
    if (!(await toast.confirm(tip + '火山按处理时长计费；原片保留，升级版完成后单独列出并默认选用。'))) return;
    setUpBusy(true);
    try {
      const r = await api.post('/api/projects/' + projectId + '/exports/upscale', { files: names });
      if (r.tasks && r.tasks.length) toast.success('已提交 ' + r.tasks.length + ' 条升级任务');
      if (r.skipped && r.skipped.length) toast.info('跳过 ' + r.skipped.length + ' 条：' + r.skipped.map((x) => exportTitle(x.name) + '（' + x.reason + '）').join('；'));
      setSelected(new Set());
      setBatchMode(false);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setUpBusy(false);
    }
  }

  async function choose(f) {
    try {
      await api.post('/api/projects/' + projectId + '/exports/select', { name: f.name });
      toast.success('已选用「' + exportTitle(f.name) + '」' + (f.res_tier ? '（' + f.res_tier + '）' : ''));
      await load();
    } catch (e) { toast.error(e.message); }
  }

  async function deliver(f) {
    if (!(await toast.confirm('把选用版本「' + exportTitle(f.name) + '」复制到交付目录？已有的 EP 文件会先归档再覆盖。'))) return;
    try {
      const r = await api.post('/api/projects/' + projectId + '/exports/deliver', { name: f.name });
      if (r.status === 'ok') toast.success('已交付 EP' + r.ep + (r.result && r.result.unchanged ? '（内容相同，未覆盖）' : ''));
      else toast.info('未交付：' + (r.reason || r.error || r.status));
    } catch (e) { toast.error(e.message); }
  }

  const pool = batchKind === 'upscale' ? upscalable : files;
  const allSelected = pool.length > 0 && pool.every((f) => selected.has(f.name));

  function toggle(name) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(pool.map((f) => f.name)));
  }

  async function remove(names) {
    if (!names.length) return;
    setDeleting(true);
    try {
      const r = await api.del('/api/projects/' + projectId + '/exports', { files: names });
      const n = (r.deleted || []).length;
      if (n) toast.success('已删除 ' + n + ' 个成片');
      if (r.failed && r.failed.length) toast.error('部分文件删除失败：' + r.failed.join('、'));
      setSelected(new Set());
      setBatchMode(false);
      if (player && names.includes(player.name)) setPlayer(null);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  }

  async function removeOne(f) {
    if (!(await toast.confirm('删除成片「' + f.name + '」？连同不带字幕版本与 SRT 字幕一起删除，不可恢复。', { danger: true }))) return;
    await remove([f.name]);
  }

  async function removeSelected() {
    const names = [...selected];
    if (!names.length) return;
    if (!(await toast.confirm('删除选中的 ' + names.length + ' 个成片？连同各自的不带字幕版本与 SRT 字幕一起删除，不可恢复。', { danger: true }))) return;
    await remove(names);
  }

  function download(f) {
    const a = document.createElement('a');
    a.href = withSession('/api/projects/' + projectId + '/exports/' + encodeURIComponent(f.name) + '/download');
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Delivery"
        title="成片"
        description="按章节平铺展示；「后期成片」在 IC 里做心声配音、剪空档、字幕和 BGM。点击封面预览，下载、字幕、升2k 与删除都在卡片上。右上角「2K」按实测分辨率标注；同一条的原片与升级版并排，交付用「选用」的那条。"
        actions={
          <>
            {!batchMode && canExport && !readOnly ? (
              <Button variant="primary" size="md" title="心声静音+配音、剪空档、一句一条字幕、BGM，输出一条新成片" onClick={() => setPostOpen(true)}>
                <Wand2 size={13} /> 后期成片
              </Button>
            ) : null}
            {files.length > 0 && !batchMode && canExport && !readOnly ? (
              <Button variant="secondary" size="md" disabled={upBusy} onClick={() => { setBatchKind('upscale'); setSelected(new Set(upscalable.map((f) => f.name))); setBatchMode(true); }}>
                <ArrowUpCircle size={13} /> 批量升级2k
              </Button>
            ) : null}
            {files.length > 0 && !batchMode && canExport && features.buttons?.delete !== false ? (
              <Button variant="danger" size="md" onClick={() => { setBatchKind('delete'); setSelected(new Set()); setBatchMode(true); }}>
                <Trash2 size={13} /> 批量删除
              </Button>
            ) : null}
            {batchMode && batchKind === 'upscale' ? (
              <>
                <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} label={'全选可升级（' + upscalable.length + '）'} />
                <Button variant="primary" size="md" loading={upBusy} disabled={selected.size === 0} onClick={() => upscale([...selected])}>
                  <ArrowUpCircle size={13} /> 升级所选（{selected.size}）
                </Button>
                <Button variant="ghost" size="md" disabled={upBusy} onClick={() => { setSelected(new Set()); setBatchMode(false); }}>
                  取消
                </Button>
              </>
            ) : null}
            {batchMode && batchKind === 'delete' && canExport && features.buttons?.delete !== false ? (
              <>
                <Checkbox checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} label="全选" />
                <Button variant="danger" size="md" disabled={deleting || selected.size === 0} onClick={removeSelected}>
                  删除所选（{selected.size}）
                </Button>
                <Button variant="ghost" size="md" disabled={deleting} onClick={() => { setSelected(new Set()); setBatchMode(false); }}>
                  取消
                </Button>
              </>
            ) : null}
            <Button variant="secondary" size="md" disabled={deleting} onClick={load}>
              <RefreshCw size={13} /> 刷新
            </Button>
          </>
        }
      />

      {loading ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel overflow-hidden">
              <div className="skeleton aspect-video w-full" />
              <div className="flex flex-col gap-2 p-3">
                <div className="skeleton h-3 w-2/3 rounded" />
                <div className="skeleton h-3 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : files.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
          {files.map((f) => {
            const active = batchMode && selected.has(f.name);
            const title = exportTitle(f.name);
            return (
              <article
                key={f.rel}
                className={
                  'panel panel-hover group flex flex-col overflow-hidden transition-colors '
                  + (active ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)]' : '')
                }
              >
                <div className="relative aspect-video overflow-hidden bg-black/40">
                  <video
                    src={withSession(f.url) + '#t=0.1'}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
                  />
                  <button
                    type="button"
                    onClick={() => setPlayer(f)}
                    className="absolute inset-0 flex items-center justify-center bg-black/10 text-white/85 opacity-0 transition-opacity hover:bg-black/25 group-hover:opacity-100"
                    aria-label={'播放 ' + title}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-black/55 backdrop-blur">
                      <Play size={16} />
                    </span>
                  </button>
                  {batchMode && (batchKind !== 'upscale' || canUpscale(f)) ? (
                    <span className="absolute left-2.5 top-2.5 rounded-lg border border-white/15 bg-black/55 p-1 backdrop-blur">
                      <Checkbox checked={selected.has(f.name)} onChange={() => toggle(f.name)} />
                    </span>
                  ) : null}
                  {f.res_tier ? (
                    <span
                      className="pointer-events-none absolute right-2.5 top-2.5 rounded-md border border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-black/65 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-[var(--accent)] backdrop-blur"
                      title={'实测 ' + f.width + '×' + f.height}
                    >
                      {f.res_tier}
                    </span>
                  ) : null}
                  <span className="pointer-events-none absolute bottom-2.5 left-2.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9.5px] text-white/75 backdrop-blur">
                    {fmtBytes(f.size)}
                  </span>
                  {f.width ? (
                    <span className="pointer-events-none absolute bottom-2.5 right-2.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9.5px] text-white/75 backdrop-blur">
                      {f.width}×{f.height}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-1 flex-col gap-2.5 p-3">
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-[13px] font-medium text-[var(--fg)]" title={f.name}>{title}</h3>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--fg-4)]">
                      <Badge tone="neutral">{title.split(' · ')[0]}</Badge>
                      <span>{fmtTime(f.mtime)}</span>
                      {f.group_size > 1 && f.selected ? <Badge tone="success" dot>选用</Badge> : null}
                      {/_后期_/.test(f.name) ? <Badge tone="accent">后期</Badge> : null}
                    </div>
                    {f.upscaled_from ? (
                      <p className="m-0 mt-1 truncate text-[10.5px] text-[var(--fg-3)]" title={f.upscaled_from}>
                        由「{exportTitle(f.upscaled_from)}」升级{f.upscale_provider === 'volc' ? '（火山）' : ''}
                      </p>
                    ) : null}
                    {f.upscaled_to && f.upscaled_to.length ? (
                      <p className="m-0 mt-1 truncate text-[10.5px] text-[var(--fg-3)]" title={f.upscaled_to.join('、')}>
                        已升级为「{f.upscaled_to.map(exportTitle).join('、')}」
                      </p>
                    ) : null}
                    {f.upscale_task && UP_ACTIVE.has(f.upscale_task.status) ? (
                      <p className="m-0 mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--accent)]">
                        <Spinner size={11} /> 升级2K：{f.upscale_task.status_label}
                      </p>
                    ) : null}
                    {f.upscale_task && f.upscale_task.status === 'failed' && !(f.upscaled_to && f.upscaled_to.length) ? (
                      <p className="m-0 mt-1 line-clamp-2 text-[10.5px] text-[var(--danger)]" title={f.upscale_task.error}>
                        升级失败：{f.upscale_task.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-1">
                    <Button variant="primary" size="sm" onClick={() => download(f)}>
                      <Download size={12} /> 下载
                    </Button>
                    {f.srt_name ? (
                      <Button variant="ghost" size="sm" onClick={() => download({ name: f.srt_name })}>
                        <Subtitles size={12} /> SRT
                      </Button>
                    ) : null}
                    {f.nosub_name ? (
                      <Button variant="ghost" size="sm" onClick={() => download({ name: f.nosub_name })}>
                        <CaptionsOff size={12} /> 无字幕
                      </Button>
                    ) : null}
                    {canExport && !readOnly && canUpscale(f) ? (
                      <Button variant="ghost" size="sm" disabled={upBusy} title="提交火山升级 2K（保留原片）" onClick={() => upscale([f.name])}>
                        <ArrowUpCircle size={12} /> {f.upscale_task && f.upscale_task.status === 'failed' ? '重试升2k' : '升2k'}
                      </Button>
                    ) : null}
                    {f.group_size > 1 && !f.selected && canExport && !readOnly ? (
                      <Button variant="ghost" size="sm" title="交付 / 导出用这一条" onClick={() => choose(f)}>
                        <CheckCircle2 size={12} /> 设为选用
                      </Button>
                    ) : null}
                    {f.group_size > 1 && f.selected && canExport && !readOnly ? (
                      <Button variant="ghost" size="sm" title="把选用的这一条复制到交付目录（EP<N>.mp4）" onClick={() => deliver(f)}>
                        <Send size={12} /> 交付
                      </Button>
                    ) : null}
                    {canExport && features.buttons?.delete !== false ? (
                      <Button variant="ghost" size="iconSm" title="删除" aria-label="删除" disabled={deleting} onClick={() => removeOne(f)} className="ml-auto">
                        <Trash2 size={13} className="text-[var(--danger)]" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={Film}
            title="暂无成片"
            description="在「分镜审查」页导出本章成片，合并好的最终视频会出现在这里。"
          />
        </div>
      )}

      <PostProduceDialog projectId={projectId} open={postOpen} onOpenChange={setPostOpen} onStarted={() => setPostWatch(Date.now())} />

      <Modal
        open={!!player}
        onOpenChange={(o) => !o && setPlayer(null)}
        title={player ? exportTitle(player.name) : '成片预览'}
        description={player ? fmtBytes(player.size) + ' · ' + fmtTime(player.mtime) : ''}
        size="xl"
        footer={
          player ? (
            <>
              {player.srt_name ? (
                <Button variant="secondary" size="md" onClick={() => download({ name: player.srt_name })}>
                  <Subtitles size={13} /> 下载 SRT
                </Button>
              ) : null}
              {player.nosub_name ? (
                <Button variant="secondary" size="md" onClick={() => download({ name: player.nosub_name })}>
                  <CaptionsOff size={13} /> 下载无字幕版
                </Button>
              ) : null}
              <Button variant="primary" size="md" onClick={() => download(player)}>
                <Download size={13} /> 下载成片
              </Button>
            </>
          ) : null
        }
      >
        {player ? (
          <video className="max-h-[68vh] w-full rounded-lg bg-black" controls autoPlay src={withSession(player.url)} />
        ) : null}
      </Modal>
    </div>
  );
}
