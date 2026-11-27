// _MV 每一格的「本格可见清单」（总导 11-26，站位出图失败归类第 1、2 类：纵深排数画多、朝向画反）。
// 派单前，从这一行的戏份说明（布局表、D 格机位）和站位表推算：这一格画面里从近到远应数出几排、每排几张，人坐哪侧、面朝哪，
// 看到屏幕正面还是背面、椅背还是椅面，左手 / 右手 / 远端是什么结构件。写进派单，审图照它逐排数。
// 纯文本推算（走 brainChat，不占 GPU）；按「戏份说明 + 出图要求 + 格」做缓存键，说明没改就不重算。算不出来不挡派单，派单里写明没算出。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSceneNote } from '../core/scene-notes.js';
import { getLocations } from '../core/locations.js';
import { roundsDir } from '../core/asset-image-work.js';
import { loadConfig } from '../core/config.js';
import { extractJson } from '../core/llm.js';
import { brainChat } from './brain.js';

const STEP_VIEW = { A: 'A 格（主视角）', B: 'B 格（反打）', C: 'C 格（侧面）', D: 'D 格（俯视平面图）' };

export function cellSpecPrompt(row, step, noteText, loc) {
  return [
    '你是短剧场景资产的空间推算员。下面是一个地点的戏份说明（含布局表、D 格机位、站位表）和这一张多视角定义图（_MV）的出图要求。',
    '请推算 ' + (STEP_VIEW[step] || step) + ' 这一格画面里应该看到什么，只依据说明里写明的布局和机位，不自己加东西。',
    step === 'D'
      ? '这一格是俯视平面图：给出全部排数、每排左右各几张、总数，门窗和主要家具的方位，A/B/C 三个机位点和朝向。'
      : '先写清这一格的机位（站在哪、朝哪看），再从近到远逐排写：这一排是布局表的第几排、画面左边几张、右边几张、共几张、是否被画面边缘裁掉；最后给可见总数。',
    '再写：人坐在桌子哪一侧、面朝哪边；从这个机位看到的是屏幕正面还是背面、椅背还是椅面；画面左手、右手、远端分别是什么墙 / 窗 / 门 / 幕墙 / 家具。',
    '说明里没写清、推不出来的，写进 unknown，不要猜。',
    '只输出 JSON：{"camera":"…","rows":[{"order":"从近到远第1排","layout_row":"布局表第4排","left":2,"right":2,"total":4,"cut":"下沿裁掉半排或空"}],"total_visible":0,"seating":"…","screens":"正面|背面|侧面|看不到","chairs":"椅背|椅面|侧面|看不到","left_side":"…","right_side":"…","far_end":"…","unknown":"…"}',
    '【出图要求】' + String(row.requirement || ''),
    loc ? '【地点表】' + JSON.stringify(loc).slice(0, 1500) : '',
    '【戏份说明】\n' + String(noteText || '').slice(0, 14000),
  ].filter(Boolean).join('\n');
}

/** 结构化结果 → 派单 / 审图里的一段话。 */
export function renderCellSpec(step, d) {
  if (!d) return '';
  const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => '  - ' + (r.order || '') + (r.layout_row ? '（' + r.layout_row + '）' : '') + '：左 ' + (r.left ?? '?') + '、右 ' + (r.right ?? '?') + '，共 ' + (r.total ?? '?') + ' 张' + (r.cut ? '；' + r.cut : ''));
  return [
    '【本格可见清单（' + step + ' 格，IC 从布局表和站位表推算；画面里照这个数，审图逐排数）】',
    d.camera ? '机位：' + d.camera : '',
    rows.length ? '从近到远：\n' + rows.join('\n') : '',
    d.total_visible != null ? '可见总数：' + d.total_visible + ' 张（多一排、少一排都退）' : '',
    d.seating ? '人坐哪侧、面朝哪：' + d.seating : '',
    d.screens ? '屏幕：看到' + d.screens : '',
    d.chairs ? '椅子：看到' + d.chairs : '',
    d.left_side ? '画面左手：' + d.left_side : '',
    d.right_side ? '画面右手：' + d.right_side : '',
    d.far_end ? '远端：' + d.far_end : '',
    d.unknown ? '说明里没写清的（按说明原文，不自己加）：' + d.unknown : '',
  ].filter(Boolean).join('\n');
}

const keyOf = (...parts) => crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 16);

/** 推算某一格的可见清单（有缓存）。返回 { text, data, cached } 或 { text: '', error }。只对 _MV 行。 */
export async function cellSpec(projectId, row, step, { chat = null } = {}) {
  if (!row || !/_MV/.test(String(row.name || '')) || !['A', 'B', 'C', 'D'].includes(step)) return { text: '' };
  const noteText = row.note_key ? (getSceneNote(projectId, row.note_key) || {}).text || '' : '';
  const loc = row.location_id ? (getLocations(projectId).rows || []).find((r) => r.id === row.location_id) || null : null;
  if (!noteText && !String(row.requirement || '').trim()) return { text: '', error: '没有戏份说明和出图要求，推不出来' };
  const key = keyOf(noteText, String(row.requirement || ''), JSON.stringify(loc || {}), step);
  const f = path.join(roundsDir(projectId, row.asset_id), 'cellspec_' + step + '.json');
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.key === key && c.data) return { text: renderCellSpec(step, c.data), data: c.data, cached: true }; } catch { /* 没缓存 */ }
  const ask = chat || ((messages, opts) => brainChat(loadConfig(), messages, opts));
  try {
    const r = await ask([{ role: 'user', content: cellSpecPrompt(row, step, noteText, loc) }], { json: true, temperature: 0.2, maxTokens: 2000, timeoutMs: 120000 });
    const data = extractJson(String((r && r.content) || ''));
    if (!data || typeof data !== 'object') return { text: '', error: '推算结果不是 JSON' };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ key, step, at: Date.now(), data }, null, 2));
    return { text: renderCellSpec(step, data), data, cached: false };
  } catch (e) { return { text: '', error: String((e && e.message) || e).slice(0, 200) }; }
}
