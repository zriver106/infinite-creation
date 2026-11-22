// 出片前「说话人 ↔ 绑定角色 ↔ 音色」检查（2026-11-18，A5-G11-2#26 复盘）。
// 背景：refs.js 只给「说话人名规范化后与本镜绑定角色名精确相等」的角色送音色参考。
// 台词写「同学男：」、绑定的却是「C065_B 正式同学男」时，音色被静默跳过，H3 自己编一个声音；
// 即使名字对上，角色挂的若是占位音色（a1 占位 wav，甚至借用别人的声音），出来的也是错的声音。
// 这里做成纯函数，tools.js 渲染前调用：说话人对不上 → 默认告警，显式配置 generation.speakerCheck=block 才拦截出片；说话人挂占位音色 → 告警。
import path from 'node:path';
import { dialogueSpeakerNames } from './prompts.js';
import { nameMatches, normalizeName } from '../shared/index.js';

// 非角色说话人（旁白/系统音等）默认豁免；可用 config.generation.speakerCheckExempt 覆盖。
export const DEFAULT_SPEAKER_EXEMPT = ['旁白', '画外音', '系统', '系统音', '提示音', '手机提示音', '广播'];
// 占位音色识别：文件名或资产名/描述里带「占位」「placeholder」，或文件 md5 在 config.generation.placeholderVoiceMd5 名单里。
export const PLACEHOLDER_NAME_RE = /占位|placeholder/i;

export function speakerCheckMode(cfg) {
  // 未配置时默认 warn（只告警不拦）；block 必须显式配置。
  const m = String(cfg?.generation?.speakerCheck || 'warn').toLowerCase();
  return m === 'block' || m === 'off' ? m : 'warn';
}

export function isPlaceholderVoice(asset, rel, { md5Of = null, placeholderMd5 = [] } = {}) {
  const r = String(rel || '');
  if (!r) return false;
  if (PLACEHOLDER_NAME_RE.test(path.basename(r))) return true;
  if (asset && (PLACEHOLDER_NAME_RE.test(String(asset.voice_desc || '')))) return true;
  const list = (placeholderMd5 || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  if (list.length && typeof md5Of === 'function') {
    const h = md5Of(r);
    if (h && list.includes(String(h).toUpperCase())) return true;
  }
  return false;
}

// 返回 { speakers, unmatched, placeholders, mode, blockMessage, warnMessage }
// chars：本镜绑定的角色资产（assembleShotReferences 返回的 chars）；assets：项目全部资产（找 audio_ids 里的独立音色）。
export function checkShotSpeakers({ shot, chars = [], assets = [], cfg = null, md5Of = null } = {}) {
  const mode = speakerCheckMode(cfg);
  const exempt = Array.isArray(cfg?.generation?.speakerCheckExempt) ? cfg.generation.speakerCheckExempt : DEFAULT_SPEAKER_EXEMPT;
  const speakers = dialogueSpeakerNames(shot?.dialogue);
  // 说话人若由本镜 audio_ids 里的独立 voice 资产承担（名字以说话人开头，如「系统音色」），也算有着落
  const audioNames = (shot?.audio_ids || []).map((id) => assets.find((a) => a.id === id)).filter((a) => a && a.category === 'voice').map((a) => normalizeName(a.name));
  const covered = (s) => chars.some((c) => nameMatches(s, c.name))
    || exempt.some((e) => nameMatches(s, e))
    || audioNames.some((n) => n && normalizeName(s) && n.startsWith(normalizeName(s)));
  const unmatched = speakers.filter((s) => !covered(s));
  const placeholders = [];
  for (const c of chars) {
    if (!speakers.some((s) => nameMatches(s, c.name))) continue; // 只管开口的人
    const voices = String(c.voice_ref || '').split(/[\n,;，；]+/).map((x) => x.trim()).filter(Boolean);
    if (!voices.length) { placeholders.push({ name: c.name, voice_ref: '', reason: '无音色' }); continue; }
    for (const v of voices) {
      if (isPlaceholderVoice(c, v, { md5Of, placeholderMd5: cfg?.generation?.placeholderVoiceMd5 })) placeholders.push({ name: c.name, voice_ref: v, reason: '占位音色' });
    }
  }
  const names = chars.map((c) => c.name).join('、') || '（无）';
  const blockMessage = unmatched.length && mode === 'block'
    ? '对白说话人「' + unmatched.join('、') + '」与本镜绑定角色名不完全一致（本镜角色：' + names + '），音色不会送出，已拦截出片。'
      + '请把台词说话人改成与绑定角色同名，或把对应角色绑进本镜（每行台词只写一个说话人）。'
    : '';
  const warnMessage = placeholders.length
    ? '说话角色的音色是占位/缺失，出片声音不可信：' + placeholders.map((p) => p.name + '（' + (p.voice_ref || p.reason) + '）').join('、')
    : '';
  return { speakers, unmatched, placeholders, mode, blockMessage, warnMessage };
}
