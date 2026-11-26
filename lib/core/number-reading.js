// 数字两种写法视为一致（2026-11-26 主会话 seq2152；手册 M03 第3条；R-003 第0条用途表）
// 只在「台词进 <d>」比对时用：dialogue 写阿拉伯数字（3200）、<d> 写汉字读法（三千二）算同一句；反过来也认。原文两边都不改。
// 用途分流（R-003 第0条）：
//   号码（前面是 电话/手机/尾号/房间/门牌/编号/卡号/车牌/航班/车次/验证码…，或后面紧跟 室/房，或以 0 开头，或 7 位以上）→ 只认逐位念（一三零一 / 幺三零幺），
//     不认数值读法（一千三百零一）；
//   年份（4 位数紧跟「年」）→ 只认逐位念（二零二六年）；
//   数量 / 价格（后面紧跟 元/块/万/个/人/岁/米/斤/张/次/倍/天/% …）→ 只认数值读法（三千二百 / 三千二）；
//   其余（看不出用途）→ 两种都认。
// 数值读法认这些说法：标准读法（一万三千八百）、末位省略单位（一万三千八、三千二、一百五）、十几可带「一」（一十五）、百千万前的 2 可读「两」。
// 实现：把要找的那句（needle）里每个数字换成「可接受读法」的正则分支，其余字符原样转义，再到 hay 里找。

const CN_DIGIT = '零一二三四五六七八九';
const DIGIT_ALT = ['[零〇洞]', '[一幺]', '[二两]', '三', '四', '五', '六', '[七拐]', '八', '九'];
const UNIT_STEP = { 十: '', 百: '十', 千: '百', 万: '千' };
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CODE_BEFORE = /(号码|电话|手机|尾号|卡号|单号|编号|工号|学号|车牌|牌照|房号|房间|门牌|航班|车次|型号|密码|验证码|账号|代码|座机|分机|No\.?|#)$/i;
const CODE_AFTER = /^(室|房(?!子|价|租))/;
const VALUE_AFTER = /^(元|块|毛|角|分(?!之)|万|亿|千|百|个|位|人|岁|米|公里|里|斤|公斤|克|吨|张|次|倍|天|年(?!级)|月|周|小时|分钟|秒|%|％|件|套|台|辆|瓶|杯|碗|份|本|层|楼|平|亩|块钱)/;

/** 0 ≤ n < 1e12 的标准汉字读法（一万三千八百 / 一千三百零一 / 十五）。 */
export function cnStandard(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return null;
  if (n === 0) return '零';
  const four = (x) => { // 0 < x < 10000
    const ds = [Math.floor(x / 1000), Math.floor(x / 100) % 10, Math.floor(x / 10) % 10, x % 10];
    const us = ['千', '百', '十', ''];
    let s = ''; let zero = false; let started = false;
    for (let i = 0; i < 4; i++) {
      if (ds[i] === 0) { if (started) zero = true; continue; }
      if (zero) { s += '零'; zero = false; }
      s += CN_DIGIT[ds[i]] + us[i]; started = true;
    }
    return s;
  };
  const yi = Math.floor(n / 1e8); const wan = Math.floor(n / 1e4) % 1e4; const low = n % 1e4;
  let s = '';
  if (yi) s += four(yi) + '亿';
  if (wan) s += (yi && wan < 1000 ? '零' : '') + four(wan) + '万';
  else if (yi && low) s += '零';
  if (low) s += ((yi || wan) && low < 1000 && !(yi && !wan) ? '零' : '') + four(low);
  return s.replace(/^一十/, '十');
}

/** 一个整数的全部可接受数值读法（字符串列表，未做「两」替换）。 */
export function cnValueReadings(n) {
  const std = cnStandard(n);
  if (!std) return [];
  const out = new Set([std]);
  if (/^十/.test(std)) out.add('一' + std);
  // 末位省略单位：…[高位单位][数字][低一位单位] → 去掉最后的单位（三千二百→三千二、一万三千八百→一万三千八、一百五十→一百五、一万七千→一万七）
  for (const s of [...out]) {
    const m = s.match(/([十百千万亿])([一二三四五六七八九])([十百千万])$/);
    if (m && UNIT_STEP[m[1]] === m[3]) out.add(s.slice(0, -1));
  }
  return [...out];
}

const valueAlt = (s) => reEsc(s).replace(/二(?=[百千万亿])/g, '[二两]').replace(/^二$/, '[二两]');
const digitAlt = (ds) => ds.split('').map((d) => DIGIT_ALT[Number(d)]).join('');

/** 阿拉伯数字串 → 可接受读法的正则分支（含原样阿拉伯数字）。ctxBefore/After 是它在原句里的前后文。 */
export function arabicAlternatives(num, ctxBefore = '', ctxAfter = '') {
  const alts = [reEsc(num)];
  const pct = /[%％]$/.test(num);
  const body = num.replace(/[%％]$/, '');
  const [ip, fp] = body.split('.');
  if (pct || fp !== undefined) {
    // 小数 / 百分数：按数值读（三点五 / 百分之五十）
    const iv = cnValueReadings(Number(ip));
    const frac = fp !== undefined ? '点' + digitAlt(fp) : '';
    const core = iv.map((r) => valueAlt(r) + frac);
    alts.push(...(pct ? core.map((c) => '百分之' + c) : core));
    return alts;
  }
  const isYear = ip.length === 4 && /^年(?!级)/.test(ctxAfter);
  const isCode = !isYear && (CODE_BEFORE.test(ctxBefore) || CODE_AFTER.test(ctxAfter) || (ip.length > 1 && ip[0] === '0') || ip.length >= 7);
  const isValue = !isYear && !isCode && VALUE_AFTER.test(ctxAfter);
  if (isYear || isCode) { alts.push(digitAlt(ip)); return alts; }
  alts.push(...cnValueReadings(Number(ip)).map(valueAlt));
  if (!isValue && ip.length > 1) alts.push(digitAlt(ip));
  return alts;
}

/** 汉字数字串 → 数值（支持标准读法与末位省略单位）；不是合法读法返回 null。 */
export function parseCnValue(s) {
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit = { 十: 10, 百: 100, 千: 1000 };
  const big = { 万: 1e4, 亿: 1e8 };
  let total = 0; let sec = 0; let num = 0; let lastUnit = 0; let lastBig = 0;
  if (!/^[零〇一二两三四五六七八九十百千万亿]+$/.test(s)) return null;
  for (const c of s) {
    if (c in map) { num = map[c]; continue; }
    if (c in unit) { sec += (num || (c === '十' ? 1 : 0)) * unit[c]; if (!num && c !== '十') return null; lastUnit = unit[c]; num = 0; continue; }
    if (c in big) { sec += num; total += sec * big[c]; lastBig = big[c]; sec = 0; num = 0; lastUnit = 0; continue; }
  }
  if (num) {
    // 末位省略单位：三千二 = 3200；一万七 = 17000；一百五 = 150
    if (lastUnit >= 100 && !/零.$/.test(s)) num *= lastUnit / 10;
    else if (!lastUnit && lastBig && !sec && !/零.$/.test(s)) num *= lastBig / 10;
  }
  return total + sec + num;
}

/** 汉字数字串 → 可接受的阿拉伯写法分支（反方向：dialogue 写汉字、<d> 写阿拉伯数字）。 */
function cnAlternatives(run) {
  const alts = [reEsc(run)];
  if (/[十百千万亿]/.test(run)) {
    const v = parseCnValue(run);
    if (v != null) alts.push(String(v));
  } else if (run.length >= 2) {
    alts.push(run.split('').map((c) => ({ 零: 0, 〇: 0, 洞: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 拐: 7, 八: 8, 九: 9 }[c])).join(''));
  }
  return alts;
}

const TOKEN_RE = /\d+(?:\.\d+)?[%％]?|[零〇一二两三四五六七八九十百千万亿]{2,}/g;
const reCache = new Map();
/** needle 里有数字时返回「数字两种写法都认」的正则；没有数字返回 null（调用方照旧用 includes）。 */
export function numberAwareRegex(needle) {
  const s = String(needle || '');
  if (reCache.has(s)) return reCache.get(s);
  let out = ''; let last = 0; let any = false; let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) {
    const tok = m[0];
    const before = s.slice(Math.max(0, m.index - 4), m.index);
    const after = s.slice(m.index + tok.length, m.index + tok.length + 3);
    const alts = /\d/.test(tok) ? arabicAlternatives(tok, before, after) : cnAlternatives(tok);
    if (alts.length > 1) any = true;
    out += reEsc(s.slice(last, m.index)) + '(?:' + alts.join('|') + ')';
    last = m.index + tok.length;
  }
  out += reEsc(s.slice(last));
  const re = any ? new RegExp(out) : null;
  if (reCache.size > 2000) reCache.clear();
  reCache.set(s, re);
  return re;
}

/** hay 是否包含 needle；needle 里的数字两种写法都认（按用途分流，见文件头）。两边都应先做同样的规范化。 */
export function includesNumberAware(hay, needle) {
  const h = String(hay || ''); const n = String(needle || '');
  if (h.includes(n)) return true;
  const re = numberAwareRegex(n);
  return re ? re.test(h) : false;
}
