// 服装参考图按朝向选（2026-11-18 · 通用修复_refs服装图按朝向选_v1）。
// 问题：refs.js 每个角色只送一张服装图（costumeByChar：同一角色绑了几件就「最后一件赢」），
// 而服装常有 正面 / 侧面 / 背面 三张图。背影镜送了正面图，H3 会把人转成正脸；正脸镜送了背面图，脸会丢。
// 规则：本镜该角色是背面（背影、背对镜头、从背后拍）→ 用背面图；正面、侧面或看不出 → 用正面图。
// 候选 = 本镜给该角色绑定的服装 + 素材库里同一角色、同一件衣服（名字去掉朝向字样后相同）的其他朝向图。
// 默认安全：素材都没有朝向标记时完全照旧；背面镜没有背面图时退回正面图并告警；只换图、从不拦截出片。
// 关闭：config.generation.refFacing = 'off'（或 false）。纯函数，refs.js 调用。

const VIEW_WORDS = '正面|侧面|背面|背影|前视|侧视|后视|front|side|back|rear|profile';
const VIEW_TAG_RE = new RegExp('[（(\\[【]?\\s*(?:' + VIEW_WORDS + ')(?:全身|半身|视图|图|view)?\\s*[）)\\]】]?', 'gi');

// 资产是哪个朝向的图：只看名字和图片文件名（描述里的「背面」可能是别的意思）。
export function viewOfAsset(asset) {
  const s = String((asset && asset.name) || '') + ' ' + String((asset && asset.image_path) || '').split(/[\\/]/).pop();
  if (/背面|背影|后视|\bback\b|\brear\b|_back\b|-back\b/i.test(s)) return 'back';
  if (/侧面|侧视|\bside\b|\bprofile\b|_side\b|-side\b/i.test(s)) return 'side';
  if (/正面|前视|\bfront\b|_front\b|-front\b/i.test(s)) return 'front';
  return null;
}

// 去掉朝向字样后的「这件衣服」名，用来把同一件衣服的三张图归到一起。
export function costumeBaseName(name) {
  return String(name || '').replace(VIEW_TAG_RE, '').replace(/[\s_\-·—]+$/g, '').replace(/^[\s_\-·—]+/g, '').trim();
}

const BACK_RE = /背影|背对(?:着)?(?:镜头|画面|观众|我们)|背身(?:对(?:着)?镜头)?|背向镜头|从(?:他|她|其)?(?:身|背)?后(?:方|面)?(?:拍|跟拍|跟|拍摄|机位)|背后机位|后背对(?:着)?镜头|\bback\s+to\s+(?:the\s+)?camera\b|\bfrom\s+behind\b|\bback\s+view\b|\brear\s+view\b|\bseen\s+from\s+(?:the\s+)?back\b/i;
const FRONT_RE = /正面|正脸|面(?:朝|对|向)镜头|正对镜头|直视镜头|看向镜头|转(?:过)?身(?:来)?面(?:朝|对)|三分之四侧|3\/4|\bfacing\s+(?:the\s+)?camera\b|\bfront\s+view\b|\bthree-quarter\b|\btoward(?:s)?\s+the\s+camera\b/i;
const SIDE_RE = /侧脸|侧身|侧面|侧影|侧对镜头|\bprofile\b|\bside\s+view\b/i;

function classify(text) {
  const back = BACK_RE.test(text);
  const front = FRONT_RE.test(text);
  const side = SIDE_RE.test(text);
  if (back && !front) return 'back';
  if (back && front) return 'mixed';
  if (front) return 'front';
  if (side) return 'side';
  return null;
}

// 本镜某个角色的朝向：先看提到该角色名字的那一段（镜头 / 画面 / 子镜头时间轴 = 站位；从名字起，到句末或下一个
// 同镜角色名为止），再看整条镜头字段（机位，如「从背后跟拍」）。返回 'back' | 'front' | 'side' | 'mixed' | null（看不出）。
export function shotFacing(shot, name = '', otherNames = []) {
  const fields = [shot && shot.camera, shot && shot.visual, shot && shot.sub_shots].map((v) => String(v || '')).filter(Boolean);
  if (!fields.length) return null;
  if (name) {
    const others = (otherNames || []).filter((n) => n && n !== name && !name.includes(n));
    const clauses = [];
    for (const seg of fields.join('\n').split(/[。；;！？!?\n｜|]+/)) {
      let i = seg.indexOf(name);
      while (i >= 0) {
        let end = seg.length;
        for (const o of others) { const j = seg.indexOf(o, i + name.length); if (j >= 0 && j < end) end = j; }
        clauses.push(seg.slice(i, end));
        i = seg.indexOf(name, end);
      }
    }
    const per = clauses.map(classify).filter(Boolean);
    if (per.length) {
      if (per.includes('mixed') || (per.includes('back') && (per.includes('front') || per.includes('side')))) return 'mixed';
      return per[0];
    }
  }
  return classify(String((shot && shot.camera) || ''));
}

export function refFacingEnabled(cfg) {
  const v = cfg && cfg.generation ? cfg.generation.refFacing : undefined;
  return !(v === false || String(v).toLowerCase() === 'off');
}

// 给一个角色选本镜要送的那张服装图。
// bound：本镜绑给该角色的服装资产（按绑定顺序）；assets：项目全部资产。
// 返回 { asset, facing, view, note, level }：asset 为 null 表示照旧（refs.js 不改）；note 是要写进日志的一句话。
export function pickCostumeForFacing({ shot, character, bound = [], assets = [], otherNames = [] }) {
  const legacy = bound.length ? bound[bound.length - 1] : null;
  const withImg = (a) => a && a.image_path;
  const pool = [];
  const seen = new Set();
  const add = (a) => { if (withImg(a) && !seen.has(a.id)) { seen.add(a.id); pool.push(a); } };
  bound.forEach(add);
  const bases = new Set(bound.map((b) => costumeBaseName(b.name)).filter(Boolean));
  for (const a of assets) {
    if (a && a.category === 'costume' && a.parent_id === (character && character.id) && bases.has(costumeBaseName(a.name))) add(a);
  }
  const byView = {};
  for (const a of pool) { const v = viewOfAsset(a); if (v && !byView[v]) byView[v] = a; }
  const facing = shotFacing(shot, character && character.name, otherNames);
  if (!byView.front && !byView.back && !byView.side) return { asset: null, facing, view: null, note: '', level: 'info' };
  const who = (character && character.name) || '角色';
  if (facing === 'back') {
    if (byView.back) return { asset: byView.back, facing, view: 'back', level: 'info', note: who + '本镜是背面，服装参考图用背面图「' + byView.back.name + '」' };
    if (byView.front) return { asset: byView.front, facing, view: 'front', level: 'warn', note: '（仅告警）' + who + '本镜是背面，但没有背面服装图，用正面图「' + byView.front.name + '」；H3 可能把人转成正脸，建议补背面图' };
    return { asset: null, facing, view: null, level: 'warn', note: '（仅告警）' + who + '本镜是背面，但没有背面/正面服装图，照旧用绑定的「' + (legacy && legacy.name) + '」' };
  }
  const note = facing === 'mixed' ? '（仅告警）' + who + '本镜朝向前后都有（先背后正或相反），按正面处理' : '';
  if (byView.front) return { asset: byView.front, facing, view: 'front', level: note ? 'warn' : 'info', note: note || (legacy && legacy.id !== byView.front.id ? who + '本镜是' + ({ side: '侧面', front: '正面' }[facing] || '朝向未写明') + '，服装参考图用正面图「' + byView.front.name + '」' : '') };
  return { asset: null, facing, view: null, level: 'warn', note: '（仅告警）' + who + '的服装图没有正面图，照旧用绑定的「' + (legacy && legacy.name) + '」' };
}
