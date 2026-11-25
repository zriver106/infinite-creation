// 「提示词撰写」走外部 Agent（Claude CLI + skill）时的专用工具集与校验（2026-11-17 第二轮）。
// - 只在 MCP 子进程环境 IC_MCP_TOOLSET=prompt-write 时启用：此时 MCP 只暴露「读」工具 + 本文件的三个工具，
//   写入只能经 save_shot_video_prompt，且只写本章、没有提示词、还没出视频的镜的 video_prompt。
// - 不碰渲染：不暴露任何出图/出视频/音频工具，也不暴露 update_shot / set_storyboard / set_chapter_script。
// - 依赖只有 core / shared（不引 job-runner，MCP 子进程里不拉起任务系统）。
import { Shots, Assets, Chapters, assembleShotReferences, withWriteContext, logger } from '../core/index.js';
import { buildExpressionSwitchBlock } from '../shared/index.js';
import { offscreenLines, offscreenPromptNote } from '../core/offscreen-lines.js';

export const PROMPT_WRITE_TOOLSET = 'prompt-write';
// 「提示词撰写」（含「只生成分镜」收尾补提示词）固定用的外部 CLI 模型：显式传 --model，不吃 CLI 默认值。
// 'opus' 是 Claude CLI 的别名（2026-11-17 解析为 claude-opus-5-5，见第三轮报告 jsonl 核对）。
export const PROMPT_WRITE_MODEL = 'opus';
export const H3_SKILL = 'h3-prompt-writing';

// 允许外部 Agent 使用的现有工具（全部只读，report 只写进度）。
export const PROMPT_WRITE_READ_TOOLS = new Set([
  'skill', 'skill_reference', 'get_project', 'get_chapter', 'list_assets', 'view_asset', 'view_shot_references', 'report',
]);

export const PROMPT_WRITE_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'list_prompt_todo', description: '列出本任务目标章里需要补写视频提示词的分镜（没有 video_prompt 且还没出视频），按 idx 升序；也返回本章总镜数和剩余数。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_shot_prompt_brief', description: '读取某分镜写 H3 视频提示词所需的全部材料：时长/场景/镜头/画面/台词/旁白/子镜头时间轴、角色与场景一致性描述、表现开关，以及参考素材的固定顺序（__MINIMAX_H3_REF_N__ 编号与对应图片/音色）。', parameters: { type: 'object', properties: { shot_id: { type: 'string' } }, required: ['shot_id'] } } },
  { type: 'function', function: { name: 'save_shot_video_prompt', description: '保存一镜按 h3-prompt-writing 写好的完整视频提示词（只写 video_prompt）。会校验：本章、该镜没有提示词且未出视频；参考占位符必须与 get_shot_prompt_brief 给出的编号一一对应（全部引用、不得新造）；<d></d> 必须成对；不得出现台词账目词。校验不过会返回原因，按原因修改后重新保存。', parameters: { type: 'object', properties: { shot_id: { type: 'string' }, video_prompt: { type: 'string' } }, required: ['shot_id', 'video_prompt'] } } },
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

const REF_RE_G = /__MINIMAX_H3_REF_(\d+)__/g;
// H3 会把这些账目词念出来（h3-prompt-writing「No ledger words」）：只允许出现在 <d> 之外为零次。
const LEDGER_WORDS = ['台词：无', '无对白', '（无对白）', '（沉默）', '（内心）', '心声'];

/**
 * 纯函数校验：refCount = 本镜参考素材数（占位符 1..refCount 必须全部出现、不得超出）。
 * @returns {{ ok: boolean, text: string, errors: string[] }}
 */
export function checkVideoPrompt(raw, refCount, _dialogue = '') { // eslint-disable-line no-unused-vars
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
  // 第三个参数 dialogue 保留签名兼容（hSave 仍会传），目前不再据此拒存。
  return { ok: errors.length === 0, text, errors };
}

function chapterTitleOf(ctx) {
  const want = String(ctx.chapter || '').trim();
  if (!want) return '';
  const c = Chapters.list(ctx.projectId).find((x) => x.title === want || x.id === want);
  return c ? c.title : want;
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
const session = { skillLoaded: false, saved: 0, rejected: 0 };
export function notePromptWriteToolCall(name, args) {
  if (name === 'skill' && args && String(args.name || '').trim() === H3_SKILL) session.skillLoaded = true;
}
export function _resetPromptWriteSession() { session.skillLoaded = false; session.saved = 0; session.rejected = 0; }

async function hListTodo(ctx) {
  const title = chapterTitleOf(ctx);
  const all = Shots.list(ctx.projectId).filter((s) => s.chapter === title);
  const todo = all.filter(shotNeedsPrompt).sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  return JSON.stringify({
    chapter: title,
    total: all.length,
    remaining: todo.length,
    skill_loaded: session.skillLoaded,
    shots: todo.map((s) => ({ shot_id: s.id, idx: s.idx, scene_name: s.scene_name || '', duration: s.duration, dialogue: String(s.dialogue || '').slice(0, 80) })),
  });
}

async function hBrief(ctx, args) {
  const shot = shotOfChapter(ctx, args.shot_id);
  const { references, characterDesc, sceneDesc, unmatchedSpeakers } = await referencesOf(ctx, shot);
  return JSON.stringify({
    shot_id: shot.id,
    idx: shot.idx,
    chapter: shot.chapter,
    needs_prompt: shotNeedsPrompt(shot),
    project_style: ctx.project.style || '未指定',
    duration: shot.duration || 5,
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
    character_consistency: characterDesc || '',
    scene_consistency: sceneDesc || '',
    unmatched_speakers: unmatchedSpeakers || [],
    expression_switches: buildExpressionSwitchBlock(ctx.project) || '',
    references: references.map((r, i) => ({ placeholder: '__MINIMAX_H3_REF_' + (i + 1) + '__', type: r.type === 'audio' ? 'audio(音色)' : 'image(图片)', label: r.label || '参考素材' })),
    rule: references.length
      ? '参考素材按此顺序编号：必须逐个引用全部 ' + references.length + ' 个占位符，不得新造编号'
      : '本镜没有参考素材（纯文生视频）：不要写任何 __MINIMAX_H3_REF_N__ 占位符',
  });
}

async function hSave(ctx, args) {
  if (!session.skillLoaded) {
    session.rejected++;
    throw new Error('保存被拒：请先调用 skill(name="' + H3_SKILL + '") 读完 H3 提示词规范，再按规范写');
  }
  const shot = shotOfChapter(ctx, args.shot_id);
  if (!shotNeedsPrompt(shot)) {
    session.rejected++;
    throw new Error('保存被拒：分镜 ' + shot.idx + ' 已有提示词或已出视频，本任务只补缺、不覆盖');
  }
  const { references } = await referencesOf(ctx, shot);
  const chk = checkVideoPrompt(args.video_prompt, references.length, shot.dialogue);
  if (!chk.ok) {
    session.rejected++;
    throw new Error('保存被拒（分镜 ' + shot.idx + '）：' + chk.errors.join('；'));
  }
  // 写入前再读一次，防并发：别的任务刚好写上了就不覆盖
  const fresh = Shots.get(shot.id);
  if (!shotNeedsPrompt(fresh)) throw new Error('保存被拒：分镜 ' + shot.idx + ' 刚被其他任务写上了提示词，不覆盖');
  withWriteContext('agent:save_shot_video_prompt', () => Shots.update(shot.id, { video_prompt: chk.text, error: '' }));
  session.saved++;
  if (ctx.report) ctx.report({ phase: '分镜提示词', detail: '已写分镜 ' + shot.idx + ' 的视频提示词' });
  const title = chapterTitleOf(ctx);
  const remaining = Shots.list(ctx.projectId).filter((s) => s.chapter === title && shotNeedsPrompt(s)).length;
  return JSON.stringify({ saved: true, shot_id: shot.id, idx: shot.idx, refs: references.length, chars: chk.text.length, remaining });
}

const HANDLERS = { list_prompt_todo: hListTodo, get_shot_prompt_brief: hBrief, save_shot_video_prompt: hSave };

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
export function buildPromptWriteAgentPrompt({ project, chapter, missing }) {
  const title = String(chapter || '');
  return [
    '【IC「提示词撰写」任务】你只做一件事：给项目「' + ((project && project.name) || '') + '」的「' + title + '」里缺视频提示词的分镜，逐镜写 MiniMax H3 视频提示词并保存。预计 ' + (missing || 0) + ' 镜。',
    '【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 先调用 skill(name="' + H3_SKILL + '")，完整读完 H3 提示词规范（这是本项目的 H3 手册）；需要示例时用 skill_reference(name="' + H3_SKILL + '", ref="ref-en.txt")。没加载技能前保存会被拒。',
    '2. 调用 list_prompt_todo 拿到待写分镜。',
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
