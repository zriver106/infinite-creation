// 生成规则书夹具（契约 r6）：node tests/fixtures/rulebook/make-fixture.mjs
// 每段最后一行「本段校验码：XXXXXXXX」= 该段 start..end-1 行用 \n 连接后 md5 前 8 位大写。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function build(name, version, budget, defs) {
  const lines = [];
  const sections = [];
  let baseEnd = 0;
  for (const d of defs) {
    const start = lines.length + 1;
    const body = d.body;
    const ck = crypto.createHash('md5').update(body.join('\n'), 'utf8').digest('hex').slice(0, 8).toUpperCase();
    lines.push(...body, '本段校验码：' + ck);
    const end = lines.length;
    const chars = lines.slice(start - 1, end).join('\n').length;
    sections.push({ id: d.id, title: d.title, tier: d.tier, start, end, chars, checksum: ck, when: d.when });
    if (d.tier !== 'volume') baseEnd = end;
  }
  const full = lines.join('\n') + '\n';
  const dir = path.join(HERE, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '规则全文.md'), full);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.slice(0, baseEnd).join('\n') + '\n');
  const base = sections.filter((s) => s.tier !== 'volume');
  fs.writeFileSync(path.join(dir, '规则全文.index.json'), JSON.stringify({
    skill: name, version, file: '规则全文.md',
    file_md5: crypto.createHash('md5').update(full, 'utf8').digest('hex'),
    total_lines: lines.length, base_end_line: baseEnd,
    base_chars: base.reduce((n, s) => n + s.chars, 0), budget_chars: budget, sections,
  }, null, 2));
}

const pad = (tag, n) => Array.from({ length: n }, (_, i) => tag + ' 规则行 ' + (i + 1) + '：' + 'x'.repeat(40));

build('h3-prompt-writing', 'rules-test-r1', 3000, [
  { id: 'MAP', title: '地图', tier: 'map', when: ['always'], body: ['---', 'name: h3-prompt-writing', 'description: 夹具', '---', '# 地图', 'OS → 分册 OS', '系统 → 分册 SYS'] },
  { id: 'A', title: '基础', tier: 'base', when: ['always'], body: ['## 基础', ...pad('A', 4)] },
  { id: 'OS', title: '心声', tier: 'volume', when: ['os'], body: ['## 心声', ...pad('OS', 3)] },
  { id: 'SYS', title: '系统声', tier: 'volume', when: ['system'], body: ['## 系统声', ...pad('SYS', 3)] },
  { id: 'MULTI', title: '多人', tier: 'volume', when: ['multi'], body: ['## 多人', ...pad('MULTI', 3)] },
  { id: 'BIG', title: '交易逻辑', tier: 'volume', when: ['logic'], body: ['## 交易逻辑', ...pad('BIG', 60)] },
  { id: 'RARE', title: '罕见', tier: 'volume', when: ['rare'], body: ['## 罕见', ...pad('RARE', 2)] },
]);
build('adapt-rules', 'adapt-test-r1', 40000, [
  { id: 'MAP', title: '地图', tier: 'map', when: ['always'], body: ['---', 'name: adapt-rules', 'description: 夹具', '---', '# 改编地图'] },
  { id: 'A', title: '改编基础', tier: 'base', when: ['always'], body: ['## 改编基础', '改编基础规则内容'] },
  { id: 'V', title: '改编分册', tier: 'volume', when: ['always'], body: ['## 改编分册', '改编分册内容'] },
]);
console.log('ok');
