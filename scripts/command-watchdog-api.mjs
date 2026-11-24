// 看门狗只读接口 + 推送（CLA-34）。
// GET /api/command/watchdog：心跳、配置摘要、当前告警、最近 50 条变化、自动恢复记录。
// 推送：4620 服务进程每 5 秒看一次 alerts.jsonl 的新行，作为 role:'system' 追加到聊天主会话 main（postSystemToMain，不触发回复）。
// 看门狗心跳超过 60 秒没更新，也推一次「看门狗停了」；恢复后推一次「恢复」。推送位置存盘，重启不重复推。
import fs from 'node:fs';
import path from 'node:path';
import { postSystemToMain } from './command-chat.mjs';

const M = process.env.CMD_M || 'C:\\Users\\usazr\\Documents\\moviePro';
export const WD_DIR = process.env.CMD_WATCHDOG_DIR || path.join(M, 'Claude工作区', '指挥', '看门狗');
const STALE_SEC = 25; // 2 个周期多一点
const PUSH_STALE_SEC = 60;
const PUSH_STATE = path.join(WD_DIR, 'push_state.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
function tailLines(f, n, maxBytes = 262144) {
  let fd; try {
    fd = fs.openSync(f, 'r'); const st = fs.fstatSync(fd); const len = Math.min(maxBytes, st.size);
    const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len);
    const ls = b.toString('utf8').split('\n'); if (len < st.size) ls.shift();
    return ls.filter((x) => x.trim()).slice(-n).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
const ptStr = (d) => new Date(d).toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles', hour12: false });

export function watchdogView() {
  const hb = readJson(path.join(WD_DIR, 'heartbeat.json'));
  const cur = readJson(path.join(WD_DIR, 'current_alerts.json'));
  const cfg = readJson(path.join(WD_DIR, 'watchdog-config.json'));
  const ageSec = hb?.at ? Math.round((Date.now() - Date.parse(hb.at)) / 1000) : null;
  const stale = ageSec == null || ageSec > STALE_SEC;
  const alerts = Object.entries(cur?.alerts || {}).map(([key, a]) => ({ key, level: a.level, check: a.check, title: a.title, text: a.text, since: a.since }));
  const errorCount = alerts.filter((a) => a.level === 'ERROR').length;
  return {
    dir: WD_DIR,
    heartbeat: hb, ageSec, stale, staleAfterSec: STALE_SEC,
    status: stale ? 'stopped' : errorCount ? 'error' : alerts.length ? 'warn' : 'ok',
    statusText: stale ? (hb ? `看门狗停了：心跳 ${ageSec} 秒没更新（上次 ${ptStr(hb.at)}）` : '看门狗停了：没有心跳文件') : errorCount ? `有 ${errorCount} 个严重告警` : alerts.length ? `有 ${alerts.length} 个注意事项` : '正常',
    config: cfg ? { intervalSec: cfg.intervalSec, gpuIdleGraceSec: cfg.gpuIdleGraceSec, chainStaleMin: cfg.chainStaleMin, chainWaitStaleMin: cfg.chainWaitStaleMin, sessionLongMin: cfg.sessionLongMin, gateFlag: cfg.gateFlag, gateMaxChapter: cfg.gateMaxChapter, recoveryMode: cfg.recovery?.mode, whitelist: (cfg.recovery?.whitelist || []).map((w) => ({ script: w.script, md5: w.md5, live: !!w.live })), deadlines: (cfg.deadlines || []).map((d) => ({ id: d.id, name: d.name, at: d.at, done: !!d.done })) } : null,
    alerts,
    changes: tailLines(path.join(WD_DIR, 'alerts.jsonl'), 50).reverse(),
    recoveries: tailLines(path.join(WD_DIR, 'recoveries.jsonl'), 20).reverse(),
  };
}

export function handleWatchdog(req, res, send) {
  try { return send(res, 200, { ok: true, at: new Date().toISOString(), data: watchdogView() }); }
  catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
}

// ---------- 推送 ----------
let pushing = false, timer = null;
async function pushTick() {
  if (pushing) return; pushing = true;
  try {
    const st = readJson(PUSH_STATE) || {};
    const f = path.join(WD_DIR, 'alerts.jsonl');
    let size = 0; try { size = fs.statSync(f).size; } catch {}
    if (st.offset == null || st.offset > size) { // 第一次：从现在开始推，不翻旧账；只推一条「当前未解决」汇总
      const cur = readJson(path.join(WD_DIR, 'current_alerts.json'));
      const arr = Object.values(cur?.alerts || {});
      const r = await postSystemToMain(`【看门狗·接入】4620 开始转发看门狗告警。当前未解决 ${arr.length} 个${arr.length ? '：\n' + arr.map((a) => `· ${a.level === 'ERROR' ? '严重' : '注意'} ${a.title}`).join('\n') : '。'}\n详情见 ${WD_DIR}\\当前告警.md`);
      if (!r.ok) { pushing = false; return; }
      st.offset = size; fs.writeFileSync(PUSH_STATE, JSON.stringify(st));
    }
    if (size > st.offset) {
      const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(Math.min(size - st.offset, 1 << 20)); fs.readSync(fd, b, 0, b.length, st.offset); fs.closeSync(fd);
      const txt = b.toString('utf8'); const end = txt.lastIndexOf('\n');
      if (end >= 0) {
        const lines = txt.slice(0, end).split('\n').filter((x) => x.trim());
        const msgs = lines.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
        if (msgs.length) {
          const body = msgs.length === 1 ? msgs[0].msg : `【看门狗】${msgs.length} 条变化：\n` + msgs.map((m) => '· ' + m.msg).join('\n');
          const r = await postSystemToMain(body, { watchdog: msgs.map((m) => ({ type: m.type, key: m.key, level: m.level })) });
          if (!r.ok) { pushing = false; return; } // 主会话不在：下次再推
        }
        st.offset += Buffer.byteLength(txt.slice(0, end + 1), 'utf8');
      }
    }
    // 心跳过期
    const hb = readJson(path.join(WD_DIR, 'heartbeat.json'));
    const age = hb?.at ? (Date.now() - Date.parse(hb.at)) / 1000 : Infinity;
    if (age > PUSH_STALE_SEC && !st.stalePushed && hb) { const r = await postSystemToMain(`【看门狗·严重】看门狗停了：心跳 ${Math.round(age)} 秒没更新（上次 ${ptStr(hb.at)} 太平洋时间，PID ${hb.pid}）。保活任务应在 1 分钟内拉起；没拉起请查 ${WD_DIR}\\keeper.log。`); if (r.ok) st.stalePushed = true; }
    else if (age <= STALE_SEC && st.stalePushed) { const r = await postSystemToMain(`【看门狗·信息】看门狗恢复了：心跳正常（PID ${hb.pid}，${ptStr(hb.at)}）。`); if (r.ok) st.stalePushed = false; }
    fs.writeFileSync(PUSH_STATE, JSON.stringify(st));
  } catch { /* 下次再试 */ }
  pushing = false;
}
export function watchdogInit() { if (timer) return; try { fs.mkdirSync(WD_DIR, { recursive: true }); } catch {} timer = setInterval(pushTick, 5000); timer.unref?.(); setTimeout(pushTick, 1500); }
