import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Clapperboard, FileText, GripVertical, Layers, Pencil, Play, Plus, SlidersHorizontal, Square, Wand2, X } from 'lucide-react';
import { api, uploadForm } from '../lib/api.js';
import { fileUrl } from '../lib/format.js';
import { Button, EmptyState, Field, Input, Progress, StatusPill, Textarea } from '../components/ui.jsx';
import { BusyOverlay, Modal } from '../components/overlays.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ReferencePicker from '../components/ReferencePicker.jsx';
import ChapterOps from '../components/ChapterOps.jsx';
import ScriptDialog from '../components/ScriptDialog.jsx';
import { useToast } from '../components/toast.jsx';

const GEN_LABEL = { empty: '无分镜', pending: '待生成', running: '生成中', done: '完成', failed: '失败' };

// 主按钮三种状态：全部完成（仍显示「生成」，提示去重新生成）/ 有进度或上次中断 → 「继续」/ 其余 → 从头「生成」
function runButtonState(c) {
  if (c.genStatus === 'done') return { label: '生成', title: '本章已全部完成；要重做请用『生成操作』里的重新生成' };
  if (c.shotCount > 0 || c.hasScript || c.doneCount > 0 || c.lastJobStatus === 'failed' || c.lastJobStatus === 'cancelled') {
    return { label: '继续', title: '从上次中断的地方接着做，已有的剧本、分镜和视频都会保留' };
  }
  return { label: '生成', title: '从头生成本章' };
}

export default function ChaptersPage({ projectId, chapters, onRefresh, running, runningChapter, runningChapters, readOnly = false, canEdit = true, canGenerate = true, features = {}, onRun, onStop, onGoLogs }) {
  const toast = useToast();
  const [order, setOrder] = useState(chapters);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editNovel, setEditNovel] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [busy, setBusy] = useState(null);
  const [vision, setVision] = useState(false);
  const [refs, setRefs] = useState([]);
  const [savedRefs, setSavedRefs] = useState([]);
  const [operating, setOperating] = useState(null);
  const [scripting, setScripting] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [sbSubmitting, setSbSubmitting] = useState(null);
  const [pwSubmitting, setPwSubmitting] = useState(null);
  const [acSubmitting, setAcSubmitting] = useState(null);
  const [stopping, setStopping] = useState(false);
  const isChapterRunning = (title) =>
    runningChapters
      ? (typeof runningChapters.has === 'function' ? runningChapters.has(title) : runningChapters.includes(title))
      : runningChapter === title;
  const allChaptersRunning = chapters.length > 0 && chapters.every((c) => isChapterRunning(c.title));

  useEffect(() => setOrder(chapters), [chapters]);

  useEffect(() => {
    api.get('/api/config').then((c) => setVision(!!c?.llm?.vision)).catch(() => {});
  }, []);

  const loadRefs = useCallback(() => {
    api.get('/api/projects/' + projectId + '/references').then(setSavedRefs).catch((e) => toast.error(e.message));
  }, [projectId]);

  useEffect(() => loadRefs(), [loadRefs]);

  useEffect(() => {
    if (submitting && (running || runningChapter)) setSubmitting(null);
  }, [running, runningChapter, submitting]);

  useEffect(() => {
    if (stopping && !running) setStopping(false);
  }, [running, stopping]);

  const chapterRefs = editing ? savedRefs.filter((r) => r.chapter_id === editing.id) : [];

  function openCreate() {
    setCreating(true);
    setEditTitle('');
    setEditNovel('');
    setEditDirty(false);
    setRefs([]);
  }

  function openEdit(c) {
    setEditing(c);
    setEditTitle(c.title || '');
    setEditNovel(c.novel || '');
    setEditDirty(false);
    setRefs([]);
  }

  async function saveChapter() {
    const isNew = !!creating;
    if (!isNew && !editing) return;
    setBusy(isNew ? '正在创建章节…' : '正在保存章节…');
    try {
      let cid = editing ? editing.id : null;
      if (isNew) {
        const payload = { novel: editNovel };
        if ((editTitle || '').trim()) payload.title = editTitle.trim();
        const c = await api.post('/api/projects/' + projectId + '/chapters', payload);
        cid = c.id;
      } else {
        await api.patch('/api/projects/' + projectId + '/chapters/' + cid, { title: editTitle, novel: editNovel });
      }
      if (refs.length && cid) await uploadRefs(cid);
      toast.success(isNew ? '已创建章节' : '已保存「' + editTitle + '」');
      setCreating(false);
      setEditing(null);
      setEditDirty(false);
      onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function uploadRefs(chapterId) {
    let done = 0;
    for (const it of refs) {
      const fd = new FormData();
      fd.append('file', it.file);
      fd.append('mode', it.mode);
      fd.append('category', it.category || 'other');
      fd.append('chapter_id', chapterId);
      fd.append('description', it.description || '');
      try {
        await uploadForm('/api/projects/' + projectId + '/references', fd);
      } catch (e) {
        throw new Error('「' + (it.file.name || '参考图') + '」' + e.message + (done ? '；前 ' + done + ' 张已上传成功，可直接继续传剩下的' : ''));
      }
      done += 1;
      setRefs((prev) => prev.filter((x) => x.key !== it.key));
    }
    loadRefs();
    return done;
  }

  async function delRef(rid) {
    try {
      await api.del('/api/projects/' + projectId + '/references/' + rid);
      loadRefs();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function updateRef(rid, patch) {
    setSavedRefs((prev) => prev.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
    try {
      await api.patch('/api/projects/' + projectId + '/references/' + rid, patch);
    } catch (e) {
      toast.error(e.message);
      loadRefs();
    }
  }

  async function submitRun(title) {
    setSubmitting(title);
    try {
      await onRun(title);
    } catch (e) {
      toast.error(e.message);
      setSubmitting(null);
    }
  }

  // 「生成分镜」：只跑到分镜（regenerate?mode=full，只跑 LLM 文本，不出视频）。
  // 没有分镜直接拆；已有分镜先确认（确认后清空本章分镜再重拆）。本章有任务时按钮置灰，后端同章去重再挡一次（409）。
  async function submitStoryboard(c) {
    if (c.shotCount > 0) {
      const ok = await toast.confirm(
        '「' + c.title + '」已有 ' + c.shotCount + ' 条分镜' + (c.doneCount ? '（其中 ' + c.doneCount + ' 条已出视频）' : '') + '。\n'
          + '重新拆分会先清空本章现有分镜，再按剧本重新拆分镜、写提示词（只跑 LLM 文本，不出图 / 视频；素材保留）。\n确定重拆？',
        { danger: true, confirmLabel: '清空并重拆分镜' },
      );
      if (!ok) return;
    }
    setSbSubmitting(c.title);
    try {
      await api.post('/api/projects/' + projectId + '/chapters/' + c.id + '/regenerate?mode=full');
      toast.info('已提交「' + c.title + '」生成分镜（只跑文本，不出视频）');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSbSubmitting(null);
    }
  }

  // 「提示词撰写」：只给本章补写缺失的分镜视频提示词（不清分镜、不改剧本、不出视频），进分镜（文本）队列。
  // 按钮状态跟章节进度：本章有任务 → 置灰；没分镜 → 置灰；缺 N 镜 → 「提示词撰写（缺 N）」；已齐 → 置灰。
  // 后端同章去重再挡一次（409）。
  function promptWriteState(c, isRunningChapter) {
    const n = Number(c.missingPromptCount) || 0;
    const withVideo = Number(c.missingPromptWithVideo) || 0;
    const extra = withVideo ? '；另有 ' + withVideo + ' 镜已出视频但没有提示词，不补写' : '';
    if (isRunningChapter) return { label: n ? '提示词撰写（缺 ' + n + '）' : '提示词撰写', disabled: true, title: '本章有任务在跑，不能撰写提示词' };
    if (!c.shotCount) return { label: '提示词撰写', disabled: true, title: '本章还没有分镜，先「生成分镜」' };
    if (!n) return { label: '提示词已齐', disabled: true, title: '本章 ' + c.shotCount + ' 镜都已有视频提示词' + extra };
    return { label: '提示词撰写（缺 ' + n + '）', disabled: false, title: '只给本章缺提示词的 ' + n + ' 镜补写视频提示词（复用已有素材；不清分镜、不改剧本、不出视频）' + extra };
  }

  async function submitPromptWrite(c) {
    setPwSubmitting(c.title);
    try {
      const r = await api.post('/api/projects/' + projectId + '/chapters/' + c.id + '/write-prompts');
      toast.info('已提交「' + c.title + '」提示词撰写（' + (r && r.missing != null ? '缺 ' + r.missing + ' 镜，' : '') + '只跑文本，不出视频）');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPwSubmitting(null);
    }
  }

  // 「检查资产」+ 徽标：只对缺件单模式（asset_mode=gap-list）的项目显示，其它项目界面不变。
  // 检查只读本章需求、登记库里同名唯一的音色、写缺件单（草稿\IC缺件单），不提交任何任务、不出图。
  function assetBadge(c) {
    if (c.assetMode !== 'gap-list') return null;
    const at = c.assetCheckedAt ? new Date(c.assetCheckedAt).toLocaleString() : '';
    const file = c.assetGapFile ? '；缺件单：' + c.assetGapFile : '';
    const rv = Number(c.assetReview) || 0;
    if (c.assetState === 'missing') return { text: '缺件 ' + (Number(c.assetMissing) || 0), cls: 'text-[var(--danger,#e5484d)]', title: '最近检查 ' + at + file + (rv ? '；另有 ' + rv + ' 项 IC 自生成待资产管理复核' : '') };
    if (c.assetState === 'complete' && rv) return { text: '待复核 ' + rv, cls: 'text-[var(--warning,#f5a524)]', title: '资产齐全（IC 自生成的先算齐），' + rv + ' 项待资产管理复核；最近检查 ' + at + file };
    if (c.assetState === 'complete') return { text: '资产齐全', cls: 'text-[var(--success,#30a46c)]', title: '最近检查 ' + at };
    if (c.assetState === 'reference') return { text: '资产参考', cls: 'text-[var(--fg-4)]', title: '剧本前清单，仅供参考、不拦；最近检查 ' + at + file };
    return { text: '资产未检查', cls: 'text-[var(--fg-4)]', title: '点「检查资产」核对本章需要的人物/场景/道具/音色' };
  }

  async function submitAssetCheck(c) {
    setAcSubmitting(c.title);
    try {
      const r = await api.post('/api/projects/' + projectId + '/chapters/' + c.id + '/asset-check');
      const s = (r && r.summary) || {};
      const reg = (r && r.registered && r.registered.filter((x) => !x.error).length) || 0;
      const msg = '「' + c.title + '」资产检查：' + (s.missing ? '缺 ' + s.missing + ' 项' : '齐全') + (s.review ? '，待复核 ' + s.review : '') + (reg ? '，已登记音色 ' + reg : '') + (r && r.gapFile ? '；缺件单 ' + r.gapFile : '');
      if (s.missing) toast.error(msg); else toast.info(msg);
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAcSubmitting(null);
    }
  }

  // 资产分析（Andy 11-26：章节页加「生成全部资产」「生成资产」）：起 IC 资产分析任务（读规则 → 读原著 → 地点表、戏份说明、缺图单），不出图
  const [aaSubmitting, setAaSubmitting] = useState('');
  const chapterNoOf = (c) => { const m = String((c && c.title) || '').match(/第\s*(\d+)\s*章/); return m ? Number(m[1]) : Number(c && c.seq) || 0; };
  async function submitAssetAnalyze(range, key) {
    setAaSubmitting(key);
    try {
      await api.post('/api/projects/' + projectId + '/assets/analyze', { chapters: range });
      toast.success('已提交资产分析：第 ' + range[0] + (range[1] !== range[0] ? '–' + range[1] : '') + ' 章（读原著定地点表、戏份说明和缺图单，在「任务」里看进度）');
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setAaSubmitting('');
    }
  }

  async function handleStop(chapter) {
    setStopping(true);
    try {
      await onStop(chapter);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setStopping(false);
    }
  }

  async function removeChapter(c) {
    if (!(await toast.confirm('删除「' + c.title + '」及其分镜？此操作不可逆。', { danger: true }))) return;
    setBusy('正在删除章节…');
    try {
      await api.del('/api/projects/' + projectId + '/chapters/' + c.id);
      toast.success('已删除「' + c.title + '」');
      onRefresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function persistReorder(list) {
    try {
      await api.patch('/api/projects/' + projectId + '/chapters', { ids: list.map((c) => c.id) });
      onRefresh();
    } catch (e) {
      toast.error(e.message);
      onRefresh();
    }
  }

  function handleDrop(to) {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    persistReorder(next);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Structure"
        title="章节管理"
        description="先规划整本书的章节骨架，再逐章生成。素材库全项目共用，分镜在「分镜审查」里查看。"
        actions={
          canEdit || canGenerate ? (
            <>
              {canEdit ? (
                <Button variant="primary" size="md" onClick={openCreate}>
                  <Plus size={14} /> 新增章节
                </Button>
              ) : null}
              {canGenerate && features.buttons?.generate !== false ? (
                <>
                  <Button variant="secondary" size="md" disabled={!chapters.length || allChaptersRunning} onClick={() => submitRun(null)}>
                    <Play size={13} /> 生成全部章节
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    title="全书资产分析：按场景生命周期读原著，定地点表（一个地点一套资产）、写戏份说明、出缺图单；不出图"
                    loading={aaSubmitting === '__all__'}
                    disabled={!chapters.length || !!aaSubmitting}
                    onClick={() => { const nos = chapters.map(chapterNoOf).filter((n) => n > 0); submitAssetAnalyze([Math.min(...nos), Math.max(...nos)], '__all__'); }}
                  >
                    <BookOpen size={13} /> 生成全部资产
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      />

      {order.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {order.map((c, i) => {
            const isRunningChapter = isChapterRunning(c.title);
            const pct = c.shotCount ? Math.round((c.doneCount / c.shotCount) * 100) : 0;
            const loading = (submitting === c.title && !isRunningChapter) || (isRunningChapter && stopping);
            return (
              <article
                key={c.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overIndex !== i) setOverIndex(i);
                }}
                onDrop={() => handleDrop(i)}
                className={clsx(
                  'panel panel-hover group relative flex flex-col overflow-hidden',
                  overIndex === i && dragIndex !== null && dragIndex !== i && 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] shadow-[0_0_0_3px_rgba(232,177,92,.10)]',
                  dragIndex === i && 'opacity-60',
                )}
              >
                <div className="relative aspect-video overflow-hidden bg-black/35">
                  {c.poster ? (
                    <img src={fileUrl(projectId, c.poster)} alt={c.title} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_120%_at_30%_0%,rgba(255,255,255,.05),transparent_60%)] text-[var(--fg-4)]">
                      <BookOpen size={20} />
                      <span className="font-mono text-[10px]">CHAPTER {String(i + 1).padStart(2, '0')}</span>
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_55%,rgba(0,0,0,.5))]" />

                  {canEdit ? (
                    <button
                      type="button"
                      draggable
                      title="拖拽排序"
                      aria-label="拖拽排序"
                      onDragStart={(e) => {
                        setDragIndex(i);
                        try {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', String(i));
                        } catch {
                          /* noop */
                        }
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      className="absolute left-2.5 top-2.5 cursor-grab rounded-lg border border-white/10 bg-black/50 p-1.5 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:text-white active:cursor-grabbing group-hover:opacity-100"
                    >
                      <GripVertical size={13} />
                    </button>
                  ) : null}

                  {canEdit && features.buttons?.delete !== false ? (
                    <button
                      type="button"
                      title="删除章节"
                      aria-label={'删除 ' + c.title}
                      onClick={() => removeChapter(c)}
                      className="absolute right-2.5 top-2.5 rounded-lg border border-white/10 bg-black/50 p-1.5 text-white/70 opacity-0 backdrop-blur transition-all duration-200 hover:border-[color-mix(in_srgb,var(--danger)_45%,transparent)] hover:text-[var(--danger)] group-hover:opacity-100"
                    >
                      <X size={13} />
                    </button>
                  ) : null}

                  <div className="absolute bottom-2.5 left-2.5">
                    <StatusPill status={c.genStatus === 'running' ? 'running' : c.genStatus === 'done' ? 'done' : c.genStatus === 'failed' ? 'failed' : 'pending'}>
                      {GEN_LABEL[c.genStatus] || c.status}
                    </StatusPill>
                  </div>
                </div>

                <div className="flex flex-col gap-2.5 p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="m-0 font-mono text-[9.5px] tracking-[.14em] text-[var(--fg-4)]">CHAPTER {String(i + 1).padStart(2, '0')}</p>
                      <h3 className="m-0 mt-0.5 truncate text-[14px] font-medium text-[var(--fg)]" title={c.title}>
                        {c.title}
                      </h3>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Progress value={pct} tone={c.genStatus === 'done' ? 'success' : c.genStatus === 'failed' ? 'danger' : 'accent'} height={3} />
                    <div className="flex items-center justify-between text-[10.5px] text-[var(--fg-4)]">
                      <span className="inline-flex items-center gap-1">
                        <Clapperboard size={10} className="opacity-70" />
                        {c.shotCount ? c.doneCount + ' / ' + c.shotCount + ' 镜' : '暂无分镜'}
                      </span>
                      <span>{isRunningChapter ? '正在生成' : pct ? pct + '%' : ''}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10.5px] text-[var(--fg-4)]">
                      <FileText size={10} className="opacity-70" />
                      {c.script ? c.script.length.toLocaleString() + ' 字剧本' : '无剧本'}
                      {(() => {
                        const b = assetBadge(c);
                        return b ? (
                          <span data-testid="asset-badge" className={clsx('ml-auto', b.cls)} title={b.title}>
                            {b.text}
                          </span>
                        ) : null;
                      })()}
                    </div>
                  </div>

                  {canEdit || canGenerate ? (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {canGenerate && features.buttons?.generate !== false ? (
                        <>
                          {isRunningChapter ? (
                            <Button variant="danger" size="xs" className="min-w-[4.5rem] flex-1" loading={stopping} onClick={() => handleStop(c.title)}>
                              <Square size={11} /> 停止
                            </Button>
                          ) : (
                            <Button
                              variant="primary"
                              size="xs"
                              className="min-w-[4.5rem] flex-1"
                              loading={loading}
                              disabled={isRunningChapter || loading}
                              title={runButtonState(c).title}
                              onClick={() => submitRun(c.title)}
                            >
                              <Play size={11} /> {runButtonState(c).label}
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            size="xs"
                            className="min-w-[5.5rem] flex-1"
                            title={isRunningChapter ? '本章有任务在跑，不能生成分镜' : c.shotCount ? '已有分镜：确认后清空并重拆（只跑文本，不出视频）' : '只拆分镜、写提示词，不出视频'}
                            loading={sbSubmitting === c.title}
                            disabled={isRunningChapter || loading || sbSubmitting === c.title}
                            onClick={() => submitStoryboard(c)}
                          >
                            <Layers size={11} /> 生成分镜
                          </Button>
                          {(() => {
                            const pw = promptWriteState(c, isRunningChapter);
                            return (
                              <Button
                                variant="secondary"
                                size="xs"
                                className="min-w-[5.5rem] flex-1"
                                data-testid="prompt-write-btn"
                                title={pw.title}
                                loading={pwSubmitting === c.title}
                                disabled={pw.disabled || loading || pwSubmitting === c.title}
                                onClick={() => submitPromptWrite(c)}
                              >
                                <Wand2 size={11} /> {pw.label}
                              </Button>
                            );
                          })()}
                          {c.assetMode === 'gap-list' ? (
                            <Button
                              variant="secondary"
                              size="xs"
                              className="min-w-[5.5rem] flex-1"
                              data-testid="asset-check-btn"
                              title="核对本章需要的人物/场景/道具/音色是否已入库：缺的写进缺件单（草稿\IC缺件单），库里同名唯一的音色自动登记；不提交任务、不出图"
                              loading={acSubmitting === c.title}
                              disabled={acSubmitting === c.title}
                              onClick={() => submitAssetCheck(c)}
                            >
                              <BookOpen size={11} /> 检查资产
                            </Button>
                          ) : null}
                          <Button
                            variant="secondary"
                            size="xs"
                            className="min-w-[5.5rem] flex-1"
                            title="本章资产分析：本章出现的场景、人物服装、道具按生命周期读原著，登记地点表、写戏份说明、出缺图单；不出图"
                            loading={aaSubmitting === c.id}
                            disabled={!!aaSubmitting || !chapterNoOf(c)}
                            onClick={() => submitAssetAnalyze([chapterNoOf(c), chapterNoOf(c)], c.id)}
                          >
                            <BookOpen size={11} /> 生成资产
                          </Button>
                        </>
                      ) : null}
                      {canEdit ? (
                        <>
                          <Button variant="secondary" size="iconSm" title="章节剧本" aria-label="章节剧本" onClick={() => setScripting(c)}>
                            <FileText size={13} />
                          </Button>
                          <Button variant="secondary" size="iconSm" title="编辑章节" aria-label="编辑章节" onClick={() => openEdit(c)}>
                            <Pencil size={13} />
                          </Button>
                          <Button variant="secondary" size="iconSm" title="生成操作" aria-label="生成操作" onClick={() => setOperating(c)}>
                            <SlidersHorizontal size={13} />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <EmptyState
            icon={BookOpen}
            title="还没有章节"
            description="新增章节并粘贴本章小说原文；标题留空会自动命名为「第 N 章」。"
            action={
              canEdit ? (
                <Button variant="primary" size="md" onClick={openCreate}>
                  <Plus size={14} /> 新增章节
                </Button>
              ) : null
            }
          />
        </div>
      )}

      <Modal
        open={creating || !!editing}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setCreating(false);
            setEditing(null);
          }
        }}
        title={creating ? '新建章节' : '编辑章节'}
        description={creating ? '标题可留空，自动命名为「第 N 章」；建议同时粘贴本章原文。' : editing ? editing.title : ''}
        size="xl"
        footer={
          <>
            <Button variant="ghost" size="md" disabled={!!busy} onClick={() => { setCreating(false); setEditing(null); }}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={!!busy}
              disabled={creating ? false : !editDirty && !refs.length}
              onClick={saveChapter}
            >
              保存本章
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="章节标题">
            <Input value={editTitle} onChange={(e) => { setEditTitle(e.target.value); setEditDirty(true); }} placeholder={creating ? '留空自动命名为「第 N 章」' : '章节标题'} />
          </Field>
          <Field label="本章小说原文" hint={editNovel ? editNovel.length.toLocaleString() + ' 字' : undefined}>
            <Textarea
              rows={9}
              value={editNovel}
              onChange={(e) => { setEditNovel(e.target.value); setEditDirty(true); }}
              placeholder="粘贴或编辑本章原文…"
              className="min-h-[170px]"
            />
          </Field>
          <p className="m-0 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-[var(--fg-2)]">参考图片素材</span>
            <ReferencePicker
              projectId={projectId}
              items={refs}
              onChange={setRefs}
              saved={chapterRefs}
              onUpdateSaved={updateRef}
              onDeleteSaved={delRef}
              allowAdd={vision}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={!!operating}
        onOpenChange={(o) => !o && setOperating(null)}
        title={'生成操作' + (operating ? ' · ' + operating.title : '')}
        description="整章重跑、分阶段运行与重新拆分分镜都在这里。"
        size="lg"
      >
        {operating ? (
          <ChapterOps
            projectId={projectId}
            chapter={operating}
            running={isChapterRunning(operating.title)}
            runningChapter={isChapterRunning(operating.title) ? operating.title : null}
            onRun={onRun}
            onStop={() => onStop(operating.title)}
            onRefresh={onRefresh}
            onGoLogs={() => {
              setOperating(null);
              onGoLogs && onGoLogs();
            }}
          />
        ) : null}
      </Modal>

      <BusyOverlay show={!!busy} text={busy} />

      {scripting ? (
        <ScriptDialog
          key={scripting.id}
          projectId={projectId}
          chapter={scripting}
          running={isChapterRunning(scripting.title)}
          onRefresh={onRefresh}
          onClose={() => setScripting(null)}
        />
      ) : null}
    </div>
  );
}
