// ic28 单测用假 CLI：
//   模式 custom（默认）：读 stdin，原文记到 FAKE_BRAIN_LOG，stdout 输出 FAKE_BRAIN_REPLY（默认固定文本）。
//   模式 claude（argv 含 --input-format stream-json）：校验参数、解析 stream-json 输入，按 Claude Code 格式输出 result 事件。
//   FAKE_BRAIN_EXIT=非 0 → 以该码退出（模拟 CLI 未登录/报错）。
import fs from 'node:fs';

const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const log = process.env.FAKE_BRAIN_LOG;
  const isClaude = args.includes('--input-format');
  let sys = '';
  const sf = args.indexOf('--system-prompt-file');
  if (sf >= 0) { try { sys = fs.readFileSync(args[sf + 1], 'utf8'); } catch {} }
  if (log) fs.appendFileSync(log, JSON.stringify({ args, input, sys, env: { CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI || '' } }) + '\n');
  const code = Number(process.env.FAKE_BRAIN_EXIT || 0);
  if (code) { process.stderr.write('fake cli error: Not logged in'); process.exit(code); }
  const reply = process.env.FAKE_BRAIN_REPLY || 'FAKE CLI REPLY';
  if (isClaude) {
    let ev = null;
    try { ev = JSON.parse(input.trim().split('\n')[0]); } catch {}
    const blocks = ev?.message?.content || [];
    const nImg = blocks.filter((b) => b.type === 'image').length;
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply + (nImg ? ' [img=' + nImg + ']' : ''), stop_reason: 'end_turn' }) + '\n');
  } else {
    process.stdout.write(reply + '\n');
  }
});
