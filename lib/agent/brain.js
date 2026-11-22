// ic28（2026-11-22）：「LLM 模型」与「Agent 运行时」合并为一个设置 ——「Agent 大脑」。
//
// 所有「一问一答」的文本类 LLM 调用（剧本生成/改写、按技能写视频提示词、反馈改写/仅 LLM 改写、
// 换装/年龄视觉精修、参考图命名、音乐 caption 改写）统一走 brainChat(cfg, messages, opts)，
// 不再各自直接 llmChat(cfg.llm)。走向只看一个设置 cfg.agent：
//
//   agent.runtime = 'openclaude'（内置）→ 内置运行时的大脑本来就是 OpenAI 兼容接口（cfg.llm），直接 llmChat；
//   agent.runtime = 外部 CLI（claude / custom，及以后补了 chatArgs 的 def）→ 拉起该 CLI 做一次纯文本补全
//                   （不挂 MCP、禁用全部文件/命令工具、prompt 走 stdin）；
//   外部 CLI 不可用（未安装 / 退出码非 0 / 超时 / 空输出 / 该 CLI 不支持纯文本调用）时：
//     agent.llmFallback === true 且配了 llm.baseUrl → 回落 OpenAI 兼容接口（日志里记一条 warn）；
//     否则直接报错（错误里写明「后备已关闭」，不静默换模型）。
//
// 返回值与 llmChat 同形：{ content, toolCalls, finishReason, message }，另加 via（'agent:<id>' | 'llm' | 'llm-fallback'）。
// 调用点只需把 llmChat(cfg.llm, …) 换成 brainChat(cfg, …)，其余校验（占位符、截断重试）不变。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { llmChat, logger, uid } from '../core/index.js';
import { findAgentDef } from './external/registry.js';
import { customAgentDef } from './external/defs/custom.js';
import { resolveBin, augmentedPath } from './external/detect.js';
import { createWorkspace, cleanupWorkspace } from './external/mcp-config.js';
import { externalAgentEnv } from './external/env.js';

/** 外部 CLI 是否走得通「纯文本补全」：def 提供 chatArgs，或自定义 CLI（用户自己的 bin+args，stdout 即结果）。 */
export function agentSupportsChat(def) {
  return !!def && (def.id === 'custom' || typeof def.chatArgs === 'function');
}

function agentDefOf(cfg, runtime) {
  if (runtime === 'custom') return customAgentDef(cfg?.agent?.custom || {});
  return findAgentDef(runtime) || null;
}

/**
 * 合并后设置的解析结果（纯函数，单测直接测）。
 * @returns {{ runtime: string, primary: 'agent'|'llm', agentId: string, fallback: boolean, llmReady: boolean, reason: string }}
 */
export function brainPlan(cfg) {
  const runtime = String(cfg?.agent?.runtime || 'openclaude');
  const llmReady = !!cfg?.llm?.baseUrl;
  if (runtime === 'openclaude') {
    return { runtime, primary: 'llm', agentId: '', fallback: false, llmReady, reason: '内置运行时（OpenAI 兼容接口）' };
  }
  const def = agentDefOf(cfg, runtime);
  const fallback = cfg?.agent?.llmFallback === true;
  if (!def) {
    // 与 runAgent 同口径：未知 runtime 回退内置
    return { runtime, primary: 'llm', agentId: '', fallback: false, llmReady, reason: '未知运行时 ' + runtime + '，按内置处理' };
  }
  return { runtime, primary: 'agent', agentId: runtime, fallback, llmReady, reason: '外部 Agent（' + (def.name || runtime) + '）' };
}

/** 是否「有大脑可用」：外部 Agent 为主时恒 true（失败在调用时报）；内置时要求 llm.baseUrl。 */
export function brainReady(cfg) {
  const p = brainPlan(cfg);
  return p.primary === 'agent' || p.llmReady;
}

/** 给日志/界面用的一句话描述。 */
export function brainLabel(cfg) {
  const p = brainPlan(cfg);
  if (p.primary === 'llm') return 'OpenAI 兼容接口 · ' + (cfg?.llm?.model || '未配置模型');
  return p.reason + (p.fallback ? '（不可用时回落 OpenAI 兼容接口）' : '');
}

// —— OpenAI messages → 单条 CLI 输入 ——

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
  return String(content == null ? '' : content);
}

function imagesOfContent(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const url = p && p.type === 'image_url' && (p.image_url?.url || p.image_url);
    const m = typeof url === 'string' && /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (m) out.push({ mimeType: m[1], data: m[2] });
  }
  return out;
}

/**
 * 把 OpenAI 风格 messages 拆成 { system, prompt, images }：
 * system 消息合并成系统提示词；其余按顺序拼成一段对话正文（单条 user 时原样）；图片收集出来交给支持视觉的 CLI。
 */
export function flattenMessages(messages, { json = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = [];
  const turns = [];
  const images = [];
  for (const m of list) {
    if (!m) continue;
    if (m.role === 'system') { sys.push(textOfContent(m.content)); continue; }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: textOfContent(m.content) });
    images.push(...imagesOfContent(m.content));
  }
  if (json) sys.push('输出要求：只输出一个合法 JSON 对象，不要 Markdown 围栏，不要任何解释文字。');
  sys.push('你现在只做一次性文本生成：不要调用任何工具、不要读写文件、不要提问，直接给出最终结果正文。');
  const prompt = turns.length === 1 && turns[0].role === 'user'
    ? turns[0].text
    : turns.map((t) => (t.role === 'assistant' ? '【助手此前的回复】\n' : '【用户】\n') + t.text).join('\n\n');
  return { system: sys.filter(Boolean).join('\n\n'), prompt, images };
}

/** Claude Code stream-json 输入：一条 user 消息（文本 + 可选图片块）。 */
export function claudeStreamInput(prompt, images = []) {
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** 解析 Claude Code `--output-format stream-json` 输出，取最后一条 result 事件。 */
export function parseClaudeStreamOutput(stdout) {
  let result = null;
  let lastAssistantText = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev.type === 'result') result = ev;
    else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const t = ev.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
      if (t) lastAssistantText = t;
    }
  }
  if (!result) {
    if (lastAssistantText) return { content: lastAssistantText, finishReason: '', isError: false };
    return { content: '', finishReason: '', isError: true, error: '没有拿到 result 事件' };
  }
  const stop = String(result.stop_reason || '');
  return {
    content: typeof result.result === 'string' ? result.result : lastAssistantText,
    finishReason: stop === 'max_tokens' ? 'length' : (stop === 'end_turn' ? 'stop' : stop),
    isError: !!result.is_error || (result.subtype && result.subtype !== 'success'),
    error: result.is_error ? String(result.result || result.subtype || 'is_error') : '',
  };
}

function quoteForShell(a) {
  const s = String(a);
  return /[\s"&|<>^]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 外部 CLI 做一次纯文本补全。不挂 MCP、不给领域工具；超时杀进程树。
 * deps.spawnFn 供单测注入。
 */
export async function agentChat(cfg, messages, { json = false, timeoutMs = 300_000, model = '' } = {}, deps = {}) {
  const runtime = String(cfg?.agent?.runtime || '');
  const def = agentDefOf(cfg, runtime);
  if (!def) throw new Error('未知的外部 Agent：' + runtime);
  if (!agentSupportsChat(def)) throw new Error((def.name || runtime) + ' 暂不支持纯文本调用（只支持 MCP 流水线任务）');
  if (!def.bin) throw new Error('自定义 CLI 未填写可执行文件（设置 → Agent 运行时）');
  const extraPath = cfg?.agent?.extraPath || '';
  const resolved = deps.resolvedBin || await resolveBin(def, extraPath);
  if (!resolved) throw new Error((def.name || def.bin) + ' 未安装或不在 PATH 中（设置 → Agent 运行时）');

  const { system, prompt, images } = flattenMessages(messages, { json });
  const ws = createWorkspace('brain_' + uid().slice(0, 12));
  const systemFile = path.join(ws, 'system.txt');
  fs.writeFileSync(systemFile, system);
  const useModel = String(model || cfg?.agent?.textModel || '').trim();
  let args;
  let stdinText;
  let parse;
  if (def.id === 'custom') {
    // 自定义 CLI：没有独立的 system 通道 → 系统提示词拼在正文前；{prompt} 占位 / stdin 规则与流水线一致
    const full = (system ? system + '\n\n---\n\n' : '') + prompt;
    args = def.buildArgs({ prompt: full, ws, mcpConfigPath: path.join(ws, 'mcp.json') });
    stdinText = def.promptViaStdin ? full : '';
    parse = (out) => ({ content: out.trim(), finishReason: '', isError: false });
  } else {
    args = def.chatArgs({ ws, systemFile, model: useModel });
    if (def.chatFormat === 'claude-stream-json') {
      stdinText = claudeStreamInput(prompt, images);
      parse = parseClaudeStreamOutput;
    } else {
      stdinText = prompt;
      parse = (out) => ({ content: out.trim(), finishReason: '', isError: false });
    }
  }

  const env = { ...externalAgentEnv(cfg), PATH: augmentedPath(extraPath), ...(def.env || {}) };
  const isWin = process.platform === 'win32';
  const needShell = isWin && /\.(cmd|bat)$/i.test(resolved);
  const spawnFn = deps.spawnFn || spawn;
  const started = Date.now();
  try {
    const child = spawnFn(needShell ? quoteForShell(resolved) : resolved, needShell ? args.map(quoteForShell) : args, {
      cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(needShell ? { shell: true } : {}),
    });
    let out = '';
    let err = '';
    const od = new StringDecoder('utf8');
    const ed = new StringDecoder('utf8');
    child.stdout?.on('data', (c) => { out += od.write(c); if (out.length > 4_000_000) out = out.slice(-2_000_000); });
    child.stderr?.on('data', (c) => { err += ed.write(c); if (err.length > 200_000) err = err.slice(-100_000); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);
    timer.unref?.();
    try { if (child.stdin) { if (stdinText) child.stdin.write(stdinText); child.stdin.end(); } } catch {}
    const res = await new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      child.on('close', (code) => fin({ code }));
      child.on('error', (error) => fin({ code: -1, error }));
    });
    clearTimeout(timer);
    out += od.end();
    err += ed.end();
    const secs = Math.round((Date.now() - started) / 1000);
    if (timedOut) throw new Error((def.name || runtime) + ' 响应超时（' + Math.round(timeoutMs / 1000) + ' 秒无结果）');
    if (res.error) throw new Error((def.name || runtime) + ' 启动失败：' + (res.error.message || res.error));
    const parsed = parse(out);
    if (res.code !== 0 && !(parsed.content && !parsed.isError)) {
      throw new Error((def.name || runtime) + ' 退出码 ' + res.code + '：' + String(parsed.error || err || out).trim().slice(0, 500));
    }
    if (parsed.isError) throw new Error((def.name || runtime) + ' 返回错误：' + String(parsed.error || '').slice(0, 500));
    const content = String(parsed.content || '').trim();
    if (!content) throw new Error((def.name || runtime) + ' 返回为空');
    logger.debug('brain: 外部 Agent 文本调用完成', { agent: def.id, secs, chars: content.length, model: useModel || '(CLI 默认)' });
    return { content, toolCalls: [], finishReason: parsed.finishReason || 'stop', message: { role: 'assistant', content }, via: 'agent:' + def.id };
  } finally {
    cleanupWorkspace(ws, !!cfg?.debug);
  }
}

/**
 * 合并后的统一入口：按 cfg.agent 决定走外部 Agent 还是 OpenAI 兼容接口，必要时回落。
 * opts 与 llmChat 相同（json/temperature/maxTokens/timeoutMs/tools），外加 model（仅外部 Agent 用）。
 * deps：{ llmChatFn, agentChatFn } 供单测注入。
 */
export async function brainChat(cfg, messages, opts = {}, deps = {}) {
  const llmFn = deps.llmChatFn || llmChat;
  const agentFn = deps.agentChatFn || agentChat;
  const plan = brainPlan(cfg);
  // 带 function-calling tools 的调用只有 OpenAI 兼容接口能做（目前没有调用点这样用，留口径）
  if (plan.primary === 'llm' || (opts.tools && opts.tools.length)) {
    const r = await llmFn(cfg?.llm, messages, opts);
    return { ...r, via: 'llm' };
  }
  try {
    return await agentFn(cfg, messages, opts);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (plan.fallback && plan.llmReady) {
      logger.warn('brain: 外部 Agent 文本调用失败，按设置回落 OpenAI 兼容接口', { agent: plan.agentId, error: msg.slice(0, 300) });
      try {
        const r = await llmFn(cfg.llm, messages, opts);
        return { ...r, via: 'llm-fallback', fallbackReason: msg };
      } catch (e2) {
        throw new Error('Agent 运行时（' + plan.agentId + '）失败：' + msg + '；回落 OpenAI 兼容接口也失败：' + (e2?.message || e2));
      }
    }
    throw new Error('Agent 运行时（' + plan.agentId + '）失败：' + msg
      + (plan.fallback ? '（已开回落，但 OpenAI 兼容接口未配置 Base URL）' : '（未开启「回落 OpenAI 兼容接口」）'));
  }
}
