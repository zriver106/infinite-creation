// 「提示词撰写」单测：临时数据目录 + 临时配置 + 本机假 LLM / 假外部 Agent CLI（不碰真实 data/ic.db、不调用真 LLM / 真 CLI、不碰 ComfyUI）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pw-'));
let server;
let calls = 0;
let core;
let pw;
let pwm;
let cfgPath;
let llmBase;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj));

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '测试提示词 #' + calls }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  cfgPath = path.join(tmp, 'config.json');
  llmBase = 'http://127.0.0.1:' + port + '/v1';
  // 旧路径（内置 openclaude 运行时 → 逐镜 llm.js）用假 LLM 测；外部 Agent 路径在后面的用例里换成假 CLI。
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'openclaude' } });
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  // 续轮6：本文件测旧布局（无 规则全文.index.json）的行为；规则书布局见 tests/rule-book.test.mjs。
  const oldH3 = path.join(tmp, 'skills-old', 'h3-prompt-writing');
  fs.mkdirSync(oldH3, { recursive: true });
  // 真实 SKILL.md 已接近 40000 字上限，再加参考文件索引会超限报错：旧布局用例只取前 20000 字
  fs.writeFileSync(path.join(oldH3, 'SKILL.md'), fs.readFileSync(path.join(HERE, '..', 'skills', 'h3-prompt-writing', 'SKILL.md'), 'utf8').slice(0, 20000));
  process.env.IC_SKILLS_OVERRIDE_DIR = path.join(tmp, 'skills-old');
  core = await import('../lib/core/index.js');
  pw = await import('../lib/agent/prompt-write.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
});

after(() => { try { server.close(); } catch {} });

async function waitJob(id, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const j = core.Jobs.get(id);
    if (j && !['running', 'queued'].includes(j.status)) return j;
    if (Date.now() - t0 > ms) throw new Error('job timeout ' + JSON.stringify(j));
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('chapterPromptGap / shotNeedsPrompt 口径', () => {
  const g = pw.chapterPromptGap([
    { video_prompt: 'x' },
    { video_prompt: '', status: 'pending' },
    { video_prompt: '  ', status: 'done', video_path: 'a.mp4' },
    { video_prompt: '', status: 'failed' },
  ]);
  assert.deepEqual(g, { total: 4, missing: 2, missingWithVideo: 1 });
  assert.equal(pw.shotNeedsPrompt({ video_prompt: '', status: 'done', video_path: '' }), true);
});

test('lane：外部云端 CLI → 文本队列（与只拆分镜同口径）；内置运行时按 LLM 地址；总开关关 → 视频队列', () => {
  assert.equal(pw.promptWriteLane({ llm: { baseUrl: 'http://127.0.0.1:8080' }, agent: { runtime: 'claude' } }).lane, 'text');
  assert.equal(pw.promptWriteLane({ llm: { baseUrl: 'https://api.deepseek.com' }, agent: { runtime: 'openclaude' } }).lane, 'text');
  assert.equal(pw.promptWriteLane({ llm: { baseUrl: 'http://127.0.0.1:8080' }, agent: { runtime: 'openclaude' } }).lane, 'gpu');
  assert.equal(pw.promptWriteLane({ llm: { baseUrl: 'https://x' }, generation: { storyboardQueue: false }, agent: { runtime: 'claude' } }).lane, 'gpu');
  assert.equal(pw.promptWriteAgentId({ agent: { runtime: 'claude' } }), 'claude');
  assert.equal(pw.promptWriteAgentId({ agent: { runtime: 'openclaude' } }), '');
  assert.equal(pw.promptWriteAgentId({}), '');
});

test('checkVideoPrompt：占位符全引用、不新造；<d> 成对；账目词拦截；围栏剥掉', () => {
  const ok = pwm.checkVideoPrompt('```\n__MINIMAX_H3_REF_1__ man, __MINIMAX_H3_REF_2__ voice (S1) says <d>[Chinese] 你好</d>\n```', 2);
  assert.equal(ok.ok, true, ok.errors.join());
  assert.ok(!ok.text.includes('```'));
  assert.match(pwm.checkVideoPrompt('__MINIMAX_H3_REF_1__ only', 2).errors.join(), /漏引用.*REF_2/);
  assert.match(pwm.checkVideoPrompt('__MINIMAX_H3_REF_1__ __MINIMAX_H3_REF_3__', 1).errors.join(), /新造.*REF_3/);
  assert.match(pwm.checkVideoPrompt('__MINIMAX_H3_REF_1__', 0).errors.join(), /纯文生视频/);
  assert.match(pwm.checkVideoPrompt('a <d>[Chinese] x', 0).errors.join(), /不成对/);
  assert.match(pwm.checkVideoPrompt('a <d>x <d>y</d></d>', 0).errors.join(), /不成对/);
  assert.match(pwm.checkVideoPrompt('台词：无，画面安静', 0).errors.join(), /账目词/);
  assert.equal(pwm.checkVideoPrompt('He says <d>[Chinese] 我的心声</d>', 0).ok, true, '<d> 里的原台词不算账目词');
  assert.equal(pwm.checkVideoPrompt('   ', 0).ok, false);
});

test('MCP 受限工具集：只读工具 + 三个专用工具，无任何渲染/写分镜工具', async () => {
  const tools = await import('../lib/agent/tools.js');
  const names = pwm.promptWriteToolDefinitions(tools.TOOL_DEFINITIONS).map((t) => t.function.name).sort();
  assert.deepEqual(names, ['get_chapter', 'get_project', 'get_shot_prompt_brief', 'list_assets', 'list_prompt_todo', 'report', 'report_rule_gap', 'save_shot_video_prompt', 'save_shot_visual', 'skill', 'skill_lines', 'skill_reference', 'view_asset', 'view_shot_references'].sort());
  for (const n of names) assert.ok(!tools.RENDER_TOOLS.has(n), n + ' 不能是渲染工具');
  for (const n of ['update_shot', 'set_storyboard', 'set_chapter_script', 'write_shot_video_prompt', 'regenerate_shot', 'generate_shot_video']) {
    assert.equal(pwm.isPromptWriteToolAllowed(n), false, n);
  }
});

test('外部 Agent 路径（注入假 runAgent）：2 轮内写完；无进展不重试；报错且一镜未写 → 交给调用方判失败', async () => {
  const { Projects, Chapters, Shots } = core;
  const p = Projects.create({ name: '提示词撰写-外部Agent-注入', auto_script: false });
  Chapters.create(p.id, { title: '第5章', script: 's' });
  const ids = [1, 2, 3].map((i) => Shots.create(p.id, { chapter: '第5章', idx: i, visual: 'v' + i, mode: 'text' }).id);
  const seen = [];
  // 第 1 轮只写 2 镜，第 2 轮写完
  let round = 0;
  const r = await pw.fillChapterVideoPromptsViaAgent({
    projectId: p.id, title: '第5章', agentId: 'claude',
    runAgentFn: async (o) => {
      round++;
      seen.push({ promptWrite: o.promptWrite, renderDisabled: o.renderDisabled, chapter: o.chapter, agentId: o.agentId, missing: o.promptWriteMissing });
      const todo = Shots.list(p.id).filter((s) => s.chapter === '第5章' && !s.video_prompt);
      for (const s of todo.slice(0, round === 1 ? 2 : 9)) Shots.update(s.id, { video_prompt: 'P' + s.idx });
    },
  });
  assert.equal(r.written, 3);
  assert.equal(r.remaining, 0);
  assert.equal(r.rounds, 2);
  assert.deepEqual(seen[0], { promptWrite: true, renderDisabled: true, chapter: '第5章', agentId: 'claude', missing: 3 });
  assert.equal(seen[1].missing, 1);
  for (const id of ids) assert.ok(Shots.get(id).video_prompt);

  Shots.create(p.id, { chapter: '第5章', idx: 4, visual: 'v4', mode: 'text' });
  let n = 0;
  const r2 = await pw.fillChapterVideoPromptsViaAgent({
    projectId: p.id, title: '第5章', agentId: 'claude',
    runAgentFn: async () => { n++; throw new Error('Not logged in'); },
  });
  assert.equal(n, 1, '无进展不重试');
  assert.equal(r2.written, 0);
  assert.match(r2.summary, /Not logged in/);
});


test('内置运行时（旧路径）只补缺的镜：不清分镜、不改剧本、不动已出视频的镜；任务带章节号；完成后再提交 409 口径', async () => {
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'openclaude' } });
  const { Projects, Chapters, Shots, Jobs } = core;
  const p = Projects.create({ name: '提示词撰写单测', auto_script: false });
  const ch = Chapters.create(p.id, { title: '第3章', script: '原剧本' });
  const a = Shots.create(p.id, { chapter: '第3章', idx: 1, visual: 'A', video_prompt: '原提示词A', mode: 'text' });
  const b = Shots.create(p.id, { chapter: '第3章', idx: 2, visual: 'B', mode: 'text' });
  const c = Shots.create(p.id, { chapter: '第3章', idx: 3, visual: 'C', mode: 'text' });
  Shots.update(c.id, { status: 'done', video_path: 'projects/x/c.mp4' });
  const d = Shots.create(p.id, { chapter: '第3章', idx: 4, visual: 'D', mode: 'text' });
  const before = Shots.list(p.id).length;

  // 同章已有任务 → CHAPTER_BUSY（路由翻 409）
  const busy = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第3章' } });
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch }), (e) => e.code === 'CHAPTER_BUSY');
  Jobs.update(busy.id, { status: 'done', finishedAt: Date.now() });

  const r = pw.submitPromptWriteJob({ projectId: p.id, chapter: ch });
  assert.equal(r.missing, 2);
  assert.equal(r.missingWithVideo, 1);
  assert.equal(r.job.type, 'prompt-write');
  assert.equal(r.job.checkpoint.chapter, '第3章');
  assert.equal(r.job.checkpoint.promptWrite, true);
  // 任务在跑期间，同章再提交 → CHAPTER_BUSY
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch }), (e) => e.code === 'CHAPTER_BUSY');

  const j = await waitJob(r.job.id);
  assert.equal(j.status, 'done', j.error);
  assert.equal(Shots.list(p.id).length, before, '分镜数不变');
  assert.equal(Shots.get(a.id).video_prompt, '原提示词A', '已有提示词不动');
  assert.match(Shots.get(b.id).video_prompt, /^测试提示词/);
  assert.match(Shots.get(d.id).video_prompt, /^测试提示词/);
  assert.equal(Shots.get(c.id).video_prompt, '', '已出视频的镜不补写');
  assert.equal(Shots.get(c.id).video_path, 'projects/x/c.mp4');
  assert.equal(Chapters.get(ch.id).script, '原剧本', '剧本不动');
  assert.equal(calls, 2, '只调用 2 次 LLM');
  assert.deepEqual(j.progress, { done: 2, total: 2 });

  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch }), (e) => e.code === 'NOTHING_TO_WRITE');
  const empty = Chapters.create(p.id, { title: '第4章' });
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: empty }), (e) => e.code === 'NO_SHOTS');
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: { title: '' } }), (e) => e.code === 'CHAPTER_REQUIRED');
});

test('外部 Agent 端到端（假 CLI 经真实 MCP 服务）：受限工具集、越权被拒、未加载技能被拒、占位符校验、只补缺不覆盖、不动剧本/分镜数', async () => {
  const { Projects, Chapters, Shots, Jobs } = core;
  const bin = path.join(tmp, 'mockbin');
  fs.mkdirSync(bin, { recursive: true });
  const mock = path.join(HERE, 'fixtures', 'mock-agent.mjs');
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'ic-mock-agent.cmd'), '@"' + process.execPath + '" "' + mock + '" %*\r\n');
  else { fs.writeFileSync(path.join(bin, 'ic-mock-agent'), '#!/bin/sh\nexec "' + process.execPath + '" "' + mock + '" "$@"\n'); fs.chmodSync(path.join(bin, 'ic-mock-agent'), 0o755); }
  const reportFile = path.join(tmp, 'mock-report.json');
  process.env.MOCK_AGENT_REPORT = reportFile;
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'custom', extraPath: bin, custom: { bin: 'ic-mock-agent', args: '--mcp-config {mcpConfig}' } } });
  const llmCallsBefore = calls;

  const p = Projects.create({ name: '提示词撰写-外部Agent-端到端', auto_script: false });
  const ch = Chapters.create(p.id, { title: '第7章', script: '原剧本7' });
  const a = Shots.create(p.id, { chapter: '第7章', idx: 1, visual: 'A', video_prompt: '原提示词A', mode: 'text' });
  const b = Shots.create(p.id, { chapter: '第7章', idx: 2, visual: 'B', dialogue: '江澈：走吧', mode: 'text' });
  const c = Shots.create(p.id, { chapter: '第7章', idx: 3, visual: 'C', mode: 'text' });
  Shots.update(c.id, { status: 'done', video_path: 'projects/x/c.mp4' });
  const d = Shots.create(p.id, { chapter: '第7章', idx: 4, visual: 'D', mode: 'text' });
  const other = Shots.create(p.id, { chapter: '第8章', idx: 1, visual: 'O', mode: 'text' });
  const before = Shots.list(p.id).length;

  const r = pw.submitPromptWriteJob({ projectId: p.id, chapter: ch });
  assert.equal(r.missing, 2);
  assert.equal(r.job.checkpoint.writer, 'agent:custom');
  assert.equal(r.job.checkpoint.chapter, '第7章');
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch }), (e) => e.code === 'CHAPTER_BUSY');
  const j = await waitJob(r.job.id, 60000);
  assert.equal(j.status, 'done', j.error || j.detail);
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(rep.done, true);
  assert.deepEqual(rep.toolNames.slice().sort(), ['get_chapter', 'get_project', 'get_shot_prompt_brief', 'list_assets', 'list_prompt_todo', 'report', 'report_rule_gap', 'save_shot_video_prompt', 'save_shot_visual', 'skill', 'skill_lines', 'skill_reference', 'view_asset', 'view_shot_references'].sort());
  for (const [k, v] of Object.entries(rep.forbidden)) assert.equal(v, 'rejected', k);
  assert.equal(rep.rejectedBeforeSkill, true);
  assert.equal(rep.skillLoaded, true);
  assert.equal(rep.todoBefore, 2);
  assert.equal(rep.saved, 2);
  assert.equal(rep.overwriteRejected, true);
  assert.equal(rep.todoAfter, 0);
  assert.match(rep.prompt, /第7章/);
  assert.match(rep.prompt, /h3-prompt-writing/);
  assert.equal(Shots.list(p.id).length, before, '分镜数不变');
  assert.equal(Shots.get(a.id).video_prompt, '原提示词A');
  assert.match(Shots.get(b.id).video_prompt, /MOCK H3 prompt for shot 2.*<d>\[Chinese\] 走吧<\/d>/);
  assert.match(Shots.get(d.id).video_prompt, /MOCK H3 prompt for shot 4/);
  assert.equal(Shots.get(c.id).video_prompt, '', '已出视频的镜不补写');
  assert.equal(Shots.get(other.id).video_prompt, '', '别的章不动');
  assert.equal(Chapters.get(ch.id).script, '原剧本7');
  assert.equal(calls, llmCallsBefore, '外部 Agent 路径不调用内置 llm.js');
  assert.deepEqual(j.progress, { done: 2, total: 2 });
  assert.ok(j.logPath, '有任务日志');
});

test('第三轮：只生成分镜收尾补提示词 → 外部 Agent（claude 定义，显式 --model opus，受限工具集），不调 llm.js', async () => {
  const { Projects, Chapters, Shots, Jobs } = core;
  const bin = path.join(tmp, 'mockbin-claude');
  fs.mkdirSync(bin, { recursive: true });
  const mock = path.join(HERE, 'fixtures', 'mock-agent.mjs');
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"' + process.execPath + '" "' + mock + '" %*\r\n');
  else { fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec "' + process.execPath + '" "' + mock + '" "$@"\n'); fs.chmodSync(path.join(bin, 'claude'), 0o755); }
  const reportFile = path.join(tmp, 'mock-report-sb.json');
  process.env.MOCK_AGENT_REPORT = reportFile;
  writeCfg({ llm: { baseUrl: llmBase, model: 'mock' }, agent: { runtime: 'claude', extraPath: bin } });
  const llmCallsBefore = calls;
  const p = Projects.create({ name: '只生成分镜-收尾-外部Agent', auto_script: false });
  Chapters.create(p.id, { title: '第3章', script: '原剧本3' });
  const a = Shots.create(p.id, { chapter: '第3章', idx: 1, visual: 'A', mode: 'text' });
  const b = Shots.create(p.id, { chapter: '第3章', idx: 2, visual: 'B', dialogue: '江澈：走吧', mode: 'text' });
  const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第3章', storyboardOnly: true } });
  const out = await pw.afterStoryboardTextJob({ projectId: p.id, chapter: '第3章', jobId: job.id });
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const mi = rep.argv.indexOf('--model');
  assert.ok(mi >= 0, '显式传 --model：' + JSON.stringify(rep.argv));
  assert.equal(rep.argv[mi + 1], 'opus');
  assert.ok(rep.argv.includes('--strict-mcp-config'));
  assert.ok(!rep.toolNames.includes('set_storyboard') && rep.toolNames.includes('save_shot_video_prompt'), '受限工具集');
  assert.equal(rep.saved, 2);
  assert.match(Shots.get(a.id).video_prompt, /MOCK H3 prompt for shot 1/);
  assert.match(Shots.get(b.id).video_prompt, /MOCK H3 prompt for shot 2/);
  assert.equal(calls, llmCallsBefore, '收尾补提示词不再调用内置 llm.js');
  assert.match(out, /外部 Agent claude/);
  // 提示词都齐了再收尾一次：不再拉起 Agent
  fs.rmSync(reportFile);
  const out2 = await pw.afterStoryboardTextJob({ projectId: p.id, chapter: '第3章', jobId: job.id });
  assert.ok(!fs.existsSync(reportFile));
  assert.match(out2, /视频提示词已齐/);
});

test('第三轮：claude 定义默认不带 --model（其它任务模型不变）；modelArgs 只在显式给值时生效', async () => {
  const { claude } = await import('../lib/agent/external/defs/claude.js');
  const args = claude.buildArgs({ ws: '/tmp/ws' });
  assert.ok(!args.includes('--model'));
  assert.deepEqual(claude.modelArgs('opus'), ['--model', 'opus']);
  assert.deepEqual(claude.modelArgs(''), []);
  assert.equal(pwm.PROMPT_WRITE_MODEL, 'opus');
});
