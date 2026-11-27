import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DATA_DIR } from './config.js';
import { enabledComfyEndpoints } from '../shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// 渲染槽位闸门
//
// 两级、彼此独立，避免嵌套获取导致死锁：
//
//   1) 任务闸门 runExclusiveVideo —— 同一时刻只允许一个「整条流水线任务」在跑。
//      保留排队/超时/取消语义（前端能看到「排队中」），也避免多个 Agent 会话同时
//      压 LLM（每个任务在文本阶段也要几十次模型调用）。
//
//   2) 渲染项闸门 runRenderSlot —— 每次真正向 ComfyUI / RunningHub 提交渲染占一个槽。
//      这才是并发的来源：一个任务内的多个镜头/资产可以同时提交，上限由
//      concurrencyLimit() 决定。
//
// 为什么分两级：若两级共用一个信号量，任务持槽后子任务再去获取，limit=1 时必然死锁。
// 分开之后任务层永远只有一个持有者，渲染层独立限流，语义清晰。
//
// 状态挂 globalThis：Next.js（含 dev）会为不同 route 各打包一份本模块，
// 模块级变量会让两条 route 各自以为槽位空闲 → 真并发。
//
//   3) 文本闸门 runExclusiveText（双队列，2026-11-16 总导批准）—— 只给「只拆分镜」的纯文本 job
//      （renderDisabled）用，容量 1，和 1) 互相独立：一条分镜 job 可以和一条出片 job 同时跑。
//      硬条件：文本闸门里的任务**绝不能和出片同时占显卡**。所以文本 job 的任务体运行在
//      「文本通道」上下文里，底层每一个碰 GPU / 8189 的入口都调 withGpuAccess：
//        - 文本通道 → 按次重新获取 1) 的任务闸门（和出片 job 同一把锁、同一条 FIFO），用完即还；
//        - 文本 job 的 MCP 子进程（看不到主进程的闸门）→ 直接拒绝；
//        - 其它调用方 → 原样执行（行为与改动前一致）。
//      锁顺序恒为「任务闸门 → 渲染项闸门」，与出片 job 相同；出片 job 从不获取文本闸门 → 不会死锁。
//      调用点清单见 草稿\…\12_界面五项\实现\GPU调用点清单.md。
// ─────────────────────────────────────────────────────────────────────────────

const JOB_GATE_KEY = '__infiniteCreationVideoGate';
const RENDER_GATE_KEY = '__infiniteCreationRenderGate';
const TEXT_GATE_KEY = '__infiniteCreationTextGate';
const TEXT_LANE_KEY = '__infiniteCreationTextLane';
const WRITE_GATE_KEY = '__infiniteCreationWriteGate';

const jobGate = (globalThis[JOB_GATE_KEY] = globalThis[JOB_GATE_KEY] || { slots: 0, queue: [] });
const renderGate = (globalThis[RENDER_GATE_KEY] = globalThis[RENDER_GATE_KEY] || { slots: 0, queue: [] });
const textGate = (globalThis[TEXT_GATE_KEY] = globalThis[TEXT_GATE_KEY] || { slots: 0, queue: [] });
// 2026-11-26（Andy「不涉及 gpu 的改动都可以同步去做」）：提示词撰写单独一个闸门，不同章可并行；拆分镜仍走 textGate（容量 1）。
const writeGate = (globalThis[WRITE_GATE_KEY] = globalThis[WRITE_GATE_KEY] || { slots: 0, queue: [] });
// 2026-11-26（Andy「剧本和资产多开几个会话同步进行，别耽误 gpu」）：写稿闸门按类型分开（script / storyboard / prompt / asset / review），各自容量
const WRITE_GATES_KEY = '__infiniteCreationWriteGates';
const writeGates = (globalThis[WRITE_GATES_KEY] = globalThis[WRITE_GATES_KEY] || {});
function gateOf(key) { if (!key) return writeGate; return (writeGates[key] = writeGates[key] || { slots: 0, queue: [] }); }

// 文本通道：ALS 上下文 + jobId 登记表（ALS 万一在第三方 SDK 里丢了上下文，按 jobId 还能认出来）。
// borrows / waits 只做诊断计数（冒烟时核对「文本任务是否等过渲染闸门」）。
const textLane = (globalThis[TEXT_LANE_KEY] = globalThis[TEXT_LANE_KEY] || {
  als: new AsyncLocalStorage(),
  jobs: new Map(),
  borrows: 0,
  waits: 0,
  denied: 0,
  log: [],
});

// 文本 job 的 MCP 子进程：IC_MCP_RENDER_DISABLED 只写进子进程 env（mcp-config.js mcpEnv），主进程永远没有。
// 子进程里的闸门是它自己的一份，借不到主进程的任务闸门 → 碰 GPU 一律拒绝。
const isTextSubprocess = () => process.env.IC_MCP_RENDER_DISABLED === '1';

function laneNote(kind, jobId, what) {
  try {
    textLane.log.push({ t: Date.now(), kind, jobId: jobId || '', what: what || '' });
    if (textLane.log.length > 200) textLane.log.splice(0, textLane.log.length - 200);
  } catch { /* 诊断失败不影响 */ }
}

function gpuDenied(what) {
  textLane.denied++;
  laneNote('denied', process.env.IC_MCP_JOB_ID || '', what);
  return Object.assign(
    new Error('分镜任务（只跑文本）不能使用显卡：' + (what || 'GPU 调用') + ' 已拦截。出图/音色/出片请在视频队列里跑。'),
    { code: 'TEXT_LANE_GPU_DENIED' },
  );
}

// 每个 job 当前占着多少个**渲染**槽位（引用计数）。
// 槽位下沉到渲染项后同一 job 会同时占多个；用 Set 会在第一个子项完成时就把 jobId 删掉，
// 导致 holdsRenderSlot 提前变 false、取消路由不再打断。
renderGate.holderCounts = renderGate.holderCounts instanceof Map ? renderGate.holderCounts : new Map();

/**
 * 「配置声明的」并发上限（保持既有语义：native 用 videoConcurrency，RunningHub 用 runninghubConcurrency）。
 * 注意：真正决定**渲染**并发的是 renderConcurrencyLimit() —— 本地 ComfyUI 被强制为 1。
 */
export function concurrencyLimit(cfg) {
  if (cfg?.comfyui?.provider === 'runninghub') {
    return Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1);
  }
  return Math.max(1, Number(cfg.generation?.videoConcurrency) || 1);
}

/**
 * 实际生效的**渲染**并发上限。
 * 本地 ComfyUI = 启用的端点数（每张显卡一个实例，见 comfy-pool.js）：单个实例原生单执行队列，
 * 所以每个端点同一时刻只派一个渲染；/interrupt 只打到该渲染所在的端点，不会误杀其它端点上的镜头。
 * 只配了一个端点（含旧配置自动迁移）时恒为 1，与改动前一致。
 */
export function renderConcurrencyLimit(cfg) {
  if (cfg?.comfyui?.provider === 'runninghub') {
    return Math.max(1, Number(cfg.generation?.runninghubConcurrency) || 1);
  }
  return Math.max(1, enabledComfyEndpoints(cfg?.comfyui).length);
}

/** 当前配置下是否允许并行渲染（决定取消时能不能安全地打全局 /interrupt）。 */
export function concurrencyEnabled(cfg) {
  return renderConcurrencyLimit(cfg) > 1;
}

/** 该任务此刻是否有渲染正在提交/等待（取消路由据此决定要不要打断 ComfyUI）。 */
export function holdsRenderSlot(jobId) {
  return !!(jobId && (renderGate.holderCounts.get(jobId) || 0) > 0);
}

/** 从两条队列里摘掉某任务的全部排队项并中止它们；返回是否摘掉了条目。 */
export function cancelQueuedJob(jobId) {
  let removed = 0;
  for (const g of [jobGate, renderGate, textGate, writeGate]) {
    for (let i = g.queue.length - 1; i >= 0; i--) {
      if (g.queue[i].jobId !== jobId) continue;
      const [e] = g.queue.splice(i, 1);
      e.cancel(new Error('任务已停止（排队中）'));
      removed++;
    }
  }
  return removed > 0;
}

/** 仅供测试/诊断。 */
export function renderGateStats() {
  return {
    jobSlots: jobGate.slots, jobQueued: jobGate.queue.length,
    renderSlots: renderGate.slots, renderQueued: renderGate.queue.length,
    holders: renderGate.holderCounts.size,
    textSlots: textGate.slots, textQueued: textGate.queue.length,
    writeSlots: writeGate.slots, writeQueued: writeGate.queue.length,
    textLaneJobs: textLane.jobs.size,
    textGpuBorrows: textLane.borrows, textGpuWaits: textLane.waits, textGpuDenied: textLane.denied,
  };
}

/** 仅供诊断：文本通道借用 / 等待 / 拒绝显卡的最近记录（冒烟时核对「文本任务是否等过渲染闸门」）。 */
export function textLaneLog() {
  return textLane.log.slice();
}

// 队列超时按「最后一次进度」计时：每当有槽位被释放、有排队项被放行（= 前面的渲染确实在推进），
// 就给仍在排队的项重新计时。否则一个几十张图的批量在本地 ComfyUI（并发 1）下，
// 队尾项会在「前面的任务一直健康地跑着」时被误判为「前置任务疑似卡死」而放弃
//（超时从入队那一刻开始算，不随进度刷新）。
const touchQueued = (gate) => {
  for (const e of gate.queue) { if (e && e.touch) e.touch(); }
};

// —— 通用：在某个闸门上获取一个槽位后执行 fn ——
function withSlot(gate, limit, fnRaw, isAborted, { queueTimeoutMs, jobId, unitId, onQueue, label }) {
  // fn 固定在「提交者」的异步上下文里执行：排队项是在别人释放槽位的 finally → drain() 里被放行的，
  // 不绑定的话它会继承释放者的上下文（例如一个借显卡的文本任务），文本通道标记就会串到出片 job 身上。
  const fn = AsyncResource.bind(fnRaw);
  return new Promise((resolve, reject) => {
    const drain = () => {
      while (gate.slots < limit && gate.queue.length) {
        const next = gate.queue.shift();
        next.tryAcquire();
      }
      touchQueued(gate);
    };
    const acquire = () => {
      gate.slots++;
      if (jobId && gate === renderGate) {
        renderGate.holderCounts.set(jobId, (renderGate.holderCounts.get(jobId) || 0) + 1);
      }
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          gate.slots--;
          if (jobId && gate === renderGate) {
            const n = (renderGate.holderCounts.get(jobId) || 0) - 1;
            if (n > 0) renderGate.holderCounts.set(jobId, n); else renderGate.holderCounts.delete(jobId);
          }
          drain();
        });
    };
    if (gate.slots < limit) { acquire(); return; }

    if (isAborted && isAborted()) {
      reject(new Error('任务在排队等待' + label + '时已被停止'));
      return;
    }
    if (onQueue) onQueue('queued');
    const waitMax = queueTimeoutMs || (Number(loadConfig().generation?.videoQueueTimeoutMinutes) || 120) * 60 * 1000;
    let timer;
    const onTimeout = () => {
      const i = gate.queue.indexOf(entry);
      if (i >= 0) gate.queue.splice(i, 1);
      reject(new Error('等待' + label + '超时（' + Math.round(waitMax / 60000) + ' 分钟）。前置任务疑似卡死，本项已主动放弃。'));
    };
    const entry = {
      jobId,
      unitId,
      tryAcquire: () => {
        clearTimeout(timer);
        if (isAborted && isAborted()) return reject(new Error('任务在排队等待' + label + '时已被停止'));
        if (onQueue) onQueue('running');
        acquire();
      },
      cancel: (err) => { clearTimeout(timer); reject(err); },
      // 队列有进展时重置等待计时（见 touchQueued）：超时语义 = 「waitMax 内没有任何进度」
      touch: () => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, waitMax);
      },
    };
    timer = setTimeout(onTimeout, waitMax);
    gate.queue.push(entry);
  });
}

/**
 * 任务闸门：整条流水线任务串行执行。
 * @param {() => Promise<any>} fn
 * @param {() => boolean} [isAborted]
 * @param {{ queueTimeoutMs?: number, jobId?: string, onQueue?: (s: 'queued'|'running') => void }} [opts]
 */
export function runExclusiveVideo(fn, isAborted, opts = {}) {
  // 任务层恒为 1：并发的收益交给渲染项闸门，这里只负责「同一时刻一个流水线」。
  // textLane.als.exit：出片 job 永远不在文本通道里跑（防御：即使从文本通道的回调里提交，也按出片 job 对待）。
  return withSlot(jobGate, 1, () => textLane.als.exit(fn), isAborted, { ...opts, label: '视频槽位' });
}

/**
 * 文本闸门（双队列）：只拆分镜的纯文本 job，容量 1，与任务闸门互相独立。
 * 任务体在「文本通道」上下文里运行；任务体里任何碰 GPU 的底层调用都会经 withGpuAccess 按次重新过任务闸门。
 * @param {() => Promise<any>} fn
 * @param {() => boolean} [isAborted]
 * @param {{ queueTimeoutMs?: number, jobId?: string, onQueue?: (s: 'queued'|'running') => void }} [opts]
 */
export function runExclusiveText(fn, isAborted, opts = {}) {
  const jobId = opts.jobId || '';
  const body = () => {
    const lane = { textLane: true, gpuHeld: false, jobId, isAborted };
    if (jobId) textLane.jobs.set(jobId, lane);
    return textLane.als.run(lane, () => Promise.resolve().then(fn)).finally(() => {
      if (jobId && textLane.jobs.get(jobId) === lane) textLane.jobs.delete(jobId);
    });
  };
  return withSlot(textGate, 1, body, isAborted, { ...opts, label: '分镜槽位' });
}

/** 提示词撰写并行闸门的容量：cfg.generation.promptWriteConcurrency，默认 3，1–8。 */
export function promptWriteConcurrency(cfg) {
  const n = Number(cfg && cfg.generation && cfg.generation.promptWriteConcurrency);
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 3;
}

/**
 * 提示词撰写闸门（2026-11-26）：和 runExclusiveText 一样跑在文本通道上下文里（碰 GPU 照样按次过任务闸门），
 * 但容量是 limit，不同章的写稿可以同时跑。同一章的互斥由 activeJobOfChapter（CHAPTER_BUSY → 409）保证。
 */
// 换规则书用的开关（主会话 seq2121）：IC 数据目录下有 rules_hold.STOP 时，新写稿任务排着等（不作废、不报错），
// 已经在写的照常写完；文件删掉后接着跑。换规则书流程：放文件 → 等在写的写完 → 合入 → 删文件。
export function rulesHoldFile() { return path.join(DATA_DIR, 'rules_hold.STOP'); }
export function rulesHoldOn() { try { return fs.existsSync(rulesHoldFile()); } catch { return false; } }
const HOLD_POLL_MS = Number(process.env.IC_RULES_HOLD_POLL_MS) || 5000;
// 返回是否真的等过；等过且给了 onQueue，就先报 queued，放行时报 running（任务面板不会一直显示排队中）
async function waitRulesHold(isAborted, onQueue) {
  let waited = false;
  while (rulesHoldOn() && !(isAborted && isAborted())) {
    if (!waited && onQueue) { try { onQueue('queued'); } catch { /* 回调失败不影响等待 */ } }
    waited = true;
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
  }
  if (waited && onQueue) { try { onQueue('running'); } catch { /* 同上 */ } }
  return waited;
}

export function runParallelText(fn, isAborted, opts = {}) {
  const { limit = 3, gateKey = '', ...rest } = opts;
  const jobId = rest.jobId || '';
  const body = async () => {
    // 进槽位前已等过一次；排在闸门队列里、开关打开后才被放行的，这里再等一次
    await waitRulesHold(isAborted, rest.onQueue);
    if (isAborted && isAborted()) throw new Error('任务在等待规则书换上时已被停止');
    const lane = { textLane: true, gpuHeld: false, jobId, isAborted };
    if (jobId) textLane.jobs.set(jobId, lane);
    return textLane.als.run(lane, () => Promise.resolve().then(fn)).finally(() => {
      if (jobId && textLane.jobs.get(jobId) === lane) textLane.jobs.delete(jobId);
    });
  };
  return waitRulesHold(isAborted, rest.onQueue).then(() => {
    if (isAborted && isAborted()) throw new Error('任务在等待规则书换上时已被停止');
    return withSlot(gateOf(gateKey), Math.max(1, limit), body, isAborted, { ...rest, label: gateKey ? '写稿槽位·' + gateKey : '写稿槽位' });
  });
}

/** 当前调用是否处在文本通道里（且还没借到显卡）。jobId 是兜底识别（ALS 上下文丢失时）。 */
function textLaneOf(jobId) {
  const s = textLane.als.getStore();
  if (s && s.textLane) return s;
  if (jobId && textLane.jobs.has(jobId)) return textLane.jobs.get(jobId);
  return null;
}

/**
 * 底层 GPU 入口统一拦截（runWorkflow / uploadTaskInput / generateTask / freeBackend / interruptTask / 本地字幕识别）。
 *   - 文本 job 的 MCP 子进程：拒绝（抛 TEXT_LANE_GPU_DENIED），不提交。
 *   - 文本通道、尚未借到显卡：按次重新获取任务闸门（与出片 job 同一把，FIFO 排在出片后面），执行完立即归还。
 *   - 已借到（嵌套调用）或其它调用方：原样执行。
 * @param {() => Promise<any>} fn
 * @param {{ jobId?: string, what?: string }} [opts]
 */
export function withGpuAccess(fn, { jobId, what } = {}) {
  if (isTextSubprocess()) return Promise.reject(gpuDenied(what));
  const lane = textLaneOf(jobId);
  if (!lane || lane.gpuHeld) return Promise.resolve().then(fn);
  const held = { ...lane, gpuHeld: true };
  const mustWait = jobGate.slots >= 1;
  textLane.borrows++;
  if (mustWait) textLane.waits++;
  laneNote(mustWait ? 'wait' : 'borrow', lane.jobId, what);
  return withSlot(jobGate, 1, () => textLane.als.run(held, fn), lane.isAborted, {
    jobId: lane.jobId,
    label: '视频槽位（分镜任务借用显卡：' + (what || 'GPU') + '）',
  }).finally(() => laneNote('release', lane.jobId, what));
}

/**
 * 最后一道硬闸（comfyui.js comfyFetch 调用）：文本通道里没借到显卡时，任何非只读的 ComfyUI 请求都拒绝。
 * 正常路径不会走到这里（上层 withGpuAccess 已借到）；走到了说明有调用点漏了，宁可报错也不和出片同时占卡。
 */
export function assertGpuHttpAllowed(method, url) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  const what = m + ' ' + String(url || '').replace(/^https?:\/\/[^/]+/i, '');
  if (isTextSubprocess()) throw gpuDenied(what);
  const s = textLane.als.getStore();
  if (s && s.textLane && !s.gpuHeld) throw gpuDenied(what);
}

/**
 * 渲染项闸门：每次向 ComfyUI / RunningHub 提交占一个槽。
 * @param {() => Promise<any>} fn
 * @param {{ jobId?: string, unitId?: string, isAborted?: () => boolean, queueTimeoutMs?: number, onQueue?: (s: 'queued'|'running') => void }} [opts]
 */
export function runRenderSlot(fn, { jobId, unitId, isAborted, queueTimeoutMs, onQueue } = {}) {
  const limit = renderConcurrencyLimit(loadConfig());
  return withSlot(renderGate, limit, fn, isAborted, { jobId, unitId, queueTimeoutMs, onQueue, label: '渲染槽位' });
}
