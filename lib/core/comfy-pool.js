import fs from 'node:fs';
import { enabledComfyEndpoints } from '../shared/index.js';
import { normBaseUrl, sleep } from './utils.js';
import { logger } from './logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// 本地 ComfyUI 端点池（多显卡）
//
// 每张显卡跑一个 ComfyUI 实例（各自端口、--cuda-device 绑卡）。ComfyUI 原生单执行队列，
// 所以「一个端点同一时刻只给它一个我们的渲染」：
//   · 渲染槽位上限 = 启用端点数（render-gate.renderConcurrencyLimit）；
//   · 每个槽位在这里再借一个**空闲**端点，提交 → 等完成 → 归还；
//   · 产物下载必须回到产出它的端点（各实例 output 目录独立），所以 outputs 带 endpoint 标记；
//   · 参考图/音频按需补传：uploadTaskInput 先传到一个端点并登记「文件名 → 本地路径 + 内容签名」，
//     渲染派到别的端点时，提交前把工作流里引用到、该端点还没有的文件补传过去。
//
// 失败隔离：一个端点在**提交前**（补传参考 / POST /prompt）连不上或超时 → 该端点冷却 COOLDOWN_MS，
// 本次渲染立即改派其它端点（任务还没进 ComfyUI，改派不会重复出片）。提交之后的失败（执行出错、
// 任务丢失、生成超时）原样抛给上层，由既有重试/收尾逻辑处理，不在这里重提，避免同一镜双份。
// 冷却只是「优先避开」：没有其它端点可用时仍会去探测冷却中的端点，坏端点恢复后自动回到调度里。
//
// 状态挂 globalThis（与 render-gate 同理：Next 会为不同 route 各打包一份模块）。
// 单端点配置下：永远只有那一个端点，行为与改动前一致（同一地址、同一串行语义）。
// ─────────────────────────────────────────────────────────────────────────────

export const COOLDOWN_MS = 60_000;
const INPUT_REGISTRY_MAX = 5000;

const POOL_KEY = '__infiniteCreationComfyPool';
const pool = (globalThis[POOL_KEY] = globalThis[POOL_KEY] || { eps: new Map(), inputs: new Map(), dispatches: 0, failovers: 0 });

function stateOf(url) {
  let s = pool.eps.get(url);
  if (!s) {
    s = { busy: 0, failStreak: 0, coolUntil: 0, lastError: '', lastErrorAt: 0, done: 0, uploaded: new Map() };
    pool.eps.set(url, s);
  }
  return s;
}

/** 当前配置下参与调度的本地端点（含规范化地址 url）。 */
export function poolEndpoints(cfg) {
  return enabledComfyEndpoints(cfg?.comfyui).map((e) => ({ ...e, url: normBaseUrl(e.baseUrl) }));
}

/** 第一个启用端点的地址（老语义的「那一个 ComfyUI」：上传首选、无标记产物的下载兜底）。 */
export function primaryEndpointUrl(cfg) {
  const eps = poolEndpoints(cfg);
  return eps.length ? eps[0].url : normBaseUrl(cfg?.comfyui?.baseUrl || '');
}

/** comfyFetch 抛出的「连不上 / 无响应」两类错误：端点级故障，可以改派。 */
export function isEndpointDownError(e) {
  const m = String(e?.message || '');
  return /无法连接 ComfyUI|ComfyUI 响应超时/.test(m);
}

function markDown(url, err) {
  const s = stateOf(url);
  s.failStreak += 1;
  s.coolUntil = Date.now() + COOLDOWN_MS;
  s.lastError = String(err?.message || err || '').slice(0, 300);
  s.lastErrorAt = Date.now();
}

function markUp(url) {
  const s = stateOf(url);
  s.failStreak = 0;
  s.coolUntil = 0;
}

// —— 参考文件登记与按需补传 ——
function fileSig(localPath) {
  try {
    const st = fs.statSync(localPath);
    return st.size + ':' + Math.round(st.mtimeMs);
  } catch {
    return 'nostat:' + Date.now();
  }
}

/** 登记一次上传（uploadTaskInput 调）：之后派到任何端点都能按需补传。 */
export function registerInput(filename, localPath) {
  if (!filename || !localPath) return null;
  const rec = { localPath, sig: fileSig(localPath) };
  pool.inputs.delete(filename);
  pool.inputs.set(filename, rec);
  while (pool.inputs.size > INPUT_REGISTRY_MAX) pool.inputs.delete(pool.inputs.keys().next().value);
  return rec;
}

/** 标记某端点已有该文件（当前签名）。 */
export function markUploaded(url, filename) {
  const rec = pool.inputs.get(filename);
  if (rec) stateOf(url).uploaded.set(filename, rec.sig);
}

const MEDIA_FIELDS = ['image', 'audio', 'file', 'video'];

/** 工作流里引用到、且在登记表里的输入文件名。 */
export function referencedInputs(workflow) {
  const names = new Set();
  for (const node of Object.values(workflow || {})) {
    const inputs = node && node.inputs;
    if (!inputs) continue;
    for (const f of MEDIA_FIELDS) {
      const v = inputs[f];
      if (typeof v === 'string' && pool.inputs.has(v)) names.add(v);
    }
  }
  return [...names];
}

/** 把工作流引用到、目标端点还没有（或内容已变）的输入文件补传过去。upload = (url, localPath, filename) => Promise。 */
export async function ensureInputsOn(url, workflow, upload) {
  const s = stateOf(url);
  for (const name of referencedInputs(workflow)) {
    const rec = pool.inputs.get(name);
    if (!rec || s.uploaded.get(name) === rec.sig) continue;
    await upload(url, rec.localPath, name);
    s.uploaded.set(name, rec.sig);
  }
}

// —— 端点挑选 ——
// 规则：未试过的端点里，优先「空闲 + 不在冷却」（按配置顺序）；没有的话，只要还有忙着的端点就等它空出来；
// 剩下的全是「空闲但冷却中」→ 探测冷却最早结束的那个（否则单端点冷却时任务会一直卡住）。
function pick(eps, tried) {
  const now = Date.now();
  const cands = eps.filter((e) => !tried.has(e.url));
  if (!cands.length) return { done: true };
  const idleHealthy = cands.find((e) => stateOf(e.url).busy === 0 && stateOf(e.url).coolUntil <= now);
  if (idleHealthy) return { ep: idleHealthy };
  if (cands.some((e) => stateOf(e.url).busy > 0)) return { wait: true };
  const cooling = cands.filter((e) => stateOf(e.url).busy === 0).sort((a, b) => stateOf(a.url).coolUntil - stateOf(b.url).coolUntil);
  return cooling.length ? { ep: cooling[0] } : { wait: true };
}

/**
 * 借一个空闲端点执行 fn(ep, ctl)。fn 在真正把任务交给 ComfyUI 后必须调 ctl.submitted()。
 * 提交前的端点故障自动改派；全部端点都试过仍失败时抛最后一个错误。
 * @param {object} cfg
 * @param {(ep: {id:string,name:string,baseUrl:string,gpu:string,url:string}, ctl: {submitted: () => void}) => Promise<any>} fn
 * @param {{ isAborted?: () => boolean, pollMs?: number, what?: string }} [opts]
 */
export async function withEndpoint(cfg, fn, { isAborted, pollMs = 300, what = '' } = {}) {
  const eps = poolEndpoints(cfg);
  if (!eps.length) throw new Error('没有启用的本地 ComfyUI 端点：请在「设置 → ComfyUI 服务」至少启用一个端点。');
  const tried = new Set();
  let lastErr = null;
  for (;;) {
    if (isAborted && isAborted()) throw new Error('任务已停止');
    const p = pick(eps, tried);
    if (p.done) throw lastErr || new Error('所有 ComfyUI 端点都不可用');
    if (p.wait) { await sleep(pollMs); continue; }
    const ep = p.ep;
    const s = stateOf(ep.url);
    s.busy += 1;
    pool.dispatches += 1;
    let submitted = false;
    try {
      const r = await fn(ep, { submitted: () => { submitted = true; } });
      markUp(ep.url);
      s.done += 1;
      return r;
    } catch (e) {
      if (isEndpointDownError(e)) {
        markDown(ep.url, e);
        tried.add(ep.url);
        if (!submitted && eps.some((x) => !tried.has(x.url))) {
          lastErr = e;
          pool.failovers += 1;
          logger.warn('ComfyUI 端点不可用，本次渲染改派其它端点', { endpoint: ep.url, gpu: ep.gpu, what, error: String(e.message || e).slice(0, 200) });
          continue;
        }
      }
      throw e;
    } finally {
      s.busy -= 1;
    }
  }
}

/** 诊断 / 设置页展示：各端点忙闲、冷却、最近错误。 */
export function poolStatus(cfg) {
  const now = Date.now();
  return {
    dispatches: pool.dispatches,
    failovers: pool.failovers,
    endpoints: poolEndpoints(cfg).map((e) => {
      const s = stateOf(e.url);
      return {
        id: e.id, name: e.name, baseUrl: e.baseUrl, gpu: e.gpu,
        busy: s.busy, done: s.done,
        cooling: s.coolUntil > now, coolMsLeft: Math.max(0, s.coolUntil - now),
        failStreak: s.failStreak, lastError: s.lastError,
      };
    }),
  };
}

/** 仅供单测：清空端点状态与登记表。 */
export function _resetPoolForTests() {
  pool.eps.clear();
  pool.inputs.clear();
  pool.dispatches = 0;
  pool.failovers = 0;
}
