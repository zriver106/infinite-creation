// IC 经验规则（skills/ic-lessons）按阶段附进技能正文（2026-11-23 IC规则同步第3步）。
// 只读：不连网、不提交渲染（8188/8189/4610 守卫）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-lessons-'));
writeTempIcConfig(tmp);
const L = await import('../lib/core/lessons.js');
const SE = await import('../lib/agent/skill-engine.js');
const P = await import('../lib/core/prompts.js');

const NL = String.fromCharCode(10);
const SAMPLE = [
  '---', 'name: ic-lessons', 'description: x', '---', '', '# 标题', '版本：v-test（x）。', '引言不进小节。', '',
  '## 【通用】甲', '通用内容', '',
  '## 【剧本】乙', '剧本内容', '',
  '## 【分镜】【提示词】丙', '分镜提示词内容', '',
  '## 【待测】【提示词】丁', '待测提示词内容', '',
  '## 【待测】【审片】戊', '待测审片内容',
].join(NL);

describe('ic-lessons 解析与按阶段选择', () => {
  test('小节标签、待测标记、版本', () => {
    const p = L.parseLessons(SAMPLE);
    assert.equal(p.version, 'v-test');
    assert.deepEqual(p.sections.map((s) => s.title), ['【通用】甲', '【剧本】乙', '【分镜】【提示词】丙', '【待测】【提示词】丁', '【待测】【审片】戊']);
    assert.deepEqual(p.sections.map((s) => s.pending), [false, false, false, true, true]);
    assert.ok(!p.sections.some((s) => s.text.includes('引言')));
  });
  test('提示词阶段：通用 + 本阶段正式 + 本阶段待测；不带别的阶段', () => {
    const s = L.renderLessons(['提示词'], { text: SAMPLE });
    assert.match(s, /^<ic_lessons stage="提示词" version="v-test" md5="[0-9A-F]{32}">/);
    for (const w of ['通用内容', '分镜提示词内容', '待测提示词内容', '【待测规则（临时，照样执行）】']) assert.ok(s.includes(w), w);
    for (const w of ['剧本内容', '待测审片内容']) assert.ok(!s.includes(w), w);
    assert.ok(s.trim().endsWith('</ic_lessons>'));
  });
  test('总控（空阶段）只带通用，不带待测', () => {
    const s = L.renderLessons([], { text: SAMPLE });
    assert.ok(s.includes('通用内容'));
    assert.ok(!s.includes('【待测规则（临时，照样执行）】') && !s.includes('待测提示词内容'), '总控不附待测');
    assert.ok(s.includes('各阶段开工前'));
  });
  test('IC_LESSONS=off 关闭', () => {
    const old = process.env.IC_LESSONS;
    process.env.IC_LESSONS = 'off';
    try { assert.equal(L.renderLessons(['提示词'], { text: SAMPLE }), ''); } finally {
      if (old === undefined) delete process.env.IC_LESSONS; else process.env.IC_LESSONS = old;
    }
  });
});

describe('真实技能加载时带上经验规则', () => {
  test('h3-prompt-writing 带【提示词】正式与待测，正文原样保留在前', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'skills', 'h3-prompt-writing', 'SKILL.md'), 'utf8');
    const k = SE.loadSkill('h3-prompt-writing');
    const i = k.body.indexOf('<ic_lessons stage="提示词"');
    assert.ok(i > 0);
    assert.ok(k.body.slice(0, i).includes('## Inner-Monologue (OS / 心声) Shots'));
    assert.ok(raw.length > 0);
    assert.ok(k.body.includes('【待测】【提示词】两人有对白就写视线锁'));
    assert.ok(!k.body.includes('【待测】【审片】'), '不带审片待测');
  });
  test('分镜、剧本、审片、资产、总控各自的技能带对应阶段', () => {
    const cases = [['story-pipeline-cn', '剧本、分镜'], ['sd-storyboard-engine', '分镜'], ['sd-script-engine', '剧本'], ['sd-qc-engine', '审片'], ['sd-asset-engine', '资产'], ['novel-to-video', '总控']];
    for (const [name, stage] of cases) {
      const k = SE.loadSkill(name);
      assert.ok(k, name);
      assert.ok(k.body.includes('<ic_lessons stage="' + stage + '"'), name + ' → ' + stage);
    }
  });
  test('ic-lessons 本身不重复附；不在映射表里的技能不附', () => {
    assert.ok(!SE.loadSkill('ic-lessons').body.includes('<ic_lessons'));
    assert.ok(!SE.loadSkill('tts-voice-design').body.includes('<ic_lessons'));
  });
  test('skill 工具渲染（外部 Agent 与 writeShotVideoPrompt 同一路径）带经验规则', () => {
    const t = SE.renderSkillContent({ ...SE.loadSkillWithResources('h3-prompt-writing'), references: [] });
    assert.ok(t.includes('<ic_lessons stage="提示词"'));
    assert.ok(t.indexOf('<ic_lessons') < t.indexOf('</skill_instructions>'));
  });
  test('剧本接口（不走技能）也带【剧本】', () => {
    const m = P.buildChapterScriptMessages({ chapterTitle: 't', novel: 'x', mode: 'generate' });
    assert.ok(m[0].content.includes('<ic_lessons stage="剧本"'));
    assert.ok(m[0].content.includes('念出来的数字写汉字'));
  });
});
