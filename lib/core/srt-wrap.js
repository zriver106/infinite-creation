// 烧字幕前自己断行（11-28 跟进2 报：一条 19 字的字幕被 libass 自动折行，逗号落到第二行行首）。
// 做法：按画面宽度算一行放得下多少字；超宽的字幕在标点后面断（逗号、顿号、破折号等留在上一行末尾），
// 没有合适标点时按字数均分，但行首不准是标点；烧录时配 WrapStyle=2，libass 不再自己折行，只认这里的换行。
// 只改烧进画面的那份，旁边附带的 .srt 文件保持原文。

// 行尾可以断开的标点（断在它后面）；也不准出现在行首
const BREAK_AFTER = '，、；：。！？…—,;:!?';
const NO_LINE_START = BREAK_AFTER + '）」』”’)]》';

/** 显示宽度：中日韩全角字算 1，半角字母数字算 0.5。 */
export function textUnits(s) {
  let n = 0;
  for (const ch of String(s || '')) n += /[\x00-\x7f -ÿ]/.test(ch) ? 0.5 : 1;
  return n;
}

/**
 * 一行放得下多少个全角字。SRT 交给 libass 时脚本分辨率按默认 384×288，字号按画面高 / 288 放大，
 * 全角字的步进约为放大后字号的 0.75（实测 1280×720、FontSize 36：每字约 68px）；左右各留 5% 边距。
 */
export function maxUnitsPerLine(width, height, fontSize) {
  const px = Number(fontSize) * (Number(height) / 288) * 0.75;
  if (!(px > 0) || !(width > 0)) return 0;
  return Math.max(6, Math.floor((width * 0.9) / px));
}

/** 把一行切成每行不超过 max 个单位的几行：优先断在标点后，离均分点最近的那个；行首不留标点。 */
export function wrapLine(line, max) {
  const chars = Array.from(String(line || ''));
  if (!max || textUnits(line) <= max) return [String(line || '')];
  const out = [];
  let rest = chars;
  while (textUnits(rest.join('')) > max) {
    const total = textUnits(rest.join(''));
    const nLines = Math.ceil(total / max);
    const ideal = total / nLines;
    // 候选断点：断在第 i 个字之后，前一段不超过 max
    let best = -1; let bestScore = Infinity; let acc = 0;
    for (let i = 0; i < rest.length - 1; i++) {
      acc += textUnits(rest[i]);
      if (acc > max) break;
      if (NO_LINE_START.includes(rest[i + 1])) continue;               // 下一行开头不能是标点
      if (total - acc > max * (nLines - 1)) continue;                   // 剩下的要能放进最少行数，不为了标点多折一行
      const punct = BREAK_AFTER.includes(rest[i]);
      const score = Math.abs(acc - ideal) - (punct ? max : 0);          // 标点后断优先，再看是否接近均分
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) {                                                     // 找不到合规断点：硬断，并把行首标点挪回上一行
      let a = 0; best = 0;
      for (let i = 0; i < rest.length; i++) { a += textUnits(rest[i]); if (a > max) break; best = i; }
      while (best + 1 < rest.length - 1 && NO_LINE_START.includes(rest[best + 1])) best++;
    }
    out.push(rest.slice(0, best + 1).join(''));
    rest = rest.slice(best + 1);
  }
  if (rest.length) out.push(rest.join(''));
  return out;
}

/** SRT 全文：每条字幕的正文逐行按宽度断行（时间轴和序号不动）。 */
export function wrapSrtForBurn(srt, max) {
  if (!max) return srt;
  const blocks = String(srt || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split('\n');
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) return b;
    const head = lines.slice(0, ti + 1);
    const body = lines.slice(ti + 1).flatMap((l) => wrapLine(l, max));
    return head.concat(body).join('\n');
  }).join('\n\n');
}
