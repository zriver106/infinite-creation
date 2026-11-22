// 外部 Agent 子进程环境：不把内置 openclaude 的 provider 环境带给外部 CLI
// （它们应该用自己的登录态/模型配置）。runner.js（MCP 流水线）与 brain.js（纯文本调用）共用。
import { openaiCompatBaseUrl } from '../../core/llm.js';

export function externalAgentEnv(cfg, baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.CLAUDE_CODE_USE_OPENAI;
  delete env.OPENCLAUDE_MAX_ACTIVE_MESSAGES;
  delete env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP;
  if (env.OPENAI_BASE_URL && cfg?.llm?.baseUrl && env.OPENAI_BASE_URL === openaiCompatBaseUrl(cfg.llm.baseUrl)) {
    delete env.OPENAI_BASE_URL;
  }
  if (env.OPENAI_MODEL && cfg?.llm?.model && env.OPENAI_MODEL === cfg.llm.model) {
    delete env.OPENAI_MODEL;
  }
  if (env.OPENAI_API_KEY && cfg?.llm?.apiKey && env.OPENAI_API_KEY === cfg.llm.apiKey) {
    delete env.OPENAI_API_KEY;
  }
  return env;
}
