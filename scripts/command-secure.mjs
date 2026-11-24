// 读取限制（Codex 试用、以及任何替模型取材料的地方都要过这里）
import path from 'node:path';
export const DENY_RULES = [
  { re: /[\\/]\.claude([\\/]|$)/i, why: 'C:\\Users\\usazr\\.claude\\ 目录' },
  { re: /[\\/]\.codex([\\/]|$)/i, why: '.codex 目录（含登录信息）' },
  { re: /\.credentials/i, why: '.credentials* 文件' },
  { re: /[\\/]local_secrets([\\/]|$)/i, why: 'local_secrets 目录（API 密钥）' },
  { re: /项目数据[\\/]封存/, why: 'P\\项目数据\\封存\\' },
  { re: /\.env$/i, why: '*.env 文件' },
  { re: /(^|[\\/])[^\\/]*(secret|token|auth|apikey|api_key|cookie)[^\\/]*$/i, why: '文件名像密钥/凭据' },
];
export function denyReason(p) {
  const full = path.resolve(String(p || ''));
  for (const r of DENY_RULES) if (r.re.test(full)) return r.why;
  return null;
}
