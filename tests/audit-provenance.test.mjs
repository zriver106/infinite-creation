// 主会话 seq2227 五件：①每镜来源审计 ②其他技能写提示词条目按条件加载 ③加载条件扫三字段 ④brief 补数据 ⑤binding-check 警告。
// 临时数据目录 + 临时配置，不碰真库、不起 CLI/GPU。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-audit-'));
let core; let cfgMod; let prov; let RB; let bc; let bk; let pwm;

before(async () => {
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgPath;
  core = await import('../lib/core/index.js');
  cfgMod = await import('../lib/core/config.js');
  prov = await import('../lib/core/shot-provenance.js');
  RB = await import('../lib/core/rule-book.js');
  bc = await import('../lib/agent/brief-context.js');
  bk = await import('../lib/agent/binding-check.js');
  pwm = await import('../lib/agent/prompt-write-mcp.js');
});

const PNG1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('① withWriteContext 的 meta 进 change_logs；来源审计按 IC 写稿 / 外部 PATCH / 旧流程归类，版本落后按 ok_from 划线', () => {
  const { Projects, Chapters, Shots, withWriteContext } = core;
  const p = Projects.create({ name: 'prov', auto_script: false });
  const a = withWriteContext('agent:set_storyboard', () => Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v1', dialogue: '' }));
  const b = withWriteContext('agent:set_storyboard', () => Shots.create(p.id, { chapter: '第1章', idx: 2, visual: 'v2', dialogue: '' }));
  withWriteContext('agent:save_shot_video_prompt', () => Shots.update(a.id, { video_prompt: 'P-a' }), { job_id: 'j1', rules_version: 'rules-old' });
  withWriteContext('PATCH /api/projects/:id/shots/:sid', () => Shots.update(b.id, { video_prompt: 'P-b' }));
  const log = core.getDb().prepare("SELECT meta FROM change_logs WHERE entity_id = ? AND source = 'agent:save_shot_video_prompt'").get(a.id);
  assert.deepEqual(JSON.parse(log.meta), { job_id: 'j1', rules_version: 'rules-old' });
  const acks = [{ ts: 1, shot_id: 'x', version: 'rules-old', skill: 'h3-prompt-writing' }, { ts: 2, shot_id: 'x', version: 'rules-mid', skill: 'h3-prompt-writing' }];
  const r = prov.shotProvenance(p.id, { acks, currentVersions: { h3: 'rules-new', adapt: 'a1' } });
  const [ra, rb] = r.chapters[0].shots;
  assert.equal(ra.video_prompt.kind, 'ic_write'); assert.equal(ra.video_prompt.rules_version, 'rules-old'); assert.equal(ra.video_prompt.job_id, 'j1');
  assert.equal(ra.video_prompt.behind, true); assert.equal(ra.video_prompt.versions_behind, 2);
  assert.ok(ra.flags.includes('video_prompt:rules_behind'));
  assert.ok(ra.flags.includes('visual:legacy_agent'));
  assert.equal(rb.video_prompt.kind, 'external_patch'); assert.ok(rb.flags.includes('video_prompt:external_patch'));
  const r2 = prov.shotProvenance(p.id, { acks, currentVersions: { h3: 'rules-new', adapt: 'a1' }, okFrom: 'rules-old' });
  assert.ok(!r2.chapters[0].shots[0].flags.includes('video_prompt:rules_behind'), 'ok_from 之后的版本不算落后');
  assert.equal(prov.classifyWriteSource('POST /api/projects/:id/chapters/:cid/move-dialogue'), 'ic_write');
});

test('① 没有 meta 的旧写入：用 rule_usage 同一镜 5 秒内的 save_ack 补版本；现值被没记日志的改动改过 → drift', () => {
  const { Projects, Chapters, Shots, withWriteContext } = core;
  const p = Projects.create({ name: 'prov2', auto_script: false });
  const a = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: 'v', dialogue: '' });
  withWriteContext('agent:save_shot_video_prompt', () => Shots.update(a.id, { video_prompt: 'P1' }));
  const ts = Number(core.getDb().prepare("SELECT ts FROM change_logs WHERE entity_id = ? AND source = 'agent:save_shot_video_prompt'").get(a.id).ts);
  const r = prov.shotProvenance(p.id, { acks: [{ ts: ts + 2, shot_id: a.id, version: 'rules-cur', skill: 'h3-prompt-writing' }], currentVersions: { h3: 'rules-cur', adapt: '' } });
  const v = r.chapters[0].shots[0].video_prompt;
  assert.equal(v.rules_version, 'rules-cur'); assert.equal(v.version_from, 'rule_usage'); assert.ok(!v.behind);
});

test('② 其他技能里带 prompt_when 的段按条件加入 extra_ranges，字数计入合计，校验码带技能名', () => {
  const index = { version: 'v', budget_chars: 100, budget_mode: 'total', sections: [{ id: 'MAP', tier: 'map', when: ['always'], chars: 10, checksum: 'M' }, { id: 'A', tier: 'base', when: ['always'], chars: 30, checksum: 'A1' }] };
  const extra = { skill: 'adapt-rules', index: { sections: [{ id: 'S19', title: 'S-019–S-024', start: 1, end: 5, chars: 50, prompt_when: ['multi'], checksum: 'SX' }, { id: 'R', tier: 'base', when: ['always'], chars: 999 }] } };
  const one = RB.requiredRanges(index, { character_ids: ['a'] }, null, { extraIndexes: [extra] });
  assert.deepEqual(one.extra_ranges, []); assert.equal(one.required_chars, 40);
  const two = RB.requiredRanges(index, { character_ids: ['a', 'b'] }, null, { extraIndexes: [extra] });
  assert.equal(two.extra_ranges.length, 1); assert.equal(two.extra_ranges[0].skill, 'adapt-rules');
  assert.equal(two.required_chars, 90); assert.equal(two.too_dense, false);
  assert.equal(two._checksums['adapt-rules:S19'], 'SX');
  extra.index.sections[0].chars = 70;
  assert.equal(RB.requiredRanges(index, { character_ids: ['a', 'b'] }, null, { extraIndexes: [extra] }).too_dense, true, '超预算');
});

test('③ 加载条件扫 visual + sub_shots + dialogue；noDialogueScan 只扫前两个；特效标记同时触发 H1（motion）', () => {
  const c1 = RB.shotConditions({ visual: '站着', sub_shots: '0-3秒 江澈走向门口', dialogue: '' }, null);
  assert.ok(c1.has('walk'), 'sub_shots 里的走向');
  // 主会话 seq2246 误触发修正：台词里说到的事不等于画面里在做——logic / walk / motion / prop 只看 visual + sub_shots
  assert.ok(!RB.shotConditions({ visual: '对坐', dialogue: '江澈：这笔交易成了。' }, null).has('logic'), '台词里的交易不触发 L');
  assert.ok(RB.shotConditions({ visual: '对坐，两人当面交易金条', dialogue: '' }, null).has('logic'), '画面里的交易触发 L');
  assert.ok(!RB.shotConditions({ visual: '江澈打开交易系统面板', dialogue: '' }, null).has('logic'), '「交易系统」是系统名');
  assert.ok(!RB.shotConditions({ visual: '对峙', sub_shots: '4-6秒 出拳前一刻（接下一镜）', dialogue: '' }, null).has('motion'), '接下一镜的小句不算本镜');
  assert.ok(RB.shotConditions({ visual: '对坐', dialogue: '江澈：给我打电话。' }, null).has('call'), '台词仍给 call');
  assert.ok(RB.shotConditions({ visual: '桌上', sub_shots: '江澈拿起手机', dialogue: '' }, null).has('phone'));
  const fx = RB.shotConditions({ visual: '【表现】P3｜特效·G01 金光眼｜江澈眼中金光一闪', dialogue: '' }, {}, { switches: { vfx: true } });
  assert.ok(fx.has('expression_qv')); assert.ok(fx.has('motion'), '特效镜读 H1');
});

function world(name) {
  const { Projects, Chapters, Shots, Assets } = core;
  const p = Projects.create({ name, auto_script: false });
  Chapters.create(p.id, { title: '第2章', script: 's' });
  const dir = cfgMod.projectDir(p.id);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'sq.png'), PNG1);
  const j = Assets.create(p.id, { category: 'character', name: '江澈', description: '青年男性', voice_desc: '青年男性，嗓音偏低、略沙哑' });
  Assets.update(j.id, { image_path: 'assets/sq.png' });
  const x = Assets.create(p.id, { category: 'character', name: '许曼宁', voice_desc: '青年女性，嗓音清亮' });
  const cos = Assets.create(p.id, { category: 'costume', name: '江澈·白T', parent_id: j.id, description: '我方资产ID：C001_O1；审核：final；白T恤、灰短裤' });
  const hall = Assets.create(p.id, { category: 'scene', name: '奥迪4S店展厅', description: '我方资产ID：S095；审核：final；展厅' });
  const hall2 = Assets.create(p.id, { category: 'scene', name: 'S095·奥迪4S店展厅', description: '另一套' });
  const mv = Assets.create(p.id, { category: 'scene', name: '奥迪展厅·前区·多视角定义图', description: '我方资产ID：S095_MV；审核：final；江澈站展车左侧，许曼宁在接待台' });
  const street = Assets.create(p.id, { category: 'scene', name: '街口' });
  const s1 = Shots.create(p.id, { chapter: '第1章', idx: 1, visual: '江澈在街口', dialogue: '', character_ids: [j.id], costume_ids: [cos.id], scene_ids: [street.id] });
  const s2 = Shots.create(p.id, { chapter: '第2章', idx: 1, visual: '江澈进展厅，额头带伤', dialogue: '', character_ids: [j.id], costume_ids: [cos.id], scene_ids: [hall.id] });
  const s3 = Shots.create(p.id, { chapter: '第2章', idx: 2, visual: '许曼宁迎上来', dialogue: '许曼宁：欢迎。', character_ids: [j.id, x.id], scene_ids: [hall.id] });
  const s4 = Shots.create(p.id, { chapter: '第2章', idx: 3, visual: '江澈看车，许曼宁在旁边介绍', dialogue: '许曼宁：这台不错。\n江澈：嗯。', character_ids: [j.id], costume_ids: [cos.id], scene_ids: [hall2.id] });
  return { p, j, x, cos, hall, hall2, mv, street, s1, s2, s3, s4 };
}

test('④ brief 补数据：上一镜 / 上一集末镜状态、同场在场人物、说话人性别和音高', () => {
  const w = world('ctx');
  const assets = core.Assets.list(w.p.id);
  const s3 = core.Shots.get(w.s3.id);
  const st = bc.prevStates(w.p.id, s3, assets);
  assert.equal(st.prev_shot.idx, 1); assert.equal(st.prev_shot.people[0].costume, '江澈·白T');
  assert.equal(st.prev_shot.people[0].costume_desc, '白T恤、灰短裤'); assert.match(st.prev_shot.visual, /额头带伤/);
  assert.equal(st.prev_chapter_last_shot, undefined, '不是本章第一镜、和上一集末镜也不同地点');
  const first = bc.prevStates(w.p.id, core.Shots.get(w.s2.id), assets);
  assert.equal(first.prev_chapter_last_shot.chapter, '第1章');
  const cast = bc.sceneCast(w.p.id, s3, assets);
  assert.deepEqual(cast.shots, [1, 2, 3]); assert.deepEqual(cast.present, ['江澈', '许曼宁']); assert.equal(cast.place, '奥迪展厅');
  const v = bc.speakerVoices(core.Shots.get(w.s4.id), assets);
  assert.deepEqual(v.map((x) => [x.speaker, x.gender, x.pitch]), [['许曼宁', '女', '清亮'], ['江澈', '男', '偏低、沙哑']]);
});

test('④ get_shot_prompt_brief 带 scene_cast / speaker_voices / prev_shot；站位表按资产号也认得出 _MV', async () => {
  const w = world('ctx-brief');
  pwm._resetPromptWriteSession();
  const ctx = { projectId: w.p.id, jobId: 'jn', chapter: '第2章', project: core.Projects.get(w.p.id), cfg: {} };
  const b = JSON.parse(await pwm.runPromptWriteExtraTool(ctx, 'get_shot_prompt_brief', { shot_id: w.s3.id }));
  assert.deepEqual(b.scene_cast.present, ['江澈', '许曼宁']);
  assert.equal(b.speaker_voices[0].gender, '女');
  assert.equal(b.prev_shot.idx, 1);
  assert.equal(b.scene_blocking.length, 1); assert.match(b.scene_blocking[0].blocking, /展车左侧/); assert.equal(b.scene_blocking[0].bound, false);
  assert.match(b.continuity_rule, /prev_shot/);
});

test('⑤ binding-check 警告只报不拦：一地两套、同场人物漏绑、非标准设定板、_MV 名字没认出来', () => {
  const w = world('warn');
  const assets = core.Assets.list(w.p.id);
  const r3 = bk.checkShotBindings(core.Shots.get(w.s3.id), { assets, projectId: w.p.id });
  const kinds = r3.issues.map((i) => i.level + ':' + i.kind);
  assert.ok(kinds.includes('W:mv_name'), kinds.join(','));
  assert.ok(!kinds.includes('C:mv'), '名字没认出来的不再报「没有 _MV」');
  assert.ok(kinds.includes('W:scene_dup'));
  assert.ok(kinds.includes('W:asset_sheet'), '1×1 图不是横版设定板');
  const r4 = bk.checkShotBindings(core.Shots.get(w.s4.id), { assets, projectId: w.p.id });
  assert.ok(r4.issues.some((i) => i.kind === 'cast_unbound' && /许曼宁.*说话/.test(i.detail)));
  for (const s of [w.s1, w.s2, w.s3, w.s4]) {
    const a = bk.checkShotBindings(core.Shots.get(s.id), { assets, projectId: w.p.id });
    const b = bk.checkShotBindings(core.Shots.get(s.id), { assets, projectId: w.p.id, warnings: false });
    assert.equal(a.blocking, b.blocking, '警告不改变是否拦截');
    assert.ok(!b.issues.some((i) => i.level === 'W' && i.kind !== 'mv_name'), 'warnings:false 只留替代原 C 的 mv_name');
  }
});
