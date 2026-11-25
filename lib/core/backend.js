import { generate, downloadOutput, uploadToInput, interrupt, freeComfy, checkComfyUI } from './comfyui.js';
import * as rh from './runninghub.js';
import { withGpuAccess } from './render-gate.js';
import { poolEndpoints, primaryEndpointUrl, withEndpoint, registerInput, markUploaded, ensureInputsOn, isEndpointDownError } from './comfy-pool.js';

// —— 渲染后端分派层 ——
// 原生 ComfyUI 逻辑（comfyui.js）保持不变；这里按 cfg.comfyui.provider 分派：
//   native     → 走 comfyui.js；地址来自 cfg.comfyui.endpoints（多显卡端点池，见 comfy-pool.js），
//                只有一个端点时与改动前完全一致（旧配置的 baseUrl 自动迁移成单端点）
//   runninghub → 走 runninghub.js 标准 OpenAPI（用 cfg.comfyui.apiKey / tier）
const isRunningHub = (cfg) => cfg?.comfyui?.provider === 'runninghub';

// 双队列硬条件：会写 ComfyUI / 占显存的入口（generate / upload / free / interrupt）都经 withGpuAccess。
// 出片 job、路由调用原样执行；文本通道按次借任务闸门（已在 runWorkflow 借到时直接放行）；
// 文本 job 的 MCP 子进程拒绝。云端 RunningHub 不占本机显卡，不拦。
const gpu = (cfg, fn, opts) => (isRunningHub(cfg) ? fn() : withGpuAccess(fn, opts));

// 对所有启用端点并行执行 op；全部失败才抛（第一个错误），否则返回各端点结果。
async function eachEndpoint(cfg, op) {
  const eps = poolEndpoints(cfg);
  if (!eps.length) throw new Error('没有启用的本地 ComfyUI 端点');
  const rs = await Promise.allSettled(eps.map((e) => op(e.url)));
  if (rs.every((r) => r.status === 'rejected')) throw rs[0].reason;
  return rs;
}

// 提交 + 等待完成，返回 { prompt_id, outputs, entry }（RunningHub 下 prompt_id = taskId）
// native：借一个空闲端点 → 补传该端点缺的参考文件 → 提交；产物打上 endpoint 标记，下载时回到同一端点。
export function generateTask(cfg, workflow, opts) {
  if (isRunningHub(cfg)) return rh.runninghubGenerate(cfg, workflow, opts);
  return gpu(cfg, () => withEndpoint(cfg, async (ep, ctl) => {
    await ensureInputsOn(ep.url, workflow, uploadToInput);
    const r = await generate(ep.url, workflow, {
      ...(opts || {}),
      onSubmitted: (pid) => {
        ctl.submitted();
        if (opts && opts.onSubmitted) opts.onSubmitted(pid);
      },
    });
    for (const o of r.outputs || []) o.endpoint = ep.url;
    return { ...r, endpoint: ep.url, gpu: ep.gpu };
  }, { isAborted: opts?.isAborted, what: 'ComfyUI 提交 /prompt' }), { jobId: opts?.jobId, what: 'ComfyUI 提交 /prompt' });
}

// 上传参考文件，返回「上传后的文件名」：native 返回传入 filename；runninghub 返回平台 fileName
// native：登记「文件名 → 本地路径」，先传到第一个能连上的端点；其它端点在被派到渲染时按需补传。
export async function uploadTaskInput(cfg, localPath, filename) {
  if (isRunningHub(cfg)) return rh.runninghubUpload(cfg, localPath);
  registerInput(filename, localPath);
  const eps = poolEndpoints(cfg);
  const urls = eps.length ? eps.map((e) => e.url) : [primaryEndpointUrl(cfg)];
  let lastErr = null;
  for (const url of urls) {
    try {
      await gpu(cfg, () => uploadToInput(url, localPath, filename), { what: 'ComfyUI 上传 /upload/image' });
      markUploaded(url, filename);
      return filename;
    } catch (e) {
      lastErr = e;
      // 只有「端点连不上」才换下一个端点；其它错误（文本通道拦截、4xx）原样抛出
      if (!isEndpointDownError(e)) throw e;
    }
  }
  throw lastErr;
}

// 下载产物，返回 Buffer：优先回到产出它的端点（outputs[].endpoint），老数据/无标记时用第一个端点
export async function downloadTaskOutput(cfg, out) {
  if (isRunningHub(cfg)) return rh.runninghubDownload(out.fileUrl);
  return downloadOutput(out?.endpoint || primaryEndpointUrl(cfg), out);
}

// 打断/取消任务：runninghub 需 taskId（无 taskId 时 no-op，由 generateTask 内部 isAborted 兜底）
// native：硬停止时打断所有启用端点（同一时刻只有一个出片 job 在用这些端点，等价于改动前打断那一个 ComfyUI）
export function interruptTask(cfg, taskId) {
  if (isRunningHub(cfg)) return taskId ? rh.runninghubCancel(cfg, taskId) : Promise.resolve();
  return gpu(cfg, () => eachEndpoint(cfg, (url) => interrupt(url)), { what: 'ComfyUI /interrupt' });
}

// 释放显存：runninghub 云端无需（无 /free 端点）；native 对所有启用端点发 /free
export function freeBackend(cfg) {
  if (isRunningHub(cfg)) return Promise.resolve();
  return gpu(cfg, () => eachEndpoint(cfg, (url) => freeComfy(url)), { what: 'ComfyUI /free' });
}

// 就绪检查：native 并行检查所有启用端点；至少一个可用即 ok（单个端点挂掉不阻断其它端点出片）。
// 顶层字段（system/device/vramFree/…）取第一个可用端点，保持老调用点语义；endpoints 为逐端点明细。
export async function checkBackend(cfg) {
  if (isRunningHub(cfg)) return rh.runninghubCheck(cfg);
  const eps = poolEndpoints(cfg);
  if (!eps.length) return { ok: false, error: '没有启用的本地 ComfyUI 端点', endpoints: [], okCount: 0, total: 0 };
  const results = await Promise.all(eps.map((e) => checkComfyUI(e.url)));
  const endpoints = eps.map((e, i) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, gpu: e.gpu, ...results[i] }));
  const okOnes = endpoints.filter((r) => r.ok);
  const head = okOnes[0] || endpoints[0];
  const out = { ...results[endpoints.indexOf(head)], endpoints, okCount: okOnes.length, total: endpoints.length };
  if (!okOnes.length && endpoints.length > 1) {
    out.error = endpoints.map((r) => (r.name || r.baseUrl) + '：' + (r.error || '失败')).join('；');
  }
  return out;
}
