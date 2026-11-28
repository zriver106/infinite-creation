// MiniMax-H3-Image 进设置下拉（Andy 11-28）：两条规格（文生图 t2i、图生图/编辑 i2i）登记成功；
// 组出来的工作流里扩写链被剪掉、prompt 直写到 MiniMaxH3ImageConditioning，所有连线都指向存在的节点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultSpecById } from '../lib/core/workflow-specs.js';
import { buildWorkflow } from '../lib/core/workflow-runner.js';

const danglers = (wf) => {
  const out = [];
  for (const [id, n] of Object.entries(wf)) for (const [k, v] of Object.entries(n.inputs || {})) if (Array.isArray(v) && typeof v[0] === 'string' && !wf[v[0]]) out.push(id + '.' + k + '→' + v[0]);
  return out;
};

test('H3-Image 文生图：prompt、宽高直写条件节点，扩写链剪掉，没有悬空连线', () => {
  const spec = getDefaultSpecById('minimax_h3_image_t2i');
  assert.equal(spec.kind, 't2i');
  const wf = buildWorkflow(spec, { positive_prompt: 'an empty office', width: 1344, height: 768, seed: 5, filename_prefix: 'x' });
  assert.equal(wf['23:5'].inputs.prompt, 'an empty office');
  assert.deepEqual([wf['23:5'].inputs.width, wf['23:5'].inputs.height], [1344, 768]);
  assert.equal(wf['23:7'].inputs.seed, 5);
  for (const gone of ['23:15', '23:16', '23:22', '14']) assert.equal(wf[gone], undefined, gone + ' 应被剪掉');
  assert.deepEqual(danglers(wf), []);
});

test('H3-Image 编辑：图和 prompt 直写，扩写链剪掉，没有悬空连线', () => {
  const spec = getDefaultSpecById('minimax_h3_image_edit');
  assert.equal(spec.kind, 'i2i');
  const wf = buildWorkflow(spec, { positive_prompt: 'turn into a photo', image: 'in.png', seed: 9, filename_prefix: 'y' });
  assert.equal(wf['32'].inputs.prompt, 'turn into a photo');
  assert.equal(wf['45'].inputs.image, 'in.png');
  assert.equal(wf['38'].inputs.seed, 9);
  for (const gone of ['34', '35', '41', '44', '62']) assert.equal(wf[gone], undefined, gone + ' 应被剪掉');
  assert.deepEqual(danglers(wf), []);
});
