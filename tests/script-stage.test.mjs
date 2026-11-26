// 剧本阶段（Andy 11-26「怎么这么多旁白」「v2 3204 字剧本到 v3 才一千多」）：先读规则再给原著正文；存盘自检只报不拦；skill_lines 读过 H2 才算。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-script-'));
let core; let tools; let SG; let cfgMod;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  cfgMod = await import('../lib/core/config.js');
  tools = await import('../lib/agent/tools.js');
  SG = await import('../lib/agent/stage-guards.js');
});

const NOVEL = '江澈正坐在工位上发愣。\n“江澈，上班时间还敢发呆摸鱼，扣200！”韩志成拍了拍桌子。\n江澈心里一沉。';

test('checkScriptDraft：旁白多 / 旁白长 / 没有 [画面：] / 心声第三人称 / 比原著短 / 原著台词找不到', () => {
  const bad = '【第1场｜上午｜公司办公室】\n出场人物：江澈、韩志成\n旁白：江澈正坐在工位上发愣，脑海里忽然响起一个清晰无比的声音。\n旁白：韩志成走了过来。\n江澈（心声）：江澈心想这下完了。';
  const codes = SG.checkScriptDraft(bad, NOVEL + NOVEL).map((x) => x.code);
  for (const c of ['NARRATION_MANY', 'NARRATION_LONG', 'NO_PICTURE_LINE', 'OS_THIRD_PERSON', 'SCRIPT_SHORTER', 'NOVEL_LINE_MISSING']) assert.ok(codes.includes(c), c + ' in ' + codes.join(','));
  const good = '【第1场｜上午｜公司办公室】\n出场人物：江澈、韩志成\n[画面：江澈坐在工位上发愣，盯着屏幕一动不动。韩志成从过道快步走来，脸拉得老长，一掌拍在桌上。]\n韩志成：江澈！上班时间还敢发呆摸鱼，扣两百！\n江澈（心声）：完了，这个月又白干了。她说等工作稳定，我连房租都快交不上。\n[画面：江澈缩了缩脖子，赶紧把手放回键盘。]';
  assert.deepEqual(SG.checkScriptDraft(good, NOVEL), [], '数字两种写法、「她说」说别人、有画面行都不报');
});

test('get_chapter：本章还没剧本、规则没读完 → 不给原著正文；读完 adapt-rules + sd-storyboard-engine（开了表现开关还要 H2）才给', async () => {
  const p = core.Projects.create({ name: 'sc', auto_script: true });
  const ch = core.Chapters.list(p.id)[0];
  core.Chapters.update(ch.id, { novel: NOVEL });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc' });
  const r1 = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
  assert.equal(r1.novel, ''); assert.equal(r1.novel_chars, NOVEL.length); assert.match(r1.novel_withheld, /adapt-rules/);
  SG.noteSkillServed(ctx, 'adapt-rules'); SG.noteSkillServed(ctx, 'sd-storyboard-engine');
  const r2 = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
  const switchesOn = Object.values(core.Projects.get(p.id) ? (await import('../lib/shared/index.js')).expressionSwitchValues(core.Projects.get(p.id)) : {}).some(Boolean);
  if (switchesOn) {
    assert.equal(r2.novel, ''); assert.match(r2.novel_withheld, /H2/);
    SG.noteSkillLinesServed(ctx, 'adapt-rules', ['H2']);
    const r3 = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
    assert.equal(r3.novel, NOVEL);
  } else assert.equal(r2.novel, NOVEL);
  // 已有剧本的章：照常给
  core.Chapters.update(ch.id, { script: 'x' });
  const ctx2 = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc2' });
  assert.equal(JSON.parse(await tools.runTool(ctx2, 'get_chapter', { chapter: ch.title })).novel, NOVEL);
});

test('set_chapter_script：存盘照存，自检结果返回给写手并记 script_checks.jsonl', async () => {
  const p = core.Projects.create({ name: 'sc2', auto_script: true });
  const ch = core.Chapters.list(p.id)[0];
  core.Chapters.update(ch.id, { novel: NOVEL });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc3' });
  SG.noteSkillServed(ctx, 'adapt-rules'); SG.noteSkillServed(ctx, 'sd-storyboard-engine');
  const r = JSON.parse(await tools.runTool(ctx, 'set_chapter_script', { chapter: ch.title, script: '【第1场｜上午｜办公室】\n旁白：江澈正坐在工位上发愣，脑海里忽然响起一个声音。' }));
  assert.ok(r.chars > 0); assert.ok(r.checks.some((c) => c.code === 'NO_PICTURE_LINE'));
  assert.match(r.checks_rule, /overwrite=true/);
  assert.ok(core.Chapters.get(ch.id).script.includes('旁白'), '只报不拦：剧本已存');
  const log = fs.readFileSync(path.join(cfgMod.projectDir(p.id), 'script_checks.jsonl'), 'utf8');
  assert.match(log, /NO_PICTURE_LINE/);
});
