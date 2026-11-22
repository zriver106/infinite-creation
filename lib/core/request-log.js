// 提交类 API 的请求日志：只记录，不拦截、不改响应、不挡任务。
// 记录时间（logger 时间戳）、来源 IP、User-Agent、章节、镜头、X-Caller（空也记）、job id。
// 读头失败或日志本身抛错时吞掉，不能影响原接口。
import { logger } from './logger.js';

function header(req, name) {
  try {
    if (!req || !req.headers) return '';
    if (typeof req.headers.get === 'function') return String(req.headers.get(name) || '');
    const v = req.headers[name] || req.headers[String(name).toLowerCase()];
    if (Array.isArray(v)) return String(v[0] || '');
    return String(v || '');
  } catch {
    return '';
  }
}

/** 来源 IP：优先自定义服务器写入的 x-ic-remote-ip（客户端伪造的同名头会在 server.js 里丢掉再重写），其次 X-Forwarded-For 首项、X-Real-IP。 */
export function requestIp(req) {
  const stamped = header(req, 'x-ic-remote-ip').trim();
  if (stamped) return stamped;
  const xff = header(req, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return header(req, 'x-real-ip').trim();
}

export function requestUserAgent(req) {
  return header(req, 'user-agent');
}

export function requestCaller(req) {
  return header(req, 'x-caller');
}

function asList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)];
}

/**
 * @param {Request|object} req
 * @param {{ route: string, projectId?: string, chapter?: string, shots?: string|string[], jobId?: string, jobIds?: string[] }} fields
 */
export function logSubmitRequest(req, fields) {
  try {
    const f = fields || {};
    const jobIds = asList(f.jobIds && f.jobIds.length ? f.jobIds : f.jobId);
    const shots = asList(f.shots);
    logger.info('提交请求', {
      route: String(f.route || ''),
      projectId: String(f.projectId || ''),
      chapter: String(f.chapter || ''),
      shots,
      jobId: jobIds[0] || '',
      jobIds,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
      caller: (f.caller != null) ? String(f.caller) : requestCaller(req),
    });
  } catch {
    /* 只记录：日志失败不能影响接口 */
  }
}
