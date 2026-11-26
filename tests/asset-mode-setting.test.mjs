// 项目设置「出图方式」（Andy 11-26「这里要给用户设置 使用 muse 还是 本地模型」）：PUT /asset-settings mode=gap-list/auto/inherit。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-assetmode-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, generation: { assetImageSource: 'muse' } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
const ROOT = process.cwd();
registerHooks({ resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
  if (spec === 'next/server') return next('next/server.js', ctx);
  return next(spec, ctx);
} });
const core = await import('../lib/core/index.js');
const AC = await import('../lib/agent/asset-check.js');
const { PUT } = await import('../app/api/projects/[id]/asset-settings/route.js');

const put = async (id, body) => { const r = await PUT(new Request('http://x/', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }); return { status: r.status, j: await r.json() }; };

test('出图方式：本地模型 → auto；Muse → gap-list；跟随系统 → 清掉项目设置，按系统（muse → gap-list）', async () => {
  const p = core.Projects.create({ name: 'am', auto_script: false });
  assert.equal(AC.gapListOn(p.id), true, '系统默认 muse');
  assert.equal((await put(p.id, { mode: 'auto' })).j.mode, 'auto');
  assert.equal(AC.gapListOn(p.id), false);
  assert.equal(core.Projects.get(p.id).context.asset_mode, 'auto');
  assert.equal((await put(p.id, { mode: 'gap-list' })).j.mode, 'gap-list');
  assert.equal((await put(p.id, { mode: 'inherit' })).j.mode, 'gap-list');
  assert.equal(core.Projects.get(p.id).context.asset_mode, '');
  assert.equal((await put(p.id, { mode: 'local' })).status, 400);
});
