// 手册存储与 API 逻辑：只用临时目录，不碰真实 data/、不连 ComfyUI / 线上 IC。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-manual-'));
fs.mkdirSync(path.join(tmp, 'data'));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_MANUAL_DIR = path.join(tmp, 'manual');

const root = process.env.IC_MANUAL_DIR;
fs.mkdirSync(path.join(root, '分镜'), { recursive: true });
fs.writeFileSync(path.join(root, 'manual.json'), JSON.stringify({
  version: 1,
  title: '制作手册',
  categories: [
    { id: 'storyboard', title: '分镜', dir: '分镜', desc: '', docs: [
      { file: '01_a.md', title: '文档A', status: '现行', source: '' },
    ] },
  ],
}) + '\n');
fs.writeFileSync(path.join(root, '分镜', '01_a.md'), '# A\nhello\n');

const m = await import('../lib/core/manual.js');

test('listManual 列出分类与文档，并发现未登记的 md', () => {
  fs.writeFileSync(path.join(root, '分镜', '99_orphan.md'), '# orphan\n');
  const list = m.listManual();
  assert.equal(list.root, root);
  assert.equal(list.categories.length, 1);
  const files = list.categories[0].docs.map((d) => d.file);
  assert.deepEqual(files, ['01_a.md', '99_orphan.md']);
  assert.equal(list.categories[0].docs[1].auto, true);
});

test('readDoc / saveDoc：改磁盘、写备份、相同内容不写盘、旧 hash 返回 409', () => {
  const before = m.readDoc('storyboard', '01_a.md');
  assert.equal(before.content, '# A\nhello\n');
  const r = m.saveDoc('storyboard', '01_a.md', '# A\nhello\nchanged\n', before.hash);
  assert.equal(r.changed, true);
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(fs.readFileSync(r.backup, 'utf8'), '# A\nhello\n');
  assert.equal(fs.readFileSync(path.join(root, '分镜', '01_a.md'), 'utf8'), '# A\nhello\nchanged\n');
  const same = m.saveDoc('storyboard', '01_a.md', '# A\nhello\nchanged\n', r.hash);
  assert.equal(same.changed, false);
  try {
    m.saveDoc('storyboard', '01_a.md', 'x', before.hash);
    assert.fail('should 409');
  } catch (e) {
    assert.equal(e.status, 409);
  }
});

test('路径穿越被拒绝', () => {
  assert.throws(() => m.readDoc('storyboard', '../manual.json'), (e) => e.status === 400);
  assert.throws(() => m.readDoc('storyboard', '..\\..\\config.json'), (e) => e.status === 400);
});

test('createCategory / createDoc / updateDocMeta', () => {
  const c = m.createCategory('剪辑', '剪辑', '');
  assert.ok(fs.existsSync(path.join(root, '剪辑')));
  const d = m.createDoc(c.id, '示例');
  assert.ok(fs.existsSync(path.join(root, '剪辑', d.file)));
  const meta = m.updateDocMeta(c.id, d.file, { status: '草案' });
  assert.equal(meta.status, '草案');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manual.json'), 'utf8'));
  assert.equal(manifest.categories.length, 2);
  assert.ok(fs.readdirSync(path.join(root, '_backup')).some((f) => f.startsWith('manual.json.')));
});
