// 章节配乐任务（2026-11-26 Andy「32集都bgm 怎么乱配」；主会话 seq2179/seq2181）：外部 Agent 的受限工具集 + 任务提示词。
// 由 IC 自己的 Agent 按 ai-music-studio 读剧本和分镜时间轴，写主曲 + cue 表（切曲 / 静音）。外面只发起任务，不直接写 cue 表。
// 不碰出片、不占 GPU：只读工具 + set_chapter_music / set_chapter_music_cues 两个写工具（只能写本任务这一章）。
// 被 runner.js（任务提示词、工具集名）和 mcp-server.mjs（工具过滤、专用工具）引用；任务提交在 music-score.js。
import fs from 'node:fs';
import path from 'node:path';
import { Shots, ShotVideos, Chapters, projectDir, probeVideoInfo, resolveProjectPath } from '../core/index.js';
import { appendProjectJsonl } from '../core/rule-book.js';

export const MUSIC_SCORE_TOOLSET = 'music-score';
export const MUSIC_SKILL = 'ai-music-studio';
export const MUSIC_GUIDE_REF = '康康合集-BGM情绪与使用指南.md';
export const MUSIC_SCORE_HISTORY_FILE = 'music_score_history.jsonl';

// 只读工具 + 两个配乐写工具（不含 apply_chapter_music / assemble_video / generate_music*：不合成、不出新曲）
export const MUSIC_SCORE_READ_TOOLS = new Set(['skill', 'skill_lines', 'skill_reference', 'get_project', 'get_chapter', 'list_assets', 'report', 'report_rule_gap']);
export const MUSIC_SCORE_WRITE_TOOLS = new Set(['set_chapter_music', 'set_chapter_music_cues']);
export const MUSIC_SCORE_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'get_chapter_timeline', description: '读本任务这一章的成片时间轴：按成片顺序列出每一镜在成片里的起止秒（已出片的镜按选用视频的实际时长算，和合成时 cue 表用的时间轴一致；还没出片的镜按计划时长算并标 planned）、场景、台词、旁白、画面摘要；以及本章现在的主曲和 cue 表。写 cue 的 start/end 就按这里的秒数。', parameters: { type: 'object', properties: {}, required: [] } } },
];
const EXTRA_NAMES = new Set(MUSIC_SCORE_EXTRA_TOOLS.map((t) => t.function.name));

export function isMusicScoreToolAllowed(name) { return MUSIC_SCORE_READ_TOOLS.has(name) || MUSIC_SCORE_WRITE_TOOLS.has(name) || EXTRA_NAMES.has(name); }
export function isMusicScoreExtraTool(name) { return EXTRA_NAMES.has(name); }
export function musicScoreToolDefinitions(allDefs) {
  return [...(allDefs || []).filter((t) => MUSIC_SCORE_READ_TOOLS.has(t.function.name) || MUSIC_SCORE_WRITE_TOOLS.has(t.function.name)), ...MUSIC_SCORE_EXTRA_TOOLS];
}

const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const parsePrompt = (ch) => { try { const p = JSON.parse((ch && ch.music_prompt) || '{}'); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } };

/** 本章成片时间轴（与 assemble_video 同口径：叙事顺序里 status=done 且有视频的镜依次拼接）。probe 可注入（测试用）。 */
// 承接上一镜 22 帧的镜：合成时剪掉开头 22 帧（lead-in.js），时间轴按剪后的时长算
export async function chapterTimeline(projectId, title, { probe = probeVideoInfo, leadOf = (s) => ShotVideos.leadInOfShot(s) } = {}) {
  const all = Shots.listInNarrativeOrder(projectId).filter((s) => s.chapter === title);
  const rows = []; let t = 0; let planned = 0;
  for (const s of all) {
    const has = s.status === 'done' && s.video_path;
    let dur = Number(s.duration) || 0; let measured = false;
    if (has) {
      try { const abs = resolveProjectPath(projectId, s.video_path); const info = abs ? await probe(abs) : null; if (info && info.duration > 0) { dur = Math.max(0, info.duration - (Number(leadOf(s)) || 0) / 24); measured = true; } } catch { /* 探测失败按计划时长 */ }
    }
    if (!has) planned++;
    const start = Math.round(t * 100) / 100; t += dur;
    rows.push({ idx: s.idx, shot_id: s.id, start, end: Math.round(t * 100) / 100, duration: Math.round(dur * 100) / 100, ...(has ? (measured ? {} : { duration_from: 'plan' }) : { planned: true }), scene: s.scene_name || '', dialogue: short(s.dialogue, 160), narration: short(s.narration, 80), visual: short(s.visual, 120) });
  }
  return { chapter: title, total: Math.round(t * 100) / 100, shots: rows, planned_shots: planned, note: planned ? '有 ' + planned + ' 镜还没出片，按计划时长占位；合成时只拼已出片的镜，这些镜之后的秒数会前移' : '全部按已出片的实际时长' };
}

// 本任务进程里读过哪些（技能 / 指南）：没读之前写配乐会被拒
const served = { skill: false, guide: false };
export function noteMusicScoreToolCall(name, args) {
  if (name === 'skill' && String(args && args.name) === MUSIC_SKILL) served.skill = true;
  if (name === 'skill_reference' && String(args && args.name) === MUSIC_SKILL && String(args && args.ref || '').includes('康康合集')) served.guide = true;
}
export function _resetMusicScoreServed() { served.skill = false; served.guide = false; }

/** 写工具前的检查 + 存档：只能写本任务这一章；先读技能和指南；写前把本章旧的主曲 / cue 表记进 music_score_history.jsonl。 */
export function guardMusicScoreWrite(ctx, name, args) {
  if (!MUSIC_SCORE_WRITE_TOOLS.has(name)) return args;
  if (!served.skill) throw new Error('先调用 skill(name="' + MUSIC_SKILL + '") 读配乐技能，再写配乐');
  if (!served.guide) throw new Error('先调用 skill_reference(name="' + MUSIC_SKILL + '", ref="' + MUSIC_GUIDE_REF + '") 读曲库指南，再写配乐');
  const want = String(ctx.chapter || '');
  const got = String((args && args.chapter) || '').trim();
  if (got && got !== want) {
    const ch = Chapters.list(ctx.projectId).find((c) => c.title === want);
    if (!ch || (got !== ch.id)) throw new Error('本任务只能给「' + want + '」配乐，不能写「' + got + '」');
  }
  const ch = Chapters.list(ctx.projectId).find((c) => c.title === want);
  if (!ch) throw new Error('章节不存在：' + want);
  const ok = appendProjectJsonl(projectDir(ctx.projectId), MUSIC_SCORE_HISTORY_FILE, { ts: Date.now(), job_id: ctx.jobId || '', chapter: want, action: name, music_path: ch.music_path || '', music_prompt: ch.music_prompt || '', args });
  if (!ok) throw new Error('写前存档失败（' + MUSIC_SCORE_HISTORY_FILE + '），不写');
  return { ...(args || {}), chapter: want };
}

export async function runMusicScoreExtraTool(ctx, name) {
  if (name === 'get_chapter_timeline') {
    const tl = await chapterTimeline(ctx.projectId, ctx.chapter);
    const ch = Chapters.list(ctx.projectId).find((c) => c.title === ctx.chapter);
    const p = parsePrompt(ch);
    return JSON.stringify({ ...tl, current_music: { music_path: (ch && ch.music_path) || '', caption: p.caption || '', music_id: p.music_id || '', music_name: p.music_name || '', cues: Array.isArray(p.cues) ? p.cues : [] } });
  }
  throw new Error('未知工具：' + name);
}

/** 本任务写过哪些配乐（读存档；任务收尾核对用）。 */
export function musicScoreWritesOfJob(projectId, jobId) {
  const out = [];
  try {
    const f = path.join(projectDir(projectId), MUSIC_SCORE_HISTORY_FILE);
    if (!fs.existsSync(f)) return out;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r.job_id === jobId) out.push(r); } catch {} }
  } catch {}
  return out;
}

export function buildMusicScoreAgentPrompt({ project, chapter, requirement }) {
  const title = String(chapter || '');
  return [
    '【IC「章节配乐」任务】你只做一件事：按配乐技能，给项目「' + ((project && project.name) || '') + '」的「' + title + '」重新配乐：选本章主曲，并按情绪段写 cue 表（哪里切曲、哪里静音），保存。',
    '【外部 Agent 运行时】你的领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    ...(requirement ? ['【导演这次的要求】' + String(requirement).trim()] : []),
    '步骤：',
    '1. skill(name="' + MUSIC_SKILL + '") 读配乐技能全文；再 skill_reference(name="' + MUSIC_SKILL + '", ref="' + MUSIC_GUIDE_REF + '") 读曲库指南（每首曲子的情绪、用途和编号）。两样都读完才能写，否则保存会被拒。',
    '2. get_chapter(chapter="' + title + '") 读本章剧本，理解剧情、人物关系和情绪走向。',
    '3. get_chapter_timeline 读成片时间轴：每镜在成片里的起止秒、台词、画面摘要，以及本章现在的主曲和 cue 表。',
    '4. 按技能把本章分成情绪段（情绪反差大的地方必须分段，不要一首曲子从头垫到尾）：每段定一首曲子或静音，段界落在镜头切点上（用时间轴里的秒数）。轻松斗嘴、日常段不要压苦情曲；对白密集或需要安静的地方按技能留静音。',
    '5. set_chapter_music(chapter, music_id, caption) 定主曲：caption 按「情绪类别：…｜选曲：NN｜曲名｜理由：…」写。',
    '6. set_chapter_music_cues(chapter, cues) 写 cue 表：每段 {start, end, music_id（曲库两位编号，或 "silence"）, fade_in, fade_out, note（这一段的情绪和理由）}；段与段不重叠；没写到的时间放主曲。保存被拒时按原因修改后重存。',
    '7. 最后用几句话总结：分了几段、每段放什么（或静音）、为什么。',
    '硬性要求：',
    '- 只从曲库现有曲子里选，不生成新曲；不合成、不出视频（这些工具本任务也不提供）。',
    '- 只能改「' + title + '」的配乐，不改分镜、台词、提示词、资产。',
    '- 拿不准时以技能和指南为准；技能里确实没写到的，自己判断并调用 report_rule_gap 登记。',
    '- 不要中途停下来提问，一直做到保存完成。',
  ].join('\n');
}
