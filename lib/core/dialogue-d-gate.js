// T2 第3批 · 台词进 <d> 硬拦（草案 v3，2026-11-23，工作流；未上线）
// v2（总导 13:4x 审定）：拦法改为「这一镜跳过，其余照出」——见文末 prepareEachSkippingDialogueGate。
// TR-V15 / TR-E05：dialogue 里每一句对白、心声、电话声，都必须写进该镜 video_prompt 的 <d></d>（系统声、旁白按现行手册后期配，不查）。
// 口径与 M\工具\h3_prompt_lint.py（md5 0842355D…）r81 DIALOGUE_NOT_IN_D / r82 DIALOGUE_SPLIT_ACROSS_D 逐条对齐：
//   - 切行：按换行切「说话人：原文」；冒号前 1–40 字是说话人；去掉整段包裹引号。
//   - 切句：行内按句末标点（。！？!?）切短句；每个短句规范化后必须是「全部 <d> 正文拼接」的子串（r81）。
//   - 规范化：引号 “”‘’『』→「」、... → …、半角 , ! ? : ; → 全角、非数字间的 . → 。、去全部空白；不改汉字和数字。
// E05（每句一对 <d>）只补 r81 管不到的两种：一条 <d> 装了不同说话人的两句以上（ERROR）；
// 对不上任何一句的 <d>、同一说话人两句并进一条 <d>（WARN）。「整句一个 <d> 都没有」只由 r81 报，不重复。
// 显式例外：说话人括注里写「不出声」（例：江澈（OS·不出声）：……），该行不查；例外须由总导登记。
// v3（总导 11-23 第4条）曾定「不出声」不豁免系统声、旁白；合并版 v2 撤销（见下条）。
// 合并版 v2（Andy 11-23 16:04「上线，系统声音还是按照原来设计去作业」）：系统声、旁白按现行手册后期配，不要求进 <d>；
//   说话人是系统/旁白的行（isPostVoiceSpeaker）r81、E05、r82 都不查；v3「不出声不豁免系统声、旁白」随之撤销，「不出声」对所有说话人一样豁免。
// 只看文本，不读库、不发请求；纯函数，便于前后端和测试共用。

const D_RE = /<d>\s*(?:\[([^\]]*)\]\s*)?([\s\S]*?)\s*<\/d>/gi;
const LINE_RE = /^([^：:]{1,40})[：:](.*)$/;
const SENT_RE = /[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g;
const FW = { ',': '，', '!': '！', '?': '？', ':': '：', ';': '；' };
export const DIALOGUE_GATE_EXEMPT_MARK = '不出声';
export function dialogueExemptAllowed(speaker) { return true; }   // 合并版 v2：v3「不出声不豁免系统声、旁白」撤销；保留导出名，调用方不用改
const POST_VOICE_RE = /^(?:系统(?:音|声|提示音?|女声|男声|的声音)?|旁白|system(?:\s+voice)?|narration|narrator)$/i;
/** 合并版 v2（Andy 11-23 16:04「系统声音还是按照原来设计去作业」）：系统声、旁白按现行手册后期配，不要求进 <d>。
 *  认定：说话人去掉所有括注（…）(…) 和【】后，等于 系统 / 系统音 / 系统声 / 系统提示 / 系统提示音 / 系统女声 / 系统男声 / 系统的声音 / 旁白 /
 *  system / system voice / narration / narrator（不分大小写）。例：「系统：」「【系统】：」「系统（系统）：」「旁白（画外）：」「Narration:」算；
 *  「系统面板：」「江澈（系统）：」「江澈（OS）：」不算，照查。没有「说话人：」的行照查。 */
export function isPostVoiceSpeaker(speaker) {
  return POST_VOICE_RE.test(String(speaker || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[【】\[\]]/g, '').trim());
}

function quoteUnify(s) {
  return String(s || '').replace(/\u201c/g, '\u300c').replace(/\u201d/g, '\u300d').replace(/\u2018/g, '\u300c')
    .replace(/\u2019/g, '\u300d').replace(/\u300e/g, '\u300c').replace(/\u300f/g, '\u300d');
}
function unwrapQuotes(s) {
  const t = quoteUnify(s).trim();
  if (t.length >= 2 && t[0] === '\u300c' && t[t.length - 1] === '\u300d') return t.slice(1, -1).trim();
  return t;
}
// Python str.strip() / \s 与 JS \s 在常见中文文本上一致（含全角空格 U+3000）
export function normDialogueText(s) {
  let t = unwrapQuotes(s || '');
  t = t.split('...').join('\u2026');
  t = t.replace(/[,!?:;]/g, (c) => FW[c]);
  t = t.replace(/(?<!\d)\.(?!\d)/g, '\u3002');
  return t.replace(/\s+/g, '');
}
export function dBodies(prompt) {
  return [...String(prompt || '').matchAll(D_RE)].map((m) => String(m[2] || '').trim());
}
export function dialogueLines(dialogue) {
  const out = [];
  for (const raw of String(dialogue || '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    const speaker = m ? m[1].trim() : '';
    const text = unwrapQuotes(m ? String(m[2] || '').trim() : line);
    if (text) {
      const marked = speaker.includes(DIALOGUE_GATE_EXEMPT_MARK); const allowed = dialogueExemptAllowed(speaker);
      const post = isPostVoiceSpeaker(speaker);
      out.push({ speaker, text, exempt: marked && allowed, mark_ignored: marked && !allowed && !post, post });
    }
  }
  return out;
}
function sentences(text) {
  const parts = (text.match(SENT_RE) || []).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}
function short(s, n = 40) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n) + '…'; }
function speakerKey(sp) { return String(sp || '').replace(/[（(][^）)]*[）)]/g, '').trim(); }

/**
 * @returns {{ errors: {code:string,msg:string}[], warnings: {code:string,msg:string}[], missing: string[], lines: number, pairs: number }}
 */
export function checkDialogueInD(dialogue, prompt) {
  const errors = []; const warnings = [];
  const text = String(prompt || '');
  if (!text.trim()) return { errors, warnings, missing: [], lines: 0, pairs: 0 };   // 还没写提示词：不归本门管
  const all = dialogueLines(dialogue);
  const lines = all.filter((l) => !l.exempt && !l.post);   // 合并版 v2：系统声、旁白行不查（后期配）
  const bodies = dBodies(text);
  const norms = bodies.map(normDialogueText);
  const joined = normDialogueText(bodies.join(''));
  // ① r81：逐短句必须在 <d> 拼接文本里
  const missing = [];
  for (const l of lines) for (const s of sentences(l.text)) {
    const n = normDialogueText(s);
    if (n && !joined.includes(n)) missing.push((l.speaker ? l.speaker + '：' : '') + s);
  }
  if (missing.length) errors.push({ code: 'DIALOGUE_NOT_IN_D', msg: 'dialogue 有 ' + missing.length + ' 句没写进 <d>（对白、心声、电话声都要写，H3 直出；系统声、旁白按现行口径后期配，不查）：' + missing.map((x) => '「' + short(x) + '」').join('；') });
  // ② E05：每个 <d> 归到哪一句
  const ln = lines.map((l) => normDialogueText(l.text));
  const allNorm = all.map((l) => normDialogueText(l.text));
  const used = new Set(); let pairs = 0; const seenPart = new Set();
  const orphan = []; const mergeCross = []; const mergeSame = [];
  norms.forEach((b, k) => {
    if (!b) { pairs++; orphan.push('（空 <d>）'); return; }
    const hit = ln.map((t, i) => (t.includes(b) ? i : -1)).filter((i) => i >= 0);
    if (hit.length) { const i = hit.find((x) => !used.has(x)) ?? hit[0]; used.add(i); if (!seenPart.has(i)) { seenPart.add(i); pairs++; } return; }
    const cont = ln.map((t, i) => (t && b.includes(t) ? i : -1)).filter((i) => i >= 0);
    if (cont.length >= 2) {
      pairs++;
      const sp = new Set(cont.map((i) => speakerKey(lines[i].speaker)));
      (sp.size > 1 ? mergeCross : mergeSame).push(cont.map((i) => i + 1).join('、'));
      return;
    }
    if (allNorm.some((t) => t && (t.includes(b) || b.includes(t)))) return;   // 属于「不出声」例外行，不计
    pairs++; orphan.push(short(bodies[k], 24));
  });
  if (mergeCross.length) errors.push({ code: 'DIALOGUE_D_COUNT', msg: '一条 <d> 里装了不同说话人的几句（第 ' + mergeCross.join('；') + ' 句），每句要单独一对 <d>，否则声线会串' });
  if (mergeSame.length) warnings.push({ code: 'DIALOGUE_D_COUNT', msg: '同一说话人的几句并进了一条 <d>（第 ' + mergeSame.join('；') + ' 句），只提醒' });
  if (orphan.length) warnings.push({ code: 'DIALOGUE_D_COUNT', msg: (lines.length ? '' : 'dialogue 为空，') + '有 ' + orphan.length + ' 对 <d> 对不上 dialogue 的任何一句：' + orphan.map((x) => '「' + x + '」').join('；') + '（出片照 <d> 发声；请补回 dialogue）' });
  // ③ r82：整行在拼接里、却不在任何单条 <d> 里（被拆开）——只提醒
  for (const l of lines) {
    const n = normDialogueText(l.text);
    if (n && joined.includes(n) && !norms.some((x) => x.includes(n))) warnings.push({ code: 'DIALOGUE_SPLIT_ACROSS_D', msg: '「' + short(l.text) + '」被拆进多条 <d>，只提醒' });
  }
  return { errors, warnings, missing, lines: lines.length, pairs };
}

/** 写入/渲染前的统一入口：有 ERROR 就抛错（硬拦），WARN 交给调用方上报。 */
const RETIRED = new Set(['obsolete', 'retire', 'retired']);
export function assertDialogueInD(shotLike, prompt, where = '') {
  if (RETIRED.has(String((shotLike && shotLike.status) || '').trim().toLowerCase())) return { errors: [], warnings: [], missing: [], lines: 0, pairs: 0 };
  const r = checkDialogueInD(shotLike && shotLike.dialogue, prompt);
  if (r.errors.length) {
    const head = (where ? where + '被拒' : '被拒') + '（第' + (shotLike && shotLike.idx != null ? shotLike.idx : '?') + '镜，TR-V15/TR-E05 台词硬拦）：';
    const e = new Error(head + r.errors.map((x) => x.code + ' ' + x.msg).join('；'));
    e.code = 'DIALOGUE_GATE'; e.gate = r;
    throw e;
  }
  return r;
}

export const DIALOGUE_GATE_VERSION = 'T2-b35-merge-v2-20261123';
export function isDialogueGateError(e) { return !!(e && e.code === 'DIALOGUE_GATE' && e.gate); }

/**
 * 整批出片用：逐镜 prepare，被台词门拦下的镜**跳过**（记进跳过清单、带原因），其余照常返回；
 * 不是台词门的错误照旧往外抛（原有的说话人对不上、子镜头时间轴错等仍按原样整批停，本草案不改）。
 * @param {Array<{id:string, idx?:number}>} shots
 * @param {(shot) => Promise<any>} prepareFn  每镜的 prepare（IC 里就是 prepareShotForRender）
 * @param {{ shouldStop?: () => boolean, onSkip?: (entry) => void }} [opts]
 * @returns {Promise<{ prepared: any[], skipped: {shot_id:string, idx:any, codes:string[], missing:string[], reason:string}[] }>}
 */
export async function prepareEachSkippingDialogueGate(shots, prepareFn, opts = {}) {
  const prepared = []; const skipped = [];
  for (const s of shots || []) {
    if (opts.shouldStop && opts.shouldStop()) break;
    try {
      prepared.push(await prepareFn(s));
    } catch (e) {
      if (!isDialogueGateError(e)) throw e;
      const entry = { shot_id: s.id, idx: s.idx, codes: e.gate.errors.map((x) => x.code), missing: e.gate.missing.slice(), reason: e.message };
      skipped.push(entry);
      if (opts.onSkip) opts.onSkip(entry);
    }
  }
  return { prepared, skipped };
}

/** v3：不加数据库列；保留旧 error，只替换本门带标签的单行。实际重渲染仍由原逻辑 error:'' 清空。 */
export function appendDialogueGateError(oldError, reason) {
  const rest = String(oldError || '').split(/\r?\n/).filter((line) => !line.startsWith('［台词门］')).join('\n');
  const tagged = '［台词门］' + String(reason || '').replace(/[\r\n]+/g, ' ');
  return rest ? rest + '\n' + tagged : tagged;
}

/**
 * 合成闸（v4 总导 14:45 第1条建立；v5 按总导 15:00 改级别；v6 按总导 15:12 区分按章 / 整片；合并版 v1 按工作流 11-23 15:33 自定去掉「待确认」；合并版 v2 按 Andy 11-23 16:04：② 不查系统声、旁白）。凡是能把分镜拼成成片的入口都调它，
 * 而且在任何副作用（字幕识别、ffmpeg 合并、交付复制 EP<N>.mp4）之前调。入口清单见 逐条对照_v6 第一部分：
 *   tools.js hAssembleVideo（Agent 的 assemble_video 工具、阶段任务 stages.video、换配乐重合成 hApplyChapterMusic 都经过它）、
 *   app/api/projects/[id]/export/route.js（手动「导出」，平行实现）。
 * 为什么设：总导 11-23 15:12 裁定转述「之前有残片被拼进去交付了」。所以任何入口都不许把没出完的章拼成残片。
 * 作废 / 退役镜（obsolete / retire / retired）一律不算。
 *   ① ERROR 拦（按章、整片都拦）：合成范围内任何一镜的 error 里有「［台词门］」行 —— 上次出片被台词门跳过。
 *   ③ 没出完片的镜（status 不是 done，或没有 video_path）：
 *      - 按章合成（传了 chapter）：ERROR 拦，这一章不合成；
 *      - 整片合并（不传 chapter）：只 WARN，不拦；没出完的章**整章跳过、不拼残片**（工作流 11-23 15:33 按既定口径自定，依据总导 15:12 设闸理由：之前有残片被拼进去交付了），
 *        其余出完的章照常拼；跳过的章列进 pendingChapters（章号 + 没出完的镜数 / 镜号 / 状态）。
 *   ② 只 WARN：真正要拼进去的已完成镜，它出片用的提示词（video_prompt_used；为空时退回 video_prompt）过不了台词门。
 * 有 ① 或（按章时）③ 时抛 code=ASSEMBLE_GATE，e.blocked 为镜清单（why = skipped_dialogue_gate / not_rendered）；
 * 通过时返回 { assemble, warnings, pendingChapters }：assemble 是真正要拼的镜（整片时已去掉跳过的章），调用方必须改用它。
 */
export const DIALOGUE_GATE_TAG = '［台词门］';
export const ASSEMBLE_GATE_CODE = 'ASSEMBLE_GATE';
export const WHOLE_FILM_PENDING_POLICY = '跳过整章、不拼残片';
export function hasDialogueGateMark(error) {
  return String(error || '').split(/\r?\n/).some((line) => line.startsWith(DIALOGUE_GATE_TAG));
}
const isRetired = (s) => RETIRED.has(String((s && s.status) || '').trim().toLowerCase());
const isRendered = (s) => String(s.status || '').trim().toLowerCase() === 'done' && !!String(s.video_path || '').trim();
export function assembleGateCheck(scopeShots, toAssemble, opts = {}) {
  const whole = !!(opts && opts.whole);
  const blocked = []; const warnings = []; const seen = new Set(); const pend = new Map();
  for (const s of scopeShots || []) {
    if (!s || isRetired(s)) continue;
    if (hasDialogueGateMark(s.error)) { blocked.push({ shot_id: s.id, idx: s.idx, chapter: s.chapter, status: s.status, why: 'skipped_dialogue_gate' }); seen.add(s.id); continue; }
    if (isRendered(s)) continue;
    seen.add(s.id);
    if (!whole) { blocked.push({ shot_id: s.id, idx: s.idx, chapter: s.chapter, status: s.status || '', why: 'not_rendered' }); continue; }
    const k = s.chapter || '?';
    if (!pend.has(k)) pend.set(k, []);
    pend.get(k).push({ shot_id: s.id, idx: s.idx, status: s.status || '' });
  }
  const pendingChapters = [...pend].map(([chapter, shots]) => ({ chapter, count: shots.length, shots }));
  const assemble = (toAssemble || []).filter((s) => s && !(whole && pend.has(s.chapter || '?')));
  for (const s of assemble) {
    if (seen.has(s.id) || isRetired(s)) continue;
    const used = String(s.video_prompt_used || '').trim() ? s.video_prompt_used : (s.video_prompt || '');
    const r = checkDialogueInD(s.dialogue, used);
    if (r.errors.length) warnings.push({ shot_id: s.id, idx: s.idx, chapter: s.chapter, codes: r.errors.map((x) => x.code), missing: r.missing.slice(0, 20).map((m) => String(m).slice(0, 80)) });
  }
  return { blocked, warnings, pendingChapters, assemble };
}
const WHY = { skipped_dialogue_gate: '上次出片被台词门跳过', not_rendered: '还没出完片' };
export function assertAssembleGate(scopeShots, toAssemble, where = '合成', opts = {}) {
  const { blocked, warnings, pendingChapters, assemble } = assembleGateCheck(scopeShots, toAssemble, opts);
  if (!blocked.length) return { assemble, warnings, pendingChapters };
  const byCh = new Map();
  for (const b of blocked) { const k = b.chapter || '?'; if (!byCh.has(k)) byCh.set(k, []); byCh.get(k).push(b); }
  const parts = [...byCh].map(([ch, list]) => '章节「' + ch + '」' + list.map((b) => '第' + (b.idx == null ? '?' : b.idx) + '镜（' + WHY[b.why] + (b.why === 'not_rendered' ? '，状态 ' + (b.status || '空') : '') + '）').join('、'));
  const e = new Error(where + '被拒（合成闸）：' + parts.join('；') + '。本次不合成、不导出、不交付；被台词门跳过的镜补齐 <d> 重新出片，没出完的镜出完片后再合成。');
  e.code = ASSEMBLE_GATE_CODE; e.blocked = blocked; e.warnings = warnings;
  throw e;
}
export function pendingChaptersText(pendingChapters) {
  return '整片合并跳过 ' + pendingChapters.length + ' 章没出完的章（只提醒；处理办法：' + WHOLE_FILM_PENDING_POLICY + '）：'
    + pendingChapters.map((p) => (p.chapter || '?') + '（' + p.count + ' 镜：' + p.shots.map((b) => '第' + (b.idx == null ? '?' : b.idx) + '镜 ' + (b.status || '空')).join('、') + '）').join('；');
}
/**
 * 提醒报告（v5 建立，v6 改名并加整片跳过的章）：合成成功后，有 ② 或整片跳过的章时，在成片旁边写一份同名 JSON：
 *   exports/<成片名>.合成闸提醒.json（和 .srt 一样不进成片列表），同时写进合成结果 JSON 的 dialogue_gate_warnings /
 *   pending_chapters 字段和任务进度（phase「台词门提醒」「待补镜」）。都没有时不写文件。内容固定、不带时间戳，便于比对。
 */
export function assembleGateReport({ chapter, exportPath, warnings, pendingChapters }) {
  const pc = pendingChapters || [];
  return {
    gate_version: DIALOGUE_GATE_VERSION,
    kind: '合成闸提醒（只提醒，不拦）：②已完成镜出片提示词缺台词；整片合并跳过的没出完的章',
    chapter: chapter || null,
    export_path: exportPath,
    count: (warnings || []).length,
    shots: (warnings || []).map((w) => ({ chapter: w.chapter, idx: w.idx, shot_id: w.shot_id, codes: w.codes, missing: w.missing })),
    pending_chapters: pc.map((p) => ({ chapter: p.chapter, count: p.count, shots: p.shots.map((b) => ({ idx: b.idx, shot_id: b.shot_id, status: b.status })) })),
    pending_policy: pc.length ? WHOLE_FILM_PENDING_POLICY : null,
    action: '缺台词的镜：补齐 <d> 后重新出片，再重新合成。跳过的章：补完镜后再整片合并，这些章才会进成片。',
  };
}
export function assembleGateReportNeeded(gateRes) {
  return !!(gateRes && ((gateRes.warnings || []).length || (gateRes.pendingChapters || []).length));
}
export function assembleGateWarnText(warnings) {
  return '有 ' + warnings.length + ' 镜成片缺台词（只提醒，照常合成）：' + warnings.map((w) => (w.chapter || '?') + ' 第' + (w.idx == null ? '?' : w.idx) + '镜').join('、');
}
