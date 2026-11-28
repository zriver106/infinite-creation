// 11-28 跟进2 报：网页「导出」路由漏了帧率收尾（裁 1080 + RIFE 30 帧），只有 hAssembleVideo 调了 finalizeExport。
// 两条导出路径都必须过同一个 finalizeExport，主成片和无字幕版都要收尾。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('网页导出路由调用 finalizeExport（主成片和 _nosub 两份），并经 withGpuAccess 过 GPU 闸门', () => {
  const src = fs.readFileSync(new URL('../app/api/projects/[id]/export/route.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ finalizeExport \} from '@\/lib\/core\/fps-finalize\.js'/);
  assert.match(src, /for \(const rel of \[outRel, subtitles \? nosubRel : ''\]\.filter\(Boolean\)\)/);
  assert.match(src, /finalizeExport\(id, resolveProjectPath\(id, rel\)[\s\S]*?withGpuAccess/);
  // 收尾在合并之后、交付之前
  assert.ok(src.indexOf('finalizeExport(id') > src.indexOf('await mergeVideos(inputs, resolveProjectPath(id, outRel)'));
  assert.ok(src.indexOf('finalizeExport(id') < src.indexOf('deliverChapterExport({'));
});
