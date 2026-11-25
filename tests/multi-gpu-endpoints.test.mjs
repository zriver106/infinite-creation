// ic29 多显卡：本地 ComfyUI 多端点调度。全部用本进程内的 mock ComfyUI（随机端口），不碰 8188/8189/4610。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic29-mgpu-'));
process.env.IC_DATA_DIR = path.join(TMP, 'data');
process.env.IC_CONFIG = path.join(TMP, 'config.json');
fs.writeFileSync(process.env.IC_CONFIG, JSON.stringify({ comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:9' } }));

const core = await import('../lib/core/index.js');
const shared = await import('../lib/shared/index.js');
const pool = await import('../lib/core/comfy-pool.js');
const { resolveHardwareConfig, renderConcurrencyLimit, runRenderSlot, generateTask, uploadTaskInput, downloadTaskOutput, checkBackend, interruptTask, freeBackend } = core;

// —— mock ComfyUI ——
function mockComfy(name, { execMs = 80, failHistory = false } = {}) {
  const st = { name, prompts: [], uploads: [], interrupts: 0, frees: 0, running: 0, maxRunning: 0, events: [], done: new Map() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((r) => { const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => r(Buffer.concat(cs))); });
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '0.45.3-' + name, argv: [] }, devices: [{ name: 'cuda:0 mock-' + name, vram_free: 8 * 1024 ** 3 }] });
    if (url.pathname === '/upload/image') {
      const m = /filename="([^"]+)"/.exec(body.toString('latin1'));
      st.uploads.push(m ? m[1] : '?');
      st.events.push('upload:' + (m ? m[1] : '?'));
      return json({ name: m ? m[1] : '?' });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const p = JSON.parse(body.toString('utf8'));
      const id = name + '-' + (st.prompts.length + 1);
      st.prompts.push({ id, prompt: p.prompt });
      st.events.push('prompt:' + id);
      st.running++;
      st.maxRunning = Math.max(st.maxRunning, st.running);
      setTimeout(() => { st.running--; st.done.set(id, true); }, execMs);
      return json({ prompt_id: id });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length);
      if (!st.done.get(id)) return json({});
      if (failHistory) return json({ [id]: { status: { status_str: 'error', messages: [['execution_error', {}]] }, outputs: {} } });
      return json({ [id]: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: id + '.png', subfolder: '', type: 'output' }] } } } });
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      const running = st.prompts.filter((p) => !st.done.get(p.id)).map((p) => [0, p.id]);
      return json({ queue_running: running, queue_pending: [] });
    }
    if (url.pathname === '/queue') return json({});
    if (url.pathname === '/interrupt') { st.interrupts++; return json({}); }
    if (url.pathname === '/free') { st.frees++; return json({}); }
    if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('PNG-from-' + name)); }
    res.writeHead(404); res.end();
  });
  // WebSocket /ws：直接拒绝升级（generate 对 WS 失败是容错的）
  server.on('upgrade', (req, socket) => socket.destroy());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    st.url = 'http://127.0.0.1:' + server.address().port;
    st.close = () => new Promise((r) => server.close(r));
    resolve(st);
  }));
}

async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return 'http://127.0.0.1:' + port;
}

function cfgWith(endpoints) {
  const cfg = resolveHardwareConfig({ comfyui: { provider: 'native', endpoints } });
  fs.writeFileSync(process.env.IC_CONFIG, JSON.stringify(cfg));
  return cfg;
}

const WF = (img) => ({ 1: { class_type: 'LoadImage', inputs: { image: img || 'none.png' } }, 9: { class_type: 'SaveImage', inputs: { images: ['1', 0] } } });
const OPTS = { pollMs: 15, timeoutMs: 20_000 };

test.beforeEach(() => pool._resetPoolForTests());

test('旧配置（只有 baseUrl）自动迁移成单端点，并发仍为 1', () => {
  const cfg = resolveHardwareConfig({ comfyui: { provider: 'native', baseUrl: 'http://127.0.0.1:8189/' } });
  assert.deepStrictEqual(cfg.comfyui.endpoints, [{ id: 'gpu0', name: 'GPU 0', baseUrl: 'http://127.0.0.1:8189', gpu: '0', enabled: true }]);
  assert.strictEqual(cfg.comfyui.baseUrl, 'http://127.0.0.1:8189');
  assert.strictEqual(renderConcurrencyLimit(cfg), 1);
  // 完全没有 comfyui 段：默认单端点
  const d = resolveHardwareConfig({});
  assert.strictEqual(d.comfyui.endpoints.length, 1);
  assert.strictEqual(renderConcurrencyLimit(d), 1);
  // 迁移结果再解析一遍不变（幂等）
  assert.deepStrictEqual(resolveHardwareConfig(cfg).comfyui.endpoints, cfg.comfyui.endpoints);
});

test('有效并发 = 启用端点数；baseUrl 同步为第一个启用端点；重复地址与空地址不计', () => {
  const cfg = resolveHardwareConfig({ comfyui: { provider: 'native', baseUrl: 'http://old', endpoints: [
    { id: 'a', baseUrl: 'http://127.0.0.1:8190', gpu: '1', enabled: false },
    { id: 'b', baseUrl: 'http://127.0.0.1:8189', gpu: '0' },
    { id: 'c', baseUrl: 'http://127.0.0.1:8191/', gpu: '2', enabled: true },
    { id: 'd', baseUrl: 'http://127.0.0.1:8191', gpu: '2', enabled: true },
    { id: 'e', baseUrl: '  ', enabled: true },
  ] } });
  assert.strictEqual(cfg.comfyui.baseUrl, 'http://127.0.0.1:8189');
  assert.strictEqual(renderConcurrencyLimit(cfg), 2);
  assert.deepStrictEqual(shared.enabledComfyEndpoints(cfg.comfyui).map((e) => e.id), ['b', 'c']);
  // 云端模式不受端点影响
  assert.strictEqual(renderConcurrencyLimit({ ...cfg, comfyui: { ...cfg.comfyui, provider: 'runninghub' }, generation: { runninghubConcurrency: 3 } }), 3);
});

test('全部禁用：并发按 1 计，提交时给出明确错误', async () => {
  const cfg = cfgWith([{ id: 'a', baseUrl: 'http://127.0.0.1:9', enabled: false }]);
  assert.strictEqual(renderConcurrencyLimit(cfg), 1);
  await assert.rejects(generateTask(cfg, WF(), OPTS), /没有启用的本地 ComfyUI 端点/);
  const st = await checkBackend(cfg);
  assert.strictEqual(st.ok, false);
});

test('两个端点：4 个渲染按空闲端点分派，每端点同一时刻只跑 1 个，总并发 2', async () => {
  const A = await mockComfy('A', { execMs: 120 });
  const B = await mockComfy('B', { execMs: 120 });
  try {
    const cfg = cfgWith([{ id: 'g0', baseUrl: A.url, gpu: '0' }, { id: 'g1', baseUrl: B.url, gpu: '1' }]);
    assert.strictEqual(renderConcurrencyLimit(cfg), 2);
    const t0 = Date.now();
    const rs = await Promise.all([1, 2, 3, 4].map(() => runRenderSlot(() => generateTask(cfg, WF(), OPTS), {})));
    const ms = Date.now() - t0;
    assert.strictEqual(A.maxRunning, 1);
    assert.strictEqual(B.maxRunning, 1);
    assert.strictEqual(A.prompts.length + B.prompts.length, 4);
    assert.ok(A.prompts.length >= 1 && B.prompts.length >= 1, 'both endpoints used');
    // 产物带 endpoint 标记，且下载回到产出端点
    for (const r of rs) {
      const out = r.outputs[0];
      assert.ok(out.endpoint === A.url || out.endpoint === B.url);
      const buf = await downloadTaskOutput(cfg, out);
      assert.strictEqual(buf.toString(), 'PNG-from-' + (out.endpoint === A.url ? 'A' : 'B'));
    }
    // 串行要 ≥ 4×120ms；双端点应明显更快（宽松断言，避免 CI 抖动）
    assert.ok(ms < 4 * 120 + 300, 'parallel wall time ' + ms + 'ms');
  } finally { await A.close(); await B.close(); }
});

test('参考图：先传到一个端点，渲染被派到另一个端点时提交前自动补传；内容变化会重传', async () => {
  const A = await mockComfy('A', { execMs: 300 });
  const B = await mockComfy('B', { execMs: 30 });
  try {
    const cfg = cfgWith([{ id: 'g0', baseUrl: A.url, gpu: '0' }, { id: 'g1', baseUrl: B.url, gpu: '1' }]);
    const f = path.join(TMP, 'ref.png');
    fs.writeFileSync(f, 'ref-v1');
    assert.strictEqual(await uploadTaskInput(cfg, f, 'ic_ref_1.png'), 'ic_ref_1.png');
    assert.deepStrictEqual(A.uploads, ['ic_ref_1.png']);
    assert.deepStrictEqual(B.uploads, []);
    // 让 A 忙着，第二个渲染只能去 B
    const busyA = generateTask(cfg, WF('ic_ref_1.png'), OPTS);
    await new Promise((r) => setTimeout(r, 40));
    await generateTask(cfg, WF('ic_ref_1.png'), OPTS);
    await busyA;
    assert.strictEqual(A.uploads.filter((n) => n === 'ic_ref_1.png').length, 1, 'A 已有，不重复上传');
    assert.deepStrictEqual(B.events.slice(0, 2), ['upload:ic_ref_1.png', 'prompt:B-1'], 'B 先补传再提交');
    // 同名文件内容变了（换图后重新上传同一个文件名）：B 下次被派到时要重传
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(f, 'ref-v2-longer');
    await uploadTaskInput(cfg, f, 'ic_ref_1.png');
    const busyA2 = generateTask(cfg, WF('ic_ref_1.png'), OPTS);
    await new Promise((r) => setTimeout(r, 40));
    await generateTask(cfg, WF('ic_ref_1.png'), OPTS);
    await busyA2;
    assert.strictEqual(B.uploads.filter((n) => n === 'ic_ref_1.png').length, 2);
  } finally { await A.close(); await B.close(); }
});

test('单个端点挂掉：提交前连不上 → 冷却并改派其它端点；就绪检查仍 ok', async () => {
  const dead = await deadUrl();
  const B = await mockComfy('B', { execMs: 30 });
  try {
    const cfg = cfgWith([{ id: 'g0', name: '坏卡', baseUrl: dead, gpu: '0' }, { id: 'g1', baseUrl: B.url, gpu: '1' }]);
    const r = await generateTask(cfg, WF(), OPTS);
    assert.strictEqual(r.endpoint, B.url);
    const ps = pool.poolStatus(cfg);
    assert.strictEqual(ps.failovers, 1);
    assert.strictEqual(ps.endpoints[0].cooling, true);
    assert.ok(ps.endpoints[0].lastError.includes('无法连接 ComfyUI'));
    // 冷却期间第二个渲染直接去 B，不再先撞坏端点
    await generateTask(cfg, WF(), OPTS);
    assert.strictEqual(pool.poolStatus(cfg).failovers, 1);
    assert.strictEqual(B.prompts.length, 2);
    // 上传：坏端点排第一也能落到 B
    const f = path.join(TMP, 'ref2.png');
    fs.writeFileSync(f, 'x');
    await uploadTaskInput(cfg, f, 'ic_ref_2.png');
    assert.deepStrictEqual(B.uploads, ['ic_ref_2.png']);
    const st = await checkBackend(cfg);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.okCount, 1);
    assert.strictEqual(st.total, 2);
    assert.strictEqual(st.endpoints[0].ok, false);
    assert.strictEqual(st.device, 'cuda:0 mock-B');
    // interrupt / free：有一个端点成功就不抛
    await interruptTask(cfg);
    await freeBackend(cfg);
    assert.strictEqual(B.interrupts, 1);
    assert.strictEqual(B.frees, 1);
  } finally { await B.close(); }
});

test('提交之后的失败（执行出错）不改派：同一镜不会在另一张卡上重复出片', async () => {
  const A = await mockComfy('A', { execMs: 20, failHistory: true });
  const B = await mockComfy('B', { execMs: 20 });
  try {
    const cfg = cfgWith([{ id: 'g0', baseUrl: A.url }, { id: 'g1', baseUrl: B.url }]);
    await assert.rejects(generateTask(cfg, WF(), OPTS), /ComfyUI 执行出错/);
    assert.strictEqual(A.prompts.length, 1);
    assert.strictEqual(B.prompts.length, 0);
    assert.strictEqual(pool.poolStatus(cfg).endpoints[0].cooling, false, '执行错误不是端点故障，不冷却');
  } finally { await A.close(); await B.close(); }
});

test('全部端点都连不上：抛出最后一个连接错误（不无限重试）', async () => {
  const d1 = await deadUrl();
  const d2 = await deadUrl();
  const cfg = cfgWith([{ id: 'g0', baseUrl: d1 }, { id: 'g1', baseUrl: d2 }]);
  await assert.rejects(generateTask(cfg, WF(), OPTS), /无法连接 ComfyUI/);
  assert.strictEqual(pool.poolStatus(cfg).failovers, 1);
});

test('单端点（旧配置迁移后）：行为与改动前一致，打到原地址', async () => {
  const A = await mockComfy('A', { execMs: 20 });
  try {
    const cfg = resolveHardwareConfig({ comfyui: { provider: 'native', baseUrl: A.url } });
    fs.writeFileSync(process.env.IC_CONFIG, JSON.stringify(cfg));
    const r = await generateTask(cfg, WF(), OPTS);
    assert.strictEqual(r.endpoint, A.url);
    // 无 endpoint 标记的老产物：回退到第一个端点
    const buf = await downloadTaskOutput(cfg, { filename: 'old.png', subfolder: '', type: 'output' });
    assert.strictEqual(buf.toString(), 'PNG-from-A');
    await interruptTask(cfg);
    assert.strictEqual(A.interrupts, 1);
    // 单端点连不上：照旧直接抛错
    const dead = await deadUrl();
    const cfg2 = resolveHardwareConfig({ comfyui: { provider: 'native', baseUrl: dead } });
    await assert.rejects(generateTask(cfg2, WF(), OPTS), /无法连接 ComfyUI/);
  } finally { await A.close(); }
});
