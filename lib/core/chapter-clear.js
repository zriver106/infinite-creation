// 章节清理：先把本章分镜 / 候选视频 / 成片归档并核对哈希，再删库和原件。
// 素材库资产（人物 / 场景 / 道具 / 音色 / 音乐文件）、剧本文本、章节配乐绑定一律不动。
// 不读、不写、不删任何「交付目录」。不提交任务，不调用 startCreateJob。
//
// 整个 clearChapter 是同步函数（fs 同步 API + node:sqlite 同步事务），中途没有 await：
// 「检查本章没有活动任务」到「删库」之间，本进程里不会插进新的任务提交。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Chapters, Shots, ShotVideos, Projects, Jobs, tx } from './db.js';
import { withWriteContext, currentBatchId, rollbackLogs } from './changelog.js';
import { loadConfig, projectDir, ROOT, DATA_DIR } from './config.js';
import { resolveProjectPath } from './refs.js';
import { slugify } from './utils.js';

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;
// 成片命名（tools.js hAssembleVideo 第 2072–2073、2099、2105 行；export/route.js 第 22–23、34–35 行）：
//   exports/{slugify(项目)}_{slugify(章)}_{uid8}.mp4，及同名 _nosub.mp4、.srt
// 前缀之后必须恰好是 8 位十六进制 + 可选 _nosub + 扩展名，否则「第2章」会误伤「第2章_心声验证」的成片。
const EXPORT_TAIL_RE = /^[0-9a-f]{8}(_nosub)?\.(mp4|srt)$/i;

// 分块读取算 sha256，避免把几百 MB 的视频整份读进内存
function hashFile(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function safeSegment(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return (t || 'item').slice(0, 60);
}

function stampLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 章节清理归档根：config.json 的 archive.chapterClearDir > 环境变量 IC_CHAPTER_ARCHIVE_DIR > data/chapter-clear-archives。
// 不写死某台机器的 moviePro 绝对路径；相对路径按仓库根解析。
export function chapterArchiveRoot() {
  let fromCfg = '';
  try {
    const cfg = loadConfig();
    fromCfg = String((cfg && cfg.archive && cfg.archive.chapterClearDir) || '').trim();
  } catch { /* 配置读不到时走环境变量 / 默认 */ }
  const fromEnv = String(process.env.IC_CHAPTER_ARCHIVE_DIR || '').trim();
  const raw = fromCfg || fromEnv;
  if (raw) return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  return path.join(DATA_DIR, 'chapter-clear-archives');
}

// 挡住本章清理的活动任务（running / queued）。口径比 job-runner.js 的 jobTouchesChapter（第 610–621 行）更保守：
// - create / stage / chapter-video：checkpoint.chapter 等于本章；没有 chapter 的 create / stage 视为覆盖全部章节
// - regenerate（单镜重生成）：checkpoint.subject 是分镜 id，按分镜所属章节判断
// - export（手动导出，checkpoint 只有 subject）/ music-apply（换配乐后重新合成）：会读写本章分镜视频和 exports/，一律挡
// lib/core 不引用 lib/agent，这里自己实现；clear 路由另外再用 activeJobOfChapter 查一次。
export function chapterClearBusyJobs(projectId, chapterTitle) {
  const want = String(chapterTitle || '');
  return Jobs.list(projectId).filter((j) => {
    // ic25：adopted = 后端重启后外部 Agent 还在往本章写镜，同样挡住清理
    if (j.status !== 'running' && j.status !== 'queued' && j.status !== 'adopted') return false;
    if (j.type === 'export' || j.type === 'music-apply') return true;
    const cp = j.checkpoint || {};
    let jc = String(cp.chapter || '');
    if (!jc && j.type === 'regenerate' && cp.subject) {
      jc = String((Shots.get(cp.subject) || {}).chapter || '');
      if (!jc) return true;
    }
    if (jc) return jc === want;
    return j.type === 'create' || j.type === 'stage';
  });
}

function listExportRels(projectId, projectName, chapterTitle) {
  const dir = path.join(projectDir(projectId), 'exports');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const prefix = slugify(projectName) + '_' + slugify(chapterTitle) + '_';
  const hit = [];
  for (const name of names) {
    if (path.basename(name) !== name) continue;
    if (!name.startsWith(prefix)) continue;
    if (!EXPORT_TAIL_RE.test(name.slice(prefix.length))) continue;
    hit.push(name);
  }
  return hit.sort().map((name) => 'exports/' + name);
}

// 本章「主成片」（不含 _nosub 和 .srt）及其修改时间，按时间新→旧。自动续章判「出片成功」用。
const MAIN_EXPORT_TAIL_RE = /^[0-9a-f]{8}\.mp4$/i;
export function chapterMainExports(projectId, projectName, chapterTitle) {
  const prefix = slugify(projectName) + '_' + slugify(chapterTitle) + '_';
  const out = [];
  for (const rel of listExportRels(projectId, projectName, chapterTitle)) {
    const name = rel.slice('exports/'.length);
    if (!MAIN_EXPORT_TAIL_RE.test(name.slice(prefix.length))) continue;
    const abs = resolveProjectPath(projectId, rel);
    if (!abs) continue;
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size > 0) out.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* 文件刚被删 */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listChapterFileRels(projectId, project, chapter, shots, shotVideos) {
  const rels = new Set();
  const add = (rel) => {
    if (!rel) return;
    const norm = String(rel).replace(/\\/g, '/');
    if (!resolveProjectPath(projectId, norm)) return; // 越界路径一律忽略（refs.js 第 17–24 行）
    rels.add(norm);
  };
  for (const s of shots) {
    add(s.video_path);
    add(s.first_frame_path);
    add(s.last_frame_path);
    add(s.reference_image_path);
  }
  for (const v of shotVideos) add(v.video_path);
  for (const rel of listExportRels(projectId, project.name, chapter.title)) add(rel);
  // 章节封面由第一条已完成分镜视频抽帧缓存（refs.js 第 31–45 行，存在即复用）；不清掉会在章节列表里留下旧封面
  add('posters/' + chapter.id + '.jpg');
  return [...rels];
}

// 只保留「项目目录里真实存在的普通文件」。素材库 assets/ 下的路径即使被分镜引用也不收（防误删素材）。
function existingFiles(projectId, rels) {
  const out = [];
  for (const rel of rels) {
    if (rel.startsWith('assets/') || rel.startsWith('references/') || rel.startsWith('novel/') || rel.startsWith('context/')) continue;
    const abs = resolveProjectPath(projectId, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (!st.isFile()) continue;
    out.push({ rel, abs, size: st.size });
  }
  return out;
}

function loadTargets(projectId, chapterId) {
  const project = Projects.get(projectId);
  if (!project) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' });
  const chapter = Chapters.get(chapterId);
  if (!chapter || chapter.project_id !== projectId) throw Object.assign(new Error('章节不存在'), { code: 'NOT_FOUND' });
  // 清空本章要连作废镜一起归档（它们也挂在本章标题下，留着会成为看不见的孤儿行）
  const shots = Shots.list(projectId, { includeObsolete: true }).filter((s) => s.chapter === chapter.title);
  const shotVideos = shots.flatMap((s) => ShotVideos.listByShot(s.id));
  const files = existingFiles(projectId, listChapterFileRels(projectId, project, chapter, shots, shotVideos));
  return { project, chapter, shots, shotVideos, files };
}

const WILL_KEEP = [
  '素材库资产（人物 / 场景 / 道具 / 音色 / 音乐文件）',
  '章节原文 novel、剧本 script、大纲 outline',
  '章节配乐绑定 music_path / music_prompt',
  '参考图 reference_images',
  '任务记录 jobs / messages、变更日志 change_logs',
  '其他章节的分镜、视频和成片',
  '交付目录（不读不写）',
];

export function previewChapterClear(projectId, chapterId, { extraBusy = [] } = {}) {
  const { project, chapter, shots, shotVideos, files } = loadTargets(projectId, chapterId);
  const busy = [...chapterClearBusyJobs(projectId, chapter.title), ...extraBusy.filter(Boolean)];
  const seen = new Set();
  const active = busy.filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
  return {
    projectId,
    projectName: project.name,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    blocked: active.length > 0,
    blockReason: active.length ? '本章有任务正在运行或排队，不能清理' : '',
    activeJobs: active.map((j) => ({ id: j.id, type: j.type, status: j.status })),
    shots: shots.length,
    shotVideos: shotVideos.length,
    videosOnDisk: files.filter((f) => f.rel.startsWith('shots/') && VIDEO_RE.test(f.rel)).length,
    exportFiles: files.filter((f) => f.rel.startsWith('exports/')).length,
    poster: files.some((f) => f.rel.startsWith('posters/')) ? 1 : 0,
    filesOnDisk: files.length,
    bytesOnDisk: files.reduce((n, f) => n + f.size, 0),
    nothingToClear: shots.length === 0 && files.length === 0,
    musicBindingKept: !!(chapter.music_path || chapter.music_prompt),
    archiveRoot: chapterArchiveRoot(),
    willDelete: { shots: shots.length, shotVideos: shotVideos.length, files: files.map((f) => ({ rel: f.rel, size: f.size })) },
    willKeep: WILL_KEEP,
  };
}

function copyAndHash(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (fs.existsSync(destAbs)) throw Object.assign(new Error('归档目标已存在：' + destAbs), { code: 'ARCHIVE_EXISTS' });
  fs.copyFileSync(srcAbs, destAbs, fs.constants.COPYFILE_EXCL);
  const srcHash = hashFile(srcAbs);
  const dstHash = hashFile(destAbs);
  if (srcHash !== dstHash) throw Object.assign(new Error('归档哈希不一致：' + srcAbs + ' → ' + destAbs), { code: 'HASH_MISMATCH' });
  return srcHash;
}

function fail(message, code, archiveDir) {
  return Object.assign(new Error(message), { code, archiveDir: archiveDir || '' });
}

// 归档 → 二次核哈希 → 事务删库 → 删原件。任何一步在删库之前失败：库和原件都不动，归档目录保留现场（不自动删）。
export function clearChapter(projectId, chapterId, { extraBusy = [] } = {}) {
  const preview = previewChapterClear(projectId, chapterId, { extraBusy });
  if (preview.blocked) throw fail(preview.blockReason, 'CHAPTER_BUSY');
  const { project, chapter, shots, shotVideos, files } = loadTargets(projectId, chapterId);
  if (!shots.length && !files.length) throw fail('本章没有分镜、视频或成片，无需清理', 'NOTHING_TO_CLEAR');

  const archiveRoot = chapterArchiveRoot();
  const archiveDir = path.join(archiveRoot, safeSegment(project.name) + '_' + safeSegment(chapter.title) + '_' + stampLocal());
  if (fs.existsSync(archiveDir)) throw fail('归档目录已存在：' + archiveDir, 'ARCHIVE_EXISTS', archiveDir);
  fs.mkdirSync(path.join(archiveDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, 'db'), { recursive: true });

  // 1) 复制（不是移动）+ 源 / 目标各算一次 sha256
  const manifestFiles = [];
  try {
    for (const f of files) {
      const archiveRel = 'files/' + f.rel;
      const destAbs = path.resolve(archiveDir, archiveRel);
      const inside = path.relative(archiveDir, destAbs);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw fail('非法归档路径：' + f.rel, 'BAD_PATH');
      const sha256 = copyAndHash(f.abs, destAbs);
      manifestFiles.push({ originalRel: f.rel, archiveRel, sha256, size: f.size });
    }
  } catch (e) {
    throw fail('归档或哈希核对失败，已停止，原文件和数据库都没有动：' + (e && e.message ? e.message : e), (e && e.code) || 'ARCHIVE_FAILED', archiveDir);
  }

  // 2) 库记录快照（Shots.list / listByShot 的解析后对象；恢复不靠它，靠 change_logs 批次 + 候选清单）
  fs.writeFileSync(path.join(archiveDir, 'db', 'shots.json'), JSON.stringify(shots, null, 2), 'utf8');
  fs.writeFileSync(path.join(archiveDir, 'db', 'shot_videos.json'), JSON.stringify(shotVideos, null, 2), 'utf8');
  fs.writeFileSync(path.join(archiveDir, 'db', 'chapter.json'), JSON.stringify(chapter, null, 2), 'utf8');

  // 3) 删库前再核一次：归档件和原件都还等于第一次的哈希
  for (const item of manifestFiles) {
    const destAbs = path.resolve(archiveDir, item.archiveRel);
    const srcAbs = resolveProjectPath(projectId, item.originalRel);
    if (!srcAbs || !fs.existsSync(destAbs) || hashFile(destAbs) !== item.sha256 || hashFile(srcAbs) !== item.sha256) {
      throw fail('归档后二次哈希核对失败，已停止，原文件和数据库都没有动：' + item.originalRel, 'HASH_MISMATCH', archiveDir);
    }
  }

  // 4) 先落一份清单（删库之前就有，万一后面出错也能看到归档了什么），删库后补上 batch_id 再写一次
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectId,
    projectName: project.name,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    archiveDir,
    changeLogBatchId: '',
    dbCleared: false,
    files: manifestFiles,
    db: {
      shots: shots.length,
      shotVideos: shotVideos.length,
      shotVideoRows: shotVideos.map((v) => ({ shot_id: v.shot_id, idx: v.idx, video_path: v.video_path, seed: v.seed, selected: !!v.selected })),
    },
    kept: WILL_KEEP,
    restore: 'restoreChapterClear(archiveDir)：先按 files 拷回原相对路径并核哈希，再 rollbackLogs({ projectId, batchId: changeLogBatchId }) 复原 shots，最后按 shotVideoRows 重建候选。本轮未接入界面。',
  };
  const manifestPath = path.join(archiveDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // 5) 事务删库：复用 Shots.remove（db.js 第 833–838 行，先删 shot_videos 再删 shots，并写 change_logs）。
  //    与「重新生成分镜」beforeRun 同口径（regenerate/route.js 第 27–32 行）。记下 batch_id，供将来按批回滚。
  let batchId = '';
  withWriteContext('chapter-clear', () => tx(() => {
    batchId = currentBatchId();
    for (const s of shots) Shots.remove(s.id);
    Chapters.update(chapter.id, { status: 'pending' });
  }));
  manifest.changeLogBatchId = batchId;
  manifest.dbCleared = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // 6) 删原件（库已提交；个别删除失败只报告，文件仍在、归档也在）
  const deleted = [];
  const deleteFailed = [];
  for (const item of manifestFiles) {
    const srcAbs = resolveProjectPath(projectId, item.originalRel);
    if (!srcAbs) { deleteFailed.push(item.originalRel); continue; }
    try {
      fs.rmSync(srcAbs, { force: true });
      deleted.push(item.originalRel);
    } catch {
      deleteFailed.push(item.originalRel);
    }
  }
  fs.writeFileSync(path.join(archiveDir, 'result.json'), JSON.stringify({ finishedAt: new Date().toISOString(), deleted, deleteFailed }, null, 2), 'utf8');

  return {
    ok: true,
    archiveDir,
    manifest: path.join(archiveDir, 'manifest.json'),
    changeLogBatchId: batchId,
    archivedFiles: manifestFiles.length,
    shotsRemoved: shots.length,
    shotVideosRemoved: shotVideos.length,
    filesDeleted: deleted.length,
    deleteFailed,
  };
}

// 恢复（本轮不接入界面 / API，留给总导需要时手动调用）。不手写 SQL：
// shots 走 change_logs 的 rollbackLogs（INSERT OR REPLACE 原始行，changelog.js 第 7–8、232 行起）；
// shot_videos 不进 change_logs，用 ShotVideos.create + setSelected 按清单重建（候选 id 会变，shots.video_path 不变）。
export function restoreChapterClear(archiveDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  const projectId = manifest.projectId;
  if (!Projects.get(projectId)) throw new Error('项目不存在，无法恢复');
  const chapter = Chapters.get(manifest.chapterId);
  if (!chapter || chapter.project_id !== projectId) throw new Error('章节不存在，无法恢复');
  if (Shots.list(projectId).some((s) => s.chapter === chapter.title)) throw new Error('本章现在已有分镜，中止恢复（避免和新分镜混在一起）');

  // 预检：归档件哈希不变；原位置若已有同名文件且内容不同，中止，不覆盖
  for (const item of manifest.files || []) {
    const src = path.resolve(archiveDir, item.archiveRel);
    if (!fs.existsSync(src)) throw new Error('归档缺文件：' + item.archiveRel);
    if (hashFile(src) !== item.sha256) throw new Error('归档文件哈希变化：' + item.archiveRel);
    const dest = resolveProjectPath(projectId, item.originalRel);
    if (!dest) throw new Error('非法原路径：' + item.originalRel);
    if (fs.existsSync(dest) && hashFile(dest) !== item.sha256) throw new Error('原位置已有不同内容的文件，中止恢复：' + item.originalRel);
  }
  for (const item of manifest.files || []) {
    const src = path.resolve(archiveDir, item.archiveRel);
    const dest = resolveProjectPath(projectId, item.originalRel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    if (hashFile(dest) !== item.sha256) throw new Error('恢复后哈希不一致：' + item.originalRel);
  }

  let rolled = null;
  if (manifest.changeLogBatchId && manifest.db && manifest.db.shots > 0) {
    rolled = rollbackLogs({ projectId, batchId: manifest.changeLogBatchId });
    if (rolled && rolled.blocked) throw new Error('变更日志回滚被漂移保护拦下，未恢复分镜；请人工核对后再决定是否 force');
  }
  let videos = 0;
  tx(() => {
    for (const v of (manifest.db && manifest.db.shotVideoRows) || []) {
      if (!Shots.get(v.shot_id)) continue;
      const created = ShotVideos.create(projectId, v.shot_id, { idx: v.idx || 0, video_path: v.video_path || '', seed: v.seed || 0 });
      if (v.selected && created) ShotVideos.setSelected(v.shot_id, created.id);
      videos++;
    }
  });
  return { ok: true, files: (manifest.files || []).length, shotsRolledBack: rolled ? (rolled.applied || []).length : 0, shotVideos: videos };
}
