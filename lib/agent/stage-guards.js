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

// ---------------- 剧本阶段（2026-11-26 Andy「怎么这么多旁白」「v2 3204 字剧本到 v3 才一千多」「剧本生成有问题啊 大问题」） ----------------

/** skill_lines 成功返回后记一笔：本任务读到了哪些分册段（「技能:段号」）。 */
export function noteSkillLinesServed(ctx, name, sections) {
  if (!ctx) return;
  if (!ctx.skillSectionsServed) ctx.skillSectionsServed = new Set();
  for (const id of sections || []) ctx.skillSectionsServed.add(String(name) + ':' + id);
}

/**
 * 写剧本前要先读的规则：adapt-rules、sd-storyboard-engine 两本（地图+基础）；项目开了任一表现开关时，再加 adapt-rules 的 H2（表现手段）分册。
 * @param {object} ctx  @param {object} switches 项目表现开关值 @param {object|null} adaptIndex adapt-rules 规则书索引
 * @returns {string[]} 还没读的，每项一句「怎么读」
 */
export function scriptReadMissing(ctx, switches, adaptIndex) {
  const served = (ctx && ctx.skillsServed) || new Map();
  const out = STAGE_REQUIRED_SKILLS.set_chapter_script.filter((n) => !served.has(n)).map((n) => 'skill(name="' + n + '")');
  const anyOn = Object.values(switches || {}).some(Boolean);
  const h2 = anyOn && adaptIndex ? (adaptIndex.sections || []).find((s) => s.id === 'H2') : null;
  if (h2 && !((ctx && ctx.skillSectionsServed) || new Set()).has('adapt-rules:H2')) out.push('skill_lines(name="adapt-rules", from=' + h2.start + ', to=' + h2.end + ')（H2 表现手段：本项目开了表现开关）');
  return out;
}

const NARR_RE = /^\s*旁白\s*[（(]?[^：:]{0,8}[）)]?\s*[：:]\s*(.*)$/;
const SCENE_RE = /^\s*(?:#+\s*)?【第[^】]*场/;
const LOCK_ITEMS = ['地点', '在场', '服装', '站位'];
const PICTURE_RE = /^\s*[\[［【]\s*画面\s*[：:]/;
const QUOTE_RE = /[“"「]([^”"」\n]{4,})[”"」]/g;
const NUM_RE = /[0-9０-９零〇一二两三四五六七八九十百千万亿.%％]/g;
const normQ = (s) => String(s || '').replace(/[\s　]+/g, '').replace(/[，,。.！!？?…、；;：:「」『』“”"'‘’—\-]/g, '');

/**
 * 剧本存盘自检（只报不拦；口径照 adapt R-004–R-007）：旁白每场>1句或>20字 / 心声第三人称 / 某场连续 3 句以上心声 / 某场没有 [画面：] 行 /
 * 原著引号台词漏了 / 剧本比原著短 / 没有本章节拍表 / 某场缺场头锁定（地点、在场、服装、站位）。
 * @returns {{ code:string, detail:string }[]}
 */
export function checkScriptDraft(script, novel, { narrationMaxChars = 20 } = {}) {
  const out = [];
  const lines = String(script || '').split(/\r?\n/);
  // 按场切
  const scenes = []; let cur = { head: '（开场前）', lines: [] };
  for (const l of lines) { if (SCENE_RE.test(l)) { if (cur.lines.length || scenes.length) scenes.push(cur); cur = { head: l.trim().slice(0, 30), lines: [] }; } else cur.lines.push(l); }
  scenes.push(cur);
  const realScenes = scenes.filter((s) => s.lines.some((l) => l.trim()));
  let narrTotal = 0;
  for (const s of realScenes) {
    const narr = s.lines.map((l) => l.match(NARR_RE)).filter(Boolean);
    narrTotal += narr.length;
    if (narr.length > 1) out.push({ code: 'NARRATION_MANY', detail: s.head + '：旁白 ' + narr.length + ' 句（每场最多 1 句）' });
    for (const m of narr) { const t = m[1].trim(); if (t.length > narrationMaxChars) out.push({ code: 'NARRATION_LONG', detail: s.head + '：旁白 ' + t.length + ' 字超过 ' + narrationMaxChars + ' 字：「' + t.slice(0, 24) + '…」' }); }
    if (SCENE_RE.test(s.head) && !s.lines.some((l) => PICTURE_RE.test(l))) out.push({ code: 'NO_PICTURE_LINE', detail: s.head + '：没有 [画面：…] 行（动作、表情、走位写进 [画面：]，不配音）' });
    // R-004 第 7 条：一条 [画面：] 只写一个时刻——超过约 60 字或 3 个以上「，」分开的动作就提示拆行
    for (const l of s.lines) {
      if (!PICTURE_RE.test(l)) continue;
      const body = l.replace(/^\s*[\[［【]\s*画面\s*[：:]/, '').replace(/[\]］】]\s*$/, '').trim();
      const commas = (body.match(/[，,]/g) || []).length;
      if (body.length > 60 || commas >= 3) out.push({ code: 'PICTURE_LONG', detail: s.head + '：一条画面行 ' + body.length + ' 字、' + (commas + 1) + ' 个动作，拆成几行（一条只写一个时刻）：「' + body.slice(0, 24) + '…」' });
    }
    // R-006：每场先写场头锁定（地点 / 在场 / 服装 / 站位）
    if (SCENE_RE.test(s.head)) {
      const body = s.lines.join('\n');
      // 「场头锁定：同第 1 场，……都不变」这种整体沿用上一场的写法算齐
      const sameAs = /场头锁定[^\n]{0,8}同(第\s*\d+\s*场|上一?场|前一?场)/.test(body);
      const lack = sameAs ? [] : LOCK_ITEMS.filter((k) => !new RegExp('(^|[\\s*\\-•])' + k + '[^\\n]{0,4}[：:]', 'm').test(body));
      if (!/场头锁定/.test(body) || lack.length) out.push({ code: 'NO_SCENE_LOCK', detail: s.head + '：' + (/场头锁定/.test(body) ? '场头锁定缺 ' + lack.join('、') : '没有场头锁定（地点、在场、服装、站位）') });
    }
    // R-004 / R-005：心声少用——同一场连续 3 句以上心声（中间没有画面行或台词）就报
    let run = 0; let maxRun = 0;
    for (const l of s.lines) {
      if (!l.trim()) continue;
      const d = parseDialogue(l)[0];
      if (d && d.kind === 'os') { run++; maxRun = Math.max(maxRun, run); } else run = 0;
    }
    if (maxRun >= 3) out.push({ code: 'OS_RUN', detail: s.head + '：连续 ' + maxRun + ' 句心声（心声少用，能用镜头讲的用镜头）' });
  }
  // R-005：动笔前先写本章节拍表
  if (!/节拍表/.test(String(script || ''))) out.push({ code: 'NO_BEAT_TABLE', detail: '没有本章节拍表（R-005：动笔前先按原著写节拍表）' });
  // 心声第三人称
  for (const l of parseDialogue(script)) {
    if (l.kind !== 'os') continue;
    const t = String(l.text || ''); const who = String(l.speaker || '').trim();
    // 只认明确的第三人称：用自己的名字称呼自己，或「他/她 + 心想/觉得/暗想/心里」这种叙述口吻（「她说……」说的是别人，不算）
    const third = (who.length >= 2 && t.includes(who)) || /(^|[。！？，\s])[他她](心想|觉得|暗想|暗道|心里|心中|想着)/.test(t);
    if (third) out.push({ code: 'OS_THIRD_PERSON', detail: who + '（心声）用了第三人称：「' + t.slice(0, 30) + '」（心声是本人心里的话，用「我」）' });
  }
  // 原著引号台词漏了
  const ns = normQ(script);
  const missing = [];
  // 模糊比对：数字两种写法（200 / 两百）都去掉；一句拆成几行、中间插了说话人也认——按 6 字窗口，七成以上在剧本里就算有
  const nsNoNum = ns.replace(NUM_RE, '');
  const present = (q) => { const x = q.replace(NUM_RE, ''); if (x.length < 6) return nsNoNum.includes(x); let hit = 0; let n = 0; for (let i = 0; i + 6 <= x.length; i += 3) { n++; if (nsNoNum.includes(x.slice(i, i + 6))) hit++; } return hit / n >= 0.7; };
  for (const m of String(novel || '').matchAll(QUOTE_RE)) { const q = normQ(m[1]); if (q.length >= 4 && !present(q)) missing.push(m[1].slice(0, 30)); }
  if (missing.length) out.push({ code: 'NOVEL_LINE_MISSING', detail: '原著引号台词 ' + missing.length + ' 句在剧本里找不到原句（漏了的补上；改写过的核对是不是 R 段允许的改法）：' + missing.slice(0, 5).map((x) => '「' + x + '」').join('') + (missing.length > 5 ? '…' : '') });
  // 剧本比原著短
  const sc = String(script || '').replace(/\s+/g, '').length; const nc = String(novel || '').replace(/\s+/g, '').length;
  if (nc && sc < nc) out.push({ code: 'SCRIPT_SHORTER', detail: '剧本 ' + sc + ' 字，比原著 ' + nc + ' 字短：原著的画面和心理不要压缩掉，写进 [画面：] 和心声' });
  if (narrTotal && realScenes.length && narrTotal > realScenes.length) out.push({ code: 'NARRATION_TOTAL', detail: '全章旁白 ' + narrTotal + ' 句，多于场数 ' + realScenes.length });
  return out;
}
