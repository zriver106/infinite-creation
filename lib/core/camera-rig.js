// 首尾帧控制（总导 11-28；临时规则 docs/临时规则/首尾帧控制审图_临时规则.md）：一镜的「机位落位」数据与校验。
//
// camera_rig（存在 shots.camera_rig，JSON 原文）：
//   { scene_id,                                   // 场景母本 id（scene_master/<scene_id>.json）
//     first: { pos:[x,y], eye, yaw, pitch, lens_mm },   // 首帧机位
//     last:  { ... } | null,                     // 尾帧机位（没有＝只锁首帧）
//     people: [{ x, y, yaw, pose:'sit'|'stand', role:'lead'|'bg'|<人物名>, asset_id?, col?, only?:'first'|'last' }] | null,
//             // null＝母本座位全部坐满（背景同事），剧中人物另外列出
//     expect: [{ at:[x,y] | what, side:'left'|'right'|'center', in:'first'|'last'|'both', note }],  // 画左画右该有什么（来自镜头说明）
//     note }                                     // 落位依据（镜头说明原句、站位点）
// 坐标：米，X 东、Y 北、Z 上；朝向一律用母本的罗盘角（0=北、90=东），和母本 seats.yaw 一致。
//
// 这里只放纯函数（解析、校验、几何），不碰数据库和 GPU；渲染在 scene-render.js，出图在 keyframe-gen.js。

export const RIG_LIMITS = Object.freeze({
  wall_margin: 0.25,     // 机位离墙至少这么远
  body_clear: 0.35,      // 机位离人形占位中心至少这么远（别把相机塞进人身上）
  move_max: 1.6,         // 首尾机位相距上限（米）：临时规则「首尾差 1–1.5 米」，超过就是两张不同的画面，模型会变形 / 叠化
  move_warn: 1.5,
  yaw_turn_max: 45,      // 首尾朝向差上限（度）
  lens_min: 18, lens_max: 85,
  eye_min: 0.3, eye_max: 3.5,
  frame_fill: 0.76,      // 剧中人物要在画面里、离边缘留够余量（横向约 0.12–0.88）：试点里 u≈0.92 的人在成图里直接丢了
});

/**
 * 分镜里写的机位角度（Andy 11-28「不要平视，这个根本不符合镜头角度要求」）：俯拍 / 仰拍 / 平视。
 * 同一句里先出现哪个算哪个（「特写拍桌切仰视中景」→ 仰）。没写返回 ''。
 */
export function angleOf(text) {
  const t = String(text || '');
  const m = t.match(/俯拍|俯视|俯瞰|鸟瞰|顶拍|高机位|仰拍|仰视|仰角|低机位|低角度|平视/);
  if (!m) return '';
  return /俯|鸟瞰|顶拍|高机位/.test(m[0]) ? 'high' : /仰|低机位|低角度/.test(m[0]) ? 'low' : 'eye';
}
export const ANGLE_RULE = Object.freeze({
  high: { test: (c) => Number(c.pitch) <= -10, need: '俯拍：pitch ≤ −10°（一般 −20 到 −45），机位高于人眼' },
  low: { test: (c) => Number(c.pitch) >= 5 && Number(c.eye || 1.45) <= 1.2, need: '仰拍：pitch ≥ +5°（一般 +10 到 +25），机位低（≤1.2 米）' },
  eye: { test: (c) => Math.abs(Number(c.pitch || 0)) <= 6, need: '平视：|pitch| ≤ 6°' },
});

export function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}
export const rigOf = (shot) => parseJson(shot && shot.camera_rig, null);
export const keyframeReviewOf = (shot) => parseJson(shot && shot.keyframe_review, null);

/** 罗盘角（0=北、90=东）→ 平面单位向量 [东, 北]。 */
export function dirOf(yaw) {
  const a = (Number(yaw) || 0) * Math.PI / 180;
  return [Math.sin(a), Math.cos(a)];
}
/** 两个罗盘角之差，结果在 (-180, 180]。正数＝b 在 a 的顺时针方向（右手边）。 */
export function yawDelta(a, b) {
  let d = ((Number(b) - Number(a)) % 360 + 360) % 360;
  return d > 180 ? d - 360 : d;
}
/** 从 p 看向 q 的罗盘角。 */
export function bearing(p, q) {
  const dx = q[0] - p[0]; const dy = q[1] - p[1];
  return ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
}
/** 横向视场角（全画幅 36 mm 宽）。 */
export const hfovOf = (lens) => 2 * Math.atan(18 / (Number(lens) || 28)) * 180 / Math.PI;

/**
 * 某点在这一机位画面里的横向位置：u∈[0,1]（0＝画左边缘、1＝画右边缘）；在镜头背后或出画返回 inFrame=false。
 * 只看水平方向（落位校验够用；精确投影在 rig_render.py 的 meta.json 里）。
 */
export function screenSide(cam, pt, limits = RIG_LIMITS) {
  const d = yawDelta(cam.yaw, bearing(cam.pos, pt));     // 正数＝在镜头朝向的右边
  const half = hfovOf(cam.lens_mm) / 2;
  const behind = Math.abs(d) > 90;
  const u = 0.5 + Math.tan(d * Math.PI / 180) / Math.tan(half * Math.PI / 180) / 2;
  const inFrame = !behind && Math.abs(d) <= half * limits.frame_fill;
  return { delta: d, u: behind ? null : Math.round(u * 1000) / 1000, inFrame, side: behind ? 'behind' : (u < 0.4 ? 'left' : u > 0.6 ? 'right' : 'center') };
}

/** 母本里的实体方块（平面投影）：工位桌、隔断、经理室桌、带 box 的固定物。用于「相机别卡在家具里」。 */
export function solidBoxes(M) {
  const out = [];
  const ws = M && M.workstations;
  if (ws && Array.isArray(ws.rows) && Array.isArray(ws.cols) && ws.desk) {
    const w = Number(ws.desk.w) || 1.4; const d = Number(ws.desk.d) || 0.7;
    for (const r of ws.rows) for (const c of ws.cols) out.push({ id: 'WS-' + r.id + '-' + c.id, x0: c.x - w / 2, x1: c.x + w / 2, y0: r.y - d / 2, y1: r.y + d / 2 });
  }
  for (const f of (M && M.office && M.office.furniture) || []) {
    if (!(f.w && f.d)) continue;
    const [hw, hd] = (f.yaw === 90 || f.yaw === 270) ? [f.d / 2, f.w / 2] : [f.w / 2, f.d / 2];
    out.push({ id: f.id, x0: f.x - hw, x1: f.x + hw, y0: f.y - hd, y1: f.y + hd });
  }
  for (const it of (M && M.items) || []) {
    const b = it.box;
    if (!(Array.isArray(b) && b.length >= 6)) continue;
    const z0 = Math.min(b[2], b[5]); const z1 = Math.max(b[2], b[5]);
    if (z1 <= 0.05 || z0 >= 2.0) continue;   // 地面 / 平台面（站在上面）和头顶的雨棚、吊顶不算挡机位
    out.push({ id: it.id, x0: Math.min(b[0], b[3]), x1: Math.max(b[0], b[3]), y0: Math.min(b[1], b[4]), y1: Math.max(b[1], b[4]) });
  }
  return out;
}

const camKeys = ['first', 'last'];

/**
 * 校验机位：返回 { ok, errors:[...], warnings:[...], frame:{ first:[{role,side,u,inFrame}], last:[...] } }。
 * errors 任一条 → 不能拿去渲染；warnings 只提示。
 * @param M     场景母本（scene_master/<id>.json 的内容）
 * @param rig   camera_rig
 * @param opts  { prevRig }：本镜承接上一镜 22 帧时传上一镜的机位，首机位必须接上上一镜尾机位
 */
export function validateRig(M, rig, { prevRig = null, limits = RIG_LIMITS } = {}) {
  const errors = []; const warnings = []; const frame = {};
  if (!rig || typeof rig !== 'object') return { ok: false, errors: ['没有机位数据'], warnings, frame };
  if (!rig.first) errors.push('缺首帧机位 first');
  const R = (M && M.room) || null;
  const boxes = solidBoxes(M);
  const people = Array.isArray(rig.people) ? rig.people : [];
  for (const k of camKeys) {
    const c = rig[k];
    if (!c) continue;
    const name = k === 'first' ? '首帧机位' : '尾帧机位';
    if (!Array.isArray(c.pos) || c.pos.length < 2 || !c.pos.every((v) => Number.isFinite(Number(v)))) { errors.push(name + '缺 pos:[x,y]'); continue; }
    const [x, y] = c.pos.map(Number);
    if (!Number.isFinite(Number(c.yaw))) errors.push(name + '缺朝向 yaw（罗盘角，0＝北）');
    const lens = Number(c.lens_mm || 28); const eye = Number(c.eye || 1.45);
    if (lens < limits.lens_min || lens > limits.lens_max) errors.push(name + '焦段 ' + lens + 'mm 超出 ' + limits.lens_min + '–' + limits.lens_max);
    if (eye < limits.eye_min || eye > limits.eye_max) errors.push(name + '机位高度 ' + eye + 'm 超出 ' + limits.eye_min + '–' + limits.eye_max);
    if (R && Number(R.h) && eye > Number(R.h) - 0.15) errors.push(name + '机位高度 ' + eye + 'm 碰到天花板（层高 ' + R.h + 'm），要低于 ' + (Number(R.h) - 0.15).toFixed(2) + 'm');
    const pitch = Number(c.pitch || 0); const roll = Number(c.roll || 0);
    if (pitch < -80 || pitch > 60) errors.push(name + '俯仰 ' + pitch + '° 超出 −80 到 +60');
    if (Math.abs(roll) > 30) errors.push(name + '滚转 ' + roll + '° 超出 ±30');
    const ang = (c.angle || rig.angle || '');
    if (ANGLE_RULE[ang] && !ANGLE_RULE[ang].test({ ...c, eye })) errors.push(name + '角度和分镜不符：分镜是' + ({ high: '俯拍', low: '仰拍', eye: '平视' }[ang]) + '，要求 ' + ANGLE_RULE[ang].need + '；现在 eye=' + eye + 'm、pitch=' + pitch + '°');
    if (R) {
      const m = limits.wall_margin;
      if (x < R.x0 + m || x > R.x1 - m || y < R.y0 + m || y > R.y1 - m) errors.push(name + ' (' + x + ',' + y + ') 不在房间里或贴墙（房间 ' + R.x0 + '–' + R.x1 + ' × ' + R.y0 + '–' + R.y1 + '）');
    }
    for (const b of boxes) if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) errors.push(name + '卡在 ' + b.id + ' 里');
    for (const p of people) {
      if (p.only && p.only !== k) continue;
      if (Math.hypot(p.x - x, p.y - y) < limits.body_clear) errors.push(name + '离人物占位 ' + (p.role || '') + '（' + p.x + ',' + p.y + '）太近');
    }
    frame[k] = people.filter((p) => !p.only || p.only === k).filter((p) => p.role && p.role !== 'bg')
      .map((p) => ({ role: p.role, ...screenSide({ pos: [x, y], yaw: Number(c.yaw), lens_mm: lens }, [p.x, p.y]) }));
    // 列进 people 的剧中人物就是这一帧要拍到的人：不在画里算错（故意不入画的标 offscreen:true）
    for (const f of frame[k]) {
      const p = people.find((q) => q.role === f.role && (!q.only || q.only === k));
      if (!f.inFrame && !(p && p.offscreen)) errors.push(name + '：' + f.role + ' 不在画里（在' + ({ left: '画左外', right: '画右外', behind: '镜头背后' }[f.side] || f.side) + '）；转机位或改焦段把人拍进来，故意不入画的标 offscreen:true');
    }
  }
  if (rig.first && rig.last && Array.isArray(rig.first.pos) && Array.isArray(rig.last.pos)) {
    const dist = Math.hypot(rig.first.pos[0] - rig.last.pos[0], rig.first.pos[1] - rig.last.pos[1]);
    const turn = Math.abs(yawDelta(rig.first.yaw, rig.last.yaw));
    if (dist > limits.move_max) errors.push('首尾机位相距 ' + dist.toFixed(2) + ' 米，超过 ' + limits.move_max + ' 米（按真实运镜路线设，差 1–1.5 米；差太远模型会变形或叠化）');
    else if (dist > limits.move_warn) warnings.push('首尾机位相距 ' + dist.toFixed(2) + ' 米，偏远');
    if (turn > limits.yaw_turn_max) errors.push('首尾朝向差 ' + turn.toFixed(0) + '°，超过 ' + limits.yaw_turn_max + '°');
  }
  for (const e of Array.isArray(rig.expect) ? rig.expect : []) {
    if (!Array.isArray(e.at) || !e.side) continue;
    if (!['left', 'right', 'center', 'behind'].includes(e.side)) { errors.push('expect 的 side 只能是 left / right / center / behind：' + (e.note || JSON.stringify(e.at)) + ' 写了 ' + e.side); continue; }
    for (const k of (e.in === 'both' || !e.in) ? camKeys : [e.in]) {
      const c = rig[k]; if (!c || !Array.isArray(c.pos)) continue;
      const s = screenSide({ pos: c.pos, yaw: Number(c.yaw), lens_mm: Number(c.lens_mm || 28) }, e.at);
      const okSide = e.side === 'behind' ? s.side === 'behind' : (s.side === e.side || (e.side !== 'center' && s.side === 'center' && Math.abs(s.u - 0.5) > 0.05 && ((s.u < 0.5) === (e.side === 'left'))));
      if (!okSide) errors.push((k === 'first' ? '首帧' : '尾帧') + '：' + (e.note || e.what || JSON.stringify(e.at)) + ' 应在' + ({ left: '画左', right: '画右', center: '画中', behind: '镜头背后' }[e.side] || e.side) + '，实际在' + ({ left: '画左', right: '画右', center: '画中', behind: '镜头背后' }[s.side] || s.side));
    }
  }
  if (prevRig && prevRig.last && rig.first) {
    const d = Math.hypot(prevRig.last.pos[0] - rig.first.pos[0], prevRig.last.pos[1] - rig.first.pos[1]);
    const t = Math.abs(yawDelta(prevRig.last.yaw, rig.first.yaw));
    if (d > 0.3 || t > 10) errors.push('本镜承接上一镜 22 帧：首机位要接上上一镜的尾机位（现在差 ' + d.toFixed(2) + ' 米、' + t.toFixed(0) + '°）');
  }
  return { ok: errors.length === 0, errors, warnings, frame };
}

/**
 * 承接上一镜 22 帧时首尾帧怎么用（S6）：承接占第 0 帧（画面 + 声音连续），机位首帧不锚，只锚尾帧（最后一帧）。
 * 不承接（场首、换场、跳时、分镜设了不接）才锚首帧。
 * @param leadInOn  leadInDecision(...).on（且 generation.leadInAuto 没关掉自动承接）
 */
export function anchorsFor(rig, leadInOn) {
  if (!rig || !rig.first) return { first: false, last: false };
  return { first: !leadInOn, last: !!rig.last };
}

/** 首尾帧文件在项目里的相对路径（frames/rig/<shotId>/…）。 */
export function rigRel(shotId, ...parts) {
  return ['frames', 'rig', String(shotId)].concat(parts).join('/');
}
