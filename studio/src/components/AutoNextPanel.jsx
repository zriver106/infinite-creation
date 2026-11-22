import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Checkbox } from './ui.jsx';
import { useToast } from './toast.jsx';

// 「运行状态」卡片底部：
//   ① 「自动生成下一章」+「到第 __ 章为止」（projects.context.auto_next / auto_next_until，默认 13）
//   ② 「自动生成下一章分镜」+「到第 __ 章为止」（auto_next_storyboard / auto_next_storyboard_until，默认 13）
//   ③ 最近一次交付结果（交付失败时红字提示）
// 勾选本身不提交任务：从下一次本章任务成功收尾开始续；中途取消勾选，跑完当前章就停。
const UNTIL_DEFAULT = 13;

function untilOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : UNTIL_DEFAULT;
}

function UntilInput({ value, disabled, onCommit, label }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function commit() {
    const n = Math.trunc(Number(text));
    if (!Number.isFinite(n) || n < 1) {
      setText(String(value));
      onCommit(null);
      return;
    }
    if (n !== value) onCommit(n);
  }
  return (
    <div className="flex items-center gap-1.5 pl-[28px] text-[11px] text-[var(--fg-3)]">
      <span>到第</span>
      <input
        type="number"
        min={1}
        step={1}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={label}
        className="h-6 w-14 rounded-md border border-[var(--line)] bg-white/[0.035] px-1.5 text-center text-[11px] text-[var(--fg)] focus:border-[color-mix(in_srgb,var(--accent)_55%,transparent)] focus:outline-none disabled:opacity-50"
      />
      <span>章为止</span>
    </div>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export default function AutoNextPanel({ projectId, project, readOnly, onSaved, refreshKey }) {
  const toast = useToast();
  const ctx = (project && project.context) || {};
  const videoOn = ctx.auto_next === true;
  const sbOn = ctx.auto_next_storyboard === true;
  const videoUntil = untilOf(ctx.auto_next_until);
  const sbUntil = untilOf(ctx.auto_next_storyboard_until);
  const [saving, setSaving] = useState(false);
  const [lastDelivery, setLastDelivery] = useState(null);
  const [guard, setGuard] = useState(null);

  // 续章守护状态（出片守护 / 分镜守护各一行），15 秒刷新一次
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get('/api/projects/' + projectId + '/auto-next')
        .then((d) => {
          if (alive) setGuard((d && d.guardian) || null);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, refreshKey, videoOn, sbOn]);

  useEffect(() => {
    let alive = true;
    api
      .get('/api/projects/' + projectId + '/delivery')
      .then((d) => {
        if (!alive) return;
        const last = (d.log || []).find((e) => e && e.status !== 'skipped') || null;
        setLastDelivery(d.enabled && d.dir ? last : last && last.status === 'failed' ? last : null);
      })
      .catch(() => {
        if (alive) setLastDelivery(null);
      });
    return () => {
      alive = false;
    };
  }, [projectId, refreshKey]);

  async function save(patch) {
    setSaving(true);
    try {
      await api.put('/api/projects/' + projectId + '/auto-next', patch);
      onSaved && onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const bad = () => toast.error('「到第 __ 章为止」要填 ≥1 的整数');
  const disabled = readOnly || saving;

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--line)] pt-2.5">
      <Checkbox checked={videoOn} disabled={disabled} onChange={(v) => save({ video: { enabled: v } })} label="自动生成下一章" />
      <UntilInput
        value={videoUntil}
        disabled={disabled}
        label="自动生成下一章到第几章为止"
        onCommit={(n) => (n == null ? bad() : save({ video: { until: n } }))}
      />
      <Checkbox checked={sbOn} disabled={disabled} onChange={(v) => save({ storyboard: { enabled: v } })} label="自动生成下一章分镜" />
      <UntilInput
        value={sbUntil}
        disabled={disabled}
        label="自动生成下一章分镜到第几章为止"
        onCommit={(n) => (n == null ? bad() : save({ storyboard: { until: n } }))}
      />
      <p className="m-0 text-[10.5px] leading-relaxed text-[var(--fg-4)]">
        勾上后由续章守护每 60 秒检查一次：上一章成功、本项目空闲才续下一章，每次只提交一章；失败、取消、结果不明、取消勾选或到达章号上限就不续。
        {videoOn && sbOn ? '出片守护和分镜守护各管各的：分镜走文本队列，不等出片；已有分镜或已出片的章不会被自动重拆。' : ''}
      </p>
      {guard && (videoOn || sbOn) ? (
        <div
          data-testid="guardian-status"
          className="flex flex-col gap-0.5 rounded-md border border-[var(--line)] px-2 py-1 text-[10.5px] leading-relaxed text-[var(--fg-3)]"
        >
          {(guard.lines || []).map((l, k) => (
            <span key={k} className="break-all">
              {l}
            </span>
          ))}
        </div>
      ) : null}
      {lastDelivery ? (
        <p
          className={
            'm-0 break-all rounded-md px-2 py-1 text-[10.5px] leading-relaxed ' +
            (lastDelivery.status === 'failed'
              ? 'border border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] text-[var(--danger)]'
              : 'text-[var(--fg-4)]')
          }
        >
          {lastDelivery.status === 'failed'
            ? '交付失败：EP' + (lastDelivery.ep == null ? '?' : lastDelivery.ep) + ' · ' + (lastDelivery.error || '未知错误') + ' · ' + fmtTime(lastDelivery.at)
            : '最近交付：EP' + lastDelivery.ep + (lastDelivery.unchanged ? '（内容未变）' : '') + ' · ' + fmtTime(lastDelivery.at)}
        </p>
      ) : null}
    </div>
  );
}
