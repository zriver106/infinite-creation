#!/usr/bin/env node
// ic25 重启恢复运行时开关：查看 / 设置 DATA_DIR/control/restart-recovery.json（后端每次判定时现读，不用重启）。
// 只写这一个控制文件，不碰 ic.db、不调接口、不动任何任务。
//   node scripts/recovery-control.mjs                      查看当前生效值
//   node scripts/recovery-control.mjs report-only          只记录：外部 Agent 退出后不记完成 / 不补交付 / 不继续 / 不续章
//   node scripts/recovery-control.mjs no-resume            没出完时不自动「继续」（出完了照常记完成、补交付、续章）
//   node scripts/recovery-control.mjs no-chain             不触发续章（恢复不续、守护也暂停出片续章）
//   node scripts/recovery-control.mjs manual               = no-resume + no-chain
//   node scripts/recovery-control.mjs auto                 恢复默认（等于删掉控制文件）
//   加 --project <projectId> 只改这个项目（覆盖全局）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.IC_DATA_DIR ? path.resolve(process.env.IC_DATA_DIR) : path.join(ROOT, 'data');
const file = path.join(DATA_DIR, 'control', 'restart-recovery.json');
const MODES = ['auto', 'report-only', 'no-resume', 'no-chain', 'manual'];

const args = process.argv.slice(2);
const pi = args.indexOf('--project');
const project = pi >= 0 ? String(args[pi + 1] || '') : '';
const mode = args.find((a, i) => !a.startsWith('--') && (pi < 0 || i !== pi + 1)) || '';

let cur = {};
try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = {}; }
if (!mode) {
  console.log(file);
  console.log(fs.existsSync(file) ? JSON.stringify(cur, null, 2) : '（没有控制文件 = auto）');
  process.exit(0);
}
if (!MODES.includes(mode)) { console.error('未知 mode：' + mode + '，可选 ' + MODES.join(' / ')); process.exit(2); }
if (project) {
  cur.projects = cur.projects || {};
  if (mode === 'auto') delete cur.projects[project]; else cur.projects[project] = { mode };
} else if (mode === 'auto') {
  delete cur.mode; delete cur.reportOnly; delete cur.resume; delete cur.chain;
} else {
  cur = { ...cur, mode };
  delete cur.reportOnly; delete cur.resume; delete cur.chain;
}
cur.updatedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = file + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
fs.renameSync(tmp, file);
console.log('已写入 ' + file);
console.log(JSON.stringify(cur, null, 2));
