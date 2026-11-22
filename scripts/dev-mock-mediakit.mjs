// 开发用：本机模拟火山 AI MediaKit（上传地址 / PUT 上传 / enhance-video / tasks 轮询 / 结果下载），不花钱。
// 只在开发实例里用：run-dev-backend.cmd 设 IC_VOLC_MEDIAKIT_BASE=http://127.0.0.1:4639 时，IC 后端会把请求打到这里。
// 结果用 ffmpeg 把原片等比放大到短边 1440，并故意去掉音轨（验证 IC 会合回原片音轨）。
// POST /__mock/fail-next 让下一次 enhance-video 任务失败；GET /__mock/log 看收到的请求（不含 Authorization 值）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.MOCK_PORT || 4639);
const DIR = process.env.MOCK_DIR || path.resolve('mock-mediakit-data');
const EXPECT_KEY = process.env.MOCK_EXPECT_KEY || 'mock-test-key-0001';
fs.mkdirSync(DIR, { recursive: true });
const tasks = new Map();
const byToken = new Map();
const uploads = new Map();
const log = [];
let failNext = false;

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }
const rid = () => crypto.randomBytes(8).toString('hex');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const auth = req.headers.authorization || '';
  const authOk = auth === 'Bearer ' + EXPECT_KEY;
  const entry = { at: new Date().toISOString(), method: req.method, path: u.pathname, auth: auth ? (authOk ? 'ok' : 'WRONG') : 'none' };
  log.push(entry);
  if (u.pathname === '/__mock/log') return json(res, 200, { log, tasks: [...tasks.values()].map(({ proc, ...t }) => t) });
  if (u.pathname === '/__mock/fail-next') { failNext = true; return json(res, 200, { ok: true }); }
  if (u.pathname.startsWith('/upload/') && req.method === 'PUT') {
    const id = u.pathname.slice(8);
    if (!uploads.has(id)) return json(res, 404, {});
    if (String(req.headers['content-type'] || '').startsWith('multipart')) return json(res, 400, { error: 'multipart not allowed' });
    const f = path.join(DIR, 'in_' + id + '.mp4');
    const out = fs.createWriteStream(f);
    req.pipe(out);
    out.on('finish', () => { uploads.set(id, f); entry.bytes = fs.statSync(f).size; res.writeHead(200); res.end(); });
    return;
  }
  if (u.pathname.startsWith('/out/')) {
    const id = u.pathname.slice(5).replace(/\.mp4$/, '');
    const t = tasks.get(id);
    if (!t || t.status !== 'completed' || u.searchParams.get('auth_key') !== t.auth_key) return json(res, 403, {});
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(t.out).size });
    return fs.createReadStream(t.out).pipe(res);
  }
  if (!authOk) return json(res, 401, { success: false, error: { code: 'Unauthorized', message: 'invalid api key' } });
  if (u.pathname === '/api/v1/tools-sync/request-media-upload-url' && req.method === 'POST') {
    const id = rid();
    uploads.set(id, '');
    return json(res, 200, { success: true, task_id: 'amk-tool-request-media-upload-url-' + id, result: { file_id: 'mediakit://' + id, method: 'PUT', upload_headers: [], upload_url: 'http://127.0.0.1:' + PORT + '/upload/' + id + '?Signature=mocksig' }, request_id: rid() });
  }
  if (u.pathname === '/api/v1/tools/enhance-video' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)).toString() || '{}');
    entry.body = b;
    if (b.client_token && byToken.has(b.client_token)) return json(res, 200, { success: true, task_id: byToken.get(b.client_token), request_id: rid() });
    const fid = String(b.video_url || '').replace('mediakit://', '');
    const inFile = uploads.get(fid);
    if (!inFile) return json(res, 400, { success: false, error: { code: 'InvalidParameter', message: 'video_url not uploaded' } });
    if (b.resolution !== '2k') return json(res, 400, { success: false, error: { code: 'InvalidParameter', message: 'resolution' } });
    const id = 'amk-tool-enhance-video-' + rid();
    const t = { id, status: 'running', created_at: Math.floor(Date.now() / 1000), params: b, out: path.join(DIR, 'out_' + id + '.mp4'), auth_key: rid() };
    tasks.set(id, t);
    if (b.client_token) byToken.set(b.client_token, id);
    if (failNext) {
      failNext = false;
      setTimeout(() => { t.status = 'failed'; t.error = { code: 'TaskFailed', type: 'TaskError', message: 'mock: source video decode failed' }; }, 1500);
    } else {
      const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', inFile, '-vf', 'scale=-2:1440:flags=lanczos', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', t.out], { stdio: 'ignore', windowsHide: true });
      p.on('close', (code) => { if (code === 0) { t.status = 'completed'; t.finished_at = Math.floor(Date.now() / 1000); } else { t.status = 'failed'; t.error = { code: 'TaskFailed', message: 'mock ffmpeg exit ' + code }; } });
    }
    return json(res, 200, { success: true, task_id: id, request_id: rid() });
  }
  if (u.pathname.startsWith('/api/v1/tasks/') && req.method === 'GET') {
    const t = tasks.get(decodeURIComponent(u.pathname.slice(14)));
    if (!t) return json(res, 404, { success: false, error: { code: 'NotFound', message: 'task not found' } });
    const base = { success: true, task_id: t.id, task_type: 'enhance-video', status: t.status, created_at: t.created_at, request_id: rid() };
    if (t.status === 'completed') return json(res, 200, { ...base, finished_at: t.finished_at, result: { video_url: 'http://127.0.0.1:' + PORT + '/out/' + t.id + '.mp4?auth_key=' + t.auth_key, resolution: '2k', tool_version: 'standard' } });
    if (t.status === 'failed') return json(res, 200, { ...base, error: t.error });
    return json(res, 200, base);
  }
  json(res, 404, { success: false, error: { code: 'NotFound', message: u.pathname } });
}).listen(PORT, '127.0.0.1', () => console.log('mock mediakit on ' + PORT));
