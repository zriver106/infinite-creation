// 场景母本（手册 13 号 / R-006 第 4 条，总导 11-28）：项目里有场景母本时，只写剧本任务没读过母本不让存剧本；读工具给 JSON 和标注版平面图。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sm-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let SM; let SW;
before(async () => { core = await import('../lib/core/index.js'); SM = await import('../lib/core/scene-master.js'); SW = await import('../lib/agent/script-write.js'); });

test('列出 / 读场景母本；有母本时没读过不让存剧本，读过才放行；没有母本的项目照旧', () => {
  const p = core.Projects.create({ name: 'sm-1', auto_script: false });
  const ch = core.Chapters.create ? null : null;
  const ctx = { projectId: p.id, chapter: '第1章' };
  assert.deepEqual(SM.listSceneMasters(p.id), []);
  assert.equal(SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }).overwrite, true, '没有母本的项目照旧能存');
  const dir = SM.sceneMasterDir(p.id); fs.mkdirSync(path.join(dir, 'L02-金店店内'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'L02-金店店内.json'), JSON.stringify({ scene_id: 'L02-金店店内', name: '五缘金店·店内', items: [{ id: 'F01' }, { id: 'F05' }] }));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', path.join(dir, 'L02-金店店内', '平面图_标注.png')]);
  assert.deepEqual(SM.listSceneMasters(p.id), [{ scene_id: 'L02-金店店内', name: '五缘金店·店内', items: 2, has_plan: true }]);
  const r = SM.getSceneMaster(p.id, 'L02-金店店内');
  assert.equal(r.master.name, '五缘金店·店内'); assert.ok(r.plan.endsWith('平面图_标注.png'));
  assert.equal(SM.getSceneMaster(p.id, 'nope'), null);
  assert.throws(() => SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }), /get_scene_master/);
  ctx.sceneMasterRead = true;
  assert.equal(SW.guardScriptWrite(ctx, 'set_chapter_script', { script: 'x' }).overwrite, true);
  assert.ok(SW.SCRIPT_WRITE_EXTRA.has('get_scene_master') && SW.SCRIPT_WRITE_EXTRA.has('list_scene_masters'));
  assert.match(SW.buildScriptWriteAgentPrompt({ project: { name: 'V3' }, chapter: '第1章' }), /get_scene_master[\s\S]*R-006 第 4 条/);
});
