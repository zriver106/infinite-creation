// 交付复制的纯文件逻辑（只依赖 node:fs / path / crypto，单测直接 import，不碰数据库）。
//
// 规则（第六张小单 + 总导 17:40 决定）：
//   - 只写两类路径，resolve 后都必须仍在交付目录里：
//       <交付目录>\EP<N>.mp4
//       <交付目录>\历史候选\IC自动交付归档\EP<N>_<yyyyMMdd-HHmmss>.mp4
//     另有一个同目录临时文件 .EP<N>.mp4.ic-tmp-<时间戳>（本函数自己建的，失败时只删它自己）。
//   - 覆盖前先把旧 EP<N>.mp4 复制到归档，归档 sha256 必须等于旧件才继续；
//     新件先复制成临时文件并核 sha，再改名覆盖，覆盖后再核一次 sha = 成片 sha。
//   - 不枚举、不删除、不改名目录里任何别的文件（含 EP1_v10_候选、EP01.mp4 等）。
//   - 任何一步失败：EP<N>.mp4 保持原样，返回 { ok:false, step, error }，不抛异常，不重试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DELIVERY_ARCHIVE_SUBDIR = path.join('历史候选', 'IC自动交付归档');

export function hashFileAsync(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function insideDir(dir, abs) {
  const rel = path.relative(dir, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 交付目录本身的校验：必须是已存在的绝对路径目录。不替用户创建交付根目录（防止手误建出一堆目录）。
export function validateDeliveryDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return { ok: false, error: '交付目录为空' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '交付目录必须是绝对路径：' + raw };
  const abs = path.resolve(raw);
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: '交付目录不存在：' + abs }; }
  if (!st.isDirectory()) return { ok: false, error: '交付目录不是文件夹：' + abs };
  return { ok: true, dir: abs };
}

/**
 * 把成片 srcAbs 交付为 <deliveryDir>\EP<ep>.mp4。
 * @returns {Promise<object>} 结果对象（成功 ok:true；失败 ok:false + step + error），永不抛异常
 */
export async function deliverFileToDir({ deliveryDir, ep, srcAbs, now = new Date() }) {
  const out = { ok: false, ep, step: 'validate', target: '', sourceSha: '', previousSha: '', archivePath: '', finalSha: '', unchanged: false, error: '' };
  const fail = (step, error) => Object.assign(out, { ok: false, step, error: String(error && error.message ? error.message : error) });
  try {
    if (!Number.isInteger(ep) || ep < 1) return fail('validate', '章号不是正整数：' + ep);
    const v = validateDeliveryDir(deliveryDir);
    if (!v.ok) return fail('validate', v.error);
    const dir = v.dir;
    const name = 'EP' + ep + '.mp4';
    if (!/^EP[1-9][0-9]*\.mp4$/.test(name)) return fail('validate', '非法交付文件名：' + name);
    const target = path.join(dir, name);
    if (!insideDir(dir, target)) return fail('validate', '交付路径越界：' + target);
    out.target = target;

    out.step = 'hash-source';
    let srcSt;
    try { srcSt = fs.statSync(srcAbs); } catch { return fail('hash-source', '成片不存在：' + srcAbs); }
    if (!srcSt.isFile() || srcSt.size <= 0) return fail('hash-source', '成片为空或不是文件：' + srcAbs);
    out.sourceSha = await hashFileAsync(srcAbs);

    const ts = stamp(now);
    if (fs.existsSync(target)) {
      out.step = 'hash-previous';
      out.previousSha = await hashFileAsync(target);
      if (out.previousSha === out.sourceSha) {
        // 内容完全相同：不归档、不覆盖，直接算成功（避免同一份片子每次重合成都往归档里堆一份）
        out.unchanged = true;
        out.finalSha = out.previousSha;
        out.step = 'done';
        out.ok = true;
        return out;
      }
      out.step = 'archive';
      const archiveDir = path.join(dir, DELIVERY_ARCHIVE_SUBDIR);
      const archivePath = path.join(archiveDir, 'EP' + ep + '_' + ts + '.mp4');
      if (!insideDir(dir, archivePath)) return fail('archive', '归档路径越界：' + archivePath);
      fs.mkdirSync(archiveDir, { recursive: true });
      if (fs.existsSync(archivePath)) return fail('archive', '归档目标已存在，不覆盖：' + archivePath);
      fs.copyFileSync(target, archivePath, fs.constants.COPYFILE_EXCL);
      out.archivePath = archivePath;
      out.step = 'verify-archive';
      const archSha = await hashFileAsync(archivePath);
      if (archSha !== out.previousSha) return fail('verify-archive', '归档 sha256 与原 ' + name + ' 不一致，未覆盖');
    }

    out.step = 'copy-temp';
    const tmp = path.join(dir, '.' + name + '.ic-tmp-' + ts);
    if (!insideDir(dir, tmp)) return fail('copy-temp', '临时路径越界：' + tmp);
    if (fs.existsSync(tmp)) return fail('copy-temp', '临时文件已存在：' + tmp);
    fs.copyFileSync(srcAbs, tmp, fs.constants.COPYFILE_EXCL);
    const tmpSha = await hashFileAsync(tmp);
    if (tmpSha !== out.sourceSha) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 留着也不影响 EP 文件 */ }
      return fail('copy-temp', '临时文件 sha256 与成片不一致，未覆盖');
    }

    out.step = 'replace';
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      return fail('replace', '改名覆盖 ' + name + ' 失败（' + (e && e.message ? e.message : e) + '），临时文件留在：' + tmp);
    }

    out.step = 'verify-final';
    out.finalSha = await hashFileAsync(target);
    if (out.finalSha !== out.sourceSha) return fail('verify-final', '覆盖后 ' + name + ' 的 sha256 与成片不一致');
    out.step = 'done';
    out.ok = true;
    return out;
  } catch (e) {
    return fail(out.step, e);
  }
}
