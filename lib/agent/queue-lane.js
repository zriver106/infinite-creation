// 双队列：只拆分镜的 job 进哪条队列（纯函数，零依赖，单测直接 import）。
// 判据只看「这条 job 的 LLM 会不会占本机显卡」：
//   - generation.storyboardQueue === false：总开关关 → 回到全串行（和双队列之前完全一样）；
//   - RunningHub + 队列（queueOn）：本来就不走任务闸门，不涉及；
//   - runtime=openclaude：LLM 走 llm.baseUrl，指向本机（127.x/localhost/::1/0.0.0.0）→ 本机模型常驻显存，不能并行；
//   - 外部 CLI：只放行确认走云端模型的（claude/codex/gemini/cursor-agent/grok/qoder）；
//     custom/opencode/qwen/hermes 可能接本机模型，判断不了 → 不并行。
// 清单与理由见 草稿\…\12_界面五项\实现\GPU调用点清单.md 第 2.5 节。

export const CLOUD_AGENT_RUNTIMES = new Set(['claude', 'codex', 'gemini', 'cursor-agent', 'grok', 'qoder']);

export function isLocalUrl(u) {
  return /^(?:https?:\/\/)?(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i.test(String(u || '').trim());
}

/** @returns {{ lane: 'text'|'gpu', reason: string }} */
export function decideStoryboardLane(cfg, queueOn = false) {
  if (cfg?.generation?.storyboardQueue === false) return { lane: 'gpu', reason: 'generation.storyboardQueue=false（总开关关闭）' };
  if (queueOn) return { lane: 'gpu', reason: 'RunningHub 队列模式（不走任务闸门）' };
  const rt = String(cfg?.agent?.runtime || 'openclaude');
  if (rt === 'openclaude') {
    if (isLocalUrl(cfg?.llm?.baseUrl)) return { lane: 'gpu', reason: '内置运行时 + 本机 LLM（会占显存）' };
    return { lane: 'text', reason: '内置运行时 + 远程 LLM' };
  }
  if (CLOUD_AGENT_RUNTIMES.has(rt)) return { lane: 'text', reason: '外部 Agent（' + rt + '，云端模型）' };
  return { lane: 'gpu', reason: '外部 Agent（' + rt + '）可能接本机模型，不并行' };
}

// 任务属于哪条队列（任务队列面板分栏、自动续章判忙都用它）。
// 新任务看 checkpoint.queue；之前提交、没有这个字段的任务一律算视频队列（它们确实在任务闸门里）。
export function jobQueueOf(job) {
  const cp = (job && job.checkpoint) || {};
  return cp.queue === 'text' ? 'text' : 'gpu';
}
