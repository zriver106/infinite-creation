// 规则书（目录化 skill：SKILL.md = 地图+基础规则；规则全文.md = 地图+基础+分册；规则全文.index.json = 段落索引）
// 2026-11-23 续轮6（契约 r6/契约.md）：外部写手（Claude CLI over MCP）单个工具结果超过约 5 万字会静默失败，
// 所以任何返回文本上限 40,000 字，超了报错、不截断；分册按 skill_lines(name, from, to) 分段读。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILLS_DIR } from './config.js';
import { offscreenLines, parseDialogue } from './offscreen-lines.js';

export const RULE_TEXT_LIMIT = 40000;
export const RULE_INDEX_FILE = '规则全文.index.json';

function safeName(name) {
  const n = String(name == null ? '' : name);
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes(':') || path.isAbsolute(n)) return '';
  return n;
}

/** 规则书目录：显式 dir > 环境变量 IC_SKILLS_OVERRIDE_DIR/<name>（测试用）> skills/<name>。非法名返回 null。 */
export function ruleBookDir(name, dir) {
  if (dir) return dir;
  const n = safeName(name);
  if (!n) return null;
  const ov = process.env.IC_SKILLS_OVERRIDE_DIR;
  if (ov && fs.existsSync(path.join(ov, n))) return path.join(ov, n);
  return path.join(SKILLS_DIR, n);
}

/** 读 规则全文.index.json；没有（旧布局）或读坏了返回 null。 */
export function loadRuleIndex(name, dir) {
  const d = ruleBookDir(name, dir);
  if (!d) return null;
  const f = path.join(d, RULE_INDEX_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    const idx = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    if (!idx || !Array.isArray(idx.sections)) return null;
    return idx;
  } catch { return null; }
}

function fullTextLines(name, idx, dir) {
  const d = ruleBookDir(name, dir);
  const f = path.join(d, (idx && idx.file) || '规则全文.md');
  if (!fs.existsSync(f)) throw new Error('规则全文不存在：' + name);
  const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '' && /\n$/.test(text)) lines.pop();
  return lines;
}

/** 某段的校验码：start..end-1 行用 \n 连接，UTF-8 md5 前 8 位大写。 */
export function sectionChecksum(lines, start, end) {
  return crypto.createHash('md5').update(lines.slice(start - 1, end - 1).join('\n'), 'utf8').digest('hex').slice(0, 8).toUpperCase();
}

/** 完整落在 [from,to] 内的段。 */
export function sectionsCoveredBy(index, from, to) {
  const secs = (index && index.sections) || [];
  return secs.filter((s) => Number(s.start) >= from && Number(s.end) <= to);
}

/** 规则全文.md 第 from–to 行（1 起算、闭区间）。越界或超过 40,000 字报错。 */
export function readSkillLines(name, from, to, dir) {
  const idx = loadRuleIndex(name, dir);
  if (!idx) throw new Error('技能 ' + name + ' 没有规则全文索引（' + RULE_INDEX_FILE + '），不能按行读');
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('from/to 必须是整数行号');
  const lines = fullTextLines(name, idx, dir);
  if (a < 1 || b < a || b > lines.length) throw new Error('行号越界：from=' + a + ' to=' + b + '（规则全文共 ' + lines.length + ' 行，1 起算、闭区间、from≤to）');
  const text = lines.slice(a - 1, b).join('\n');
  if (text.length > RULE_TEXT_LIMIT) throw new Error('内容过长：第 ' + a + '–' + b + ' 行共 ' + text.length + ' 字，超过单次上限 ' + RULE_TEXT_LIMIT + ' 字。请按地图分成更小的行段多次用 skill_lines 读');
  return { text, from: a, to: b, sections: sectionsCoveredBy(idx, a, b).map((s) => s.id), version: idx.version || '', index: idx };
}

/** 地图 + 基础段（SKILL.md 里的部分）。 */
export function baseSections(index) {
  return ((index && index.sections) || []).filter((s) => s.tier === 'map' || s.tier === 'base');
}

const has = (s, re) => re.test(String(s || ''));
const listOf = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.filter(Boolean); } catch {}
    return v.split(/[,，\s]+/).filter(Boolean);
  }
  return [];
};

// 续轮16：本镜表现手段标记表（命中任一条 = 本镜用到 H2 管的手段）。查的字段：visual、sub_shots、camera、dialogue。
//   ① 【表现】行（分镜按 H2 第 0b 条写在 visual / sub_shots 里）：每一处【表现】都算，只有类型是「表演」「真人表演」的不算（真人表演 H2 不管）。
//      带编号的「【表现】P3｜特效·G01 金光眼｜…」「【表现】P4｜Q版·方式一…」「【表现】L1｜谐音｜配音替换…」「【表现】L3｜流行语…」「【表现】L4｜段子…」，
//      和不带编号、直接写效果的「【表现】额角滑下一颗夸张的大汗珠」「【表现】段子·原著自带：…」都算（复查1 第1条：7#1/#3/#10/#20 就是这种写法）。
//   ② 正文关键词：Q版 / chibi / 特效 / VFX / 金光眼 / 卡姿兰 / 谐音 / 流行语 / 段子 / 接梗 / 配音替换。
//      同一小句里（中间没有逗号、顿号、句号、分号）前面有否定词的不算，如「不用Q版、不加特效」「无Q版无特效」「不加任何特效」「without any chibi or VFX」。
//      中文否定词看前 8 个字：不用 / 不加 / 不要 / 不出 / 不做 / 不写 / 不放 / 不带 / 无 / 没有 / 别 / 禁止 / 禁用 / 勿（单字「不」不算，防「不知不觉」）；
//      英文否定词看前 24 个字符：no / not / without / never。
//      复查2 第1条补：前面是「避免 / 不再」，或紧挨着「镜N」（说的是别的镜，如「已有镜12金光眼+镜15 Q版」）的不算；
//      后面同一小句里紧跟「未用 / 不用 / 不加 / 放在下一镜 / 留到下一镜 / 放到下一镜」的也不算（如「Q版未用」「接梗放在下一镜」）。
//      「无比 / 无论 / 无疑 / 无限 / 无数 / 无奈」里的「无」不是否定；资产名「<人名>·Q版设定」不算本镜用了 Q 版（Q 版只认【表现】…Q版 行）。
//   先做 NFKC 归一（全角 Ｑ、｜ 等按半角算）。
const EXPR_TAG_RE = /【表现】([^\n]*)/g;
const EXPR_CODE_RE = /^\s*[A-Za-z]{0,2}\d*\s*[|︱丨]\s*/;
const EXPR_PERFORM_RE = /^\s*(真人)?表演/;
const EXPR_WORD_RE = /Q\s?版|chibi|特效|VFX|金光眼|卡姿兰|谐音|流行语|段子|接梗|配音替换/gi;
const EXPR_NEG_ZH_RE = /(不用|不加|不要|不出|不做|不写|不放|不带|无(?!比|论|疑|限|数|奈)|没有|别|禁止|禁用|勿|避免|不再)[^。；;，,、\n]{0,7}$/;
const EXPR_OTHER_SHOT_RE = /镜\s*\d+\s*$/;
// 2026-11-25（主会话 seq1593，2#26）：「金光眼本章已用在镜12」这类说明别镜已用过的，不算本镜用了。
const EXPR_NEG_AFTER_RE = /^[^。；;，,、\n]{0,4}(未用|不用|不加|(放|留|挪)(在|到)下一镜|已用(在|于|过)|已在镜\s*\d)/;
const EXPR_NEG_EN_RE = /\b(no|not|without|never)\b[^.;,\n]{0,20}$/i;
/** 本镜命中的表现手段标记（空数组 = 没用到 H2 管的手段）。 */
export function expressionMarkers(shot) {
  const s = shot || {};
  const out = [];
  for (const f of ['visual', 'sub_shots', 'camera', 'dialogue']) {
    const t = String(s[f] || '').normalize('NFKC');
    if (!t) continue;
    for (const m of t.matchAll(EXPR_TAG_RE)) {
      const body = m[1].replace(EXPR_CODE_RE, '');
      if (EXPR_PERFORM_RE.test(body)) continue;
      out.push(f + ':【表现】' + body.split(/[|︱丨:：]/)[0].trim().slice(0, 12));
    }
    for (const m of t.matchAll(EXPR_WORD_RE)) {
      const pre8 = t.slice(Math.max(0, m.index - 8), m.index);
      const post = t.slice(m.index + m[0].length, m.index + m[0].length + 10);
      if (/^Q\s?版$/i.test(m[0]) && post.startsWith('设定')) continue; // 「<人名>·Q版设定」是资产名，不是本镜用了 Q 版（H2 第1条：Q 版只认【表现】…Q版 行）
      if (EXPR_NEG_ZH_RE.test(pre8) || EXPR_OTHER_SHOT_RE.test(pre8) || EXPR_NEG_AFTER_RE.test(post) || EXPR_NEG_EN_RE.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
      out.push(f + ':' + m[0]);
    }
  }
  return out;
}

// 画面说明 / sub_shots 里提到心声（排除否定写法）
function osMentioned(t) {
  const s = String(t || '');
  for (const m of s.matchAll(/心声|内心独白|（OS）|\(OS\)/g)) {
    const pre8 = s.slice(Math.max(0, m.index - 8), m.index);
    const post = s.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (EXPR_NEG_ZH_RE.test(pre8) || /^[^。；;，,、\n]{0,2}(无|没有)/.test(post)) continue;
    return true;
  }
  return false;
}

/** 按分镜数据判断契约里的 when 条件，返回命中的条件集合（含 always）。 */
export function shotConditions(shot, project, opts = {}) {
  const s = shot || {};
  const c = new Set(['always']);
  const dlg = String(s.dialogue || '');
  const vis = String(s.visual || '');
  const cam = String(s.camera || '');
  const off = offscreenLines(dlg);
  // 2026-11-25（主会话 seq1821/1823）：心声 C 段改成按需读后，画面说明 / sub_shots 里写的心声也要触发（V2 30#6 心声只写在画面说明里）；
  // 「本镜无心声」「不用心声」这类否定写法按 EXPR_NEG_ZH_RE 排除。
  if (off.some((l) => l.kind === 'os') || /OS|心声|内心独白/.test(dlg) || osMentioned(vis + '\n' + (typeof s.sub_shots === 'string' ? s.sub_shots : JSON.stringify(s.sub_shots || '')))) c.add('os');
  if (off.some((l) => l.kind === 'system') || parseDialogue(dlg).some((l) => /^系统/.test(l.speaker)) || has(vis, /光幕|提示条/)) c.add('system');
  if (dlg.trim()) c.add('dialogue');
  const scenes = listOf(s.scene_ids);
  const chars = listOf(s.character_ids);
  const props = listOf(s.prop_ids);
  if (scenes.length) c.add('scene');
  if (chars.length) c.add('character');
  // 续轮7（复查1 第9条）：不用单字匹配（「车」会命中车站、「打」会命中打开、打电话）
  if (props.length || has(vis, /桌面|桌上|汽车|轿车|车内|车钥匙|开车|奥迪|展车|金条|手机屏/)) c.add('prop');
  if (chars.length >= 2) c.add('multi');
  // 2026-11-25（主会话 seq1589）：visual 打戏词去掉「挥拳」——「挥拳起哄」这类欢呼动作把固定机位镜误拉进 H1；真打戏由 打斗/打架/出拳/扇/踹 兜着。
  if (has(cam, /推近|推进|拉远|拉开|摇镜|横移|跟拍|跟随|升降|环绕|运镜|甩镜|打斗|dolly|pan|tilt|track/i) || has(vis, /打斗|打架|扇了|扇他|一巴掌|出拳|踹|追赶|追逐|奔跑|跑向|跑出|摔倒|摔在|倒地/)) c.add('motion');
  // 续轮16（总导 04:54）：H2（Q 版、特效、流行语与谐音）按本镜加载，不再「项目开了任一表现开关就每镜都加载」。
  // 项目四个表现开关全关 → 不加载；有开关开着 → 本镜确实用到表现手段（expressionMarkers 命中）才加载。
  const sw = project ? Object.entries(opts.switches || {}).some(([, v]) => v) : false;
  if (sw) {
    const mk = expressionMarkers(s);
    if (mk.length) {
      c.add('expression');
      c.add('expression_any');
      // 2026-11-25（16#13 too_dense）：H2 拆成 H2（Q 版、特效）和 H2L（流行语、段子、谐音），按标记类型分别加载。
      // 只按分得出类型的标记定；只有编号（如「L·P3」）或描述分不出的忽略；一个都分不出时只读 H2（与拆卷前一致）。
      const SLANG = /谐音|流行语|段子|接梗|玩笑|配音替换|脏话|原句|吐槽/i;
      const QV = /Q\s?版|chibi|特效|VFX|金光|卡姿兰|换头|小人|夸张|青筋|汗珠|冷光|阴影|冒出/i;
      let any = false;
      for (const m of mk) {
        if (SLANG.test(m)) { c.add('expression_slang'); any = true; }
        if (QV.test(m)) { c.add('expression_qv'); any = true; }
      }
      if (!any) c.add('expression_qv');
    }
  }
  if (opts.bindingDebt) c.add('binding');
  if (has(vis, /交易|付款|扫码|转账|到账|回忆|闪回|冲突|争执|推搡/)) c.add('logic');
  return c;
}

/** 本镜要读的分册段 + 合计字数。 */
export function requiredRanges(index, shot, project, opts = {}) {
  if (!index) return null;
  const cond = shotConditions(shot, project, opts);
  const vols = index.sections.filter((s) => s.tier === 'volume' && (s.when || []).some((w) => cond.has(w)));
  const base = baseSections(index);
  const sum = (arr) => arr.reduce((n, s) => n + (Number(s.chars) || 0), 0);
  // 续轮7（总导 23:29）：每次读取 ≤ 40,000 字。地图+基础一次读完（合并脚本保证 ≤ 40,000）；
  // 本镜要读的分册合计（volume_chars）也必须 ≤ 40,000，超了就是这一镜太满，拆镜，不提高上限。
  // brief 不再给校验码（复查1 第7条）：校验码只在每段最后一行，读到全段才看得到。
  const volumeChars = sum(vols);
  const requiredChars = sum(base) + volumeChars;
  const budget = Number(index.budget_chars) || RULE_TEXT_LIMIT;
  // 2026-11-25（主会话 seq1821）：budget_mode=total 时按「基础 + 本镜分卷」合计判；旧索引仍按分卷合计判
  const totalMode = index.budget_mode === 'total';
  return {
    required_ranges: vols.map((s) => ({ id: s.id, title: s.title, start: s.start, end: s.end, chars: s.chars })),
    required_chars: requiredChars,
    volume_chars: volumeChars,
    too_dense: (totalMode ? requiredChars : volumeChars) > budget,
    rules_version: index.version || '',
    conditions: [...cond],
    base: base.map((s) => ({ id: s.id })),
    _checksums: Object.fromEntries([...base, ...vols].map((s) => [s.id, s.checksum])),
  };
}

/** 追加一行 JSON 到项目目录下的 jsonl（rule_usage / rule_gaps）。失败不抛。 */
export function appendProjectJsonl(projectDirAbs, file, obj) {
  try {
    fs.mkdirSync(projectDirAbs, { recursive: true });
    fs.appendFileSync(path.join(projectDirAbs, file), JSON.stringify(obj) + '\n');
    return true;
  } catch { return false; }
}
