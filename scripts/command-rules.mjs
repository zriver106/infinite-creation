// 指挥系统的规则表（只显示和提醒：不自动改链、不改稿、不发单）
// 排序规则：越靠前越优先。派工规则：每张派工单必须写明模型和理由。

export const PRIORITY_RULES = [
  { id: 'gpu-ep1-10-first', top: true, text: 'GPU 优先级：第1–10集最先。链序里第1–10集的镜头一律排在最前。', check: '违反就标红', source: 'Andy 2026-11-23 16:58（经总导转达）' },
  { id: 'ep1-10-before-new', top: true, text: '第1–10集没做完之前不开新章。链序、写稿、审片都先排第1–10集。', check: '违反就标红', source: 'Andy 2026-11-23 16:57（经总导转达）；16:58 补充：第25章写稿和指挥系统照做，GPU 先做第1–10集' },
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
