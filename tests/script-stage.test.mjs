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
  for (const c of ['NARRATION_MANY', 'NARRATION_LONG', 'NO_PICTURE_LINE', 'OS_THIRD_PERSON', 'SCRIPT_SHORTER', 'NOVEL_LINE_MISSING', 'NO_BEAT_TABLE', 'NO_SCENE_LOCK', 'NO_CONVERSION_NOTE']) assert.ok(codes.includes(c), c + ' in ' + codes.join(','));
  const NT = '';   // 剧本精简（总导 11-28）：不再写叙述转换表，章末一两行【转换说明】
  const CN = '\n【转换说明】作者的叙述转成了画面和心声。';
  const LOCK = '**场头锁定**\n- **地点：** 公司办公室\n- **在场：** 江澈、韩志成\n- **服装：** 江澈浅灰衬衫\n- **站位：** 江澈坐中间，韩志成从右后来\n';
  const good = '## 本章节拍表\n| 拍 | 原著 |\n\n' + NT + '## 【第1场｜上午｜公司办公室】\n' + LOCK + '[画面：江澈坐在工位上发愣，盯着屏幕一动不动。]\n\n[画面：韩志成从过道快步走来，一掌拍在桌上。]\n韩志成：江澈！上班时间还敢发呆摸鱼，扣两百！\n江澈（OS）：完了，这个月又白干了。她说等工作稳定，我连房租都快交不上。\n[画面：江澈缩了缩脖子，赶紧把手放回键盘。]\n【衔接→第2场】切前：江澈缩脖子；方式：承接；切后：江澈拿手机；声音：键盘声延续\n## 【第2场｜上午｜公司办公室】\n**地点、时段光线、在场、服装、站位：** 同第 1 场。\n[画面：江澈拿起手机。]\n【衔接→下一章】切前：江澈看手机；方式：跳时；切后：次日清晨；声音：铃声起' + CN;
  assert.deepEqual(SG.checkScriptDraft(good, NOVEL), [], '有节拍表、场头锁定（含合并写法「地点、…站位：同第 1 场」）、场间和章末都有【衔接】、数字两种写法、「她说」说别人、有画面行都不报');
  const END = '\n【衔接→下一章】方式：跳时' + CN;
  const runs = SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n' + LOCK + '[画面：江澈躺着。]\n江澈（OS）：一。\n江澈（OS）：二。\n江澈（OS）：三。' + END, '');
  assert.deepEqual(runs.map((x) => x.code), ['OS_RUN'], '同一场连续 3 句心声');
  const longPic = SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n' + LOCK + '[画面：江澈推门进屋，把包扔在沙发上，弯腰换鞋，抬头看见桌上的外卖盒，愣了一下。]' + END, '');
  assert.deepEqual(longPic.map((x) => x.code), ['PICTURE_LONG'], '一条画面行塞了多个动作');
  assert.deepEqual(SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n**场头锁定**\n- **地点：** 家\n- **在场：** 江澈\n- **服装：** 睡衣\n[画面：躺着。]' + END, '').map((x) => x.detail.replace(/^.*：/, '')), ['场头锁定缺 站位']);
  const noTr = SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n' + LOCK + '[画面：躺着。]\n## 【第2场｜夜｜家】\n' + LOCK + '[画面：坐起。]', '');
  assert.deepEqual(noTr.map((x) => x.code).filter((c) => c !== 'NO_CONVERSION_NOTE'), ['NO_TRANSITION', 'NO_TRANSITION'], '场间没衔接 + 末场没【衔接→下一章】');
  // 剧本精简：第 1 场不认「同第N场」；其余场认「同第N场；变化：…」，地点和引用那场不同要写全；衔接多行要压成一行；没写【转换说明】软提示
  assert.match(SG.checkScriptDraft('## 本章节拍表\n## 【第1场｜夜｜家】\n**场头锁定：** 同第1场\n[画面：躺着。]' + END, '').map((x) => x.detail).join(), /第 1 场要写全场头锁定/);
  const LOCK2 = '**场头锁定：** 同第1场；变化：江澈坐起\n';
  assert.deepEqual(SG.checkScriptDraft('## 本章节拍表\n## 【第1场｜夜｜家】\n' + LOCK + '[画面：躺着。]\n【衔接→第2场】切前：躺｜方式：承接｜切后：坐｜声音：静\n## 【第2场｜夜｜家】\n' + LOCK2 + '[画面：坐起。]' + END, '').map((x) => x.code), [], '其余场「同第N场；变化：…」算齐');
  const moved = SG.checkScriptDraft('## 本章节拍表\n## 【第1场｜夜｜家】\n' + LOCK + '[画面：躺着。]\n【衔接→第2场】切前：躺｜方式：跳｜切后：走｜声音：静\n## 【第2场｜夜｜街上】\n**场头锁定：** 同第1场\n- **地点：** 楼下街边\n[画面：走着。]' + END, '');
  assert.match(moved.map((x) => x.detail).join(), /地点「楼下街边」和第 1 场「公司办公室」不同，场头锁定要写全/);
  const multi = SG.checkScriptDraft('## 本章节拍表\n## 【第1场｜夜｜家】\n' + LOCK + '[画面：躺着。]\n【衔接→第2场】\n切前：躺着\n方式：承接\n## 【第2场｜夜｜家】\n' + LOCK2 + '[画面：坐起。]' + END, '');
  assert.match(multi.map((x) => x.detail).join(), /衔接写成了多行/);
  assert.deepEqual(SG.checkScriptDraft('## 本章节拍表\n## 【第1场｜夜｜家】\n' + LOCK + '[画面：躺着。]\n【衔接→下一章】方式：跳时', '').map((x) => x.code), ['NO_CONVERSION_NOTE']);
  assert.deepEqual(SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n' + LOCK + '[画面：江澈躺着。]\n江澈（OS）：一。\n【表演说明：这里声音放轻，眼睛一直看着天花板，不要转头，也不要动手，保持三秒后再接下一句。】\n江澈（OS）：二。' + END, '').map((x) => x.code), [], '表演说明行不算画面行、不打断也不算心声');
  assert.deepEqual(SG.checkScriptDraft('## 本章节拍表\n' + NT + '## 【第1场｜夜｜家】\n' + LOCK + '[画面：江澈站在窗边看着楼下的车流慢慢散开。]' + END, '').map((x) => x.code), [], '两个逗号以内、80 字以内不报');
});

test('get_chapter：本章还没剧本、规则没读完 → 不给原著正文；读完 adapt-rules + sd-storyboard-engine（开了表现开关还要 H2）才给', async () => {
  const p = core.Projects.create({ name: 'sc', auto_script: true });
  const ch = core.Chapters.list(p.id)[0];
  core.Chapters.update(ch.id, { novel: NOVEL });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc' });
  const r1 = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
  assert.equal(r1.novel, ''); assert.equal(r1.novel_chars, NOVEL.length); assert.match(r1.novel_withheld, /adapt-rules/);
  SG.noteSkillServed(ctx, 'adapt-rules'); SG.noteSkillServed(ctx, 'sd-storyboard-engine');
  // adapt-rules 带了剧本样稿：没读样稿也不给
  const rs = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
  assert.equal(rs.novel, ''); assert.match(rs.novel_withheld, /剧本样稿/);
  await tools.runTool(ctx, 'skill_reference', { name: 'adapt-rules', ref: '剧本样稿.md' });
  const rm = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: ch.title }));
  assert.equal(rm.novel, ''); assert.match(rm.novel_withheld, /叙述转换方法/);
  await tools.runTool(ctx, 'skill_reference', { name: 'adapt-rules', ref: '叙述转换方法.md' });
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

test('一章一个写剧本回合：本任务存过一章剧本后，下一章的原著正文要再读一遍剧本样稿才给', async () => {
  const p = core.Projects.create({ name: 'sc3', auto_script: true });
  const c1 = core.Chapters.list(p.id)[0];
  const c2 = core.Chapters.create(p.id, { title: '第2章', novel: NOVEL });
  core.Chapters.update(c1.id, { novel: NOVEL });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc4' });
  SG.noteSkillServed(ctx, 'adapt-rules'); SG.noteSkillServed(ctx, 'sd-storyboard-engine'); SG.noteSkillLinesServed(ctx, 'adapt-rules', ['H2']);
  await tools.runTool(ctx, 'skill_reference', { name: 'adapt-rules', ref: '剧本样稿.md' });
  await tools.runTool(ctx, 'skill_reference', { name: 'adapt-rules', ref: '叙述转换方法.md' });
  assert.equal(JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: c1.title })).novel, NOVEL);
  await new Promise((r) => setTimeout(r, 5));
  await tools.runTool(ctx, 'set_chapter_script', { chapter: c1.title, script: '## 【第1场｜上午｜办公室】\n[画面：x。]' });
  const r = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: c2.title }));
  assert.equal(r.novel, ''); assert.match(r.novel_withheld, /再读一遍样稿/);
  await new Promise((r2) => setTimeout(r2, 5));
  await tools.runTool(ctx, 'skill_reference', { name: 'adapt-rules', ref: '剧本样稿.md' });
  assert.equal(JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: c2.title })).novel, NOVEL);
});

test('只写剧本（重写模式）：只有要写的那一章不给旧剧本；上一章照常给剧本，好对末场（R-006 第6条）', async () => {
  const p = core.Projects.create({ name: 'sc-rw', auto_script: true });
  const c1 = core.Chapters.list(p.id)[0];
  const c2 = core.Chapters.create(p.id, { title: '第2章', novel: NOVEL });
  core.Chapters.update(c1.id, { novel: NOVEL, script: '上一章末场：江澈在走廊接电话' });
  core.Chapters.update(c2.id, { script: '旧第2章剧本' });
  const ctx = tools.createToolRuntime({ projectId: p.id, jobId: 'jsc-rw', chapter: c2.title });
  ctx.scriptRewrite = true;
  const prev = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: c1.title }));
  assert.equal(prev.script, '上一章末场：江澈在走廊接电话');
  assert.equal(prev.novel, NOVEL);
  const self = JSON.parse(await tools.runTool(ctx, 'get_chapter', { chapter: c2.title }));
  assert.equal(self.script, '');
});

test('只写剧本工具集：带读地点表和戏份说明（服装锁定照戏份说明抄）', async () => {
  const SW = await import('../lib/agent/script-write.js');
  const names = SW.scriptWriteToolDefinitions(tools.TOOL_DEFINITIONS).map((t) => t.function.name);
  for (const n of ['get_locations', 'list_scene_notes', 'get_scene_note', 'get_chapter', 'set_chapter_script']) assert.ok(names.includes(n), n);
  assert.match(SW.buildScriptWriteAgentPrompt({ project: { name: 'x' }, chapter: '第2章' }), /get_scene_note[\s\S]*上一章/);
});
