#!/usr/bin/env node
// 场景三视图审图（手册 13 号；总导 11-28）：登记一轮候选并跑审图任务（同一套外部 Agent 执行器），等审完打印结论。
//   node scripts/scene-review.mjs <projectId> <scene_id> <候选目录> [--round r3]
// 候选目录：art_plan / art_front / art_left / art_right（.png/.jpg/.webp，只交几张也行，没交的沿用已定稿 art/）；
// 灰模 平面图.png 等（及 *_标注.png）可放在里面，没有就用母本目录下导出的那份。
// 数据目录同服务（IC_DATA_DIR，缺省 <仓库>/data）。过了写进 scene_master/<scene_id>/art/（旧图备份到 art_history/）并拼白板_2x2.jpg；不过写 candidates/<round>/退回意见.md。
import path from 'node:path';

const args = process.argv.slice(2);
const ri = args.indexOf('--round');
const round = ri >= 0 ? String(args[ri + 1] || '') : '';
const pos = args.filter((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1));
const [projectId, sceneId, candidateDir] = pos;
if (!projectId || !sceneId || !candidateDir) {
  console.error('用法：node scripts/scene-review.mjs <projectId> <scene_id> <候选目录> [--round r3]');
  process.exit(2);
}

const { Projects } = await import('../lib/core/index.js');
const { reviewSceneCandidates } = await import('../lib/agent/scene-review.js');
if (!Projects.get(projectId)) { console.error('项目不存在：' + projectId); process.exit(2); }
try {
  const r = reviewSceneCandidates(projectId, sceneId, path.resolve(candidateDir), { round });
  console.log(JSON.stringify({ round: r.round, job_id: r.job_id, new_views: r.new_views, fallback_views: r.fallback_views, ratio: r.ratio }, null, 2));
  console.log('审图中……');
  const out = await r.done;
  console.log(JSON.stringify(out, null, 2));
  process.exit(out && out.status === 'accepted' ? 0 : 1);
} catch (e) {
  console.error('失败：' + e.message);
  process.exit(1);
}
