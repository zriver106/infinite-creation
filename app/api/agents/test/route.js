import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/core/index.js';
import { findAgentDef, customAgentDef, resolveBin, probeVersion } from '@/lib/agent/external/index.js';
import { brainChat, brainPlan, agentSupportsChat } from '@/lib/agent/brain.js';

// body.ping=true（ic28）：用界面当前（未保存）的 Agent 大脑设置真的问一句，验证「剧本/提示词改写」这类
// 文本调用走得通；会消耗一次极短的模型调用。不带 ping 时与以前一样只查可执行文件。
async function pingBrain(cfg, body) {
  const merged = {
    ...cfg,
    agent: { ...(cfg.agent || {}), ...(body.agent || {}), ...(body.agentId ? { runtime: body.agentId } : {}), ...(body.custom ? { custom: body.custom } : {}) },
    llm: { ...(cfg.llm || {}), ...(body.llm || {}) },
  };
  // 前端在公开模式拿到的 apiKey 是空串：空串不覆盖已保存的 key
  if (body.llm && !body.llm.apiKey && cfg.llm?.apiKey) merged.llm.apiKey = cfg.llm.apiKey;
  const plan = brainPlan(merged);
  const started = Date.now();
  try {
    const r = await brainChat(merged, [
      { role: 'system', content: '连通性测试。' },
      { role: 'user', content: '只回复两个字母：OK' },
    ], { temperature: 0, maxTokens: 16, timeoutMs: 120000 });
    return { ok: true, via: r.via, content: String(r.content || '').slice(0, 80), secs: Math.round((Date.now() - started) / 1000), plan, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason.slice(0, 300) } : {}) };
  } catch (e) {
    return { ok: false, error: e.message, plan, secs: Math.round((Date.now() - started) / 1000) };
  }
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const cfg = loadConfig();
  const id = String(body.agentId || cfg.agent?.runtime || 'openclaude');
  if (body.ping) return NextResponse.json(await pingBrain(cfg, body));
  if (id === 'openclaude') return NextResponse.json({ ok: true, builtin: true, version: null });

  const def = id === 'custom' ? customAgentDef(body.custom || cfg.agent?.custom || {}) : findAgentDef(id);
  if (!def) return NextResponse.json({ error: '未知 Agent：' + id }, { status: 400 });
  if (!def.bin) return NextResponse.json({ ok: false, error: '未填写可执行文件' });

  const path = await resolveBin(def, cfg.agent?.extraPath || '');
  if (!path) return NextResponse.json({ ok: false, error: '未找到可执行文件：' + def.bin });
  const version = await probeVersion(path, def.versionArgs, cfg.agent?.extraPath || '');
  return NextResponse.json({ ok: true, path, version, textChat: agentSupportsChat(def) });
}
