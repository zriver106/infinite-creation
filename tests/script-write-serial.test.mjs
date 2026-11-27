// 只写剧本：同一项目逐章串行（总导 11-26：章与章并行就读不到上章新稿）；跳转式戏份说明（「见：系统」）不算四问没答全、不要求进缺图单。
// 临时数据目录，假 Agent，不起 CLI、不碰 GPU。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sws-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, agent: { runtime: 'claude' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let SW; let SN; let GAPS;
before(async () => {
  core = await import('../lib/core/index.js');
  SW = await import('../lib/agent/script-write.js');
  SN = await import('../lib/core/scene-notes.js');
  GAPS = await import('../lib/core/asset-gaps.js');
});

const wait = async (id, ok) => { for (let i = 0; i < 200; i++) { const j = core.Jobs.get(id); if (ok.includes(j.status)) return j; await new Promise((x) => setTimeout(x, 20)); } return core.Jobs.get(id); };

test('同项目多章只写剧本：上一章写完才开下一章，不并发', async () => {
  const p = core.Projects.create({ name: 'sws', auto_script: false });
  const c1 = core.Chapters.list(p.id)[0];
  core.Chapters.update(c1.id, { novel: '一' });
  const c2 = core.Chapters.create(p.id, { title: '第2章', novel: '二' });
  const log = []; let release; const hold = new Promise((x) => { release = x; });
  const fake = (ch, gate) => async () => { log.push('start ' + ch.title); await gate; core.Chapters.update(ch.id, { script: ch.title + ' 新稿' }); log.push('end ' + ch.title); };
  const r1 = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c1.id), runAgentFn: fake(c1, hold) });
  const r2 = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c2.id), runAgentFn: fake(c2, Promise.resolve()) });
  await new Promise((x) => setTimeout(x, 80));
  assert.deepEqual(log, ['start 第1章'], '第2章要等第1章写完');
  assert.match(core.Jobs.get(r2.job.id).detail || '', /等前一章/);
  release();
  assert.equal((await wait(r1.job.id, ['done', 'failed'])).status, 'done');
  assert.equal((await wait(r2.job.id, ['done', 'failed'])).status, 'done');
  assert.deepEqual(log, ['start 第1章', 'end 第1章', 'start 第2章', 'end 第2章']);
  assert.equal(SW.scriptWriteChainLength(p.id), 0);
});

test('跳转式戏份说明：「见：系统」不要求进缺图单', async () => {
  const p = core.Projects.create({ name: 'sws-redirect', auto_script: false });
  SN.saveSceneNote(p.id, '系统', '# 角色：系统\n生命周期 范围 功能 状态');
  SN.saveSceneNote(p.id, '系统光幕', '见：系统（光幕就是系统的外观，J-012）');
  assert.equal(SN.isRedirectNote('见：系统'), true);
  assert.equal(SN.isRedirectNote('# 标题\n见：系统'), true);
  assert.equal(SN.isRedirectNote('系统光幕不单立资产，见戏份说明「系统」'), false);
  GAPS.mergeGapList(p.id, { items: [{ kind: 'character', name: '系统·光幕A版', note_key: '系统' }] });
  assert.deepEqual(GAPS.gapCoverage(p.id).missing, []);
});

test('缺图单附 J-009 原文：规则书超过单次读取上限也能取到整节', async () => {
  const A = await import('../lib/agent/asset-analyze-mcp.js');
  const t = A.j009Text();
  assert.match(t, /^### 〔J-009〕/);
  assert.ok(t.length > 300);
  assert.doesNotMatch(t.split('\n').slice(1).join('\n'), /^### 〔J-010〕/m);
});

test('排队等前一章时取消：马上标已取消，这章能重交', async () => {
  const JR = await import('../lib/agent/job-runner.js');
  const p = core.Projects.create({ name: 'sws-cancel', auto_script: false });
  const c1 = core.Chapters.list(p.id)[0];
  core.Chapters.update(c1.id, { novel: '一' });
  const c2 = core.Chapters.create(p.id, { title: '第2章', novel: '二' });
  let release; const hold = new Promise((x) => { release = x; });
  const r1 = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c1.id), runAgentFn: async () => { await hold; core.Chapters.update(c1.id, { script: '新' }); } });
  const r2 = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c2.id), runAgentFn: async () => { throw new Error('不该跑'); } });
  JR.stopJob(r2.job.id);
  assert.equal((await wait(r2.job.id, ['cancelled'])).status, 'cancelled');
  const r3 = SW.submitScriptWriteJob({ projectId: p.id, chapter: core.Chapters.get(c2.id), runAgentFn: async () => { core.Chapters.update(c2.id, { script: '第2章 新稿' }); } });
  release();
  assert.equal((await wait(r1.job.id, ['done', 'failed'])).status, 'done');
  assert.equal((await wait(r3.job.id, ['done', 'failed'])).status, 'done');
  assert.equal(core.Jobs.get(r2.job.id).status, 'cancelled');
});
