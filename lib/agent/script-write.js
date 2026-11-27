// 只写剧本任务（总导 11-26：Andy「V3 把我提到的问题都搞好，重新生成 1-5 章的剧本 资产」；IC 原来没有「只写剧本」的入口）。
// POST /api/projects/:id/chapters/:cid/script/rewrite { requirement? } 起一个 IC Agent 只重写本章剧本：
// 工具集 script-write = 读规则 + get_chapter（重写模式：先读完规则才给原著，旧剧本不给）+ set_chapter_script（只能写本章、照样存盘自检）。
// 一章一个任务（一章一个回合）；不拆分镜、不出片、不占 GPU；走写稿文本队列。
import { Jobs, Chapters, logger, loadConfig } from '../core/index.js';
import { activeJobOfChapter, isAborted, markProjectRunning, settleProject, runJobTask } from './job-runner.js';
import { runExternalAgent } from './external/index.js';
import { promptWriteAgentId, promptWriteLane } from './prompt-write.js';

export const SCRIPT_WRITE_JOB_TYPE = 'script-write';
export const SCRIPT_WRITE_TOOLSET = 'script-write';
export const SCRIPT_WRITE_TOOLS = new Set(['skill', 'skill_lines', 'skill_reference', 'get_project', 'get_chapter', 'set_chapter_script', 'list_assets', 'report', 'report_rule_gap']);

export function scriptWriteToolDefinitions(allDefs) {
  return [...(allDefs || []).filter((t) => SCRIPT_WRITE_TOOLS.has(t.function.name)), ...SCRIPT_WRITE_EXTRA_DEFS];
}

/** MCP 子进程里的写前检查：只能写本任务这一章，强制 overwrite。 */
export function guardScriptWrite(ctx, name, args) {
  if (name !== 'set_chapter_script') return args;
  const want = String(ctx.chapter || '');
  const got = String((args && args.chapter) || '').trim();
  if (got && got !== want) {
    const ch = Chapters.list(ctx.projectId).find((c) => c.title === want);
    if (!ch || got !== ch.id) throw new Error('本任务只能重写「' + want + '」的剧本，不能写「' + got + '」');
  }
  return { ...(args || {}), chapter: want, overwrite: true };
}

// 资产分析写的地点表、戏份说明（人物服装、道具、地点）是剧本场头锁定的依据：只读
export const SCRIPT_WRITE_EXTRA = new Set(['get_locations', 'list_scene_notes', 'get_scene_note']);
export const SCRIPT_WRITE_EXTRA_DEFS = [
  { type: 'function', function: { name: 'get_locations', description: '读本项目地点表（场头锁定的「地点」只用表里的地点名）。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_scene_notes', description: '列出本项目的戏份说明（key、字数）：人物服装、道具、地点的锁定写在这里。', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_scene_note', description: '读一份戏份说明（key 如「某人·服装」或地点 ID）。服装颜色款式、人数照这里写。', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
];

export function buildScriptWriteAgentPrompt({ project, chapter, requirement }) {
  const title = String(chapter || '');
  return [
    '【IC「只写剧本」任务】给项目「' + ((project && project.name) || '') + '」重写「' + title + '」的剧本，按 adapt-rules 的剧本规则（R-004～R-008）写，保存。只写剧本：不拆分镜、不写提示词、不出图出片。',
    '【外部 Agent 运行时】领域工具由本地 MCP 服务 ic 提供，工具名可能带 mcp__ic__ / ic__ / mcp_ic_ 等前缀，按同名工具调用即可。禁止使用你自身的 shell / 文件读写 / 联网 / 子代理工具，不读项目外的任何文件。',
    ...(requirement ? ['【这次的要求】' + String(requirement).trim()] : []),
    '步骤：',
    '1. 读规则：skill(name="adapt-rules")、skill(name="sd-storyboard-engine")；skill_reference(name="adapt-rules", ref="叙述转换方法.md")；skill_reference(name="adapt-rules", ref="剧本样稿.md")；项目开了表现开关时，按地图用 skill_lines 读 adapt-rules 的 H2 分册。没读完 get_chapter 不给原著正文。',
    '2. get_chapter(chapter="' + title + '") 读本章原著（重写模式下不给本章旧剧本，按原著从头写）；get_locations 读地点表，场头锁定的「地点」只用表里的地点名；list_scene_notes 后用 get_scene_note 读本章出场人物的服装说明和本章地点的戏份说明——服装颜色款式照服装说明原文抄，不自己另编。',
    '2b. 跨章接续（R-006 第6条）：用 get_chapter 读上一章的剧本（别的章照常给剧本），本章第一场的地点、人数、服装、站位和上一章末场逐项比对，照抄接上；上一章还没剧本时才按原著推定，并在跨章接续里写明。',
    '3. 照剧本组成顺序写：节拍表 → 叙述转换表 → 各场（场头锁定 / [画面：] / 台词 / 心声 / 【表演说明：…】）→ 每场结尾【衔接→…】、末场【衔接→下一章】。',
    '4. set_chapter_script(chapter="' + title + '", script) 保存（会自动覆盖旧剧本）。保存后看返回的自检提示，按 R 段逐条改好再存，直到没有该改的问题。',
    '5. 最后几句话总结：几场、多少字、自检还剩哪些提示（为什么保留）。',
    '硬性要求：只写「' + title + '」这一章；原著每个情节点、每句引号台词都要落到画面、台词或心声里，不压缩；不要中途停下来提问。',
  ].join('\n');
}

/** @returns {{ job, lane:string }} */
export function submitScriptWriteJob({ projectId, chapter, requirement, onProgress, runAgentFn = runExternalAgent }) {
  const title = String((chapter && chapter.title) || '');
  if (!title) throw Object.assign(new Error('缺少章节'), { code: 'CHAPTER_REQUIRED' });
  if (!String(chapter.novel || '').trim()) throw Object.assign(new Error('「' + title + '」没有原著正文，写不了剧本'), { code: 'NO_NOVEL' });
  const req = requirement == null ? '' : String(requirement);
  if (req.length > 4000) throw Object.assign(new Error('requirement 不能超过 4000 字'), { code: 'BAD_REQUIREMENT' });
  const busy = activeJobOfChapter(projectId, title);
  if (busy) throw Object.assign(new Error('「' + title + '」已有任务在跑或排队，请等它结束再重写剧本'), { code: 'CHAPTER_BUSY', job: busy });
  const cfg = loadConfig();
  const agentId = promptWriteAgentId(cfg);
  if (!agentId) throw Object.assign(new Error('只写剧本只支持外部 Agent 运行时（设置 → Agent 运行时）'), { code: 'NO_AGENT' });
  const lane = promptWriteLane(cfg);
  const job = Jobs.create({ projectId, type: SCRIPT_WRITE_JOB_TYPE, checkpoint: { subject: title, chapter: title, scriptWrite: true, queue: lane.lane, writer: 'agent:' + agentId, ...(req.trim() ? { requirement: req.trim() } : {}) } });
  markProjectRunning(projectId);
  const emit = (patch) => { if (onProgress) onProgress({ jobId: job.id, projectId, type: job.type, chapter: title, ...patch }); };
  const aborted = isAborted(job.id);
  const before = String(chapter.script || '');
  const task = async () => {
    let agentErr = null;
    try {
      await runAgentFn({ projectId, chapter: title, jobId: job.id, agentId, scriptWrite: true, scriptRequirement: req.trim(), renderDisabled: true, isAborted: aborted,
        onProgress: (patch) => { Jobs.update(job.id, { phase: patch.phase || undefined, detail: patch.detail || undefined }); emit(patch); } });
    } catch (e) { agentErr = e; }
    if (aborted()) return '已取消';
    const now = (Chapters.list(projectId).find((c) => c.title === title) || {}).script || '';
    const summary = '「' + title + '」剧本' + (now !== before ? '已重写（' + now.length + ' 字，原 ' + before.length + ' 字）' : '没有变化') + (agentErr ? '；Agent 报错：' + (agentErr.message || String(agentErr)) : '');
    if (now === before) throw new Error(summary + '；没有写入新剧本');
    return summary;
  };
  const onQueue = (st) => { const phase = st === 'queued' ? '排队中' : '准备'; Jobs.update(job.id, { status: st, phase, detail: '' }); emit({ phase, status: st }); };
  runJobTask(task, aborted, { jobId: job.id, onQueue, lane: lane.lane === 'text' ? 'write' : lane.lane })
    .then((summary) => {
      const cancelled = aborted(); settleProject(projectId, job.id, true);
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'done', phase: cancelled ? '已取消' : '完成', detail: String(summary || '').slice(0, 2000), error: cancelled ? '已取消' : '', finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '完成', detail: summary, status: cancelled ? 'cancelled' : 'done' });
    })
    .catch((e) => {
      const cancelled = aborted(); settleProject(projectId, job.id, false);
      const detail = cancelled ? '已取消' : (e && e.message ? e.message : String(e));
      Jobs.update(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '失败', error: detail, finishedAt: Date.now() });
      emit({ phase: cancelled ? '已取消' : '失败', detail, status: cancelled ? 'cancelled' : 'failed' });
      if (!cancelled) logger.error('job: 只写剧本失败', { projectId, chapter: title, error: e && e.message });
    });
  return { job, lane: lane.lane };
}
