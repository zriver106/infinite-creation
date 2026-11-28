// 字幕（SRT）生成。
//
// 文本只取镜头 dialogue 字段（总导 16:21 / CH8-007）：
//   1) segmentsToSrt：把已经按 dialogue 对齐过的分段写成 SRT（时间来自音轨，字仍是 dialogue）；
//   2) buildSrt：script 模式直接按 dialogue 估时；不读 narration、<d>、sub_shots。
// 取不到 dialogue 或对齐失败时由调用方报错停下，不得回退 ASR 原文。
import { SHOT_DURATION_DEFAULT } from './shot-write.js';

// 秒 -> SRT 时间戳 "HH:MM:SS,mmm"
export function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(milli, 3);
}

// 单镜字幕文本只取 dialogue：去掉行首「人物：」/「人物（OS）：」前缀（字幕里不出现角色名）。
// 不读 narration。一行一句，便于逐句分配时间轴。
// 引号保持 dialogue 原文（按「」口径书写，后期不把「」改成 “” 或 ""）。
function subtitleLines(shot) {
  const out = [];
  // dialogue 为空、只有旁白的镜取 narration（11-28：R-004 允许每场 ≤1 句旁白，只有旁白的镜不再整章拦下）
  (String((shot && shot.dialogue) || '').trim() || String((shot && shot.narration) || ''))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // 「林默：你好」/「江澈（OS）：够。」/「系统：叮——」→ 只留冒号后的台词。限长 32 字，避免把
    // 带冒号的整句叙述（如「他说：走吧」）之外的长句误当说话人标签。
    .map((l) => l.replace(/^[^：:]{1,32}[：:]\s*/, '').trim())
    .filter(Boolean)
    .forEach((l) => out.push(l));
  return out;
}

// 有 <d>、却既没有 dialogue 也没有 narration 的镜头必须停下，不得回退 <d> / ASR。只有旁白的镜按 narration 出字幕。
export function assertDialogueSource(shots) {
  const missing = [];
  for (const shot of shots || []) {
    if (!shot) continue;
    const dlg = String(shot.dialogue || '').trim();
    const nar = String(shot.narration || '').trim();
    const prompt = String(shot.video_prompt_used || shot.video_prompt || '');
    const hasD = /<d>[\s\S]*?<\/d>/.test(prompt);
    if (!dlg && !nar && hasD) {
      missing.push(shot.idx != null ? shot.idx : (shot.id || '?'));
    }
  }
  if (missing.length) {
    throw new Error('字幕取镜头 dialogue（只有旁白的镜取 narration），下列镜头有 <d> 但两样都没有，已拒绝回退到 <d>/ASR：#' + missing.join(', #'));
  }
}

// 估算「这句话说完要多久」：按中文字幕常用语速（约 5 字/秒）折算，并给一个最短停留时间，
// 让很短的一句（「嗯」「好」）也能看清。字幕只在这段时间内显示，说完就消失——
// 不再占满整个分镜（分镜尾部没说话的空白期不该还挂着上一句台词）。
const SPEECH_RATE = 5;      // 字/秒
const MIN_CUE_SEC = 0.8;    // 单句最短显示时长

// 分镜数组（按叙事顺序）-> SRT 全文。
// 每镜的 duration 照常推进时间轴（没说话的镜头也不产出空 cue），
// 镜内多句台词按各自的「说完所需时长」顺序排布，每句一条 cue（单行）。
export function buildSrt(shots) {
  const cues = [];
  let cursor = 0;
  for (const shot of shots || []) {
    if (!shot) continue;
    const dur = Number(shot.duration) > 0 ? Number(shot.duration) : SHOT_DURATION_DEFAULT;
    const start = cursor;
    cursor += dur;
    const lines = subtitleLines(shot);
    if (!lines.length) continue;
    const spans = lines.map((l) => Math.max(MIN_CUE_SEC, l.length / SPEECH_RATE));
    const total = spans.reduce((a, b) => a + b, 0);
    // 台词总时长超出本镜时按比例压缩，保证字幕不会越到下一个分镜
    const scale = total > dur ? dur / total : 1;
    let t = start;
    for (let i = 0; i < lines.length; i++) {
      const span = spans[i] * scale;
      cues.push({ index: cues.length + 1, start: t, end: t + span, text: lines[i] });
      t += span;
    }
  }
  if (!cues.length) return '';
  return cues.map((c) => c.index + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n').join('\n');
}

// whisper 分段 -> SRT 全文。只做清洗（丢空文本、非法时间、end <= start 的段），
// 不做折行/标点后处理 —— 与 audio2srt 一致，断句与标点由 whisper 自身给出。
export function segmentsToSrt(segments) {
  const cues = (segments || []).filter(
    (s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && String(s.text || '').trim(),
  );
  if (!cues.length) return '';
  return cues
    .map((c, i) => i + 1 + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + String(c.text).trim() + '\n')
    .join('\n');
}
