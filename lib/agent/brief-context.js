// 写稿 brief 补数据（主会话 seq2227 第4件；站位会话同一件）：
//   prev_shot / prev_chapter_last_shot：上一镜、上一集末镜的状态（每人绑的服装、画面里写的伤妆姿态），跨镜跨集接得上；
//   scene_cast：同场（同一地点、连续的几镜）在场人物名单，和 scene_blocking 站位表一起用；
//   speaker_voices：本镜说话人音色资产的性别和音高。
// 只读，不写库。被 prompt-write-mcp.js 的 get_shot_prompt_brief 引用。
import { Shots } from '../core/index.js';
import { dialogueVoiceSpeakers } from '../core/prompts.js';
import { nameMatches } from '../shared/index.js';
import { placeKey, placeOf } from './binding-check.js';

const stripAdmin = (t) => String(t || '').replace(/^(?:\s*(?:我方资产ID|审核|挂在角色)[^；;]*[；;])+\s*/, '').trim();
const cut = (t, n) => { const s = String(t || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const isMv = (a) => a && a.category === 'scene' && /_MV|多视角定义图/.test(String(a.name || ''));


function stateOf(shot, byId) {
  const costumes = new Map();
  for (const cid of shot.costume_ids || []) { const c = byId.get(cid); if (c && c.category === 'costume') costumes.set(c.parent_id, c); }
  const people = (shot.character_ids || []).map((id) => byId.get(id)).filter((a) => a && a.category === 'character').map((c) => {
    const cos = costumes.get(c.id);
    return { name: c.name, costume: cos ? cos.name : '', costume_desc: cos ? cut(stripAdmin(cos.description), 160) : '' };
  });
  return { idx: shot.idx, chapter: shot.chapter, scene_name: shot.scene_name || '', people, visual: cut(shot.visual, 600), ...(shot.sub_shots ? { sub_shots_tail: cut(String(shot.sub_shots).slice(-300), 300) } : {}) };
}

/** 上一镜（同章叙事顺序的前一镜）；本镜是本章第一镜、或和上一集末镜同地点时，另给上一集末镜。 */
export function prevStates(projectId, shot, assets, all = Shots.listInNarrativeOrder(projectId)) {
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const mvs = (assets || []).filter(isMv);
  const list = all.filter((s) => s.chapter === shot.chapter);
  const i = list.findIndex((s) => s.id === shot.id);
  const out = {};
  if (i > 0) out.prev_shot = stateOf(list[i - 1], byId);
  const chs = [...new Set(all.map((s) => s.chapter))];
  const ci = chs.indexOf(shot.chapter);
  if (ci > 0) {
    const prevCh = all.filter((s) => s.chapter === chs[ci - 1]);
    const last = prevCh[prevCh.length - 1];
    if (last && (i === 0 || (placeOf(last, byId, mvs) && placeOf(last, byId, mvs) === placeOf(shot, byId, mvs)))) out.prev_chapter_last_shot = stateOf(last, byId);
  }
  return out;
}

/** 同场在场人物：本章里和本镜同一地点、连续的那一段镜（中间没有换到别的地点），所有镜绑过的人物。 */
export function sceneCast(projectId, shot, assets, all = Shots.listInNarrativeOrder(projectId)) {
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const mvs = (assets || []).filter(isMv);
  const list = all.filter((s) => s.chapter === shot.chapter);
  const i = list.findIndex((s) => s.id === shot.id);
  const key = placeOf(shot, byId, mvs);
  if (i < 0 || !key) return null;
  let a = i; let b = i;
  while (a > 0 && placeOf(list[a - 1], byId, mvs) === key) a--;
  while (b < list.length - 1 && placeOf(list[b + 1], byId, mvs) === key) b++;
  const names = []; const seen = new Set();
  for (let k = a; k <= b; k++) for (const id of list[k].character_ids || []) { const c = byId.get(id); if (c && c.category === 'character' && !seen.has(c.id)) { seen.add(c.id); names.push(c.name); } }
  const here = new Set((shot.character_ids || []).map((id) => (byId.get(id) || {}).name).filter(Boolean));
  const place = key.startsWith('mv:') ? placeKey((byId.get(key.slice(3)) || {}).name) : key.replace(/^(place|name):/, '');
  return { place, shots: list.slice(a, b + 1).map((s) => s.idx), present: names, in_this_shot: names.filter((n) => here.has(n)), not_in_this_shot: names.filter((n) => !here.has(n)) };
}

const PITCH_WORDS = ['低沉', '浑厚', '偏低', '低音', '中低', '中音', '中高', '偏高', '高亢', '尖', '偏亮', '清亮', '明亮', '清脆', '沙哑', '偏软', '软', '偏薄', '厚实', '磁性', '稚嫩', '苍老'];
function genderOf(...texts) {
  for (const t of texts) {
    const s = String(t || '');
    const m = /(女|男)(?:性|生|孩|人|声)?/.exec(s);
    if (m) return m[1] === '女' ? '女' : '男';
  }
  return '';
}

/** 本镜每个说话人：音色资产、性别、音高词（取自音色描述 voice_desc；没有就看人物描述）。 */
export function speakerVoices(shot, assets) {
  const list = assets || [];
  const out = [];
  for (const sp of dialogueVoiceSpeakers(shot.dialogue || '')) {
    if (/^(旁白|系统|广播)/.test(sp.name)) continue;
    const ch = list.find((a) => a.category === 'character' && nameMatches(sp.name, a.name));
    const v = list.find((a) => a.category === 'voice' && (nameMatches(sp.name, a.name) || nameMatches(sp.name + '音色', a.name)));
    const desc = String((ch && ch.voice_desc) || (v && v.voice_desc) || '').trim();
    const pitch = PITCH_WORDS.filter((w) => desc.includes(w));
    out.push({ speaker: sp.name, ...(sp.kind ? { kind: sp.kind } : {}), voice_asset: ch && ch.voice_ref ? ch.name : (v ? v.name : ''), gender: genderOf(desc, ch && ch.description), pitch: pitch.join('、'), voice_desc: cut(desc, 200), ...(ch || v ? {} : { missing: '资产库里没找到这个说话人' }) });
  }
  return out;
}
