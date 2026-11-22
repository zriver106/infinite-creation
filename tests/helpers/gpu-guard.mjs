// 测试用：把 LLM / Comfy 指到不可达的 :9，并拦截任何打向 8188/8189 的 fetch / http / https。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const BLOCKED = [':8188', ':8189'];

export function blockedUrl(u) {
  const s = String(u || '');
  return BLOCKED.some((p) => s.includes(p));
}

export function installGpuGuard() {
  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function' && !globalThis.fetch.__icGpuGuard) {
    const wrapped = async (url, ...rest) => {
      const href = (url && url.url) ? url.url : (url && url.href) ? url.href : String(url);
      if (blockedUrl(href)) throw new Error('fetch 守卫拦截了 8188/8189 请求：' + href);
      return origFetch(url, ...rest);
    };
    wrapped.__icGpuGuard = true;
    globalThis.fetch = wrapped;
  }
  function wrap(label, orig) {
    if (!orig || orig.__icGpuGuard) return orig;
    const fn = function guarded(...args) {
      const a0 = args[0];
      const target = (a0 && a0.href) ? a0.href
        : (typeof a0 === 'string' ? a0
          : [a0 && a0.host, a0 && a0.hostname, a0 && a0.port].filter(Boolean).join(':'));
      if (blockedUrl(target) || (a0 && (String(a0.port) === '8188' || String(a0.port) === '8189'))) {
        throw new Error(label + ' 守卫拦截了 8188/8189 请求：' + target);
      }
      return orig.apply(this, args);
    };
    fn.__icGpuGuard = true;
    return fn;
  }
  http.request = wrap('http.request', http.request);
  https.request = wrap('https.request', https.request);
  http.get = wrap('http.get', http.get);
  https.get = wrap('https.get', https.get);
}

export function writeTempIcConfig(dir) {
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock' },
    comfyui: { url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9', provider: 'native' },
    generation: { videosPerShot: 1 },
  }));
  process.env.IC_DATA_DIR = path.join(dir, 'data');
  process.env.IC_CONFIG = cfgPath;
  return cfgPath;
}
