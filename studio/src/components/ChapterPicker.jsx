// 章节选择器：用于分镜审查等需要在大量章节（几百上千章）之间切换的场景。
// 提供「第一章 / 上一章 / 下一章 / 最后一章」快捷按钮、可搜索下拉列表、按章号直接跳转。
// 章号口径：跳转先按标题「第N章」匹配，匹配不到再按位置（chapters 数组里的第 N 个，从 1 开始）；
// 列表左侧显示的数字与过滤仍按位置，与章节管理页的顺序一致。
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { Button, Input } from './ui.jsx';
import { useToast } from './toast.jsx';

const MAX_RENDER = 300;
const TITLE_HAS_NO = /^\s*第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*章/;

// 默认章节：最后一个已有分镜的章节；都没有分镜就取第一章；空数组返回 ''。
export function defaultChapterId(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (Number(list[i]?.shotCount) > 0) return list[i].id;
  }
  return list.length ? list[0].id : '';
}

// 按标题里的「第N章」查找章节，返回下标，找不到返回 -1。
// 口径：标题去掉所有空白后匹配 /第0*N章/，N 为阿拉伯数字，允许前导 0（如“第007章”匹配 N=7）；
// “第”与“章”把数字两端夹住，所以 N=1 不会匹配到“第12章”“第21章”。
// 只认阿拉伯数字，不解析中文数字；多条匹配时取数组里的第一条。
function findChapterIndexByTitleNo(chapters, n) {
  if (!Array.isArray(chapters) || !Number.isInteger(n) || n < 1) return -1;
  const re = new RegExp('第0*' + n + '章');
  return chapters.findIndex((c) => re.test(String(c?.title || '').replace(/\s+/g, '')));
}

function chapterLabel(no, title) {
  const t = String(title || '').trim();
  if (!t) return '第 ' + no + ' 章';
  return TITLE_HAS_NO.test(t) ? t : '第 ' + no + ' 章 · ' + t;
}

export default function ChapterPicker({ chapters = [], value, onChange, className }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [jump, setJump] = useState('');
  const rootRef = useRef(null);
  const filterRef = useRef(null);
  const listRef = useRef(null);

  const total = chapters.length;
  const index = chapters.findIndex((c) => c.id === value);
  const current = index >= 0 ? chapters[index] : null;

  const go = (i) => {
    const ch = chapters[i];
    if (ch && ch.id !== value) onChange?.(ch.id);
  };

  // 过滤结果：保留原始位置（章号 = 位置 + 1）
  const matches = useMemo(() => {
    const q = query.trim();
    const all = chapters.map((c, i) => ({ c, no: i + 1 }));
    if (!q) return all;
    if (/^\d+$/.test(q)) {
      return all.filter(({ c, no }) => String(no).startsWith(q) || String(c.title || '').includes(q));
    }
    const lq = q.toLowerCase();
    return all.filter(({ c }) => String(c.title || '').toLowerCase().includes(lq));
  }, [chapters, query]);

  // 渲染窗口：有过滤词时只渲染前 MAX_RENDER 条；
  // 无过滤词且当前章在 MAX_RENDER 之后时，改为渲染包含当前章的一段，保证打开时能滚动到当前项。
  const { start, visible } = useMemo(() => {
    let s = 0;
    if (!query.trim() && index >= MAX_RENDER) {
      s = Math.max(0, Math.min(index - Math.floor(MAX_RENDER / 2), matches.length - MAX_RENDER));
    }
    return { start: s, visible: matches.slice(s, s + MAX_RENDER) };
  }, [matches, query, index]);
  const hiddenBefore = start;
  const hiddenAfter = Math.max(0, matches.length - start - visible.length);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const pick = (id) => {
    if (id !== value) onChange?.(id);
    close();
  };

  // 点面板外 / Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开时聚焦过滤框，并滚动到当前项
  useEffect(() => {
    if (!open) return;
    filterRef.current?.focus();
    const el = listRef.current?.querySelector('[data-active="true"]');
    if (el) el.scrollIntoView({ block: 'center' });
  }, [open]);

  const doJump = () => {
    const raw = jump.trim();
    if (!raw) {
      toast.error('请输入章号');
      return;
    }
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) {
      toast.error('请输入数字章号');
      return;
    }
    // 1) 先按标题「第N章」匹配
    const byTitle = findChapterIndexByTitleNo(chapters, n);
    if (byTitle >= 0) {
      go(byTitle);
      setJump('');
      return;
    }
    // 2) 标题没匹配到，再按位置跳
    if (n <= total) {
      const ch = chapters[n - 1];
      go(n - 1);
      setJump('');
      toast.info('没有标题为“第' + n + '章”的章节，已按位置跳到第 ' + n + ' 个：' + (ch?.title || '第 ' + n + ' 章'));
      return;
    }
    // 3) 都不行
    toast.error('没有标题为“第' + n + '章”的章节；按位置也超出范围（共 ' + total + ' 个章节，位置 1–' + total + '）');
  };

  const atFirst = total === 0 || index <= 0;
  const atLast = total === 0 || index === total - 1;

  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5', className)}>
      <Button variant="secondary" size="xs" data-testid="chapter-first" disabled={atFirst} onClick={() => go(0)}>
        第一章
      </Button>
      <Button variant="secondary" size="xs" data-testid="chapter-prev" disabled={atFirst} onClick={() => go(index - 1)}>
        上一章
      </Button>

      <div ref={rootRef} className="relative min-w-0">
        <button
          type="button"
          data-testid="chapter-trigger"
          disabled={!total}
          onClick={() => (open ? close() : setOpen(true))}
          className={clsx(
            'flex h-8 w-[260px] items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-white/[0.035] px-2.5 text-left text-[12px] text-[var(--fg)]',
            'transition-all duration-150 hover:border-[var(--line-strong)] focus:outline-none disabled:opacity-50',
            open && 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] shadow-[0_0_0_3px_rgba(232,177,92,.12)]',
          )}
        >
          <span className={clsx('truncate', !current && 'text-[var(--fg-4)]')}>
            {current ? chapterLabel(index + 1, current.title) : total ? '选择章节' : '暂无章节'}
          </span>
          <ChevronDown size={14} className="shrink-0 text-[var(--fg-3)]" />
        </button>

        {open ? (
          <div className="absolute left-0 top-[calc(100%+6px)] z-[260] w-[360px] overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--panel-2)] shadow-[0_24px_60px_-20px_rgba(0,0,0,.95)]">
            <div className="border-b border-[var(--line)] p-2">
              <Input
                ref={filterRef}
                autoFocus
                data-testid="chapter-filter"
                value={query}
                placeholder="输入章号或标题过滤"
                className="h-8 px-2.5 text-[12.5px]"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (matches.length) pick(matches[0].c.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
              />
            </div>
            <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1.5">
              {matches.length === 0 ? (
                <p className="m-0 px-3 py-6 text-center text-[12px] text-[var(--fg-3)]">没有匹配的章节</p>
              ) : (
                <>
                  {hiddenBefore > 0 ? (
                    <p className="m-0 px-3 py-1.5 text-center text-[11px] text-[var(--fg-4)]">前面还有 {hiddenBefore} 条，请继续输入缩小范围</p>
                  ) : null}
                  {visible.map(({ c, no }) => {
                    const active = c.id === value;
                    const shotCount = Number(c.shotCount) || 0;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-testid="chapter-option"
                        data-active={active ? 'true' : undefined}
                        onClick={() => pick(c.id)}
                        className={clsx(
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                          active
                            ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--fg)]'
                            : 'text-[var(--fg-2)] hover:bg-white/[0.07] hover:text-[var(--fg)]',
                        )}
                      >
                        <span className={clsx('w-10 shrink-0 font-mono text-[11px]', active ? 'text-[var(--accent)]' : 'text-[var(--fg-4)]')}>{no}</span>
                        <span className="min-w-0 flex-1 truncate">{c.title || '第 ' + no + ' 章'}</span>
                        {shotCount > 0 ? <span className="shrink-0 text-[10.5px] text-[var(--fg-3)]">{shotCount} 镜</span> : null}
                        {active ? <Check size={13} className="shrink-0 text-[var(--accent)]" /> : null}
                      </button>
                    );
                  })}
                  {hiddenAfter > 0 ? (
                    <p className="m-0 px-3 py-1.5 text-center text-[11px] text-[var(--fg-4)]">还有 {hiddenAfter} 条，请继续输入缩小范围</p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>

      <Button variant="secondary" size="xs" data-testid="chapter-next" disabled={atLast} onClick={() => go(index < 0 ? 0 : index + 1)}>
        下一章
      </Button>
      <Button variant="secondary" size="xs" data-testid="chapter-last" disabled={atLast} onClick={() => go(total - 1)}>
        最后一章
      </Button>

      <div className="flex shrink-0 items-center gap-1.5">
        <div className="w-[72px] shrink-0">
          <Input
            data-testid="chapter-jump-input"
            value={jump}
            inputMode="numeric"
            placeholder="章号"
            disabled={!total}
            className="h-7 px-2 text-[12px]"
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                doJump();
              }
            }}
          />
        </div>
        <Button
          variant="secondary"
          size="xs"
          data-testid="chapter-jump-btn"
          disabled={!total}
          title="先按标题第N章匹配，找不到再按位置"
          onClick={doJump}
        >
          跳转
        </Button>
      </div>
    </div>
  );
}
