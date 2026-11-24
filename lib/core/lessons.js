// IC 经验规则（skills/ic-lessons）按阶段装配（2026-11-23 IC规则同步第3步；Andy 11-23 18:41「让 ic 制作流程读取手册的时候加载进去」）。
// skills/ic-lessons/SKILL.md 的每个「## 」小节标题带阶段标签：【通用】【剧本】【分镜】【资产】【提示词】【审片】，待测小节另带【待测】。
// 加载某个阶段的技能时（skill-engine.loadSkill），把【通用】+ 该阶段的正式小节 + 该阶段的【待测】小节附在技能正文后面；
// 剧本生成接口（prompts.buildChapterScriptMessages）不走技能，直接附【剧本】阶段。
// 每次调用都重新读文件（与 readSkillFile 一致，无缓存）：改了 SKILL.md 下一次调用即生效，不用重启。
// 关闭：环境变量 IC_LESSONS=off。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKILLS_DIR } from './config.js';

export const LESSONS_SKILL = 'ic-lessons';
export const LESSON_STAGES = ['通用', '剧本', '分镜', '资产', '提示词', '审片'];

// 技能 → 阶段。没列出的技能不附经验规则。总控类技能只附【通用】，并提示各阶段开工前加载。
export const SKILL_LESSON_STAGES = {
  // 剧本
  '0715-scriptwriter': ['剧本'],
  'script-master': ['剧本'],
  'sd-script-engine': ['剧本'],
  'short-drama-scriptwriting': ['剧本'],
  'novel-to-skitscreenplay': ['剧本'],
  // 剧本 + 分镜（story-pipeline-cn 三种模式覆盖写剧本和拆分镜）
  'story-pipeline-cn': ['剧本', '分镜'],
  // 分镜
  'sd-storyboard-engine': ['分镜'],
  'scene-blocking-consistency': ['分镜'],
  'novel-to-storyboard': ['分镜'],
  'hf-drama-storyboard-script': ['分镜'],
  'script-to-storyboard': ['分镜'],
  // 资产
  'image-prompt-writing': ['资产'],
  'sd-asset-engine': ['资产'],
  'era-consistency-optimizer': ['资产'],
  // 提示词
  'h3-prompt-writing': ['提示词'],
  'video-cinematography': ['提示词'],
  'sd-feed-engine': ['提示词'],
  // 审片
  'sd-qc-engine': ['审片'],
  // 总控
  'novel-to-video': [],
  'short-drama-director': [],
};

export function lessonsEnabled() {
  return String(process.env.IC_LESSONS || '').trim().toLowerCase() !== 'off';
}

function lessonsFile() {
  return path.join(SKILLS_DIR, LESSONS_SKILL, 'SKILL.md');
}

function readLessonsText() {
  try { return fs.readFileSync(lessonsFile(), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; }
}

// 解析成 { version, sections: [{ title, tags:Set, pending, text }] }。frontmatter 和第一个「## 」之前的引言不进 sections。
export function parseLessons(text) {
  const src = String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const vm = src.match(/版本：(\S+?)（/);
  const sections = [];
  let cur = null;
  for (const line of src.split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) sections.push(cur);
      const title = line.slice(3).trim();
      const tags = new Set([...title.matchAll(/【([^】]+)】/g)].map((m) => m[1]));
      cur = { title, tags, pending: tags.has('待测'), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return {
    version: vm ? vm[1] : '',
    sections: sections.map((s) => ({ title: s.title, tags: s.tags, pending: s.pending, text: s.lines.join('\n').trim() })),
  };
}

// 某一阶段要附的小节：【通用】+ 本阶段正式；本阶段【待测】单独一组。stages 为空 = 只要【通用】。
export function selectLessons(parsed, stages) {
  const want = new Set(stages || []);
  const hit = (s) => s.tags.has('通用') || [...want].some((st) => s.tags.has(st));
  return {
    formal: parsed.sections.filter((s) => !s.pending && hit(s)),
    pending: parsed.sections.filter((s) => s.pending && [...want].some((st) => s.tags.has(st))),
  };
}

/** 按阶段渲染经验规则块；没有可附内容或已关闭时返回 ''。 */
export function renderLessons(stages, opts = {}) {
  if (!lessonsEnabled()) return '';
  const text = opts.text != null ? String(opts.text) : readLessonsText();
  if (!text) return '';
  const parsed = parseLessons(text);
  const { formal, pending } = selectLessons(parsed, stages);
  if (!formal.length && !pending.length) return '';
  const md5 = crypto.createHash('md5').update(text).digest('hex').toUpperCase();
  const label = (stages && stages.length) ? stages.join('、') : '总控';
  const out = [
    '<ic_lessons stage="' + label + '" version="' + parsed.version + '" md5="' + md5 + '">',
    '【IC 经验规则（skill ic-lessons）· 本阶段：' + label + '】以下是本项目返修教训整理成的通用规则，和上面技能正文一样必须遵守；与上面技能正文冲突时以这里为准（h3-prompt-writing 除外：提示词写法以 h3-prompt-writing 为准）。全文可用 skill(ic-lessons) 查看。',
  ];
  if (!stages || !stages.length) out.push('各阶段开工前（写剧本、拆分镜、做资产、写提示词、审片），先加载该阶段的技能：IC 会把对应阶段的经验规则和待测规则附在技能正文后面。');
  for (const s of formal) out.push(s.text);
  if (pending.length) {
    out.push('【待测规则（临时，照样执行）】下面这些还没经成片验证：照样执行；执行后出了新问题，在报告里写明是哪条待测规则、哪一镜，不要自己删规则。');
    for (const s of pending) out.push(s.text);
  }
  out.push('</ic_lessons>');
  return out.join('\n\n');
}

/** 某个技能要附的经验规则块（技能不在映射表里、或就是 ic-lessons 本身时返回 ''）。 */
export function lessonsForSkill(name) {
  const n = String(name || '');
  if (!n || n === LESSONS_SKILL) return '';
  if (!Object.prototype.hasOwnProperty.call(SKILL_LESSON_STAGES, n)) return '';
  return renderLessons(SKILL_LESSON_STAGES[n]);
}
