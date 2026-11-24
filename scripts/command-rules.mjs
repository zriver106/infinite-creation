// 指挥系统的规则表（只显示和提醒：不自动改链、不改稿、不发单）
// 排序规则：越靠前越优先。派工规则：每张派工单必须写明模型和理由。

export const PRIORITY_RULES = [
  { id: 'gpu-ep1-10-first', top: true, text: 'GPU 优先级：第1–10集最先。链序里第1–10集的镜头一律排在最前。', check: '违反就标红', source: 'Andy 2026-11-23 16:58（经总导转达）：第25章以后的写稿和指挥系统开发照常做，只有 GPU 链序把第1–10集排最前' },
];

export const MODEL_TABLE = [
  { kind: 'heavy', label: '写剧本、分镜、提示词、审片裁决、改代码、修问题、开发', model: 'Opus 5.5', re: /剧本|写稿|分镜|提示词|审片裁决|裁决|改代码|代码|修|开发|bug|改稿/i },
  { kind: 'cheap', label: '巡视、对账、整理清单、日志解析、简单复核', model: '便宜模型（Sonnet 或 Haiku）或 Codex', re: /巡视|对账|清单|日志|复核|核对|整理|统计|盘点/ },
  { kind: 'script', label: '能写成脚本的活', model: '脚本，不用模型', re: /脚本|定时|轮询|自动跑|自动检查/ },
  { kind: 'escalate', label: '同一个问题修了两次还不行', model: 'Fable 5.2（派工单写明前面失败了几次、各是哪次；别的情况一律不能选 Fable 5.2）', re: null },
];

export const DISPATCH_RULES = [
  { id: 'model-required', text: '每张派工单必须填「模型」和「选它的理由」两栏，空着不许派出去。', check: '空着标红「不许派出」', source: 'Andy 2026-11-23 17:04（经总导转达）' },
  { id: 'model-table', text: '按分配表选模型：' + MODEL_TABLE.map((m) => `${m.label} → ${m.model}`).join('；'), check: '选了 Opus 或 Fable 却不符合条件，标黄', source: 'Andy 2026-11-23 17:04 三条原话（经总导转达）' },
];

const str = (v) => (v == null ? '' : Array.isArray(v) ? v.map(str).join(' ') : typeof v === 'object' ? Object.values(v).map(str).join(' ') : String(v));
const get = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && str(o[k]).trim() !== '') return o[k]; return null; };

export function classifyTask(o) {
  const explicit = str(get(o, '活的类型', '任务类型', 'taskType'));
  const text = explicit || [get(o, '范围'), get(o, '说明'), get(o, '验收标准')].map(str).join(' ');
  // 脚本优先（能写成脚本的就不用模型），再看重活，最后看便宜活
  for (const k of ['script', 'heavy', 'cheap']) { const m = MODEL_TABLE.find((x) => x.kind === k); if (m.re.test(text)) return { kind: k, label: m.label, defaultModel: m.model, from: explicit ? '活的类型' : '范围/说明里的字' }; }
  return { kind: null, label: '看不出是哪类活', defaultModel: null, from: null };
}

function failCount(o) {
  const n = Number(get(o, '前面失败次数', '失败次数'));
  if (Number.isFinite(n) && n > 0) return n;
  const m = /失败(?:了)?\s*(\d+)\s*次/.exec(str(get(o, '选它的理由', '模型理由')) + ' ' + str(get(o, '前面失败记录')));
  return m ? Number(m[1]) : 0;
}

// 返回 { level: 'red'|'amber'|'ok', canSend, msgs[], task, model, reason, suggested }
export function checkOrder(o) {
  const model = str(get(o, '模型', 'model')).trim();
  const reason = str(get(o, '选它的理由', '模型理由', 'modelReason')).trim();
  const task = classifyTask(o);
  const msgs = []; let level = 'ok';
  if (!model || !reason) { level = 'red'; msgs.push(`「${!model && !reason ? '模型」和「选它的理由' : !model ? '模型' : '选它的理由'}」空着，不许派出去`); }
  const isFable = /fable/i.test(model), isOpus = /opus/i.test(model);
  if (isFable) {
    const n = failCount(o); const which = str(get(o, '前面失败记录', '失败记录')).trim();
    if (n < 2 || !which) { if (level !== 'red') level = 'amber'; msgs.push(`选了 Fable 5.2，但单上${n < 2 ? `只写了失败 ${n} 次（要同一个问题修了两次还不行）` : ''}${!which ? '没写「前面失败记录」（各是哪次）' : ''}；别的情况一律不能选 Fable 5.2`); }
  } else if (isOpus && task.kind !== 'heavy') {
    if (level !== 'red') level = 'amber';
    msgs.push(task.kind ? `选了 Opus，但这是「${task.label}」，按分配表应该用：${task.defaultModel}` : '选了 Opus，但从单上看不出是写剧本/分镜/提示词/审片裁决/改代码/修问题/开发这类活（可加「活的类型」栏写明）');
  }
  return { level, canSend: level !== 'red', msgs, task, model: model || null, reason: reason || null, suggested: task.defaultModel };
}

// ---------- 拍板规则（总导 2026-11-23 17:22 决定；交接清单 md5 275ADA78 第二、五节）----------
export const GATE_MD5 = 'ED8D5910611AD8FF25A58CA3AE4478F7'; // 门禁 md5：谁都不改，对不上就标红
export const DECISION_RULES = [
  { id: 'chain-tech', text: '卡链技术拍板（不挂上游直接正式启动、换链里写死的工具钉值、挂链顺序、从已放行的链复制只改镜单/路径/上游）→ 拍板人：指挥中心主会话；审查会话复审通过才放。放行记录缺 diff 和它的 md5、脚本 sha256、空跑日志 md5 任一项就标红「不许放」；不挂上游启动的三个前提（没有别的 gpu_ 链或等待器在跑、没有 STOP 文件、空跑通过）缺一项也标红。', check: '缺项标红「不许放」', source: '总导 2026-11-23 17:22（Andy 17:20「不要搞 我点头这些 你直接安排好」）' },
  { id: 'escalate-zongdao', text: '改动碰到 gpu_submit.py、提交函数、单一提交者检查、STOP 检查、等待循环、门禁 → 不归主会话，标红「报总导」。门禁 md5 ED8D5910 谁都不改。', check: '碰到就标红「报总导」', source: '总导 2026-11-23 17:22' },
  { id: 'ask-andy', text: '花钱（包括 2K 放大）、每集导出交付、改手册、改剧情 → 标红「直接问 Andy」。', check: '碰到就标红「直接问 Andy」', source: '总导 2026-11-23 17:22 转 Andy' },
];
const ESCALATE_RE = /gpu_submit\.py|提交函数|submit_?(job|shot)|单一提交者|single.?submitter|STOP\s*(检查|check)|等待循环|wait.?loop|门禁|gate|rulepack/i;
const ASK_ANDY_RE = /花钱|付费|充值|2K|放大|upscale|导出|交付|export|deliver|手册|剧情|plot/i;
const TECH_KINDS = { 'no-upstream': '不挂上游直接正式启动', pin: '换工具钉值', order: '挂链顺序', copy: '复制链只改镜单/路径/上游' };
// 放行记录要带的栏：kind、decider、reviewer、diffPath、diffMd5、scriptSha256、dryrunMd5、at
export const RELEASE_FIELDS = ['kind', 'decider', 'reviewer', 'diffPath', 'diffMd5', 'scriptSha256', 'dryrunMd5', 'at'];
export function checkRelease(r) {
  r = r || {}; const msgs = []; let level = 'ok';
  const red = (m) => { level = 'red'; msgs.push(m); };
  const blob = str([r.kind, r.note, r.changes, r.diffSummary, r.touches]);
  if (ESCALATE_RE.test(blob)) red('改动碰到提交逻辑/安全闸/门禁：报总导，主会话不能放');
  if (ASK_ANDY_RE.test(blob)) red('涉及花钱/导出交付/手册/剧情：直接问 Andy');
  if (r.gateMd5 && String(r.gateMd5).toUpperCase() !== GATE_MD5) red(`门禁 md5 对不上（${String(r.gateMd5).slice(0, 8)}，应为 ED8D5910）`);
  const miss = [];
  if (!r.diffPath || !/^[0-9A-Fa-f]{8,32}$/.test(String(r.diffMd5 || ''))) miss.push('diff 和它的 md5');
  if (!/^[0-9A-Fa-f]{64}$/.test(String(r.scriptSha256 || ''))) miss.push('脚本 sha256（64 位）');
  if (!/^[0-9A-Fa-f]{8,32}$/.test(String(r.dryrunMd5 || ''))) miss.push('空跑日志 md5');
  if (!r.decider) miss.push('decider（拍板人）'); if (!r.reviewer) miss.push('reviewer（复审）');
  if (miss.length) red('不许放：缺 ' + miss.join('、'));
  if (r.decider && r.reviewer && String(r.decider) === String(r.reviewer)) red('拍板人和复审是同一个，要审查会话另审');
  if (r.kind === 'no-upstream') { const p = r.preconditions || {}; const lack = [!p.noOtherChain && '没有别的 gpu_ 链或等待器在跑', !p.noStopFile && '没有 STOP 文件', !p.dryrunOk && '空跑通过'].filter(Boolean); if (lack.length) red('不挂上游启动的前提缺：' + lack.join('、')); }
  if (r.kind && !TECH_KINDS[r.kind] && level !== 'red') { level = 'amber'; msgs.push(`kind「${r.kind}」不在拍板类型里（${Object.keys(TECH_KINDS).join('/')}）`); }
  return { level, canRelease: level !== 'red', msgs, kindLabel: TECH_KINDS[r.kind] || r.kind || null };
}
