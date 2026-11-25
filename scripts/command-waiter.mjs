// 等待器（arm_waiter*.ps1）只读识别：读进程命令行、脚本文本和它自己的日志；绝不启动/停止/写任何东西
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const cache = new Map(); // script path -> { mtime, v }
async function parseScript(file, U) {
  const st = await fsp.stat(file).catch(() => null); if (!st) return null;
  const c = cache.get(file); if (c && c.mtime === st.mtimeMs) return c.v;
  const src = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  const vars = {}; for (const m of src.matchAll(/\$(\w+)\s*=\s*'([^']*)'/g)) vars[m[1]] = m[2];
  const expand = (s) => s.replace(/\$\{?(\w+)\}?/g, (a, k) => (k in vars ? vars[k] : a));
  const lm = /\$LOG\s*=\s*"([^"]+)"/.exec(src) || /\$LOG\s*=\s*'([^']+)'/.exec(src);
  const log = lm ? expand(lm[1]) : null;
  const steps = [];
  // 只认顶层调用行（不在 function 定义里）：WaitDone 'name' ... / Launch 'gpu_x_chain.py' 'sha' 'stop' @(args) ...
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*function\s/.test(line) || /^\s+/.test(line)) continue;
    let m;
    if ((m = /^\s*WaitDone\s+'([^']+)'.*?\(\[datetime\]'([^']+)'\)/.exec(line)) || (m = /^\s*WaitDone\s+'([^']+)'/.exec(line))) steps.push({ kind: 'wait', key: m[1], since: m[2] || null });
    else if ((m = /Launch\s+'gpu_([\w\-]+)_chain\.py'\s+'([0-9A-Fa-f]+)'\s+'([^']+)'\s+@\(([^)]*)\)/.exec(line))) {
      const args = [...m[4].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      const after = (args.find((a) => /^--after=/.test(a)) || '').replace(/^--after=/, '') || null;
      steps.push({ kind: 'launch', key: m[1], sha: m[2].toUpperCase(), stopFile: m[3], args, after });
    }
  }
  const v = { file, log, steps, stopFile: /arm_waiter\.STOP/.test(src) ? path.join(U, 'arm_waiter.STOP') : null };
  cache.set(file, { mtime: st.mtimeMs, v }); return v;
}
async function readLog(f) { try { return (await fsp.readFile(f, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean); } catch { return null; } }

// procs: [{ pid, cmd }]（powershell 进程）；U: M\_ 目录
export async function waiterStatus(psProcs, U) {
  const out = [];
  const seen = new Set();
  const add = async (file, pid) => {
    if (seen.has(file.toLowerCase())) return; seen.add(file.toLowerCase());
    const meta = await parseScript(file, U); if (!meta) return;
    const lines = meta.log ? await readLog(meta.log) : null;
    const w = { name: path.basename(path.dirname(file)) + '\\' + path.basename(file), file, pid: pid || null, alive: !!pid, log: meta.log, logLines: lines ? lines.length : null, firstLine: lines ? lines[0] || null : null, lastLine: lines ? lines[lines.length - 1] || null : null, aborted: null, finished: null, stopPresent: meta.stopFile ? fs.existsSync(meta.stopFile) : false, steps: [] };
    for (const l of lines || []) { if (/\bABORT\b/.test(l)) w.aborted = l; if (/finished/.test(l)) w.finished = l; }
    let blocked = false;
    for (const s of meta.steps) {
      const st = { ...s, status: 'pending', at: null, pidStarted: null };
      if (s.kind === 'wait') { const d = (lines || []).find((l) => l.includes(`${s.key} done`)); if (d) { st.status = 'done'; st.at = d.slice(0, 19); } }
      else { const d = (lines || []).find((l) => new RegExp(`started gpu_${s.key}_chain\\.py`).test(l)); if (d) { st.status = 'started'; st.at = d.slice(0, 19); st.pidStarted = Number((/pid (\d+)/.exec(d) || [])[1]) || null; } }
      if (st.status === 'pending') { if (w.aborted || !w.alive) st.status = 'dead'; else if (blocked) st.status = 'armed'; else st.status = s.kind === 'wait' ? 'waiting' : 'armed'; blocked = true; }
      w.steps.push(st);
    }
    w.state = w.aborted ? 'aborted' : w.finished ? 'finished' : w.alive ? 'alive' : 'gone';
    out.push(w);
  };
  for (const p of psProcs) { const m = /-File\s+"?([^"]*?arm_waiter[^"\\\/]*\.ps1)"?/i.exec(p.cmd || ''); if (m) await add(m[1], p.pid); }
  // 今天改过但不在跑的等待器也列出来（看它是跑完了还是中止了）
  try {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    for (const d of await fsp.readdir(U)) {
      if (!/^arm_waiter/i.test(d)) continue; const dp = path.join(U, d); const st = await fsp.stat(dp).catch(() => null); if (!st || !st.isDirectory()) continue;
      for (const f of await fsp.readdir(dp)) if (/^arm_waiter.*\.ps1$/i.test(f)) { const fp = path.join(dp, f); const s2 = await fsp.stat(fp).catch(() => null); if (s2 && s2.mtimeMs >= t0.getTime()) await add(fp, null); }
    }
  } catch {}
  out.sort((a, b) => (b.alive - a.alive));
  return out;
}
