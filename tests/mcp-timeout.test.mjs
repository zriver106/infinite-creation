// ic24：claude-mcp.json 里给 ic 服务器单独配 timeout（默认 6 小时），可用 IC_ 环境变量覆盖或关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentDef } from '../lib/agent/external/index.js';
import { writeMcpConfigs, icMcpTimeoutMs, IC_MCP_TIMEOUT_DEFAULT_MS, mcpEnv } from '../lib/agent/external/mcp-config.js';
import { MCP_SERVER_NAME } from '../lib/agent/external/defs/shared.js';

const SPEC = { command: '/usr/bin/node', args: ['/x/mcp-server.mjs'] };
const ENV_KEYS = ['IC_MCP_TIMEOUT_MS', 'IC_DISABLE_MCP_TIMEOUT'];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function writeFor(id, vars = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ic24-'));
  try {
    withEnv(vars, () => writeMcpConfigs(findAgentDef(id), ws, SPEC, {}));
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out[path.relative(ws, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(ws);
    return out;
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

const PRE_IC24_CLAUDE = { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: SPEC.command, args: SPEC.args } } };

test('ic24 默认：claude-mcp.json 的 ic 服务器带 timeout=21600000（6 小时），其余字段不变', () => {
  assert.equal(IC_MCP_TIMEOUT_DEFAULT_MS, 21600000);
  const files = writeFor('claude');
  const cfg = JSON.parse(files['claude-mcp.json']);
  assert.deepEqual(Object.keys(cfg.mcpServers), [MCP_SERVER_NAME]);
  assert.deepEqual(cfg.mcpServers[MCP_SERVER_NAME], { type: 'stdio', command: SPEC.command, args: SPEC.args, timeout: 21600000 });
  assert.equal(Number.isInteger(cfg.mcpServers[MCP_SERVER_NAME].timeout), true, 'Claude Code 的 schema 要求正整数');
  // 通用 mcp.json（设置页复制 / 自定义 CLI 用）不加 timeout。
  assert.deepEqual(JSON.parse(files['mcp.json']), { mcpServers: { [MCP_SERVER_NAME]: { command: SPEC.command, args: SPEC.args } } });
});

test('ic24 覆盖：IC_MCP_TIMEOUT_MS 合法值按毫秒写入，超大值截到 2147483647', () => {
  assert.equal(JSON.parse(writeFor('claude', { IC_MCP_TIMEOUT_MS: '7200000' })['claude-mcp.json']).mcpServers.ic.timeout, 7200000);
  assert.equal(JSON.parse(writeFor('claude', { IC_MCP_TIMEOUT_MS: ' 3600000.9 ' })['claude-mcp.json']).mcpServers.ic.timeout, 3600000);
  assert.equal(JSON.parse(writeFor('claude', { IC_MCP_TIMEOUT_MS: '1000' })['claude-mcp.json']).mcpServers.ic.timeout, 1000);
  assert.equal(JSON.parse(writeFor('claude', { IC_MCP_TIMEOUT_MS: '99999999999' })['claude-mcp.json']).mcpServers.ic.timeout, 2147483647);
});

test('ic24 关闭：IC_MCP_TIMEOUT_MS=0 或 IC_DISABLE_MCP_TIMEOUT=1 → claude-mcp.json 与 ic24 之前逐字节一致', () => {
  const before = JSON.stringify(PRE_IC24_CLAUDE, null, 2) + '\n';
  for (const vars of [{ IC_MCP_TIMEOUT_MS: '0' }, { IC_DISABLE_MCP_TIMEOUT: '1' }, { IC_DISABLE_MCP_TIMEOUT: 'true' }, { IC_DISABLE_MCP_TIMEOUT: '1', IC_MCP_TIMEOUT_MS: '7200000' }]) {
    assert.equal(writeFor('claude', vars)['claude-mcp.json'], before, JSON.stringify(vars));
  }
});

test('ic24 误配：非数字 / 负数 / 小于 1 秒 → 仍按默认 6 小时（不会退回 30 分钟）；空开关不算关闭', () => {
  for (const v of ['abc', '-5', '999', '1e400x', '']) {
    assert.equal(withEnv({ IC_MCP_TIMEOUT_MS: v }, () => icMcpTimeoutMs()), 21600000, v);
  }
  for (const v of ['0', 'false', 'no', '']) {
    assert.equal(withEnv({ IC_DISABLE_MCP_TIMEOUT: v }, () => icMcpTimeoutMs()), 21600000, 'disable=' + v);
  }
  assert.equal(icMcpTimeoutMs({}), 21600000);
  assert.equal(icMcpTimeoutMs({ IC_MCP_TIMEOUT_MS: '0' }), 0);
  assert.equal(icMcpTimeoutMs({ IC_DISABLE_MCP_TIMEOUT: 'YES' }), 0);
});

test('ic24 范围：其它 CLI 的配置文件不带 timeout，和 ic24 之前一致', () => {
  for (const id of ['gemini', 'qwen', 'cursor-agent', 'qoder-cli', 'grok', 'opencode']) {
    const def = findAgentDef(id);
    if (!def) continue;
    const files = writeFor(id);
    for (const [name, text] of Object.entries(files)) {
      assert.equal(/"timeout"|^timeout\s*=/m.test(text), false, id + ' ' + name + ' 不应出现 timeout');
    }
  }
});

test('ic24 不改 MCP 子进程环境：mcpEnv 不带 IC_MCP_TIMEOUT_MS / IC_DISABLE_MCP_TIMEOUT', () => {
  withEnv({ IC_MCP_TIMEOUT_MS: '7200000', IC_DISABLE_MCP_TIMEOUT: '0' }, () => {
    const env = mcpEnv({ projectId: 'p', jobId: 'j', chapter: 1 });
    assert.equal('IC_MCP_TIMEOUT_MS' in env, false);
    assert.equal('IC_DISABLE_MCP_TIMEOUT' in env, false);
  });
});

test('ic24 接线：Claude 启动参数仍用 --mcp-config <ws>/claude-mcp.json + --strict-mcp-config', () => {
  const ws = path.join(os.tmpdir(), 'ic24-ws');
  const args = findAgentDef('claude').buildArgs({ ws });
  const i = args.indexOf('--mcp-config');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], path.join(ws, 'claude-mcp.json'));
  assert.ok(args.includes('--strict-mcp-config'));
});