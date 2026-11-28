// 场景三视图审图 Agent 的受限工具集（手册 13 号；总导 11-28）：美术加工后的平面 / 正 / 左 / 右四张，逐件对母本、量位置、核比例、核画风。
// 只读：母本摘要 + 逐件清单（各视图应在的百分比）、宽高比结果、本轮哪几张是新图、以前的退回意见、审图总览、灰模（可带标注）、美术图；
// 唯一写入是 submit_scene_review（结论落 candidates/<round>/review.json，由 IC 接着写回 art/ 或写退回意见）。
import fs from 'node:fs';
import path from 'node:path';
import { Jobs } from '../core/index.js';
import { getSceneMaster, SCENE_VIEWS } from '../core/scene-master.js';
import { imagePayload } from '../core/reference-assets.js';
import { sceneChecklist, roundDir, loadRound, reviewResultFile, overviewFile, previousReturns, VIEW_META, VIEW_KEYS, viewOf, buildOverview, POS_TOL_PCT } from '../core/scene-review.js';

export const SCENE_REVIEW_TOOLSET = 'scene-review';
const VIEW_ENUM = { type: 'string', enum: VIEW_KEYS };

export const SCENE_REVIEW_TOOLS = [
  { type: 'function', function: { name: 'get_scene_review_context', description: '本次要审的场景、第几轮；母本摘要、四个视图的观察方向和拿掉的墙、逐件清单（每件在各视图横向应占的百分比、门窗在各视图是正对 / 侧面 / 被拿掉）、宽高比结果、本轮哪几张是新图、以前各轮的退回意见、审图口径。先调它。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_overview', description: '看审图总览：每个视图一行（左灰模、右美术），最下面四张美术并排（画风统一检查）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'view_gray', description: '看某个视图的灰模底图（母本正交导出）；labelled=true 看带物件编号的标注版。', parameters: { type: 'object', properties: { view: VIEW_ENUM, labelled: { type: 'boolean' } }, required: ['view'] } } },
  { type: 'function', function: { name: 'view_art', description: '看某个视图本轮的美术图（没交新图的视图是沿用的已定稿图）。', parameters: { type: 'object', properties: { view: VIEW_ENUM }, required: ['view'] } } },
  { type: 'function', function: { name: 'submit_scene_review', description: '交审图结论（只交一次）。views 四张都要有：{view, verdict: pass|fail, items:[{id, expected, seen_pct, ok}], defects:[...], fix_note}；items 逐件填该视图灰模里看得见的每一件（expected 抄清单的百分比，seen_pct 写你在美术图里量到的百分比）；任一件 ok=false、缺件、多件、比例不过、画风不对，这张就是 fail，fix_note 写给返修的人：哪一件、在哪、照什么改。verdict 是总结论：四张都过才 pass。', parameters: { type: 'object', properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    views: { type: 'array', items: { type: 'object', properties: {
      view: VIEW_ENUM, verdict: { type: 'string', enum: ['pass', 'fail'] },
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, expected: { type: 'string' }, seen_pct: { type: 'string' }, ok: { type: 'boolean' } }, required: ['id', 'expected', 'seen_pct', 'ok'] } },
      defects: { type: 'array', items: { type: 'string' } },
      fix_note: { type: 'string' },
    }, required: ['view', 'verdict', 'items'] } },
    note: { type: 'string' },
  }, required: ['verdict', 'views'] } } },
];
const NAMES = new Set(SCENE_REVIEW_TOOLS.map((t) => t.function.name));
export const isSceneReviewTool = (n) => NAMES.has(n);
export const sceneReviewToolDefinitions = () => SCENE_REVIEW_TOOLS;

/** 审图任务上下文：任务 checkpoint 里的 scene_id、round。 */
export function sceneReviewCtxOf(jobId) {
  const j = Jobs.get(jobId); const cp = (j && j.checkpoint) || {};
  if (!cp.scene_id || !cp.round) throw new Error('场景审图任务缺上下文（scene_id / round）');
  return cp;
}

const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

/**
 * 校验并收口结论。服务端强制：宽高比不过的视图一律 fail；有任一件 ok=false 的视图一律 fail；四张都过才总 pass。
 * 返回 { error } 或 { result, forced:[说明] }。
 */
export function validateSceneReview(args, { ratio = {} } = {}) {
  const r = { ...(args || {}) };
  r.views = parse(r.views);
  if (!Array.isArray(r.views)) return { error: 'views 要是四个视图的数组' };
  const forced = [];
  const seen = new Set(); const views = [];
  for (const v0 of r.views) {
    const v = { ...(v0 || {}) };
    v.items = parse(v.items); v.defects = parse(v.defects);
    if (!VIEW_KEYS.includes(v.view)) return { error: 'view 只能是 ' + VIEW_KEYS.join(' / ') + '，收到 ' + v.view };
    if (seen.has(v.view)) return { error: v.view + ' 交了两次' };
    seen.add(v.view);
    if (!['pass', 'fail'].includes(v.verdict)) return { error: v.view + '.verdict 只能是 pass / fail' };
    if (!Array.isArray(v.items) || !v.items.length) return { error: v.view + ' 要逐件填 items（该视图灰模里看得见的每一件）' };
    for (const it of v.items) {
      if (!it || !String(it.id || '').trim()) return { error: v.view + ' 的 items 每件要有 id' };
      if (typeof it.ok !== 'boolean') return { error: v.view + ' 的 ' + it.id + '.ok 要是 true / false' };
      if (it.expected == null || it.seen_pct == null) return { error: v.view + ' 的 ' + it.id + ' 要写 expected 和 seen_pct' };
    }
    v.defects = Array.isArray(v.defects) ? v.defects.map(String) : (v.defects ? [String(v.defects)] : []);
    const declaredFail = v.verdict === 'fail';
    const rc = ratio[v.view];
    if (rc && rc.fail) {
      const d = '宽高比不对：美术 / 灰模整图宽高比 = ' + rc.img_ratio + '（差超过 10%），要按灰模的画幅比例出图';
      if (!v.defects.includes(d)) v.defects.push(d);
      if (v.verdict === 'pass') { v.verdict = 'fail'; forced.push(v.view + '：宽高比不过，改判 fail'); }
    }
    const bad = v.items.filter((x) => x.ok === false);
    if (bad.length && v.verdict === 'pass') { v.verdict = 'fail'; forced.push(v.view + '：有对不上的物件（' + bad.map((x) => x.id).join('、') + '），改判 fail'); }
    if (v.verdict === 'fail' && !String(v.fix_note || '').trim()) {
      if (declaredFail) return { error: v.view + ' 判了 fail 要写 fix_note（给返修：哪一件、在哪、照什么改）' };
      v.fix_note = [bad.length ? '对不上的物件照灰模位置改：' + bad.map((x) => x.id + ' 应在 ' + x.expected).join('；') : '', rc && rc.fail ? '画幅比例照灰模（宽高比差 ' + rc.img_ratio + '）' : ''].filter(Boolean).join('；');
    }
    views.push(v);
  }
  const missing = VIEW_KEYS.filter((k) => !seen.has(k));
  if (missing.length) return { error: '四张都要审，缺 ' + missing.join('、') };
  const allPass = views.every((v) => v.verdict === 'pass');
  let verdict = r.verdict;
  if (!['pass', 'fail'].includes(verdict)) return { error: 'verdict 只能是 pass / fail' };
  if (verdict === 'pass' && !allPass) { verdict = 'fail'; forced.push('总结论：有视图不过，改判 fail'); }
  if (verdict === 'fail' && allPass) return { error: '四张都判 pass，总结论却是 fail：哪张不过就把那张判 fail 并写 fix_note' };
  return { result: { verdict, views: VIEW_KEYS.map((k) => views.find((v) => v.view === k)), note: String(r.note || '') }, forced };
}

function img(abs, meta) {
  if (!abs || !fs.existsSync(abs)) return JSON.stringify({ ...meta, note: '图文件不在：' + abs });
  const p = imagePayload(abs);
  return p ? { text: JSON.stringify(meta), images: [p] } : JSON.stringify({ ...meta, note: '图太大没附上' });
}

export async function runSceneReviewTool(ctx, name, args = {}) {
  const cp = sceneReviewCtxOf(ctx.jobId);
  const pid = ctx.projectId;
  const rd = roundDir(pid, cp.scene_id, cp.round);
  const round = loadRound(pid, cp.scene_id, cp.round);
  if (!round) throw new Error('这一轮没登记：' + cp.round);
  if (name === 'get_scene_review_context') {
    const sm = getSceneMaster(pid, cp.scene_id);
    const m = (sm && sm.master) || {};
    return JSON.stringify({
      scene_id: cp.scene_id, name: m.name || '', round: cp.round, new_views: round.new_views, fallback_views: round.fallback_views,
      master: { room: m.room, finish: m.finish, exterior: m.exterior || undefined, openings: (m.openings || []).map((o) => ({ id: o.id, name: o.name, side: o.side, kind: o.kind, from: o.from, to: o.to })), zones: (m.zones || []).map((z) => ({ id: z.id, name: z.name })) },
      views: SCENE_VIEWS.map((v) => ({ view: v.key, name: v.name, how: VIEW_META[v.key].how, span_from: VIEW_META[v.key].span_from, removed_wall: VIEW_META[v.key].removed_wall })),
      checklist: sceneChecklist(m),
      checklist_note: 'span 是该件在各视图横向应占的百分比（从画面左边算；平面 / 正视从西数，左视从北数，右视从南数）。face：门窗在该视图是 face_on 正对、edge_on 侧面（只能是一条边）、removed（那面墙被拿掉）、gap（平面图里的墙洞）。count 是同款件数。',
      ratio: round.ratio,
      previous_returns: previousReturns(pid, cp.scene_id, cp.round),
      pos_tolerance_pct: POS_TOL_PCT,
    });
  }
  if (name === 'view_overview') {
    const f = overviewFile(pid, cp.scene_id, cp.round);
    if (!fs.existsSync(f)) buildOverview(rd, f, { newViews: round.new_views });
    return img(f, { overview: true, round: cp.round, new_views: round.new_views });
  }
  if (name === 'view_gray' || name === 'view_art') {
    const v = viewOf(String(args.view || ''));
    if (!v) throw new Error('view 只能是 ' + VIEW_KEYS.join(' / '));
    if (name === 'view_art') return img(path.join(rd, 'art_' + v.key + '.png'), { view: v.key, name: v.name, how: VIEW_META[v.key].how, art: true, new_this_round: round.new_views.includes(v.key) });
    const lab = path.join(rd, v.name + '_标注.png');
    const f = args.labelled && fs.existsSync(lab) ? lab : path.join(rd, v.name + '.png');
    return img(f, { view: v.key, name: v.name, how: VIEW_META[v.key].how, gray: true, labelled: f === lab });
  }
  if (name === 'submit_scene_review') {
    const out = reviewResultFile(pid, cp.scene_id, cp.round);
    if (fs.existsSync(out)) throw new Error('本轮已经交过结论了');
    const { error, result, forced } = validateSceneReview(args, { ratio: round.ratio || {} });
    if (error) throw new Error('结论不合格：' + error);
    fs.writeFileSync(out, JSON.stringify({ ...result, forced, scene_id: cp.scene_id, round: cp.round, job_id: ctx.jobId, at: Date.now() }, null, 2));
    return JSON.stringify({ saved: true, verdict: result.verdict, forced });
  }
  throw new Error('未知工具 ' + name);
}

export function buildSceneReviewAgentPrompt({ project, cp }) {
  return [
    '【IC「场景三视图审图」任务】项目「' + ((project && project.name) || '') + '」：审场景「' + cp.scene_id + '」第 ' + cp.round + ' 轮的四视图美术图（平面图、正视图、左视图、右视图）。只审不画，不改任何文件；从严，拿不准就判 fail。',
    '【外部 Agent 运行时】领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ 前缀。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具。',
    '步骤：',
    '1. get_scene_review_context：母本、四个视图的观察方向、逐件清单（span 百分比、门窗 face）、宽高比结果、本轮哪几张是新图（没交新图的是沿用已定稿，照样一起审，画风要四张统一）、以前的退回意见（上次说的改了没有要核）。',
    '2. view_overview 先看总览；再逐个视图 view_gray(view, labelled=true) 对着标注认件，view_art(view) 看美术图。',
    '3. 每个视图：把该视图灰模里看得见的每一件逐件打勾（items：id、expected 抄清单的百分比、seen_pct 写你在美术图里量到的横向百分比、ok）。审图口径（任一条不符这张就 fail）：',
    '   ① 灰模里有的件美术图里缺了 = fail；美术图里多出灰模没有的物件（多一个柜子、多一盆花、多一扇门窗、多出人物）= fail，写进 defects。',
    '   ② 量到的位置和清单 span 差超过画面宽度的 ' + POS_TOL_PCT + '% = 这件 ok=false。数量（count）对不上 = ok=false。',
    '   ③ 侧面墙上的门窗（face=edge_on）在该视图里只能是一条边，画成正对着的门窗 = fail；face=removed 的那面墙不该挡在镜头前。',
    '   ④ 宽高比（ratio.<view>.fail=true）= 这张直接 fail（服务端也会强制）。bbox_ratio_info 只是参考，不据此判。',
    '   ⑤ 画风：四张都要是照片级写实的室内 / 外景摄影质感；任何一张像平涂色块、示意图、线稿、插画、3D 灰模渲染 = 那张 fail。四张的材质、色温、光线要一致。',
    '   ⑥ 平面图必须是真正的正交俯视（没有透视、看不到墙的侧面立面），墙体、门洞、窗要画出来；画成鸟瞰透视 = fail。',
    '   ⑦ 图上不能有可读的文字、编号、标注、水印；不能留标注色（红色的座位、蓝色的屏幕 / 色块这类灰模标记色）= fail。',
    '4. submit_scene_review 交结论（只交一次）：views 四张都要交；不过的视图写 defects 和 fix_note（给返修的人：哪一件、在画面哪里、照什么改；左右先写清这张的观察方向）。四张都过 verdict 才是 pass。过了 IC 会写回 art/ 并拼白板；不过 IC 会把 fix_note 合成退回意见。',
  ].join('\n');
}
