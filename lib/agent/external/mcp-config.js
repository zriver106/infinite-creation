// 外部 Agent 工作区与 MCP 配置生成。
// 每个任务一个独立目录，避免污染项目目录，也避免不同 CLI 的配置互相覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../../core/config.js';
import { MCP_SERVER_NAME } from './defs/shared.js';

const WORKSPACES_DIR = path.join(DATA_DIR, 'agent-workspaces');
const MCP_SERVER_PATH = path.join(ROOT, 'lib', 'agent', 'external', 'mcp-server.mjs');

// ic24：Claude Code 对 stdio MCP 服务器默认有 30 分钟「无响应也无 progress 通知」的空闲超时，
// generate_chapter_videos 这类长调用会被它判超时，模型随后重调（第16–19章重复渲染的起因）。
// Claude Code 2.1.325 的 MCP 服务器配置支持 per-server 的 timeout（毫秒）：它既是这台服务器单次
// 工具调用的硬上限，也会把空闲超时抬到同一数值。这里只给 ic 服务器配 6 小时，不做 progress 通知。
// 覆盖：IC_MCP_TIMEOUT_MS=<毫秒>（>=1000 才生效，上限 2147483647）；关闭：IC_MCP_TIMEOUT_MS=0
// 或 IC_DISABLE_MCP_TIMEOUT=1（不写 timeout 字段，claude-mcp.json 与 ic24 之前完全一致）。
export const IC_MCP_TIMEOUT_DEFAULT_MS = 6 * 60 * 60 * 1000;
const IC_MCP_TIMEOUT_MAX_MS = 2147483647;

function envOn(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

// 返回要写进 claude-mcp.json 的 timeout 毫秒数；0 表示不写这个字段。
export function icMcpTimeoutMs(env = process.env) {
  if (envOn(env.IC_DISABLE_MCP_TIMEOUT)) return 0;
  const raw = env.IC_MCP_TIMEOUT_MS == null ? '' : String(env.IC_MCP_TIMEOUT_MS).trim();
  if (raw === '') return IC_MCP_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (n === 0) return 0;
  // 非数字、负数、小于 1 秒（Claude Code 会忽略 <1000 的值）：按默认 6 小时，避免误配回到 30 分钟。
  if (!Number.isFinite(n) || n < 1000) return IC_MCP_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.floor(n), IC_MCP_TIMEOUT_MAX_MS);
}

export function mcpServerSpec() {
  return { command: process.execPath, args: [MCP_SERVER_PATH] };
}

export function mcpConfigSnippet(spec = mcpServerSpec()) {
  return { mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args } } };
}

export function createWorkspace(jobId) {
  const safe = String(jobId || 'job').replace(/[^A-Za-z0-9_-]/g, '_');
  const ws = path.join(WORKSPACES_DIR, safe);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

export function cleanupWorkspace(ws, keep) {
  if (!ws || keep) return;
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2) + '\n');
}

function yamlScalar(value) {
  // YAML 双引号字符串与 JSON 字符串语法兼容，路径里的反斜杠会被正确转义。
  return JSON.stringify(String(value));
}

function prepareHermes(ws, spec) {
  const hermesHome = path.join(ws, 'hermes-home');
  const srcRoot = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  const src = path.join(srcRoot, 'config.yaml');
  let text = '';
  try { text = fs.readFileSync(src, 'utf8'); } catch {}

  // 已有同名 server 就不重复插入（避免 YAML 重复键）。
  if (!/^\s{2}infinite_creation:\s*$/m.test(text)) {
    const block = [
      '  infinite_creation:',
      '    command: ' + yamlScalar(spec.command),
      '    args:',
      ...spec.args.map((a) => '      - ' + yamlScalar(a)),
    ].join('\n');
    if (/^mcp_servers:\s*$/m.test(text)) {
      text = text.replace(/^mcp_servers:\s*$/m, (m) => m + '\n' + block);
    } else {
      const head = text.trim() ? text.replace(/\s*$/, '\n') : '';
      text = head + 'mcp_servers:\n' + block + '\n';
    }
  }
  writeText(path.join(hermesHome, 'config.yaml'), text);
  // 认证信息可能不在 config.yaml：把常见的凭据文件一起带到临时 HERMES_HOME，
  // 避免切换 HOME 后 Hermes 变成未登录状态（不改动用户原目录）。
  for (const name of ['.env', 'auth.json', 'credentials.json']) {
    try { fs.copyFileSync(path.join(srcRoot, name), path.join(hermesHome, name)); } catch {}
  }
  return { HERMES_HOME: hermesHome };
}

// 写各 CLI 的 MCP 配置；返回需要额外注入的环境变量。
// mcpVars 是 IC_MCP_* 任务变量，给需要显式传环境变量的 CLI（OpenCode 的 environment 字段）用。
export function writeMcpConfigs(def, ws, spec = mcpServerSpec(), mcpVars = {}) {
  const server = { command: spec.command, args: spec.args };
  const mcpServers = { [MCP_SERVER_NAME]: server };

  // 通用配置：供自定义 CLI 的 {mcpConfig} 占位符、以及设置页复制。
  writeJson(path.join(ws, 'mcp.json'), { mcpServers });

  switch (def.id) {
    case 'claude':
    {
      // ic24：只给 Claude Code 的 ic 服务器加 timeout，其它 CLI 和通用 mcp.json 不变。
      const timeoutMs = icMcpTimeoutMs();
      writeJson(path.join(ws, 'claude-mcp.json'), {
        mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...server, ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) } },
      });
      break;
    }
    case 'gemini':
      writeJson(path.join(ws, '.gemini', 'settings.json'), { mcpServers });
      break;
    case 'qwen':
      writeJson(path.join(ws, '.qwen', 'settings.json'), {
        mcpServers: { [MCP_SERVER_NAME]: { ...server, trust: true } },
      });
      break;
    case 'cursor-agent':
      writeJson(path.join(ws, '.cursor', 'mcp.json'), { mcpServers });
      break;
    case 'qoder-cli':
      writeJson(path.join(ws, '.qoder', 'settings.json'), { mcpServers });
      break;
    case 'grok':
      writeText(path.join(ws, '.grok', 'config.toml'), [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        'command = ' + JSON.stringify(String(spec.command)),
        'args = ' + JSON.stringify(spec.args.map(String)),
        '',
      ].join('\n'));
      break;
    case 'hermes':
      return prepareHermes(ws, spec);
    case 'opencode':
      // V2 的 local server：type=local + command 数组；codemode:false 让工具直接暴露给模型。
      // policies 把用户全局配置里的其它 MCP 全部挡掉，只留 ic，避免模型误调无关工具。
      writeJson(path.join(ws, 'opencode.json'), {
        $schema: 'https://opencode.ai/config.json',
        policies: [
          { action: 'integration.use', resource: 'mcp:*', effect: 'deny' },
          { action: 'integration.use', resource: 'mcp:' + MCP_SERVER_NAME, effect: 'allow' },
          // 外部 Agent 只需要 MCP 领域工具；用户全局 skills 会分散它的注意力。
          { action: 'integration.use', resource: 'skill:*', effect: 'deny' },
        ],
        mcp: {
          servers: {
            [MCP_SERVER_NAME]: {
              type: 'local',
              command: [spec.command, ...spec.args],
              // 任务上下文必须显式传给 MCP 子进程：不能指望 --standalone 的进程环境透传。
              environment: mcpVars,
              codemode: false,
            },
          },
        },
      });
      break;
    default:
      break;
  }
  return {};
}

export function mcpEnv({ projectId, jobId, chapter, renderDisabled, logFile, progressFile, abortFile, assetId, toolset }) {
  const env = {
    IC_MCP_PROJECT_ID: String(projectId || ''),
    IC_MCP_JOB_ID: String(jobId || ''),
    IC_MCP_CHAPTER: String(chapter || ''),
    IC_MCP_RENDER_DISABLED: renderDisabled ? '1' : '0',
    IC_MCP_ASSET_ID: String(assetId || ''),
    IC_MCP_LOG_FILE: String(logFile || ''),
    IC_MCP_PROGRESS_FILE: String(progressFile || ''),
    IC_MCP_ABORT_FILE: String(abortFile || ''),
  };
  // 受限工具集（如「提示词撰写」= prompt-write）：只在指定时才加这个变量，其它任务的 MCP 环境与之前完全一致。
  if (toolset) env.IC_MCP_TOOLSET = String(toolset);
  // ic23：按章加锁的开关/参数显式带给 MCP 子进程（只在后端设了时才加，平时环境与之前完全一致）。
  for (const k of ['IC_DISABLE_CHAPTER_RENDER_LOCK', 'IC_CHAPTER_LOCK_WAIT_MIN', 'IC_RENDER_LOCK_STALE_SEC']) {
    if (process.env[k]) env[k] = String(process.env[k]);
  }
  return env;
}

export { MCP_SERVER_PATH };
