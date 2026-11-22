// ic28「LLM 模型」并入「Agent 运行时」单测：临时数据目录 + 临时配置 + 假 OpenAI 兼容接口 + 假 CLI。
// 不碰真实 data/ic.db / config.json，不调用真 LLM / 真 Claude CLI，不碰 ComfyUI。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-brain-cli.mjs').replace(/\\/g, '/');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-brain-'));
const cliLog = path.join(tmp, 'cli.jsonl');
let server;
let llmCalls = 0;
let llmBase;
let cfgPath;
let core;
let brain;
let tools;
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj));
const readCliLog = () => (fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const customNode = (extra = {}) => ({ runtime: 'custom', custom: { name: '假CLI', bin: 'node', args: FAKE, promptViaStdin: true }, ...extra });

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      llmCalls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'LLM REPLY #' + llmCalls }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llmBase = 'http://127.0.0.1:' + server.address().port + '/v1';
  cfgPath = path.join(tmp, 'config.json');
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'openclaude' } });
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  process.env.FAKE_BRAIN_LOG = cliLog;
  core = await import('../lib/core/index.js');
  brain = await import('../lib/agent/brain.js');
  tools = await import('../lib/agent/tools.js');
});

after(() => { try { server.close(); } catch {} });

test('迁移：旧 config 不丢 llm 字段；llmFallback 按「接口看起来能用」推导；显式值保留', () => {
  const old = { llm: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'DeepSeek-V4.1-Flash', vision: false, rewriteLanguage: 'en', rewriteMaxTokens: 6000 }, agent: { runtime: 'claude', extraPath: 'C:\\x' } };
  const r = core.resolveHardwareConfig(old);
  assert.equal(r.llm.baseUrl, 'https://api.deepseek.com');
  assert.equal(r.llm.model, 'DeepSeek-V4.1-Flash');
  assert.equal(r.llm.rewriteLanguage, 'en');
  assert.equal(r.llm.rewriteMaxTokens, 6000);
  assert.equal(r.agent.runtime, 'claude');
  assert.equal(r.agent.extraPath, 'C:\\x');
  assert.equal(r.agent.llmFallback, false, '云端端点没 key → 不回落（只会 401）');
  assert.equal(r.agent.textModel, '');
  assert.equal(core.resolveHardwareConfig({ ...old, llm: { ...old.llm, apiKey: 'sk-x' } }).agent.llmFallback, true, '有 key → 保留为后备');
  assert.equal(core.resolveHardwareConfig({ llm: { baseUrl: 'http://127.0.0.1:8080' }, agent: { runtime: 'claude' } }).agent.llmFallback, true, '本机无鉴权端点 → 后备');
  assert.equal(core.resolveHardwareConfig({ llm: { baseUrl: 'http://127.0.0.1:8080' }, agent: { runtime: 'claude', llmFallback: false } }).agent.llmFallback, false, '显式 false 保留');
  assert.equal(core.resolveHardwareConfig({}).agent.runtime, 'openclaude', '全新配置默认值不变');
  // 再存再读（PUT 回写）幂等
  const again = core.resolveHardwareConfig(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(again.agent, r.agent);
  assert.deepEqual(again.llm, r.llm);
});

test('brainPlan：内置 → llm；外部 → agent（回落按设置）；未知 → llm', () => {
  assert.equal(brain.brainPlan({ agent: { runtime: 'openclaude' }, llm: { baseUrl: 'x' } }).primary, 'llm');
  const p = brain.brainPlan({ agent: { runtime: 'claude', llmFallback: true }, llm: { baseUrl: 'x' } });
  assert.equal(p.primary, 'agent'); assert.equal(p.agentId, 'claude'); assert.equal(p.fallback, true);
  assert.equal(brain.brainPlan({ agent: { runtime: 'claude' } }).fallback, false);
  assert.equal(brain.brainPlan({ agent: { runtime: 'nope' } }).primary, 'llm');
  assert.equal(brain.brainReady({ agent: { runtime: 'claude' }, llm: {} }), true, '外部 Agent 为主时不要求 llm.baseUrl');
  assert.equal(brain.brainReady({ agent: { runtime: 'openclaude' }, llm: {} }), false);
  assert.equal(brain.agentSupportsChat({ id: 'codex' }), false);
  assert.equal(brain.agentSupportsChat({ id: 'custom' }), true);
});

test('flattenMessages / stream-json 输入输出', () => {
  const f = brain.flattenMessages([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ], { json: true });
  assert.match(f.system, /^SYS/); assert.match(f.system, /JSON/);
  assert.equal(f.prompt, 'hello');
  assert.deepEqual(f.images, [{ mimeType: 'image/png', data: 'AAAA' }]);
  const line = JSON.parse(brain.claudeStreamInput('hi', f.images));
  assert.equal(line.type, 'user'); assert.equal(line.message.content[1].type, 'image');
  const out = brain.parseClaudeStreamOutput('{"type":"system"}\nnoise\n{"type":"result","subtype":"success","is_error":false,"result":"R","stop_reason":"max_tokens"}\n');
  assert.deepEqual([out.content, out.finishReason, !!out.isError], ['R', 'length', false]);
  assert.equal(brain.parseClaudeStreamOutput('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}').isError, true);
});

test('brainChat 分流与回落（注入）', async () => {
  const llmFn = async () => ({ content: 'L', finishReason: 'stop' });
  const okAgent = async () => ({ content: 'A', finishReason: 'stop', via: 'agent:claude' });
  const badAgent = async () => { throw new Error('claude 未安装'); };
  const base = { llm: { baseUrl: 'http://x' } };
  assert.equal((await brain.brainChat({ ...base, agent: { runtime: 'openclaude' } }, [], {}, { llmChatFn: llmFn, agentChatFn: okAgent })).via, 'llm');
  assert.equal((await brain.brainChat({ ...base, agent: { runtime: 'claude' } }, [], {}, { llmChatFn: llmFn, agentChatFn: okAgent })).via, 'agent:claude');
  const fb = await brain.brainChat({ ...base, agent: { runtime: 'claude', llmFallback: true } }, [], {}, { llmChatFn: llmFn, agentChatFn: badAgent });
  assert.equal(fb.via, 'llm-fallback'); assert.equal(fb.content, 'L'); assert.match(fb.fallbackReason, /未安装/);
  await assert.rejects(() => brain.brainChat({ ...base, agent: { runtime: 'claude', llmFallback: false } }, [], {}, { llmChatFn: llmFn, agentChatFn: badAgent }), /未开启「回落/);
  await assert.rejects(() => brain.brainChat({ llm: {}, agent: { runtime: 'claude', llmFallback: true } }, [], {}, { llmChatFn: llmFn, agentChatFn: badAgent }), /未配置 Base URL/);
});

test('agentChat：自定义 CLI 真进程（stdin 进、stdout 出；系统提示词拼在正文前；不带 openclaude 环境）', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1';
  process.env.FAKE_BRAIN_REPLY = '自定义CLI的回答';
  try {
    const r = await brain.agentChat({ agent: customNode(), llm: {} }, [{ role: 'system', content: '系统X' }, { role: 'user', content: '问题Y' }], { timeoutMs: 30000 });
    assert.equal(r.content, '自定义CLI的回答');
    assert.equal(r.via, 'agent:custom');
    const last = readCliLog().at(-1);
    assert.match(last.input, /系统X[\s\S]*问题Y/);
    assert.equal(last.env.CLAUDE_CODE_USE_OPENAI, '', '内置 openclaude 的 provider 环境不外泄');
  } finally { delete process.env.CLAUDE_CODE_USE_OPENAI; delete process.env.FAKE_BRAIN_REPLY; }
});

test('agentChat：claude 定义（stream-json + system 文件 + 禁 MCP/工具 + 图片块 + textModel）', async () => {
  const spawnFn = (cmd, args, opts) => spawn(process.execPath, [FAKE, ...args], opts);
  process.env.FAKE_BRAIN_REPLY = 'CLAUDE OK';
  try {
    const r = await brain.agentChat(
      { agent: { runtime: 'claude', textModel: 'opus' }, llm: {} },
      [{ role: 'system', content: '技能全文' }, { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
      { timeoutMs: 30000 },
      { resolvedBin: 'claude.exe', spawnFn },
    );
    assert.equal(r.content, 'CLAUDE OK [img=1]');
    const last = readCliLog().at(-1);
    for (const a of ['--print', '--strict-mcp-config', '--no-session-persistence', '--disallowedTools']) assert.ok(last.args.includes(a), a);
    assert.ok(!last.args.includes('--mcp-config'), '纯文本调用不挂 MCP');
    assert.equal(last.args[last.args.indexOf('--model') + 1], 'opus');
    assert.match(last.sys, /^技能全文/);
  } finally { delete process.env.FAKE_BRAIN_REPLY; }
});

test('agentChat：CLI 退出码非 0 / 找不到可执行文件 → 抛错', async () => {
  process.env.FAKE_BRAIN_EXIT = '3';
  try {
    await assert.rejects(() => brain.agentChat({ agent: customNode(), llm: {} }, [{ role: 'user', content: 'x' }], { timeoutMs: 30000 }), /退出码 3/);
  } finally { delete process.env.FAKE_BRAIN_EXIT; }
  await assert.rejects(() => brain.agentChat({ agent: { runtime: 'custom', custom: { bin: 'ic-no-such-cli-xyz' } }, llm: {} }, [{ role: 'user', content: 'x' }]), /未安装或不在 PATH/);
  await assert.rejects(() => brain.agentChat({ agent: { runtime: 'codex' }, llm: {} }, [{ role: 'user', content: 'x' }], {}, { resolvedBin: 'codex' }), /暂不支持纯文本调用/);
});

test('集成：write_shot_video_prompt（按技能写提示词）按合并设置走 —— 外部 CLI / 回落 / 不回落', async () => {
  const { Projects, Chapters, Shots } = core;
  const p = Projects.create({ name: 'ic28-brain', auto_script: false });
  Chapters.create(p.id, { title: '第7章', script: 's' });
  const mk = (i) => Shots.create(p.id, { chapter: '第7章', idx: i, visual: '画面' + i, mode: 'text' });
  const ctxOf = () => tools.createToolRuntime({ projectId: p.id, chapter: '第7章', renderDisabled: true, isAborted: () => false, onProgress: () => {} });

  // 1) 外部 CLI 为主：提示词来自 CLI，LLM 一次都没调
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: customNode({ llmFallback: true }) });
  process.env.FAKE_BRAIN_REPLY = 'A quiet street at dusk, slow dolly in.';
  const s1 = mk(1);
  const before = llmCalls;
  try { await tools.runTool(ctxOf(), 'write_shot_video_prompt', { shot_id: s1.id }); } finally { delete process.env.FAKE_BRAIN_REPLY; }
  assert.equal(Shots.get(s1.id).video_prompt, 'A quiet street at dusk, slow dolly in.');
  assert.equal(llmCalls, before, '外部 Agent 成功时不打 OpenAI 兼容接口');
  assert.match(readCliLog().at(-1).input, /画面1/);

  // 2) CLI 坏了 + 开回落 → 走 OpenAI 兼容接口
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'custom', custom: { bin: 'ic-no-such-cli-xyz' }, llmFallback: true } });
  const s2 = mk(2);
  await tools.runTool(ctxOf(), 'write_shot_video_prompt', { shot_id: s2.id });
  assert.match(Shots.get(s2.id).video_prompt, /^LLM REPLY #/);

  // 3) CLI 坏了 + 不回落 → 报错，提示词不动
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'custom', custom: { bin: 'ic-no-such-cli-xyz' }, llmFallback: false } });
  const s3 = mk(3);
  const n3 = llmCalls;
  const out3 = await tools.runTool(ctxOf(), 'write_shot_video_prompt', { shot_id: s3.id }).catch((e) => 'ERR:' + e.message);
  assert.match(String(out3), /未开启「回落|Agent 运行时/);
  assert.equal(String(Shots.get(s3.id).video_prompt || ''), '');
  assert.equal(llmCalls, n3);

  // 4) 内置运行时：照旧走 OpenAI 兼容接口
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'openclaude' } });
  const s4 = mk(4);
  await tools.runTool(ctxOf(), 'write_shot_video_prompt', { shot_id: s4.id });
  assert.match(Shots.get(s4.id).video_prompt, /^LLM REPLY #/);
});

test('音乐 caption 改写：optimizeMusicBrief 用注入的 chat（= brainChat），不再直连 llm', async () => {
  let n = 0;
  const chat = async (messages, opts) => {
    n++;
    if (opts && opts.maxTokens === 600) return { content: '{"primary":"general-pop-ballad","secondary":""}' };
    return { content: '{"caption":"warm piano ballad","lyrics":""}' };
  };
  const r = await core.optimizeMusicBrief({ llm: { baseUrl: '' }, chat, caption: '温柔的钢琴', lyrics: '', duration: 30, style: '' });
  assert.equal(r.caption, 'warm piano ballad');
  assert.ok(n >= 2);
});

test('preflight「LLM 创作」：外部 Agent 为主时只查 CLI，不去探 OpenAI 兼容接口（此前没 key 会被 401 误拦）', async () => {
  const { preflight } = await import('../lib/agent/stages.js');
  const dead = { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' };
  // CLI 找得到 → 放行（llm 指向死端口也不影响）
  const ok = await preflight(['llm'], { llm: dead, agent: customNode() });
  assert.ok(Array.isArray(ok.warns));
  // CLI 找不到 + 不回落 → 明确报「Agent 运行时未就绪」
  await assert.rejects(() => preflight(['llm'], { llm: dead, agent: { runtime: 'custom', custom: { bin: 'ic-no-such-cli-xyz' }, llmFallback: false } }), /Agent 运行时未就绪/);
  // CLI 找不到 + 回落 → 按 OpenAI 兼容接口探测（死端口 → LLM 未就绪）
  await assert.rejects(() => preflight(['llm'], { llm: dead, agent: { runtime: 'custom', custom: { bin: 'ic-no-such-cli-xyz' }, llmFallback: true } }), /LLM 未就绪/);
  // 内置运行时：照旧探 OpenAI 兼容接口
  await assert.rejects(() => preflight(['llm'], { llm: dead, agent: { runtime: 'openclaude' } }), /LLM 未就绪/);
});
