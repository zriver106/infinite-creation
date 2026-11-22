// 手册（Manual）：分类 + 文档，目录与配置驱动。
// 存储：<IC_MANUAL_DIR>/manual.json（分类与文档清单） + <分类目录>/*.md（文档正文，Markdown）。
// IC 页面编辑的和写提示词时读的是同一份文件；每次保存前先把旧文件备份到 <root>/_backup/。
// 未写进 manual.json 的 .md 会被自动发现并显示（状态=现行），所以往目录里放文件也能新增文档。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export const MANUAL_ROOT = process.env.IC_MANUAL_DIR ? path.resolve(process.env.IC_MANUAL_DIR) : path.join(DATA_DIR, 'manual');
const MANIFEST = 'manual.json';
const BACKUP_DIR = '_backup';
export const MANUAL_STATUSES = ['现行', '草案'];
const MAX_DOC_BYTES = 2 * 1024 * 1024;

export class ManualError extends Error {
  constructor(message, status = 400, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function stamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function manifestPath() {
  return path.join(MANUAL_ROOT, MANIFEST);
}

function readManifest() {
  const p = manifestPath();
  if (!fs.existsSync(p)) throw new ManualError('手册目录未初始化：找不到 ' + p, 404);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new ManualError('manual.json 解析失败：' + e.message, 500);
  }
  if (!m || !Array.isArray(m.categories)) throw new ManualError('manual.json 缺少 categories', 500);
  return m;
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file, label) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(path.join(MANUAL_ROOT, BACKUP_DIR), { recursive: true });
  const dest = path.join(MANUAL_ROOT, BACKUP_DIR, `${label}.${stamp()}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

function writeManifest(m) {
  backupFile(manifestPath(), 'manual.json');
  atomicWrite(manifestPath(), JSON.stringify(m, null, 2) + '\n');
}

function safeSegment(name, what) {
  const s = String(name ?? '').trim();
  if (!s || s === '.' || s === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(s)) throw new ManualError(what + ' 不合法：' + s);
  return s;
}

function findCat(m, id) {
  const c = m.categories.find((x) => x.id === id);
  if (!c) throw new ManualError('找不到分类：' + id, 404);
  return c;
}

function docPath(cat, file) {
  const f = safeSegment(file, '文件名');
  if (!f.toLowerCase().endsWith('.md')) throw new ManualError('文档文件名必须以 .md 结尾');
  const dir = path.join(MANUAL_ROOT, safeSegment(cat.dir, '分类目录'));
  const full = path.join(dir, f);
  if (path.relative(dir, full).startsWith('..') || path.dirname(full) !== dir) throw new ManualError('路径越界');
  return full;
}

function statDoc(full) {
  try {
    const st = fs.statSync(full);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

export function listManual() {
  const m = readManifest();
  const categories = m.categories.map((c) => {
    const dirFull = path.join(MANUAL_ROOT, safeSegment(c.dir, '分类目录'));
    const declared = Array.isArray(c.docs) ? c.docs : [];
    const seen = new Set(declared.map((d) => d.file));
    const docs = declared.map((d) => ({ ...d, status: d.status || '现行', ...statDoc(docPath(c, d.file)) }));
    if (fs.existsSync(dirFull)) {
      const extra = fs.readdirSync(dirFull).filter((f) => f.toLowerCase().endsWith('.md') && !seen.has(f)).sort();
      for (const f of extra) docs.push({ file: f, title: f.replace(/\.md$/i, ''), status: '现行', source: '', auto: true, ...statDoc(path.join(dirFull, f)) });
    }
    return { id: c.id, title: c.title, dir: c.dir, desc: c.desc || '', docs };
  });
  return { root: MANUAL_ROOT, title: m.title || '手册', statuses: MANUAL_STATUSES, categories };
}

export function readDoc(catId, file) {
  const m = readManifest();
  const c = findCat(m, catId);
  const full = docPath(c, file);
  if (!fs.existsSync(full)) throw new ManualError('文档不存在：' + file, 404);
  const content = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
  const meta = (c.docs || []).find((d) => d.file === file) || { file, title: file.replace(/\.md$/i, ''), status: '现行', source: '' };
  return { cat: c.id, catTitle: c.title, file, path: full, title: meta.title, status: meta.status || '现行', source: meta.source || '', content, hash: sha(content), mtime: statDoc(full).mtime };
}

export function saveDoc(catId, file, content, baseHash) {
  if (typeof content !== 'string') throw new ManualError('content 必须是字符串');
  if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw new ManualError('文档过大（上限 2MB）', 413);
  const m = readManifest();
  const c = findCat(m, catId);
  const full = docPath(c, file);
  if (!fs.existsSync(full)) throw new ManualError('文档不存在：' + file, 404);
  const cur = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
  if (baseHash && baseHash !== sha(cur)) throw new ManualError('磁盘上的文件已被别处改动，请先刷新再编辑（未保存）', 409, { hash: sha(cur) });
  if (cur === content) return { changed: false, hash: sha(cur), backup: null, path: full };
  const backup = backupFile(full, `${c.dir}__${file}`);
  atomicWrite(full, content);
  return { changed: true, hash: sha(content), backup, path: full, mtime: statDoc(full).mtime };
}

export function updateDocMeta(catId, file, patch) {
  const m = readManifest();
  const c = findCat(m, catId);
  docPath(c, file);
  c.docs = Array.isArray(c.docs) ? c.docs : [];
  let d = c.docs.find((x) => x.file === file);
  if (!d) {
    d = { file, title: file.replace(/\.md$/i, ''), status: '现行', source: '' };
    c.docs.push(d);
  }
  if (patch.title !== undefined) d.title = String(patch.title).trim() || d.title;
  if (patch.status !== undefined) {
    if (!MANUAL_STATUSES.includes(patch.status)) throw new ManualError('状态只能是：' + MANUAL_STATUSES.join(' / '));
    d.status = patch.status;
  }
  writeManifest(m);
  return d;
}

export function createDoc(catId, title, file) {
  const t = String(title ?? '').trim();
  if (!t) throw new ManualError('标题不能为空');
  const m = readManifest();
  const c = findCat(m, catId);
  c.docs = Array.isArray(c.docs) ? c.docs : [];
  let f = file ? safeSegment(file, '文件名') : '';
  if (!f) {
    const n = String(c.docs.length + 1).padStart(2, '0');
    f = `${n}_${t.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}.md`;
  }
  if (!f.toLowerCase().endsWith('.md')) f += '.md';
  const full = docPath(c, f);
  if (fs.existsSync(full) || c.docs.some((d) => d.file === f)) throw new ManualError('同名文档已存在：' + f, 409);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  atomicWrite(full, `# ${t}\n`);
  c.docs.push({ file: f, title: t, status: '现行', source: '页面新建' });
  writeManifest(m);
  return { cat: c.id, file: f };
}

export function createCategory(title, dir, desc) {
  const t = String(title ?? '').trim();
  if (!t) throw new ManualError('分类名称不能为空');
  const m = readManifest();
  const d = safeSegment(dir || t, '分类目录');
  if (m.categories.some((c) => c.title === t || c.dir === d)) throw new ManualError('分类名称或目录已存在', 409);
  let id = 'cat' + (m.categories.length + 1);
  while (m.categories.some((c) => c.id === id)) id += 'x';
  m.categories.push({ id, title: t, dir: d, desc: String(desc || ''), docs: [] });
  fs.mkdirSync(path.join(MANUAL_ROOT, d), { recursive: true });
  writeManifest(m);
  return { id };
}