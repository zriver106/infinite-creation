// 续轮12快（2026-11-24，总导 00:15/00:17）：剧本/分镜阶段的硬检。
// 起因：EP6 重拆核查（job a80f63fa）——分镜 Agent 没读 sd-storyboard-engine / adapt-rules、在 set_storyboard 里顺手写了
// video_prompt（收尾因「提示词已齐」跳过提示词撰写，ranges_ack/save_ack 机制没跑）、27 镜 costume_ids 全空、
// 台词「小舅子」写成「小舒子」、剧本里没有的心声也进了分镜、Agent 自己编参考编号、顺手改了本章配乐。
// 本文件只放纯函数和会话状态，tools.js 在对应工具里调用。
import { parseDialogue } from '../core/offscreen-lines.js';
import { inCostumeBase } from './binding-check.js';

// 剧本、分镜两个写入工具要求本任务里先真读过的规则书（skill(name) 成功返回过）。
export const STAGE_REQUIRED_SKILLS = {
  set_chapter_script: ['adapt-rules', 'sd-storyboard-engine'],
  set_storyboard: ['adapt-rules', 'sd-storyboard-engine'],
};

// 分镜/剧本阶段默认不许动的配乐工具（EP6 Agent 顺手把第6章配乐换了）。项目 context.storyboard_allow_music=true 时放行。
export const STAGE_MUSIC_TOOLS = new Set(['set_chapter_music', 'set_chapter_music_cues', 'apply_chapter_music']);

/** 新硬检是否生效：任务里（有 jobId）一律生效；没有任务的单测/脚本调用可用 IC_STAGE_GUARDS=1 打开。 */
export function stageGuardsOn(ctx) {
  if (process.env.IC_STAGE_GUARDS === '0') return false;
  return !!(ctx && ctx.jobId) || process.env.IC_STAGE_GUARDS === '1';
}

/** skill(name) 成功返回后记一笔：本任务真读过这本规则书（= 实际返回给 Agent 的内容，返回前已过 40,000 字上限检查）。 */
export function noteSkillServed(ctx, name, meta = {}) {
  if (!ctx) return;
  if (!ctx.skillsServed) ctx.skillsServed = new Map();
  ctx.skillsServed.set(String(name), { ts: Date.now(), ...meta });
}

/** 写剧本/分镜前：本任务没读过的规则书 → 拒绝。 */
export function assertStageSkills(ctx, tool) {
  if (!stageGuardsOn(ctx)) return;
  const need = STAGE_REQUIRED_SKILLS[tool] || [];
  const served = (ctx && ctx.skillsServed) || new Map();
  const missing = need.filter((n) => !served.has(n));
  if (missing.length) {
    throw new Error(tool + ' 被拒：本任务还没读规则书 ' + missing.map((n) => 'skill(name="' + n + '")').join('、')
      + '。先调用它们读地图+基础规则（分册按地图用 skill_lines 读），再写。');
  }
}

// 台词比对用的归一：只去空白和引号（「」“”""『』''），标点、字一律保留——错一个字就对不上。
const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, '').replace(/[「」『』“”"'‘’]/g, '');

/**
 * 分镜台词/心声逐句对剧本原句：每一行「说话人：台词」的台词正文，必须原样出现在本章剧本里。
 * 返回 { errors:[{line, text, why}] }。剧本为空时，凡有台词的分镜一律报错（没有原句可对）。
 */
export function checkDialogueAgainstScript(dialogue, script) {
  const errors = [];
  const lines = parseDialogue(dialogue);
  if (!lines.length) return { errors };
  const ns = norm(script);
  if (!ns) {
    errors.push({ line: String(dialogue).slice(0, 60), text: '', why: '本章还没有剧本，台词没有原句可对；先 get_chapter 确认剧本，剧本为空时先写剧本' });
    return { errors };
  }
  for (const l of lines) {
    const t = norm(l.text);
    if (!t) continue;
    if (ns.includes(t)) continue;
    // 一行里可能把剧本相邻的两句拼在一起（中间去掉了说话人）：按句末标点切开，每一小句都得在剧本里
    const parts = String(l.text).split(/(?<=[。！？!?…])/).map(norm).filter(Boolean);
    const bad = parts.filter((p) => !ns.includes(p));
    if (parts.length > 1 && !bad.length) continue;
    errors.push({ line: l.raw.trim().slice(0, 80), text: (bad[0] || t).slice(0, 60), why: '剧本里找不到这句原话（错字、改写、增删字或剧本里没有的句子都不行）' });
  }
  return { errors };
}

/** 有出场人物但一件服装都没绑 → 错误文本；否则 ''。
 * 2026-11-25（主会话 seq1923，规则 A-006/J-007「缺图不等图」）：
 *  - 在基础形象豁免段（项目 context.costume_base）里的人物不算缺服装；
 *  - 单人镜缺服装不拒整批，只由 collectMissingBindingWarnings 报警告；
 *  - 多人镜里有豁免段外的人物、又一件服装都没绑，照旧整批拒绝。 */
export function costumeBindingError(sb, characterIds, costumeIds, { costumeBase = [], chapter } = {}) {
  const chars = Array.isArray(characterIds) ? characterIds : [];
  const cost = Array.isArray(costumeIds) ? costumeIds : [];
  if (!chars.length || cost.length) return '';
  const shot = { chapter: chapter != null ? chapter : sb.chapter, idx: sb.idx };
  const need = chars.filter((id) => !inCostumeBase(costumeBase, id, shot));
  if (!need.length || chars.length === 1) return '';
  return '第' + sb.idx + '镜有出场人物（' + (sb.characters || []).join('、') + '）但 costumes 为空：每个有人物的镜头都要按剧情绑定该人物当前那套服装资产（list_assets 看 costume 类）；缺服装资产的人物先在 costume_base 登记走基础形象，并列进缺图单交 am';
}
