import path from 'node:path';
import fs from 'node:fs';
import { projectDir } from './config.js';
import { uploadTaskInput } from './backend.js';
import { extractFrame } from './ffmpeg.js';
import { logger } from './logger.js';
import { toVideoReferenceImage, videoRefKind } from './videoref-crop.js';
import { dialogueVoiceSpeakers, MAX_AUDIO_REFS } from './prompts.js';
import { voiceSampleFor } from './offscreen-lines.js';
import { nameMatches } from '../shared/index.js';
import { pickCostumeForFacing, refFacingEnabled } from './ref-facing.js';

// 项目内相对路径 -> 绝对路径（asset.image_path / voice_ref 均相对项目目录存储）。
// 必须在这里做越界防护：rel 不全是可信的内部产物——asset.image_path / voice_ref 可由 HTTP PATCH、
// 以及 LLM 工具（update_asset.voice_ref、edit_asset_image.reference_image_path）写入，
// 而 novel 正文可经提示注入操纵这些工具参数。一旦 rel 是 '../..' 或绝对路径，
// path.resolve 会逃出项目目录，随后被 references 删除时 unlinkSync、被参考图提交时
// uploadTaskInput 上传到 ComfyUI/RunningHub、被 imageToDataUrl 读成 base64 —— 等于任意文件删/读。
// 越界一律返回 null，调用方按「文件不存在」处理（各调用点都已判 null）。
export function resolveProjectPath(projectId, rel) {
  if (!rel) return null;
  const base = projectDir(projectId);
  const abs = path.resolve(base, rel);
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return abs;
}

// 懒生成章节首帧预览图（存在即复用）：从章节第一个已完成分镜的视频抽首帧存为 jpg。
// 同一章节的抽取只允许一个在跑：GET /chapters 会被前端高频轮询（WS 每条进度都刷新 + 运行期每 2.5s 一次），
// 少了这道闸门，同一张 posters/<章节id>.jpg 会被多个请求并发抽取/写入，既同时起一堆 ffmpeg，
// 又可能写出半截文件——而「存在即复用」会让这张坏图被永久缓存下来。
const posterInflight = new Set();
export async function ensureChapterPoster(projectId, chapterId, firstDoneShot) {
  const rel = 'posters/' + chapterId + '.jpg';
  const abs = resolveProjectPath(projectId, rel);
  if (!abs) return '';
  if (fs.existsSync(abs)) return rel;
  if (posterInflight.has(abs)) return '';
  posterInflight.add(abs);
  try {
    const videoAbs = resolveProjectPath(projectId, firstDoneShot.video_path);
    if (!videoAbs || !fs.existsSync(videoAbs)) return '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await extractFrame(videoAbs, abs);
    return fs.existsSync(abs) ? rel : '';
  } catch { return ''; } finally { posterInflight.delete(abs); }
}

// 组装一个分镜的参考素材（MiniMax H3 全能参考范式：多图 + 多音视频）。
// 顺序：人物图 -> 场景图 -> 道具图 -> 人物语音。
// upload=false：只解析参考清单与标签，不向 ComfyUI 上传文件（「仅 LLM 改写提示词、不渲染」用，
// 该路径无需 ComfyUI，也就不应因 ComfyUI 未启动而失败）。
export async function assembleShotReferences({ cfg, project, shot, assets, upload = true }) {
  const pid = project.id;
  // 同一张素材在一个镜头里只出一次：character_ids / scene_ids / prop_ids 可能因历史数据或
  // 外部写入出现重复 id，重复上传不仅白占「最多 9 张参考图」的名额，还会让同一个人物在
  // 参考素材里出现两次。
  const uniqAssets = (ids) => {
    const seen = new Set();
    const out = [];
    for (const id of (ids || [])) {
      const key = String(id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const a = assets.find((x) => x.id === key);
      if (a) out.push(a);
    }
    return out;
  };
  const charIds = (shot.character_ids && shot.character_ids.length) ? shot.character_ids : [];
  const sceneIds = (shot.scene_ids && shot.scene_ids.length) ? shot.scene_ids : [];
  const chars = uniqAssets(charIds);
  const scenes = uniqAssets(sceneIds);
  const props = uniqAssets(shot.prop_ids);
  const costumeIds = (shot.costume_ids || []).filter(Boolean);
  // 服装替换：把 costume 资产按 parent_id 归属到角色；有服装时角色参考图改用服装图
  const costumeByChar = {};
  const costumeBound = {};
  for (const cid of costumeIds) {
    const c = assets.find((a) => a.id === cid && a.category === 'costume');
    if (c?.parent_id) { costumeByChar[c.parent_id] = c; (costumeBound[c.parent_id] ||= []).push(c); }
  }
  // 服装图按朝向选（2026-11-18）：每个角色只送一张服装图，同一件衣服有 正面/侧面/背面 图时，
  // 本镜该角色是背面（背影/背对镜头/从背后拍，读 camera、visual、sub_shots）→ 背面图；正面、侧面或看不出 → 正面图。
  // 没有朝向标记时照旧；背面镜缺背面图退回正面图并告警；只换图、不拦截。关闭：generation.refFacing='off'。
  const facingNotes = [];
  if (refFacingEnabled(cfg)) {
    for (const ch of chars) {
      if (!costumeBound[ch.id]) continue;
      const r = pickCostumeForFacing({ shot, character: ch, bound: costumeBound[ch.id], assets, otherNames: chars.map((x) => x.name) });
      if (r.asset) costumeByChar[ch.id] = r.asset;
      if (r.note) { facingNotes.push(r.note); (r.level === 'warn' ? logger.warn : logger.info)('参考图朝向：' + r.note); }
    }
  }
  // 年龄变体：把 age 资产按 parent_id 归属到角色；有时间跳跃时角色参考图改用对应时期变体
  const ageIds = (shot.age_ids || []).filter(Boolean);
  const ageByChar = {};
  for (const aid of ageIds) {
    const a = assets.find((x) => x.id === aid && x.category === 'age');
    if (a?.parent_id) ageByChar[a.parent_id] = a;
  }
  // 至少需要一张参考图（人物或场景）；无图的人物会被自然跳过
  const hasImage = [...chars, ...scenes, ...props].some((a) => a?.image_path);
  if (!hasImage) throw new Error('请先为该分镜生成至少一张参考图（人物或场景）');

  const uploadImageRef = async (asset, role) => {
    if (!asset?.image_path) return null;
    const abs = resolveProjectPath(pid, asset.image_path);
    if (!abs || !fs.existsSync(abs)) return null;
    const ext = path.extname(abs) || '.png';
    const name = 'ic_' + pid.slice(0, 8) + '_' + role + '_' + asset.id.slice(0, 8) + ext;
    // 人物/服装/道具参考图送 H3 前先裁成「单人正面/左侧特写」（道具只裁白底多角度板），整张设定板不再送进去，
    // 从源头减少 H3 把三视图/设定板整张画进镜头。只裁不重绘；原图不动，裁切图另存 assets/_videorefs/（记源图 sha 与裁切框）。
    // 裁不准/出错一律回退原图并记 warn。关闭：config.generation.videoRefCrop = false。场景图不裁。
    // 人物 / 服装图：系统设置「人物参考图」缺省 sheet（整张三视图送进去，不裁）；设成 crop 才按旧做法裁单面。道具照旧裁。
    const cropThis = role === 'prop' || (role === 'char' && cfg?.generation?.characterRefSheet === 'crop');
    if (upload && cropThis && cfg?.generation?.videoRefCrop !== false) {
      const vr = await toVideoReferenceImage({
        projectDirAbs: projectDir(pid), asset, abs, kind: videoRefKind(asset),
        log: (lv, msg) => (lv === 'warn' ? logger.warn : logger.info)(msg),
      });
      if (vr?.path) return await uploadTaskInput(cfg, vr.path, 'ic_' + pid.slice(0, 8) + '_' + role + '_' + asset.id.slice(0, 8) + '_vr.png');
    }
    // 走渲染后端分派层（backend.uploadTaskInput）：原生通道返回本地文件名；RunningHub 通道必须
    // 把文件传到平台并返回平台的 fileName，云端工作流里的 LoadImage 才找得到它。
    // 原先固定调 comfyui.uploadToInput（写死 127.0.0.1:8188）：RunningHub 模式下参考图传到本机，
    // 云端任务因缺输入失败、本机没开 ComfyUI 时直接 ECONNREFUSED——「参考图 → 视频」整条不可用。
    return upload ? await uploadTaskInput(cfg, abs, name) : name;
  };

  const references = [];
  for (const c of chars) {
    const costume = costumeByChar[c.id];
    const age = ageByChar[c.id];
    // 优先级：服装 > 年龄变体 > 角色原图（年龄与服装为两个独立维度，不做叠加）
    const imgAsset = (costume && costume.image_path) ? costume : ((age && age.image_path) ? age : c);
    const img = await uploadImageRef(imgAsset, 'char');
    // 整张三视图送进去时，标签写明它是外观设定板，不是画面（配合出片后的「首尾帧直出参考图」检测）。
    const sheetNote = cfg?.generation?.characterRefSheet === 'crop' ? '' : '；人物三视图设定板，只作外观参考，不是画面，不要画成多格';
    if (img) references.push({ type: 'image', filename: img, label: c.name + (costume ? '（' + costume.name + sheetNote + '）' : (age ? '（' + age.name + sheetNote + '）' : '（人物形象' + sheetNote + '）')) });
  }
  for (const s of scenes) {
    const img = await uploadImageRef(s, 'scene');
    // 多视角定义图（场景号_MV，2×2：A 正打 / B 反打 / C 侧面 / D 俯视平面），2026-11-22 临时规则：
    // 标签写明不是首帧、不是故事板，避免模型把拼图当画面。
    // 名字或文件名里带 _MV / 多视角定义图 都算（库里实际命名是「S400_MV·海鲜自助餐厅·多视角定义图」「五缘金店·店内柜台·多视角定义图」，旧正则只认结尾 _MV，一张都认不出）。
    const isMV = /_MV|多视角定义图/i.test(String(s.name || '')) || /_MV[_.]|多视角定义图/i.test(String(s.image_path || ''));
    if (img) references.push({ type: 'image', filename: img, label: s.name + (isMV ? '（场景多视角空间定义图：A正打/B反打/C侧面/D俯视平面图；不是首帧，不是故事板）' : '（场景背景）') });
  }
  for (const pr of props) {
    const img = await uploadImageRef(pr, 'prop');
    if (img) references.push({ type: 'image', filename: img, label: pr.name + '（道具）' });
  }
  // 音频参考统一走 MAX_AUDIO_REFS 上限（MiniMax H3 节点 maxAudioVideo 上限）。
  // 顺序：①② 本镜 character_ids 顺序里凡是说话的角色（入画，或心声/OS、电话那头等角色画外）依次取音色
  //（多人同场仅说话角色才引用音色；2026-11-22 起全部台词由 H3 直出，心声/电话声也要本人音色参考）
  // → ③ 不在本镜角色里的画外说话人（电话那头等，按台词出现顺序，按名字从资产库找，见 voiceSampleFor）
  // → ④ 分镜显式绑定的独立音频素材（voice/music/sfx，含旁白/系统音音色）。同一人只送一次。
  // 旁白/广播/系统音不是角色，不配角色音色，只走 ④。
  const voiceSpeakers = dialogueVoiceSpeakers(shot.dialogue);
  const speakers = voiceSpeakers.filter((s) => !s.kind).map((s) => s.name);
  const offSpeakers = voiceSpeakers.filter((s) => s.kind);
  // 规范化后精确相等（lib/shared 的 nameMatches）：用 includes 双向包含匹配时，
  // 同场的「明」会因为对白里「小明」说话而被误判为说话人 —— 它的音色被一起提交，
  // 音色错乱，还会挤掉 MAX_AUDIO_REFS 名额把后面真正的参考音频截断。
  const speaks = (c) => speakers.some((s) => nameMatches(s, c.name));
  // 可观测性：对白里的说话人没匹配到本镜任何角色时，其音色会被静默跳过（不报错，用户只看到「这一镜没有声音」）。
  // 典型来源是「李雷，韩梅梅：台词」这类一行多说话人标签——dialogueSpeakerNames 会把整串逗号名当成一个名字，
  // 而 nameMatches 是规范化后精确相等，于是两人谁都匹配不上（顺带也让「单镜 ≤2 说话人」的校验失效）。
  // 这里只提示、不改判定：拆逗号会误伤台词正文（「小明，别走」），说话人归属属于内容层问题。
  const unmatchedSpeakers = speakers.filter((s) => !chars.some((c) => nameMatches(s, c.name)));
  if (unmatchedSpeakers.length) {
    logger.warn('分镜对白里的说话人未匹配到本镜角色，其音色不会被引用：' + unmatchedSpeakers.join('、')
      + '（每行台词只写一个说话人，如「李雷：你好」；多个说话人请拆成多行/多镜）');
  }
  const droppedAudio = [];
  const usedAudio = new Set();
  const pushAudio = async (rel, label, prefix) => {
    if (!rel) return;
    // 同一个文件只送一次（例：画外说话人按名字找到的 voice 资产又被分镜 audio_ids 绑了一次）
    const key = String(rel).replace(/\\/g, '/').trim();
    if (usedAudio.has(key)) return;
    if (references.filter((r) => r.type === 'audio').length >= MAX_AUDIO_REFS) { droppedAudio.push(label); return; }
    const abs = resolveProjectPath(pid, rel);
    if (!abs || !fs.existsSync(abs)) {
      // 本地不存在该音频文件：不引用，避免 ComfyUI LoadAudio 报 Invalid audio file 而整图被拒
      logger.warn('跳过不存在的参考音频：' + rel);
      return;
    }
    const ext = path.extname(rel) || '.flac';
    const cName = 'ic_' + pid.slice(0, 8) + '_' + prefix + ext;
    // 同 uploadImageRef：音频也必须走分派层（RunningHub 下需平台 fileName）
    const useName = upload ? await uploadTaskInput(cfg, abs, cName) : cName;
    usedAudio.add(key);
    references.push({ type: 'audio', filename: useName, label });
  };
  // ①② 本镜角色按 character_ids 顺序：凡是说话的（入画或角色画外）依次取音色。线上第1–10集提示词里的
  //「__MINIMAX_H3_REF_n__ is X's voice」都按这个顺序写（2026-11-22 主会话比对 67 镜），不能改成「入画在前、画外在后」。
  const voicedAssetIds = new Set();
  const offTag = { os: '（心声）', phone: '（电话那头）' };
  for (const c of chars) {
    if (!String(c.voice_ref || '').trim()) continue;
    const onscreen = speaks(c);
    const off = onscreen ? null : offSpeakers.find((sp) => nameMatches(sp.name, c.name));
    if (!onscreen && !off) continue;
    voicedAssetIds.add(c.id);
    const voices = String(c.voice_ref).split(/[\n,;，；]+/).map((s) => s.trim()).filter(Boolean);
    for (let vi = 0; vi < voices.length; vi++) {
      await pushAudio(voices[vi], c.name + '的声音' + (off ? (offTag[off.kind] || '') : ''), 'voice_' + c.id.slice(0, 8) + '_' + vi);
    }
  }
  // ③ 不在本镜角色里（或本镜角色没挂音色）的画外说话人（电话那头等），按台词出现顺序到整个资产库找
  // 同名角色 voice_ref / 同名 voice 资产。找不到只告警（不拦）：返回 offscreenVoiceMissing 供上层上报。
  const offscreenVoiceMissing = [];
  for (const sp of offSpeakers) {
    if (chars.some((c) => voicedAssetIds.has(c.id) && nameMatches(sp.name, c.name))) continue;
    const vs = voiceSampleFor(sp.name, assets);
    if (!vs || !vs.voice_ref) { offscreenVoiceMissing.push(sp.name); continue; }
    if (voicedAssetIds.has(vs.asset_id)) continue;
    voicedAssetIds.add(vs.asset_id);
    // voice 资产与下面 audio_ids 同口径取 audio_path 优先，同一资产再被 audio_ids 绑到时能去重
    const rel = vs.asset?.category === 'voice' ? (vs.asset.audio_path || vs.asset.voice_ref) : vs.voice_ref;
    await pushAudio(rel, sp.name + '的声音' + (offTag[sp.kind] || ''), 'voice_' + String(vs.asset_id).slice(0, 8) + '_0');
  }
  if (offscreenVoiceMissing.length) {
    logger.warn('画外说话人（心声/电话那头）没找到本人音色，H3 会自己编声音：' + offscreenVoiceMissing.join('、')
      + '（给同名角色挂 voice_ref，或建同名 voice 资产）');
  }
  // 独立音频素材：优先 audio_path，其次 voice_ref（voice 资产两者都写、music/sfx 只有 audio_path）
  const audioLabel = { voice: '语音', music: '音乐', sfx: '音效' };
  for (const aid of (shot.audio_ids || []).filter(Boolean)) {
    const a = assets.find((x) => x.id === aid);
    if (!a || voicedAssetIds.has(a.id)) continue; // 已作为画外说话人本人音色送过
    await pushAudio(a.audio_path || a.voice_ref, a.name + '（' + (audioLabel[a.category] || '音频') + '）', 'audio_' + a.id.slice(0, 8));
  }
  if (droppedAudio.length) {
    logger.warn('参考音频超过 ' + MAX_AUDIO_REFS + ' 段，已截断（仅保留前 ' + MAX_AUDIO_REFS + ' 段；顺序：本镜说话角色（按 character_ids）→ 本镜外的画外说话人 → 分镜绑定音频）。'
      + '保留：' + references.filter((r) => r.type === 'audio').map((r) => r.label).join('、') + '；丢弃：' + droppedAudio.join('、'));
  }
  if (!references.length) throw new Error('没有可用的参考素材（人物图/场景图/道具图/语音）');

  const imgCount = references.filter((r) => r.type === 'image').length;
  const avCount = references.filter((r) => r.type === 'audio' || r.type === 'video').length;
  if (imgCount > 9) throw new Error('参考图片过多（最多 9 张），当前 ' + imgCount + ' 张');
  if (avCount > MAX_AUDIO_REFS) throw new Error('参考音视频过多（最多 ' + MAX_AUDIO_REFS + ' 段），当前 ' + avCount + ' 段');

  const characterName = chars[0]?.name || '';
  // 服装规则（Andy 2026-11-24 02:23）：角色描述按本镜绑定的服装写——绑了服装图就用该服装资产的描述（与送去的参考图同一张），
  // 没绑服装才用年龄变体或人物主图描述。资产描述开头的登记字段（我方资产ID、审核、挂在角色）不进描述。
  const stripAdmin = (t) => String(t || '').replace(/^(?:\s*(?:我方资产ID|审核|挂在角色)[^；;]*[；;])+\s*/, '').trim();
  const characterDesc = chars.map((c) => {
    const costume = costumeByChar[c.id];
    if (costume) {
      const d = stripAdmin(costume.description) || costume.name || '';
      return c.name + '（本镜绑定服装：' + (costume.name || '') + '）：' + d;
    }
    const age = ageByChar[c.id];
    if (age && age.description) return c.name + '（' + (age.name || '') + '）：' + stripAdmin(age.description);
    return c.description || c.name;
  }).filter(Boolean).join('；');
  const sceneDesc = scenes.map((s) => s.description || s.name).filter(Boolean).join('；');
  return { references, chars, scenes, characterName, characterDesc, sceneDesc, unmatchedSpeakers, facingNotes, offscreenVoiceMissing, droppedAudio };
}
