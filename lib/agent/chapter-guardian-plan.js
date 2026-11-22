// 续章守护的决策（纯函数，零副作用，单测直接 import）。副作用（读库、提交、日志、定时）在 lib/agent/chapter-guardian.js。
//
// 2026-11-17 Andy 8:27 / 8:28 定：两个守护各管各的，每 60 秒查一次，不停。
//   出片守护（勾「自动生成下一章」时）：本项目没有任何 running/queued 任务；上一章（= 最后一个已出主成片的章）
//     最近一次出片任务成功；下一章不超过 until；下一章还没出片 → 单章 /run（startSingleChapterRun，自带同章去重）。
//   分镜守护（勾「自动生成下一章分镜」时）：本项目没有 running/queued 的分镜类任务（只拆分镜 create / prompt-write / stage）；
//     上一章（= 最后一个有分镜的章）分镜成功完成、且上一章没有任务在跑；下一章不超过分镜 until；下一章还没有分镜
//     → 只拆分镜入口（submitStoryboardJob auto=true）。走文本队列，不等 GPU / 视频队列。
// 共同的防重复：每次最多提交一章；同章同类最多一个任务；上一章失败 / 取消不续；
// 下一章最近一次同类任务失败 / 取消 / 结果不明（interrupted 等）一律不重复提交，只记跳过原因。
import { chapterNumberFromTitle } from '../core/project-ui-settings.js';

const num = chapterNumberFromTitle;

export const GUARDIAN_INTERVAL_MS = 60 * 1000;
export const PROMPT_WRITE_TYPE = 'prompt-write';

/**
 * 总开关：config.generation.chapterGuardian === false，或进程环境 IC_DISABLE_CHAPTER_GUARDIAN=1 时守护不跑，
 * 任务收尾钩子（auto-chain.js）回到旧的「收尾即续」规则——两个开关口径一致，不会出现「收尾交给守护、守护又没开」两头落空。缺省开。
 */
export function guardianEnabled(cfg, env = (typeof process !== 'undefined' && process.env) || {}) {
  if (env && env.IC_DISABLE_CHAPTER_GUARDIAN === '1') return false;
  return !(cfg && cfg.generation && cfg.generation.chapterGuardian === false);
}

// ic25：adopted = 后端重启时外部 Agent 进程还活着、重启恢复正在等它退出的任务。算「活动」（项目忙），不是「结果不明」。
export const ADOPTED_STATUS = 'adopted';
export function statusClass(s) {
  if (s === 'running' || s === 'queued' || s === ADOPTED_STATUS) return 'active';
  if (s === 'done') return 'ok';
  if (s === 'failed' || s === 'cancelled' || s === 'error') return 'failed';
  return 'unknown'; // interrupted 及其它：结果不明
}
const isActive = (j) => statusClass(j && j.status) === 'active';
const chapterOf = (j) => String((j && j.checkpoint && j.checkpoint.chapter) || '');
const sbOnly = (j) => !!(j && j.checkpoint && j.checkpoint.storyboardOnly);

export function isVideoJob(j) { return !!j && j.type === 'create' && !sbOnly(j); }
export function isStoryboardOnlyJob(j) { return !!j && j.type === 'create' && sbOnly(j); }
/** 分镜守护判忙用：只拆分镜、提示词撰写 / 补写（prompt-write）、阶段任务（stage，含提示词补写） */
export function isStoryboardLaneJob(j) { return isStoryboardOnlyJob(j) || (!!j && (j.type === PROMPT_WRITE_TYPE || j.type === 'stage')); }

export function shortJob(j) {
  if (!j) return '';
  const id = String(j.id || '').slice(0, 8);
  const kind = j.type === 'create' ? (sbOnly(j) ? '只拆分镜' : '出片') : j.type;
  return id + '（' + kind + (chapterOf(j) ? ' ' + chapterOf(j) : '') + ' ' + j.status + '）';
}

// jobs：本项目任务，按 started_at DESC（Jobs.list 的顺序）→ 第一个匹配即「最近一次」
function latestOf(jobs, pred, title) {
  return jobs.find((j) => pred(j) && chapterOf(j) === title) || null;
}
function busyText(list) {
  return shortJob(list[0]) + (list.length > 1 ? ' 等 ' + list.length + ' 个' : '');
}
const skip = (code, reason, extra) => ({ action: 'skip', code, reason, ...(extra || {}) });

// 只认「第N章」标题、按章号排：项目里夹着的验证章（如「第2章_Q门槛验证_20261116」「串音验证_3镜」）不参与找上一章 / 下一章。
// 「下一章」= 章号恰好 +1 的那一章；没有就跳过（不跳号）。
function numbered(chapters) {
  const seen = new Set();
  return chapters.map((t) => ({ t, n: num(t) })).filter((x) => x.n != null && !seen.has(x.n) && seen.add(x.n)).sort((a, b) => a.n - b.n);
}
function frontier(chapters, has) {
  const list = numbered(chapters);
  let base = null;
  for (let k = list.length - 1; k >= 0; k--) if (has(list[k].t)) { base = list[k]; break; }
  if (!base) return { base: null };
  return { base, next: list.find((x) => x.n === base.n + 1) || null };
}

/**
 * @param {object} i
 * @param {{video:{enabled:boolean,until:number}, storyboard:{enabled:boolean,until:number}}} i.settings
 * @param {string[]} i.chapters           章节标题，按 seq 升序
 * @param {object[]} i.jobs               本项目全部任务（started_at DESC）
 * @param {(t:string)=>boolean} i.exportedOf 该章是否已有主成片
 * @returns {{action:'off'|'skip'|'submit', code:string, reason:string, chapter?:string, prev?:string}}
 */
export function planVideoGuard(i) {
  const s = i.settings;
  if (!s.video.enabled) return { action: 'off', code: 'off', reason: '没勾「自动生成下一章」' };
  const active = i.jobs.filter(isActive);
  const adopted = active.filter((j) => j.status === ADOPTED_STATUS);
  if (adopted.length) return skip('recovery-waiting', '重启恢复正在等外部 Agent 退出：' + busyText(adopted) + '，项目算忙，等它判定完再续');
  if (active.length) return skip('project-busy', '本项目有任务在跑或排队：' + busyText(active) + '，等它结束再续');
  // ic25 运行时开关（DATA_DIR/control/restart-recovery.json chain=false）：暂停出片续章，不用重启
  if (i.chainHold) return skip('recovery-hold', i.chainHold);
  const f = frontier(i.chapters, i.exportedOf);
  if (!f.base) return skip('no-base', '本项目还没有已出片的「第N章」，守护不从头开，请先手动生成第一章');
  const prev = f.base.t;
  if (f.base.n >= s.video.until) return skip('until', '上一章「' + prev + '」已到「到第 ' + s.video.until + ' 章为止」', { prev });
  if (!f.next) return skip('no-next', '「' + prev + '」后面没有第 ' + (f.base.n + 1) + ' 章', { prev });
  const next = f.next.t;
  const nn = f.next.n;
  if (nn > s.video.until) return skip('until', '下一章是第 ' + nn + ' 章，超过「到第 ' + s.video.until + ' 章为止」', { prev, chapter: next });
  const pj = latestOf(i.jobs, isVideoJob, prev);
  if (pj && statusClass(pj.status) !== 'ok') {
    return skip('prev-not-ok', '上一章「' + prev + '」最近一次出片任务 ' + shortJob(pj) + ' 没有成功，不续', { prev, chapter: next });
  }
  const nj = latestOf(i.jobs, isVideoJob, next);
  if (nj) {
    const c = statusClass(nj.status);
    if (c === 'failed') return skip('next-failed', '下一章「' + next + '」最近一次出片任务 ' + shortJob(nj) + ' 失败 / 取消，不自动重试，需人工处理', { prev, chapter: next });
    if (c === 'unknown') return skip('next-unknown', '下一章「' + next + '」最近一次出片任务 ' + shortJob(nj) + ' 结果不明，不重复提交', { prev, chapter: next });
    if (c === 'ok') return skip('next-done-no-export', '下一章「' + next + '」最近一次出片任务 ' + shortJob(nj) + ' 已结束但没有主成片，状态存疑，不重复提交', { prev, chapter: next });
  }
  if (s.storyboard.enabled && nn <= s.storyboard.until) {
    const sj = latestOf(i.jobs, isStoryboardOnlyJob, next);
    if (sj && statusClass(sj.status) !== 'ok') {
      return skip('next-sb-not-ok', '下一章「' + next + '」最近一次只拆分镜任务 ' + shortJob(sj) + ' 没有成功，需人工处理，本次不出片', { prev, chapter: next });
    }
  }
  return { action: 'submit', code: 'submit', prev, chapter: next, reason: '上一章「' + prev + '」已出片，续「' + next + '」（单章 /run）' };
}

/**
 * @param {object} i 同上，另加：
 * @param {(t:string)=>number} i.shotCountOf
 * @param {(t:string)=>boolean} i.chapterBusy  该章是否有 running/queued 任务（任一类型）
 */
export function planStoryboardGuard(i) {
  const s = i.settings;
  if (!s.storyboard.enabled) return { action: 'off', code: 'off', reason: '没勾「自动生成下一章分镜」' };
  const active = i.jobs.filter((j) => isActive(j) && isStoryboardLaneJob(j));
  if (active.length) return skip('sb-busy', '本项目有分镜 / 提示词任务在跑或排队：' + busyText(active) + '，等它结束再续');
  const f = frontier(i.chapters, (t) => i.shotCountOf(t) > 0);
  if (!f.base) return skip('no-base', '本项目还没有任何「第N章」有分镜，守护不从头开，请先手动拆第一章');
  const prev = f.base.t;
  if (f.base.n >= s.storyboard.until) return skip('until', '上一章「' + prev + '」已到分镜「到第 ' + s.storyboard.until + ' 章为止」', { prev });
  if (!f.next) return skip('no-next', '「' + prev + '」后面没有第 ' + (f.base.n + 1) + ' 章', { prev });
  const next = f.next.t;
  const nn = f.next.n;
  if (nn > s.storyboard.until) return skip('until', '下一章是第 ' + nn + ' 章，超过分镜「到第 ' + s.storyboard.until + ' 章为止」', { prev, chapter: next });
  if (i.chapterBusy(prev)) return skip('prev-busy', '上一章「' + prev + '」还有任务在跑或排队（分镜可能还没写完），等它结束', { prev, chapter: next });
  const ps = latestOf(i.jobs, isStoryboardOnlyJob, prev);
  if (ps && statusClass(ps.status) !== 'ok') {
    return skip('prev-not-ok', '上一章「' + prev + '」最近一次只拆分镜任务 ' + shortJob(ps) + ' 没有成功，不续', { prev, chapter: next });
  }
  if (i.chapterBusy(next)) return skip('next-busy', '下一章「' + next + '」已有任务在跑或排队，不重复提交', { prev, chapter: next });
  if (i.exportedOf(next)) return skip('next-exported', '下一章「' + next + '」已出片，自动续分镜不重拆', { prev, chapter: next });
  const ns = latestOf(i.jobs, isStoryboardOnlyJob, next);
  if (ns) {
    const c = statusClass(ns.status);
    if (c === 'failed') return skip('next-failed', '下一章「' + next + '」最近一次只拆分镜任务 ' + shortJob(ns) + ' 失败 / 取消，不自动重试，需人工处理', { prev, chapter: next });
    if (c === 'unknown') return skip('next-unknown', '下一章「' + next + '」最近一次只拆分镜任务 ' + shortJob(ns) + ' 结果不明，不重复提交', { prev, chapter: next });
    if (c === 'ok') return skip('next-done-empty', '下一章「' + next + '」最近一次只拆分镜任务 ' + shortJob(ns) + ' 已结束但没有分镜，状态存疑，不重复提交', { prev, chapter: next });
  }
  return { action: 'submit', code: 'submit', prev, chapter: next, reason: '上一章「' + prev + '」分镜已完成，只拆「' + next + '」的分镜（文本队列）' };
}
