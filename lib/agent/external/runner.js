// 外部 Agent 执行器：启动本机 CLI，通过 MCP stdio 服务把领域工具交给它，
// 并把工具进度、停止、看门狗、日志统一接回现有任务系统。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { loadConfig, Jobs, projectDir } from '../../core/index.js';
import { externalAgentEnv } from './env.js';
import { AGENT_WATCHDOG } from '../../shared/index.js';
import { createToolRuntime, visionEnabled } from '../tools.js';
import { buildSystemPrompt, buildTaskPrompt, REFERENCE_INSTRUCTION, buildReferenceDescription, buildOpuscarSystemPrompt, buildOpuscarTaskPrompt } from '../agent-loop.js';
import { findAgentDef } from './registry.js';
import { customAgentDef } from './defs/custom.js';
import { resolveBin, augmentedPath } from './detect.js';
import { createWorkspace, cleanupWorkspace, writeMcpConfigs, mcpServerSpec, mcpEnv } from './mcp-config.js';
import { buildPromptWriteAgentPrompt, PROMPT_WRITE_TOOLSET, PROMPT_WRITE_MODEL } from '../prompt-write-mcp.js';
import { buildMusicScoreAgentPrompt, MUSIC_SCORE_TOOLSET } from '../music-score-mcp.js';
import { buildAssetAnalyzeAgentPrompt, ASSET_ANALYZE_TOOLSET } from '../asset-analyze-mcp.js';

function truncate(value, max = 400) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

// promptWrite=true：「提示词撰写」任务——专用提示词 + MCP 受限工具集（只读 + 只写 video_prompt，无渲染工具），强制 renderDisabled。
export async function runExternalAgent({ projectId, chapter, jobId, onProgress, isAborted, renderDisabled, agentId, opuscar, assetId, styleSlug, styleInfo, prompt: userPrompt, materials, history, continueMessage, promptWrite, promptWriteMissing, musicScore, musicRequirement, assetAnalyze, assetAnalyzeRange, assetAnalyzeRequirement }) {
  // musicScore=true：「章节配乐」任务（2026-11-26 主会话 seq2179）——专用提示词 + MCP 受限工具集（只读 + 本章主曲/cue 表），强制 renderDisabled。
  // assetAnalyze=true：「资产分析」任务（Andy 11-26；adapt J-010）——专用提示词 + MCP 受限工具集（读规则 / 原著，写地点表、戏份说明、缺图单）
  if (promptWrite || musicScore || assetAnalyze) renderDisabled = true;
  const cfg = loadConfig();
  const custom = cfg.agent?.custom || {};
  const def = agentId === 'custom' ? customAgentDef(custom) : findAgentDef(agentId);
  if (!def) throw new Error('未知的外部 Agent：' + agentId);
  if (!def.bin) throw new Error('自定义 CLI 未填写可执行文件（设置 → Agent 运行时）');

  const extraPath = cfg.agent?.extraPath || '';
  const resolved = await resolveBin(def, extraPath);
  if (!resolved) {
    throw new Error(
      (def.name || def.bin) + ' 未安装或不在 PATH 中'
      + (def.installUrl ? ('，安装地址：' + def.installUrl) : '')
      + '（设置 → Agent 运行时）',
    );
  }

  const ctx = createToolRuntime({ projectId, jobId, chapter, renderDisabled, isAborted, onProgress: () => {}, assetId });
  let prompt;
  if (assetAnalyze) {
    prompt = buildAssetAnalyzeAgentPrompt({ project: ctx.project, range: assetAnalyzeRange, requirement: assetAnalyzeRequirement });
  } else if (musicScore) {
    prompt = buildMusicScoreAgentPrompt({ project: ctx.project, chapter, requirement: musicRequirement });
  } else if (promptWrite) {
    prompt = buildPromptWriteAgentPrompt({ project: ctx.project, chapter, missing: promptWriteMissing, jobId });
  } else if (opuscar) {
    prompt = buildOpuscarSystemPrompt({ ctx, external: true })
      + '\n\n---\n\n'
      + buildOpuscarTaskPrompt({ ctx, styleSlug, styleInfo, prompt: userPrompt, materials, history, continueMessage });
  } else {
    prompt = buildSystemPrompt({ ctx, external: true })
      + '\n\n---\n\n'
      + buildTaskPrompt(ctx);
    if (visionEnabled(ctx)) {
      const { refs, descText } = buildReferenceDescription(ctx);
      if (refs.length) {
        prompt += REFERENCE_INSTRUCTION
          + '\n\n【参考图用途/剧情定位】\n' + (descText || '')
          + '\n请调用 view_project_references 查看这些参考图。';
      }
    }
  }

  const logDir = path.join(projectDir(projectId), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, jobId + '.log');
  const progressFile = path.join(logDir, jobId + '.progress.jsonl');
  const abortFile = path.join(logDir, jobId + '.abort');
  try { fs.rmSync(progressFile, { force: true }); } catch {}
  try { fs.rmSync(abortFile, { force: true }); } catch {}
  try { Jobs.update(jobId, { logPath: logFile }); } catch {}

  const logAppend = (line) => {
    try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + String.fromCharCode(10)); } catch {}
  };

  const ws = createWorkspace(jobId);
  const spec = mcpServerSpec();
  // MCP 子进程的环境变量：先算好，写配置文件时要用（OpenCode 的 environment 字段），spawn 时也注入。
  const mcpVars = mcpEnv({ projectId, jobId, chapter, renderDisabled, logFile, progressFile, abortFile, assetId, toolset: assetAnalyze ? ASSET_ANALYZE_TOOLSET : musicScore ? MUSIC_SCORE_TOOLSET : promptWrite ? PROMPT_WRITE_TOOLSET : '', chapterRange: assetAnalyzeRange ? assetAnalyzeRange.join('-') : '' });
  let extraEnv = {};
  let progressTimer = null;
  let checkTimer = null;

  try {
    extraEnv = writeMcpConfigs(def, ws, spec, mcpVars) || {};

    const args = def.buildArgs({
      prompt,
      ws,
      nodeBin: spec.command,
      mcpServer: spec,
      mcpConfigPath: path.join(ws, 'mcp.json'),
    });
    // 只有「提示词撰写」路径显式指定模型（def 提供 modelArgs 时，如 claude → --model opus）；其它任务不变。
    if ((promptWrite || musicScore || assetAnalyze) && typeof def.modelArgs === 'function') args.push(...def.modelArgs(PROMPT_WRITE_MODEL));

    // 不把内置 openclaude 的 provider 环境带给外部 Agent（它们应该用自己的登录态/模型配置）。
    const env = externalAgentEnv(cfg);
    env.PATH = augmentedPath(extraPath);
    Object.assign(
      env,
      def.env || {},
      mcpVars,
      extraEnv,
    );

    logAppend('==== 外部 Agent 任务开始 ====');
    logAppend('agent=' + def.id + ' bin=' + resolved + ' cwd=' + ws);
    logAppend('args=' + JSON.stringify(args.map((a) => (a === prompt ? '<prompt>' : truncate(a)))));
    if (def.mcpMode === 'manual') {
      logAppend('[提示] 自定义 CLI 需要自行接入 MCP 服务；配置片段见设置页。');
    }
    if (!def.promptViaStdin) {
      logAppend('[提示] 该 Agent 通过 argv 传入 prompt；Windows 下超长 prompt 可能超过命令行长度限制。');
    }
    if (onProgress) onProgress({ phase: '外部 Agent', detail: def.name + ' 启动' });

    const isWin = process.platform === 'win32';
    const child = spawn(resolved, args, {
      cwd: ws,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
      ...(isWin ? { shell: true } : {}),
    });

    let killed = false;
    const killTree = () => {
      if (killed) return;
      killed = true;
      try {
        if (isWin) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
      const timer = setTimeout(() => {
        try { if (!isWin) process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 3000);
      timer.unref?.();
    };

    let lastActivity = Date.now();
    let pendingTools = 0;
    let toolCallCount = 0;
    let progressOffset = 0;
    let halted = '';

    const readProgress = () => {
      let text = '';
      try { text = fs.readFileSync(progressFile, 'utf8'); } catch { return; }
      if (text.length <= progressOffset) return;
      const chunk = text.slice(progressOffset);
      progressOffset = text.length;
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        lastActivity = Date.now();
        if (ev.kind === 'tool_start') {
          pendingTools += 1;
          toolCallCount += 1;
          // 工具调用/结果由 MCP 服务直接写日志（同一文件），这里只转进度，避免重复两行。
          // detail 只写进 jobs.detail 给任务队列显示，不回喂模型：上限 4000 字（原 300）
          if (onProgress) onProgress({ phase: 'tool:' + ev.tool, detail: truncate(ev.detail || '', 4000) });
        } else if (ev.kind === 'tool_end') {
          pendingTools = Math.max(0, pendingTools - 1);
        } else if (ev.kind === 'phase') {
          if (onProgress) onProgress({ phase: ev.phase || '', detail: ev.detail || '' });
        }
      }
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk) => {
      const text = outDecoder.write(chunk);
      if (!text) return;
      stdoutBuf += text;
      if (stdoutBuf.length > 200000) stdoutBuf = stdoutBuf.slice(-100000);
      lastActivity = Date.now();
    });
    child.stderr?.on('data', (chunk) => {
      const text = errDecoder.write(chunk);
      if (!text) return;
      stderrBuf += text;
      if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
      lastActivity = Date.now();
    });

    try {
      if (def.promptViaStdin && child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      } else if (child.stdin) {
        child.stdin.end();
      }
    } catch {}

    const stallMs = Number(cfg.generation?.agentStallMinutes) > 0
      ? Number(cfg.generation.agentStallMinutes) * 60 * 1000
      : AGENT_WATCHDOG.STALL_MS;

    progressTimer = setInterval(readProgress, 500);
    checkTimer = setInterval(() => {
      if (halted) return;
      if (isAborted && isAborted()) {
        halted = '任务已停止';
        try { fs.writeFileSync(abortFile, '1'); } catch {}
        killTree();
        return;
      }
      if (pendingTools <= 0 && Date.now() - lastActivity > stallMs) {
        halted = '外部 Agent 停滞（' + Math.round(stallMs / 60000) + ' 分钟无输出或工具调用）';
        killTree();
      }
    }, 1000);

    const result = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      child.on('close', (code, signal) => finish({ code, signal }));
      child.on('error', (error) => finish({ code: -1, error }));
    });

    clearInterval(progressTimer);
    clearInterval(checkTimer);
    progressTimer = null;
    checkTimer = null;

    const outTail = outDecoder.end();
    if (outTail) stdoutBuf += outTail;
    const errTail = errDecoder.end();
    if (errTail) stderrBuf += errTail;
    readProgress();

    const cleanOut = stripAnsi(stdoutBuf).trim();
    const cleanErr = stripAnsi(stderrBuf).trim();
    if (cleanOut) logAppend('[外部 Agent 输出] ' + truncate(cleanOut, 4000));
    if (cleanErr) logAppend('[外部 Agent stderr] ' + truncate(cleanErr, 2000));

    if (halted) throw new Error(halted);
    if (isAborted && isAborted()) throw new Error('任务已停止');
    if (result.error) throw new Error('外部 Agent 启动失败：' + (result.error.message || result.error));
    if (result.code !== 0) {
      throw new Error('外部 Agent 退出码 ' + result.code + (cleanErr ? '：' + truncate(cleanErr, 500) : ''));
    }
    if (toolCallCount === 0) {
      throw new Error(
        '外部 Agent 未调用任何领域工具（MCP 未接通）：请检查 ' + def.name + ' 的 MCP 配置与登录状态。任务日志：' + logFile,
      );
    }

    logAppend('==== 外部 Agent 任务结束（工具调用 ' + toolCallCount + ' 次）====');
    return cleanOut.slice(-4000) || '外部 Agent 执行完成';
  } catch (e) {
    logAppend('[异常] ' + (e && e.message ? e.message : String(e)));
    throw e;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (checkTimer) clearInterval(checkTimer);
    try { fs.rmSync(abortFile, { force: true }); } catch {}
    cleanupWorkspace(ws, !!cfg.debug);
  }
}
