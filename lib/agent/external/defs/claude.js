import path from 'node:path';

// Claude Code：--mcp-config 指向工作区 JSON；--print 无头模式；禁用文件/命令类工具。
export const claude = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  versionArgs: ['--version'],
  installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  promptViaStdin: true,
  mcpMode: 'flag',
  // 2026-11-17 第三轮：只有调用方显式给模型时才追加（目前只有「提示词撰写」路径用，见 runner.js）；
  // 其它任务仍跟随 Claude CLI 自己的默认模型（~/.claude/settings.json 的 model）。
  modelArgs(model) {
    const m = String(model || '').trim();
    return m ? ['--model', m] : [];
  },
  // ic28：纯文本调用（剧本 / 提示词 / 改写等「一问一答」，见 lib/agent/brain.js）。
  // 不挂任何 MCP（--strict-mcp-config 且不给 --mcp-config）、禁用文件/命令工具、不落会话；
  // 系统提示词走文件（Windows 命令行长度有限，技能全文动辄上万字）；
  // stream-json 输入可带图片块（视觉精修 / 参考图命名），输出取 result 事件。
  chatArgs({ systemFile, model }) {
    const m = String(model || '').trim();
    return [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt-file', systemFile,
      '--disallowedTools', 'Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task',
      ...(m ? ['--model', m] : []),
    ];
  },
  // 由 brain.js 注入实现（claudeStreamInput / parseClaudeStreamOutput），这里只声明格式
  chatFormat: 'claude-stream-json',
  buildArgs({ ws }) {
    return [
      '--print',
      '--mcp-config', path.join(ws, 'claude-mcp.json'),
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      '--disallowedTools', 'Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task',
    ];
  },
};
