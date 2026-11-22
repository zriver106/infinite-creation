// 写分镜前的分类资产清单（2026-11-17）：人物 / 服装 / 场景 / 道具分开列出，
// 列表太大按类分页。供 buildTaskPrompt 注入正文，以及 list_assets 的默认返回。
export const STORYBOARD_ASSET_CATEGORIES = ['character', 'costume', 'scene', 'prop'];
export const CATALOG_PAGE_SIZE = 80;
export const CATALOG_DESC_MAX = 80;

export const CAT_LABEL = { character: '人物', costume: '服装', scene: '场景', prop: '道具' };
export const FIELD_OF = { character: 'characters', costume: 'costumes', scene: 'scenes', prop: 'props' };

export function assetsByCategory(assets) {
  const out = {};
  for (const c of STORYBOARD_ASSET_CATEGORIES) out[c] = [];
  for (const a of (assets || [])) {
    if (out[a.category]) out[a.category].push(a);
  }
  return out;
}

export function clipDesc(s, max = CATALOG_DESC_MAX) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max) + '…' : v;
}

export function summarizeItem(a, { byId } = {}) {
  const o = {
    id: a.id,
    name: a.name,
    category: a.category,
    status: a.status || '',
    source: a.source || '',
  };
  if (a.parent_id) {
    o.parent_id = a.parent_id;
    const p = byId && byId[a.parent_id];
    if (p) o.parent_name = p.name;
  }
  const d = clipDesc(a.description);
  if (d) o.description = d;
  if (a.image_path) o.has_image = true;
  return o;
}

export function pageItems(items, page = 1, pageSize = CATALOG_PAGE_SIZE) {
  const size = Math.min(Math.max(Number(pageSize) || CATALOG_PAGE_SIZE, 1), 200);
  const pg = Math.max(Number(page) || 1, 1);
  const total = (items || []).length;
  const start = (pg - 1) * size;
  return {
    total,
    page: pg,
    page_size: size,
    has_more: start + size < total,
    items: (items || []).slice(start, start + size),
  };
}

export function buildGroupedCatalog(assets, { page = 1, pageSize = CATALOG_PAGE_SIZE } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  const grouped = assetsByCategory(list);
  const categories = {};
  for (const cat of STORYBOARD_ASSET_CATEGORIES) {
    categories[cat] = pageItems(grouped[cat].map((a) => summarizeItem(a, { byId })), page, pageSize);
  }
  const also = {};
  for (const a of list) {
    if (!STORYBOARD_ASSET_CATEGORIES.includes(a.category)) also[a.category] = (also[a.category] || 0) + 1;
  }
  return {
    grouped: true,
    page_size: Math.min(Math.max(Number(pageSize) || CATALOG_PAGE_SIZE, 1), 200),
    categories,
    also_present: also,
    hint: '资产已按人物/服装/场景/道具分类列出。某一类 has_more=true 时请再调用 list_assets({category, page:2}) 翻页。写分镜前必须看完这四类，不要只列人物。',
  };
}

export function buildCategoryPage(assets, category, { page = 1, pageSize = CATALOG_PAGE_SIZE } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  const items = list.filter((a) => a.category === category).map((a) => summarizeItem(a, { byId }));
  return { category, grouped: false, ...pageItems(items, page, pageSize) };
}

// 注入首条任务的资产清单（2026-11-17 v3，总导定：全量 B2 + IC生成标记 + 自动降级 C）：
//  - B2（默认）：四类全部条目，每条一行，只带名字和所属人物（父级），不带描述、不带「有图」；
//    描述按需用 list_assets({category, page}) 查。全量列出 → 没有 has_more，模型一次看全场景和道具。
//  - IC 生成的条目（source=generated，或 uploaded 且描述里没有「我方资产ID」）在名字后标「（IC生成）」。
//    运行时只看资产自身的 source / description，不读资产登记表、不写死 id 列表。
//  - C（降级）：B2 超过 maxChars（默认 15,000 字）时，改为每类一行、「名字@父级」用顿号连写；标记随名字保留。
//  - 每次调用写一行日志：用了哪种格式、多少字。
export const CATALOG_INJECT_MAX_CHARS = 15000;
export const CATALOG_NAMES_ONLY_HINT = '清单只列名字和所属人物，不带描述；要看某个资产的描述或图，请调用 list_assets({category, page}) 查询。写分镜前必须看完这四类，不要只列人物；无换装时也要逐镜引用本场已有的服装。';
export const CATALOG_IC_TAG = '（IC生成）';
export const CATALOG_IC_PRIORITY_HINT = '同一个人、地点或道具，只要有我方定稿资产，就优先用定稿，标「（IC生成）」的只在没有定稿时用。';

const OUR_ASSET_ID_RE = /我方资产ID/;

// 与 v2 分析口径一致：G1 source=generated（52）+ G2 uploaded 且描述无「我方资产ID」（30）。
// 不读 assets.csv：在 V2 现有数据上，「描述无我方资产ID」与「未登记在 assets.csv」是同一批 82 个。
export function isIcGenerated(asset) {
  if (!asset) return false;
  if (String(asset.source || '') === 'generated') return true;
  if (String(asset.source || '') === 'uploaded' && !OUR_ASSET_ID_RE.test(String(asset.description || ''))) return true;
  return false;
}

export function catalogDisplayName(asset) {
  const name = asset && asset.name != null ? String(asset.name) : '';
  return isIcGenerated(asset) ? name + CATALOG_IC_TAG : name;
}

function catalogLines(assets, inline) {
  const list = Array.isArray(assets) ? assets : [];
  const byId = Object.fromEntries(list.map((a) => [a.id, a]));
  const grouped = assetsByCategory(list);
  const lines = ['【项目资产清单（按类，写分镜前必读）】'];
  for (const key of STORYBOARD_ASSET_CATEGORIES) {
    const items = grouped[key];
    const label = CAT_LABEL[key] || key;
    if (!items.length) { lines.push(label + '（0）：无'); continue; }
    const entries = items.map((a) => {
      const p = a.parent_id && byId[a.parent_id];
      const name = catalogDisplayName(a);
      if (inline) return name + (p ? '@' + p.name : '');
      return '- ' + name + (p ? '；挂在「' + p.name + '」下' : '');
    });
    if (inline) lines.push(label + '（' + items.length + '）：' + entries.join('、'));
    else { lines.push(label + '（' + items.length + '）：'); lines.push(...entries); }
  }
  const also = {};
  for (const a of list) if (!STORYBOARD_ASSET_CATEGORIES.includes(a.category)) also[a.category] = (also[a.category] || 0) + 1;
  const alsoE = Object.entries(also);
  if (alsoE.length) lines.push('其他分类（写分镜可不绑）：' + alsoE.map(([k, n]) => k + ' ' + n + ' 个').join('、'));
  lines.push(CATALOG_NAMES_ONLY_HINT);
  lines.push(CATALOG_IC_PRIORITY_HINT);
  return lines.join('\n');
}

export function buildCatalogInjection(assets, { maxChars = CATALOG_INJECT_MAX_CHARS, log } = {}) {
  let text = catalogLines(assets, false);
  let format = 'B2';
  const b2Chars = text.length;
  if (b2Chars > maxChars) {
    text = catalogLines(assets, true);
    format = 'C';
  }
  const line = '资产清单注入：格式 ' + format + '，' + text.length + ' 字' + (format === 'C' ? '（B2 ' + b2Chars + ' 字超过上限 ' + maxChars + '，已降级）' : '（上限 ' + maxChars + '）');
  if (typeof log === 'function') { try { log(line); } catch {} }
  return { text, format, chars: text.length, b2Chars, maxChars, logLine: line };
}

export function formatCatalogText(assets, opts = {}) {
  return buildCatalogInjection(assets, opts).text;
}

// set_storyboard：库里已有某类资产，但本镜没传或传了空数组时，给出可行动的非致命提示。
// 不拒绝整批——与「未找到同名资产」同一口径，已写入的分镜保留，模型可补绑后再调用。
export function collectMissingBindingWarnings({ shots, chapterTitles, idxs, assets }) {
  const counts = { character: 0, costume: 0, scene: 0, prop: 0 };
  const samples = { character: [], costume: [], scene: [], prop: [] };
  for (const a of (assets || [])) {
    if (counts[a.category] == null) continue;
    counts[a.category] += 1;
    if (samples[a.category].length < 3 && a.name) samples[a.category].push(a.name);
  }
  const groups = { character: [], costume: [], scene: [], prop: [] };
  (shots || []).forEach((sb, i) => {
    const label = (chapterTitles && chapterTitles[i] ? chapterTitles[i] : '') + '第' + (idxs ? idxs[i] : (sb && sb.idx)) + '镜';
    for (const cat of STORYBOARD_ASSET_CATEGORIES) {
      if (!counts[cat]) continue;
      const key = FIELD_OF[cat];
      const missing = !sb || !Object.prototype.hasOwnProperty.call(sb, key) || sb[key] == null;
      const empty = Array.isArray(sb && sb[key]) && sb[key].length === 0;
      if (missing || empty) groups[cat].push(label + (missing ? '（未传 ' + key + '）' : '（' + key + ' 为空）'));
    }
  });
  const msgs = [];
  for (const cat of STORYBOARD_ASSET_CATEGORIES) {
    if (!groups[cat].length) continue;
    const ex = samples[cat].length ? '，库里可引用例如「' + samples[cat].join('、') + '」' : '';
    msgs.push('库里有' + CAT_LABEL[cat] + '资产 ' + counts[cat] + ' 个，但以下镜头未绑定 ' + FIELD_OF[cat] + '：' + groups[cat].join('、') + ex + '。请按名字补绑后再调用 set_storyboard（已写入的分镜保留，本次不拒绝）');
  }
  return msgs;
}
