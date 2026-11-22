// 界面级的按项目设置（存 projects.context 的扁平键，用 Projects.setContextKey 单键合并写入）。
// 本文件是纯函数、零依赖：单测可以直接 import，不会拉起数据库。
//
//   auto_next                  「自动生成下一章」（出片）开关，缺省 false
//   auto_next_until            「到第 __ 章为止」，缺省 13：刚完成的章号 >= 它就停
//   auto_next_storyboard       「自动生成下一章分镜」开关，缺省 false
//   auto_next_storyboard_until 同上，缺省 13
//   delivery_dir               交付目录（本机绝对路径），缺省空 = 不交付
//   delivery_enabled           交付「启用」勾选，缺省 true（「默认勾上」）
//   post_settings              成片后期设置（ic32），缺省见 post-production.js POST_DEFAULTS
//
// 这些键只给界面和后端调度用，不是创作上下文：get_project 交给 Agent 之前要剔掉
// （stripUiContextKeys，见 lib/agent/tools.js hGetProject），交付目录是本机路径，不能进模型输入。

export const AUTO_NEXT_KEY = 'auto_next';
export const AUTO_NEXT_UNTIL_KEY = 'auto_next_until';
export const AUTO_NEXT_STORYBOARD_KEY = 'auto_next_storyboard';
export const AUTO_NEXT_STORYBOARD_UNTIL_KEY = 'auto_next_storyboard_until';
export const DELIVERY_DIR_KEY = 'delivery_dir';
export const DELIVERY_ENABLED_KEY = 'delivery_enabled';
export const POST_STORYBOARD_JOBS_KEY = 'post_storyboard_jobs';
export const POST_SETTINGS_KEY = 'post_settings';  // ic32 成片后期设置（对象，见 post-production.js normalizePostOptions）  // 'none' = 分镜收尾不排出图/TTS，缺省 queue
export const AUTO_NEXT_UNTIL_DEFAULT = 13;
// 「到第 __ 章为止」的输入上限（V2 有 798 章，留足余量；只是防止填出离谱值）
export const AUTO_NEXT_UNTIL_MAX = 100000;

export const UI_CONTEXT_KEYS = Object.freeze([
  AUTO_NEXT_KEY,
  AUTO_NEXT_UNTIL_KEY,
  AUTO_NEXT_STORYBOARD_KEY,
  AUTO_NEXT_STORYBOARD_UNTIL_KEY,
  DELIVERY_DIR_KEY,
  DELIVERY_ENABLED_KEY,
  POST_STORYBOARD_JOBS_KEY,
  POST_SETTINGS_KEY,
]);

function untilOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= AUTO_NEXT_UNTIL_MAX ? n : AUTO_NEXT_UNTIL_DEFAULT;
}

export function readAutoNextSettings(project) {
  const c = (project && project.context) || {};
  return {
    video: { enabled: c[AUTO_NEXT_KEY] === true, until: untilOf(c[AUTO_NEXT_UNTIL_KEY]) },
    storyboard: { enabled: c[AUTO_NEXT_STORYBOARD_KEY] === true, until: untilOf(c[AUTO_NEXT_STORYBOARD_UNTIL_KEY]) },
  };
}

export function readDeliverySettings(project) {
  const c = (project && project.context) || {};
  return {
    dir: typeof c[DELIVERY_DIR_KEY] === 'string' ? c[DELIVERY_DIR_KEY].trim() : '',
    enabled: c[DELIVERY_ENABLED_KEY] !== false,
  };
}

// 交给 Agent 的 context 去掉界面键（返回新对象，不改原对象）
export function stripUiContextKeys(context) {
  const out = { ...(context || {}) };
  for (const k of UI_CONTEXT_KEYS) delete out[k];
  return out;
}

// 章号只认整个标题（去首尾空白后）严格是「第N章」，N 为不带前导 0 的正整数（允许「第 3 章」这种中间空格）。
// 「第2章_心声验证」「串音验证_3镜」一律返回 null：交付会跳过，自动续章会停——
// 否则实验章会把正片 EP2.mp4 覆盖掉，或让自动续章闯进实验章。
export function chapterNumberFromTitle(title) {
  const m = /^第\s*([1-9][0-9]*)\s*章$/.exec(String(title == null ? '' : title).trim());
  return m ? Number(m[1]) : null;
}

// 校验前端提交的 until 值：返回整数，或 null（非法）
export function parseUntilInput(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= AUTO_NEXT_UNTIL_MAX ? n : null;
}

// 分镜文本任务收尾要不要排资产图/音色。缺省 queue（原行为）；none = 只把缺图和缺音色写进报告，不入队。
export function readPostStoryboardJobs(project) {
  const c = (project && project.context) || {};
  return c[POST_STORYBOARD_JOBS_KEY] === 'none' ? 'none' : 'queue';
}
