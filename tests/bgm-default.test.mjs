// 默认配乐走曲库（Andy 11-28）：首选名单在配置 bgm.preferred；首选情绪对得上用首选，对不上按指南从其余曲目选；只有明确生成才调 MiniMax；路径可配。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preferredNos, preferredTracks, keywordPick, pickDefaultTrack } from '../lib/agent/bgm-default.js';
import { bgmMapFile, bgmLibraryDir, DEFAULT_BGM_LIBRARY_DIR } from '../lib/shared/bgm-library.js';

const map = JSON.parse(fs.readFileSync(new URL('../lib/shared/bgm_映射.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const cfg = { bgm: { preferred: ['01', '03', '05', '07'] } };

test('首选名单只在配置里：bgm.preferred；映射表里不再有 default_pool；没配就没有首选', () => {
  assert.equal(map.default_pool, undefined);
  assert.deepEqual(preferredNos(cfg), ['01', '03', '05', '07']);
  assert.deepEqual(preferredTracks(map, cfg).map((t) => t.title), ['囚笼', 'Life Struggle', 'Overturn', 'Amazon']);
  assert.deepEqual(preferredNos({}), []);
  assert.deepEqual(preferredNos({ bgm: { preferred: [1, '3'] } }), ['01', '03']);
});

test('LLM 看全曲库、首选标出来；它可以选首选之外的（情绪对不上时）；答非所问就走关键词', async () => {
  const ch = { title: '第2章', script: '一家人吃饭，轻松打趣，温馨日常。' };
  let seen = [];
  const r = await pickDefaultTrack({ map, chapter: ch, cfg }, { chat: async (msgs) => { seen = msgs; return { content: '{"no":"17","reason":"轻松日常"}' }; } });
  assert.deepEqual([r.no, r.by, r.preferred], ['17', 'llm', false], '首选之外的也能选');
  assert.match(seen[1].content, /【首选】\n01｜囚笼/); assert.match(seen[1].content, /【其余曲目】/);
  assert.match(seen[0].content, /首选都对不上时，才从【其余曲目】/);
  const p = await pickDefaultTrack({ map, chapter: ch, cfg }, { chat: async () => ({ content: '{"no":"03"}' }) });
  assert.equal(p.preferred, true);
  const bad = await pickDefaultTrack({ map, chapter: ch, cfg }, { chat: async () => ({ content: '{"no":"99"}' }) });
  assert.equal(bad.by, 'keyword');
});

test('关键词兜底：首选里对得上就用首选；首选都是 0 分而别的曲子对得上，就用别的；谁都对不上用首选第一首', () => {
  const tracks = map.tracks;
  const pref = ['01', '03', '05', '07'];
  assert.equal(keywordPick(tracks, '他被冤枉、被羞辱，压抑地隐忍着，被逼到墙角。', pref).no, '01');
  const none = keywordPick(tracks, 'zzzz', pref);
  assert.deepEqual([none.no, none.preferred], ['01', true]);
  // 首选全不中、别的曲子中：挑一首指南里情绪写着的别的曲子的词
  const other = tracks.find((t) => !pref.includes(t.no) && t.emotion);
  const w = String(other.emotion).split(/[，,、。；;：:\s]+/).find((x) => x.length >= 2 && x.length <= 6);
  const k = keywordPick(tracks, (w + '。').repeat(5), pref);
  if (keywordPick(tracks.filter((t) => pref.includes(t.no)), (w + '。').repeat(5)).score <= 0) assert.equal(k.preferred, false);
});

test('路径不写死：映射表 环境变量 > 配置 > 仓库缺省；曲库目录 环境变量 > 配置 > 表内 > 缺省 kim-bgm\\完整版', () => {
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
  assert.match(src, /pickDefaultTrack\(\{ map, chapter: ch, cfg: ctx\.cfg/);
});
