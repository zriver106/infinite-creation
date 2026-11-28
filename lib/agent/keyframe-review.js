// 首尾帧控制 S4（最小版）：一张关键帧交视频模型前的审图。视觉模型按临时规则「首尾帧控制审图」第三节五条给结论，
// 不自动修、不换种子（第二批再做）。结论存 shots.keyframe_review，审过才允许挂到首/尾帧槽位。
import fs from 'node:fs';
import { imageToDataUrl } from '../core/index.js';
import { buildVisionUserMessage, extractJson } from '../core/llm.js';
import { brainChat } from './brain.js';

export const REVIEW_KEYS = Object.freeze(['openings', 'costume', 'faces', 'props', 'positions']);
const KEY_NAME = { openings: '门窗开口', costume: '服装颜色', faces: '背景人', props: '桌面物件与道具', positions: '人物位置' };

/** 审图提示词（纯函数，测试直接看）。 */
export function reviewPrompt({ which, openings = [], costumes = [], props = [], people = [], sceneName = '' }) {
  const lines = [];
  lines.push('你是首尾帧审图员，只看图、只按下面五条判，任何一条不过就整张不过。图 1 是待审的' + (which === 'last' ? '尾帧' : '首帧') + '，图 2 是同机位从空间母本渲出的灰模（结构以它为准）' + (costumes.length ? '，之后依次是人物定妆图' : '') + '。');
  if (sceneName) lines.push('场景：' + sceneName + '。');
  lines.push('1. 门窗开口（openings）：画面里每个门、窗、玻璃开口都要能在母本门窗清单里找到；母本里没有的开口，哪怕只是像窗，一律不过；玻璃隔断后面透出室外景色、母本里那面墙不是外窗的，也不过。母本门窗清单：' + (openings.length ? openings.join('；') : '（清单为空：画面里出现任何窗都不过）'));
  lines.push('2. 服装颜色（costume）：每个剧中人物的服装颜色、款式对照定妆图逐项比，偏色（例如灰蓝出成纯灰）就不过。人物：' + (costumes.length ? costumes.map((c, i) => c.name + '（定妆图 ' + (i + 3) + '）：' + (c.desc || '')).join('；') : '（无剧中人物）'));
  lines.push('3. 背景人（faces）：不能有糊脸、马赛克脸、缺五官；朝向要和灰模里人形占位一致（占位有鼻子的一面是脸）；人数和灰模一致，多出来或少了人都不过（被隔断、显示器挡住大半看不见的不算少）。个别在画面边缘、很小的朝向偏差记在 note 里但可以判过；挡在主角身后或画面中间的不过。');
  lines.push('4. 桌面物件与道具（props）：只拦两类——剧情道具的位置或数量不对（落到别人桌上、多了少了）；多出来的大件或家具（柜子、绿植盆栽、白板这类灰模里没有的大东西）。桌面上的常规办公小物件（纸、杯子、笔、文件夹、键盘鼠标）一律放过，不算不过。本镜剧情道具：' + (props.length ? props.join('；') : '（无）'));
  lines.push('5. 人物位置（positions）：剧中人物站或坐的位置、朝向和灰模占位一致。占位在画面里的横向位置（0＝最左，1＝最右）：' + (people.length ? people.map((p) => p.role + ' u=' + p.u).join('；') : '（无剧中人物）'));
  lines.push('只输出 JSON：{"verdict":"pass|fail","items":[{"key":"openings|costume|faces|props|positions","ok":true|false,"note":"一句话，写在画面哪里、错成什么"}],"fix":[{"key":"…","box":[x0,y0,x1,y1],"want":"该改成什么"}]}，box 用 0–1 的画面比例；过的项 note 可空。');
  return lines.join('\n');
}

/** 结论规整：五项缺了算不过；verdict 以各项为准（模型自己写 pass 但有一项不过，按不过）。 */
export function normalizeReview(raw) {
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  const byKey = new Map(items.filter((x) => x && REVIEW_KEYS.includes(x.key)).map((x) => [x.key, { key: x.key, ok: x.ok === true, note: String(x.note || '') }]));
  const out = REVIEW_KEYS.map((k) => byKey.get(k) || { key: k, ok: false, note: '审图没给这一项的结论' });
  return { verdict: out.every((x) => x.ok) ? 'pass' : 'fail', items: out, fix: Array.isArray(raw && raw.fix) ? raw.fix : [], failed: out.filter((x) => !x.ok).map((x) => KEY_NAME[x.key] + (x.note ? '：' + x.note : '')) };
}

const dataUrl = (abs) => { const im = abs && fs.existsSync(abs) ? imageToDataUrl(abs) : null; return im ? 'data:' + im.mimeType + ';base64,' + im.data : ''; };

/**
 * 审一张关键帧。
 * @param ctx { cfg }   @param inp { which, imageAbs, grayAbs, openings, costumes:[{name,desc,refAbs}], props, people, sceneName }
 */
export async function reviewKeyframe(ctx, inp, deps = {}) {
  const chat = deps.brainChat || brainChat;
  const images = [dataUrl(inp.imageAbs), dataUrl(inp.grayAbs), ...(inp.costumes || []).map((c) => dataUrl(c.refAbs))].filter(Boolean);
  if (!images[0]) throw new Error('待审关键帧不存在：' + inp.imageAbs);
  const r = await chat(ctx.cfg, [
    { role: 'system', content: '你是短剧首尾帧审图员。严格按给出的五条判，只输出 JSON。' },
    buildVisionUserMessage(reviewPrompt(inp), images),
  ], { json: true, temperature: 0.1, maxTokens: 1500 });
  let parsed = null;
  try { parsed = extractJson(r.content || ''); } catch { parsed = null; }
  if (!parsed) return { verdict: 'fail', items: REVIEW_KEYS.map((k) => ({ key: k, ok: false, note: '' })), fix: [], failed: ['审图输出读不出 JSON'], raw: String(r.content || '').slice(0, 500), at: Date.now() };
  return { ...normalizeReview(parsed), at: Date.now() };
}
