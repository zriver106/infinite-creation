// 成片「升级 2K」（ic31，2026-11-22 Andy 需求）。
//
// 做法照搬本项目 2026-11-19 EP 批量 2K 的火山 AI MediaKit 调用（草稿\火山2K_修仙_20261119、火山EP15对比_20261119 的任务记录）：
//   1. POST /api/v1/tools-sync/request-media-upload-url  → file_id(mediakit://…) + upload_url
//   2. PUT 原片二进制到 upload_url（Content-Type: video/mp4，不能用 multipart）
//   3. POST /api/v1/tools/enhance-video  { video_url: file_id, tool_version:'standard', scene:'common',
//        resolution:'2k', enhance_style:'balanced', client_token }   （fps 不传 = 保持原帧率）
//   4. 轮询 GET /api/v1/tasks/{task_id}，直到 status = completed / failed
//   5. 下载 result.video_url（24h 临时链接），用原片音轨无损合流（-map 0:v -map 1:a -c copy），
//      因为火山结果的音轨不能假定与原声一致（docs/480p预览与成片规则.md §5）。
//
// 密钥：只存在 DATA_DIR/upscale2k.json（不进 config.json、不进代码、不进日志、不进任何接口返回）。
// 新旧片关系：exports/.ic-versions.json（files[新片].upscaled_from = 原片；selected[原片] = 当前选用的那一条）。
// 2K 判定：ffprobe 读首条视频流的宽高，短边 ≥ 1440 记 2K（≥ 2160 记 4K），不看文件名。
//
// 任务状态挂在 globalThis（Next 会给 server.js 与各 route 各打包一份模块，模块级变量不共享，同 lib/ws.js）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { DATA_DIR, projectDir } from './config.js';
import { logger } from './logger.js';
import { probeVideoInfo, runFfmpeg } from './ffmpeg.js';

export const UPSCALE_SETTINGS_PATH = process.env.IC_UPSCALE_SETTINGS
  ? path.resolve(process.env.IC_UPSCALE_SETTINGS)
  : path.join(DATA_DIR, 'upscale2k.json');
export const UPSCALE_TASKS_PATH = path.join(DATA_DIR, 'upscale2k-tasks.json');
export const VERSIONS_FILE = '.ic-versions.json';
// 只给开发/测试用的接口地址覆盖（指到本机 mock），界面上不可改；线上不设这个环境变量 = 火山官方地址。
const MEDIAKIT_BASE = (process.env.IC_VOLC_MEDIAKIT_BASE || 'https://mediakit.cn-beijing.volces.com').replace(/\/+$/, '');
const POLL_MS = Math.max(200, Number(process.env.IC_UPSCALE_POLL_MS) || 15_000);
const TASK_TIMEOUT_MS = 6 * 3600 * 1000;
const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;

export const UPSCALE_PROVIDERS = [
  { id: 'volc', label: '火山', available: true, desc: '火山引擎 AI MediaKit 画质增强（标准版），按分钟计费' },
  { id: 'local', label: '本地', available: false, desc: '用本机显卡超分（暂未开放）' },
];
export const ENHANCE_STYLES = [
  { id: 'balanced', label: '均衡（EP1–30 2K 所用）' },
  { id: 'clear', label: '清晰' },
];

const DEFAULT_SETTINGS = {
  provider: 'volc',
  volc: { apiKey: '', keyUpdatedAt: '', toolVersion: 'standard', scene: 'common', resolution: '2k', enhanceStyle: 'balanced', concurrency: 2 },
};

// ———————————————————— 设置 ————————————————————
export function readUpscaleSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(UPSCALE_SETTINGS_PATH, 'utf8')) || {}; } catch { /* 没有就用默认 */ }
  return {
    provider: raw.provider === 'local' ? 'local' : 'volc',
    volc: { ...DEFAULT_SETTINGS.volc, ...(raw.volc && typeof raw.volc === 'object' ? raw.volc : {}) },
  };
}

// 前端可见的设置：永远不带 apiKey，只给「是否已配置」。
export function publicUpscaleSettings(s = readUpscaleSettings()) {
  const { apiKey, ...rest } = s.volc;
  return {
    provider: s.provider,
    providers: UPSCALE_PROVIDERS,
    enhanceStyles: ENHANCE_STYLES,
    volc: { ...rest, configured: !!apiKey },
    endpoint: MEDIAKIT_BASE.startsWith('https://mediakit.') ? '火山 AI MediaKit（cn-beijing）' : '开发 mock：' + MEDIAKIT_BASE,
  };
}

// body: { provider?, volc?: { apiKey?: string（非空才覆盖）, clearKey?: true, enhanceStyle?, concurrency? } }
export function saveUpscaleSettings(body) {
  const cur = readUpscaleSettings();
  const next = { provider: cur.provider, volc: { ...cur.volc } };
  if (body && body.provider !== undefined) {
    if (body.provider === 'local') throw httpError(400, '本地升级 2K 暂未开放');
    if (body.provider !== 'volc') throw httpError(400, '未知的升级方式：' + body.provider);
    next.provider = 'volc';
  }
  const v = (body && body.volc) || {};
  if (v.clearKey === true) { next.volc.apiKey = ''; next.volc.keyUpdatedAt = new Date().toISOString(); }
  if (v.apiKey !== undefined && v.apiKey !== null && String(v.apiKey).trim() !== '') {
    const k = String(v.apiKey).trim();
    if (k.length < 8 || k.length > 512 || /\s/.test(k)) throw httpError(400, 'API Key 格式不对（不能含空格，长度 8–512）');
    next.volc.apiKey = k;
    next.volc.keyUpdatedAt = new Date().toISOString();
  }
  if (v.enhanceStyle !== undefined) {
    if (!ENHANCE_STYLES.some((e) => e.id === v.enhanceStyle)) throw httpError(400, '未知的增强风格：' + v.enhanceStyle);
    next.volc.enhanceStyle = v.enhanceStyle;
  }
  if (v.concurrency !== undefined) {
    const n = Number(v.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw httpError(400, '并发数只能是 1–8');
    next.volc.concurrency = n;
  }
  fs.mkdirSync(path.dirname(UPSCALE_SETTINGS_PATH), { recursive: true });
  const tmp = UPSCALE_SETTINGS_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, UPSCALE_SETTINGS_PATH);
  logger.info('升级2K 设置已保存', { provider: next.provider, keyConfigured: !!next.volc.apiKey, enhanceStyle: next.volc.enhanceStyle });
  return publicUpscaleSettings(next);
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 错误信息里可能带签名 URL、Bearer 头或 key 本身：一律打码后再进日志 / 任务状态 / 接口。
export function redactSecrets(text) {
  let s = String(text == null ? '' : text);
  const key = readUpscaleSettings().volc.apiKey;
  if (key && key.length >= 4) s = s.split(key).join('***');
  s = s.replace(/(Bearer\s+)[^\s"']+/gi, '$1***');
  s = s.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/gi, '$1?***');
  return s.slice(0, 600);
}

// ———————————————————— 分辨率 ————————————————————
const probeCache = () => (globalThis.__icUpscaleProbe ||= new Map());

export function resolutionTier(width, height) {
  const short = Math.min(Number(width) || 0, Number(height) || 0);
  if (short >= 2160) return '4K';
  if (short >= 1440) return '2K';
  return '';
}

// 读实际宽高（ffprobe），按 路径+大小+mtime 缓存；失败返回 0×0。
export async function probeResolution(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return { width: 0, height: 0, duration: 0 }; }
  const k = abs + '|' + st.size + '|' + st.mtimeMs;
  const c = probeCache();
  if (c.has(k)) return c.get(k);
  let r = { width: 0, height: 0, duration: 0 };
  try {
    // 复用上游 ffmpeg.js 的 probeVideoInfo（成片轻量剪辑同一个探测函数）
    const info = await probeVideoInfo(abs, 30_000);
    r = { width: info.width || 0, height: info.height || 0, duration: info.duration || 0 };
  } catch (e) {
    logger.warn('升级2K：ffprobe 读分辨率失败', { file: path.basename(abs), error: String(e.message).slice(0, 200) });
  }
  c.set(k, r);
  return r;
}

// ———————————————————— 新旧片关系（exports/.ic-versions.json） ————————————————————
function exportsDir(projectId) { return path.join(projectDir(projectId), 'exports'); }

export function readVersions(projectId) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(exportsDir(projectId), VERSIONS_FILE), 'utf8'));
    return { version: 1, files: j.files || {}, selected: j.selected || {} };
  } catch { return { version: 1, files: {}, selected: {} }; }
}

function writeVersions(projectId, v) {
  const dir = exportsDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, VERSIONS_FILE);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, file);
}

export function rootOf(versions, name) {
  let cur = name;
  for (let i = 0; i < 10; i++) {
    const up = versions.files[cur] && versions.files[cur].upscaled_from;
    if (!up) return cur;
    cur = up;
  }
  return cur;
}

// 当前选用的那一条：显式选过且文件还在就用它，否则回退原片（原片也没了就取组里任意一条还在的）。
export function selectedOf(versions, root, existing) {
  const s = versions.selected[root];
  if (s && existing.has(s)) return s;
  if (existing.has(root)) return root;
  for (const [n, meta] of Object.entries(versions.files)) if (existing.has(n) && rootOf(versions, n) === root && meta) return n;
  return root;
}

export function setSelected(projectId, name) {
  const dir = exportsDir(projectId);
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name || !VIDEO_RE.test(safe)) throw httpError(400, '非法文件名');
  if (!fs.existsSync(path.join(dir, safe))) throw httpError(404, '成片不存在：' + safe);
  const v = readVersions(projectId);
  const root = rootOf(v, safe);
  v.selected[root] = safe;
  writeVersions(projectId, v);
  return { root, selected: safe };
}

// ———————————————————— 任务 ————————————————————
const ACTIVE = new Set(['queued', 'uploading', 'submitting', 'running', 'downloading', 'remuxing']);
export const STATUS_LABEL = {
  queued: '排队中', uploading: '上传原片', submitting: '提交火山', running: '火山处理中',
  downloading: '下载结果', remuxing: '合回原音轨', done: '已完成', failed: '失败',
};

function state() {
  if (!globalThis.__icUpscale2k) {
    globalThis.__icUpscale2k = { tasks: [], running: 0, booted: false, timer: null };
  }
  return globalThis.__icUpscale2k;
}

function persist() {
  const st = state();
  try {
    fs.mkdirSync(path.dirname(UPSCALE_TASKS_PATH), { recursive: true });
    const tmp = UPSCALE_TASKS_PATH + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st.tasks.slice(-500).map(({ _inflight, _step, ...rest }) => rest), null, 2));
    fs.renameSync(tmp, UPSCALE_TASKS_PATH);
  } catch (e) { logger.error('升级2K 任务表写入失败', { error: e.message }); }
}

// 进程重启后接着跑：已拿到火山 task_id 的继续轮询（不重复提交、不重复计费）；没拿到的重新排队（client_token 不变，火山侧幂等）。
function boot() {
  const st = state();
  if (st.booted) return;
  st.booted = true;
  try { st.tasks = JSON.parse(fs.readFileSync(UPSCALE_TASKS_PATH, 'utf8')) || []; } catch { st.tasks = []; }
  let n = 0;
  for (const t of st.tasks) {
    if (!ACTIVE.has(t.status)) continue;
    t.status = t.remote_task_id ? 'running' : 'queued';
    t.resumed = true;
    n++;
  }
  if (n) { logger.info('升级2K：接管上次未完成的任务', { count: n }); persist(); }
  pump();
}

function publicTask(t) {
  return {
    id: t.id, projectId: t.projectId, source: t.source, target: t.target, status: t.status,
    status_label: STATUS_LABEL[t.status] || t.status, provider: t.provider, remote_task_id: t.remote_task_id || '',
    error: t.error || '', created_at: t.created_at, updated_at: t.updated_at, finished_at: t.finished_at || '',
    result: t.result || null, resumed: !!t.resumed,
    remote_status: t.remote_status || '', remote_progress: t.remote_progress == null ? null : t.remote_progress,
    remote_checked_at: t.remote_checked_at || '', remote_status_since: t.remote_status_since || '', remote_raw: t.remote_raw || '',
  };
}

// 2026-11-26（主会话 seq2025）：火山每次轮询回的状态原文落盘，只记录、不改判定。
// 任务表里存最近一次（状态、进度、时间、这个状态从几点开始、去掉结果链接的原文前 300 字）；状态变了另写一条日志。
export function remoteSnapshot(info) {
  const i = info && typeof info === 'object' ? info : {};
  const prog = i.progress != null ? i.progress : (i.result && i.result.progress != null ? i.result.progress : null);
  const slim = { ...i };
  delete slim.result; // 结果里有带签名的下载链接，不落盘
  return { status: String(i.status || ''), progress: prog, raw: redactSecrets(JSON.stringify(slim)).slice(0, 300) };
}

export function listUpscaleTasks(projectId) {
  boot();
  return state().tasks.filter((t) => !projectId || t.projectId === projectId).map(publicTask);
}

function update(t, patch) {
  Object.assign(t, patch, { updated_at: new Date().toISOString() });
  persist();
}

function targetNameFor(dir, source) {
  const base = source.replace(/\.[^.]+$/, '');
  let name = base + '_2k.mp4';
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = base + '_2k_' + i + '.mp4';
  return name;
}

// files: 成片文件名数组。返回 { tasks, skipped:[{name, reason}] }
export async function enqueueUpscale(projectId, files, { force = false } = {}) {
  boot();
  const s = readUpscaleSettings();
  if (s.provider !== 'volc') throw httpError(400, '本地升级 2K 暂未开放');
  if (!s.volc.apiKey) throw httpError(400, '还没有配置火山 MediaKit API Key：请到「系统设置 → 升级2K」填写后再试');
  const dir = exportsDir(projectId);
  const versions = readVersions(projectId);
  const st = state();
  const created = [];
  const skipped = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const name = String(raw || '');
    if (!name || path.basename(name) !== name || !VIDEO_RE.test(name)) { skipped.push({ name, reason: '非法文件名' }); continue; }
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) { skipped.push({ name, reason: '文件不存在' }); continue; }
    if (st.tasks.some((t) => t.projectId === projectId && t.source === name && ACTIVE.has(t.status))) { skipped.push({ name, reason: '已在升级中' }); continue; }
    // 上次因网络瞬断失败、火山侧已有 task_id 的：接着查原火山任务，不重新提交（不重复计费）。force 照旧新开。
    const prevFail = !force && [...st.tasks].reverse().find((t) => t.projectId === projectId && t.source === name && t.status === 'failed' && t.remote_task_id && (t.transient || isTransientError({ message: t.error })));
    if (prevFail) {
      update(prevFail, { status: 'running', resumed: true, error: '', finished_at: '' });
      created.push(prevFail);
      continue;
    }
    const r = await probeResolution(abs);
    if (resolutionTier(r.width, r.height)) { skipped.push({ name, reason: '已经是 ' + r.width + '×' + r.height }); continue; }
    if (!force) {
      const has = Object.entries(versions.files).find(([n, m]) => m && m.upscaled_from === name && fs.existsSync(path.join(dir, n)));
      if (has) { skipped.push({ name, reason: '已有升级版 ' + has[0] }); continue; }
    }
    const now = new Date().toISOString();
    const t = {
      id: 'up_' + crypto.randomBytes(6).toString('hex'),
      projectId, source: name, target: '', provider: 'volc', status: 'queued', error: '',
      client_token: 'ic2k-' + crypto.createHash('sha1').update(projectId + '|' + name + '|' + now).digest('hex').slice(0, 40),
      params: { tool_version: s.volc.toolVersion, scene: s.volc.scene, resolution: s.volc.resolution, enhance_style: s.volc.enhanceStyle },
      source_info: r, created_at: now, updated_at: now,
    };
    st.tasks.push(t);
    created.push(t);
  }
  persist();
  if (created.length) logger.info('升级2K：已排队', { projectId, count: created.length, files: created.map((t) => t.source) });
  pump();
  return { tasks: created.map(publicTask), skipped };
}

function pump() {
  const st = state();
  const limit = readUpscaleSettings().volc.concurrency || 1;
  // 已有火山 task_id 的轮询不占提交名额以外的资源，但为了简单统一算一个槽位
  for (const t of st.tasks) {
    if (st.running >= limit) break;
    if (t._inflight) continue;
    if (t.status !== 'queued' && !(t.status === 'running' && t.resumed && t.remote_task_id)) continue;
    t._inflight = true;
    st.running++;
    runTask(t)
      .catch((e) => {
        const msg = redactSecrets(e && e.message ? e.message : e);
        update(t, { status: 'failed', error: msg, transient: isTransientError(e), finished_at: new Date().toISOString() });
        logger.error('升级2K 失败', { task: t.id, source: t.source, step: t._step || '', error: msg });
      })
      .finally(() => { t._inflight = false; st.running--; setImmediate(pump); });
  }
}

// —— HTTP 小工具（不带第三方依赖；所有日志只记路径，不记头） ——
function request(method, url, { headers = {}, body, bodyStream, bodyLength, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { ...headers, ...(bodyLength != null ? { 'Content-Length': bodyLength } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(method + ' ' + u.host + u.pathname + ' 超时')));
    req.on('error', reject);
    if (bodyStream) bodyStream.pipe(req);
    else req.end(body);
  });
}

async function mediakit(method, apiPath, key, payload) {
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  const r = await request(method, MEDIAKIT_BASE + apiPath, {
    headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
    bodyLength: body ? body.length : undefined,
  });
  let j = {};
  try { j = JSON.parse(r.text || '{}'); } catch { /* 非 JSON */ }
  if (r.status === 401 || r.status === 403) throw new Error('火山鉴权失败（HTTP ' + r.status + '）：请检查「升级2K」里的 API Key');
  if (r.status >= 400 || j.success === false) {
    const em = (j.error && (j.error.message || j.error.code)) || r.text.slice(0, 300) || ('HTTP ' + r.status);
    throw new Error('火山接口 ' + apiPath + ' 返回错误：' + (r.status >= 500 ? 'HTTP ' + r.status + ' ' : '') + em);
  }
  return j;
}

function download(url, dest, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, u).toString(), dest, { maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载结果失败：HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('下载结果超时')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2026-11-25：网络瞬断（ECONNRESET 等）或火山 5xx 不算任务失败。EP1 那次就是轮询时一次 ECONNRESET，
// 火山侧任务还在跑，IC 却把整条标了失败；重排会新开火山任务、重复扣费。
const TRANSIENT_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|超时|HTTP 5\d\d|返回错误：HTTP 5\d\d/i;
export function isTransientError(e) {
  const m = String((e && (e.code || '')) + ' ' + (e && e.message ? e.message : e || ''));
  return TRANSIENT_RE.test(m);
}
async function withRetry(fn, { tries = 8, baseMs = POLL_MS, label = '' } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isTransientError(e)) throw e;
      logger.warn('升级2K 网络瞬断，稍后重试', { step: label, attempt: i, error: redactSecrets(e && e.message ? e.message : e) });
      await sleep(Math.min(baseMs * i, 5 * 60 * 1000));
    }
  }
}

async function runTask(t) {
  const key = readUpscaleSettings().volc.apiKey;
  if (!key) throw new Error('火山 API Key 未配置');
  const dir = exportsDir(t.projectId);
  const srcAbs = path.join(dir, t.source);
  if (!fs.existsSync(srcAbs)) throw new Error('原片不存在：' + t.source);

  if (!t.remote_task_id) {
    t._step = 'upload';
    update(t, { status: 'uploading', error: '' });
    const up = await mediakit('POST', '/api/v1/tools-sync/request-media-upload-url', key, {});
    const res = up.result || {};
    if (!res.file_id || !res.upload_url) throw new Error('火山没有返回上传地址');
    const size = fs.statSync(srcAbs).size;
    const extra = {};
    const uh = res.upload_headers;
    if (Array.isArray(uh)) for (const h of uh) { const k = h && (h.key || h.name); if (k) extra[k] = h.value; }
    else if (uh && typeof uh === 'object') Object.assign(extra, uh);
    const put = await request(res.method || 'PUT', res.upload_url, {
      headers: { 'Content-Type': 'video/mp4', ...extra }, bodyStream: fs.createReadStream(srcAbs), bodyLength: size, timeoutMs: 60 * 60 * 1000,
    });
    if (put.status < 200 || put.status >= 300) throw new Error('上传原片失败：HTTP ' + put.status);

    t._step = 'submit';
    update(t, { status: 'submitting' });
    const sub = await mediakit('POST', '/api/v1/tools/enhance-video', key, { video_url: res.file_id, ...t.params, client_token: t.client_token });
    if (!sub.task_id) throw new Error('火山没有返回 task_id');
    update(t, { status: 'running', remote_task_id: sub.task_id, submitted_at: new Date().toISOString() });
    logger.info('升级2K 已提交火山', { task: t.id, source: t.source, remote: sub.task_id });
  }

  t._step = 'poll';
  const started = Date.parse(t.submitted_at || t.created_at) || Date.now();
  let info;
  for (;;) {
    info = await withRetry(() => mediakit('GET', '/api/v1/tasks/' + encodeURIComponent(t.remote_task_id), key), { label: 'poll' });
    const snap = remoteSnapshot(info);
    const now = new Date().toISOString();
    if (snap.status !== (t.remote_status || '')) {
      logger.info('升级2K 火山状态', { task: t.id, source: t.source, remote: t.remote_task_id, from: t.remote_status || '', to: snap.status, progress: snap.progress, raw: snap.raw });
      t.remote_status_since = now;
    }
    update(t, { remote_status: snap.status, remote_progress: snap.progress, remote_checked_at: now, remote_raw: snap.raw });
    if (info.status === 'completed') break;
    if (info.status === 'failed') throw new Error('火山任务失败：' + ((info.error && (info.error.message || info.error.code)) || '未知原因'));
    if (Date.now() - started > TASK_TIMEOUT_MS) throw new Error('火山任务超过 6 小时未完成');
    await sleep(POLL_MS);
  }
  const videoUrl = info.result && info.result.video_url;
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) throw new Error('火山结果里没有可下载的视频地址');

  t._step = 'download';
  update(t, { status: 'downloading' });
  const target = targetNameFor(dir, t.source);
  const raw = path.join(dir, '.' + target + '.volc-raw');
  const tmpOut = path.join(dir, '.' + target + '.remux.mp4');
  try {
    await withRetry(() => download(videoUrl, raw), { tries: 4, label: 'download' });
    t._step = 'remux';
    update(t, { status: 'remuxing' });
    // 画面用火山结果，声音用原片（原片没有音轨时 1:a? 自动跳过）
    await runFfmpeg(['-v', 'error', '-y', '-i', raw, '-i', srcAbs, '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', tmpOut], { timeoutMs: 30 * 60 * 1000 });
    const outInfo = await probeResolution(tmpOut);
    const srcInfo = await probeResolution(srcAbs);
    if (!resolutionTier(outInfo.width, outInfo.height)) throw new Error('火山结果不是 2K：' + outInfo.width + '×' + outInfo.height);
    if (srcInfo.duration && outInfo.duration && Math.abs(srcInfo.duration - outInfo.duration) > 0.5) {
      throw new Error('结果时长 ' + outInfo.duration.toFixed(2) + 's 与原片 ' + srcInfo.duration.toFixed(2) + 's 不一致');
    }
    if (fs.existsSync(path.join(dir, target))) throw new Error('目标文件已存在，不覆盖：' + target);
    fs.renameSync(tmpOut, path.join(dir, target));
    const v = readVersions(t.projectId);
    v.files[target] = {
      upscaled_from: t.source, provider: 'volc', remote_task_id: t.remote_task_id, task_id: t.id,
      params: t.params, width: outInfo.width, height: outInfo.height, created_at: new Date().toISOString(),
    };
    // 升级完成后默认选用 2K 版；想交付原片在成片卡片上点「设为选用」即可切回
    v.selected[rootOf(v, t.source)] = target;
    writeVersions(t.projectId, v);
    update(t, { status: 'done', target, finished_at: new Date().toISOString(), result: { width: outInfo.width, height: outInfo.height, duration: outInfo.duration } });
    logger.info('升级2K 完成', { task: t.id, source: t.source, target, size: outInfo.width + 'x' + outInfo.height });
  } finally {
    for (const f of [raw, tmpOut]) { try { fs.rmSync(f, { force: true }); } catch { /* 留着不影响 */ } }
  }
}

// 成片列表的附加信息：宽高、2K 角标、新旧片关系、选用状态、最近一次升级任务。
export async function decorateExports(projectId, files) {
  boot();
  const dir = exportsDir(projectId);
  const versions = readVersions(projectId);
  const existing = new Set(files.map((f) => f.name));
  const tasks = state().tasks.filter((t) => t.projectId === projectId);
  const infos = await Promise.all(files.map((f) => probeResolution(path.join(dir, f.name))));
  const byName = new Map(files.map((f) => [f.name, f]));
  const out = files.map((f, i) => {
    const r = infos[i];
    const meta = versions.files[f.name] || null;
    const root = rootOf(versions, f.name);
    const derived = Object.entries(versions.files).filter(([n, m]) => m && m.upscaled_from === f.name && existing.has(n)).map(([n]) => n);
    const last = [...tasks].reverse().find((t) => t.source === f.name);
    const rootFile = byName.get(root);
    return {
      ...f,
      width: r.width, height: r.height, duration: r.duration,
      res_tier: resolutionTier(r.width, r.height),
      upscaled_from: meta ? meta.upscaled_from : '',
      upscale_provider: meta ? meta.provider : '',
      upscaled_to: derived,
      group: root,
      selected: selectedOf(versions, root, existing) === f.name,
      group_size: 1 + Object.entries(versions.files).filter(([n, m]) => m && existing.has(n) && rootOf(versions, n) === root && n !== root).length,
      // 2K 版没有自己的 SRT：字幕时间轴与原片一致，沿用原片的 SRT
      srt_name: f.srt_name || (meta && rootFile ? rootFile.srt_name || '' : ''),
      upscale_task: last ? publicTask(last) : null,
    };
  });
  // 同组排在一起：原片在前，升级版紧跟其后；组之间按原片时间新→旧
  const groupTime = new Map();
  for (const f of out) groupTime.set(f.group, Math.max(groupTime.get(f.group) || 0, (byName.get(f.group) || f).mtime));
  out.sort((a, b) => (groupTime.get(b.group) - groupTime.get(a.group)) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || ((a.upscaled_from ? 1 : 0) - (b.upscaled_from ? 1 : 0)) || (a.mtime - b.mtime));
  return out;
}

export function chapterTitleFromExportName(name) {
  const m = /第\s*([1-9][0-9]*)\s*章/.exec(String(name || ''));
  return m ? '第' + m[1] + '章' : '';
}
