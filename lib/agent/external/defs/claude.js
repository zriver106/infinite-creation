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
