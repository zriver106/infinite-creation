// 系统设置「资产出图方式」（generation.assetImageSource）：缺省 muse = 资产由 Muse 在 IC 外出图，IC 不生图。
// 临时数据目录 + 临时配置；不调 LLM / ComfyUI。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ais-'));
const cfgFile = path.join(tmp, 'config.json');
let core; let ac; let tools; let stages;

function writeCfg(extra) {
  fs.writeFileSync(cfgFile, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, ...extra }));
}

before(async () => {
  writeCfg({});
  process.env.IC_DATA_DIR = path.join(tmp, 'data');
  process.env.IC_CONFIG = cfgFile;
  core = await import('../lib/core/index.js');
  ac = await import('../lib/agent/asset-check.js');
  tools = await import('../lib/agent/tools.js');
  stages = await import('../lib/agent/stages.js');
});

test('缺省（config 里没写）= muse：没单独设 asset_mode 的项目按缺件单模式', () => {
  writeCfg({});
  assert.equal(ac.assetImageSource(), 'muse');
  const p = core.Projects.create({ name: '缺省项目', auto_script: false });
  assert.equal(ac.readAssetCheckSettings(core.Projects.get(p.id)).mode, 'gap-list');
  assert.equal(ac.gapListOn(p.id), true);
});

test('系统设置改成 ic：没单独设的项目回到 auto（上游原行为）', () => {
  writeCfg({ generation: { assetImageSource: 'ic' } });
  const p = core.Projects.create({ name: 'IC 生图项目', auto_script: false });
  assert.equal(ac.readAssetCheckSettings(core.Projects.get(p.id)).mode, 'auto');
  assert.equal(ac.gapListOn(p.id), false);
  writeCfg({});
});

test('项目单独设过的按项目：asset_mode=auto 在 muse 缺省下仍是 auto', () => {
  writeCfg({});
  const p = core.Projects.create({ name: '项目自设 auto', auto_script: false });
  core.Projects.setContextKey(p.id, 'asset_mode', 'auto');
  assert.equal(ac.gapListOn(p.id), false);
});

test('muse 模式：生图类工具一律跳过不抛错；资产图阶段不欠图', async () => {
  writeCfg({});
  const p = core.Projects.create({ name: 'Muse 项目', auto_script: false });
  const a = core.Assets.create(p.id, { category: 'character', name: '江澈', prompt: 'a young man' });
  const reports = [];
  const ctx = tools.createToolRuntime({ projectId: p.id, onProgress: (x) => reports.push(x) });
  for (const n of tools.MUSE_IMAGE_TOOLS) {
    const r = JSON.parse(await tools.runTool(ctx, n, {}));
    assert.equal(r.skipped, true, n + ' 应被跳过');
    assert.match(r.reason, /Muse/);
  }
  assert.equal(stages.pendingByStage(p.id, '').image.todo, 0, 'Muse 模式下 IC 不欠资产图');
  assert.ok(!tools.MUSE_IMAGE_TOOLS.has('design_voice'), '音色不受影响');
});
