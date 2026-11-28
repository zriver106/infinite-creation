// 首尾帧控制（总导 11-28 批，第一批 S1/S2/S3/S4 最小版/S5/S6）：一镜从「机位落位」到「首尾帧挂上槽位」的编排。
//   S1 planRig：LLM 读镜头说明 + 场景母本（门窗、工位/座位、站位点）→ camera_rig；validateRig 校验，不过带错误重写一次。
//   S2 renderRig（lib/core/scene-render.js）：首尾灰模 + 深度 + 线稿。
//   S3 generateKeyframe（lib/core/keyframe-gen.js）：结构控制 + 人物定妆参考出首/尾帧候选。
//   S4 reviewKeyframe（./keyframe-review.js）：五条审图，最小版只给结论。
//   S5 审过 → setUploadedFrame：首/尾帧挂到分镜槽位，出片时走现成的 MiniMaxH3AddGuide 锚定（参考图、音色照带）。
//   S6 承接上一镜 22 帧时：承接占第 0 帧，机位只出尾帧、只挂尾帧；首机位要接上上一镜尾机位（validateRig prevRig）。
import fs from 'node:fs';
import { Shots, Assets, Projects, resolveProjectPath } from '../core/index.js';
import { getSceneMaster, sceneMasterForAsset } from '../core/scene-master.js';
import { rigOf, keyframeReviewOf, validateRig, anchorsFor } from '../core/camera-rig.js';
import { renderRig } from '../core/scene-render.js';
import { generateKeyframe } from '../core/keyframe-gen.js';
import { setUploadedFrame } from '../core/first-frame.js';
import { extractJson } from '../core/llm.js';
import { brainChat } from './brain.js';
import { reviewKeyframe } from './keyframe-review.js';
import { leadInContext } from './lead-in-ctx.js';

const arr = (v) => (Array.isArray(v) ? v : []);

/** 这一镜属于哪个场景母本：绑定的场景资产里第一个挂了母本的。 */
export function sceneMasterOfShot(projectId, shot) {
  for (const aid of arr(shot.scene_ids)) {
    const m = sceneMasterForAsset(projectId, aid);
    if (m) return m;
  }
  return null;
}

/** 母本压缩成给 LLM 看的摘要（门窗、分区、工位/办公室、固定物、座位、站位点）。 */
export function masterBrief(M) {
  const b = { scene_id: M.scene_id, name: M.name, room: M.room, openings: arr(M.openings).map((o) => ({ id: o.id, name: o.name, side: o.side, kind: o.kind, from: o.from, to: o.to })), zones: arr(M.zones).map((z) => ({ id: z.id, name: z.name, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 })) };
  if (M.workstations) b.workstations = { desk: M.workstations.desk, rows: M.workstations.rows, cols: M.workstations.cols, seating_rule: M.workstations.seating_rule, id_rule: M.workstations.id_rule };
  if (M.office) b.office = { id: M.office.id, name: M.office.name, x0: M.office.x0, y0: M.office.y0, x1: M.office.x1, y1: M.office.y1, door: M.office.door, furniture: M.office.furniture };
  b.items = arr(M.items).slice(0, 40).map((it) => ({ id: it.id, name: it.name, center: it.center, box: it.box }));
  const seats = arr(M.seats);
  if (seats.length) b.seats = seats.slice(0, 120).map((s) => ({ id: s.id, at: s.at, yaw: s.yaw }));
  const sp = M.source_doc && (M.source_doc['站位点'] || M.source_doc['站位']);
  if (sp) b.standing_points = Array.isArray(sp) ? sp.slice(0, 60) : sp;
  return b;
}

/** 这一镜的剧中人物：名字 + 定妆图（有服装资产用服装图）+ 服装描述。 */
export function castOfShot(projectId, shot) {
  const assets = Assets.list(projectId);
  const out = [];
  for (const cid of arr(shot.character_ids)) {
    const ch = assets.find((a) => a.id === cid);
    if (!ch) continue;
    const cos = assets.find((a) => a.category === 'costume' && a.parent_id === ch.id && arr(shot.costume_ids).includes(a.id));
    const img = (cos && cos.image_path) || ch.image_path || '';
    out.push({ id: ch.id, name: ch.name, desc: (cos && (cos.description || cos.name)) || ch.description || '', refAbs: img ? resolveProjectPath(projectId, img) : '' });
  }
  return out;
}

export function planPrompt(shot, brief, cast, { prevRig = null, leadIn = false } = {}) {
  return [
    '把下面这一镜落到场景母本的坐标里，给出首帧、尾帧两个机位和画面里每个剧中人物的位置。',
    '坐标：米，X 东、Y 北；朝向一律用罗盘角：0＝北、90＝东、180＝南、270＝西（和母本 seats.yaw 一致）。',
    '规则：① 机位照镜头说明来，朝哪边拍、画左画右有什么都要对得上；把镜头说明里写到的方位关系写进 expect（例如经理室应在画左：{"at":[经理室中心x,y],"side":"left","in":"both","note":"经理室"}；镜头背后的窗写 side:"behind"）。② 首尾机位沿真实运镜路线，相距 1–1.5 米或一次小幅转向；镜头不动就 last 设 null。③ 机位不能卡在桌子、隔断、人身上，离墙至少 0.25 米；坐着拍人眼高约 1.2–1.45，站着约 1.5–1.65；焦段 24–50。④ people 只列剧中人物（role 写人物名，pose sit/stand，yaw 是脸朝向），背景同事不用列（自动按母本座位坐满）；只在首帧或只在尾帧出现的人加 only。⑤ first.desc / last.desc 各写一句这一刻的画面（谁在哪、在干什么、道具在哪）。',
    leadIn ? '本镜承接上一镜末尾 22 帧：first 必须等于上一镜的尾机位：' + JSON.stringify(prevRig && prevRig.last) : '',
    '只输出 JSON：{"scene_id":"' + brief.scene_id + '","first":{"pos":[x,y],"eye":1.4,"yaw":0,"pitch":-5,"lens_mm":28,"desc":"…"},"last":{…}|null,"people":[{"x":0,"y":0,"yaw":0,"pose":"sit","role":"人物名","only":"last"}],"expect":[…],"note":"落位依据"}',
    '镜头：第' + shot.idx + '镜；机位：' + (shot.camera || '') + '；画面：' + (shot.visual || '') + (shot.sub_shots ? '；分镜：' + (typeof shot.sub_shots === 'string' ? shot.sub_shots : JSON.stringify(shot.sub_shots)).slice(0, 2000) : '') + (shot.dialogue ? '；台词：' + String(shot.dialogue).slice(0, 600) : ''),
    '剧中人物：' + (cast.map((c) => c.name).join('、') || '无'),
    '场景母本：' + JSON.stringify(brief),
  ].filter(Boolean).join('\n');
}

/** S6：本镜是否承接上一镜 22 帧（以及上一镜的机位）。 */
export function leadInOf(projectId, shot, cfg) {
  let lc = null;
  try { lc = leadInContext(projectId, shot); } catch { lc = null; }
  const dec = lc && lc.decision;
  let on = !!(dec && dec.on);
  if (on && dec.mode === 'auto' && cfg && cfg.generation && cfg.generation.leadInAuto === false) on = false;
  return { on, prev: lc && lc.prev, prevRig: on && lc && lc.prev ? rigOf(lc.prev) : null };
}

export async function planRig(ctx, shotId, deps = {}) {
  const chat = deps.brainChat || brainChat;
  const shot = Shots.get(shotId);
  if (!shot) throw new Error('分镜不存在');
  const sm = sceneMasterOfShot(ctx.projectId, shot);
  if (!sm) throw new Error('第' + shot.idx + '镜绑的场景没有空间母本，不能落机位（先补母本，或照原来的参考图流程出）');
  const M = sm; const brief = masterBrief(M); const cast = castOfShot(ctx.projectId, shot);
  const li = leadInOf(ctx.projectId, shot, ctx.cfg);
  let msgs = [{ role: 'system', content: '你是短剧摄影指导，负责把文字机位落到场景坐标。只输出 JSON。' }, { role: 'user', content: planPrompt(shot, brief, cast, { prevRig: li.prevRig, leadIn: li.on && !!li.prevRig }) }];
  let rig = null; let v = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(ctx.cfg, msgs, { json: true, temperature: 0.2, maxTokens: 2500 });
    try { rig = extractJson(r.content || ''); } catch (e) { rig = null; v = { ok: false, errors: [e.message], warnings: [] }; }
    if (rig) { rig.scene_id = rig.scene_id || M.scene_id; v = validateRig(M, rig, { prevRig: li.on ? li.prevRig : null }); }
    if (v && v.ok) break;
    msgs = msgs.concat([{ role: 'assistant', content: JSON.stringify(rig) }, { role: 'user', content: '校验没过，按下面的问题改了再输出完整 JSON：\n' + (v ? v.errors.join('\n') : '读不出 JSON') }]);
  }
  rig = { ...(rig || {}), planned_at: Date.now(), validation: v };
  Shots.setRigFields(shotId, { camera_rig: rig });
  return { rig, validation: v, lead_in: li.on };
}

/** 关键帧提示词：画风 + 场景 + 这一刻的画面 + 人物服装 + 结构硬要求（临时规则第二节）。 */
export function keyframePrompt({ style = '', sceneName = '', finish = null, desc = '', cast = [], openingsNote = '' }) {
  return [
    'Still frame from a high-end Chinese drama, ' + (style || 'realistic 3D CG render, realistic human proportions, real-world materials and lighting, subtle stylization') + '.',
    sceneName ? 'Location: ' + sceneName + (finish ? ' (' + JSON.stringify(finish).slice(0, 400) + ')' : '') + '.' : '',
    desc ? 'This moment: ' + desc : '',
    ...cast.map((c, i) => 'The person who is ' + c.name + ' looks exactly like reference image ' + (i + 1) + ': same face, hair and outfit' + (c.desc ? ' (' + c.desc + ')' : '') + '.'),
    'Every other seated figure is an ordinary colleague in casual clothes, facing the way the control figure faces (we see a face where the control figure has a nose); nobody else wears the main characters\' outfits.',
    openingsNote || 'Doors and windows only where the control lines put them; no extra windows or openings anywhere.',
    'Keep every wall, desk, partition, monitor, person and opening exactly where the control lines put them; do not add or remove any person or furniture. No text, no logos, no watermark.',
  ].filter(Boolean).join(' ');
}

/**
 * S2–S5 跑一镜：渲灰模 → 出首/尾帧候选 → 审图 → 审过挂槽位。返回 { review, applied }。
 * @param opts.seeds   每张出几个种子（默认 [7, 11]；第一个审过的就用）
 * @param opts.apply   审过是否直接挂槽位（默认 true）
 */
export async function runKeyframeRig(ctx, shotId, { seeds = [7, 11], apply = true, deps = {} } = {}) {
  const shot = Shots.get(shotId);
  if (!shot) throw new Error('分镜不存在');
  const rig = rigOf(shot);
  if (!rig || !rig.first) throw new Error('第' + shot.idx + '镜还没落机位（先 plan）');
  const sm = getSceneMaster(ctx.projectId, rig.scene_id);
  if (!sm) throw new Error('场景母本不存在：' + rig.scene_id);
  const M = sm.master;
  const li = leadInOf(ctx.projectId, shot, ctx.cfg);
  const v = validateRig(M, rig, { prevRig: li.on ? li.prevRig : null });
  if (!v.ok) throw new Error('机位校验没过：' + v.errors.join('；'));
  const want = anchorsFor(rig, li.on);
  const say = (detail) => { try { ctx.report && ctx.report({ phase: '首尾帧控制', detail: '第' + shot.idx + '镜 ' + detail }); } catch {} };
  const rendered = await (deps.renderRig || renderRig)(ctx.projectId, shotId, rig, { cfg: ctx.cfg });
  say('灰模已渲：' + rendered.dir);
  const cast = castOfShot(ctx.projectId, shot);
  const project = Projects.get(ctx.projectId) || {};
  const openings = arr(M.openings).map((o) => (o.name || o.id) + '（' + (o.side || '') + (o.kind ? '，' + o.kind : '') + '）');
  const review = { lead_in: li.on, want, first: null, last: null, at: Date.now() };
  for (const which of ['first', 'last']) {
    if (!want[which]) continue;
    const views = rendered[which];
    const meta = (rendered.meta && rendered.meta[which]) || {};
    const inFrame = new Set(arr(meta.people_in_frame).map((p) => p.role));
    const castHere = cast.filter((c) => inFrame.has(c.name));
    const prompt = keyframePrompt({ style: project.style, sceneName: M.name, finish: M.finish, desc: (rig[which] && rig[which].desc) || '', cast: castHere });
    const cands = [];
    for (const seed of seeds) {
      const g = await (deps.generateKeyframe || generateKeyframe)(ctx.cfg, ctx.projectId, shotId, which, views, { prompt, refAbs: castHere.map((c) => c.refAbs).filter(Boolean), seed, size: (rendered.meta && rendered.meta[which] && rendered.meta[which].size) || [1280, 720], jobId: ctx.jobId, isAborted: ctx.isAborted });
      say((which === 'first' ? '首' : '尾') + '帧候选 s' + seed + '：' + g.rel);
      const rv = await (deps.reviewKeyframe || reviewKeyframe)(ctx, { which, imageAbs: resolveProjectPath(ctx.projectId, g.rel), grayAbs: resolveProjectPath(ctx.projectId, views.gray), openings, costumes: castHere, props: [], people: arr(meta.people_in_frame).filter((p) => p.role !== 'bg'), sceneName: M.name });
      cands.push({ rel: g.rel, seed, review: rv });
      say((which === 'first' ? '首' : '尾') + '帧 s' + seed + ' 审图' + (rv.verdict === 'pass' ? '过' : '不过：' + rv.failed.join('；')));
      if (rv.verdict === 'pass') break;
    }
    const chosen = cands.find((c) => c.review.verdict === 'pass') || null;
    review[which] = { candidates: cands, chosen: chosen ? chosen.rel : '' };
  }
  const okAll = ['first', 'last'].every((k) => !want[k] || (review[k] && review[k].chosen));
  review.verdict = okAll ? 'pass' : 'fail';
  let applied = false;
  if (okAll && apply) {
    if (want.first) setUploadedFrame(ctx.projectId, shotId, 'first', review.first.chosen);
    if (want.last) setUploadedFrame(ctx.projectId, shotId, 'last', review.last.chosen);
    applied = true;
    say('首尾帧已挂到槽位' + (li.on ? '（承接上一镜 22 帧占第 0 帧，只挂尾帧）' : ''));
  }
  review.applied = applied;
  Shots.setRigFields(shotId, { keyframe_review: review });
  return { review, applied, rendered };
}

export { keyframeReviewOf };
