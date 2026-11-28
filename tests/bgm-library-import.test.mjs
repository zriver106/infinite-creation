// 曲库导入（Andy 11-28）：曲库全部曲目登记成项目 music 资产；硬链接不复制；首选标出来；重复导入不重复登记。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bgmlib-'));
const lib = path.join(tmp, 'kim-bgm', '完整版'); fs.mkdirSync(lib, { recursive: true });
const files = { '01-囚笼-北千川-完整候选.mp3': 'aaa-01', '02-Try-P!NK-完整候选.mp3': 'bbb-02', '03-Life Struggle-K1RO-完整候选.mp3': 'ccc-03' };
for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(lib, n), c);
const sha = (c) => crypto.createHash('sha256').update(c).digest('hex');
const map = {
  library_dir: lib,
  tracks: [
    { no: '01', title: '囚笼', emotion: '压抑', files: [{ file: '01-囚笼-北千川-完整候选.mp3', duration: '0:03', sha256: sha('aaa-01') }] },
    { no: '02', title: 'Try', emotion: '燃', files: [{ file: '02-Try-P!NK-完整候选.mp3', duration: '0:03', sha256: sha('bbb-02') }] },
    { no: '03', title: 'Life Struggle', emotion: '挣扎', files: [{ file: '03-Life Struggle-K1RO-完整候选.mp3', duration: '0:03', sha256: sha('ccc-03') }] },
  ],
};
fs.writeFileSync(path.join(tmp, 'map.json'), JSON.stringify(map));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' }, comfyui: { baseUrl: 'http://127.0.0.1:9' }, bgm: { preferred: ['01', '03'], mapFile: path.join(tmp, 'map.json') } }));
process.env.IC_DATA_DIR = path.join(tmp, 'data');
process.env.IC_CONFIG = cfgPath;
let core; let T;
before(async () => { core = await import('../lib/core/index.js'); T = await import('../lib/agent/tools.js'); });

test('导入曲库：全部曲目登记成 music 资产，硬链接（同一份数据）不复制，首选标出来；再导一次只复用', () => {
  const p = core.Projects.create({ name: 'bgm-import', auto_script: false });
  const r = T.importBgmLibrary(p.id);
  assert.deepEqual([r.added, r.existed, r.failed.length], [3, 0, 0]);
  const music = core.Assets.list(p.id, 'music');
  assert.equal(music.length, 3);
  const byNo = Object.fromEntries(music.map((a) => [a.params.bgm_library.no, a]));
  assert.equal(byNo['01'].params.bgm_library.preferred, true);
  assert.equal(byNo['02'].params.bgm_library.preferred, false);
  assert.match(byNo['03'].description, /^【首选】/);
  assert.doesNotMatch(byNo['02'].description, /首选/);
  // 硬链接：改原曲内容，项目里那份跟着变（同一份数据）
  const abs = core.resolveProjectPath(p.id, byNo['02'].audio_path);
  const st = fs.statSync(abs);
  assert.ok(st.nlink >= 2, '是硬链接（链接数 ≥ 2）');
  const again = T.importBgmLibrary(p.id);
  assert.deepEqual([again.added, again.existed], [0, 3]);
  assert.equal(core.Assets.list(p.id, 'music').length, 3);
});
