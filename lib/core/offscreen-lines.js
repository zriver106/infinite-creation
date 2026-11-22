// 画外台词不进段文件（2026-11-18，重启包）：心声/OS、电话那头、广播、系统音、旁白等「画外」台词
// 不进生成段的 <d>、不拿段内音色参考；改为写进「画外音声源清单」，后期按时间窗用说话人本人的声线样本配音。
// 依据：本地H3生产工作流.md r58（§0「画外音」条：心声、系统音、旁白、电话人声不进生成，只在 windows 登记，后期分轨配音）；
//      剪辑与配乐基础规范.md v3 §8 D19。两份文档在 moviePro\docs，不在本仓库。
// 入画台词（普通「人物：台词」）一律不变。纯函数（写文件的 writeVoiceSourceManifest 只写调用方给的目录）。
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

// 某个角色在画外说话（「江澈（OS）」「苏晴（电话）」「江澈OS」「电话里的王总」）：dialogueSpeakerNames 跳过这类行，
// 角色就不会因为这句拿到段内音色参考。说话人名本身是「系统」「广播」「旁白」的行照旧算说话人名（不是角色，本来就不配角色音色，
// 说话人闸门 v2 对它们有豁免名单），但仍不进 <d>、进画外音声源清单。
export function isOffscreenPersonLine(line) {
  const l = parseDialogueLine(line);
  return !!l.kind && l.source !== 'name';
}

// 只留入画台词（含无冒号的描述行），画外台词整行去掉。
export function onscreenDialogue(dialogue) {
  if (!dialogue) return '';
  return String(dialogue).split(/\r?\n/).filter((l) => !l.trim() || !isOffscreenLine(l)).join('\n').trim();
}

export function offscreenLines(dialogue) {
  return parseDialogue(dialogue).filter((l) => l.kind);
}

const KIND_LABEL = { os: '心声/OS', phone: '电话那头', broadcast: '广播', system: '系统音', narration: '旁白' };
export function offscreenKindLabel(kind) { return KIND_LABEL[kind] || kind; }

// 给写提示词的模型的一句话说明（brief、writeShotVideoPrompt 共用）
export function offscreenPromptNote(dialogue) {
  const off = offscreenLines(dialogue);
  if (!off.length) return '';
  return '画外台词（' + off.map((l) => offscreenKindLabel(l.kind) + '·' + l.speaker + '：' + l.text).join('；')
    + '）不进本段：不写进 <d>、不写 off-screen voiceover / 电话声 / 广播声句子、不引用音色；这段时间写入画人物的闭嘴表演'
    + '（眼、眉、头、手、道具 + 一句自然闭嘴句），电话那头/广播的人不入画；音频后期按时间窗用说话人本人声线样本配。';
}

const norm = (s) => String(s || '').replace(/[\s，。、,.!！?？…—\-~～“”"'‘’：:；;()（）]/g, '');

// video_prompt 的 <d> 里出现了画外台词原话 → 返回这些行
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

// 说话人本人的声线样本资产：先找同名角色（有 voice_ref），再找同名 voice 类资产
export function voiceSampleFor(speaker, assets = []) {
  const n = normalizeName(speaker);
  if (!n) return null;
  const same = (a) => normalizeName(a.name) === n;
  const ch = assets.find((a) => a && a.category === 'character' && same(a) && a.voice_ref);
  if (ch) return { asset_id: ch.id, voice_ref: String(ch.voice_ref).split(/[\n,;，；]+/)[0].trim() };
  const v = assets.find((a) => a && a.category === 'voice' && same(a) && (a.voice_ref || a.audio_path));
  if (v) return { asset_id: v.id, voice_ref: v.voice_ref || v.audio_path };
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

// 渲染前检查口径同闸门 v2：默认 warn；generation.offscreenCheck=block 拦截，=off 关闭
export function offscreenCheckMode(cfg) {
  const m = String(cfg?.generation?.offscreenCheck || 'warn').toLowerCase();
  return m === 'block' || m === 'off' ? m : 'warn';
}
