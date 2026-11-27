// 写稿类 Agent 的同时运行数（Andy 11-26「剧本和资产 你给 ic 工作流多开几个会话同步进行，别耽误 gpu」；总导定默认值）。
// 按类型各一个闸门、各自上限，存项目设置 projects.context.agent_limits；GPU 出第 N 章时，N+1、N+2 章的分镜、提示词并行写。
// 同一章的互斥另由 activeJobOfChapter 保证（剧本改写 和 分镜 / 提示词 不同时跑）；资产分析本项目一次一个（写共用的地点表、缺图单）。
import { Projects } from './db.js';

export const AGENT_LIMITS_KEY = 'agent_limits';
export const AGENT_LIMIT_KINDS = {
  script: { label: '剧本改写', def: 2 },
  storyboard: { label: '分镜（LLM 创作，只拆文本）', def: 3 },
  prompt: { label: '提示词撰写（含配乐）', def: 3 },
  asset: { label: '资产分析', def: 1 },
  review: { label: '资产审图', def: 3 },   // _MV 并行（总导 11-26）：B/C/D 三格同时审
};
export const AGENT_LIMIT_MAX = 8;

export function agentLimitsOf(projectId) {
  const raw = (((Projects.get(projectId) || {}).context || {})[AGENT_LIMITS_KEY]) || {};
  const out = {};
  for (const [k, v] of Object.entries(AGENT_LIMIT_KINDS)) {
    const n = Number(raw[k]);
    out[k] = Number.isFinite(n) && n >= 1 ? Math.min(AGENT_LIMIT_MAX, Math.floor(n)) : v.def;
  }
  return out;
}
export const agentLimit = (projectId, kind) => agentLimitsOf(projectId)[kind] || 1;

/** 校验并规整界面交来的上限（只收认识的类型，1–8 的整数）。 */
export function normalizeAgentLimits(input) {
  const out = {}; const bad = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (!AGENT_LIMIT_KINDS[k]) { bad.push(k); continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > AGENT_LIMIT_MAX) { bad.push(k); continue; }
    out[k] = n;
  }
  return { limits: out, bad };
}
