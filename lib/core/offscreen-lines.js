// 画外台词识别（心声/OS、电话那头、广播、系统音、旁白）。
// 现行口径（2026-11-22，dev 7d1365f「作废心声/电话声走后期旧口径，全部台词由 H3 直出」）：画外台词和入画台词一样写进
// video_prompt 的 <d>，由 H3 直接念出；角色的画外台词（心声/OS、电话那头）用说话人本人的音色参考（refs.js 经
// prompts.js dialogueVoiceSpeakers 取说话人）。旁白/广播/系统音不是角色，不配角色音色，照旧走分镜绑定的 audios。
// 旧口径（2026-11-18，r58：画外台词不进 <d>、不拿音色、后期按画外音声源清单配音）已作废；
// 画外音声源清单（buildVoiceSourceManifest）保留，仅作登记/核对，不再是「台词不进段」的理由。
// 纯函数（写文件的 writeVoiceSourceManifest 只写调用方给的目录）。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeName } from '../shared/index.js';

// 括号里的标记（「江澈（OS）：」「苏晴（电话）：」「唐知夏（C005，电话）：」）——按逗号/顿号/空格拆开后有一项完全等于下表才算；
// 「林默（对着电话）：」是入画的人对着电话说话，不算。
const MARK_KIND = [
  ['os', /^(?:os|o\.s\.?|vo|v\.o\.?|心声|内心|内心独白|内心os|画外|画外音|画外声)$/i],
  ['phone', /^(?:电话|电话里|电话中|电话那头|电话声|电话音|听筒|听筒里|手机里|免提)$/],
  ['broadcast', /^(?:广播|广播里|广播声|喇叭|喇叭里|扩音器|电视|电视里|收音机|收音机里|录音|录音里|对讲机|对讲机里)$/],
  ['system', /^(?:系统|系统音|系统声|系统提示|系统提示音)$/],
  ['narration', /^(?:旁白)$/],
];
// 说话人名本身就是画外声源（「系统：」「广播：」「旁白：」）
const NAME_KIND = [
  ['system', /^(?:系统|系统音|系统提示|系统提示音)$/],
  ['broadcast', /^(?:广播|喇叭|广播员|电视|收音机)$/],
  ['narration', /^(?:旁白)$/],
  ['os', /^(?:画外音|心声|内心独白)$/],
];
// 前缀写法：「电话里的苏晴：」「电话那头苏晴：」「广播里的主持人：」
const PREFIX_KIND = [
  ['phone', /^(?:电话里|电话那头|电话中|听筒里|手机里)的?(.+)$/],
  ['broadcast', /^(?:广播里|电视里|收音机里|喇叭里|对讲机里)的?(.+)$/],
];

function markKind(token) {
  const t = String(token || '').trim();
  for (const [k, re] of MARK_KIND) if (re.test(t)) return k;
  return null;
}

function cleanName(s) {
  return String(s || '')
    .replace(/[(（][^()（）]*[)）]/g, '')
    .replace(/[，。、,;；!！?？.·]+$/g, '')
    .trim();
}

// 解析一行台词：{ raw, speaker, text, kind, marker, source }；kind 为 null 表示入画台词；没有「名字：」的描述行 speaker 为 ''。
// source：'bracket'（名字后括号标记）/ 'suffix'（江澈OS）/ 'prefix'（电话里的王总）/ 'name'（说话人名本身就是「系统」「广播」「旁白」）。
export function parseDialogueLine(line) {
  const raw = String(line == null ? '' : line);
  const t = raw.trim();
  const m = t.match(/^(.+?)[：:]/);
  if (!m) return { raw, speaker: '', text: t, kind: null, marker: '', source: '' };
  const head = m[1];
  const text = t.slice(m[0].length).trim();
  let kind = null;
  let marker = '';
  let source = '';
  for (const b of head.matchAll(/[(（]([^()（）]*)[)）]/g)) {
    for (const tok of b[1].split(/[，,、\s/]+/)) {
      const k = markKind(tok);
      if (k) { kind = k; marker = tok.trim(); source = 'bracket'; break; }
    }
    if (kind) break;
  }
  let speaker = cleanName(head);
  if (!kind) {
    const os = speaker.match(/^(.+?)\s*(OS|VO|O\.S\.?|V\.O\.?)$/i);
    if (os && os[1].trim()) { kind = 'os'; marker = os[2]; speaker = os[1].trim(); source = 'suffix'; }
  }
  if (!kind) {
    for (const [k, re] of PREFIX_KIND) {
      const pm = speaker.match(re);
      if (pm && pm[1].trim()) { kind = k; marker = speaker.slice(0, speaker.length - pm[1].length).replace(/的$/, ''); speaker = pm[1].trim(); source = 'prefix'; break; }
    }
  }
  if (!kind) {
    for (const [k, re] of NAME_KIND) if (re.test(speaker)) { kind = k; marker = speaker; source = 'name'; break; }
  }
  return { raw, speaker, text, kind, marker, source };
}

export function parseDialogue(dialogue) {
  if (!dialogue) return [];
  return String(dialogue).split(/\r?\n/).filter((l) => l.trim()).map(parseDialogueLine);
}

export function isOffscreenLine(line) {
  return !!parseDialogueLine(line).kind;
}

// 某个人在画外说话（「江澈（OS）」「苏晴（电话）」「江澈OS」「电话里的王总」「广播里的主持人」）：dialogueSpeakerNames
// 跳过这类行——它只列「入画说话人」（单镜入画说话人上限、说话人↔绑定角色检查用）。说话人名本身是「系统」「广播」「旁白」的行
// 照旧算说话人名（不是角色，不配角色音色，说话人闸门 v2 对它们有豁免名单）。
export function isOffscreenPersonLine(line) {
  const l = parseDialogueLine(line);
  return !!l.kind && l.source !== 'name';
}

// 要配「说话人本人音色」的画外台词种类：心声/OS、电话那头。广播/系统音/旁白不是角色，不配角色音色。
export const VOICED_OFFSCREEN_KINDS = ['os', 'phone'];

// 角色的画外台词（心声/OS、电话那头），说话人名不是「系统/广播/旁白」这类非角色声源 → 要拿本人音色参考的行
export function offscreenVoiceLines(dialogue) {
  return parseDialogue(dialogue).filter((l) => l.speaker && VOICED_OFFSCREEN_KINDS.includes(l.kind) && l.source !== 'name');
}

// 只留入画台词（含无冒号的描述行），画外台词整行去掉。2026-11-22 起写提示词/兜底提示词不再用它删台词（全部台词由 H3 直出）。
export function onscreenDialogue(dialogue) {
  if (!dialogue) return '';
  return String(dialogue).split(/\r?\n/).filter((l) => !l.trim() || !isOffscreenLine(l)).join('\n').trim();
}

export function offscreenLines(dialogue) {
  return parseDialogue(dialogue).filter((l) => l.kind);
}

const KIND_LABEL = { os: '心声/OS', phone: '电话那头', broadcast: '广播', system: '系统音', narration: '旁白' };
export function offscreenKindLabel(kind) { return KIND_LABEL[kind] || kind; }

// 给写提示词的模型的一句话说明（brief、writeShotVideoPrompt 共用）。现行口径（2026-11-22）：画外台词也写 <d>、由 H3 直出。
export function offscreenPromptNote(dialogue) {
  const off = offscreenLines(dialogue);
  if (!off.length) return '';
  return '画外台词（' + off.map((l) => offscreenKindLabel(l.kind) + '·' + l.speaker + '：' + l.text).join('；')
    + '）也写进 <d> 由 H3 直接念出，与 dialogue 逐字一致，不删、不合并、不走后期：'
    + '心声/OS 用 h3-prompt-writing 的心声固定句（off-screen inner-monologue voice … narrates <d>…</d>，入画人物闭嘴）；'
    + '电话那头写成听筒里传出的声音，接听人闭嘴听，来电人可不入画；'
    + '心声/电话声引用说话人本人的音色参考（参考素材里「某某的声音」那一项），一人一个声线。';
}

const norm = (s) => String(s || '').replace(/[\s，。、,.!！?？…—\-~～“”"'‘’：:；;()（）]/g, '');

// video_prompt 的 <d> 里出现了画外台词原话 → 返回这些行。
// 2026-11-22 起不再用于告警/拦截（现行口径画外台词本来就该进 <d>），保留作工具函数。
export function offscreenLinesInPrompt(prompt, dialogue) {
  const off = offscreenLines(dialogue).filter((l) => norm(l.text).length >= 2);
  if (!off.length) return [];
  const bodies = [...String(prompt || '').matchAll(/<d>([\s\S]*?)<\/d>/g)].map((m) => norm(m[1].replace(/^\s*\[[^\]]*\]/, '')));
  return off.filter((l) => {
    const t = norm(l.text);
    return bodies.some((b) => b && (b.includes(t) || (b.length >= 4 && t.includes(b))));
  });
}

// 子分镜时间轴里找这句台词所在的时间窗（「0-3秒（…）：…台词：江澈（OS）：……」），找不到返回 null
export function lineWindow(subShots, text) {
  const s = String(subShots || '');
  const key = String(text || '').trim().slice(0, 8);
  if (!s || !key) return null;
  const at = s.indexOf(key);
  if (at < 0) return null;
  let win = null;
  const re = /(\d+(?:\.\d+)?)\s*[-~—–至到]\s*(\d+(?:\.\d+)?)\s*秒/g;
  let m;
  while ((m = re.exec(s)) !== null && m.index <= at) win = { start: parseFloat(m[1]), end: parseFloat(m[2]) };
  return win;
}

// 说话人本人的声线样本资产：先找同名角色（有 voice_ref），再找同名 voice 类资产（名为「王总」或「王总音色」）。
// refs.js 给不在本镜 character_ids 里的画外说话人（电话那头没入画的人）按名字找音色也用它。
export function voiceSampleFor(speaker, assets = []) {
  const n = normalizeName(speaker);
  if (!n) return null;
  const same = (a) => normalizeName(a.name) === n;
  const firstRef = (s) => String(s || '').split(/[\n,;，；]+/).map((x) => x.trim()).filter(Boolean)[0] || '';
  const ch = assets.find((a) => a && a.category === 'character' && same(a) && firstRef(a.voice_ref));
  if (ch) return { asset_id: ch.id, voice_ref: firstRef(ch.voice_ref), asset: ch };
  const v = assets.find((a) => a && a.category === 'voice' && (same(a) || normalizeName(a.name) === n + '音色') && (a.voice_ref || a.audio_path));
  if (v) return { asset_id: v.id, voice_ref: v.voice_ref || v.audio_path, asset: v };
  return null;
}

// 生成一章的画外音声源清单：每条画外台词一条（镜、时间窗、原话、说话人、说话人本人声线样本资产 id）
export function buildVoiceSourceManifest({ chapter = '', shots = [], assets = [] } = {}) {
  const entries = [];
  const sorted = [...shots].filter((s) => s && s.status !== 'obsolete').sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  for (const s of sorted) {
    for (const l of offscreenLines(s.dialogue)) {
      const win = lineWindow(s.sub_shots, l.text);
      const vs = voiceSampleFor(l.speaker, assets);
      const issues = [];
      if (!win) issues.push('子分镜时间轴里没找到这句，时间窗待定');
      if (!vs && !['system', 'broadcast', 'narration'].includes(l.kind)) issues.push('没找到说话人本人的声线样本');
      entries.push({
        shot_id: s.id, shot_idx: s.idx, kind: l.kind, marker: l.marker, speaker: l.speaker, text: l.text,
        window: win, voice_asset_id: vs ? vs.asset_id : null, voice_ref: vs ? vs.voice_ref : null, issues,
      });
    }
  }
  return { version: 1, type: 'voice-source-manifest', chapter, generated_at: new Date().toISOString(), entries };
}

export function voiceSourceManifestName(chapter) {
  return 'manifest_' + (String(chapter || '未分章').replace(/[\\/:*?"<>|\s]+/g, '_') || '未分章') + '.json';
}

// 写到调用方给的目录（tools.js 传 <项目目录>/画外音声源）；没有画外台词也写一份空清单，表示已检查过。
export function writeVoiceSourceManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, voiceSourceManifestName(manifest.chapter));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

// 旧口径「<d> 里有画外台词原话就告警/拦截」的开关（generation.offscreenCheck）。2026-11-22 起出片前不再做这项检查
//（tools.js 已去掉调用，配了 warn/block 也不生效），默认 off；函数只为兼容旧配置/旧调用保留。
export function offscreenCheckMode(cfg) {
  const m = String(cfg?.generation?.offscreenCheck || 'off').toLowerCase();
  return m === 'block' || m === 'warn' ? m : 'off';
}
