// 全量测试预加载守卫（2026-11-17 第一批 v2）：用法
//   NODE_OPTIONS=--import=file:///<repo>/tests/helpers/gpu-guard-preload.mjs node --test ...
// NODE_OPTIONS 会被 node --test 起的每个测试子进程、以及测试自己 spawn 的 node 子进程继承，所以对所有测试文件生效。
//  1. 网络：在 net.Socket.prototype.connect 这一层拦截 8188 / 8189（ComfyUI）和 4610（线上后端），
//     以及任何非本机地址；fetch / http / https / WebSocket 最终都走这里。被拦时异步抛 ECONNREFUSED 风格错误，
//     并把「哪个测试文件、连哪里、调用栈」追加写进 IC_GUARD_LOG（JSON 行）。
//  2. 配置：IC_CONFIG 指向临时 config.json（llm / comfyui 的 baseUrl、url 都是 http://127.0.0.1:9）；
//     IC_DATA_DIR 指向每个进程自己的临时目录。测试文件自己再设的值优先（它们在 import lib 之前覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const BLOCKED_PORTS = new Set([8188, 8189, 4610]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '', undefined, null]);

function logBlocked(kind, target) {
  const rec = { t: new Date().toISOString(), pid: process.pid, file: process.argv[1] || '', kind, target, stack: String(new Error().stack || '').split('\n').slice(3, 12).map((s) => s.trim()) };
  const p = process.env.IC_GUARD_LOG;
  if (p) { try { fs.appendFileSync(p, JSON.stringify(rec) + '\n'); } catch {} }
  try { process.stderr.write('[IC-GUARD] 拦截 ' + kind + ' ' + target + ' ← ' + rec.file + '\n'); } catch {}
}

function targetOf(args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === 'object') return { port: a0.port, host: a0.host, path: a0.path };
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) return { port: a0, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (typeof a0 === 'string') return { path: a0 };
  return {};
}

if (!globalThis.__icGuardPreload) {
  globalThis.__icGuardPreload = true;
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = targetOf(args);
    if (!t.path) {
      const port = Number(t.port);
      const host = t.host == null ? '' : String(t.host).replace(/^\[|\]$/g, '');
      const blockedPort = BLOCKED_PORTS.has(port);
      const external = !LOOPBACK.has(host) && !/^127\./.test(host);
      if (blockedPort || external) {
        const target = (host || 'localhost') + ':' + port;
        logBlocked(blockedPort ? 'blocked-port' : 'external-host', target);
        const err = Object.assign(new Error('IC 测试守卫拦截连接 ' + target + (blockedPort ? '（8188/8189/4610 禁止）' : '（测试禁止连外网）')), { code: 'ECONNREFUSED', address: host, port });
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return origConnect.apply(this, args);
  };
  // fetch 层也拦一次并记日志（undici 最终也会走上面的 Socket.connect，这里是双保险，便于记下 URL）。
  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = async function guardedFetch(input, ...rest) {
      const href = (input && input.url) ? input.url : (input && input.href) ? input.href : String(input);
      let u = null; try { u = new URL(href); } catch {}
      if (u && /^(https?|wss?):$/.test(u.protocol)) {
        const port = Number(u.port || (/^(https|wss):$/.test(u.protocol) ? 443 : 80));
        const host = u.hostname.replace(/^\[|\]$/g, '');
        const blockedPort = BLOCKED_PORTS.has(port);
        const external = !LOOPBACK.has(host) && !/^127\./.test(host);
        if (blockedPort || external) {
          logBlocked(blockedPort ? 'blocked-port(fetch)' : 'external-host(fetch)', href);
          throw Object.assign(new TypeError('fetch failed: IC 测试守卫拦截 ' + href), { cause: { code: 'ECONNREFUSED' } });
        }
      }
      return origFetch.call(this, input, ...rest);
    };
    wrapped.__icGpuGuard = true;
    globalThis.fetch = wrapped;
  }
  // 临时配置 + 临时数据目录
  const root = process.env.IC_GUARD_TMP_ROOT || os.tmpdir();
  if (!process.env.IC_DATA_DIR || process.env.IC_DATA_DIR === process.env.IC_GUARD_DEFAULT_DATA) {
    const d = fs.mkdtempSync(path.join(root, 'icg-data-'));
    process.env.IC_DATA_DIR = d;
    process.env.IC_GUARD_DEFAULT_DATA = d;
  }
  if (!process.env.IC_CONFIG || process.env.IC_CONFIG === process.env.IC_GUARD_DEFAULT_CONFIG || /^https?:/.test(process.env.IC_CONFIG)) {
    const d = fs.mkdtempSync(path.join(root, 'icg-cfg-'));
    const cfg = path.join(d, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' },
      comfyui: { provider: 'native', url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9' },
      generation: { videosPerShot: 1 },
    }));
    process.env.IC_CONFIG = cfg;
    process.env.IC_GUARD_DEFAULT_CONFIG = cfg;
  }
}
