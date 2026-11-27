// 资产分析任务（Andy 11-26「V3 不用从头再分析，但是要掌握这个技能，我们现在要迭代好系统」；adapt J-004 / J-009 / J-010）：
// 外部 Agent 的受限工具集 + 任务提示词。只读本项目原著和规则书，写地点表、戏份说明、缺图单；不出图、不出片、不改分镜。
// 被 runner.js（提示词、工具集名）和 mcp-server.mjs（工具过滤、专用工具）引用；任务提交在 asset-analyze.js。
import fs from 'node:fs';
import path from 'node:path';
import { Chapters, Assets, Projects, projectDir } from '../core/index.js';
import { getLocations, saveLocations } from '../core/locations.js';
import { listSceneNotes, getSceneNote, saveSceneNote } from '../core/scene-notes.js';
import { getGapList, mergeGapList, gapCoverage, renderGapListMd, createAssetSlots } from '../core/asset-gaps.js';
import { loadRuleIndex } from '../core/rule-book.js';
import { readSkillLines } from './skill-engine.js';

export const ASSET_ANALYZE_TOOLSET = 'asset-analyze';
export const ASSET_ANALYZE_SKILL = 'adapt-rules';
export const ASSET_ANALYZE_REFS = ['戏份说明模板.md', '戏份说明例_虚构.md'];
const READ_CHARS_MAX = 20000;

export const ASSET_ANALYZE_READ_TOOLS = new Set(['skill', 'skill_lines', 'skill_reference', 'get_project', 'report', 'report_rule_gap']);
export const ARCHIVED_ASSETS_KEY = 'archived_asset_ids';
const chArg = { type: 'integer' };
export const ASSET_ANALYZE_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'search_novel', description: '全书关键词检索本项目原著：返回命中的章号和所在句子（可限章节范围）。用地点名、人物名、区域词找某个地点的生命周期（第一次和最后一次真正出现在戏里的章）。读完规则才能用。', parameters: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } }, chapter_from: chArg, chapter_to: chArg, max_hits: { type: 'integer', description: '最多返回多少条命中句（缺省 200，上限 600）' } }, required: ['keywords'] } } },
  { type: 'function', function: { name: 'read_chapter_novel', description: '读本项目某一章的原著正文（按章号；长章可用 from / to 字符位置分段读，单次最多 20000 字）。只读生命周期内的相关章。读完规则才能用。', parameters: { type: 'object', properties: { chapter: { type: 'integer', description: '章号（第 N 章的 N）' }, from: { type: 'integer' }, to: { type: 'integer' } }, required: ['chapter'] } } },
  { type: 'function', function: { name: 'list_assets', description: '读本项目资产库（名字、类别、描述摘要、有没有图）。已归档的旧资产不列（不当已有定稿用）。', parameters: { type: 'object', properties: { category: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'get_locations', description: '读本项目地点表（地点 ID｜地点名｜生命周期首末章｜变体｜资产 ID）和存疑。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'save_locations', description: '保存本项目地点表（整份覆盖，旧版留档）。rows 每项 {id, name（全剧唯一写法）, aliases, first_chapter, last_chapter, kind（内景/外景…）, variants:[{name, asset_id, note}], asset_ids, note}；doubts 每项 {question, chapters, options}：拿不准是不是同一个地方的列这里，不自己拍板。', parameters: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } }, doubts: { type: 'array', items: { type: 'object' } } }, required: ['rows'] } } },
  { type: 'function', function: { name: 'list_scene_notes', description: '列出本项目已写的戏份说明（key、字数）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_scene_note', description: '读一份戏份说明（key = 地点 ID 或资产名）。', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'save_scene_note', description: '保存一份戏份说明（md，按戏份说明模板写：生命周期、逐章出场与引文、功能区、人数峰值、动线、规模口径〔原著明写 / 想象补写分开标〕、跨章状态、存疑、布局表）。key = 地点 ID（场景）或资产名（人物服装 / 道具）。覆盖时旧版留档。', parameters: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } } },
  { type: 'function', function: { name: 'save_gap_list', description: '更新本项目的完整缺图单（合并式：同名同类的行用这次的替换，没提到的旧行保留）。items 每项 {kind:scene|costume|prop|character, name, location_id, note_key（对应的戏份说明 key）, requirement（要画什么，引戏份说明和布局表）}；写了戏份说明但这次不出图的，也要列一行 {kind, name, note_key, need_image:false, reason}。voids：要作废的旧行 [{name, kind?, replaced_by（替代它的新行名称）, reason}]（比如旧口径的「光幕·不带可读文字」），作废后不留冲突行。保存后返回还没进缺图单的戏份说明 key，要补齐。会自动附 adapt J-009 原文，并另存一份当前缺图单.md。', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, voids: { type: 'array', items: { type: 'object' } }, note: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'create_asset_slots', description: '按缺图单给每条有效、要出图的行建 IC 资产槽（只建行，不出图）：人物 character；「角色名·…」的服装 / 状态变体（含系统的光幕版式）建成 costume 挂在角色下；场景、道具各自建。同名同类没归档的复用，已归档的不复用。缺图单每行写回 asset_id，地点表变体名对上的也写上。缺图单定稿后最后调一次。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_gap_list', description: '读本项目当前的完整缺图单（含已作废的行和覆盖检查）。', parameters: { type: 'object', properties: {}, required: [] } } },
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
    // 规则书过了单次 skill_lines 上限（4 万字）后整本读会抛错、被 catch 成空 → 缺图单写「没读到 J-009 原文」（总导 11-26）。分段读。
    const total = idx.total_lines || 2000; const parts = [];
    for (let a = 1; a <= total; a += 150) parts.push(readSkillLines(ASSET_ANALYZE_SKILL, a, Math.min(total, a + 149)).text.replace(/\n$/, ''));
    const full = parts.join('\n').split('\n');
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
  if (name === 'list_assets') {
    const arch = new Set(((Projects.get(ctx.projectId) || {}).context || {})[ARCHIVED_ASSETS_KEY] || []);
    const rows = Assets.list(ctx.projectId).filter((a) => !arch.has(a.id) && (!args.category || a.category === args.category))
      .map((a) => ({ id: a.id, name: a.name, category: a.category, parent_id: a.parent_id || '', has_image: !!a.image_path, description: String(a.description || '').slice(0, 200) }));
    return JSON.stringify({ assets: rows, archived_hidden: arch.size });
  }
  if (name === 'get_locations') return JSON.stringify(getLocations(ctx.projectId));
  if (name === 'save_locations') { const doc = saveLocations(ctx.projectId, args, { source: 'asset-analyze', job_id: ctx.jobId || '' }); served.writes++; return JSON.stringify({ saved: true, rows: doc.rows.length, doubts: doc.doubts.length }); }
  if (name === 'list_scene_notes') return JSON.stringify(listSceneNotes(ctx.projectId));
  if (name === 'get_scene_note') return JSON.stringify(getSceneNote(ctx.projectId, args.key) || { key: args.key, text: '', note: '还没有这份戏份说明' });
  if (name === 'save_scene_note') { const r = saveSceneNote(ctx.projectId, args.key, args.text); served.writes++; return JSON.stringify({ saved: true, ...r }); }
  if (name === 'create_asset_slots') {
    const arch = ((Projects.get(ctx.projectId) || {}).context || {})[ARCHIVED_ASSETS_KEY] || [];
    const r = createAssetSlots(ctx.projectId, { archivedIds: arch, jobId: ctx.jobId || '' });
    const md = renderGapListMd(r.doc, { title: '已建资产槽', j009: j009Text() });
    const d = path.join(projectDir(ctx.projectId), 'asset_gaps'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '当前缺图单.md'), md);
    served.writes++;
    return JSON.stringify({ created: r.created.length, reused: r.reused.length, skipped: r.skipped, location_variants_filled: r.location_variants_filled, created_list: r.created.slice(0, 80) });
  }
  if (name === 'get_gap_list') { const doc = getGapList(ctx.projectId); return JSON.stringify({ ...doc, coverage: gapCoverage(ctx.projectId, doc) }); }
  if (name === 'save_gap_list') {
    const items = (Array.isArray(args.items) ? args.items : []).filter((x) => x && typeof x === 'object');
    const voids = (Array.isArray(args.voids) ? args.voids : []).filter((x) => x && typeof x === 'object');
    if (!items.length && !voids.length) throw new Error('items 和 voids 都为空');
    const { doc, voided } = mergeGapList(ctx.projectId, { items, voids }, { job_id: ctx.jobId || '' });
    const md = renderGapListMd(doc, { title: args.note ? String(args.note).slice(0, 60) : '', j009: j009Text() });
    const d = path.join(projectDir(ctx.projectId), 'asset_gaps'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '当前缺图单.md'), md);
    const snap = path.join(d, 'asset_analyze_' + Date.now() + '.md');
    fs.writeFileSync(snap, md);
    served.writes++;
    const cov = gapCoverage(ctx.projectId, doc);
    const active = doc.items.filter((x) => x.status !== 'void');
    return JSON.stringify({ saved: true, merged: true, active: active.length, need_image: active.filter((x) => x.need_image !== false).length, voided, file: 'asset_gaps/当前缺图单.md',
      ...(cov.missing.length ? { missing_notes: cov.missing, missing_rule: '这些戏份说明还没进缺图单：要出图的补一行；不出图的列一行 need_image:false 和原因。再调一次 save_gap_list 补齐' } : { coverage: '全部戏份说明都已在缺图单里' }) });
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
    '先读规则（没读完不给原著）：skill(name="adapt-rules")（基础段里的 J-004 一个地点一套资产、J-009 出图与验收、J-010 场景按生命周期做、J-011 资产四问）；skill_reference(name="adapt-rules", ref="戏份说明模板.md")；skill_reference(name="adapt-rules", ref="戏份说明例_虚构.md")（虚构教学示例，只学格式和深度，内容一律从本项目原著里找）。',
    '流程（照 J-010）：',
    '1. 列出范围内的场景（地点）：先 search_novel 用地点、场所类词扫一遍范围内各章，列候选地点；每个地点用地点名、相关人物、区域词再检索全书，定生命周期（第一次和最后一次真正在戏里的章；只嘴上提到的不算；回忆、闪回单独标；同名但不是同一个地方的分开）。',
    '2. 只读生命周期内的相关章（read_chapter_novel），写场所需求分析进戏份说明（save_scene_note，key 用地点 ID）：逐章在这里发生了什么、用到哪些区域（附原著引文）；功能区清单；人数峰值；动线；规模和档次、时段昼夜、跨章状态变化。原著明写的和你想象补写的分开标（规模、尺寸、陈设数量这类原著没写的，标「想象补写」）。',
    '3. 定地点身份进地点表（save_locations）：同一家店、同一间办公室在不同章出现，是同一个地点 ID；原著明写是不同的店（例如「几处位置偏的店」），分开立。拿不准的写进 doubts，不自己拍板。每行：地点 ID｜地点名（全剧唯一写法）｜生命周期首末章｜内外景、门口、昼夜等变体｜对应的资产 ID（库里已有的才填，list_assets 看）。',
    '4. 一次定布局：在戏份说明里写布局表（生命周期内所有章要用的功能区放进同一张表）。',
    '5. 人物服装、道具也按各自生命周期追踪（服装状态、伤势、道具归属和数量），写进对应的戏份说明（key 用人物名·服装 或 道具名）。',
    '每份戏份说明（场景、人物、服装、道具）开头都先答 J-011 四问：① 生命周期（第几章到第几章，回忆单独标）；② 范围（场景：几个区域、人数峰值、相连空间；人物：和谁同场、在哪些地点；道具：数量、在谁手里、在哪些场景）；③ 功能（功能区和动线 / 要被拿、递、开合的动作 / 要演的动作——功能决定结构）；④ 状态（昼夜、换装、受伤、损毁、数量变化各几种）。按四问定大小和要出几张状态图，缺图单里写清每张状态图。',
    '6. 缺图单是一份合并的完整清单（get_gap_list 先看现有的）：save_gap_list 只传这次新增或改了的行，同名同类会替换旧行；旧口径要作废的行放进 voids（写原因），不留冲突行。写了戏份说明的资产都要进缺图单：要出图的写清要画什么、引哪份戏份说明（note_key）；不出图的列一行 need_image:false 和原因。保存后看返回的 missing_notes，补齐为止。',
    '7. 缺图单定稿后调 create_asset_slots 建资产槽（只建行不出图，缺图单每行写回 asset_id），看返回的 skipped 有没有该建没建的。',
    '8. 最后用几句话总结：分析了哪些地点（ID、首末章）、存疑几条、戏份说明几份、缺图几项、建了 / 复用了几个资产槽。',
    '硬性要求：不读项目外的文件；不出图、不出片、不改剧本 / 分镜 / 资产；拿不准的进存疑；规则里确实没写到的情况，自己判断并调用 report_rule_gap 登记；不要中途停下来提问，一直做到保存完成。',
  ].join('\n');
}
