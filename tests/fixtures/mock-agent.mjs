// 测试用「假外部 Agent CLI」：不调用任何模型。按 claude/custom 的参数找到 MCP 配置，拉起 ic MCP 服务，
// 走一遍「提示词撰写」流程并把观察结果写到 MOCK_AGENT_REPORT（JSON）。
// 用法（custom/claude 都可）：<bin> --mcp-config <json>   prompt 从 stdin 读。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const i = argv.indexOf('--mcp-config');
const cfgPath = i >= 0 ? argv[i + 1] : '';
const report = { argv, prompt: '', toolNames: [], calls: [], saved: 0, rejected: [], forbidden: {}, done: false };
const out = process.env.MOCK_AGENT_REPORT || '';
const save = () => { if (out) try { fs.writeFileSync(out, JSON.stringify(report, null, 1)); } catch {} };

let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
await new Promise((r) => process.stdin.on('end', r));
report.prompt = stdin;

const conf = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const srv = conf.mcpServers.ic;
const child = spawn(srv.command, srv.args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, args = {}) => {
  const m = await rpc('tools/call', { name, arguments: args });
  const text = (m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || '';
  report.calls.push({ name, isError: !!(m.result && m.result.isError) });
  return { isError: !!(m.result && m.result.isError), text };
};

await rpc('initialize', { protocolVersion: '2024-11-05' });
const list = await rpc('tools/list', {});
report.toolNames = list.result.tools.map((t) => t.name);

// 越权尝试：都应被拒
for (const name of ['update_shot', 'generate_shot_video', 'set_storyboard', 'generate_chapter_videos', 'write_shot_video_prompt', 'set_chapter_script']) {
  const r = await call(name, { shot_id: 'x' });
  report.forbidden[name] = r.isError ? 'rejected' : 'ALLOWED';
}
let todo = JSON.parse((await call('list_prompt_todo')).text);
report.todoBefore = todo.remaining;
// 未加载技能先保存 → 应被拒
if (todo.shots.length) {
  const r = await call('save_shot_video_prompt', { shot_id: todo.shots[0].shot_id, video_prompt: 'x' });
  report.rejectedBeforeSkill = r.isError && /skill/.test(r.text);
}
const sk = await call('skill', { name: 'h3-prompt-writing' });
report.skillLoaded = !sk.isError && sk.text.length > 1000;
const limit = Number(process.env.MOCK_AGENT_LIMIT || 0) || todo.shots.length;
for (const s of todo.shots.slice(0, limit)) {
  const b = JSON.parse((await call('get_shot_prompt_brief', { shot_id: s.shot_id })).text);
  const refs = b.references.map((r) => r.placeholder);
  // 先故意漏一个占位符（有参考素材时）→ 应被拒，再正确保存
  if (refs.length) {
    const bad = await call('save_shot_video_prompt', { shot_id: s.shot_id, video_prompt: 'The video begins. ' + refs.slice(1).join(' ') });
    if (bad.isError) report.rejected.push(bad.text.slice(0, 160));
  }
  const d = String(b.dialogue || '').replace(/^[^：:]{1,8}[：:]/, '');
  const text = 'MOCK H3 prompt for shot ' + b.idx + '. ' + refs.map((p) => p + ' is a reference.').join(' ')
    + (d ? ' S1 says urgently, fast pace, <d>[Chinese] ' + d + '</d>' : '');
  const r = await call('save_shot_video_prompt', { shot_id: s.shot_id, video_prompt: text });
  if (!r.isError) report.saved++; else report.rejected.push('UNEXPECTED ' + r.text.slice(0, 200));
}
// 覆盖已有提示词 → 应被拒
if (todo.shots.length) {
  const r = await call('save_shot_video_prompt', { shot_id: todo.shots[0].shot_id, video_prompt: 'overwrite' });
  report.overwriteRejected = r.isError;
}
todo = JSON.parse((await call('list_prompt_todo')).text);
report.todoAfter = todo.remaining;
report.done = true;
save();
child.stdin.end();
child.kill();
process.stdout.write('mock agent done: saved ' + report.saved + '\n');
process.exit(0);
