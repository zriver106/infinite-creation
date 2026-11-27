// 「提示词撰写」走外部 Agent（Claude CLI + skill）时的专用工具集与校验（2026-11-17 第二轮）。
// - 只在 MCP 子进程环境 IC_MCP_TOOLSET=prompt-write 时启用：此时 MCP 只暴露「读」工具 + 本文件的三个工具，
//   写入只能经 save_shot_video_prompt，且只写本章、没有提示词、还没出视频的镜的 video_prompt。
// - 不碰渲染：不暴露任何出图/出视频/音频工具，也不暴露 update_shot / set_storyboard / set_chapter_script。
// - 依赖只有 core / shared（不引 job-runner，MCP 子进程里不拉起任务系统）。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Shots, Assets, Chapters, Jobs, assembleShotReferences, withWriteContext, logger, prevShotOf } from '../core/index.js';
import { leadInDecision, LEAD_IN_FRAMES, LEAD_IN_SECONDS } from '../core/lead-in.js';

function leadInBriefFields(ctx, shot) {
  try {
    const dec = leadInDecision(shot, prevShotOf(shot, Shots.list(ctx.projectId)));
    if (!dec.on) return {};
    if (dec.mode === 'auto' && ctx.cfg && ctx.cfg.generation && ctx.cfg.generation.leadInAuto === false) return {};
    return { lead_in_frames: LEAD_IN_FRAMES, lead_in_seconds: Math.round(LEAD_IN_SECONDS * 100) / 100, lead_in_rule: '本镜开头 ' + LEAD_IN_FRAMES + ' 帧（约 ' + LEAD_IN_SECONDS.toFixed(2) + ' 秒）会钉上一镜结尾的画面和声音（' + dec.reason + '），成片里剪掉；本镜的台词和新动作从 ' + LEAD_IN_SECONDS.toFixed(2) + ' 秒之后开始，按规则书写' };
  } catch { return {}; }
}
import { buildExpressionSwitchBlock, styleAnchor } from '../shared/index.js';
import { offscreenLines, offscreenPromptNote } from '../core/offscreen-lines.js';
import { checkDialogueInD } from '../core/dialogue-d-gate.js';
import { loadRuleIndex, requiredRanges, sectionsCoveredBy, baseSections, appendProjectJsonl, promptExtraIndexes, PROMPT_EXTRA_SKILLS } from '../core/rule-book.js';
import { projectDir } from '../core/config.js';
import { sceneBlockingOf } from './binding-check.js';
import { prevStates, sceneCast, speakerVoices } from './brief-context.js';
import { expressionSwitchValues } from '../shared/index.js';

export const PROMPT_WRITE_TOOLSET = 'prompt-write';
// 「提示词撰写」（含「只生成分镜」收尾补提示词）固定用的外部 CLI 模型：显式传 --model，不吃 CLI 默认值。
// 'opus' 是 Claude CLI 的别名（2026-11-17 解析为 claude-opus-5-5，见第三轮报告 jsonl 核对）。
export const PROMPT_WRITE_MODEL = 'opus';
export const H3_SKILL = 'h3-prompt-writing';
// 服装规则会话（2026-11-24 03:09 总导）：分镜 visual 指定镜重写也走本工具集；写 visual 前必须先读改编规则书。
export const ADAPT_SKILL = 'adapt-rules';

// 允许外部 Agent 使用的现有工具（全部只读，report 只写进度）。
export const PROMPT_WRITE_READ_TOOLS = new Set([
  'skill', 'skill_lines', 'report_rule_gap', 'skill_reference', 'get_project', 'get_chapter', 'list_assets', 'view_asset', 'view_shot_references', 'report',
]);

export const PROMPT_WRITE_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'list_prompt_todo', description: '列出本任务目标章里需要补写视频提示词的分镜（没有 video_prompt 且还没出视频），按 idx 升序；也返回本章总镜数和剩余数。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_shot_prompt_brief', description: '读取某分镜写 H3 视频提示词所需的全部材料：时长/场景/镜头/画面/台词/旁白/子镜头时间轴、角色与场景一致性描述、本镜地点的站位表（scene_blocking）、表现开关，以及参考素材的固定顺序（__MINIMAX_H3_REF_N__ 编号与对应图片/音色）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'save_shot_visual', description: '（只在「分镜 visual 指定镜重写」任务里可用）保存一镜改好的分镜字段：只能写 visual、sub_shots、camera 三个（至少传一个，不改的不要传）。台词、旁白、人物、场景、道具、服装绑定、年龄变体、音色、时长一律锁定：参数里带了就拒存，存盘前核这些字段的 md5 与提交时一致才写。会校验：本任务名单里的镜、已先读 skill(adapt-rules)；写前三个字段的旧值存档。其他任务调用会被拒。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, visual: { type: 'string', description: '改好的完整分镜画面描述（不改就不传）' }, sub_shots: { type: 'string', description: '改好的完整子镜头时间轴（不改就不传）' }, camera: { type: 'string', description: '改好的完整镜头/运镜描述（不改就不传）' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'save_shot_video_prompt', description: '保存一镜按 h3-prompt-writing 写好的完整视频提示词（只写 video_prompt）。会校验：本章、该镜没有提示词且未出视频；参考占位符必须与 get_shot_prompt_brief 给出的编号一一对应（全部引用、不得新造）；<d></d> 必须成对；不得出现台词账目词。校验不过会返回原因，按原因修改后重新保存。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, video_prompt: { type: 'string' }, ranges_ack: { type: 'array', items: { type: 'string' }, description: '读过的各规则段末尾「本段校验码：XXXXXXXX」的校验码：地图、全部基础段、brief.required_ranges 里的每一段都要有（规则书布局时必填）' } }, required: ['shot_id', 'video_prompt'] } } },
];
const EXTRA_NAMES = new Set(PROMPT_WRITE_EXTRA_TOOLS.map((t) => t.function.name));

export function isPromptWriteToolAllowed(name) {
  return PROMPT_WRITE_READ_TOOLS.has(name) || EXTRA_NAMES.has(name);
}
export function isPromptWriteExtraTool(name) { return EXTRA_NAMES.has(name); }

/** 从完整工具定义里挑出本工具集（读工具 + 三个专用工具）。 */
export function promptWriteToolDefinitions(allDefs) {
  return [...(allDefs || []).filter((t) => PROMPT_WRITE_READ_TOOLS.has(t.function.name)), ...PROMPT_WRITE_EXTRA_TOOLS];
}

const hasPrompt = (s) => !!String((s && s.video_prompt) || '').trim();
const hasVideo = (s) => !!(s && s.status === 'done' && s.video_path);
/** 该分镜是否需要「提示词撰写」补写：没有提示词，且还没出视频。 */
export function shotNeedsPrompt(s) { return !!s && !hasPrompt(s) && !hasVideo(s); }

// 续轮12快：「指定镜重写」模式（Andy 11-24 00:14「保留现有分镜，只让 IC 重写提示词」）。
// 提交时显式给 shot_ids → 存进 job.checkpoint.rewriteShotIds；只有这些镜可写，已有提示词/已出视频也照写（视频文件不动、不出片），
// 写前旧提示词存档到 prompt_history.jsonl（action=rewrite，带 job_id）；同一任务里每镜只重写一次（以存档为准，跨轮也认）。
export const PROMPT_HISTORY_FILE = 'prompt_history.jsonl';
const BUSY_STATUS = new Set(['generating', 'queued', 'obsolete']);
export function rewriteIdsOfJob(jobId) {
  if (!jobId) return null;
  try {
    const j = Jobs.get(jobId);
    const ids = j && j.checkpoint && Array.isArray(j.checkpoint.rewriteShotIds) ? j.checkpoint.rewriteShotIds.map(String).filter(Boolean) : [];
    return ids.length ? new Set(ids) : null;
  } catch { return null; }
}
// 续轮13 R：提交时带的每镜修改要求（job.checkpoint.rewriteRequirements = { shot_id: 文本 }）。没有就返回 ''。
export function requirementOfJob(jobId, shotId) {
  if (!jobId || !shotId) return '';
  try {
    const j = Jobs.get(jobId);
    const m = j && j.checkpoint && j.checkpoint.rewriteRequirements;
    const v = m && typeof m === 'object' ? m[String(shotId)] : '';
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}
// 服装规则会话：重写目标（job.checkpoint.rewriteTarget）。'visual' = 分镜 visual 指定镜重写；其余 = 视频提示词。
export function targetOfJob(jobId) {
  if (!jobId) return 'video_prompt';
  try {
    const j = Jobs.get(jobId);
    return j && j.checkpoint && j.checkpoint.rewriteTarget === 'visual' ? 'visual' : 'video_prompt';
  } catch { return 'video_prompt'; }
}
const actionOfTarget = (target) => (target === 'visual' ? 'rewrite_visual' : 'rewrite');
export function rewrittenIdsOfJob(projectDirAbs, jobId) {
  const out = new Set();
  const want = actionOfTarget(targetOfJob(jobId));
  if (!jobId) return out;
  try {
    const f = path.join(projectDirAbs, PROMPT_HISTORY_FILE);
    if (!fs.existsSync(f)) return out;
    for (const line of fs.readFileSync(f, 'utf8').split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.job_id === jobId && r.action === want && r.shot_id) out.add(String(r.shot_id)); } catch {}
    }
  } catch {}
  return out;
}
/** 本任务里这一镜要不要写：重写模式 = 在名单里、没在生成/排队/作废、本任务还没重写过；否则 = 原口径（无提示词且未出视频）。 */
export function shotNeedsPromptForJob(s, rewriteIds, rewritten) {
  if (!s) return false;
  if (rewriteIds) return rewriteIds.has(String(s.id)) && !BUSY_STATUS.has(String(s.status || '')) && !(rewritten && rewritten.has(String(s.id)));
  return shotNeedsPrompt(s);
}
function needsOf(ctx) {
  const rw = rewriteIdsOfJob(ctx.jobId);
  const done = rw ? rewrittenIdsOfJob(projectDir(ctx.projectId), ctx.jobId) : null;
  return (s) => shotNeedsPromptForJob(s, rw, done);
}

const REF_RE_G = /__MINIMAX_H3_REF_(\d+)__/g;
// H3 会把这些账目词念出来（h3-prompt-writing「No ledger words」）：只允许出现在 <d> 之外为零次。
const LEDGER_WORDS = ['台词：无', '无对白', '（无对白）', '（沉默）', '（内心）', '心声'];

/**
 * 纯函数校验：refCount = 本镜参考素材数（占位符 1..refCount 必须全部出现、不得超出）。
 * @returns {{ ok: boolean, text: string, errors: string[] }}
 */
export function checkVideoPrompt(raw, refCount, dialogue = '') {
  const errors = [];
  const text = String(raw == null ? '' : raw).trim().replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (!text) return { ok: false, text, errors: ['提示词为空'] };
  if (text.length > 12000) errors.push('提示词过长（' + text.length + ' 字符，上限 12000）');
  const n = Math.max(0, Number(refCount) || 0);
  const got = new Set();
  for (const m of text.matchAll(REF_RE_G)) got.add(Number(m[1]));
  if (n === 0) {
    if (got.size) errors.push('本镜没有参考素材（纯文生视频），不得写任何 __MINIMAX_H3_REF_N__ 占位符');
  } else {
    const missing = [];
    for (let i = 1; i <= n; i++) if (!got.has(i)) missing.push('__MINIMAX_H3_REF_' + i + '__');
    if (missing.length) errors.push('漏引用参考占位符：' + missing.join('、'));
    const extra = [...got].filter((i) => i < 1 || i > n).sort((a, b) => a - b);
    if (extra.length) errors.push('新造了不存在的占位符编号：' + extra.map((i) => '__MINIMAX_H3_REF_' + i + '__').join('、') + '（本镜只有 1..' + n + '）');
  }
  // <d></d> 成对且不嵌套
  let depth = 0;
  let bad = false;
  for (const m of text.matchAll(/<\/?d>/g)) {
    if (m[0] === '<d>') { if (depth) bad = true; depth++; } else { if (!depth) bad = true; depth = Math.max(0, depth - 1); }
  }
  if (bad || depth) errors.push('<d></d> 不成对或嵌套');
  const outside = text.replace(/<d>[\s\S]*?<\/d>/g, ' ');
  const ledger = LEDGER_WORDS.filter((w) => outside.includes(w));
  if (ledger.length) errors.push('<d> 之外出现了会被念出来的账目词：' + ledger.join('、'));
  // 画外台词（心声/OS、电话那头、广播、系统音、旁白）2026-11-22 起也写 <d> 由 H3 直出：旧口径「画外台词进了 <d> 就拒存」已去掉。
  // 〔合并版 v2，Andy 11-23 16:04：系统声、旁白照现行手册后期配，不写 <d>，台词门不查它们〕
  // T2 第3批（TR-V15/TR-E05 台词硬拦，草案）：第三个参数 dialogue 重新启用——
  // 每句对白/心声/电话声都要写进 <d>（系统声、旁白后期配，不查），一条 <d> 不得装不同说话人的几句；不过就拒存（hSave 已经在传 shot.dialogue）。
  const gate = checkDialogueInD(dialogue, text);
  for (const e of gate.errors) errors.push(e.code + '：' + e.msg);
  return { ok: errors.length === 0, text, errors, warnings: gate.warnings.map((w) => w.code + '：' + w.msg) };
}

function chapterTitleOf(ctx) {
  const want = String(ctx.chapter || '').trim();
  if (!want) return '';
  const c = Chapters.list(ctx.projectId).find((x) => x.title === want || x.id === want);
  return c ? c.title : want;
}

// 2026-11-26（Andy「写提示词的时候不光要看剧本，还要看原著，都要理解才行」）：本章剧本和原著原文随 brief 交给写稿 Agent。
// 每章只在本任务第一次 brief 里给全文（一章约 1–4 千字），之后的镜只给提示，需要时 get_chapter 再读。
export const SOURCE_RULE = '写这一镜之前，先在 chapter_script（本章剧本）和 chapter_novel（本章原著原文）里找到这一镜对应的段落读懂：谁在场、做什么动作、什么反应、情绪怎么变。剧情事实（谁在场、在做什么动作、有什么反应、当时的时间和天气）以原著为准：分镜在这些事实上和原著冲突时照原著写，并调用 report_rule_gap 登记。镜头设计照分镜写，不因原著改动：景别、机位、时长、切点、哪一镜说哪句台词。台词以剧本为准。不要把原著原文抄进提示词。';
// 2026-11-26（Andy「写稿时按江澈当时所处的阶段来演」）：主角主线地图按章号取本章所在阶段与节点。
// 数据由 M\工具\arc_notes_build.py 从项目「原著索引/主角主线」生成到 IC 项目目录 protagonist_arc.json；IC 第N章 = 原著第N章。
export const ARC_RULE = 'protagonist_stage 是主角在本章所处的人生阶段（钱、能力、地位、身边人、心态、待人处事、表演提示，来自主角主线地图）：主角的神情、语气、站姿、花钱时的反应、对人的距离感，按这一阶段演，不要演成别的阶段的他。它只管表演基调，不改剧情事实和镜头设计。';
export function protagonistStageOf(arc, chapterTitle) {
  const m = String(chapterTitle || '').match(/第\s*(\d+)\s*章/);
  if (!arc || !m) return null;
  const n = Number(m[1]);
  const inR = (x) => Number(x.from) <= n && n <= Number(x.to);
  const stage = (arc.stages || []).find(inR) || null;
  const nodes = (arc.nodes || []).filter(inR).map((x) => ({ title: x.title, text: x.text }));
  if (!stage && !nodes.length) return null;
  return { chapter_no: n, stage, nodes };
}
function arcOf(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir(ctx.projectId), 'protagonist_arc.json'), 'utf8')); } catch { return null; }
}

function chapterSourceOf(ctx, shot) {
  const title = shot.chapter || '';
  if (session.sourceGiven.has(title)) {
    return { chapter_source: '本章剧本、原著原文和主角所处阶段（protagonist_stage）已在本任务第一次 get_shot_prompt_brief 里给过；剧本和原著记不清时用 get_chapter(chapter="' + title + '") 再读', source_rule: SOURCE_RULE };
  }
  let c = null;
  try { c = (Chapters.list(ctx.projectId) || []).find((x) => x.title === title) || null; if (c && Chapters.get) c = Chapters.get(c.id) || c; } catch { c = null; }
  if (!c) return { chapter_source: '读不到本章剧本和原著，请用 get_chapter(chapter="' + title + '") 读', source_rule: SOURCE_RULE };
  session.sourceGiven.add(title);
  const stage = protagonistStageOf(arcOf(ctx), title);
  return { chapter_script: String(c.script || ''), chapter_novel: String(c.novel || ''), ...(stage ? { protagonist_stage: stage, arc_rule: ARC_RULE } : {}), source_rule: SOURCE_RULE };
}

function shotOfChapter(ctx, shotId) {
  const shot = Shots.get(shotId);
  if (!shot || shot.project_id !== ctx.projectId) throw new Error('分镜不存在：' + shotId);
  const title = chapterTitleOf(ctx);
  if (!title || shot.chapter !== title) throw new Error('该分镜不属于本任务的章节「' + title + '」');
  return shot;
}

async function referencesOf(ctx, shot) {
  if (shot.mode === 'text') return { references: [], characterDesc: '', sceneDesc: '', unmatchedSpeakers: [] };
  const assets = Assets.list(ctx.projectId);
  // 只解析不上传：编号与渲染时真正绑定的媒体顺序一致（与 write_shot_video_prompt 同一口径）。
  return assembleShotReferences({ cfg: ctx.cfg, project: ctx.project, shot, assets, upload: false });
}

// 会话内状态：保存前必须先加载过 h3 技能（每个 MCP 子进程 = 一次任务）。
const session = { skillLoaded: false, adaptLoaded: false, saved: 0, rejected: 0, served: new Set(), sourceGiven: new Set() };
export function notePromptWriteToolCall(name, args) {
  if (name === 'skill' && args && String(args.name || '').trim() === H3_SKILL) session.skillLoaded = true;
  if (name === 'skill' && args && String(args.name || '').trim() === ADAPT_SKILL) session.adaptLoaded = true;
}
// 续轮6：工具成功返回后记「本任务真实返回过的规则段」：skill(h3) → 地图+全部基础段；skill_lines → 完整覆盖的段。
export function notePromptWriteToolResult(name, args, dir) {
  const a = args || {};
  const sk = String(a.name || '').trim();
  // 第2件：其他技能里写提示词要读的段（prompt_when）用 skill_lines 读到全段，记成「技能:段号」
  if (sk !== H3_SKILL && PROMPT_EXTRA_SKILLS.includes(sk) && name === 'skill_lines') {
    const ex = loadRuleIndex(sk, dir);
    if (ex) for (const s of sectionsCoveredBy(ex, Number(a.from), Number(a.to))) session.served.add(sk + ':' + s.id);
    return;
  }
  if (sk !== H3_SKILL) return;
  const idx = loadRuleIndex(H3_SKILL, dir);
  if (!idx) return;
  if (name === 'skill') for (const s of baseSections(idx)) session.served.add(s.id);
  if (name === 'skill_lines') for (const s of sectionsCoveredBy(idx, Number(a.from), Number(a.to))) session.served.add(s.id);
}
export function promptWriteServedSections() { return [...session.served]; }
export function _resetPromptWriteSession() { session.skillLoaded = false; session.adaptLoaded = false; session.saved = 0; session.rejected = 0; session.served = new Set(); session.sourceGiven = new Set(); }

function rangesOf(ctx, shot) {
  const idx = loadRuleIndex(H3_SKILL);
  if (!idx) return null;
  return { idx, rr: requiredRanges(idx, shot, ctx.project, { switches: expressionSwitchValues(ctx.project), extraIndexes: promptExtraIndexes() }) };
}

async function hListTodo(ctx) {
  const title = chapterTitleOf(ctx);
  const all = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  const todo = all.filter(needsOf(ctx)).sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  return JSON.stringify({
    chapter: title,
    total: all.length,
    remaining: todo.length,
    skill_loaded: { loaded: session.skillLoaded, sections: [...session.served] },
    shots: todo.map((s) => ({ shot_id: s.id, idx: s.idx, scene_name: s.scene_name || '', duration: s.duration, dialogue: String(s.dialogue || '').slice(0, 80), has_revision_requirement: !!requirementOfJob(ctx.jobId, s.id) })),
  });
}

function boundCostumesOf(ctx, shot) {
  try {
    const assets = Assets.list(ctx.projectId);
    const byId = new Map(assets.map((a) => [String(a.id), a]));
    const chars = new Set((shot.character_ids || []).map(String));
    return (shot.costume_ids || []).map((id) => byId.get(String(id))).filter((a) => a && a.category === 'costume' && chars.has(String(a.parent_id)))
      .map((a) => ({ character: (byId.get(String(a.parent_id)) || {}).name || '', costume_id: a.id, costume_name: a.name || '', description: String(a.description || '') }));
  } catch { return []; }
}

async function hBrief(ctx, args) {
  const shot = shotOfChapter(ctx, args.shot_id);
  const { references, characterDesc, sceneDesc, unmatchedSpeakers } = await referencesOf(ctx, shot);
  const allAssets = Assets.list(ctx.projectId);
  const narrative = Shots.listInNarrativeOrder(ctx.projectId);
  const rb = rangesOf(ctx, shot);
  const ruleFields = rb ? {
    rules_version: rb.rr.rules_version,
    required_ranges: rb.rr.required_ranges,
    required_chars: rb.rr.required_chars,
    too_dense: rb.rr.too_dense,
    ranges_rule: rb.rr.too_dense
      ? '本镜需要的规则合计 ' + rb.rr.required_chars + ' 字，超过预算 ' + (rb.idx.budget_chars || 40000) + ' 字：不要写，报回「需在分镜层拆成两个 7–8 秒的镜头」'
      : '地图+基础规则已在 skill(' + H3_SKILL + ') 里；required_ranges 每段用 skill_lines(name="' + H3_SKILL + '", from=start, to=end) 读；保存时 ranges_ack 交地图、全部基础段和这些段末尾的校验码'
        + (rb.rr.extra_ranges.length ? '；extra_ranges 是其他技能里写提示词也要守的段，每段用 skill_lines(name=该段的 skill, from=start, to=end) 读，校验码一并交进 ranges_ack' : ''),
    ...(rb.rr.extra_ranges.length ? { extra_ranges: rb.rr.extra_ranges } : {}),
  } : {};
  return JSON.stringify({
    ...ruleFields,
    shot_id: shot.id,
    idx: shot.idx,
    chapter: shot.chapter,
    needs_prompt: needsOf(ctx)(shot),
    rewrite: !!rewriteIdsOfJob(ctx.jobId),
    rewrite_target: targetOfJob(ctx.jobId),
    // 服装规则（Andy 2026-11-24）：本镜每个人绑定的服装资产描述；visual 和提示词里的衣物必须与它一致
    bound_costumes: boundCostumesOf(ctx, shot),
    costume_rule: '服装照抄 bound_costumes 里该人物绑定服装资产的描述（上衣、下装、外套、鞋的种类和主色一致，不写资产没有的衣物）；visual 与资产不一致时以资产为准，并在总结里写明',
    ...(requirementOfJob(ctx.jobId, shot.id) ? {
      revision_requirement: requirementOfJob(ctx.jobId, shot.id),
      revision_rule: '这一镜是返修重写，revision_requirement 是导演给这一镜的修改要求：逐条照做；它与分镜字段冲突时以修改要求为准，与规则书冲突时以规则书为准、并调用 report_rule_gap 登记；不要把修改要求原文抄进提示词，写成提示词能直接执行的画面和声音描述',
    } : {}),
    project_style: ctx.project.style || '未指定',
    // 有英文锚点的风格（如「写实偏动漫3D」）另给一句英文描述，提示词里的画风按它写
    ...(styleAnchor(ctx.project.style) ? { project_style_anchor: styleAnchor(ctx.project.style) } : {}),
    duration: shot.duration || 5,
    // 承接上一镜 22 帧（lead-in.js）：本镜开头 22 帧（约 0.92 秒）钉的是上一镜结尾的画面和声音，导出时剪掉
    ...leadInBriefFields(ctx, shot),
    mode: shot.mode || 'auto',
    scene_name: shot.scene_name || '',
    camera: shot.camera || '',
    visual: shot.visual || '',
    // 全部台词（含心声/电话声）都要写进 <d>，由 H3 直出（2026-11-22）；offscreen_lines 标明哪些是画外
    dialogue: shot.dialogue || '',
    offscreen_lines: offscreenLines(shot.dialogue).map((l) => ({ kind: l.kind, speaker: l.speaker, text: l.text })),
    offscreen_rule: offscreenPromptNote(shot.dialogue),
    narration: shot.narration || '',
    sub_shots: shot.sub_shots || '',
    ...chapterSourceOf(ctx, shot),
    character_consistency: characterDesc || '',
    scene_consistency: sceneDesc || '',
    // 站位表：本镜地点 _MV 的说明（D 平面站位、门窗家具方位、A/B/C 机位方向）；同地点跨镜、跨章按它写（主会话 seq2215）
    scene_blocking: sceneBlockingOf(shot, allAssets),
    // 第4件（主会话 seq2227）：同场在场人物名单，和站位表一起用
    scene_cast: sceneCast(ctx.projectId, shot, allAssets, narrative),
    scene_blocking_rule: 'scene_blocking 是本镜所在地点的站位表（该地点多视角定义图 _MV 的说明）：人物站/坐的位置、门窗家具在画面哪一侧、机位从 A/B/C 哪个方向拍，visual 和提示词都按它写，同一地点跨镜、跨章保持一致；与 visual 冲突时以站位表为准并在总结里写明；为空表示该地点还没有站位表，按规则书处理。scene_cast 是同场在场人物：present 是这一场连续几镜（shots）里出现过的全部人物，in_this_shot 是本镜绑定的，not_in_this_shot 是同场在但本镜没绑的（他们在画面外的哪个位置照站位表）',
    unmatched_speakers: unmatchedSpeakers || [],
    // 第4件：本镜说话人音色资产的性别和音高（写 <d> 的声线描述要和它一致）
    speaker_voices: speakerVoices(shot, allAssets),
    // 第4件：上一镜 / 上一集末镜的状态（服装、伤妆、姿态），接续时照它写
    ...prevStates(ctx.projectId, shot, allAssets, narrative),
    continuity_rule: 'prev_shot 是本章上一镜、prev_chapter_last_shot 是上一集末镜（本镜是本章第一镜或和它同一地点时才给）：同一人物的服装、伤妆、脏污、姿态、手里的东西，没有原著依据的变化就照上一镜接着写；speaker_voices 是说话人音色资产的性别和音高，写说话人声线时与它一致',
    expression_switches: buildExpressionSwitchBlock(ctx.project) || '',
    references: references.map((r, i) => ({ placeholder: '__MINIMAX_H3_REF_' + (i + 1) + '__', type: r.type === 'audio' ? 'audio(音色)' : 'image(图片)', label: r.label || '参考素材' })),
    rule: references.length
      ? '参考素材按此顺序编号：必须逐个引用全部 ' + references.length + ' 个占位符，不得新造编号'
      : '本镜没有参考素材（纯文生视频）：不要写任何 __MINIMAX_H3_REF_N__ 占位符',
  });
}

async function hSave(ctx, args) {
  if (targetOfJob(ctx.jobId) === 'visual') {
    session.rejected++;
    throw new Error('保存被拒：本任务是「分镜 visual 指定镜重写」，只能用 save_shot_visual 写 visual，不写视频提示词');
  }
  if (!session.skillLoaded) {
    session.rejected++;
    throw new Error('保存被拒：请先调用 skill(name="' + H3_SKILL + '") 读完 H3 提示词规范，再按规范写');
  }
  const shot = shotOfChapter(ctx, args.shot_id);
  const rewriteMode = !!rewriteIdsOfJob(ctx.jobId);
  if (!needsOf(ctx)(shot)) {
    session.rejected++;
    throw new Error(rewriteMode
      ? '保存被拒：分镜 ' + shot.idx + ' 不在本任务的重写名单里、正在生成/排队/已作废，或本任务已重写过'
      : '保存被拒：分镜 ' + shot.idx + ' 已有提示词或已出视频，本任务只补缺、不覆盖');
  }
  const rb = rangesOf(ctx, shot);
  let ackIds = null;
  if (rb) {
    if (rb.rr.too_dense) {
      session.rejected++;
      throw new Error('保存被拒（分镜 ' + shot.idx + '）：too_dense，本镜需要的规则合计 ' + rb.rr.required_chars + ' 字超过预算 ' + (rb.idx.budget_chars || 40000) + ' 字。不要写这一镜，报回：需在分镜层把它拆成两个 7–8 秒的镜头');
    }
    const rawAck = Array.isArray(args.ranges_ack) ? args.ranges_ack : String(args.ranges_ack || '').split(/[,，\s]+/);
    const ack = new Set(rawAck.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean));
    const need = [...baseSections(rb.idx), ...rb.idx.sections.filter((s) => rb.rr.required_ranges.some((r) => r.id === s.id))];
    const extraNeed = rb.rr._extra_sections || [];
    const missing = [...need, ...extraNeed].filter((s) => !ack.has(String(s.checksum || '').toUpperCase()));
    if (missing.length) {
      session.rejected++;
      throw new Error('保存被拒（分镜 ' + shot.idx + '）：ranges_ack 缺少或校验码不对：' + missing.map((s) => (s.skill ? s.skill + ':' : '') + s.id + '（' + s.title + '，第 ' + s.start + '–' + s.end + ' 行）').join('、') + '。请交读过的各段末尾「本段校验码」');
    }
    const unserved = [...need.filter((s) => !session.served.has(s.id)), ...extraNeed.filter((s) => !session.served.has(s.skill + ':' + s.id))];
    if (unserved.length) {
      session.rejected++;
      throw new Error('保存被拒（分镜 ' + shot.idx + '）：这些规则段本任务还没真正读过：' + unserved.map((s) => (s.skill ? s.skill + ':' : '') + s.id + '（第 ' + s.start + '–' + s.end + ' 行）').join('、') + '。地图+基础段用 skill(' + H3_SKILL + ') 读，分册段用 skill_lines 读');
    }
    ackIds = [...need.map((s) => s.id), ...extraNeed.map((s) => s.skill + ':' + s.id)];
  }
  const { references } = await referencesOf(ctx, shot);
  const chk = checkVideoPrompt(args.video_prompt, references.length, shot.dialogue);
  if (!chk.ok) {
    session.rejected++;
    throw new Error('保存被拒（分镜 ' + shot.idx + '）：' + chk.errors.join('；'));
  }
  // 写入前再读一次，防并发：别的任务刚好写上了就不覆盖
  const fresh = Shots.get(shot.id);
  if (!needsOf(ctx)(fresh)) throw new Error('保存被拒：分镜 ' + shot.idx + ' 刚被其他任务写上了提示词或改了状态，不覆盖');
  if (rewriteMode) {
    // 先存档旧提示词；存档写不进就不覆盖
    const okArc = appendProjectJsonl(projectDir(ctx.projectId), PROMPT_HISTORY_FILE, { ts: Date.now(), job_id: ctx.jobId || '', shot_id: shot.id, chapter: shot.chapter, idx: shot.idx, action: 'rewrite', status: fresh.status || '', video_path: fresh.video_path || '', video_prompt: String(fresh.video_prompt || ''), ...(requirementOfJob(ctx.jobId, shot.id) ? { requirement: requirementOfJob(ctx.jobId, shot.id) } : {}) });
    if (!okArc) throw new Error('保存被拒：旧提示词存档失败（' + PROMPT_HISTORY_FILE + '），不覆盖');
  }
  withWriteContext('agent:save_shot_video_prompt', () => Shots.update(shot.id, { video_prompt: chk.text, error: '' }), { job_id: ctx.jobId || '', skill: H3_SKILL, rules_version: (rb && rb.idx.version) || '' });
  session.saved++;
  if (rb && ackIds) appendProjectJsonl(projectDir(ctx.projectId), 'rule_usage.jsonl', { ts: Date.now(), job_id: ctx.jobId || '', tool: 'save_ack', skill: H3_SKILL, version: rb.idx.version || '', sections: ackIds, shot_id: shot.id });
  if (ctx.report) ctx.report({ phase: '分镜提示词', detail: '已写分镜 ' + shot.idx + ' 的视频提示词' });
  const title = chapterTitleOf(ctx);
  const needsAfter = needsOf(ctx);
  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && needsAfter(s)).length;
  return JSON.stringify({ saved: true, shot_id: shot.id, idx: shot.idx, refs: references.length, chars: chk.text.length, remaining });
}

// 服装规则会话：分镜 visual 指定镜重写的保存。只写 visual；名单内、未在生成/排队/作废、本任务未写过；旧 visual 先存档。
// 续轮15（主会话 seq344）：可写字段扩成 visual、sub_shots、camera 三个；其余分镜字段锁定——
// 台词、旁白、人物、场景、道具、服装绑定、年龄变体、音色、时长。提交时记下锁定字段的 md5（checkpoint.lockedFieldsMd5），
// 存盘前、写入后各核一次，变了就拒存/报错；参数里带了锁定字段也拒存。
export const VISUAL_MAX_CHARS = 8000;
export const VISUAL_WRITABLE_FIELDS = ['visual', 'sub_shots', 'camera'];
export const VISUAL_LOCKED_FIELDS = ['dialogue', 'narration', 'character_ids', 'scene_name', 'scene_ids', 'prop_ids', 'costume_ids', 'age_ids', 'audio_ids', 'duration'];
const LOCKED_ARG_NAMES = ['dialogue', 'narration', 'characters', 'character_ids', 'scene_name', 'scenes', 'scene_ids', 'props', 'prop_ids', 'costumes', 'costume_ids', 'ages', 'age_ids', 'audios', 'audio_ids', 'duration', 'video_prompt'];
/** 锁定字段的 md5（数组字段排序后比较，空值统一成 ''）。 */
export function lockedFieldsMd5(shot) {
  const norm = {};
  for (const f of VISUAL_LOCKED_FIELDS) {
    const v = shot ? shot[f] : undefined;
    if (Array.isArray(v)) norm[f] = [...v].map(String).sort();
    else if (f === 'duration') norm[f] = v == null || v === '' ? '' : Number(v);
    else norm[f] = v == null ? '' : String(v);
  }
  return createHash('md5').update(JSON.stringify(norm), 'utf8').digest('hex').toUpperCase();
}
function lockedMd5OfJob(jobId, shotId) {
  try {
    const j = Jobs.get(jobId);
    const m = j && j.checkpoint && j.checkpoint.lockedFieldsMd5;
    return m && typeof m === 'object' ? String(m[String(shotId)] || '') : '';
  } catch { return ''; }
}
async function hSaveVisual(ctx, args) {
  if (targetOfJob(ctx.jobId) !== 'visual') {
    session.rejected++;
    throw new Error('保存被拒：save_shot_visual 只在「分镜 visual 指定镜重写」任务里可用');
  }
  if (!session.adaptLoaded) {
    session.rejected++;
    throw new Error('保存被拒：请先调用 skill(name="' + ADAPT_SKILL + '") 读改编规则书（分镜规则），再改 visual');
  }
  const shot = shotOfChapter(ctx, args.shot_id);
  if (!needsOf(ctx)(shot)) {
    session.rejected++;
    throw new Error('保存被拒：分镜 ' + shot.idx + ' 不在本任务的重写名单里、正在生成/排队/已作废，或本任务已改过');
  }
  // 续轮15：参数里带了锁定字段（台词、人物、场景、服装、时长等）→ 拒存
  const lockedArgs = LOCKED_ARG_NAMES.filter((k) => args[k] !== undefined);
  if (lockedArgs.length) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：本工具只写 visual、sub_shots、camera，不准写 ' + lockedArgs.join('、')); }
  const patch = {};
  for (const f of VISUAL_WRITABLE_FIELDS) {
    if (args[f] === undefined || args[f] === null) continue;
    const v = String(args[f]).trim();
    if (!v) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：' + f + ' 为空（不改的字段不要传）'); }
    if (v.length > VISUAL_MAX_CHARS) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：' + f + ' 超过 ' + VISUAL_MAX_CHARS + ' 字'); }
    patch[f] = v;
  }
  if (!Object.keys(patch).length) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：visual、sub_shots、camera 至少要传一个'); }
  const fresh = Shots.get(shot.id);
  if (!needsOf(ctx)(fresh)) throw new Error('保存被拒：分镜 ' + shot.idx + ' 状态刚变了（生成/排队/作废），不覆盖');
  // 续轮15：锁定字段 md5 硬检（与提交时记下的一致才写）
  const want = lockedMd5OfJob(ctx.jobId, shot.id);
  const before = lockedFieldsMd5(fresh);
  if (!want) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：任务里没有锁定字段 md5 记录，不写'); }
  if (want !== before) { session.rejected++; throw new Error('保存被拒（分镜 ' + shot.idx + '）：锁定字段（台词/人物/场景/服装/时长等）自提交后已变（' + want + ' → ' + before + '），不覆盖'); }
  const req = requirementOfJob(ctx.jobId, shot.id);
  const old = {}; for (const f of VISUAL_WRITABLE_FIELDS) old[f] = String(fresh[f] || '');
  const okArc = appendProjectJsonl(projectDir(ctx.projectId), PROMPT_HISTORY_FILE, { ts: Date.now(), job_id: ctx.jobId || '', shot_id: shot.id, chapter: shot.chapter, idx: shot.idx, action: 'rewrite_visual', status: fresh.status || '', visual: old.visual, sub_shots: old.sub_shots, camera: old.camera, fields: Object.keys(patch), new_values: patch, ...(patch.visual ? { new_visual: patch.visual } : {}), locked_md5: before, ...(req ? { requirement: req } : {}) });
  if (!okArc) throw new Error('保存被拒：旧 visual/sub_shots/camera 存档失败（' + PROMPT_HISTORY_FILE + '），不覆盖');
  withWriteContext('agent:save_shot_visual', () => Shots.update(shot.id, patch), { job_id: ctx.jobId || '', skill: ADAPT_SKILL, rules_version: (loadRuleIndex(ADAPT_SKILL) || {}).version || '' });
  const after = lockedFieldsMd5(Shots.get(shot.id));
  if (after !== before) {
    logger.warn('save_shot_visual: 写入后锁定字段 md5 变了', { shotId: shot.id, before, after });
    appendProjectJsonl(projectDir(ctx.projectId), PROMPT_HISTORY_FILE, { ts: Date.now(), job_id: ctx.jobId || '', shot_id: shot.id, action: 'rewrite_visual_locked_changed', before, after });
    throw new Error('保存后核对失败（分镜 ' + shot.idx + '）：锁定字段 md5 变了（' + before + ' → ' + after + '），旧值在 ' + PROMPT_HISTORY_FILE);
  }
  session.saved++;
  if (ctx.report) ctx.report({ phase: '分镜 visual 重写', detail: '已改分镜 ' + shot.idx + ' 的 ' + Object.keys(patch).join('、') });
  const title = chapterTitleOf(ctx);
  const needsAfter = needsOf(ctx);
  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && needsAfter(s)).length;
  return JSON.stringify({ saved: true, shot_id: shot.id, idx: shot.idx, fields: Object.keys(patch), field: Object.keys(patch).join(','), chars: patch.visual ? patch.visual.length : 0, locked_md5: before, remaining });
}

const HANDLERS = { list_prompt_todo: hListTodo, get_shot_prompt_brief: hBrief, save_shot_video_prompt: hSave, save_shot_visual: hSaveVisual };

export async function runPromptWriteExtraTool(ctx, name, args) {
  const h = HANDLERS[name];
  if (!h) throw new Error('未知工具：' + name);
  try {
    return await h(ctx, args || {});
  } catch (e) {
    logger.warn('prompt-write mcp: ' + name + ' 失败', { error: e && e.message });
    throw e;
  }
}

/** 外部 Agent 的完整任务提示词（系统要求 + 任务）。 */
export function buildPromptWriteAgentPrompt({ project, chapter, missing, jobId }) {
  const title = String(chapter || '');
  if (jobId && targetOfJob(jobId) === 'visual') return buildVisualRewriteAgentPrompt({ project, title, missing });
  if (loadRuleIndex(H3_SKILL)) return buildRuleBookAgentPrompt({ project, title, missing });
  return [
    '【IC「提示词撰写」任务】你只做一件事：给项目「' + ((project && project.name) || '') + '」的「' + title + '」里缺视频提示词的分镜，逐镜写 MiniMax H3 视频提示词并保存。预计 ' + (missing || 0) + ' 镜。',
    '【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 先调用 skill(name="' + H3_SKILL + '")，完整读完 H3 提示词规范（这是本项目的 H3 手册）；需要示例时用 skill_reference(name="' + H3_SKILL + '", ref="ref-en.txt")。没加载技能前保存会被拒。',
    '2. 调用 list_prompt_todo 拿到待写分镜。',
    '2b. 第一镜的 brief 里会带本章剧本 chapter_script 和原著原文 chapter_novel：先通读理解；之后每镜按 source_rule 对照本镜在剧本和原著里的段落：剧情事实以原著为准，镜头设计照分镜，台词照剧本。主角的表演基调按 brief 里的 protagonist_stage（他在本章所处的阶段）来演。',
    '3. 对每一镜：get_shot_prompt_brief(shot_id) 读材料 → 严格按规范写完整提示词 → save_shot_video_prompt(shot_id, video_prompt)。保存被拒时按返回原因修改后重存，不要跳过。',
    '4. 全部写完后再调用一次 list_prompt_todo，确认 remaining 为 0，然后用一两句话总结（写了几镜、有无问题）并结束。',
    '硬性要求：',
    '- 参考素材占位符必须按 brief 给出的顺序逐个引用全部 __MINIMAX_H3_REF_N__，不得新造编号；没有参考素材的镜不写占位符。',
    '- 台词放进成对的 <d>[Chinese] 原台词</d>，<d> 内只放语言标签和原话，其余描述写在 <d> 外（英文）；说话人编号按本镜内开口顺序 (S1)(S2)；心声/OS、谐音配音替换、表现开关等全部按技能规范执行。',
    '- 不写任何字幕/水印/logo 要求；不要输出解释或 Markdown 围栏，video_prompt 只放提示词正文。',
    '- 只允许写视频提示词：不要改分镜、剧本、资产，不出图、不出视频（这些工具本任务也不提供）。',
    '- 不要中途停下来提问，一直做到本章写完。',
  ].join('\n');
}

// 续轮6：规则书布局（skills/h3-prompt-writing/规则全文.index.json 存在）时的任务提示词。
function buildRuleBookAgentPrompt({ project, title, missing }) {
  return [
    '【IC「提示词撰写」任务】你只做一件事：给项目「' + ((project && project.name) || '') + '」的「' + title + '」里缺视频提示词的分镜，逐镜写 MiniMax H3 视频提示词并保存。预计 ' + (missing || 0) + ' 镜。',
    '【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 先调用 skill(name="' + H3_SKILL + '")，读地图和基础规则。没读之前保存会被拒。',
    '2. 调用 list_prompt_todo 拿到待写分镜。',
    '2b. 第一镜的 brief 里会带本章剧本 chapter_script 和原著原文 chapter_novel：先通读，理解本章剧情、人物关系和情绪走向（Andy：写提示词不光看剧本，还要看原著，都要理解）。之后每镜写之前，按 brief 里的 source_rule 找到本镜在剧本和原著里对应的段落：剧情事实（在场人物、动作、反应、时间天气）以原著为准，镜头设计（景别、机位、时长、切点）照分镜，台词照剧本。主角的表演基调按 brief 里的 protagonist_stage（他在本章所处的阶段）来演。',
    '3. 每一镜：get_shot_prompt_brief(shot_id) 读材料；brief 里 required_ranges 列出的每一段，用 skill_lines(name="' + H3_SKILL + '", from=start, to=end) 读对应行段（本任务已读过的段不用重读）。',
    '4. 拿不准时先查地图，找到对应的段去读；有规则就以规则为准；规则里确实没有，才自己判断，并调用 report_rule_gap(shot_id, situation, what_i_did, why) 登记。',
    '5. 写好后调用 save_shot_video_prompt(shot_id, video_prompt, ranges_ack)：ranges_ack 交你读过的各段末尾「本段校验码：」后面的校验码（地图、全部基础段、本镜 required_ranges 的每一段）。保存被拒时按返回原因修改后重存，不要跳过。',
    '5b. brief 里有 revision_requirement 的镜是返修重写：按 revision_rule 逐条落实这一镜的修改要求（以规则书为准，冲突就 report_rule_gap 登记），不要把要求原文抄进提示词。',
    '6. brief 里 too_dense 为 true 的镜不写，在最后的总结里报回：这一镜要在分镜层拆成两个 7–8 秒的镜头。',
    '7. 全部写完后再调用一次 list_prompt_todo，确认除 too_dense 的镜以外都已写完，然后用一两句话总结（写了几镜、哪些镜要拆、登记了几条规则缺口）并结束。',
    '硬性要求：',
    '- 参考素材占位符必须按 brief 给出的顺序逐个引用全部 __MINIMAX_H3_REF_N__，不得新造编号；没有参考素材的镜不写占位符。',
    '- 台词放进成对的 <d>[Chinese] 原台词</d>，<d> 内只放语言标签和原话，其余描述写在 <d> 外（英文）。',
    '- 不写任何字幕/水印/logo 要求；不要输出解释或 Markdown 围栏，video_prompt 只放提示词正文。',
    '- 只允许写视频提示词：不要改分镜、剧本、资产，不出图、不出视频。',
    '- 不要中途停下来提问，一直做到本章写完。',
  ].join('\n');
}

// 服装规则会话（总导 2026-11-24 03:09「分镜 visual 指定镜重写入口」）：只改名单里各镜的 visual，按修改要求只动相关字。
function buildVisualRewriteAgentPrompt({ project, title, missing }) {
  return [
    '【IC「分镜 visual 指定镜重写」任务】你只做一件事：按导演给每镜的修改要求，改项目「' + ((project && project.name) || '') + '」的「' + title + '」里指定分镜的 visual（分镜画面描述）、sub_shots（子镜头时间轴）、camera（镜头/运镜）并保存。预计 ' + (missing || 0) + ' 镜。',
    '【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 先调用 skill(name="' + ADAPT_SKILL + '")，读改编规则书（分镜规则，含〔S-015〕服装描述照抄绑定的服装资产）。没读之前保存会被拒。',
    '2. 调用 list_prompt_todo 拿到本任务要改的分镜。',
    '3. 每一镜：get_shot_prompt_brief(shot_id) 读材料（visual、sub_shots、camera、revision_requirement、bound_costumes、scene_blocking）。',
    '4. 在原 visual / sub_shots / camera 上只改修改要求点名的内容（例如服装、镜头分段、运镜），其余文字逐字保留：修改要求没点名的站位、动作、场景、道具不改，台词一字不改；服装照抄 bound_costumes 里该人物绑定服装资产的描述；修改要求涉及站位或机位方向时，按 scene_blocking 站位表写。',
    '5. 调用 save_shot_visual(shot_id, visual?, sub_shots?, camera?) 保存：改了哪个字段就传哪个字段的完整新文本，没改的不传。台词、人物、场景、服装绑定、时长是锁定的，传了会被拒。保存被拒时按返回原因修改后重存，不要跳过。',
    '6. 全部改完后再调用一次 list_prompt_todo，确认 remaining 为 0，然后用一两句话总结（改了几镜、每镜改了哪几处字、visual 与绑定服装还有没有对不上的）并结束。',
    '硬性要求：',
    '- 只写 visual、sub_shots、camera：不写视频提示词，不改其他分镜字段（台词、人物、场景、服装绑定、时长）、剧本、资产，不出图、不出视频（save_shot_video_prompt 在本任务里会被拒）。',
    '- 修改要求与规则书冲突时以规则书为准，并调用 report_rule_gap 登记；不要把修改要求原文抄进 visual。',
    '- 不要中途停下来提问，一直做到本任务的镜改完。',
  ].join('\n');
}
