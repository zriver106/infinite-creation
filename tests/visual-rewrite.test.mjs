// 服装规则会话（2026-11-24）：分镜 visual 指定镜重写 + refs 角色描述按绑定服装写。临时数据目录 + 临时配置，不碰真库、不调 LLM/CLI/ComfyUI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-vr-'));
let core; let pw; let pwm; let cfgMod;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  cfgMod = await import('../lib/core/config.js');
  pw = await import('../lib/agent/prompt-write.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function setup(name) {
  const { Projects, Chapters, Shots, Assets } = core;
  const p = Projects.create({ name, auto_script: false });
  const ch = Chapters.create(p.id, { title: '第8章', script: 's' });
  const dir = cfgMod.projectDir(p.id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'c.png'), PNG);
  fs.writeFileSync(path.join(dir, 'assets', 'o.png'), PNG);
  const chr = Assets.create(p.id, { category: 'character', name: '江澈', description: '人物主图描述：灰西装' });
  Assets.update(chr.id, { image_path: 'assets/c.png' });
  const cos = Assets.create(p.id, { category: 'costume', name: '江澈·白T短裤', parent_id: chr.id, description: '我方资产ID：C001_O49；审核：final；挂在角色C001；江澈·白T短裤，正面全身：白色短袖T恤、深灰及膝短裤、白色帆布鞋。' });
  Assets.update(cos.id, { image_path: 'assets/o.png' });
  const mk = (idx, extra = {}) => Shots.create(p.id, { chapter: '第8章', idx, visual: '江澈进店。服装锁：江澈白色圆领短袖T恤、深灰直筒裤、米白帆布鞋。', dialogue: '江澈：看看车', camera: '中景', sub_shots: '0-4 进店', video_prompt: 'old prompt trousers', character_ids: [chr.id], costume_ids: [cos.id], ...extra });
  const a = mk(1); const b = mk(2); const c = mk(3);
  Shots.update(a.id, { status: 'done', video_path: 'projects/x/a.mp4' });
  return { p, ch, chr, cos, a: Shots.get(a.id), b: Shots.get(b.id), c: Shots.get(c.id), dir };
}

const ctxOf = (p, jobId) => ({ projectId: p.id, jobId, chapter: '第8章', project: core.Projects.get(p.id), cfg: {} });

test('submitPromptWriteJob：target 校验（visual 必须带 shot_ids；未知 target 拒）', () => {
  const { p, ch, a } = setup('vr-submit');
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch, target: 'visual' }), (e) => e.code === 'BAD_TARGET');
  assert.throws(() => pw.submitPromptWriteJob({ projectId: p.id, chapter: ch, shotIds: [a.id], target: 'dialogue' }), (e) => e.code === 'BAD_TARGET');
});

test('save_shot_visual：只写 visual、只写名单内的镜、先读 adapt-rules、旧 visual 存档、每镜一次；提示词保存在 visual 任务里被拒', async () => {
  const { Shots, Jobs } = core;
  const { p, a, b, c, dir } = setup('vr-save');
  const REQ = '只把江澈的服装改成绑定的白T短裤（白色短袖T恤、深灰及膝短裤、白色帆布鞋），其余字一律不动';
  const job = Jobs.create({ projectId: p.id, type: 'prompt_write', checkpoint: { chapter: '第8章', promptWrite: true, rewriteShotIds: [a.id, b.id], rewriteRequirements: { [a.id]: REQ }, rewriteTarget: 'visual', lockedFieldsMd5: { [a.id]: pwm.lockedFieldsMd5(a), [b.id]: pwm.lockedFieldsMd5(b) } } });
  assert.equal(pwm.targetOfJob(job.id), 'visual');
  const ctx = ctxOf(p, job.id);
  pwm._resetPromptWriteSession();
  const NEW = '江澈进店。服装锁：江澈白色短袖T恤、深灰及膝短裤、白色帆布鞋。';
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, visual: NEW }), /adapt-rules/);
  pwm.notePromptWriteToolCall('skill', { name: 'adapt-rules' });
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: c.id, visual: NEW }), /不在本任务的重写名单/);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, visual: '   ' }), /visual 为空/);
  pwm.notePromptWriteToolCall('skill', { name: 'h3-prompt-writing' });
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_video_prompt', { shot_id: a.id, video_prompt: 'x' }), /只能用 save_shot_visual/);
  const brief = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'get_shot_prompt_brief', { shot_id: a.id }));
  assert.equal(brief.rewrite_target, 'visual');
  assert.equal(brief.revision_requirement, REQ);
  assert.equal(brief.bound_costumes.length, 1);
  assert.match(brief.bound_costumes[0].description, /深灰及膝短裤/);
  assert.equal(brief.bound_costumes[0].character, '江澈');
  const todo = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'list_prompt_todo', {}));
  assert.equal(todo.remaining, 2);
  const before = Shots.get(a.id);
  const r = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, visual: NEW }));
  assert.equal(r.saved, true); assert.equal(r.field, 'visual'); assert.equal(r.remaining, 1);
  const after = Shots.get(a.id);
  assert.equal(after.visual, NEW);
  for (const k of Object.keys(before)) {
    if (k === 'visual' || k === 'updated_at') continue;
    assert.deepEqual(after[k], before[k], '字段 ' + k + ' 不能变');
  }
  assert.equal(after.status, 'done'); assert.equal(after.video_path, 'projects/x/a.mp4');
  const hist = fs.readFileSync(path.join(dir, 'prompt_history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((h) => h.job_id === job.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].action, 'rewrite_visual');
  assert.equal(hist[0].visual, before.visual);
  assert.equal(hist[0].new_visual, NEW);
  assert.equal(hist[0].requirement, REQ);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, visual: NEW + '再改' }), /本任务已改过/);
  assert.equal(Shots.get(a.id).visual, NEW);
  assert.equal(Shots.get(c.id).visual, c.visual, '名单外的镜不动');
  const prompt = pwm.buildPromptWriteAgentPrompt({ project: core.Projects.get(p.id), chapter: '第8章', missing: 2, jobId: job.id });
  assert.match(prompt, /save_shot_visual/); assert.match(prompt, /adapt-rules/); assert.match(prompt, /其余文字逐字保留/);
});

test('普通提示词任务里 save_shot_visual 被拒；提示词重写存档口径不受影响', async () => {
  const { Jobs } = core;
  const { p, a } = setup('vr-normal');
  const job = Jobs.create({ projectId: p.id, type: 'prompt_write', checkpoint: { chapter: '第8章', promptWrite: true, rewriteShotIds: [a.id] } });
  assert.equal(pwm.targetOfJob(job.id), 'video_prompt');
  pwm._resetPromptWriteSession();
  pwm.notePromptWriteToolCall('skill', { name: 'adapt-rules' });
  await assert.rejects(pwm.runPromptWriteExtraTool(ctxOf(p, job.id), 'save_shot_visual', { shot_id: a.id, visual: 'x' }), /只在「分镜 visual 指定镜重写」任务里可用/);
  const prompt = pwm.buildPromptWriteAgentPrompt({ project: core.Projects.get(p.id), chapter: '第8章', missing: 1, jobId: job.id });
  assert.doesNotMatch(prompt, /save_shot_visual\(shot_id/);
});

test('refs：角色描述按本镜绑定的服装资产写（去掉登记字段）；没绑服装用人物主图描述', async () => {
  const { Assets, Shots } = core;
  const { p, a, chr } = setup('vr-refs');
  const r = await core.assembleShotReferences({ cfg: {}, project: core.Projects.get(p.id), shot: Shots.get(a.id), assets: Assets.list(p.id), upload: false });
  assert.match(r.characterDesc, /^江澈（本镜绑定服装：江澈·白T短裤）：/);
  assert.match(r.characterDesc, /深灰及膝短裤/);
  assert.doesNotMatch(r.characterDesc, /灰西装|我方资产ID|审核：|挂在角色/);
  const s2 = Shots.create(p.id, { chapter: '第8章', idx: 9, visual: 'x', character_ids: [chr.id], costume_ids: [] });
  const r2 = await core.assembleShotReferences({ cfg: {}, project: core.Projects.get(p.id), shot: Shots.get(s2.id), assets: Assets.list(p.id), upload: false });
  assert.equal(r2.characterDesc, '人物主图描述：灰西装');
});

test('续轮15：save_shot_visual 可写 sub_shots、camera；锁定字段带了就拒、md5 变了就拒；三字段旧值存档', async () => {
  const { Shots, Jobs } = core;
  const { p, ch, a, b, dir } = setup('vr-r15');
  const REQ = '去掉一镜到底，按 At MM:SS [Shot N] 把心声和出口台词分成两段';
  const job = Jobs.create({ projectId: p.id, type: 'prompt_write', checkpoint: { chapter: '第8章', promptWrite: true, rewriteShotIds: [a.id, b.id], rewriteRequirements: { [a.id]: REQ }, rewriteTarget: 'visual', lockedFieldsMd5: { [a.id]: pwm.lockedFieldsMd5(a), [b.id]: 'DEADBEEF' } } });
  const ctx = ctxOf(p, job.id);
  pwm._resetPromptWriteSession();
  pwm.notePromptWriteToolCall('skill', { name: 'adapt-rules' });
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, camera: '中景跟拍', dialogue: '改台词' }), /不准写 dialogue/);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, camera: '中景', costumes: ['x'] }), /不准写 costumes/);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, duration: 8, camera: 'x' }), /不准写 duration/);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id }), /至少要传一个/);
  await assert.rejects(pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: b.id, camera: '中景' }), /锁定字段.*已变/);
  const before = Shots.get(a.id);
  const r = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'save_shot_visual', { shot_id: a.id, sub_shots: 'At 00:00 [Shot 1] 心声；At 00:04 [Shot 2] 出口台词', camera: '中景，缓慢推近' }));
  assert.deepEqual(r.fields, ['sub_shots', 'camera']);
  const after = Shots.get(a.id);
  assert.equal(after.camera, '中景，缓慢推近'); assert.match(after.sub_shots, /\[Shot 2\]/);
  assert.equal(after.visual, before.visual, '没传 visual 就不动');
  assert.equal(pwm.lockedFieldsMd5(after), pwm.lockedFieldsMd5(before));
  for (const k of pwm.VISUAL_LOCKED_FIELDS) assert.deepEqual(after[k], before[k], '锁定字段 ' + k + ' 不能变');
  const hist = fs.readFileSync(path.join(dir, 'prompt_history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((h) => h.job_id === job.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].action, 'rewrite_visual');
  assert.equal(hist[0].visual, before.visual); assert.equal(hist[0].sub_shots, before.sub_shots); assert.equal(hist[0].camera, before.camera);
  assert.equal(hist[0].requirement, REQ);
  assert.deepEqual(hist[0].fields, ['sub_shots', 'camera']);
  // 锁定 md5：数组顺序无关、空值统一
  assert.equal(pwm.lockedFieldsMd5({ character_ids: ['b', 'a'] }), pwm.lockedFieldsMd5({ character_ids: ['a', 'b'], dialogue: '' }));
  assert.notEqual(pwm.lockedFieldsMd5({ dialogue: 'x' }), pwm.lockedFieldsMd5({ dialogue: 'y' }));
});
