// 默认配乐走曲库（Andy 11-28「bgm 默认去 kim-bgm\」「默认使用 01 囚笼、03 Life Struggle、05 Overturn、07 Amazon」「其余的根据文档自行选择」）：
// 本章没有选定曲目、也没明确要求「生成」时，在曲库里按《康康合集-BGM情绪与使用指南》给本章挑主曲：
//   首选名单（配置 bgm.preferred）里情绪对得上就用首选；都对不上，才按指南从其余曲目里选，不用点名。只有明确要求生成才调 MiniMax。
// 先问一次项目配置的 LLM（全曲库给它看，首选标出来；只回一个编号）；LLM 不可用或回答不在曲库里，就按指南的情绪 / 场景 / 忌用词打关键词分，首选优先。
import { llmChat } from '../core/llm.js';

/** 首选名单（两位编号）：配置 bgm.preferred；没配就是空（全曲库平等）。 */
export function preferredNos(cfg) {
  const p = cfg && cfg.bgm && Array.isArray(cfg.bgm.preferred) ? cfg.bgm.preferred : [];
  return p.map((x) => String(x).padStart(2, '0'));
}

/** 首选曲目对象（按名单顺序，曲库里找不到的略过）。 */
export function preferredTracks(map, cfg) {
  if (!map || !Array.isArray(map.tracks)) return [];
  return preferredNos(cfg).map((no) => map.tracks.find((t) => String(t.no) === no)).filter(Boolean);
}

const cut = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 本章拿来判断情绪的文字：大纲 + 剧本（没有剧本用原文）。 */
export function chapterMoodText(ch) {
  return [ch && ch.title, ch && ch.outline, ch && (ch.script || ch.novel)].filter(Boolean).join('\n');
}

// 关键词兜底：把指南里每首的「情绪 / 适用场景」切成短词，数在本章文字里出现几次；「忌用」里的词出现一次扣两分。
function words(s) { return String(s || '').split(/[，,、。；;：:\s（）()「」“”/|｜]+/).map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 6); }
export function keywordScore(tr, text) {
  const t = String(text || '');
  let score = 0;
  for (const w of new Set([...words(tr.emotion), ...words(tr.scenes)])) { const n = t.split(w).length - 1; if (n) score += n; }
  for (const w of new Set(words(tr.avoid))) { const n = t.split(w).length - 1; if (n) score -= 2 * n; }
  return score;
}
/** 首选里有对得上的（得分 > 0）就取首选里最高的；首选都对不上，取全曲库最高的。 */
export function keywordPick(tracks, text, preferred = []) {
  const pref = new Set(preferred.map(String));
  const scored = tracks.map((tr) => ({ tr, score: keywordScore(tr, text) }));
  const best = (arr) => arr.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
  const bp = best(scored.filter((x) => pref.has(String(x.tr.no))));
  if (bp && bp.score > 0) return { no: bp.tr.no, by: 'keyword', score: bp.score, preferred: true };
  const ba = best(scored);
  if (ba && ba.score > 0) return { no: ba.tr.no, by: 'keyword', score: ba.score, preferred: pref.has(String(ba.tr.no)) };
  if (bp) return { no: bp.tr.no, by: 'keyword', score: bp.score, preferred: true };   // 谁都对不上：首选第一首
  return ba ? { no: ba.tr.no, by: 'keyword', score: ba.score, preferred: false } : null;
}

/**
 * 给本章挑主曲。返回 { no, by:'llm'|'keyword', preferred, reason }。
 * deps.chat 测试注入（默认用项目配置的 LLM）。
 */
export async function pickDefaultTrack({ map, chapter, llmCfg, cfg }, deps = {}) {
  const tracks = (map && Array.isArray(map.tracks)) ? map.tracks : [];
  if (!tracks.length) return null;
  const pref = preferredNos(cfg);
  const text = chapterMoodText(chapter);
  const chat = deps.chat || ((msgs) => llmChat(llmCfg, msgs, { temperature: 0.2, maxTokens: 200, timeoutMs: 60_000 }));
  if (llmCfg || deps.chat) {
    try {
      const line = (t) => t.no + '｜' + t.title + '｜情绪：' + (t.emotion || '') + '｜适用：' + (t.scenes || '') + '｜忌用：' + (t.avoid || '');
      const first = tracks.filter((t) => pref.includes(String(t.no)));
      const rest = tracks.filter((t) => !pref.includes(String(t.no)));
      const menu = (first.length ? '【首选】\n' + first.map(line).join('\n') + '\n【其余曲目】\n' : '') + rest.map(line).join('\n');
      const out = await chat([
        { role: 'system', content: '你是短剧配乐编辑，按曲库指南给本章挑一首主曲。' + (first.length ? '先看【首选】：本章整体情绪和其中某首对得上就选它；首选都对不上时，才从【其余曲目】里按情绪选。' : '') + '避开每首的「忌用」情境。只回 JSON：{"no":"两位编号","reason":"一句话理由"}。' },
        { role: 'user', content: '曲库（只能从这里选）：\n' + menu + '\n\n本章（' + ((chapter && chapter.title) || '') + '）剧本：\n' + cut(text, 6000) },
      ]);
      const raw = typeof out === 'string' ? out : (out && (out.content || out.text)) || '';
      const m = String(raw).match(/"no"\s*:\s*"?(\d{1,2})"?/) || String(raw).match(/\b(\d{2})\b/);
      const no = m ? m[1].padStart(2, '0') : '';
      if (tracks.some((t) => String(t.no) === no)) {
        const r = String(raw).match(/"reason"\s*:\s*"([^"]*)"/);
        return { no, by: 'llm', preferred: pref.includes(no), reason: r ? r[1] : '' };
      }
    } catch { /* LLM 不可用就走关键词 */ }
  }
  const k = keywordPick(tracks, text, pref);
  return k ? { no: k.no, by: 'keyword', preferred: k.preferred, reason: '关键词匹配得分 ' + k.score } : null;
}
