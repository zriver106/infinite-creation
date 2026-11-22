// 资产复用 / 保护 / 名字对齐的纯函数（无数据库、无渲染）。
// 供 tools.js、HTTP PATCH、离线单元验证共用。
import path from 'node:path';
import { nameMatches, normalizeName } from './index.js';

/** 已上传且完成的成品图：禁止因提示词变更被自动重画或覆盖。 */
export function uploadedImageProtected(asset) {
  return !!(asset && asset.source === 'uploaded' && asset.status === 'done' && asset.image_path);
}

/** 批量出图 / 待办判定：已上传成品跳过；其余仍按「有图且提示词未变」跳过。 */
export function shouldSkipAssetImage(asset) {
  if (uploadedImageProtected(asset)) return true;
  return !!(asset && asset.image_path && asset.status === 'done' && (asset.prompt_used || '') === (asset.prompt || ''));
}

/**
 * 已有可用 voice_ref 的人物跳过音色生成。
 * fileExists(rel) 由调用方注入（避免本模块碰项目路径）。
 */
export function shouldSkipDesignVoice(asset, fileExists) {
  const ref = asset && String(asset.voice_ref || '').trim();
  if (!ref) return false;
  if (typeof fileExists === 'function') {
    try { return !!fileExists(ref); } catch { return false; }
  }
  return true;
}

/** 给已上传人物补登记音色时，不得把 source 改成 generated。 */
export function patchWithoutClobberingUploadedSource(asset, patch) {
  const out = { ...patch };
  if (asset && asset.source === 'uploaded' && Object.prototype.hasOwnProperty.call(out, 'source')) {
    delete out.source;
  }
  return out;
}

/**
 * 从 name→id 表解析名字：精确命中优先，否则唯一的 nameMatches 命中。
 * 0 个或多个模糊命中视为未找到（避免把 A 绑到 B）。
 */
export function resolveNameFromMap(map, rawName) {
  const n = String(rawName == null ? '' : rawName);
  if (!n || !map) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, n) && map[n] != null) return map[n];
  const keys = Object.keys(map).filter((k) => nameMatches(k, n));
  if (keys.length === 1) return map[keys[0]];
  return undefined;
}

/**
 * 在资产列表里按名字查找：精确 + parent 优先，否则唯一 nameMatches。
 * isVariant 时还要比 parent_id。
 */
export function findExistingByName(list, name, { parentId = '', isVariant = false } = {}) {
  const items = Array.isArray(list) ? list : [];
  const want = String(name == null ? '' : name);
  const parentOk = (a) => !isVariant || (a.parent_id || '') === (parentId || '');
  const exact = items.find((a) => a && a.name === want && parentOk(a));
  if (exact) return exact;
  const fuzzy = items.filter((a) => a && nameMatches(a.name, want) && parentOk(a));
  if (fuzzy.length === 1) return fuzzy[0];
  return null;
}

/** 去掉角色名前缀和常见分隔符后的服装短名，用于「江澈·xxx」与「江澈-xxx」对齐。 */
export function costumeVariantKey(name, charName) {
  let s = String(name == null ? '' : name).trim();
  const cn = String(charName == null ? '' : charName).trim();
  if (cn) {
    if (s.startsWith(cn)) s = s.slice(cn.length);
    else {
      const ns = normalizeName(s);
      const nc = normalizeName(cn);
      if (nc && ns.startsWith(nc)) s = ns.slice(nc.length);
    }
  }
  s = String(s).replace(/^[\s·•・.。\-_—]+/, '').trim();
  return normalizeName(s).replace(/[-_—]/g, '');
}

/**
 * 换装去重：精确「角色名-短名/描述」，或规范化后短名相同，或 description 精确等于 outfit。
 */
export function findExistingCostume(list, char, { label = '', outfit = '', name = '' } = {}) {
  const items = Array.isArray(list) ? list : [];
  const charId = char && char.id;
  const charName = (char && char.name) || '';
  const scoped = items.filter((a) => a && a.parent_id === charId);
  const wantedName = String(name || (charName + '-' + (label || outfit || ''))).trim();
  if (wantedName && wantedName !== (charName + '-')) {
    const exact = scoped.find((a) => a.name === wantedName);
    if (exact) return exact;
  }
  const keys = [];
  if (label) keys.push(costumeVariantKey(label, charName));
  if (outfit) keys.push(costumeVariantKey(outfit, charName));
  if (wantedName) keys.push(costumeVariantKey(wantedName, charName));
  const uniq = [...new Set(keys.filter(Boolean))];
  const byKey = scoped.filter((a) => {
    const k = costumeVariantKey(a.name, charName);
    return k && uniq.includes(k);
  });
  if (byKey.length === 1) return byKey[0];
  if (outfit) {
    const byDesc = scoped.filter((a) => String(a.description || '') === String(outfit));
    if (byDesc.length === 1) return byDesc[0];
  }
  return null;
}

/**
 * 只允许把人物 voice_ref 指到本项目 assets/voice/ 下已存在的文件。
 * resolveAbs(rel) 必须返回项目内绝对路径；越界或文件不存在则返回 null。
 */
export function sanitizeVoiceRef(rel, { resolveAbs, exists } = {}) {
  let s = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
  if (!s) return null;
  if (s.includes('\0') || s.includes('..') || s.startsWith('/') || s.startsWith('//') || /^[a-zA-Z]:/.test(s)) return null;
  if (!s.startsWith('assets/voice/')) return null;
  const rest = s.slice('assets/voice/'.length);
  if (!rest || rest.includes('/') || rest.startsWith('.')) return null;
  if (typeof resolveAbs === 'function') {
    const abs = resolveAbs(s);
    if (!abs) return null;
    const norm = path.normalize(String(abs));
    if (typeof exists === 'function') {
      if (!exists(norm)) return null;
    }
  } else if (typeof exists === 'function') {
    if (!exists(s)) return null;
  }
  return s;
}

export { nameMatches, normalizeName };
