// 每镜来源审计（主会话 seq2227；Andy 11-26「查看下我们修复的bug 有多少ic文档没用上」「1–31 章 都要排查一次」）。
// 只读：按章列出每镜 video_prompt / visual 现值是谁写的、写时的规则书版本，标出「规则版本落后 / 外部 PATCH 写的 / 旧流程写的」。
// 依据：change_logs（每次写入的整行快照 + source + meta）；meta 里没有版本时（本功能上线前的写入），
// 用 <项目>/rule_usage.jsonl 里同一镜、时间相差 ≤5 秒的 save_ack 补版本。
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { Shots } from './db.js';
import { projectDir } from './config.js';
import { loadRuleIndex } from './rule-book.js';

const H3 = 'h3-prompt-writing';
const ADAPT = 'adapt-rules';
const ACK_WINDOW_MS = 5000;

/** 写入来源归类：ic_write = IC 写稿任务；external_patch = 外部直接 PATCH / 建镜；legacy_agent = 旧流程 Agent（分镜生成、update_shot 等）；other。 */
export function classifyWriteSource(source) {
  const s = String(source || '');
  if (s === 'agent:save_shot_video_prompt' || s === 'agent:save_shot_visual' || /move-dialogue$/.test(s)) return 'ic_write';
  if (/^(PATCH|POST|PUT) \/api\/projects\/:id\/shots/.test(s) || s === 'PUT /api/projects/:id/chapters/:cid/storyboard') return 'external_patch';
  if (s.startsWith('agent:') || s.startsWith('job:')) return 'legacy_agent';
  if (s === 'rollback') return 'rollback';
  return 'other';
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function readAcks(projectId) {
  const out = [];
  try {
    const f = path.join(projectDir(projectId), 'rule_usage.jsonl');
    if (!fs.existsSync(f)) return out;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.tool === 'save_ack' && r.shot_id && r.version) out.push({ ts: Number(r.ts) || 0, shot_id: r.shot_id, version: r.version, skill: r.skill || H3 }); } catch {}
    }
  } catch {}
  return out;
}

/** 规则书版本先后：按项目里各版本第一次出现的时间排（rule_usage 里的 save_ack），当前版本排最后。 */
function versionOrder(acks, current) {
  const first = new Map();
  for (const a of acks) if (!first.has(a.version) || first.get(a.version) > a.ts) first.set(a.version, a.ts);
  const list = [...first.entries()].sort((x, y) => x[1] - y[1]).map((x) => x[0]);
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function lastWriteOf(logs, field, cur) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    const a = parse(l.after); const b = parse(l.before);
    if (!a) continue;
    const av = a[field] == null ? '' : String(a[field]);
    const bv = b && b[field] != null ? String(b[field]) : '';
    if (l.action === 'create' ? av !== '' : av !== bv) {
      return { ts: Number(l.ts), source: l.source, meta: parse(l.meta) || {}, matches_current: av === cur };
    }
  }
  return null;
}

/**
 * @param {string} projectId
 * @param {{ chapter?: string, okFrom?: string, logsOf?: Function, acks?: any[], currentVersions?: {h3?:string, adapt?:string} }} [opt]
 * @returns {{ current_versions, chapters: [{ chapter, shots: [...], counts }] }}
 */
export function shotProvenance(projectId, opt = {}) {
  const shots = Shots.list(projectId).filter((s) => !opt.chapter || s.chapter === opt.chapter);
  const acks = opt.acks || readAcks(projectId);
  const cur = opt.currentVersions || { h3: (loadRuleIndex(H3) || {}).version || '', adapt: (loadRuleIndex(ADAPT) || {}).version || '' };
  const order = versionOrder(acks.filter((a) => a.skill === H3), cur.h3);
  // ok_from：这个版本及之后的 h3 版本都算不落后（规则书每次编辑都换版本号，排查时按「某条规则上线的版本」划线）
  const okFrom = String(opt.okFrom || '');
  const stmt = opt.logsOf ? null : getDb().prepare("SELECT ts, source, action, before, after, meta FROM change_logs WHERE entity = 'shot' AND entity_id = ? ORDER BY ts ASC");
  const logsOf = opt.logsOf || ((id) => stmt.all(id));
  const acksByShot = new Map();
  for (const a of acks) { if (!acksByShot.has(a.shot_id)) acksByShot.set(a.shot_id, []); acksByShot.get(a.shot_id).push(a); }

  const byCh = new Map();
  for (const s of shots) {
    const logs = logsOf(s.id);
    const row = { shot_id: s.id, idx: s.idx, status: s.status || '', flags: [] };
    for (const [field, skill, curV] of [['video_prompt', H3, cur.h3], ['visual', ADAPT, cur.adapt]]) {
      const val = s[field] == null ? '' : String(s[field]);
      if (!val) { row[field] = { empty: true }; continue; }
      const w = lastWriteOf(logs, field, val);
      if (!w) { row[field] = { kind: 'no_record' }; row.flags.push(field + ':no_record'); continue; }
      const kind = classifyWriteSource(w.source);
      let version = w.meta.rules_version || '';
      let versionFrom = version ? 'meta' : '';
      if (!version && field === 'video_prompt' && kind === 'ic_write') {
        const near = (acksByShot.get(s.id) || []).filter((a) => a.skill === skill && Math.abs(a.ts - w.ts) <= ACK_WINDOW_MS).sort((x, y) => Math.abs(x.ts - w.ts) - Math.abs(y.ts - w.ts))[0];
        if (near) { version = near.version; versionFrom = 'rule_usage'; }
      }
      const info = { kind, source: w.source, ts: w.ts, job_id: w.meta.job_id || '', rules_version: version, ...(versionFrom ? { version_from: versionFrom } : {}), ...(w.matches_current ? {} : { drift: true }) };
      if (version && curV && version !== curV && !(okFrom && field === 'video_prompt' && order.indexOf(version) >= order.indexOf(okFrom) && order.indexOf(okFrom) >= 0)) {
        info.behind = true;
        if (field === 'video_prompt') { const i = order.indexOf(version); if (i >= 0) info.versions_behind = order.length - 1 - i; }
      }
      row[field] = info;
      if (kind === 'external_patch') row.flags.push(field + ':external_patch');
      if (kind === 'legacy_agent') row.flags.push(field + ':legacy_agent');
      // visual 的版本本功能上线前没记过，不当问题报；video_prompt 是 IC 写的却查不到版本才报
      if (kind === 'ic_write' && !version && field === 'video_prompt') row.flags.push(field + ':no_version');
      if (info.behind) row.flags.push(field + ':rules_behind');
      if (info.drift) row.flags.push(field + ':drift');
    }
    if (!byCh.has(s.chapter)) byCh.set(s.chapter, []);
    byCh.get(s.chapter).push(row);
  }
  const chapters = [...byCh.entries()].map(([chapter, rows]) => {
    rows.sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
    const counts = {};
    for (const r of rows) for (const f of r.flags) counts[f] = (counts[f] || 0) + 1;
    return { chapter, total: rows.length, flagged: rows.filter((r) => r.flags.length).length, counts, shots: rows };
  });
  const num = (t) => { const m = /第(\d+)/.exec(t || ''); return m ? Number(m[1]) : 1e9; };
  chapters.sort((a, b) => num(a.chapter) - num(b.chapter));
  return { current_versions: cur, version_order: order, chapters };
}
