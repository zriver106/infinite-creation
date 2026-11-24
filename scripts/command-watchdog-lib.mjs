// 指挥系统看门狗：纯判断函数（无 I/O，可单测）。CLA-34，2026-11-23。
// 看门狗只读、只报警；从不提交 GPU、从不改链脚本、从不建/删 STOP 标记、从不杀进程。
import crypto from 'node:crypto';

export const TZ = 'America/Los_Angeles';
export const UNCERTAIN = new Set(['unknown', 'timeout_unknown', 'submitting', 'running']);
export const SESSION_PROC = /^(claude|codex|grok)[^\\/]*\.exe$/i;
export const SHELL_PROC = /^(powershell|pwsh|cmd|bash|sh|wsl|conhost|WindowsTerminal|OpenConsole)\.exe$/i;
export const DETACHED_PROC = /^(WmiPrvSE|svchost|services|wininit|explorer|taskeng|taskhostw)\.exe$/i;

// ---------- 时间（太平洋时间） ----------
export function ptParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
export function ptStr(d = new Date()) { const o = ptParts(d instanceof Date ? d : new Date(d)); return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}`; }
export function ptHM(d) { const o = ptParts(d instanceof Date ? d : new Date(d)); return `${o.hour}:${o.minute}`; }
// '2026-11-23T20:30' 当作太平洋时间 → Date
export function ptToDate(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = asUtc;
  for (let i = 0; i < 2; i++) { // 两次迭代收敛到正确的 UTC 偏移（含夏令时切换）
    const o = ptParts(new Date(t));
    const shown = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
    t += asUtc - shown;
  }
  return new Date(t);
}

// ---------- 链脚本解析 ----------
export function chainNameFromScript(base) { const m = String(base).match(/^gpu_(.+?)_chain(?:_[^.]*)?\.py$/i); return m ? m[1] : null; }
export function chapterNum(ch) {
  const m = String(ch).match(/第\s*(\d+)\s*章/); if (m) return +m[1];
  const n = String(ch).match(/^ch(\d+)/i); return n ? +n[1] : null;
}
export function parseChainScript(text, base) {
  const name = chainNameFromScript(base);
  const out = { name, script: base, plan: [], stopName: null, logDir: null, progDirs: {}, upstream: {}, defaultAfter: null, parsed: false };
  const pm = text.match(/^PLAN\s*=\s*\[([\s\S]*?)\]\s*$/m) || text.match(/^PLAN\s*=\s*\[([\s\S]*?\)\s*)\]/m);
  if (pm) {
    const re = /\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]\s*,\s*'([^']+)'\s*\)/g; let m;
    while ((m = re.exec(pm[1]))) out.plan.push({ chapter: m[1], ch: chapterNum(m[1]), ids: m[2].split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)), tag: m[3] });
  }
  const sm = text.match(/^STOPF\s*=\s*os\.path\.join\(\s*U\s*,\s*'([^']+)'\s*\)/m); if (sm) out.stopName = sm[1];
  const lm = text.match(/^LOGD\s*=.*?os\.path\.join\(\s*G\s*,\s*'([^']+)'\s*\)\s*$/m); if (lm) out.logDir = lm[1];
  const om = text.match(/os\.path\.join\(\s*G\s*,\s*'([^'%]*)%s([^']*)'\s*%\s*tag\s*\)/);
  for (const p of out.plan) out.progDirs[p.tag] = om ? om[1] + p.tag + om[2] : (name ? `${name}_${p.tag}` : null);
  const um = text.match(/^UPSTREAM\s*=\s*\{([\s\S]*?)\}\s*$/m);
  if (um) {
    const re = /'([^']+)'\s*:\s*\(\s*\d+\s*,\s*'([^']*)'\s*,\s*\[([^\]]*)\]\s*\)/g; let m;
    while ((m = re.exec(um[1]))) out.upstream[m[1]] = { logDir: m[2], progDirs: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]) };
  }
  const am = text.match(/startswith\('--after='\)\]\s*or\s*\['([^']+)'\]\)/); if (am) out.defaultAfter = am[1];
  out.parsed = out.plan.length > 0 && !!out.logDir;
  return out;
}

// ---------- 日志 ----------
export function lastLine(tail) { const ls = String(tail || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); return ls.length ? ls[ls.length - 1] : ''; }
export function stripTs(line) { return String(line).replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s+/, ''); }
export function lineTs(line) { const m = String(line).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/); return m ? m[1] : null; }
export function terminalOf(name, line) {
  const s = stripTs(line);
  // 链名在日志里可能比脚本名短（gpu_style6_a1_chain.py 写「style6 done」），所以认任意一个链名样的词
  if (s === `${name} done` || /^[\w.-]+ done$/.test(s)) return 'done';
  if (/^[\w.-]+ stopped \(/.test(s)) return 'stopped';
  return null;
}
export function isWaitingLine(line) { return /\bwaiting\b/i.test(stripTs(line)); }
// 最后一次启动行里的上游：'start (armed wait for rr678; …)' / 'start (no upstream wait)'
export function upstreamFromLog(name, text) {
  const re = new RegExp(`${escapeRe(name)} chain\\s+(?:start \\(armed wait for (\\w+)|start \\(no upstream wait\\)|DRY-RUN)`, 'g');
  let m, last;
  while ((m = re.exec(String(text)))) last = m;
  if (!last) return null;
  if (/DRY-RUN/.test(last[0])) return null;
  return last[1] || 'none';
}
export function afterFromCmd(cl) { const m = String(cl || '').match(/--after=(\S+)/); return m ? m[1].replace(/["']$/, '') : null; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- 进程 ----------
export function scriptInCmd(cl, script) {
  return new RegExp(`(^|[\\s"'\\\\/])${escapeRe(script)}(["'\\s]|$)`, 'i').test(String(cl || ''));
}
export function chainProcs(procs, script) { return procs.filter((p) => /python/i.test(p.name) && scriptInCmd(p.cmd, script)); }
export function anyChainOrSubmit(procs, exceptScript) {
  return procs.filter((p) => /python/i.test(p.name) && /gpu_[^\s"']*chain[^\s"']*\.py|gpu_submit\.py/i.test(p.cmd || '') && !(exceptScript && scriptInCmd(p.cmd, exceptScript)));
}
// 父进程链：一直往上找；遇到会话进程（claude/codex/grok）→ 挂在会话下
export function ancestry(procs, pid, maxDepth = 12) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = []; let cur = byPid.get(pid);
  for (let i = 0; cur && i < maxDepth; i++) {
    const par = byPid.get(cur.ppid);
    if (!par || par.pid === cur.pid) break;
    if (par.created && cur.created && new Date(par.created) > new Date(cur.created)) break; // pid 复用
    chain.push(par); cur = par;
  }
  return chain;
}
export function underSession(procs, pid) {
  const anc = ancestry(procs, pid);
  for (const a of anc) {
    if (DETACHED_PROC.test(a.name)) return null;
    if (SESSION_PROC.test(a.name) || (/^node\.exe$/i.test(a.name) && /claude|codex|grok/i.test(a.cmd || ''))) return { session: a, path: anc.slice(0, anc.indexOf(a) + 1).map((x) => `${x.name}(${x.pid})`) };
  }
  return null;
}

// ---------- 镜头状态 ----------
// prog: { tag: progress.json 对象或 null }
export function shotSummary(chain, prog) {
  const r = { total: 0, unsubmitted: [], uncertain: [], done: 0, byChapter: [] };
  for (const p of chain.plan) {
    const pj = prog[p.tag];
    const st = new Map(); for (const s of (pj?.shots || [])) st.set(s['镜序'], s.status);
    for (const k of p.ids) {
      r.total++;
      const s = st.get(k);
      if (!pj || s === undefined || s === 'pending') r.unsubmitted.push(`${p.chapter}#${k}`);
      else if (UNCERTAIN.has(s)) r.uncertain.push(`${p.chapter}#${k}:${s}`);
      else r.done++;
    }
    if (pj && pj.status && UNCERTAIN.has(pj.status) === false && pj.status === 'running') { /* chapter running：上面按镜判断 */ }
  }
  return r;
}

// chain view: { name, script, parsed, alive:[pid], logExists, logMtimeMs, last, upstream, upstreamState, terminal, shots, md5, recent, prepared }
export function chainState(c) {
  if (c.alive.length) return isWaitingLine(c.last) ? 'waiting' : 'running';
  if (!c.logExists) return 'prepared';
  if (c.terminal === 'done') return 'done';
  if (c.terminal === 'stopped') return 'stopped';
  return 'dead';
}

// ---------- 告警评估（一轮） ----------
// 输入 snap：{ now(ms), cfg, gpu:{ok,running:[],pending:[],error}, gpuEmptySinceMs, chains:[view], procs:[], sessions:{long:[], errors:[]}, deadlines:[{id,name,at,done}], gateFlag:bool, queueChapters:[{prompt_id, chapter|null, src}] }
export function evaluate(snap) {
  const { cfg } = snap; const now = snap.now; const out = [];
  const add = (key, level, check, title, text, sigObj) => out.push({ key, level, check, title, text, sig: sig(sigObj ?? { level, text }) });
  const live = snap.chains.filter((c) => !c.ignored);
  const byName = new Map(snap.chains.map((c) => [c.name, c]));

  // 1. GPU 空闲但还有未提交镜头
  if (!snap.gpu.ok) add('gpu_queue_unreachable', 'WARN', 1, '读不到 8189 队列', `GET 8189 /queue 失败：${snap.gpu.error || ''}`, { e: 'unreach' });
  else if (!snap.gpu.running.length && !snap.gpu.pending.length && snap.gpuEmptySinceMs != null) {
    const idleSec = Math.round((now - snap.gpuEmptySinceMs) / 1000);
    const pend = live.filter((c) => ['running', 'waiting', 'dead'].includes(c.state) && c.shots && c.shots.unsubmitted.length);
    if (idleSec >= cfg.gpuIdleGraceSec && pend.length) {
      add('gpu_idle', 'ERROR', 1, 'GPU 空着，但链计划里还有没提交的镜头',
        `8189 队列已空约 ${Math.round(idleSec / 60)} 分钟（宽限 ${cfg.gpuIdleGraceSec} 秒）。还有没提交的：` + pend.map((c) => `${c.name}（${stateZh(c.state)}，${c.shots.unsubmitted.length} 镜：${c.shots.unsubmitted.slice(0, 6).join('、')}${c.shots.unsubmitted.length > 6 ? '…' : ''}）`).join('；'),
        { chains: pend.map((c) => [c.name, c.state, c.shots.unsubmitted.length]) });
    }
  }

  for (const c of live) {
    const ageMin = c.logMtimeMs ? (now - c.logMtimeMs) / 60000 : null;
    const up = c.upstream && c.upstream !== 'none' ? byName.get(c.upstream) : null;
    // 3. 交接断：上游 done、下游没在跑、下游还有未提交
    if (c.state === 'dead' && c.upstream && c.upstream !== 'none' && up && up.state === 'done' && !up.alive.length && c.shots && c.shots.unsubmitted.length) {
      add(`handoff_broken:${c.name}`, 'ERROR', 3, `链交接断了：${c.upstream} 已出完，${c.name} 没在跑`,
        `${c.upstream} 已结束（最后一行「${trim(stripTs(up.last), 80)}」，${lineTs(up.last) ? ptHM(new Date(lineTs(up.last))) : ''}），下游 ${c.name} 进程不在，日志最后一行「${trim(stripTs(c.last), 100)}」，计划里还有 ${c.shots.unsubmitted.length} 镜没提交。`,
        { up: c.upstream, last: c.last, n: c.shots.unsubmitted.length });
      continue;
    }
    // 2. 链进程没了 / 日志太久没更新
    if (c.state === 'dead' && c.recent) {
      add(`chain_gone:${c.name}`, 'ERROR', 2, `链 ${c.name} 的进程没了`,
        `进程表里没有 ${c.script}，日志最后一行不是 done/stopped：「${trim(stripTs(c.last), 120)}」（${ageMin != null ? Math.round(ageMin) + ' 分钟前' : ''}）。${c.shots ? `未提交 ${c.shots.unsubmitted.length} 镜，状态不明 ${c.shots.uncertain.length} 镜。` : ''}`,
        { last: c.last, unc: c.shots?.uncertain?.length || 0 });
    }
    if (c.state === 'running' && ageMin != null && ageMin > cfg.chainStaleMin) {
      add(`chain_stale:${c.name}`, 'WARN', 2, `链 ${c.name} 日志 ${Math.round(ageMin)} 分钟没更新`, `进程在（PID ${c.alive.join(',')}），但 chain.log 超过 ${cfg.chainStaleMin} 分钟没写（一个镜头最长 45 分钟）。最后一行「${trim(stripTs(c.last), 120)}」`, { last: c.last });
    }
    if (c.state === 'waiting' && ageMin != null && ageMin > cfg.chainWaitStaleMin) {
      const upAlive = up ? up.alive.length > 0 : false;
      if (!upAlive) add(`chain_wait_stuck:${c.name}`, 'ERROR', 2, `链 ${c.name} 在等上游，但上游没在跑`, `最后一行是等待（${Math.round(ageMin)} 分钟前）：「${trim(stripTs(c.last), 120)}」，上游 ${c.upstream || '（不明）'} 进程不在。`, { last: c.last, up: c.upstream });
    }
    if (c.state === 'dead' && c.shots && c.shots.uncertain.length) {
      add(`chain_uncertain:${c.name}`, 'ERROR', 2, `链 ${c.name} 有状态不明的镜头`, `进程不在，progress.json 里有 ${c.shots.uncertain.join('、')}。状态不明的不要重复提交，需要人核对。`, { u: c.shots.uncertain });
    }
    // 7. 挂在会话下面
    for (const pid of c.alive) {
      const u = underSession(snap.procs, pid);
      if (u) add(`chain_under_session:${c.name}:${pid}`, 'WARN', 7, `链 ${c.name} 挂在会话进程下面`, `PID ${pid} 的父进程链：${u.path.join(' ← ')}。会话一结束它就会被一起杀掉（今晚 rr678b 就是这样死的）。应当用 WMI Win32_Process Create 或独立启动器起链。`, { s: u.session.pid });
    }
  }

  // 4. 写稿会话
  for (const s of snap.sessions?.long || []) add(`session_long:${s.pid}`, 'WARN', 4, `claude -p 会话已跑 ${Math.round(s.min)} 分钟`, `PID ${s.pid}（${s.created ? ptHM(new Date(s.created)) : ''} 起，阈值 ${cfg.sessionLongMin} 分钟）：${trim(s.cmd, 160)}`, { pid: s.pid });
  for (const e of snap.sessions?.errors || []) add(`session_error:${e.file}`, 'ERROR', 4, `写稿会话输出里有错误`, `${e.file}：${trim(e.what, 240)}`, { w: e.what });

  // 5. 截止时间
  for (const d of snap.deadlines || []) {
    const at = ptToDate(d.at); if (!at || d.done) continue;
    const left = (at.getTime() - now) / 60000;
    let stage = null;
    if (left <= 0) stage = 'over'; else if (left <= 10) stage = 't10'; else if (left <= 30) stage = 't30';
    if (!stage) continue;
    const lv = stage === 'over' ? 'ERROR' : 'WARN';
    const txt = stage === 'over' ? `「${d.name}」截止 ${ptHM(at)} 已过，还没标记完成。` : `「${d.name}」${ptHM(at)} 截止，还剩不到 ${stage === 't10' ? 10 : 30} 分钟，还没标记完成。`;
    add(`deadline:${d.id}`, lv, 5, stage === 'over' ? `过点：${d.name}` : `快到点：${d.name}`, txt, { stage });
  }

  // 6. 第1–10集闸门
  if (!snap.gateFlag) {
    const max = cfg.gateMaxChapter;
    for (const q of snap.queueChapters || []) {
      if (q.chapter != null && q.chapter > max) add(`gate_queue:${q.prompt_id}`, 'ERROR', 6, `第1–10集没做完，GPU 里在出第${q.chapter}章`, `8189 队列${q.where === 'pending' ? '等待' : '正在跑'}的任务 ${q.prompt_id.slice(0, 8)} 对应第${q.chapter}章（来源：${q.src}）。只报警，不取消。`, { ch: q.chapter });
    }
    for (const c of snap.chains) {
      if (!['running', 'waiting', 'prepared'].includes(c.state)) continue;
      if (c.state === 'prepared' && !(c.scriptMtimeMs && now - c.scriptMtimeMs < (cfg.preparedHours ?? 2) * 3600000)) continue;
      const hi = (c.plan || []).filter((p) => p.ch != null && p.ch > max);
      if (!hi.length) continue;
      const lv = c.state === 'prepared' ? 'WARN' : 'ERROR';
      add(`gate_chain:${c.name}`, lv, 6, `第1–10集没做完，链 ${c.name} 计划里有第11章以后`, `${c.name}（${stateZh(c.state)}）计划含 ${hi.map((p) => p.chapter).join('、')}。闸门标记文件不存在 = 闸门生效。只报警，不杀不取消。`, { st: c.state, hi: hi.map((p) => p.ch) });
    }
  }
  return out;
}
export function stateZh(s) { return ({ running: '在跑', waiting: '在等上游', dead: '进程没了', done: '已完成', stopped: '已停', prepared: '已准备未启动' })[s] || s; }
function trim(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }
export function sig(o) { return crypto.createHash('md5').update(JSON.stringify(o)).digest('hex').slice(0, 12); }

// ---------- 去重：只在 新出现 / 内容变化 / 已解决 时产生事件 ----------
// state.alerts: { key: {level,check,title,text,sig,since,lastSeen,missing} }
export function diffAlerts(state, found, nowIso, resolveAfter = 3) {
  const events = []; const seen = new Set();
  state.alerts = state.alerts || {};
  for (const a of found) {
    seen.add(a.key);
    const cur = state.alerts[a.key];
    if (!cur) { state.alerts[a.key] = { ...a, since: nowIso, lastSeen: nowIso, missing: 0 }; events.push({ type: 'new', ...a, at: nowIso }); }
    else if (cur.sig !== a.sig || cur.level !== a.level) { Object.assign(cur, a, { lastSeen: nowIso, missing: 0 }); events.push({ type: 'changed', ...a, at: nowIso }); }
    else { cur.lastSeen = nowIso; cur.missing = 0; cur.text = a.text; } // 文字里的分钟数可以刷新，但不推送
  }
  for (const k of Object.keys(state.alerts)) {
    if (seen.has(k)) continue;
    const cur = state.alerts[k]; cur.missing = (cur.missing || 0) + 1;
    if (cur.missing >= resolveAfter) { events.push({ type: 'resolved', key: k, level: cur.level, check: cur.check, title: cur.title, text: cur.text, at: nowIso }); delete state.alerts[k]; }
  }
  return events;
}

// ---------- 自动恢复判断（只按已有规矩） ----------
// 返回 { ok, reasons:[未满足的条件], cmd }
export function recoveryDecision({ c, up, cfg, procs, gpu, gpuIdleSec, stopExists, upProgUncertain, history, now, M, python }) {
  const reasons = [];
  const wl = (cfg.recovery?.whitelist || []).find((w) => w.script.toLowerCase() === String(c.script).toLowerCase());
  if (!wl) reasons.push('脚本不在白名单');
  else if (String(c.md5).toUpperCase() !== String(wl.md5).toUpperCase()) reasons.push(`脚本 md5 ${c.md5} 与白名单 ${wl.md5} 不符`);
  if (c.upstream == null) reasons.push('上游不明');
  else if (c.upstream !== 'none') {
    if (!up) reasons.push(`找不到上游 ${c.upstream} 的日志`);
    else {
      if (up.alive.length) reasons.push(`上游 ${c.upstream} 进程还在`);
      if (stripTs(up.last) !== `${c.upstream} done`) reasons.push(`上游最后一行不是「${c.upstream} done」`);
      if (upProgUncertain && upProgUncertain.length) reasons.push(`上游 progress 有状态不明：${upProgUncertain.join('、')}`);
    }
  }
  if (c.alive.length) reasons.push('自己的进程还在');
  if (c.terminal) reasons.push(`自己的日志最后一行是 ${c.terminal}（人为或规则停下，不重启）`);
  if (!c.shots) reasons.push('读不到自己的 progress');
  else {
    if (c.shots.uncertain.length) reasons.push(`自己有状态不明的镜头：${c.shots.uncertain.join('、')}`);
    if (!c.shots.unsubmitted.length) reasons.push('没有未提交的镜头');
  }
  const others = anyChainOrSubmit(procs, null);
  if (others.length) reasons.push(`还有别的提交者活着：${others.map((p) => p.pid).join(',')}`);
  if (!gpu.ok) reasons.push('8189 队列读不到');
  else if (gpu.running.length || gpu.pending.length) reasons.push('8189 队列不空');
  else if (gpuIdleSec < cfg.gpuIdleGraceSec) reasons.push(`8189 空闲才 ${gpuIdleSec} 秒（< ${cfg.gpuIdleGraceSec}）`);
  if (stopExists) reasons.push('STOP 标记存在');
  const hist = (history || []).filter((h) => h.chain === c.name && h.live);
  if (hist.some((h) => now - Date.parse(h.at) < 30 * 60000)) reasons.push('30 分钟内已自动重启过');
  if (hist.filter((h) => now - Date.parse(h.at) < 12 * 3600000).length >= 2) reasons.push('今晚已自动重启 2 次');
  const U = `${M}\\_`;
  const outDir = wl?.outDir || `${U}\\rr678b_release`;
  const tsx = ptStr(new Date(now)).replace(/[-: ]/g, '').slice(0, 12);
  const so = `${outDir}\\run_stdout_${c.name}_wd${tsx}.txt`; const se = `${outDir}\\run_stderr_${c.name}_wd${tsx}.txt`;
  const cmd = `cmd /c "cd /d ${U} && "${python}" -X utf8 -u ${c.script} --after=none 1> "${so}" 2> "${se}""`;
  return { ok: reasons.length === 0, reasons, cmd, cwd: U, live: !!(wl && wl.live && cfg.recovery?.mode === 'live') };
}

// ---------- 写稿会话输出里的错误 ----------
export function scanOutputTail(name, tail) {
  const hits = [];
  const isErrFile = /(err|stderr)/i.test(name);
  for (const raw of String(tail).split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line[0] === '{') {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && (o.type === 'result' || (o.type == null && 'is_error' in o))) {
        if (o.is_error === true || /^error/.test(String(o.subtype || ''))) hits.push(`结果出错 subtype=${o.subtype || ''} ${String(o.result || o.error || '').slice(0, 160)}`);
      } else if (o && o.type === 'error') hits.push(`error 事件 ${JSON.stringify(o.error || o.message || '').slice(0, 160)}`);
      continue;
    }
    if (isErrFile && /(usage limit|rate limit|limit reached|hit your limit|quota exceeded|credit balance|额度)/i.test(line)) hits.push(`stderr：${line.slice(0, 200)}`);
  }
  return hits.length ? hits[hits.length - 1] : null;
}
// 从 cmd 命令行里取重定向的输出文件
export function redirectTargets(cl) {
  const s = String(cl || ''); const out = [];
  const cd = s.match(/cd\s+\/d\s+("?)([^"&]+?)\1\s*&&/i); const base = cd ? cd[2].trim() : null;
  for (const m of s.matchAll(/(?:^|\s)[12]?>>?\s*("([^"]+)"|([^\s"&|]+))/g)) {
    let p = m[2] || m[3]; if (!p || /^&\d$/.test(p) || /^nul$/i.test(p)) continue;
    if (!/^[a-z]:\\/i.test(p) && base) p = base.replace(/\\$/, '') + '\\' + p;
    if (/^[a-z]:\\/i.test(p)) out.push(p);
  }
  return out;
}

// ---------- 当前告警.md ----------
export function renderCurrentMd(alerts, hb) {
  const L = ['# 看门狗：当前未解决的问题', '', `更新：${ptStr(new Date(hb.at))}（太平洋时间） · 第 ${hb.round} 轮 · 本轮 ${hb.ms} 毫秒`, ''];
  const arr = Object.entries(alerts).map(([key, a]) => ({ key, ...a })).sort((a, b) => (a.level === b.level ? 0 : a.level === 'ERROR' ? -1 : 1));
  if (!arr.length) L.push('现在没有问题。');
  for (const a of arr) L.push(`- **${a.level === 'ERROR' ? '严重' : '注意'}** ${a.title}（从 ${ptHM(new Date(a.since))} 起）`, `  ${a.text}`, `  \`${a.key}\``);
  L.push('', '看门狗只看不动：不提交 GPU、不改链、不建/删 STOP、不杀进程。告警变化记录见 alerts.jsonl。');
  return L.join('\n') + '\n';
}
export function eventText(e) {
  const tag = e.type === 'resolved' ? '已解决' : e.type === 'changed' ? '有变化' : e.type === 'recovery' ? '自动恢复' : '新问题';
  const lv = e.level === 'ERROR' ? '严重' : e.level === 'INFO' ? '信息' : '注意';
  return `【看门狗·${tag}·${lv}】${e.title}${e.type === 'resolved' ? '' : '：' + e.text}（${ptHM(new Date(e.at))}，${e.key}）`;
}
