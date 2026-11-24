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

// 续轮6（契约 r6）：h3-prompt-writing、adapt-rules 已是规则书（有 规则全文.index.json）。
// 剧本/分镜技能附 adapt-rules 的地图+基础规则（<adapt_rules>）代替 ic-lessons；提示词阶段什么都不附；其余阶段照旧附 ic-lessons。
const SK = path.join(process.cwd(), 'skills');
const hasBook = (n) => fs.existsSync(path.join(SK, n, '规则全文.index.json'));

describe('真实技能加载时附带的规则', () => {
  test('h3-prompt-writing：规则书布局不附 ic-lessons；旧布局附【提示词】', () => {
    const k = SE.loadSkill('h3-prompt-writing');
    if (hasBook('h3-prompt-writing')) {
      assert.ok(!k.body.includes('<ic_lessons') && !k.body.includes('<adapt_rules'));
      assert.ok(k.body.includes('本段校验码：'));
    } else {
      assert.ok(k.body.includes('<ic_lessons stage="提示词"'));
    }
  });
  test('剧本/分镜技能附 adapt-rules（有时）；审片、资产、总控照旧附 ic-lessons', () => {
    const adapt = hasBook('adapt-rules') || fs.existsSync(path.join(SK, 'adapt-rules', 'SKILL.md'));
    for (const name of ['story-pipeline-cn', 'sd-storyboard-engine', 'sd-script-engine']) {
      const k = SE.loadSkill(name);
      assert.ok(k, name);
      if (adapt) {
        assert.match(k.body, /<adapt_rules version="[^"]*">/, name);
        assert.ok(!k.body.includes('<ic_lessons'), name + ' 不再附 ic-lessons');
        assert.ok(!/^---\nname: adapt-rules/m.test(k.body.slice(k.body.indexOf('<adapt_rules'))), '去掉 frontmatter');
      } else {
        assert.ok(k.body.includes('<ic_lessons'), name);
      }
    }
    for (const [name, stage] of [['sd-qc-engine', '审片'], ['sd-asset-engine', '资产'], ['novel-to-video', '总控']]) {
      assert.ok(SE.loadSkill(name).body.includes('<ic_lessons stage="' + stage + '"'), name + ' → ' + stage);
    }
  });
  test('提示词阶段的其它技能（规则书存在时）不附', () => {
    if (!hasBook('h3-prompt-writing')) return;
    assert.ok(!SE.loadSkill('video-cinematography').body.includes('<ic_lessons'));
  });
  test('ic-lessons / adapt-rules 本身不重复附；不在映射表里的技能不附', () => {
    assert.ok(!SE.loadSkill('ic-lessons').body.includes('<ic_lessons'));
    assert.ok(!SE.loadSkill('tts-voice-design').body.includes('<ic_lessons'));
    if (fs.existsSync(path.join(SK, 'adapt-rules', 'SKILL.md'))) assert.ok(!SE.loadSkill('adapt-rules').body.includes('<adapt_rules'));
  });
  test('IC_LESSONS=off 时剧本/分镜也不附 adapt-rules', () => {
    const old = process.env.IC_LESSONS;
    process.env.IC_LESSONS = 'off';
    try {
      const b = SE.loadSkill('story-pipeline-cn').body;
      assert.ok(!b.includes('<adapt_rules') && !b.includes('<ic_lessons'));
    } finally { if (old === undefined) delete process.env.IC_LESSONS; else process.env.IC_LESSONS = old; }
  });
  test('adapt-rules 不存在时退回 ic-lessons（夹具覆盖目录里放一个没有 adapt-rules 的空目录不影响；直接测 renderStageRules）', () => {
    const s = L.renderStageRules(['审片']);
    assert.ok(s.includes('<ic_lessons stage="审片"'));
  });
  test('剧本接口（不走技能）附剧本阶段规则', () => {
    const m = P.buildChapterScriptMessages({ chapterTitle: 't', novel: 'x', mode: 'generate' });
    if (fs.existsSync(path.join(SK, 'adapt-rules', 'SKILL.md'))) assert.ok(m[0].content.includes('<adapt_rules'));
    else assert.ok(m[0].content.includes('<ic_lessons stage="剧本"'));
  });
});
