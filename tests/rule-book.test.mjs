// 规则书加载（续轮6 契约 r6）：loader / skill_lines 上限与越界 / 覆盖段 / brief required_ranges / too_dense / 存盘 ranges_ack。
// 临时 IC_DATA_DIR + IC_CONFIG（:9），拦 8188/8189；夹具在 tests/fixtures/rulebook/（IC_SKILLS_OVERRIDE_DIR 指过去）。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'rulebook');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rulebook-'));
writeTempIcConfig(tmp);
process.env.IC_SKILLS_OVERRIDE_DIR = FIX;

const RB = await import('../lib/core/rule-book.js');
const SE = await import('../lib/agent/skill-engine.js');
const core = await import('../lib/core/index.js');
const tools = await import('../lib/agent/tools.js');
const PWM = await import('../lib/agent/prompt-write-mcp.js');
const H3 = 'h3-prompt-writing';
const idx = RB.loadRuleIndex(H3);
const ck = (id) => idx.sections.find((s) => s.id === id).checksum;
const BASE_ACK = () => ['MAP', 'A'].map(ck);

function verifyBook(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, '规则全文.index.json'), 'utf8').replace(/^﻿/, ''));
  const strip = (t) => t.replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  const full = strip(fs.readFileSync(path.join(dir, index.file), 'utf8'));
  const skill = strip(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  if (skill.length && skill[skill.length - 1] === '') skill.pop();
  assert.deepEqual(skill, full.slice(0, index.base_end_line), 'SKILL.md = 规则全文.md 前 base_end_line 行');
  for (const s of index.sections) {
    const got = crypto.createHash('md5').update(full.slice(s.start - 1, s.end - 1).join('\n'), 'utf8').digest('hex').slice(0, 8).toUpperCase();
    assert.equal(got, s.checksum, s.id + ' 校验码');
    assert.equal(full[s.end - 1].trim(), '本段校验码：' + s.checksum, s.id + ' 末行');
  }
  return index;
}

describe('loader 与 skill_lines', () => {
  test('夹具与真实 h3 规则书：SKILL.md 等于前 base_end_line 行，各段校验码可复算', () => {
    verifyBook(path.join(FIX, H3));
    verifyBook(path.join(FIX, 'adapt-rules'));
    const real = path.join(HERE, '..', 'skills', H3);
    if (fs.existsSync(path.join(real, '规则全文.index.json'))) {
      const ri = verifyBook(real);
      assert.ok(RB.loadRuleIndex(H3, real).sections.length === ri.sections.length);
    }
  });
  test('loadRuleIndex：有索引返回对象，没有返回 null，非法名 null', () => {
    assert.equal(idx.skill, H3);
    assert.equal(RB.loadRuleIndex('tts-voice-design'), null);
    assert.equal(RB.loadRuleIndex('../x'), null);
  });
  test('readSkillLines 闭区间、越界报错、超 40000 字报错', () => {
    const r = SE.readSkillLines(H3, 1, 3);
    assert.equal(r.text.split('\n').length, 3);
    assert.throws(() => SE.readSkillLines(H3, 0, 3), /越界/);
    assert.throws(() => SE.readSkillLines(H3, 5, 4), /越界/);
    assert.throws(() => SE.readSkillLines(H3, 1, idx.total_lines + 1), /越界/);
    const big = path.join(tmp, 'bigbook');
    fs.mkdirSync(big, { recursive: true });
    const lines = Array.from({ length: 1000 }, () => 'y'.repeat(50));
    fs.writeFileSync(path.join(big, '规则全文.md'), lines.join('\r\n'));
    fs.writeFileSync(path.join(big, '规则全文.index.json'), JSON.stringify({ skill: 'big', file: '规则全文.md', sections: [] }));
  });
  test('CRLF 容忍 + 超长报错', () => {
    const big = path.join(tmp, 'bigbook');
    assert.equal(RB.readSkillLines('big', 1, 2, big).text, 'y'.repeat(50) + '\n' + 'y'.repeat(50));
    assert.throws(() => RB.readSkillLines('big', 1, 1000, big), /过长/);
  });
  test('sectionsCoveredBy 只算完整覆盖的段', () => {
    const os_ = idx.sections.find((s) => s.id === 'OS');
    assert.deepEqual(RB.sectionsCoveredBy(idx, os_.start, os_.end).map((s) => s.id), ['OS']);
    assert.deepEqual(RB.sectionsCoveredBy(idx, os_.start, os_.end - 1).map((s) => s.id), []);
    assert.deepEqual(RB.sectionsCoveredBy(idx, 1, idx.base_end_line).map((s) => s.id), ['MAP', 'A']);
  });
  test('规则书技能不附 ic-lessons；skill 工具超 40000 报错不截断', async () => {
    const k = SE.loadSkill(H3);
    assert.ok(!k.body.includes('<ic_lessons'));
  });
});

describe('真实规则书（skills/）', () => {
  test('skill(h3-prompt-writing) / skill(adapt-rules) 返回不超 40000 字；各分册 skill_lines 可读且只覆盖本段', async () => {
    const old = process.env.IC_SKILLS_OVERRIDE_DIR;
    delete process.env.IC_SKILLS_OVERRIDE_DIR;
    try {
      for (const n of [H3, 'adapt-rules']) {
        const ri = RB.loadRuleIndex(n);
        if (!ri) continue;
        const t = await tools.runTool({}, 'skill', { name: n });
        assert.ok(t.length <= 40000, n + ' ' + t.length);
        assert.ok(!t.includes('<ic_lessons'), n);
        for (const s of ri.sections.filter((x) => x.tier === 'volume')) {
          assert.deepEqual(RB.readSkillLines(n, s.start, s.end).sections, [s.id], n + ' ' + s.id);
        }
      }
    } finally { process.env.IC_SKILLS_OVERRIDE_DIR = old; }
  });
});

describe('brief / save（prompt-write MCP）', () => {
  let p; let ctx;
  const { Projects, Chapters, Shots } = core;
  before(() => {
    p = Projects.create({ name: '规则书单测', auto_script: false });
    try { Chapters.create(p.id, { title: '第1章', script: 's' }); } catch { /* 新建项目已自带第1章 */ }
    ctx = { projectId: p.id, project: Projects.get(p.id), chapter: '第1章', cfg: {}, jobId: 'job-t' };
  });
  const brief = async (sid) => JSON.parse(await PWM.runPromptWriteExtraTool(ctx, 'get_shot_prompt_brief', { shot_id: sid }));
  const ids = (b) => b.required_ranges.map((r) => r.id);

  test('OS 镜 / 系统镜 / 两人镜 的 required_ranges；too_dense', async () => {
    const a = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: '他站着', dialogue: '江澈（OS）：走吧', mode: 'text' });
    const b = Shots.create(p.id, { chapter: '第1章', idx: 2, visual: '光幕弹出', mode: 'text' });
    const c1 = core.Assets.create(p.id, { name: '甲', category: 'character' });
    const c2 = core.Assets.create(p.id, { name: '乙', category: 'character' });
    const c = Shots.create(p.id, { chapter: '第1章', idx: 3, visual: '两人对坐', character_ids: [c1.id, c2.id], mode: 'text' });
    const d = Shots.create(p.id, { chapter: '第1章', idx: 4, visual: '扫码付款', mode: 'text' });
    const ba = await brief(a.id);
    assert.ok(ids(ba).includes('OS') && !ids(ba).includes('SYS'));
    assert.equal(ba.rules_version, 'rules-test-r1');
    assert.equal(ba.too_dense, false);
    assert.ok(!ids(ba).includes('RARE'));
    const bb = await brief(b.id);
    assert.ok(ids(bb).includes('SYS') && !ids(bb).includes('OS'));
    const shotC = Shots.get(c.id);
    const bc = await brief(c.id);
    assert.equal(shotC.character_ids.length, 2);
    assert.ok(ids(bc).includes('MULTI'), JSON.stringify(ids(bc)));
    const bd = await brief(d.id);
    assert.equal(bd.too_dense, true);
    assert.equal(bd.required_chars, idx.base_chars + idx.sections.find((s) => s.id === 'BIG').chars);
    PWM._resetPromptWriteSession();
    PWM.notePromptWriteToolCall('skill', { name: H3 });
    await assert.rejects(PWM.runPromptWriteExtraTool(ctx, 'save_shot_video_prompt', { shot_id: d.id, video_prompt: 'A man scans.', ranges_ack: [] }), /too_dense[\s\S]*7–8 秒/);
  });

  test('存盘：无 ack / 错校验码 / 未读过的段 拒；读过后成功并记 rule_usage', async () => {
    PWM._resetPromptWriteSession();
    const s = Shots.create(p.id, { chapter: '第1章', idx: 5, visual: '光幕弹出', mode: 'text' });
    const save = (ack) => PWM.runPromptWriteExtraTool(ctx, 'save_shot_video_prompt', { shot_id: s.id, video_prompt: 'A man stands still in a quiet room.', ranges_ack: ack });
    // skill 工具（经 tools.runTool）返回后由 MCP 记已返回段
    PWM.notePromptWriteToolCall('skill', { name: H3 });
    const skillText = await tools.runTool(ctx, 'skill', { name: H3 });
    assert.ok(skillText.includes('本段校验码：' + ck('A')));
    PWM.notePromptWriteToolResult('skill', { name: H3 });
    await assert.rejects(save(undefined), /ranges_ack 缺少/);
    await assert.rejects(save([...BASE_ACK(), 'DEADBEEF']), /SYS/);
    await assert.rejects(save([...BASE_ACK(), ck('SYS')]), /还没真正读过[\s\S]*SYS/);
    const sys = idx.sections.find((x) => x.id === 'SYS');
    const txt = await tools.runTool(ctx, 'skill_lines', { name: H3, from: sys.start, to: sys.end });
    assert.ok(txt.endsWith('本段校验码：' + sys.checksum));
    PWM.notePromptWriteToolResult('skill_lines', { name: H3, from: sys.start, to: sys.end });
    const todo = JSON.parse(await PWM.runPromptWriteExtraTool(ctx, 'list_prompt_todo', {}));
    assert.deepEqual(todo.skill_loaded, { loaded: true, sections: ['MAP', 'A', 'SYS'] });
    const r = JSON.parse(await save([...BASE_ACK(), ck('SYS')]));
    assert.equal(r.saved, true);
    const usage = fs.readFileSync(path.join(core.projectDir(p.id), 'rule_usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(usage.map((u) => u.tool), ['skill', 'skill_lines', 'save_ack']);
    assert.equal(usage[1].from, sys.start);
    assert.deepEqual(usage[1].sections, ['SYS']);
    assert.deepEqual(usage[2].sections, ['MAP', 'A', 'SYS']);
    assert.equal(usage[2].shot_id, s.id);
  });

  test('report_rule_gap 追加到 rule_gaps.jsonl；工具在 prompt-write 工具集里', async () => {
    await tools.runTool(ctx, 'report_rule_gap', { shot_id: 's1', situation: '情况', what_i_did: '做法', why: '原因' });
    const g = fs.readFileSync(path.join(core.projectDir(p.id), 'rule_gaps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(g[0].situation, '情况');
    assert.ok(PWM.isPromptWriteToolAllowed('skill_lines') && PWM.isPromptWriteToolAllowed('report_rule_gap'));
    const names = PWM.promptWriteToolDefinitions(tools.TOOL_DEFINITIONS).map((t) => t.function.name);
    assert.ok(names.includes('skill_lines') && names.includes('report_rule_gap'));
    const prompt = PWM.buildPromptWriteAgentPrompt({ project: { name: 'x' }, chapter: '第1章', missing: 1 });
    assert.ok(prompt.includes('required_ranges') && prompt.includes('ranges_ack') && prompt.includes('report_rule_gap') && prompt.includes('7–8 秒'));
  });

  // 2026-11-26（Andy「写提示词的时候不光要看剧本，还要看原著」）：brief 带本章剧本和原著，每章本任务只给一次全文
  test('brief：本章第一镜带 chapter_script / chapter_novel，后面的镜只给提示；任务提示词有 2b 步', async () => {
    PWM._resetPromptWriteSession();
    const ch = Chapters.list(p.id).find((c) => c.title === '第1章');
    Chapters.update(ch.id, { novel: '清晨，宋老在公园散步，他点了点头，江澈站到队尾跟着练。', script: '江澈：早。' });
    const s1 = Shots.create(p.id, { chapter: '第1章', idx: 21, visual: '公园', mode: 'text' });
    const s2 = Shots.create(p.id, { chapter: '第1章', idx: 22, visual: '队尾', mode: 'text' });
    const b1 = await brief(s1.id);
    assert.match(b1.chapter_novel, /站到队尾跟着练/);
    assert.equal(b1.chapter_script, '江澈：早。');
    assert.match(b1.source_rule, /原著为准/);
    const b2 = await brief(s2.id);
    assert.equal(b2.chapter_novel, undefined);
    assert.match(b2.chapter_source, /get_chapter/);
    assert.match(b2.source_rule, /原著为准/);
    const prompt = PWM.buildPromptWriteAgentPrompt({ project: { name: 'x' }, chapter: '第1章', missing: 1 });
    assert.ok(prompt.includes('chapter_novel') && prompt.includes('以原著为准'));
  });
});
