// 资产出图工作台（总导 11-26：Andy「制作资产也是要走 ic 工作流」）——纯数据层：状态文件、排单、派单正文、拼板、写回资产。
// 状态存 <项目>/asset_gaps/image_work.json；每张图每一轮的回图原件存 <项目>/asset_gaps/rounds/<asset_id>/<格>_r<轮>_<原文件名>。
// 流程：缺图单行 → 派 am（一个资产一条单，按线程并行）→ 回图 → IC 审图 Agent 逐件对照 → 过：写回原 asset_id（旧版进 versions）/ 不过：原线程退回返修。
// _MV 分四格走：A → 审过后带 A 出 B → C → D（照布局表）→ IC 拼 2×2 写回。其他资产一张。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectDir } from './config.js';
import { Assets, Projects } from './db.js';
import { getGapList } from './asset-gaps.js';
import { PROJECT_ASSET_SUBDIRS, styleWithAnchor } from '../shared/index.js';

const DIR = 'asset_gaps';
const FILE = 'image_work.json';
export const THREADS_KEY = 'asset_image_threads';
export const STALE_WARN_MIN = 10; // 10 分钟没回图：提示核查
export const STALE_STOP_MIN = 20; // 20 分钟仍没有：标「待对账」，不自动重派（结果不明的不重派）

export function workPath(projectId) { return path.join(projectDir(projectId), DIR, FILE); }
export function roundsDir(projectId, aid) { return path.join(projectDir(projectId), DIR, 'rounds', aid); }

export function loadWork(projectId) {
  try { const f = workPath(projectId); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 坏文件按空 */ }
  return { running: false, allow: [], items: {}, threads: {}, updated_at: 0 };
}
export function saveWork(projectId, w) {
  const f = workPath(projectId); fs.mkdirSync(path.dirname(f), { recursive: true });
  w.updated_at = Date.now();
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(w, null, 2)); fs.renameSync(tmp, f);
  return w;
}

/** 项目设置：am 线程表 [{ name, session, lane }]，lane = person | scene | prop。线程数 = 表长。 */
export function threadsOf(projectId) {
  const t = ((Projects.get(projectId) || {}).context || {})[THREADS_KEY];
  return Array.isArray(t) ? t.filter((x) => x && x.name && x.session) : [];
}

const isMv = (row) => /_MV/.test(String(row.name || ''));
const isUi = (row) => /光幕|UI|屏幕/.test(String(row.name || ''));
export function laneOf(row) {
  const k = String(row.kind || '');
  if (k === 'scene') return 'scene';
  if (k === 'prop' || isUi(row)) return 'prop';
  return 'person';
}
export function stepsOf(row) { return isMv(row) ? ['A', 'B', 'C', 'D'] : ['main']; }
// 排单顺序：_MV → 有人的阶段变体 → 人物服装 → 道具 / UI
export function priorityOf(row) {
  if (isMv(row)) return 0;
  if (row.kind === 'scene') return 1;
  if (laneOf(row) === 'person') return 2;
  return 3;
}

/** 界面用：缺图单里所有要出图的行 + 出图状态（没派的：在跑且在名单里 = 排队，否则 = 未派）。 */
export function rowsWithStatus(projectId, w = loadWork(projectId)) {
  const allow = new Set(w.allow || []);
  return (getGapList(projectId).items || []).filter((x) => x.status !== 'void' && x.need_image !== false && x.asset_id).map((x) => {
    const it = (w.items || {})[x.asset_id];
    const a = Assets.get(x.asset_id) || {};
    const status = it ? it.status : (w.running && (!allow.size || allow.has(x.asset_id)) ? 'queued' : 'idle');
    return { asset_id: x.asset_id, name: x.name, kind: x.kind, location_id: x.location_id || '', has_image: !!a.image_path, status, step: it ? it.step : '', round: it ? it.round : 0, note: it ? it.note || '' : '', thread: it ? it.thread || '' : '', last_verdict: it ? ((it.history || []).filter((h) => h.action === 'review').slice(-1)[0] || {}).verdict || '' : '', base_ref: x.base_ref || null };
  }).sort((a, b) => priorityOf(a) - priorityOf(b));
}

/** 候选行：缺图单里有效、要出图、有 asset_id 的。allow 非空时只排 allow 里的（总导确认过的单子）。 */
export function candidateRows(projectId, w = loadWork(projectId)) {
  const allow = new Set(w.allow || []);
  return (getGapList(projectId).items || [])
    .filter((x) => x.status !== 'void' && x.need_image !== false && x.asset_id && (!allow.size || allow.has(x.asset_id)))
    .sort((a, b) => priorityOf(a) - priorityOf(b));
}

/** 行改过要求、图还是旧的（行的 updated_at 晚于图）——要重出的行。纯读，列给总导确认。 */
export function staleRows(projectId) {
  return (getGapList(projectId).items || []).filter((x) => x.status !== 'void' && x.need_image !== false && x.asset_id).map((x) => {
    const a = Assets.get(x.asset_id) || {};
    const imgAt = a.image_path ? Number(a.updated_at || 0) : 0;
    return { asset_id: x.asset_id, name: x.name, kind: x.kind, has_image: !!a.image_path, row_updated_at: x.updated_at || 0, image_updated_at: imgAt };
  }).filter((r) => !r.has_image || r.row_updated_at > r.image_updated_at);
}

export const outPrefix = (aid, step, round) => String(aid).slice(0, 8) + '_' + step + '_r' + round;

/** 派单正文。模板来自技能参考文件（asset-image/references/派单模板.md），占位符 {名称}{格}{轮}{文件名}{画风}{要画什么}{底图}{附图}{格说明}；没有模板时用内置的。 */
export function buildDispatchText(row, { step, round, style = '', template = '', outFile = '', refRemote = '', attachRemote = [], kind = '' } = {}) {
  const stepNote = step === 'main' ? '' : step === 'A'
    ? '这一单只出 A 格（主视角）一张；B、C、D 等 A 审过后再派。'
    : step === 'D'
      ? '这一单只出 D 格：照布局表画俯视平面图，作核对基准；要和已审过的 A/B/C 是同一个空间。'
      : '这一单只出 ' + step + ' 格：拿已审过的 A 格（附图）换视角出，空间、装潢、物件位置、光线一律不变。';
  const styleLine = styleWithAnchor(style, kind === 'scene' ? 'scene' : kind === 'prop' ? 'prop' : 'character') + '；人物和人群：中国人长相，当代中国城市普通市民穿着。不要动漫、插画、描边、二次元。';
  const refLine = refRemote ? '拿 ' + refRemote + ' 做图生图（前作定稿底图），内容照底图；本单要求和底图不一致处，交图时列差异表（项目｜本单写的｜底图里的）。' : '';
  const attach = attachRemote.length ? '附图（已审过，照它保持一致）：' + attachRemote.join('、') : '';
  const fill = { '{名称}': row.name, '{格}': step === 'main' ? '' : '（' + step + ' 格）', '{轮}': round > 1 ? '返修 r' + round : 'r1', '{文件名}': outFile, '{画风}': styleLine, '{要画什么}': String(row.requirement || ''), '{底图}': refLine, '{附图}': attach, '{格说明}': stepNote };
  if (template && template.includes('{名称}')) return Object.entries(fill).reduce((s, [k, v]) => s.split(k).join(v), template).trim();
  return [
    '【IC 单张资产 ' + (round > 1 ? '返修 r' + round : 'r1') + '】只做这一张：「' + row.name + '」' + (step !== 'main' ? '（' + step + ' 格）' : '') + '。',
    '存 ' + outFile + '，交图时在消息里报文件名并附图、附逐件对照表；交了等审，审完再给下一张。',
    stepNote, '【要画什么】' + String(row.requirement || ''), refLine, attach, '画风：' + styleLine, '图上不写任何文字。',
  ].filter(Boolean).join('\n');
}

export function buildReviseText(row, { step, round, note = '', outFile = '' }) {
  return '【退回 r' + round + '·「' + row.name + '」' + (step !== 'main' ? step + ' 格' : '') + '】' + String(note || '').trim() + '\n改好存 ' + outFile + '，报文件名并附图、附对照表。';
}

/** 2×2 拼板（A 左上、B 右上、C 左下、D 右下），用 ffmpeg；四格先统一缩到同一尺寸。 */
export function composeMv(files, outAbs) {
  const [a, b, c, d] = files;
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const sc = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white';
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', a, '-i', b, '-i', c, '-i', d, '-filter_complex',
    `[0:v]${sc}[a];[1:v]${sc}[b];[2:v]${sc}[c];[3:v]${sc}[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack`, '-frames:v', '1', outAbs], { timeout: 120000 });
  return outAbs;
}

/** 审过的图写回原 asset_id：存进项目资产目录，旧图进 versions（可回滚）。 */
export function writeAssetImage(projectId, aid, srcAbs, { source = 'am' } = {}) {
  const a = Assets.get(aid);
  if (!a || a.project_id !== projectId) throw Object.assign(new Error('资产不在本项目：' + aid), { code: 'NO_ASSET' });
  const ext = (path.extname(srcAbs) || '.png').toLowerCase();
  const slug = String(a.name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const rel = 'assets/' + (PROJECT_ASSET_SUBDIRS[a.category] || 'other') + '/' + slug + '_' + Date.now().toString(36) + ext;
  const abs = path.join(projectDir(projectId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(srcAbs, abs);
  Assets.update(aid, { image_path: rel, source, status: 'done', error: '', versions: [...(a.versions || []), a.image_path].filter(Boolean) });
  return rel;
}
