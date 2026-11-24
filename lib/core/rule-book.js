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

/** 按分镜数据判断契约里的 when 条件，返回命中的条件集合（含 always）。 */
export function shotConditions(shot, project, opts = {}) {
  const s = shot || {};
  const c = new Set(['always']);
  const dlg = String(s.dialogue || '');
  const vis = String(s.visual || '');
  const cam = String(s.camera || '');
  const off = offscreenLines(dlg);
  if (off.some((l) => l.kind === 'os') || /OS|心声|内心独白/.test(dlg)) c.add('os');
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
  if (has(cam, /推近|推进|拉远|拉开|摇镜|横移|跟拍|跟随|升降|环绕|运镜|甩镜|打斗|dolly|pan|tilt|track/i) || has(vis, /打斗|打架|扇了|扇他|一巴掌|挥拳|出拳|踹|追赶|追逐|奔跑|跑向|跑出|摔倒|摔在|倒地/)) c.add('motion');
  const sw = project ? Object.entries(opts.switches || {}).some(([, v]) => v) : false;
  if (sw || has(vis + dlg, /Q版|特效|金光眼|谐音/)) c.add('expression');
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
  return {
    required_ranges: vols.map((s) => ({ id: s.id, title: s.title, start: s.start, end: s.end, chars: s.chars })),
    required_chars: requiredChars,
    volume_chars: volumeChars,
    too_dense: volumeChars > budget,
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
