// 跨镜挪台词（2026-11-26 Andy：「这个画面应该对应后面的心声，现在是心声太迟了」「提前一些即可」；主会话 seq2130/seq2133）
// 只许把台词原句一字不改地在相邻镜之间挪；整章台词（说话人 + 每一句）集合不变；只动请求里点名的镜。
// 纯函数：不碰数据库。路由 app/api/projects/[id]/chapters/[cid]/move-dialogue 负责落库、记档和交 IC 重写。

export const MOVE_DIALOGUE_SOURCE = 'POST /api/projects/:id/chapters/:cid/move-dialogue';
const BUSY = new Set(['generating', 'queued', 'obsolete']);
const PREFIX_RE = /^\s*([^：:\n]{1,20}?[（(][^）)\n]*[）)]|[^：:（(\n]{1,12}?)\s*[：:]\s*/;

const normText = (t) => String(t || '').replace(/[\s　]/g, '');
const normSpeaker = (t) => String(t || '').replace(/[\s　]/g, '').replace(/\(/g, '（').replace(/\)/g, '）');

/** 一行台词拆成 { speaker, content }；没有「某某：」前缀的 speaker = ''。 */
export function parseLine(line) {
  const s = String(line || '');
  const m = s.match(PREFIX_RE);
  if (!m) return { speaker: '', content: s.trim() };
  return { speaker: m[1].trim(), content: s.slice(m[0].length).trim() };
}

/** 按句末标点切句，标点和紧跟的右引号留在句子里；末尾没标点的残句也算一句。 */
export function splitSentences(content) {
  const out = [];
  const re = /[^。！？!?…]*(?:[。！？!?]+|…+)[」”’"』）)]*/g;
  const s = String(content || '');
  let last = 0; let m;
  while ((m = re.exec(s)) && m[0]) { out.push(m[0]); last = re.lastIndex; }
  const rest = s.slice(last);
  if (rest.trim()) out.push(rest);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** 整段台词 → 「说话人|句子」单元列表（用于整章集合比对）。 */
export function dialogueUnits(dialogue) {
  const units = [];
  for (const line of String(dialogue || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const { speaker, content } = parseLine(line);
    for (const sen of splitSentences(content)) units.push(normSpeaker(speaker) + '|' + normText(sen));
  }
  return units;
}

const multisetKey = (arr) => [...arr].sort().join('\n');

/**
 * 计划一次挪台词。
 * @param {Array<{id,idx,status,dialogue}>} chapterShots 本章全部分镜
 * @param {Array<{from:string,to:string,text:string,position?:'start'|'end'}>} moves
 * @returns {{ ok:boolean, errors:string[], updates: Record<string,{before:string,after:string}>, moved: Array<{from,to,fromIdx,toIdx,speaker,text,position}>, touched:string[] }}
 */
export function planDialogueMove(chapterShots, moves) {
  const errors = [];
  const fail = (m) => { errors.push(m); return { ok: false, errors, updates: {}, moved: [], touched: [] }; };
  if (!Array.isArray(moves) || !moves.length) return fail('moves 必须是非空数组：[{ from, to, text }]');
  if (moves.length > 10) return fail('一次最多挪 10 句');
  const byId = new Map(chapterShots.map((s) => [String(s.id), s]));
  const order = chapterShots.filter((s) => String(s.status || '') !== 'obsolete').sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0));
  const pos = new Map(order.map((s, i) => [String(s.id), i]));
  const cur = new Map(chapterShots.map((s) => [String(s.id), String(s.dialogue || '')]));
  const moved = [];
  for (const [k, mv] of moves.entries()) {
    const n = '第 ' + (k + 1) + ' 条';
    const from = String(mv?.from || '').trim(); const to = String(mv?.to || '').trim();
    const text = String(mv?.text || '').trim();
    if (!from || !to || !text) return fail(n + '：from / to / text 都必须给');
    if (from === to) return fail(n + '：from 和 to 是同一镜');
    const a = byId.get(from); const b = byId.get(to);
    if (!a || !b) return fail(n + '：' + (!a ? 'from' : 'to') + ' 不是本章的分镜');
    for (const s of [a, b]) if (BUSY.has(String(s.status || ''))) return fail(n + '：第' + s.idx + '镜正在生成/排队或已作废，不能改台词');
    if (Math.abs(pos.get(from) - pos.get(to)) !== 1) return fail(n + '：只许在相邻镜之间挪（第' + a.idx + '镜 → 第' + b.idx + '镜不相邻）');
    const position = mv.position === 'start' || mv.position === 'end' ? mv.position : (pos.get(to) < pos.get(from) ? 'end' : 'start');
    // 在 from 的台词里找：某一行里连续的若干整句，拼起来一字不差等于 text
    const want = normText(text);
    const lines = cur.get(from).split(/\r?\n/);
    let hit = null;
    for (let li = 0; li < lines.length && !hit; li++) {
      if (!lines[li].trim()) continue;
      const { speaker, content } = parseLine(lines[li]);
      const sens = splitSentences(content);
      for (let i = 0; i < sens.length && !hit; i++) {
        let acc = '';
        for (let j = i; j < sens.length; j++) {
          acc += normText(sens[j]);
          if (acc === want) { hit = { li, speaker, sens, i, j }; break; }
          if (!want.startsWith(acc)) break;
        }
      }
    }
    if (!hit) return fail(n + '：第' + a.idx + '镜的台词里找不到这句原文（必须是同一行里完整的一句或几句，一字不改，含标点）');
    const keep = hit.sens.slice(0, hit.i).concat(hit.sens.slice(hit.j + 1));
    const piece = hit.sens.slice(hit.i, hit.j + 1).join('');
    const sp = hit.speaker ? hit.speaker + '：' : '';
    if (keep.length) lines[hit.li] = sp + keep.join(''); else lines.splice(hit.li, 1);
    cur.set(from, lines.filter((l) => l.trim()).join('\n'));
    const tl = cur.get(to).split(/\r?\n/).filter((l) => l.trim());
    if (position === 'end') tl.push(sp + piece); else tl.unshift(sp + piece);
    cur.set(to, tl.join('\n'));
    moved.push({ from, to, fromIdx: a.idx, toIdx: b.idx, speaker: hit.speaker, text: piece, position });
  }
  // 整章台词集合不变（说话人 + 每一句）
  const before = chapterShots.flatMap((s) => dialogueUnits(s.dialogue));
  const after = chapterShots.flatMap((s) => dialogueUnits(cur.get(String(s.id))));
  if (multisetKey(before) !== multisetKey(after)) return fail('校验失败：挪完后整章台词集合变了（不应发生），未写入');
  const updates = {};
  for (const s of chapterShots) {
    const id = String(s.id); const b = String(s.dialogue || ''); const a = cur.get(id);
    if (a !== b) updates[id] = { before: b, after: a };
  }
  const named = new Set(moves.flatMap((m) => [String(m.from).trim(), String(m.to).trim()]));
  const extra = Object.keys(updates).filter((id) => !named.has(id));
  if (extra.length) return fail('校验失败：动到了请求里没点名的镜，未写入');
  return { ok: true, errors, updates, moved, touched: [...named].filter((id) => updates[id]) };
}
