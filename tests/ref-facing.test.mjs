// 服装参考图按朝向选（lib/core/ref-facing.js + refs.js assembleShotReferences）。
// 临时数据目录 + 临时配置（IC_CONFIG=:9 + 8188/8189/4610 守卫）；upload=false 只解析参考清单，不上传、不渲染。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';
import { viewOfAsset, costumeBaseName, shotFacing, pickCostumeForFacing, refFacingEnabled } from '../lib/core/ref-facing.js';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-reffacing-'));
writeTempIcConfig(tmp);

describe('ref-facing 纯函数', () => {
  test('资产朝向只看名字和文件名；同一件衣服去掉朝向字样后同名', () => {
    assert.equal(viewOfAsset({ name: '灰蓝洗旧T（背面）' }), 'back');
    assert.equal(viewOfAsset({ name: '灰蓝洗旧T', image_path: 'assets/costume/x_side.png' }), 'side');
    assert.equal(viewOfAsset({ name: '灰蓝洗旧T 正面全身' }), 'front');
    assert.equal(viewOfAsset({ name: '灰蓝洗旧T', description: '背面有字' }), null, '描述不算');
    assert.equal(costumeBaseName('灰蓝洗旧T（背面）'), '灰蓝洗旧T');
    assert.equal(costumeBaseName('灰蓝洗旧T_正面'), '灰蓝洗旧T');
    assert.equal(costumeBaseName('灰蓝洗旧T 侧面全身'), '灰蓝洗旧T');
  });
  test('朝向：按角色名所在那段判断，不串到同镜别人；机位字段兜底；前后都有记 mixed', () => {
    const shot = { visual: '江澈背对镜头走向门口，唐知夏面朝镜头' };
    assert.equal(shotFacing(shot, '江澈', ['唐知夏']), 'back');
    assert.equal(shotFacing(shot, '唐知夏', ['江澈']), 'front');
    assert.equal(shotFacing({ camera: '中景 · 从背后跟拍' }, '江澈'), 'back');
    assert.equal(shotFacing({ sub_shots: '0-3s｜江澈侧身坐在窗边' }, '江澈'), 'side');
    assert.equal(shotFacing({ sub_shots: '0-3s｜江澈的背影。3-6s｜江澈转身面朝镜头' }, '江澈'), 'mixed');
    assert.equal(shotFacing({ visual: '江澈坐着喝茶' }, '江澈'), null);
    assert.equal(shotFacing({ visual: '江澈背对唐知夏站着' }, '江澈', ['唐知夏']), null, '背对别人不等于背对镜头');
  });
  const C = { id: 'c1', name: '江澈' };
  const front = { id: 'f', category: 'costume', parent_id: 'c1', name: '灰蓝T（正面）', image_path: 'a/f.png' };
  const side = { id: 's', category: 'costume', parent_id: 'c1', name: '灰蓝T（侧面）', image_path: 'a/s.png' };
  const back = { id: 'b', category: 'costume', parent_id: 'c1', name: '灰蓝T（背面）', image_path: 'a/b.png' };
  const other = { id: 'o', category: 'costume', parent_id: 'c1', name: '西装（背面）', image_path: 'a/o.png' };
  const all = [front, side, back, other];
  test('背面镜 → 背面图（即使只绑了正面图，也从同一件衣服的兄弟图里找）；别的衣服不拿', () => {
    const r = pickCostumeForFacing({ shot: { visual: '江澈的背影' }, character: C, bound: [front], assets: all });
    assert.equal(r.asset.id, 'b');
    assert.equal(r.level, 'info');
  });
  test('正面 / 侧面 / 看不出 → 正面图', () => {
    for (const v of ['江澈面朝镜头', '江澈侧身坐着', '江澈坐着']) {
      assert.equal(pickCostumeForFacing({ shot: { visual: v }, character: C, bound: [back], assets: all }).asset.id, 'f', v);
    }
  });
  test('背面镜没有背面图 → 退回正面图并告警；都没有朝向标记 → 照旧（asset=null）', () => {
    const r = pickCostumeForFacing({ shot: { visual: '江澈的背影' }, character: C, bound: [front], assets: [front, side] });
    assert.equal(r.asset.id, 'f');
    assert.equal(r.level, 'warn');
    assert.match(r.note, /仅告警/);
    const plain = { id: 'p', category: 'costume', parent_id: 'c1', name: '灰蓝T', image_path: 'a/p.png' };
    assert.equal(pickCostumeForFacing({ shot: { visual: '江澈的背影' }, character: C, bound: [plain], assets: [plain] }).asset, null);
  });
  test('开关：缺省开；refFacing=off / false 关闭', () => {
    assert.equal(refFacingEnabled({}), true);
    assert.equal(refFacingEnabled({ generation: { refFacing: 'off' } }), false);
    assert.equal(refFacingEnabled({ generation: { refFacing: false } }), false);
  });
});

describe('assembleShotReferences 接线（upload=false）', { concurrency: 1 }, () => {
  let core;
  before(async () => { core = await import('../lib/core/index.js'); });
  function mk() {
    const p = core.Projects.create({ name: '朝向测试', auto_script: false });
    const dir = core.projectDir(p.id);
    const img = (rel) => { const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'PNG'); return rel; };
    const ch = core.Assets.create(p.id, { category: 'character', name: '江澈' });
    core.Assets.update(ch.id, { image_path: img('assets/character/jc.png'), status: 'done' });
    const mkC = (name, file) => { const a = core.Assets.create(p.id, { category: 'costume', name, parent_id: ch.id }); core.Assets.update(a.id, { image_path: img('assets/costume/' + file), status: 'done' }); return a; };
    const f = mkC('灰蓝T（正面）', 'f.png'); mkC('灰蓝T（侧面）', 's.png'); const b = mkC('灰蓝T（背面）', 'b.png');
    return { p, ch, f, b };
  }
  const run = (p, shot, cfg = core.loadConfig()) => core.assembleShotReferences({ cfg, project: core.Projects.get(p.id), shot, assets: core.Assets.list(p.id), upload: false });
  test('背影镜只绑了正面服装 → 送背面图；正脸镜绑了背面服装 → 送正面图', async () => {
    const { p, ch, f, b } = mk();
    const r1 = await run(p, { character_ids: [ch.id], costume_ids: [f.id], visual: '江澈的背影慢慢走远' });
    assert.match(r1.references[0].label, /灰蓝T（背面）/);
    assert.ok(r1.references[0].filename.includes(b.id.slice(0, 8)));
    const r2 = await run(p, { character_ids: [ch.id], costume_ids: [b.id], camera: '中景', visual: '江澈面朝镜头开口' });
    assert.match(r2.references[0].label, /灰蓝T（正面）/);
    assert.ok(r2.facingNotes.some((n) => /正面图/.test(n)));
  });
  test('refFacing=off：照旧用绑定的那张', async () => {
    const { p, ch, f } = mk();
    const cfg = { ...core.loadConfig(), generation: { ...(core.loadConfig().generation || {}), refFacing: 'off' } };
    const r = await run(p, { character_ids: [ch.id], costume_ids: [f.id], visual: '江澈的背影' }, cfg);
    assert.match(r.references[0].label, /灰蓝T（正面）/);
  });
});
