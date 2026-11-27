// 资产分析任务（Andy 11-26「V3 不用从头再分析，但是要掌握这个技能，我们现在要迭代好系统」；adapt J-004 / J-009 / J-010）：
// 外部 Agent 的受限工具集 + 任务提示词。只读本项目原著和规则书，写地点表、戏份说明、缺图单；不出图、不出片、不改分镜。
// 被 runner.js（提示词、工具集名）和 mcp-server.mjs（工具过滤、专用工具）引用；任务提交在 asset-analyze.js。
import fs from 'node:fs';
import path from 'node:path';
import { Chapters, projectDir } from '../core/index.js';
import { getLocations, saveLocations } from '../core/locations.js';
import { listSceneNotes, getSceneNote, saveSceneNote } from '../core/scene-notes.js';
import { loadRuleIndex } from '../core/rule-book.js';
import { readSkillLines } from './skill-engine.js';

export const ASSET_ANALYZE_TOOLSET = 'asset-analyze';
export const ASSET_ANALYZE_SKILL = 'adapt-rules';
export const ASSET_ANALYZE_REFS = ['戏份说明模板.md', '戏份说明例_虚构.md'];
const READ_CHARS_MAX = 20000;

export const ASSET_ANALYZE_READ_TOOLS = new Set(['skill', 'skill_lines', 'skill_reference', 'get_project', 'list_assets', 'report', 'report_rule_gap']);
const chArg = { type: 'integer' };
export const ASSET_ANALYZE_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'search_novel', description: '全书关键词检索本项目原著：返回命中的章号和所在句子（可限章节范围）。用地点名、人物名、区域词找某个地点的生命周期（第一次和最后一次真正出现在戏里的章）。读完规则才能用。', parameters: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } }, chapter_from: chArg, chapter_to: chArg, max_hits: { type: 'integer', description: '最多返回多少条命中句（缺省 200，上限 600）' } }, required: ['keywords'] } } },
  { type: 'function', function: { name: 'read_chapter_novel', description: '读本项目某一章的原著正文（按章号；长章可用 from / to 字符位置分段读，单次最多 20000 字）。只读生命周期内的相关章。读完规则才能用。', parameters: { type: 'object', properties: { chapter: { type: 'integer', description: '章号（第 N 章的 N）' }, from: { type: 'integer' }, to: { type: 'integer' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'get_locations', description: '读本项目地点表（地点 ID｜地点名｜生命周期首末章｜变体｜资产 ID）和存疑。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'save_locations', description: '保存本项目地点表（整份覆盖，旧版留档）。rows 每项 {id, name（全剧唯一写法）, aliases, first_chapter, last_chapter, kind（内景/外景…）, variants:[{name, asset_id, note}], asset_ids, note}；doubts 每项 {question, chapters, options}：拿不准是不是同一个地方的列这里，不自己拍板。', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } }, doubts: { type: 'array', items: { type: 'object' } } }, required: ['rows'] } } },
  { type: 'function', function: { name: 'list_scene_notes', description: '列出本项目已写的戏份说明（key、字数）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_scene_note', description: '读一份戏份说明（key = 地点 ID 或资产名）。', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'save_scene_note', description: '保存一份戏份说明（md，按戏份说明模板写：生命周期、逐章出场与引文、功能区、人数峰值、动线、规模口径〔原著明写 / 想象补写分开标〕、跨章状态、存疑、布局表）。key = 地点 ID（场景）或资产名（人物服装 / 道具）。覆盖时旧版留档。', parameters: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } } },
  { type: 'function', function: { name: 'save_gap_list', description: '出缺图单（派 am 出图用）：每项 {kind:scene|costume|prop|character, name, location_id, requirement（要画什么，引戏份说明和布局表）}。保存时自动附上 adapt J-009 资产图生成与验收标准原文。', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: ['items'] } } },
];
const EXTRA_NAMES = new Set(ASSET_ANALYZE_EXTRA_TOOLS.map((t) => t.function.name));
const NEED_RULES = new Set(['search_novel', 'read_chapter_novel']);
const WRITE_TOOLS = new Set(['save_locations', 'save_scene_note', 'save_gap_list']);

export function isAssetAnalyzeToolAllowed(name) { return ASSET_ANALYZE_READ_TOOLS.has(name) || EXTRA_NAMES.has(name); }
export function isAssetAnalyzeExtraTool(name) { return EXTRA_NAMES.has(name); }
export function assetAnalyzeToolDefinitions(allDefs) {
  return [...(allDefs || []).filter((t) => ASSET_ANALYZE_READ_TOOLS.has(t.function.name)), ...ASSET_ANALYZE_EXTRA_TOOLS];
}

// 本任务进程里读过的规则：skill(adapt-rules)（基础段含 J-004 / J-009 / J-010）+ 两份参考文件。没读完不给原著。
const served = { skill: false, refs: new Set(), writes: 0 };
export function noteAssetAnalyzeToolCall(name, args) {
  const a = args || {};
  if (name === 'skill' && String(a.name || '').trim() === ASSET_ANALYZE_SKILL) served.skill = true;
  if (name === 'skill_reference' && String(a.name || '').trim() === ASSET_ANALYZE_SKILL && ASSET_ANALYZE_REFS.includes(String(a.ref || ''))) served.refs.add(String(a.ref));
}
export function _resetAssetAnalyzeServed() { served.skill = false; served.refs = new Set(); served.writes = 0; }
export function assetAnalyzeRulesMissing() {
  const out = [];
  if (!served.skill) out.push('skill(name="' + ASSET_ANALYZE_SKILL + '")（基础段里有 J-004、J-009、J-010）');
  for (const r of ASSET_ANALYZE_REFS) if (!served.refs.has(r)) out.push('skill_reference(name="' + ASSET_ANALYZE_SKILL + '", ref="' + r + '")');
  return out;
}

const chapterNo = (c) => { const m = String(c.title || '').match(/第\s*(\d+)\s*章/); return m ? Number(m[1]) : Number(c.seq) || 0; };
function chaptersOf(projectId) { return Chapters.list(projectId).map((c) => ({ ...c, no: chapterNo(c) })).sort((a, b) => a.no - b.no); }

/** J-009 原文（缺图单附带）：adapt-rules 规则全文里 〔J-009〕 那一节。 */
export function j009Text() {
  try {
    const idx = loadRuleIndex(ASSET_ANALYZE_SKILL);
    if (!idx) return '';
    const full = readSkillLines(ASSET_ANALYZE_SKILL, 1, idx.total_lines || 2000).text.split('\n');
    const i = full.findIndex((l) => /^###\s*〔J-009〕/.test(l));
    if (i < 0) return '';
    let j = i + 1; while (j < full.length && !/^###\s|^##\s/.test(full[j])) j++;
    return full.slice(i, j).join('\n').trim();
  } catch { return ''; }
}

export async function runAssetAnalyzeExtraTool(ctx, name, args = {}) {
  if (NEED_RULES.has(name)) {
    const miss = assetAnalyzeRulesMissing();
    if (miss.length) throw new Error('先读规则再读原著。还没读：' + miss.join('、'));
  }
  const range = ctx.chapterRange || null;
  if (name === 'search_novel') {
    const kws = (Array.isArray(args.keywords) ? args.keywords : [args.keywords]).map((k) => String(k || '').trim()).filter(Boolean);
    if (!kws.length) throw new Error('keywords 为空');
    const from = Number(args.chapter_from) || 0; const to = Number(args.chapter_to) || 0;
    const max = Math.min(600, Math.max(1, Number(args.max_hits) || 200));
    const hits = []; const perChapter = {};
    for (const c of chaptersOf(ctx.projectId)) {
      if ((from && c.no < from) || (to && c.no > to)) continue;
      const sentences = String(c.novel || '').split(/(?<=[。！？!?…\n])/);
      for (const s of sentences) {
        const hit = kws.filter((k) => s.includes(k));
        if (!hit.length) continue;
        perChapter[c.no] = (perChapter[c.no] || 0) + 1;
        if (hits.length < max) hits.push({ chapter: c.no, keywords: hit, sentence: s.trim().slice(0, 160) });
      }
    }
    const chs = Object.keys(perChapter).map(Number).sort((a, b) => a - b);
    return JSON.stringify({ keywords: kws, chapters_hit: chs, first_chapter: chs[0] || null, last_chapter: chs[chs.length - 1] || null, per_chapter: perChapter, hits, truncated: Object.values(perChapter).reduce((a, b) => a + b, 0) > hits.length });
  }
  if (name === 'read_chapter_novel') {
    const no = Number(args.chapter);
    const c = chaptersOf(ctx.projectId).find((x) => x.no === no);
    if (!c) throw new Error('没有第 ' + no + ' 章');
    const text = String(c.novel || '');
    const from = Math.max(0, Number(args.from) || 0);
    const to = Math.min(text.length, Number(args.to) || from + READ_CHARS_MAX, from + READ_CHARS_MAX);
    return JSON.stringify({ chapter: no, title: c.title, chars: text.length, from, to, text: text.slice(from, to), ...(to < text.length ? { more: '还有 ' + (text.length - to) + ' 字，用 from=' + to + ' 接着读' } : {}), ...(range && (no < range[0] || no > range[1]) ? { note: '本章在本次分析范围（第 ' + range[0] + '–' + range[1] + ' 章）之外：只在确认生命周期时读' } : {}) });
  }
  if (name === 'get_locations') return JSON.stringify(getLocations(ctx.projectId));
  if (name === 'save_locations') { const doc = saveLocations(ctx.projectId, args, { source: 'asset-analyze', job_id: ctx.jobId || '' }); served.writes++; return JSON.stringify({ saved: true, rows: doc.rows.length, doubts: doc.doubts.length }); }
  if (name === 'list_scene_notes') return JSON.stringify(listSceneNotes(ctx.projectId));
  if (name === 'get_scene_note') return JSON.stringify(getSceneNote(ctx.projectId, args.key) || { key: args.key, text: '', note: '还没有这份戏份说明' });
  if (name === 'save_scene_note') { const r = saveSceneNote(ctx.projectId, args.key, args.text); served.writes++; return JSON.stringify({ saved: true, ...r }); }
  if (name === 'save_gap_list') {
    const items = (Array.isArray(args.items) ? args.items : []).filter((x) => x && typeof x === 'object');
    if (!items.length) throw new Error('items 为空');
    const lines = ['# 缺图单（资产分析任务 ' + String(ctx.jobId || '').slice(0, 8) + '，' + new Date().toISOString() + '）', '', ...(args.note ? [String(args.note), ''] : []), '| # | 类别 | 名称 | 地点 ID | 要画什么 |', '|---|---|---|---|---|',
      ...items.map((x, i) => '| ' + (i + 1) + ' | ' + String(x.kind || '') + ' | ' + String(x.name || '') + ' | ' + String(x.location_id || '') + ' | ' + String(x.requirement || '').replace(/\n/g, ' ') + ' |'),
      '', '---', '', '## 出图与验收标准（adapt J-009 原文）', '', j009Text() || '（没读到 J-009 原文）'];
    const d = path.join(projectDir(ctx.projectId), 'asset_gaps'); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'asset_analyze_' + Date.now() + '.md');
    fs.writeFileSync(f, lines.join('\n'));
    served.writes++;
    return JSON.stringify({ saved: true, items: items.length, file: path.relative(projectDir(ctx.projectId), f).replace(/\\/g, '/') });
  }
  throw new Error('未知工具：' + name);
}

export function assetAnalyzeWriteCount() { return served.writes; }

export function buildAssetAnalyzeAgentPrompt({ project, range, requirement }) {
  const r = range ? '第 ' + range[0] + '–' + range[1] + ' 章' : '全书';
  return [
    '【IC「资产分析」任务】给项目「' + ((project && project.name) || '') + '」做资产分析，范围：' + r + '。只做分析和登记：地点表、戏份说明、缺图单。不出图、不出片、不改剧本和分镜。',
    '【外部 Agent 运行时】领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具；只读本项目原著（search_novel / read_chapter_novel）和规则书，不读项目外的任何文件。',
    ...(requirement ? ['【这次的要求】' + String(requirement).trim()] : []),
    '先读规则（没读完不给原著）：skill(name="adapt-rules")（基础段里的 J-004 一个地点一套资产、J-009 出图与验收、J-010 场景按生命周期做）；skill_reference(name="adapt-rules", ref="戏份说明模板.md")；skill_reference(name="adapt-rules", ref="戏份说明例_虚构.md")（虚构教学示例，只学格式和深度，内容一律从本项目原著里找）。',
    '流程（照 J-010）：',
    '1. 列出范围内的场景（地点）：先 search_novel 用地点、场所类词扫一遍范围内各章，列候选地点；每个地点用地点名、相关人物、区域词再检索全书，定生命周期（第一次和最后一次真正在戏里的章；只嘴上提到的不算；回忆、闪回单独标；同名但不是同一个地方的分开）。',
    '2. 只读生命周期内的相关章（read_chapter_novel），写场所需求分析进戏份说明（save_scene_note，key 用地点 ID）：逐章在这里发生了什么、用到哪些区域（附原著引文）；功能区清单；人数峰值；动线；规模和档次、时段昼夜、跨章状态变化。原著明写的和你想象补写的分开标（规模、尺寸、陈设数量这类原著没写的，标「想象补写」）。',
    '3. 定地点身份进地点表（save_locations）：同一家店、同一间办公室在不同章出现，是同一个地点 ID；原著明写是不同的店（例如「几处位置偏的店」），分开立。拿不准的写进 doubts，不自己拍板。每行：地点 ID｜地点名（全剧唯一写法）｜生命周期首末章｜内外景、门口、昼夜等变体｜对应的资产 ID（库里已有的才填，list_assets 看）。',
    '4. 一次定布局：在戏份说明里写布局表（生命周期内所有章要用的功能区放进同一张表）。',
    '5. 人物服装、道具也按各自生命周期追踪（服装状态、伤势、道具归属和数量），写进对应的戏份说明（key 用人物名·服装 或 道具名）。',
    '6. 库里没有、要出图的，save_gap_list 出缺图单（会自动附 J-009 标准原文），写清要画什么、引哪份戏份说明。',
    '7. 最后用几句话总结：分析了哪些地点（ID、首末章）、存疑几条、戏份说明几份、缺图几项。',
    '硬性要求：不读项目外的文件；不出图、不出片、不改剧本 / 分镜 / 资产；拿不准的进存疑；规则里确实没写到的情况，自己判断并调用 report_rule_gap 登记；不要中途停下来提问，一直做到保存完成。',
  ].join('\n');
}
