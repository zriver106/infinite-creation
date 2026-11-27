// 资产图审图 Agent 的受限工具集（总导 11-26：资产出图收回 IC，审图按手册 12 逐件对照）。
// 只读：本轮回图、已审过的格、前作底图、缺图单这一行、戏份说明、地点表、画风样张、审图技能；唯一写入是 submit_review（结论落文件，由 IC 接着写回或退回）。
// 必核项写在 submit_review 的结构里（不只在技能正文）：同一空间逐件对照、画风对比样张、人种长相、对照底图、数量和朝向、不带文字。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs, Projects, Assets, projectDir } from '../core/index.js';
import { getGapList, STYLE_SAMPLES } from '../core/asset-gaps.js';
import { getLocations } from '../core/locations.js';
import { getSceneNote } from '../core/scene-notes.js';
import { viewReferenceAsset, imagePayload } from '../core/reference-assets.js';
import { roundsDir, baseRefAbs, importedApprovedOf, cellImage } from '../core/asset-image-work.js';
import { styleWithAnchor } from '../shared/index.js';
import { skillDir } from './skill-engine.js';
import { j2Hint } from './asset-analyze-mcp.js';

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
  color_temp: '色温一致（同地点、同层的几张图色温、光线方向一致：拿同地点已定稿的 _MV / 阶段变体并排比；非场景填 na）',
  appearance_vs_desc: '人物外形逐项核（人物、服装、年龄图）：年龄段、体型、发型和发际线、各件衣服的颜色，任一项对不上就不过。依据：描述已照图或照原著更新过的，按资产描述逐项核；挂了底图、图生图出来的人物，核图和原著明写项、和底图对不对得上，不拿旧描述卡（描述和图 / 原著冲突的，在 note 里写明描述要改）；不是人物、服装、年龄图填 na',
};
export const PERSON_KINDS = new Set(['character', 'costume', 'age']);

export const REVIEW_EXTRA_TOOLS = [
  { type: 'function', function: { name: 'get_review_context', description: '本次要审的是哪个资产、哪一格、第几轮；缺图单这一行（出图要求、底图 base_ref）、戏份说明、地点表行、画风段、以前各轮的退回意见、必核项清单。先调它。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_candidate', description: '看本轮 am 交回的图。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_approved', description: '看本资产已审过的格（_MV 审 B/C/D 时对照 A；step 填 A/B/C）。', parameters: { type: 'object', properties: { step: { type: 'string' } }, required: ['step'] } } },
  { type: 'function', function: { name: 'view_reference_asset', description: '只读看前作（登记过的参考项目，如 V2）的定稿底图：按 asset_id 或编号前缀。', parameters: { type: 'object', properties: { asset_id: { type: 'string' }, name: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'view_style_sample', description: '看画风样张（asset-image 技能 resources/画风样张 下）；不传 name 列出全部。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'submit_review', description: '交审图结论（只交一次）。checks 六项都要填：ok=true 过、false 不过、"na" 不适用（只能用在说明里允许 na 的项）。任一项 false 就只能 verdict=return，并写 return_note（给 am 的退回意见：哪一处、照什么改；左右先写清机位朝向）。_MV 和有多件陈设的图要填 checklist 逐件对照表（件、应为、图里、ok）。', parameters: { type: 'object', properties: {
    verdict: { type: 'string', enum: ['pass', 'return', 'needs_human'] },
    checks: { type: 'object', properties: Object.fromEntries(Object.entries(REVIEW_CHECKS).map(([k, d]) => [k, { type: 'object', description: d, properties: { ok: {}, note: { type: 'string' } }, required: ['ok', 'note'] }])), required: Object.keys(REVIEW_CHECKS) },
    checklist: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, expected: { type: 'string' }, seen: { type: 'string' }, ok: { type: 'boolean' } }, required: ['item', 'expected', 'seen', 'ok'] } },
    return_note: { type: 'string' },
    redo_step: { type: 'string', enum: ['A', 'B', 'C', 'D', 'main'], description: '重审退回时填：要重出的那一格（_MV 填 A/B/C/D，单张填 main）' },
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
export function validateReview(r, { step = 'main', isMv = false, isScene = false, hasBase = false, rereview = false, isPerson = false } = {}) {
  if (!r || !['pass', 'return', 'needs_human'].includes(r.verdict)) return 'verdict 只能是 pass、return 或 needs_human';
  if (r.verdict === 'needs_human') return String(r.return_note || '').trim() ? '' : 'needs_human 要在 return_note 写清为什么要人看（例如取不到底图）';
  const c = r.checks || {};
  for (const k of Object.keys(REVIEW_CHECKS)) {
    if (!c[k] || !('ok' in c[k])) return 'checks.' + k + ' 没填（' + REVIEW_CHECKS[k] + '）';
    if (![true, false, 'na'].includes(c[k].ok)) return 'checks.' + k + '.ok 只能是 true / false / "na"';
    if (!String(c[k].note || '').trim()) return 'checks.' + k + '.note 要写看到了什么';
  }
  if (isMv && step !== 'A' && c.same_space.ok === 'na') return '_MV 的 ' + step + ' 格要和 A 逐件对照，same_space 不能填 na';
  // 总导 11-26：场景（阶段变体、_MV 非 A 格）要对同一空间、对底图，不能填 na；挂了底图的都要对底图。取不到底图就交 needs_human，别判过
  if (isScene && hasBase && !(isMv && step === 'A') && c.same_space.ok === 'na') return '场景图要和底图（同地点 _MV 的 A 格）逐件对同一空间，same_space 不能填 na；取不到底图交 needs_human';
  // 总导 11-26（韩志成·上班装：描述三十七八岁略发福后梳深灰裤，图上约三十偏瘦侧分藏青裤，出片像江澈同龄人）：人物、服装图外形逐项核，不能 na
  if (isPerson && c.appearance_vs_desc.ok === 'na') return '人物、服装、年龄图要逐项核年龄段、体型、发型和发际线、各件衣服颜色，appearance_vs_desc 不能填 na';
  if (isScene && c.color_temp.ok === 'na') return '场景图要和同地点、同层已定稿的图核色温一致，color_temp 不能填 na';
  if (isMv && step === 'compose' && (!Array.isArray(r.checklist) || r.checklist.length < 3)) return '拼板核对要逐件填 checklist（至少写 D 和 A/B/C 的关键物件：门、窗、饮水机这类方位，有没有幕墙，机位标注是不是本张的）';
  // 没登记参考项目、也没有本项目底图的新剧（Andy 11-26：借用 V2 只是加速，从零也要跑通）：没有底图时 base_image 可以 na；有底图就必须对
  if (hasBase && c.base_image.ok === 'na') return '这一行有底图要对，base_image 不能填 na；取不到底图交 needs_human';
  if (c.no_text.ok === 'na' || c.style_vs_sample.ok === 'na' || c.count_orientation.ok === 'na') return 'style_vs_sample / count_orientation / no_text 每张都要核，不能填 na';
  const bad = Object.keys(REVIEW_CHECKS).filter((k) => c[k].ok === false).concat((r.checklist || []).filter((x) => x && x.ok === false).map((x) => '对照表：' + x.item));
  if (r.verdict === 'pass' && bad.length) return '有不过的项（' + bad.join('、') + '），verdict 只能是 return';
  if (isMv && (!Array.isArray(r.checklist) || !r.checklist.length)) return '_MV 要填 checklist 逐件对照表';
  if (r.verdict === 'return' && !String(r.return_note || '').trim()) return 'return 要写 return_note（退回意见）';
  if (rereview && isMv && r.verdict === 'return' && !['A', 'B', 'C', 'D'].includes(String(r.redo_step || '').toUpperCase())) return '重审 _MV 退回要填 redo_step（要重出哪一格：A/B/C/D）';
  return '';
}

// 重审（总导 11-26）的结论另存 review_rereview<N>_<格>.json，不覆盖原来那轮的审图记录
export const reviewResultPath = (projectId, cp) => path.join(roundsDir(projectId, cp.asset_id), cp.rereview ? 'review_rereview' + cp.rereview + '_' + cp.step + '.json' : 'review_' + cp.step + '_r' + cp.round + '.json');

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
    return JSON.stringify({ asset_id: cp.asset_id, name: row.name, kind: row.kind, step: cp.step, round: cp.round, is_mv: isMv, rereview: cp.rereview || 0,
      requirement: row.requirement || '', base_ref: row.base_ref || null, asset_description: personDesc(cp.asset_id), approved_steps: Object.keys(cp.approved || {}),
      previous_returns: cp.previous_returns || [], location: loc, scene_note: note.slice(0, 8000),
      style: { scene: styleWithAnchor(style, 'scene'), character: styleWithAnchor(style, 'character'), prop: styleWithAnchor(style, 'prop'), people: '中国人长相，当代中国城市普通市民穿着' },
      checks_required: REVIEW_CHECKS });
  }
  if (name === 'view_candidate') return img(cp.file, { asset: row.name, step: cp.step, round: cp.round, file: path.basename(cp.file) });
  if (name === 'view_approved') {
    const st = String(args.step || '').toUpperCase();
    let f = (cp.approved || {})[st];
    let src = 'IC 审图';
    if (!f) { const imp = importedApprovedOf(pid, cp.asset_id); if (imp) { f = cellImage(pid, cp.asset_id, imp.abs, st, row.name); src = imp.source; } }
    return f ? img(f, { asset: row.name, step: st, approved: true, source: src }) : JSON.stringify({ note: '没有已审过的 ' + st + ' 格' });
  }
  if (name === 'view_reference_asset') {
    const base = row.base_ref || null;
    // 底图是本项目的（V3 定稿 _MV 的 A 格等）：直接看本项目的图，按格裁
    if (base && base.project_id === pid && (!args.asset_id || args.asset_id === base.asset_id) && !args.name) {
      const abs = baseRefAbs(pid, base);
      return abs ? img(abs, { base: base.name, cell: base.cell || '', own: true }) : JSON.stringify({ found: 0, note: '底图「' + base.name + '」在本项目里还没有图：取不到底图，交 needs_human' });
    }
    const r = viewReferenceAsset(pid, { asset_id: args.asset_id || (base || {}).asset_id, name: args.name });
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
    const err = validateReview(args, { step: cp.step, isMv, isScene: row.kind === 'scene', hasBase: !!row.base_ref, rereview: !!cp.rereview, isPerson: PERSON_KINDS.has(row.kind) });
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
    '【IC「资产审图」任务】项目「' + ((project && project.name) || '') + '」：' + (cp.rereview ? '重审已经写回资产的「' + (cp.name || '') + '」（第 ' + cp.rereview + ' 次重审）' : '审 am 交回的「' + (cp.name || '') + '」' + (cp.step !== 'main' ? cp.step + ' 格' : '') + ' 第 ' + cp.round + ' 轮') + '。只审不画，不改任何资产。',
    '【外部 Agent 运行时】领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ 前缀。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. 读审图规则：skill(name="' + ASSET_IMAGE_SKILL + '")（资产出图与审图：①画风与人 ②底图 ③_MV 三步法 ④逐件对照表 ⑤审图口径 ⑥常见错误）；规则依据读 adapt-rules 的 J2「资产制作」分卷：' + (j2Hint() || 'skill_lines 按地图读 J2') + '。',
    '2. get_review_context 看出图要求、底图、戏份说明、地点表、以前的退回意见和必核项。',
    '3. view_candidate 看本轮回图；有底图的 view_reference_asset 并排看；_MV 的 B/C/D 用 view_approved 对照 A；画风拿前作定稿样张比：view_reference_asset 取场景 ' + STYLE_SAMPLES.scene.join('、') + '，人物 ' + STYLE_SAMPLES.character.join('、') + '（取不到再用 view_style_sample）。窗外门外要是中国城市街景。',
    ...(cp.rereview ? ['【这一轮是重审】这张图已经写回资产（可能是手工线导入、IC 从没审过的）。照新图一样按必核项逐项核，不因为它已经定稿就放过。' + (cp.step === 'compose' ? '它是 _MV 的 2×2：view_candidate 看整张，view_approved 分别看 A、B、C、D 四格，逐格核 B/C/D 和 A 是不是同一空间、D 的物件方位和数量是否和 A/B/C 对得上、D 上的机位标注是不是本张的。' : '') + '不过就 verdict=return，return_note 写清哪一处、照什么改' + (cp.step === 'compose' ? '，redo_step 填要重出的那一格（A/B/C/D，挑错得最根本的那一格）' : '') + '；取不到底图才交 needs_human。过了图不动。'] : []),
    ...(cp.step === 'compose' && !cp.rereview ? ['【这一轮是拼板核对】' + '这张 2×2 是拿已审过的 A/B/C 和 D 拼的（D 可能是人工指定、从同地点别的 _MV 借来的）。用 view_approved 分别看 A、B、C、D，核 D 和 A/B/C 是不是同一个空间：门窗、饮水机这类物件的方位，有没有幕墙，D 上的机位标注是不是本张 A/B/C 的（借来的 D 上标的是别张的机位就不对）。对不上就交 needs_human，写清哪一处，不要判过。'] : []),
    '4. 人物、服装、年龄图：拿 get_review_context 的 asset_description（本资产和所属角色的描述）逐项核年龄段、体型、发型和发际线、每件衣服的颜色，看着图写「描述 X / 图里 Y」，一项对不上就退回。描述还没照图或照原著更新过、而这张是照底图图生图的：核图和原著明写项、和底图对不对得上，不拿旧描述卡，在 note 里写明描述哪句要改。\n' +
    '4b. 逐项核八个必核项，_MV 和多件陈设的逐件填对照表。一项不符就退回；左右先写清机位朝向（朝北看东在右手，朝南看东在左手），不要给错方向。',
    '5. submit_review 交结论（只交一次）。过了 IC 会写回原资产；退回会把 return_note 原样发给 am 返修。场景图的 same_space、base_image 和挂了底图的 base_image 不能填 na；底图取不到就交 verdict=needs_human（return_note 写原因），不要判过。',
  ].join('\n');
}

/** 本资产和所属角色的描述（服装 / 年龄挂在角色下，外形以角色描述为准、服装以本资产描述为准）。 */
function personDesc(aid) {
  const a = Assets.get(aid);
  if (!a) return null;
  const p = a.parent_id ? Assets.get(a.parent_id) : null;
  return { self: String(a.description || '').slice(0, 2000), parent: p ? { name: p.name, description: String(p.description || '').slice(0, 2000) } : null };
}
