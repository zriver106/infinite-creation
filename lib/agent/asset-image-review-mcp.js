// 资产图审图 Agent 的受限工具集（总导 11-26：资产出图收回 IC，审图按手册 12 逐件对照）。
// 只读：本轮回图、已审过的格、前作底图、缺图单这一行、戏份说明、地点表、画风样张、审图技能；唯一写入是 submit_review（结论落文件，由 IC 接着写回或退回）。
// 必核项写在 submit_review 的结构里（不只在技能正文）：同一空间逐件对照、画风对比样张、人种长相、对照底图、数量和朝向、不带文字。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, projectDir } from '../core/index.js';
import { getGapList } from '../core/asset-gaps.js';
import { getLocations } from '../core/locations.js';
import { getSceneNote } from '../core/scene-notes.js';
import { viewReferenceAsset, imagePayload } from '../core/reference-assets.js';
import { roundsDir } from '../core/asset-image-work.js';
import { styleWithAnchor } from '../shared/index.js';
import { skillDir } from './skill-engine.js';

export const ASSET_IMAGE_REVIEW_TOOLSET = 'asset-image-review';
export const ASSET_IMAGE_SKILL = 'asset-image';
export const REVIEW_READ_TOOLS = new Set(['skill', 'skill_lines', 'skill_reference', 'report', 'report_rule_gap']);
export const REVIEW_CHECKS = {
  same_space: '同一空间逐件对照（_MV 的 B/C/D 和已审过的 A 是同一个空间：物件、位置、朝向、装潢、光线；非 _MV 填 na）',
  style_vs_sample: '画风对比样张（照片级写实；没有动漫、插画、描边、柔光雾化、塑料皮肤；窗外门外不是日本街景）',
  ethnicity: '人种长相（人物、人群一律中国人长相、当代中国城市普通市民穿着；画面里没有人填 na）',
  base_image: '对照底图（有 base_ref 的：长相 / 空间 / 款式照底图；没有底图填 na）',
  count_orientation: '数量和朝向（物件、人数、座位朝向、机位方向和缺图单 / 布局表一致；朝北看东在右手）',
  no_text: '不带文字（图上没有字幕、标注、水印、乱码；UI 母版的字逐字照缺图单）',
};

export const REVIEW_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'get_review_context', description: '本次要审的是哪个资产、哪一格、第几轮；缺图单这一行（出图要求、底图 base_ref）、戏份说明、地点表行、画风段、以前各轮的退回意见、必核项清单。先调它。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_candidate', description: '看本轮 am 交回的图。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_approved', description: '看本资产已审过的格（_MV 审 B/C/D 时对照 A；step 填 A/B/C）。', parameters: { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] } } },
  { type: 'function', function: { name: 'view_reference_asset', description: '只读看前作（登记过的参考项目，如 V2）的定稿底图：按 asset_id 或编号前缀。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, name: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'view_style_sample', description: '看画风样张（asset-image 技能 resources/画风样张 下）；不传 name 列出全部。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'submit_review', description: '交审图结论（只交一次）。checks 六项都要填：ok=true 过、false 不过、"na" 不适用（只能用在说明里允许 na 的项）。任一项 false 就只能 verdict=return，并写 return_note（给 am 的退回意见：哪一处、照什么改；左右先写清机位朝向）。_MV 和有多件陈设的图要填 checklist 逐件对照表（件、应为、图里、ok）。', parameters: { type: 'object', properties: {
    verdict: { type: 'string', enum: ['pass', 'return'] },
    checks: { type: 'object', properties: Object.fromEntries(Object.entries(REVIEW_CHECKS).map(([k, d]) => [k, { type: 'object', description: d, properties: { ok: {}, note: { type: 'string' } }, required: ['ok', 'note'] }])), required: Object.keys(REVIEW_CHECKS) },
    checklist: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, expected: { type: 'string' }, seen: { type: 'string' }, ok: { type: 'boolean' } }, required: ['item', 'expected', 'seen', 'ok'] } },
    return_note: { type: 'string' },
  }, required: ['verdict', 'checks'] } } },
];
const EXTRA = new Set(REVIEW_EXTRA_TOOLS.map((t) => t.function.name));
export const isReviewToolAllowed = (n) => REVIEW_READ_TOOLS.has(n) || EXTRA.has(n);
export const isReviewExtraTool = (n) => EXTRA.has(n);
export const reviewToolDefinitions = (allDefs) => [...(allDefs || []).filter((t) => REVIEW_READ_TOOLS.has(t.function.name)), ...REVIEW_EXTRA_TOOLS];

/** 审图任务的上下文：从任务 checkpoint 读（派单时写好：asset_id、step、round、file、approved）。 */
export function reviewCtxOf(jobId) {
  const j = Jobs.get(jobId); const cp = (j && j.checkpoint) || {};
  if (!cp.asset_id || !cp.file) throw new Error('审图任务缺上下文（asset_id / file）');
  return cp;
}

/** 校验结论：六项都填；有不过的不能 pass；_MV 非 A 格 same_space 不能 na；return 要写意见。返回错误文字（空 = 合格）。 */
export function validateReview(r, { step = 'main', isMv = false } = {}) {
  if (!r || !['pass', 'return'].includes(r.verdict)) return 'verdict 只能是 pass 或 return';
  const c = r.checks || {};
  for (const k of Object.keys(REVIEW_CHECKS)) {
    if (!c[k] || !('ok' in c[k])) return 'checks.' + k + ' 没填（' + REVIEW_CHECKS[k] + '）';
    if (![true, false, 'na'].includes(c[k].ok)) return 'checks.' + k + '.ok 只能是 true / false / "na"';
    if (!String(c[k].note || '').trim()) return 'checks.' + k + '.note 要写看到了什么';
  }
  if (isMv && step !== 'A' && c.same_space.ok === 'na') return '_MV 的 ' + step + ' 格要和 A 逐件对照，same_space 不能填 na';
  if (c.no_text.ok === 'na' || c.style_vs_sample.ok === 'na' || c.count_orientation.ok === 'na') return 'style_vs_sample / count_orientation / no_text 每张都要核，不能填 na';
  const bad = Object.keys(REVIEW_CHECKS).filter((k) => c[k].ok === false).concat((r.checklist || []).filter((x) => x && x.ok === false).map((x) => '对照表：' + x.item));
  if (r.verdict === 'pass' && bad.length) return '有不过的项（' + bad.join('、') + '），verdict 只能是 return';
  if (isMv && (!Array.isArray(r.checklist) || !r.checklist.length)) return '_MV 要填 checklist 逐件对照表';
  if (r.verdict === 'return' && !String(r.return_note || '').trim()) return 'return 要写 return_note（退回意见）';
  return '';
}

export const reviewResultPath = (projectId, cp) => path.join(roundsDir(projectId, cp.asset_id), 'review_' + cp.step + '_r' + cp.round + '.json');

function img(abs, meta) {
  if (!abs || !fs.existsSync(abs)) return JSON.stringify({ ...meta, note: '图文件不在：' + abs });
  const p = imagePayload(abs);
  return p ? { text: JSON.stringify(meta), images: [p] } : JSON.stringify({ ...meta, note: '图太大没附上' });
}

export async function runReviewExtraTool(ctx, name, args = {}) {
  const cp = reviewCtxOf(ctx.jobId);
  const pid = ctx.projectId;
  const row = (getGapList(pid).items || []).find((x) => x.asset_id === cp.asset_id) || { name: cp.name };
  const isMv = /_MV/.test(String(row.name || ''));
  if (name === 'get_review_context') {
    const loc = row.location_id ? (getLocations(pid).rows || []).find((r) => r.id === row.location_id) || null : null;
    const note = row.note_key ? (getSceneNote(pid, row.note_key) || {}).text || '' : '';
    const style = (Projects.get(pid) || {}).style || '';
    return JSON.stringify({ asset_id: cp.asset_id, name: row.name, kind: row.kind, step: cp.step, round: cp.round, is_mv: isMv,
      requirement: row.requirement || '', base_ref: row.base_ref || null, approved_steps: Object.keys(cp.approved || {}),
      previous_returns: cp.previous_returns || [], location: loc, scene_note: note.slice(0, 8000),
      style: { scene: styleWithAnchor(style, 'scene'), character: styleWithAnchor(style, 'character'), prop: styleWithAnchor(style, 'prop'), people: '中国人长相，当代中国城市普通市民穿着' },
      checks_required: REVIEW_CHECKS });
  }
  if (name === 'view_candidate') return img(cp.file, { asset: row.name, step: cp.step, round: cp.round, file: path.basename(cp.file) });
  if (name === 'view_approved') {
    const f = (cp.approved || {})[String(args.step || '').toUpperCase()];
    return f ? img(f, { asset: row.name, step: args.step, approved: true }) : JSON.stringify({ note: '没有已审过的 ' + args.step + ' 格' });
  }
  if (name === 'view_reference_asset') {
    const r = viewReferenceAsset(pid, { asset_id: args.asset_id || (row.base_ref || {}).asset_id, name: args.name });
    return r && r.images ? r : JSON.stringify(r);
  }
  if (name === 'view_style_sample') {
    let dir = ''; try { dir = path.join(skillDir(ASSET_IMAGE_SKILL), 'resources', '画风样张'); } catch { /* 没装技能 */ }
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
    if (!args.name) return JSON.stringify({ samples: files, note: files.length ? '' : '还没有画风样张（asset-image 技能 resources/画风样张）' });
    const f = files.find((x) => x === args.name || x.startsWith(args.name));
    return f ? img(path.join(dir, f), { sample: f }) : JSON.stringify({ note: '没有样张 ' + args.name, samples: files });
  }
  if (name === 'submit_review') {
    const err = validateReview(args, { step: cp.step, isMv });
    if (err) throw new Error('结论不合格：' + err);
    const out = reviewResultPath(pid, cp);
    if (fs.existsSync(out)) throw new Error('本轮已经交过结论了');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...args, asset_id: cp.asset_id, step: cp.step, round: cp.round, job_id: ctx.jobId, at: Date.now() }, null, 2));
    return JSON.stringify({ saved: true, verdict: args.verdict });
  }
  throw new Error('未知工具 ' + name);
}

export function buildReviewAgentPrompt({ project, cp }) {
  return [
    '【IC「资产审图」任务】项目「' + ((project && project.name) || '') + '」：审 am 交回的「' + (cp.name || '') + '」' + (cp.step !== 'main' ? cp.step + ' 格' : '') + ' 第 ' + cp.round + ' 轮。只审不画，不改任何资产。',
    '【外部 Agent 运行时】领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ 前缀。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 读审图规则：skill(name="' + ASSET_IMAGE_SKILL + '")（资产出图与审图：画风、底图、_MV 三步法、逐件对照表、审图口径、常见错误）。',
    '2. get_review_context 看出图要求、底图、戏份说明、地点表、以前的退回意见和必核项。',
    '3. view_candidate 看本轮回图；有底图的 view_reference_asset 并排看；_MV 的 B/C/D 用 view_approved 对照 A；画风拿 view_style_sample 的样张比。',
    '4. 逐项核六个必核项，_MV 和多件陈设的逐件填对照表。一项不符就退回；左右先写清机位朝向（朝北看东在右手，朝南看东在左手），不要给错方向。',
    '5. submit_review 交结论（只交一次）。过了 IC 会写回原资产；退回会把 return_note 原样发给 am 返修。',
  ].join('\n');
}
