// ic32 成片后期：选章 → 检查心声时间窗 / 声线 → 设置 → 起一条后期任务（IC 内流水线，输出一条新成片）
import { useEffect, useState } from 'react';
import { Clapperboard, Save, Wand2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button, Checkbox, Field, Input, Select, Spinner } from './ui.jsx';
import { Modal } from './overlays.jsx';
import { useToast } from './toast.jsx';

const KIND = { os: '心声', phone: '电话', broadcast: '广播', system: '系统音', narration: '旁白' };

export default function PostProduceDialog({ projectId, open, onOpenChange, onStarted }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [chapter, setChapter] = useState('');
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/api/projects/' + projectId + '/post-produce' + (chapter ? '?chapter=' + encodeURIComponent(chapter) : ''))
      .then((r) => { setData(r); setS((prev) => prev || r.settings); if (!chapter && r.suggested) setChapter(r.suggested); })
      .catch((e) => toast.error(e.message));
  }, [open, projectId, chapter]);

  const set = (k, v) => setS((p) => ({ ...p, [k]: v }));
  const check = data && data.check;

  async function save() {
    try { const r = await api.put('/api/projects/' + projectId + '/post-produce', { settings: s }); setS(r.settings); toast.success('已保存为本项目的后期设置'); }
    catch (e) { toast.error(e.message); }
  }

  async function start() {
    if (!chapter) return;
    setBusy(true);
    try {
      const r = await api.post('/api/projects/' + projectId + '/post-produce', { chapter, options: s });
      toast.success('已开始「' + r.chapter + '」后期（' + r.shots + ' 镜），完成后成片出现在本页');
      onStarted && onStarted(r);
      onOpenChange(false);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="后期成片"
      description="拼接本章分镜 → 心声窗静音并用角色克隆声配音 → 剪空档 → 一句一条字幕 → 垫 BGM → 输出新成片（原片不动）"
      size="lg"
      footer={
        <>
          <Button variant="secondary" size="md" disabled={!s} onClick={save}><Save size={13} /> 存为项目设置</Button>
          <Button variant="primary" size="md" loading={busy} disabled={!s || !chapter || !(check && check.shots)} onClick={start}><Wand2 size={13} /> 开始后期</Button>
        </>
      }
    >
      {!data || !s ? <Spinner /> : (
        <div className="flex flex-col gap-4 text-[12px]">
          <Field label="章节">
            <Select value={chapter} onChange={setChapter} items={(data.chapters || []).map((c) => ({ value: c.title, label: c.title + '（' + c.done + ' 镜）' }))} />
          </Field>
          {check ? (
            <div className="rounded-lg border border-[var(--line)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{check.shots} 镜</Badge>
                <Badge tone="neutral">约 {check.est_total}s</Badge>
                <Badge tone="neutral">台词 {check.lines} 行 / {check.sentences} 句</Badge>
                <Badge tone={check.offscreen_no_window || check.offscreen_no_voice ? 'danger' : 'success'}>画外台词 {check.offscreen.length} 条</Badge>
                <Badge tone={check.music ? 'success' : 'neutral'}>{check.music ? '已选 BGM' : '无 BGM'}</Badge>
              </div>
              {check.offscreen.length ? (
                <ul className="m-0 mt-2 max-h-40 list-none overflow-auto p-0 text-[11px] text-[var(--fg-3)]">
                  {check.offscreen.map((o, i) => (
                    <li key={i} className={o.window && o.voice ? '' : 'text-[var(--danger)]'}>
                      镜{o.shot_idx} · {KIND[o.kind] || o.kind} · {o.speaker}：{o.text}
                      {' '}（{o.window ? o.window.start + '–' + o.window.end + 's' : '没找到时间窗'}{o.voice ? '' : '，没有声线'}）
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Checkbox checked={s.os_mute} onChange={(v) => set('os_mute', v)} label="心声窗口内静音原声" />
            <Checkbox checked={s.os_dub} onChange={(v) => set('os_dub', v)} label="用角色克隆声配心声" />
            <Checkbox checked={s.subtitles} onChange={(v) => set('subtitles', v)} label="字幕（一句一条）" />
            <Checkbox checked={s.bgm} onChange={(v) => set('bgm', v)} label="垫本章 BGM" />
            <Checkbox checked={s.trim_gaps} onChange={(v) => set('trim_gaps', v)} label="剪空档（不剪台词/心声窗）" />
            <Checkbox checked={s.motion_check} onChange={(v) => set('motion_check', v)} label="只剪画面静止的空档（保留表演）" />
            <Checkbox checked={s.deliver} onChange={(v) => set('deliver', v)} label="完成后交付（EP 文件）" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="空档保留上限（秒）"><Input type="number" step="0.1" value={s.max_gap_sec} onChange={(e) => set('max_gap_sec', Number(e.target.value))} /></Field>
            <Field label="安静电平（dB）"><Input type="number" step="1" value={s.silence_db} onChange={(e) => set('silence_db', Number(e.target.value))} /></Field>
            <Field label="心声配音增益（dB）"><Input type="number" step="1" value={s.dub_gain_db} onChange={(e) => set('dub_gain_db', Number(e.target.value))} /></Field>
          </div>
          {data.reports && data.reports.length ? (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--fg-4)]"><Clapperboard size={12} /> 最近后期</div>
              <ul className="m-0 list-none p-0 text-[11px] text-[var(--fg-3)]">
                {data.reports.slice(0, 5).map((r) => (
                  <li key={r.name} title={(r.issues || []).join('\n')}>
                    {r.chapter} · {r.total_before}s→{r.total_after}s（剪 {r.gaps_cut} 处 {r.removed_sec}s）· 心声静音 {r.mute_windows} 处 / 配音 {r.dubs} 条{r.tts_mock ? '（mock）' : ''} · 字幕 {r.subtitle_cues} 条 · {r.bgm ? 'BGM' : '无BGM'}{r.issues && r.issues.length ? ' · ⚠ ' + r.issues.length : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
