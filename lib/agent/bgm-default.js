// 默认配乐走曲库（Andy 11-28「bgm 默认去 kim-bgm\」「默认使用 01 囚笼、03 Life Struggle、05 Overturn、07 Amazon」）：
// 本章没有选定曲目、也没明确要求「生成」时，只在映射表 default_pool 这几首里，按《康康合集-BGM情绪与使用指南》各首的情绪配本章情绪。
// 先问一次项目配置的 LLM（只回一个编号，限定在名单里）；LLM 不可用或回答不在名单里，就按指南的情绪 / 场景 / 忌用词和本章剧本做关键词打分。
// 名单只在映射表 default_pool 一处维护；映射表没写就退回「全部曲目」。
import { llmChat } from '../core/llm.js';

/** 映射表里的默认名单（曲目对象，按名单顺序）。 */
export function defaultPoolTracks(map) {
  if (!map || !Array.isArray(map.tracks)) return [];
  const pool = Array.isArray(map.default_pool) ? map.default_pool.map((x) => String(x).padStart(2, '0')) : null;
  if (!pool || !pool.length) return map.tracks;
  return pool.map((no) => map.tracks.find((t) => String(t.no) === no)).filter(Boolean);
}

const cut = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 本章拿来判断情绪的文字：剧本优先，没有就原文；再加大纲。 */
export function chapterMoodText(ch) {
  return [ch && ch.title, ch && ch.outline, ch && (ch.script || ch.novel)].filter(Boolean).join('\n');
}

// 关键词兜底：把指南里每首的「情绪 / 适用场景」切成短词，数在本章文字里出现几次；「忌用」里的词出现一次扣两分。
function words(s) { return String(s || '').split(/[，,、。；;：:\s（）()「」“”/|｜]+/).map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 6); }
export function keywordPick(tracks, text) {
  const t = String(text || '');
  let best = null;
  for (const tr of tracks) {
    let score = 0;
    for (const w of new Set([...words(tr.emotion), ...words(tr.scenes)])) { const n = t.split(w).length - 1; if (n) score += n; }
    for (const w of new Set(words(tr.avoid))) { const n = t.split(w).length - 1; if (n) score -= 2 * n; }
    if (!best || score > best.score) best = { track: tr, score };
  }
  return best ? { no: best.track.no, by: 'keyword', score: best.score } : null;
}

/**
 * 在默认名单里给本章挑一首。返回 { no, by:'llm'|'keyword'|'only', reason }。
 * deps.chat 测试注入（默认用项目配置的 LLM）。
 */
export async function pickDefaultTrack({ map, chapter, llmCfg }, deps = {}) {
  const tracks = defaultPoolTracks(map);
  if (!tracks.length) return null;
  if (tracks.length === 1) return { no: tracks[0].no, by: 'only', reason: '默认名单只有一首' };
  const text = chapterMoodText(chapter);
  const chat = deps.chat || ((msgs) => llmChat(llmCfg, msgs, { temperature: 0.2, maxTokens: 200, timeoutMs: 60_000 }));
  if (llmCfg || deps.chat) {
    try {
      const menu = tracks.map((t) => t.no + '｜' + t.title + '｜情绪：' + (t.emotion || '') + '｜适用：' + (t.scenes || '') + '｜忌用：' + (t.avoid || '')).join('\n');
      const out = await chat([
        { role: 'system', content: '你是短剧配乐编辑。只能从给出的曲目里选一首最贴合本章整体情绪的作为本章主曲。只回 JSON：{"no":"两位编号","reason":"一句话理由"}。' },
        { role: 'user', content: '可选曲目（只能从这里选）：\n' + menu + '\n\n本章（' + ((chapter && chapter.title) || '') + '）剧本：\n' + cut(text, 6000) },
      ]);
      const raw = typeof out === 'string' ? out : (out && (out.content || out.text)) || '';
      const m = String(raw).match(/"no"\s*:\s*"?(\d{1,2})"?/) || String(raw).match(/\b(\d{2})\b/);
      const no = m ? m[1].padStart(2, '0') : '';
      if (tracks.some((t) => String(t.no) === no)) {
        const r = String(raw).match(/"reason"\s*:\s*"([^"]*)"/);
        return { no, by: 'llm', reason: r ? r[1] : '' };
      }
    } catch { /* LLM 不可用就走关键词 */ }
  }
  const k = keywordPick(tracks, text);
  return k ? { no: k.no, by: 'keyword', reason: '关键词匹配得分 ' + k.score } : null;
}
