// 续轮12快（2026-11-24）：剧本/分镜阶段硬检 + 提示词撰写「指定镜重写」。临时 IC_DATA_DIR，绝不碰真实 data/ic.db。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stage-guards-'));
process.env.IC_DATA_DIR = TMP;
delete process.env.IC_STAGE_GUARDS;

const core = await import('../lib/core/index.js');
const { createToolRuntime, runTool } = await import('../lib/agent/tools.js');
const { checkDialogueAgainstScript, costumeBindingError } = await import('../lib/agent/stage-guards.js');
const pw = await import('../lib/agent/prompt-write-mcp.js');
const { Projects, Chapters, Shots, Jobs, Assets, withWriteContext, DB_PATH, projectDir } = core;

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const SCRIPT = '【第1场｜夜｜餐厅】\n出场：江澈、唐知夏\n唐知夏：帅哥，不好意思给你添麻烦。\n江澈（OS）：滨海大学？还是学妹？\n经理：这位是老板的小舅子。';

function setup() {
  const p = withWriteContext('test', () => Projects.create({ name: '硬检' }));
  const ex = Chapters.list(p.id).find((c) => c.title === '第1章');
  const ch = ex ? withWriteContext('test', () => Chapters.update(ex.id, { script: SCRIPT })) : withWriteContext('test', () => Chapters.create(p.id, { title: '第1章', script: SCRIPT }));
  const jiang = withWriteContext('test', () => Assets.create(p.id, { category: 'character', name: '江澈' }));
  withWriteContext('test', () => Assets.create(p.id, { category: 'costume', name: '江澈·衬衫', parent_id: jiang.id }));
  const job = Jobs.create({ projectId: p.id, type: 'create', checkpoint: { chapter: '第1章' } });
  const ctx = createToolRuntime({ projectId: p.id, jobId: job.id, chapter: '第1章', renderDisabled: true });
  return { p, ch, ctx, job };
}
const loadRules = async (ctx) => { await runTool(ctx, 'skill', { name: 'adapt-rules' }); await runTool(ctx, 'skill', { name: 'sd-storyboard-engine' }); };
const shot = (over = {}) => ({ chapter: '第1章', idx: 1, visual: '餐厅', duration: 8, characters: ['江澈'], costumes: ['江澈·衬衫'], dialogue: '江澈（OS）：滨海大学？还是学妹？', ...over });

test('DB 在临时目录', () => { assert.ok(DB_PATH.startsWith(TMP)); });

test('纯函数：台词逐字对剧本；错字/剧本里没有的句子报错；只差空白引号不报', () => {
  assert.equal(checkDialogueAgainstScript('经理：这位是老板的小舅子。', SCRIPT).errors.length, 0);
  assert.equal(checkDialogueAgainstScript('经理：这位是老板的小舒子。', SCRIPT).errors.length, 1);
  assert.equal(checkDialogueAgainstScript('江澈（OS）：光这个背影，就能打九分。', SCRIPT).errors.length, 1);
  assert.equal(checkDialogueAgainstScript('唐知夏：「帅哥， 不好意思给你添麻烦。」', SCRIPT).errors.length, 0);
  assert.equal(checkDialogueAgainstScript('唐知夏：帅哥。', '').errors.length, 1);
  assert.ok(costumeBindingError({ idx: 3, characters: ['江澈'] }, ['c1'], []));
  assert.equal(costumeBindingError({ idx: 3, characters: [] }, [], []), '');
});

test('a：本任务没读 adapt-rules / sd-storyboard-engine → set_storyboard、set_chapter_script 拒；读了才放行，且 rule_usage 记 md5/字数', async () => {
  const { p, ctx } = setup();
  await assert.rejects(runTool(ctx, 'set_storyboard', { shots: [shot()] }), /还没读规则书.*adapt-rules.*sd-storyboard-engine/);
  await assert.rejects(runTool(ctx, 'set_chapter_script', { chapter: '第1章', script: 'x', overwrite: true }), /还没读规则书/);
  await loadRules(ctx);
  const out = await runTool(ctx, 'set_storyboard', { shots: [shot()] });
  assert.match(out, /分镜已写入/);
  const rows = fs.readFileSync(path.join(projectDir(p.id), 'rule_usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sk = rows.filter((r) => r.tool === 'skill').map((r) => r.skill);
  assert.deepEqual(sk, ['adapt-rules', 'sd-storyboard-engine']);
  for (const r of rows) { assert.ok(r.md5 && r.chars > 0); assert.equal(r.job_id, ctx.jobId); }
});

test('b：set_storyboard 带 video_prompt 整批拒；文本任务 update_shot 写 video_prompt 拒', async () => {
  const { p, ctx } = setup();
  await loadRules(ctx);
  await assert.rejects(runTool(ctx, 'set_storyboard', { shots: [shot({ video_prompt: 'x __MINIMAX_H3_REF_1__' })] }), /不接受 video_prompt/);
  assert.equal(Shots.list(p.id).length, 0);
  await runTool(ctx, 'set_storyboard', { shots: [shot()] });
  const s = Shots.list(p.id)[0];
  await assert.rejects(runTool(ctx, 'update_shot', { shot_id: s.id, video_prompt: 'abc' }), /分镜阶段不写 video_prompt/);
});

test('b：改了内容、未出视频的旧镜，旧提示词存档后清空（收尾会起提示词撰写）；未改内容的不动', async () => {
  const { p, ctx } = setup();
  await loadRules(ctx);
  await runTool(ctx, 'set_storyboard', { shots: [shot(), shot({ idx: 2 })] });
  for (const s of Shots.list(p.id)) Shots.update(s.id, { video_prompt: '旧提示词' + s.idx });
  await runTool(ctx, 'set_storyboard', { shots: [shot({ visual: '餐厅·改' }), shot({ idx: 2 })], replace_chapter: false });
  const by = Object.fromEntries(Shots.list(p.id).map((s) => [s.idx, s]));
  assert.equal(by[1].video_prompt, '');
  assert.equal(by[2].video_prompt, '旧提示词2');
  const hist = fs.readFileSync(path.join(projectDir(p.id), 'prompt_history.jsonl'), 'utf8');
  assert.match(hist, /旧提示词1/);
});

test('c/d：有人物没服装、错字、剧本里没有的句子 → 整批拒，一镜不写', async () => {
  const { p, ctx } = setup();
  await loadRules(ctx);
  await assert.rejects(runTool(ctx, 'set_storyboard', { shots: [shot({ costumes: [] })] }), /costumes 为空/);
  await assert.rejects(runTool(ctx, 'set_storyboard', { shots: [shot(), shot({ idx: 2, dialogue: '经理：这位是老板的小舒子。' })] }), /剧本里找不到这句原话.*小舒子/);
  await assert.rejects(runTool(ctx, 'set_storyboard', { shots: [shot({ dialogue: '江澈（OS）：光这个背影，就能打九分。' })] }), /剧本里找不到/);
  assert.equal(Shots.list(p.id).length, 0);
});

test('f：文本任务里 set_chapter_music 默认跳过，不改配乐', async () => {
  const { ctx } = setup();
  const out = JSON.parse(await runTool(ctx, 'set_chapter_music', { chapter: '第1章', music_id: '17', caption: '情绪类别：x｜选曲：17｜x｜理由：x' }));
  assert.equal(out.skipped, true);
});

test('提示词撰写·指定镜重写：名单内已出视频的镜可写、名单外不可写；存档后每镜只写一次', () => {
  const rw = new Set(['a']);
  const done = { id: 'a', status: 'done', video_path: 'x.mp4', video_prompt: '旧' };
  const other = { id: 'b', status: 'done', video_path: 'y.mp4', video_prompt: '' };
  assert.equal(pw.shotNeedsPromptForJob(done, rw, new Set()), true);
  assert.equal(pw.shotNeedsPromptForJob(other, rw, new Set()), false);
  assert.equal(pw.shotNeedsPromptForJob(done, rw, new Set(['a'])), false);
  assert.equal(pw.shotNeedsPromptForJob({ ...done, status: 'generating' }, rw, new Set()), false);
  // 不给名单 = 原口径
  assert.equal(pw.shotNeedsPromptForJob(done, null, null), false);
  assert.equal(pw.shotNeedsPromptForJob({ id: 'c', status: 'pending' }, null, null), true);
});
