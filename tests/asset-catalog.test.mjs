import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupedCatalog, buildCategoryPage, formatCatalogText, collectMissingBindingWarnings, pageItems,
  buildCatalogInjection, CATALOG_INJECT_MAX_CHARS, isIcGenerated, CATALOG_IC_TAG, CATALOG_IC_PRIORITY_HINT,
} from '../lib/agent/asset-catalog.js';

function A(id, category, name, extra = {}) {
  const source = extra.source || 'uploaded';
  let description = extra.description || '';
  // 默认视为我方定稿（描述带「我方资产ID」），避免空描述被判成 IC 生成；IC 条目显式传 source/description。
  if (!extra.ic && source !== 'generated' && !/我方资产ID/.test(description)) {
    description = (description ? description + '；' : '') + '我方资产ID：TEST';
  }
  return { id, category, name, description, parent_id: extra.parent_id || '', image_path: extra.image || 'x.png', status: 'done', source };
}

test('不传分类时按人物/服装/场景/道具分组，并标明翻页', () => {
  const assets = [
    A('c1', 'character', '江澈', { description: '白T' }),
    A('o1', 'costume', '白T短裤', { parent_id: 'c1' }),
    A('s1', 'scene', '物业大厅'),
    A('p1', 'prop', '钥匙'),
    A('v1', 'voice', '江澈音色'),
  ];
  const g = buildGroupedCatalog(assets);
  assert.equal(g.grouped, true);
  assert.equal(g.categories.character.total, 1);
  assert.equal(g.categories.costume.items[0].parent_name, '江澈');
  assert.equal(g.categories.scene.total, 1);
  assert.equal(g.categories.prop.total, 1);
  assert.equal(g.also_present.voice, 1);
  const text = formatCatalogText(assets);
  assert.match(text, /人物（1）/);
  assert.match(text, /服装（1）/);
  assert.match(text, /场景（1）/);
  assert.match(text, /道具（1）/);
  assert.match(text, /不要只列人物/);
});

test('单类超过页长时 has_more，第 2 页从下一档接着', () => {
  const assets = Array.from({ length: 85 }, (_, i) => A('s' + i, 'scene', '场景' + i));
  const p1 = buildCategoryPage(assets, 'scene', { page: 1, pageSize: 80 });
  const p2 = buildCategoryPage(assets, 'scene', { page: 2, pageSize: 80 });
  assert.equal(p1.total, 85);
  assert.equal(p1.has_more, true);
  assert.equal(p1.items.length, 80);
  assert.equal(p2.items.length, 5);
  assert.equal(p2.has_more, false);
  assert.equal(p2.items[0].name, '场景80');
});

test('库里有场景/服装/道具而分镜没绑时给出非致命提示；没这类资产则不提示', () => {
  const assets = [A('c1', 'character', '江澈'), A('s1', 'scene', '大厅'), A('o1', 'costume', '白T', { parent_id: 'c1' })];
  const msgs = collectMissingBindingWarnings({
    shots: [{ characters: ['江澈'] }],
    chapterTitles: ['第26章'],
    idxs: [1],
    assets,
  });
  assert.equal(msgs.some((m) => m.includes('场景')), true);
  assert.equal(msgs.some((m) => m.includes('服装')), true);
  assert.equal(msgs.some((m) => m.includes('道具')), false);
  assert.equal(msgs.some((m) => m.includes('不拒绝')), true);
  const none = collectMissingBindingWarnings({
    shots: [{ characters: ['江澈'] }],
    chapterTitles: ['第1章'],
    idxs: [1],
    assets: [A('c1', 'character', '江澈')],
  });
  assert.equal(none.length, 0);
});

test('pageItems 边界', () => {
  const r = pageItems([], 1, 80);
  assert.equal(r.total, 0);
  assert.equal(r.has_more, false);
});

test('注入清单默认 B2：未超上限时全量逐行列名字和父级，不带描述，提示去 list_assets 查描述，并写一行日志', () => {
  const assets = [
    A('c1', 'character', '江澈', { description: '白T短裤，这段描述不应出现在注入清单里' }),
    A('o1', 'costume', '江澈·白T短裤', { parent_id: 'c1', description: '服装描述不应出现' }),
    ...Array.from({ length: 90 }, (_, i) => A('s' + i, 'scene', '场景' + i)),
    A('p1', 'prop', '钥匙'),
  ];
  const logs = [];
  const r = buildCatalogInjection(assets, { log: (l) => logs.push(l) });
  assert.equal(r.format, 'B2');
  assert.equal(CATALOG_INJECT_MAX_CHARS, 15000);
  assert.ok(r.chars <= 15000);
  assert.match(r.text, /^- 江澈$/m);
  assert.match(r.text, /^- 江澈·白T短裤；挂在「江澈」下$/m);
  assert.match(r.text, /^- 场景89$/m); // 全量，没有 80 条截断
  assert.doesNotMatch(r.text, /has_more|page:2|第 1 页/);
  assert.doesNotMatch(r.text, /描述不应出现|有图/);
  assert.match(r.text, /list_assets\(\{category, page\}\)/);
  assert.match(r.text, /不带描述/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /格式 B2，\d+ 字/);
  assert.equal(formatCatalogText(assets), r.text);
});

test('注入清单超过 15,000 字自动降级为 C（每类一行 名字@父级），日志写明格式和字数', () => {
  const assets = [A('c0', 'character', '江澈')];
  for (let i = 0; i < 1500; i++) assets.push(A('p' + i, 'prop', '道具名字比较长的一个条目' + i));
  for (let i = 0; i < 30; i++) assets.push(A('o' + i, 'costume', '服装' + i, { parent_id: 'c0' }));
  const logs = [];
  const r = buildCatalogInjection(assets, { log: (l) => logs.push(l) });
  assert.ok(r.b2Chars > 15000);
  assert.equal(r.format, 'C');
  assert.equal(r.chars, r.text.length);
  assert.ok(r.chars < r.b2Chars);
  assert.doesNotMatch(r.text, /^- /m);
  assert.match(r.text, /^服装（30）：服装0@江澈、服装1@江澈/m);
  assert.match(r.text, /^道具（1500）：道具名字比较长的一个条目0、/m);
  assert.match(r.text, /list_assets\(\{category, page\}\)/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp('格式 C，' + r.chars + ' 字'));
  assert.match(logs[0], /超过上限 15000，已降级/);
  const small = buildCatalogInjection(assets, { maxChars: 10 ** 9 });
  assert.equal(small.format, 'B2');
});

test('IC 生成资产在 B2 名字后标「（IC生成）」，定稿不标，并带优先用定稿的提示句', () => {
  const assets = [
    A('c1', 'character', '江澈'),
    A('c2', 'character', '跟拍青年', { source: 'generated', description: 'IC 出的群演' }),
    A('s1', 'scene', '办公室工位区', { source: 'generated' }),
    A('s2', 'scene', '牡丹厅包厢', { source: 'uploaded', description: '名字和描述是模型写的，图后来换了定稿', ic: true }),
    A('s3', 'scene', '龙津别墅客厅', { description: '我方资产ID：S032；审核：final' }),
    A('p1', 'prop', '金砖', { source: 'uploaded', description: '一块长方形金砖', ic: true }),
    A('p2', 'prop', '钥匙'),
    A('o1', 'costume', '临时服装', { parent_id: 'c2', source: 'generated' }),
  ];
  const r = buildCatalogInjection(assets);
  assert.equal(r.format, 'B2');
  assert.equal(CATALOG_IC_TAG, '（IC生成）');
  assert.match(r.text, /^- 江澈$/m);
  assert.match(r.text, /^- 跟拍青年（IC生成）$/m);
  assert.match(r.text, /^- 办公室工位区（IC生成）$/m);
  assert.match(r.text, /^- 牡丹厅包厢（IC生成）$/m);
  assert.match(r.text, /^- 龙津别墅客厅$/m);
  assert.match(r.text, /^- 金砖（IC生成）$/m);
  assert.match(r.text, /^- 钥匙$/m);
  assert.match(r.text, /^- 临时服装（IC生成）；挂在「跟拍青年」下$/m);
  assert.doesNotMatch(r.text, /江澈（IC生成）/);
  assert.doesNotMatch(r.text, /龙津别墅客厅（IC生成）/);
  assert.doesNotMatch(r.text, /挂在「跟拍青年（IC生成）」下/);
  assert.equal(r.text.includes(CATALOG_IC_PRIORITY_HINT), true);
  assert.equal(isIcGenerated(assets[0]), false);
  assert.equal(isIcGenerated(assets[1]), true);
  assert.equal(isIcGenerated(assets[3]), true);
  assert.equal(isIcGenerated({ source: 'uploaded', description: '我方资产ID：C001_B' }), false);
  assert.equal(isIcGenerated({ source: 'generated', description: '我方资产ID：X' }), true);
});

test('降级为 C 时「（IC生成）」标记仍保留在名字后，提示句也在', () => {
  const assets = [
    A('c0', 'character', '江澈'),
    A('c1', 'character', '跟拍青年', { source: 'generated', description: '群演' }),
  ];
  for (let i = 0; i < 1500; i++) assets.push(A('p' + i, 'prop', '道具名字比较长的一个条目' + i));
  assets.push(A('pIC', 'prop', '洗筋伐髓丹', { source: 'uploaded', description: 'IC 建的条目', ic: true }));
  for (let i = 0; i < 30; i++) assets.push(A('o' + i, 'costume', '服装' + i, { parent_id: 'c0' }));
  assets.push(A('oIC', 'costume', '临时服装', { parent_id: 'c1', source: 'generated' }));
  const logs = [];
  const r = buildCatalogInjection(assets, { log: (l) => logs.push(l) });
  assert.ok(r.b2Chars > 15000);
  assert.equal(r.format, 'C');
  assert.match(r.text, /跟拍青年（IC生成）/);
  assert.match(r.text, /洗筋伐髓丹（IC生成）/);
  assert.match(r.text, /临时服装（IC生成）@跟拍青年(?!（IC生成）)/);
  assert.doesNotMatch(r.text, /江澈（IC生成）/);
  assert.equal(r.text.includes(CATALOG_IC_PRIORITY_HINT), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /已降级/);
});
