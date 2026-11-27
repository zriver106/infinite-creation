// 本项目领域工具的 MCP stdio 服务。
// 协议：newline-delimited JSON-RPC 2.0（stdin/stdout）。
// 注意：stdout 只能输出协议帧，所有日志必须走 stderr 或日志文件。
import fs from 'node:fs';
import readline from 'node:readline';
import { TOOL_DEFINITIONS, createToolRuntime, runTool } from '../tools.js';
import {
  PROMPT_WRITE_TOOLSET, promptWriteToolDefinitions, isPromptWriteToolAllowed, isPromptWriteExtraTool,
  runPromptWriteExtraTool, notePromptWriteToolCall, notePromptWriteToolResult,
} from '../prompt-write-mcp.js';
import {
  MUSIC_SCORE_TOOLSET, musicScoreToolDefinitions, isMusicScoreToolAllowed, isMusicScoreExtraTool,
  runMusicScoreExtraTool, noteMusicScoreToolCall, guardMusicScoreWrite,
} from '../music-score-mcp.js';
import {
  ASSET_ANALYZE_TOOLSET, assetAnalyzeToolDefinitions, isAssetAnalyzeToolAllowed, isAssetAnalyzeExtraTool,
  runAssetAnalyzeExtraTool, noteAssetAnalyzeToolCall,
} from '../asset-analyze-mcp.js';
import { SCRIPT_WRITE_TOOLSET, SCRIPT_WRITE_TOOLS, SCRIPT_WRITE_EXTRA, scriptWriteToolDefinitions, guardScriptWrite } from '../script-write.js';
import { listSceneNotes, getSceneNote } from '../../core/scene-notes.js';
import { getLocations } from '../../core/locations.js';

const writeStdout = process.stdout.write.bind(process.stdout);
// 先重定向 console，再加载/执行任何会写日志的模块逻辑。
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

const projectId = process.env.IC_MCP_PROJECT_ID || '';
const jobId = process.env.IC_MCP_JOB_ID || '';
const chapter = process.env.IC_MCP_CHAPTER || '';
const renderDisabled = process.env.IC_MCP_RENDER_DISABLED === '1';
const assetId = process.env.IC_MCP_ASSET_ID || '';
const logFile = process.env.IC_MCP_LOG_FILE || '';
const progressFile = process.env.IC_MCP_PROGRESS_FILE || '';
const abortFile = process.env.IC_MCP_ABORT_FILE || '';
// 工具集：缺省 = 全部领域工具（与之前完全一致）；prompt-write = 「提示词撰写」专用（只读工具 + 只写 video_prompt）。
const promptWriteOnly = (process.env.IC_MCP_TOOLSET || '') === PROMPT_WRITE_TOOLSET;
// 章节配乐（2026-11-26 主会话 seq2179）：music-score = 只读工具 + 本章 set_chapter_music / set_chapter_music_cues
const musicScoreOnly = (process.env.IC_MCP_TOOLSET || '') === MUSIC_SCORE_TOOLSET;
// 资产分析（Andy 11-26；adapt J-010）：asset-analyze = 读规则 / 原著 + 写地点表、戏份说明、缺图单
const assetAnalyzeOnly = (process.env.IC_MCP_TOOLSET || '') === ASSET_ANALYZE_TOOLSET;
const chapterRange = String(process.env.IC_MCP_CHAPTER_RANGE || '').split('-').map(Number).filter((n) => n > 0);
// 只写剧本（总导 11-26）：script-write = 读规则 + get_chapter（重写模式）+ set_chapter_script（只写本章）+ get_locations
const scriptWriteOnly = (process.env.IC_MCP_TOOLSET || '') === SCRIPT_WRITE_TOOLSET;
const LISTED_TOOLS = scriptWriteOnly ? scriptWriteToolDefinitions(TOOL_DEFINITIONS) : promptWriteOnly ? promptWriteToolDefinitions(TOOL_DEFINITIONS) : musicScoreOnly ? musicScoreToolDefinitions(TOOL_DEFINITIONS) : assetAnalyzeOnly ? assetAnalyzeToolDefinitions(TOOL_DEFINITIONS) : TOOL_DEFINITIONS;

function appendLog(line) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + String.fromCharCode(10)); } catch {}
}

function progress(ev) {
  if (!progressFile) return;
  try { fs.appendFileSync(progressFile, JSON.stringify({ t: Date.now(), ...ev }) + String.fromCharCode(10)); } catch {}
}

function isAborted() {
  return !!abortFile && fs.existsSync(abortFile);
}

let ctx = null;
function getCtx() {
  if (ctx) return ctx;
  if (!projectId) throw new Error('缺少 IC_MCP_PROJECT_ID，无法初始化项目工具上下文');
  ctx = createToolRuntime({
    projectId,
    jobId,
    chapter,
    renderDisabled,
    assetId,
    isAborted,
    onProgress: (patch) => progress({
      kind: 'phase',
      phase: patch?.phase || '',
      detail: String(patch?.detail || '').slice(0, 500),
    }),
  });
  if (scriptWriteOnly) ctx.scriptRewrite = true; // 只写剧本：get_chapter 不给旧剧本、先读规则才给原著
  if (musicScoreOnly) ctx.musicScore = true; // 章节配乐任务：放行文本任务默认拦着的配乐工具（tools.js 配乐守卫）
  return ctx;
}

function send(msg) {
  try { writeStdout(JSON.stringify(msg) + String.fromCharCode(10)); } catch {}
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function truncate(value, max = 300) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const text = s == null ? '' : String(s);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function toContent(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.images)) {
    const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
    const content = [{ type: 'text', text }];
    for (const img of result.images) {
      if (img && img.data && img.mimeType) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
    return content;
  }
  return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }];
}

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (!name) {
    fail(id, -32602, 'tools/call 缺少 name');
    return;
  }
  const detail = truncate(args);
  // 进度里的工具参数只进 jobs.detail 给任务队列显示（不回喂模型），上限放到 4000 字；日志行仍按 300 字截
  progress({ kind: 'tool_start', tool: name, detail: truncate(args, 4000) });
  appendLog('[工具调用] ' + name + ' ' + detail);
  try {
    if (promptWriteOnly && !isPromptWriteToolAllowed(name)) {
      throw new Error('本任务（提示词撰写）只允许读取与写视频提示词，不提供工具 ' + name);
    }
    if (scriptWriteOnly && !SCRIPT_WRITE_TOOLS.has(name) && !SCRIPT_WRITE_EXTRA.has(name)) {
      throw new Error('本任务（只写剧本）只允许读规则、读本章原著和写本章剧本，不提供工具 ' + name);
    }
    if (assetAnalyzeOnly && !isAssetAnalyzeToolAllowed(name)) {
      throw new Error('本任务（资产分析）只允许读规则、读原著和写地点表 / 戏份说明 / 缺图单，不提供工具 ' + name);
    }
    if (musicScoreOnly && !isMusicScoreToolAllowed(name)) {
      throw new Error('本任务（章节配乐）只允许读取和写本章配乐，不提供工具 ' + name);
    }
    if (promptWriteOnly) notePromptWriteToolCall(name, args);
    if (musicScoreOnly) noteMusicScoreToolCall(name, args);
    if (assetAnalyzeOnly) noteAssetAnalyzeToolCall(name, args);
    const result = scriptWriteOnly && name === 'get_locations'
      ? JSON.stringify(getLocations(getCtx().projectId))
      : scriptWriteOnly && name === 'list_scene_notes'
      ? JSON.stringify(listSceneNotes(getCtx().projectId))
      : scriptWriteOnly && name === 'get_scene_note'
      ? JSON.stringify(getSceneNote(getCtx().projectId, args.key) || { key: args.key, text: '', note: '还没有这份戏份说明' })
      : scriptWriteOnly
        ? await runTool(getCtx(), name, guardScriptWrite(getCtx(), name, args))
        : assetAnalyzeOnly && isAssetAnalyzeExtraTool(name)
      ? await runAssetAnalyzeExtraTool({ ...getCtx(), chapterRange: chapterRange.length === 2 ? chapterRange : null }, name, args)
      : promptWriteOnly && isPromptWriteExtraTool(name)
      ? await runPromptWriteExtraTool(getCtx(), name, args)
      : musicScoreOnly && isMusicScoreExtraTool(name)
        ? await runMusicScoreExtraTool(getCtx(), name, args)
        : await runTool(getCtx(), name, musicScoreOnly ? guardMusicScoreWrite(getCtx(), name, args) : args);
    if (promptWriteOnly) notePromptWriteToolResult(name, args);
    const content = toContent(result);
    const text = content.find((c) => c.type === 'text')?.text || '';
    appendLog('[工具结果] ' + name + ': ' + truncate(text, 500) + (content.length > 1 ? ' [图片] ' + (content.length - 1) + ' 张' : ''));
    if (name === 'skill' && args.name) appendLog('[技能] 已加载技能：' + args.name);
    progress({ kind: 'tool_end', tool: name, ok: true });
    ok(id, { content });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    appendLog('[工具错误] ' + name + ': ' + msg);
    progress({ kind: 'tool_end', tool: name, ok: false, detail: msg });
    ok(id, { content: [{ type: 'text', text: '工具执行错误：' + msg }], isError: true });
  }
}

function handle(msg) {
  const id = msg?.id;
  const method = msg?.method;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    if (!isNotification) {
      ok(id, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'infinite-creation', version: '1.0.0' },
      });
    }
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    if (!isNotification) ok(id, {});
    return;
  }
  if (method === 'tools/list') {
    if (!isNotification) {
      ok(id, {
        tools: LISTED_TOOLS.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
        })),
      });
    }
    return;
  }
  if (method === 'tools/call') {
    if (!isNotification) callTool(id, msg.params);
    return;
  }
  if (!isNotification) fail(id, -32601, 'Method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    fail(null, -32700, 'Parse error');
    return;
  }
  if (Array.isArray(msg)) {
    for (const one of msg) handle(one);
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
