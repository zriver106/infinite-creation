// 片内配乐闸门（2026-11-18）：本项目所有配乐都在合成时按章节 BGM cue 表垫入，分镜视频里不生成音乐。
// H3 提示词的 non_diegetic_music 段一律写 N/A；镜内生成的配乐会和章节 BGM 打架，也会破坏主曲断点续放。
// 纯函数，tools.js 渲染前调用。口径同说话人闸门 v2：未配置时默认 warn（只告警不拦）；
// 显式配置 generation.musicCheck=block 才拦截出片，=off 关闭。
const SECTION_HEAD = /^\s*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*[:：]\s*(.*)$/i;
// 自由文本提示词（IC 实际多为「Sound: …. Background music: ….」）里的配乐句：标签 + 冒号，取到句末。
const FREE_MUSIC = /(?:^|[.。!?！？]\s+|\n\s*)(background music|music|bgm|score|soundtrack|背景音乐|配乐)\s*[:：]\s*([^\n]*)/gi;
// 视为「无配乐」的写法只认这四个（不分大小写，后面可带一个句号）：silence / 没有配乐 / N/A / none。
// 必须与 skills/short-drama-director/scripts/validate_prompt.py 的 H10B_EMPTY_MUSIC_VALUES 一字不差
// （tests/music-check.test.mjs 与 test_ndm_warn.py 两边互读对方的列表比对）。
// 空串、单个「.」「。」、只有空白或标点都不算「无配乐」：段在但没写值按 ndm_missing 报（H3 会自己配乐）。
export const EMPTY_MUSIC_VALUES = ['silence', '没有配乐', 'N/A', 'none'];
const EMPTY_MUSIC = new RegExp('^(?:' + EMPTY_MUSIC_VALUES.map((v) => v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')\\s*[.。]?$', 'i');
const BLANK_MUSIC = /^[\s.。,，;；:：!！?？…\-—–]*$/;

export function musicCheckMode(cfg) {
  const m = String(cfg?.generation?.musicCheck || 'warn').toLowerCase();
  return m === 'block' || m === 'off' ? m : 'warn';
}

// 切出 H3 提示词各段（行首「字段名:」）。返回 { 字段: 内容 }；没有分段的自由文本返回 {}。
export function h3Sections(prompt) {
  const out = {};
  let cur = null;
  for (const line of String(prompt || '').split(/\r?\n/)) {
    const m = SECTION_HEAD.exec(line);
    if (m) { cur = m[1].toLowerCase(); out[cur] = [m[2]]; continue; }
    if (cur) out[cur].push(line);
  }
  const res = {};
  for (const [k, v] of Object.entries(out)) res[k] = v.join('\n').trim();
  return res;
}

export function isEmptyMusic(v) {
  return EMPTY_MUSIC.test(String(v == null ? '' : v).trim());
}

// 段在但没写值：空串、只有空白或标点（如单个「.」「。」）
export function isBlankMusic(v) {
  return BLANK_MUSIC.test(String(v == null ? '' : v));
}

// 返回 { mode, issues: [{ code, detail }], warnMessage, blockMessage }
//   ndm_content：non_diegetic_music 段写了配乐内容（不是 N/A）
//   ndm_missing：提示词是 H3 分段格式（有 overall_soundscape）却缺 non_diegetic_music 段，或段在但内容为空/只有标点（H3 会自己配乐）；
//                自由文本的「Background music:」句没写值也按此报
//   ndm_freetext：自由文本里写了「Background music: …」之类的配乐句（不是 silence / 没有配乐 / N/A / none）
//   music_ref：分镜 audio_ids 绑了 music 类资产（会作为音频参考送进 H3）
export function checkShotMusic({ prompt, shot = null, assets = [], cfg = null } = {}) {
  const mode = musicCheckMode(cfg);
  const issues = [];
  if (mode !== 'off') {
    const sec = h3Sections(prompt);
    if ('non_diegetic_music' in sec) {
      if (isBlankMusic(sec.non_diegetic_music)) issues.push({ code: 'ndm_missing', detail: 'non_diegetic_music 段在但没写值（空或只有标点），写 N/A' });
      else if (!isEmptyMusic(sec.non_diegetic_music)) issues.push({ code: 'ndm_content', detail: 'non_diegetic_music 写了配乐：「' + sec.non_diegetic_music.slice(0, 80) + '」' });
    } else if ('overall_soundscape' in sec) {
      issues.push({ code: 'ndm_missing', detail: '缺 non_diegetic_music 段' });
    }
    for (const m of String(prompt || '').matchAll(FREE_MUSIC)) {
      const val = m[2].split(/(?<=[.。])\s/)[0].trim();
      if (isBlankMusic(val)) { issues.push({ code: 'ndm_missing', detail: '「' + m[1] + ':」配乐句没写值，删掉这句或写 none' }); break; }
      if (!isEmptyMusic(val)) { issues.push({ code: 'ndm_freetext', detail: '提示词写了配乐句：「' + (m[1] + ': ' + val).slice(0, 80) + '」' }); break; }
    }
    const musicRefs = (shot?.audio_ids || []).map((id) => assets.find((a) => a.id === id)).filter((a) => a && a.category === 'music');
    if (musicRefs.length) issues.push({ code: 'music_ref', detail: '本镜 audios 绑了背景音乐资产：' + musicRefs.map((a) => a.name).join('、') });
  }
  const text = issues.length
    ? '片内配乐：' + issues.map((i) => i.detail).join('；') + '。本项目配乐统一在合成时按章节 cue 表垫入，分镜提示词写 non_diegetic_music: N/A、不写 Background music 句，music 资产不绑进分镜。'
    : '';
  return {
    mode, issues,
    warnMessage: text && mode === 'warn' ? '（仅告警）' + text : '',
    blockMessage: text && mode === 'block' ? text + '已拦截出片（generation.musicCheck=block）。' : '',
  };
}
