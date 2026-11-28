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
import { rigOf, keyframeReviewOf, validateRig, anchorsFor, hfovOf, yawDelta, bearing, angleOf } from '../core/camera-rig.js';
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

export function planPrompt(shot, brief, cast, { prevRig = null, leadIn = false, angle = '' } = {}) {
  return [
    '把下面这一镜落到场景母本的坐标里，给出首帧、尾帧两个机位和画面里每个剧中人物的位置。',
    '坐标：米，X 东、Y 北；朝向一律用罗盘角：0＝北、90＝东、180＝南、270＝西（和母本 seats.yaw 一致）。',
    '规则：① 机位照镜头说明来，朝哪边拍、画左画右有什么都要对得上；把镜头说明里写到的方位关系写进 expect（例如经理室应在画左：{"at":[经理室中心x,y],"side":"left","in":"both","note":"经理室"}；镜头背后的窗写 side:"behind"）。② 首尾机位沿真实运镜路线，相距 1–1.5 米或一次小幅转向；镜头不动就 last 设 null。③ 机位不能卡在桌子、隔断、人身上，离墙至少 0.25 米；坐着拍人眼高约 1.2–1.45，站着约 1.5–1.65；焦段 24–50。④ people 只列剧中人物（role 写人物名，pose sit/stand，yaw 是脸朝向），背景同事不用列（自动按母本座位坐满）。人在首尾两帧位置不同（走动）就列两条，分别加 only:"first" / only:"last"；列出来的人在那一帧必须拍得到（校验会核水平视场），真要不入画的加 offscreen:true。expect 的 side 只能是 left / right / center / behind。⑤ first.desc / last.desc 各写一句这一刻的画面（谁在哪、在干什么、道具在哪）。',
    leadIn ? '本镜承接上一镜末尾 22 帧：first 必须等于上一镜的尾机位：' + JSON.stringify(prevRig && prevRig.last) : '',
    '⑥ 机位高度、俯仰、焦段一律按分镜写的景别和角度来，禁止默认平视：俯拍 / 俯视 → 机位 2.0–2.6 米（不超过层高减 0.2）、pitch −20 到 −45；仰拍 / 仰视 → 机位 0.5–1.1 米、pitch +10 到 +25；平视 → pitch −3 到 +3；荷兰角写 roll（±5–15）。特写 → 焦段 50–85、离主体 0.8–1.5 米；近景 → 35–50；中景 → 28–35；全景 / 远景 → 18–24。推拉的镜头 first 是起点、last 是终点。画面要包含人物站位所在的那一块，不是只拍大全景。' + (angle ? '本镜分镜角度：' + ({ high: '俯拍', low: '仰拍', eye: '平视' }[angle]) + '，first/last 都写 "angle":"' + angle + '"。' : ''),
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
  const angle = angleOf((shot.camera || '') + ' ' + (shot.visual || ''));
  let msgs = [{ role: 'system', content: '你是短剧摄影指导，负责把文字机位落到场景坐标。只输出 JSON。' }, { role: 'user', content: planPrompt(shot, brief, cast, { prevRig: li.prevRig, leadIn: li.on && !!li.prevRig, angle }) }];
  let rig = null; let v = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await chat(ctx.cfg, msgs, { json: true, temperature: 0.2, maxTokens: 2500 });
    try { rig = extractJson(r.content || ''); } catch (e) { rig = null; v = { ok: false, errors: [e.message], warnings: [] }; }
    if (rig) { rig.scene_id = rig.scene_id || M.scene_id; if (angle) rig.angle = angle; v = validateRig(M, rig, { prevRig: li.on ? li.prevRig : null }); }
    if (v && v.ok) break;
    msgs = msgs.concat([{ role: 'assistant', content: JSON.stringify(rig) }, { role: 'user', content: '校验没过，按下面的问题改了再输出完整 JSON：\n' + (v ? v.errors.join('\n') : '读不出 JSON') }]);
  }
  rig = { ...(rig || {}), planned_at: Date.now(), validation: v };
  Shots.setRigFields(shotId, { camera_rig: rig });
  return { rig, validation: v, lead_in: li.on };
}

/** 母本门窗 → 「窗只在哪面墙」一句（试点：模型爱在实墙上补落地窗）。 */
export function wallsNote(M) {
  const sides = { north: '北', south: '南', east: '东', west: '西' };
  const win = new Set(); const doors = new Set();
  for (const o of arr(M.openings)) {
    const side = o.side || ''; if (!sides[side]) continue;
    if (o.kind === 'window' || /窗|幕墙/.test(o.name || '')) win.add(side); else doors.add(side);
  }
  const solid = Object.keys(sides).filter((k) => !win.has(k));
  const en = { north: 'north', south: 'south', east: 'east', west: 'west' };
  // 门按墙列出来，玻璃门写明「通走廊、看不到室外」（试点：灰模里玻璃门和窗同色，模型把玻璃门画成了看得见城市的窗）
  const doorTxt = arr(M.openings).filter((o) => sides[o.side] && !(o.kind === 'window' || /窗|幕墙/.test(o.name || '')))
    .map((o) => (/玻璃|glass/i.test((o.name || '') + (o.detail || '')) ? 'a black-framed glass door' : 'a solid door') + ' on the ' + en[o.side] + ' wall');
  return (win.size ? 'Windows exist only on the ' + [...win].map((k) => en[k]).join(' and ') + ' wall' + (win.size > 1 ? 's' : '') + '. ' : 'This room has no windows at all. ')
    + (solid.length ? 'The ' + solid.map((k) => en[k]).join(', ') + ' wall' + (solid.length > 1 ? 's are' : ' is') + ' solid painted wall with no window and no glass to the outside. ' : '')
    + (doorTxt.length ? 'Doors: ' + doorTxt.join('; ') + '; a glass door opens onto an indoor corridor, never onto an outdoor view. Doors only where the control lines draw a door.' : '');
}

/**
 * 按机位算「这一张画面里每面墙在哪一侧、是什么墙」（多视角空镜实测：只写「窗只在北墙」不够，模型照样把画左的东墙画成落地窗；
 * 按画面方位逐面写清楚才压得住）。cam：{ pos:[x,y], yaw（罗盘角）, lens_mm }。
 */
export function viewNote(M, cam) {
  if (M.exterior) return '';   // 室外场景没有四面墙
  const R = M.room || {}; const hf = hfovOf(cam.lens_mm || 28) / 2;
  const mid = { north: [(R.x0 + R.x1) / 2, R.y1], south: [(R.x0 + R.x1) / 2, R.y0], east: [R.x1, (R.y0 + R.y1) / 2], west: [R.x0, (R.y0 + R.y1) / 2] };
  const isWin = (o) => o.kind === 'window' || /窗/.test(o.name || '');
  const txt = (o) => String(o.name || '') + ' ' + String(o.detail || '');
  // 沿墙的通高玻璃幕墙（母本里记成固定物）：box 贴着这面墙
  const near = (b, side) => {
    const m = 0.8;
    return side === 'north' ? Math.max(b[1], b[4]) > R.y1 - m : side === 'south' ? Math.min(b[1], b[4]) < R.y0 + m : side === 'east' ? Math.max(b[0], b[3]) > R.x1 - m : Math.min(b[0], b[3]) < R.x0 + m;
  };
  const curtain = (side) => arr(M.items).some((it) => /幕墙/.test(it.name || '') && Array.isArray(it.box) && near(it.box, side));
  const doorDesc = (o) => {
    const t = txt(o);
    if (/旋转门|正门|主入口/.test(t) && arr(M.items).some((it) => /旋转门/.test(it.name || ''))) return 'the main entrance with a glass revolving door';
    if (/玻璃|glass/i.test(t)) return 'a dark-framed glass door' + (/走廊|电梯厅|通道|室内/.test(t) ? ' to an indoor corridor (no outdoor view through it)' : '');
    if (/木|软包/.test(t)) return 'a wooden door';
    return 'a door';
  };
  const desc = (side) => {
    const os = arr(M.openings).filter((o) => o.side === side);
    if (os.some(isWin)) return 'a wall of floor-to-ceiling windows with the city outside';
    const doors = os.filter((o) => !isWin(o)).map(doorDesc);
    if (curtain(side)) return 'a full-height glass curtain wall' + (doors.length ? ' with ' + doors.join(' and ') : '');
    return 'a solid wall with no window at all' + (doors.length ? ', only ' + doors.join(' and ') : '');
  };
  const pos = (d) => (d < -hf * 0.33 ? 'on the left of the frame' : d > hf * 0.33 ? 'on the right of the frame' : 'straight ahead in the background');
  const parts = [];
  for (const side of ['north', 'south', 'east', 'west']) {
    const d = yawDelta(cam.yaw, bearing(cam.pos, mid[side]));
    if (Math.abs(d) > hf + 25) continue;   // 在镜头背后
    parts.push('The ' + side + ' wall, ' + pos(d) + ', is ' + desc(side) + '.');
  }
  const off = M.office;
  if (off) {
    const c = [(off.x0 + off.x1) / 2, (off.y0 + off.y1) / 2]; const d = yawDelta(cam.yaw, bearing(cam.pos, c));
    const inside = cam.pos[0] > off.x0 && cam.pos[0] < off.x1 && cam.pos[1] > off.y0 && cam.pos[1] < off.y1;
    if (!inside && Math.abs(d) <= hf + 8) parts.push("The black-framed glass manager's office is " + pos(d) + '; behind its glass there are only its own solid painted walls, never a window or an outdoor view.');
    else if (!inside) parts.push("The glass manager's office is out of view: there is no glass room anywhere in this picture.");
  }
  return parts.join(' ');
}

const where = (u) => (u == null ? '' : u < 0.36 ? 'on the left of the frame' : u > 0.64 ? 'on the right of the frame' : 'in the middle of the frame');

/** 关键帧提示词：画风 + 场景 + 这一刻 + 每个剧中人物「在画面哪儿、长得像第几张参考、穿什么」+ 墙和窗 + 桌面 / 人数禁令。 */
export function keyframePrompt({ style = '', sceneName = '', desc = '', cast = [], walls = '', generic = false }) {
  return [
    'Still frame from a high-end Chinese drama, ' + (style || 'realistic 3D CG render, realistic human proportions, real-world materials and lighting, subtle stylization') + '.',
    sceneName ? 'Location: ' + sceneName + '.' : '',
    desc ? 'This moment: ' + desc : '',
    ...(generic
      ? cast.map((c) => 'There is a ' + (c.pose === 'stand' ? 'standing' : 'seated') + ' young man ' + where(c.u) + ', wearing clothes in the colors of his control figure.')
      : cast.map((c, i) => c.name + ' is the ' + (c.pose === 'stand' ? 'standing' : 'seated') + ' person ' + where(c.u) + ' (the figure colored like his outfit in the control image); he has exactly the face, hair and outfit of reference image ' + (i + 1) + (c.desc ? ': ' + c.desc : '') + '. Nobody else wears this outfit.')),
    !generic && cast.length > 1 ? 'Never swap the two outfits: each person keeps only his own reference outfit.' : '',
    'Every other seated figure is an ordinary colleague in plain casual clothes, facing exactly the way the control figure faces (we see a face where the control figure has a nose). Exactly as many people as there are figures in the control image, each one where its figure is: keep every background colleague, add nobody.',
    walls,
    'Desks hold only a monitor, a keyboard, a mouse and at most a stack of kraft folders; no plants, no pen holders, no cups, no scissors, no papers on the floor.',
    'Keep every wall, desk, partition, monitor, person and opening exactly where the control lines put them. No text, no logos, no watermark.',
  ].filter(Boolean).join(' ');
}

/** 分步第二步：在一个剧中人物的占位框里只画他自己（只给他一张参考，不可能和别人对调）。 */
export function personPrompt(c, style = '') {
  return [
    'Still frame from a high-end Chinese drama, ' + (style || 'realistic 3D CG render, realistic human proportions, real-world materials and lighting, subtle stylization') + '.',
    'In the marked area there is exactly one person: ' + c.name + ', ' + (c.pose === 'stand' ? 'standing' : 'seated') + ', with exactly the face, hair and outfit of reference image 1' + (c.desc ? ' (' + c.desc + ')' : '') + '.',
    'Keep his position, body size, pose and facing exactly as the control figure in the marked area; keep the desk, partition and chair around him; everything outside the marked area stays unchanged. No text, no logos.',
  ].join(' ');
}

const growBox = (b, k = 0.04) => (b ? [Math.max(0, b[0] - k), Math.max(0, b[1] - k), Math.min(1, b[2] + k), Math.min(1, b[3] + k)] : null);

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
  const cast = castOfShot(ctx.projectId, shot);
  const refByName = new Map(cast.map((c) => [c.name, c.refAbs]));
  const rigR = { ...rig, people: arr(rig.people).map((p) => (refByName.get(p.role) ? { ...p, ref: refByName.get(p.role) } : p)) };
  const rendered = await (deps.renderRig || renderRig)(ctx.projectId, shotId, rigR, { cfg: ctx.cfg });
  say('灰模已渲：' + rendered.dir);
  const project = Projects.get(ctx.projectId) || {};
  const openings = arr(M.openings).map((o) => (o.name || o.id) + '（' + (o.side || '') + (o.kind ? '，' + o.kind : '') + '）');
  const review = { lead_in: li.on, want, first: null, last: null, at: Date.now() };
  for (const which of ['first', 'last']) {
    if (!want[which]) continue;
    const views = rendered[which];
    const meta = (rendered.meta && rendered.meta[which]) || {};
    const inFrame = new Set(arr(meta.people_in_frame).map((p) => p.role));
    const seen = arr(meta.people_in_frame);
    const castHere = cast.filter((c) => inFrame.has(c.name)).map((c) => {
      const m = seen.find((p) => p.role === c.name) || {};
      const rp = arr(rig.people).find((p) => p.role === c.name && (!p.only || p.only === which)) || {};
      return { ...c, u: m.u, pose: rp.pose };
    });
    // 分步出图（试点：一次塞两张人物参考会对调服装）：① 场景 + 背景人，剧中人物只当普通人占位，不给人物参考；
    // ② 每个剧中人物在自己的占位框里局部重画，每次只给他自己的一张参考。
    const scenePrompt = keyframePrompt({ style: project.style, sceneName: M.name, desc: (rig[which] && rig[which].desc) || '', cast: castHere, walls: wallsNote(M), generic: true });
    const size = (rendered.meta && rendered.meta[which] && rendered.meta[which].size) || [1280, 720];
    const gen = deps.generateKeyframe || generateKeyframe;
    const cands = [];
    for (const seed of seeds) {
      let g = await gen(ctx.cfg, ctx.projectId, shotId, which, views, { prompt: scenePrompt, refAbs: [], seed, size, tag: 'scene', jobId: ctx.jobId, isAborted: ctx.isAborted });
      for (const [ci, c] of castHere.entries()) {
        const m = seen.find((p) => p.role === c.name);
        if (!c.refAbs || !m || !m.box) continue;
        g = await gen(ctx.cfg, ctx.projectId, shotId, which, views, { prompt: personPrompt(c, project.style), refAbs: [c.refAbs], seed: seed + ci + 1, size, init: g.rel, mask: growBox(m.box), denoise: 1.0, tag: 'p' + (ci + 1), jobId: ctx.jobId, isAborted: ctx.isAborted });
      }
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
