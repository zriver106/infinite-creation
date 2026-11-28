// 默认配乐走曲库（Andy 11-28）：没选定曲目、没明确要求生成时，只在映射表 default_pool 里按本章情绪挑；路径可配。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultPoolTracks, keywordPick, pickDefaultTrack } from '../lib/agent/bgm-default.js';
import { bgmMapFile, bgmLibraryDir, DEFAULT_BGM_LIBRARY_DIR } from '../lib/shared/bgm-library.js';

const map = JSON.parse(fs.readFileSync(new URL('../lib/shared/bgm_映射.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));

test('映射表一处维护默认名单：01 囚笼、03 Life Struggle、05 Overturn、07 Amazon；名单为空退回全部曲目', () => {
  assert.deepEqual(map.default_pool, ['01', '03', '05', '07']);
  assert.deepEqual(defaultPoolTracks(map).map((t) => t.no), ['01', '03', '05', '07']);
  assert.equal(defaultPoolTracks({ ...map, default_pool: [] }).length, map.tracks.length);
});

test('LLM 只能在名单里选；回答不在名单里或 LLM 出错就按指南关键词挑', async () => {
  const ch = { title: '第1章', script: '江澈被主管当众羞辱，被逼到墙角，只能隐忍沉默。' };
  let seen = '';
  const r = await pickDefaultTrack({ map, chapter: ch }, { chat: async (msgs) => { seen = msgs[1].content; return { content: '{"no":"05","reason":"局势反转"}' }; } });
  assert.deepEqual([r.no, r.by, r.reason], ['05', 'llm', '局势反转']);
  assert.match(seen, /01｜囚笼/); assert.doesNotMatch(seen, /02｜/, '名单外的曲目不给 LLM 看');
  const out = await pickDefaultTrack({ map, chapter: ch }, { chat: async () => ({ content: '{"no":"17"}' }) });
  assert.equal(out.by, 'keyword'); assert.ok(['01', '03', '05', '07'].includes(out.no));
  const err = await pickDefaultTrack({ map, chapter: ch }, { chat: async () => { throw new Error('down'); } });
  assert.equal(err.by, 'keyword');
});

test('关键词兜底：受困隐忍的章挑 01 囚笼，翻盘反转的章不挑它', () => {
  const pool = defaultPoolTracks(map);
  assert.equal(keywordPick(pool, '他被冤枉、被羞辱，压抑地隐忍着，被逼到墙角。').no, '01');
  assert.notEqual(keywordPick(pool, '最后一刻翻盘，局势改变，反转打脸。').no, '01');
});

test('路径不写死：环境变量 > 配置 > 缺省；曲库目录同样可配', () => {
  assert.equal(bgmMapFile({ root: 'C:/ic', env: {} }), path.join('C:/ic', 'lib', 'shared', 'bgm_映射.json'));
  assert.equal(bgmMapFile({ root: 'C:/ic', cfg: { bgm: { mapFile: 'D:/m/map.json' } }, env: {} }), path.resolve('D:/m/map.json'));
  assert.equal(bgmMapFile({ root: 'C:/ic', cfg: { bgm: { mapFile: 'D:/m/map.json' } }, env: { IC_BGM_MAP: 'E:/x.json' } }), path.resolve('E:/x.json'));
  assert.equal(bgmLibraryDir({ library_dir: 'X:/lib' }, { env: {} }), 'X:/lib');
  assert.equal(bgmLibraryDir({ library_dir: 'X:/lib' }, { cfg: { bgm: { libraryDir: 'Y:/lib' } }, env: {} }), 'Y:/lib');
  assert.equal(bgmLibraryDir({}, { env: {} }), DEFAULT_BGM_LIBRARY_DIR);
});

test('generate_music 默认走曲库：只有 mode="generate" 才走 MiniMax；不再按 enable_bgm 分流', () => {
  const src = fs.readFileSync(new URL('../lib/agent/tools.js', import.meta.url), 'utf8');
  assert.match(src, /if \(String\(\(args && args\.mode\) \|\| ''\)\.toLowerCase\(\) !== 'generate'\) \{\s*return applyLibraryMusicForChapter\(ctx, args\);/);
  assert.doesNotMatch(src, /if \(ctx\.project\.enable_bgm === false\) \{\s*return applyLibraryMusicForChapter/);
  assert.match(src, /pickDefaultTrack\(\{ map, chapter: ch/);
});
