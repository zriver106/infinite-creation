// 「自动生成下一章」（视频队列）与「自动生成下一章分镜」（分镜队列）的决策（纯函数，零副作用，单测直接 import）。
// 副作用（读库、提交任务）在 lib/agent/auto-chain.js。
//
// 双队列（2026-11-16 总导批准，见 草稿\…\12_界面五项\实现\总导批准_1810_双队列硬条件.md）：
//   - 视频队列 = 原 job 闸门（出片等碰 GPU 的任务）；分镜队列 = 文本闸门（只拆分镜的纯文本任务，容量 1）。
//   - 两个开关不互斥：都勾上时，分镜队列自己往前拆；视频队列出完一章，接下一个「分镜已完成」的章。
//   - 同一章不能同时在两个队列里（chapterBusy）；视频队列只接分镜已完成的章（两个都勾时）；
//     分镜队列不碰正在出片 / 已有分镜 / 已出片的章（只有用户手动「生成分镜」才会重拆）。
//   - 两条链各自受自己的「到第 __ 章为止」约束。
//   - 每条队列最多再提交一个任务，且只在**该队列**空闲时提交（不往别人的队尾塞，避开 120 分钟排队超时）。
//
// 退化：i.dual=false（总开关关、本机 LLM 等，分镜任务仍走 job 闸门）时两条链共用一条队列，
// 行为回到改动前——每次收尾最多提交一个任务、GPU 优先（分镜完成的章能接上视频链就先出片）。

import { chapterNumberFromTitle } from '../core/project-ui-settings.js';

const num = chapterNumberFromTitle;

/**
 * @param {object} i
 * @param {{kind:'video'|'storyboard', status:string, chapter:string, ok:boolean, okReason?:string}} i.finished
 * @param {{video:{enabled:boolean,until:number}, storyboard:{enabled:boolean,until:number}}} i.settings
 * @param {string[]} i.chapters            本项目章节标题，按 seq 升序
 * @param {(t:string)=>number} i.shotCountOf
 * @param {(t:string)=>boolean} i.exportedOf      该章是否已有主成片
 * @param {(t:string)=>boolean} i.lastVideoJobDone 该章最近一次已结束的出片任务是否 done
 * @param {(t:string)=>boolean} i.chapterBusy     该章是否有 running/queued 任务（任一队列）
 * @param {(t:string)=>boolean} [i.storyboardReady] 该章分镜是否已完成（有分镜、不忙、最近一次只拆分镜任务没失败）
 * @param {boolean} [i.dual]                是否真的双队列（分镜任务走文本闸门）
 * @param {boolean} [i.videoQueueBusy]      视频队列（任意项目）是否有 running/queued 任务（不含刚结束的这条）
 * @param {boolean} [i.textQueueBusy]       分镜队列（任意项目）是否有 running/queued 任务（不含刚结束的这条）
 * @param {boolean} [i.projectBusy]         旧字段（单队列口径）：本项目还有活动任务
 * @param {boolean} [i.otherProjectsBusy]   旧字段（单队列口径）：其它项目有活动任务
 * @returns {{ submits: Array<{kind:'video'|'storyboard', chapter:string, note:string}>, stops: Array<{chain:string, reason:string}>, none?: string }}
 */
export function planAutoChain(raw) {
  const i = normalize(raw);
  const s = i.settings;
  const f = i.finished;
  const out = { submits: [], stops: [] };
  const stop = (chain, reason) => { out.stops.push({ chain, reason }); return out; };

  if (!s.video.enabled && !s.storyboard.enabled) return { ...out, none: '两个自动开关都没勾' };
  if (f.kind === 'video' && !s.video.enabled) return { ...out, none: '出片任务结束，但没勾「自动生成下一章」' };
  const chain = f.kind === 'video' || !s.storyboard.enabled ? '自动生成下一章' : '自动生成下一章分镜';
  if (f.status !== 'done') return stop(chain, '「' + f.chapter + '」任务没有成功完成（' + (f.status || '未知') + '），不续');
  if (!f.ok) return stop(chain, '「' + f.chapter + '」' + (f.okReason || '没有达到成功条件') + '，不续');
  const idx = i.chapters.indexOf(f.chapter);
  if (idx < 0) return stop(chain, '「' + f.chapter + '」已不在章节列表里');

  if (f.kind === 'video') {
    planVideoNext(i, idx, out);
    return out;
  }

  // 分镜任务成功：① 视频队列能不能接本章；② 分镜队列继续往后拆。双队列下两件事都做（各自一个队列）。
  let handed = false;
  if (s.video.enabled) handed = videoHandoff(i, idx, out);
  if (!s.storyboard.enabled) {
    if (!handed && !out.stops.length) out.none = '分镜任务结束，没勾「自动生成下一章分镜」，视频队列也不接本章';
    return out;
  }
  if (handed && !i.dual) {
    out.stops.push({ chain: '自动生成下一章分镜', reason: '执行层仍是单队列（分镜任务没有走文本闸门），本次先让视频队列接上，分镜等它之后再拆' });
    return out;
  }
  planStoryboardNext(i, idx, out);
  return out;
}

/** 旧接口（单个动作），保留给旧调用方 / 旧单测：先返回提交，其次返回停，最后 none。 */
export function planAutoNext(raw) {
  const p = planAutoChain(raw);
  if (p.submits.length) return { action: 'submit', ...p.submits[0] };
  if (p.stops.length) return { action: 'stop', ...p.stops[0] };
  return { action: 'none', reason: p.none || '' };
}

function normalize(raw) {
  const i = { ...raw };
  const legacyBusy = !!(raw.projectBusy || raw.otherProjectsBusy);
  i.dual = !!raw.dual;
  i.videoQueueBusy = raw.videoQueueBusy == null ? legacyBusy : !!raw.videoQueueBusy;
  i.textQueueBusy = raw.textQueueBusy == null ? legacyBusy : !!raw.textQueueBusy;
  if (!i.dual) {
    // 单队列：两条链排同一条队，任一忙都算忙
    const any = i.videoQueueBusy || i.textQueueBusy;
    i.videoQueueBusy = any;
    i.textQueueBusy = any;
  }
  i.legacyProjectBusy = !!raw.projectBusy;
  i.storyboardReady = typeof raw.storyboardReady === 'function'
    ? raw.storyboardReady
    : (t) => raw.shotCountOf(t) > 0 && !raw.chapterBusy(t);
  return i;
}

function busyText(i, queue) {
  if (!i.dual) {
    return i.legacyProjectBusy
      ? '本项目还有别的任务在跑或排队，不往队尾追加'
      : '有任务在跑或排队（分镜和出片共用一个执行槽），不往队尾追加';
  }
  return queue === 'video'
    ? '视频队列有任务在跑或排队（可能是其它项目），不往队尾追加'
    : '分镜队列有任务在跑或排队（可能是其它项目），不往队尾追加';
}

// 出片成功 → 视频队列接下一章
function planVideoNext(i, idx, out) {
  const chain = '自动生成下一章';
  const s = i.settings;
  const until = s.video.until;
  const cur = i.chapters[idx];
  const n = num(cur);
  const stop = (reason) => { out.stops.push({ chain, reason }); };
  if (n == null) return stop('「' + cur + '」不是「第N章」格式，解析不到章号，已停');
  if (n >= until) return stop('已到「到第 ' + until + ' 章为止」，已停');
  const next = i.chapters[idx + 1];
  if (next == null) return stop('没有下一章，已停');
  const nn = num(next);
  if (nn == null) return stop('下一章「' + next + '」不是「第N章」格式，已停');
  if (nn > until) return stop('下一章是第 ' + nn + ' 章，超过「到第 ' + until + ' 章为止」，已停');
  if (i.exportedOf(next)) return stop('下一章「' + next + '」已经出过片，不自动重跑，已停');
  if (i.chapterBusy(next)) {
    return stop('下一章「' + next + '」已有任务在跑或排队' + (s.storyboard.enabled ? '（若是分镜任务，它成功后会把这一章交给视频队列）' : '') + '，本次不提交');
  }
  // 两个都勾：视频队列只接分镜已完成的章（下一章在分镜链的上限内时）
  if (s.storyboard.enabled && nn <= s.storyboard.until && !i.storyboardReady(next)) {
    if (i.shotCountOf(next) > 0) {
      return stop('下一章「' + next + '」最近一次拆分镜没有成功（分镜不完整），需要手动处理，本次不提交');
    }
    // 下一章还没有分镜：分镜队列空闲就把它交给分镜队列（分镜成功后由分镜任务交回视频队列），避免两条链互相等；
    // 分镜队列忙就等它自己拆到这一章。
    if (!i.textQueueBusy) {
      out.submits.push({ kind: 'storyboard', chapter: next, note: '视频队列：下一章「' + next + '」还没有分镜，先交给分镜队列拆分镜（拆完由分镜任务交回视频队列）' });
      return;
    }
    return stop('下一章「' + next + '」还没有分镜，' + busyText(i, 'text') + '；等分镜队列拆完后由分镜任务交给视频队列');
  }
  // 下一章超出分镜链的上限：分镜队列不会去拆它，视频队列照旧走单章 /run（整章正常生成流程，含拆分镜）
  if (i.videoQueueBusy) return stop(busyText(i, 'video'));
  out.submits.push({ kind: 'video', chapter: next, note: '视频队列：续下一章「' + next + '」（单章 /run，正常生成流程）' });
}

// 分镜任务成功后，视频队列是否接本章：视频链正停在前一章（前一章最近一次出片成功、有成片），本章没出过片。
function videoHandoff(i, idx, out) {
  const s = i.settings;
  if (idx < 1) return false;
  const cur = i.chapters[idx];
  const prev = i.chapters[idx - 1];
  const pn = num(prev);
  const cn = num(cur);
  if (pn == null || cn == null) return false;
  if (pn >= s.video.until || cn > s.video.until) return false;
  if (!i.exportedOf(prev) || !i.lastVideoJobDone(prev)) return false;
  if (i.exportedOf(cur)) return false;
  if (i.chapterBusy(cur)) return false;
  if (i.videoQueueBusy) {
    out.stops.push({ chain: '自动生成下一章', reason: busyText(i, 'video') + '；「' + cur + '」分镜已完成，等视频队列空了需手动点「生成」或等当前出片任务收尾接上' });
    return false;
  }
  out.submits.push({ kind: 'video', chapter: cur, note: '视频队列：前一章「' + prev + '」已出片，接上分镜已完成的「' + cur + '」' });
  return true;
}

// 分镜队列往后拆：跳过已有分镜 / 已出片 / 正有任务（正在出片）的章，绝不重拆
function planStoryboardNext(i, idx, out) {
  const chain = '自动生成下一章分镜';
  const until = i.settings.storyboard.until;
  const cur = i.chapters[idx];
  const n = num(cur);
  const stop = (reason) => { out.stops.push({ chain, reason }); };
  if (n == null) return stop('「' + cur + '」不是「第N章」格式，解析不到章号，已停');
  if (n >= until) return stop('已到「到第 ' + until + ' 章为止」，已停');
  // 本次已把某章交给分镜队列（不会发生在这里，但防御：每条队列最多一个提交）
  if (out.submits.some((x) => x.kind === 'storyboard')) return;
  const skipped = [];
  const skippedText = () => (skipped.length ? '（跳过：' + skipped.join('、') + '）' : '');
  for (let k = idx + 1; k < i.chapters.length; k++) {
    const c = i.chapters[k];
    const cn = num(c);
    if (cn == null) return stop('下一章「' + c + '」不是「第N章」格式，已停' + skippedText());
    if (cn > until) return stop('下一章是第 ' + cn + ' 章，超过「到第 ' + until + ' 章为止」，已停' + skippedText());
    if (i.chapterBusy(c)) { skipped.push(c + ' 有任务'); continue; }
    if (i.shotCountOf(c) > 0) { skipped.push(c + ' 已有分镜'); continue; }
    if (i.exportedOf(c)) { skipped.push(c + ' 已出片'); continue; }
    if (i.textQueueBusy) return stop(busyText(i, 'text'));
    out.submits.push({ kind: 'storyboard', chapter: c, note: '分镜队列：只拆「' + c + '」的分镜' + skippedText() });
    return;
  }
  return stop((skipped.length ? '后面的章都不需要拆' : '没有下一章') + '，已停' + skippedText());
}
