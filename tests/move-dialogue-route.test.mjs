// 跨镜挪台词路由（主会话 seq2133）：直接调 POST，只用临时库，不提交出片、不碰 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installGpuGuard, writeTempIcConfig } from './helpers/gpu-guard.mjs';

installGpuGuard();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-move-dlg-'));
writeTempIcConfig(tmp);
const ROOT = process.cwd();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) return next(pathToFileURL(path.join(ROOT, spec.slice(2))).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});
const core = await import('../lib/core/index.js');
const { POST } = await import('../app/api/projects/[id]/chapters/[cid]/move-dialogue/route.js');
const { MOVE_DIALOGUE_SOURCE } = await import('../lib/core/dialogue-move.js');

const L14 = '江澈（OS）：仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。爷爷要是看见，是先惊讶，还是先骂我乱吃东西？';
const S1 = '仙丹真吃到了，竹匾里的药，我倒有一半认不出来了。';
let n = 0;
function world() {
  const p = core.Projects.create({ name: '挪台词测试' + (++n), auto_script: false });
  const c = core.Chapters.create(p.id, { title: '第24章', script: 'x' });
  const a = core.Shots.create(p.id, { chapter: '第24章', idx: 13, visual: '闪回竹匾', dialogue: '', video_prompt: 'old13' });
  const b = core.Shots.create(p.id, { chapter: '第24章', idx: 14, visual: '冲澡', dialogue: L14, video_prompt: 'old14' });
  const d = core.Shots.create(p.id, { chapter: '第24章', idx: 15, visual: '吃饭', dialogue: '老人：回来吃饭。', video_prompt: 'old15' });
  return { p, c, a, b, d };
}
const call = async (w, body) => {
  const r = await POST(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: w.p.id, cid: w.c.id }) });
  return { status: r.status, j: await r.json() };
};

test('dry_run 只预览不写', async () => {
  const w = world();
  const { status, j } = await call(w, { dry_run: true, moves: [{ from: w.b.id, to: w.a.id, text: S1 }] });
  assert.equal(status, 200, JSON.stringify(j)); assert.equal(j.dry_run, true);
  assert.equal(core.Shots.get(w.a.id).dialogue, ''); assert.equal(core.Shots.get(w.b.id).dialogue, L14);
});

test('rewrite=none：只改两镜 dialogue、同一批次、来源是挪台词通道、prompt_history 有记录、提示词不动', async () => {
  const w = world();
  const { status, j } = await call(w, { rewrite: 'none', moves: [{ from: w.b.id, to: w.a.id, text: S1 }] });
  assert.equal(status, 200, JSON.stringify(j));
  assert.equal(core.Shots.get(w.a.id).dialogue, '江澈（OS）：' + S1);
  assert.equal(core.Shots.get(w.b.id).dialogue, '江澈（OS）：爷爷要是看见，是先惊讶，还是先骂我乱吃东西？');
  assert.equal(core.Shots.get(w.d.id).dialogue, '老人：回来吃饭。');
  assert.equal(core.Shots.get(w.a.id).video_prompt, 'old13');
  const rows = core.getDb().prepare('select entity_id, source, batch_id from change_logs where project_id = ? and source = ?').all(w.p.id, MOVE_DIALOGUE_SOURCE);
  assert.deepEqual(new Set(rows.map((r) => r.entity_id)), new Set([w.a.id, w.b.id]));
  assert.equal(new Set(rows.map((r) => r.batch_id)).size, 1); assert.equal(rows[0].batch_id, j.batch_id);
  const hist = fs.readFileSync(path.join(core.projectDir(w.p.id), 'prompt_history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.action === 'move_dialogue');
  assert.equal(hist.length, 2); assert.equal(hist[0].batch_id, j.batch_id);
  assert.equal(j.job, null);
});

test('缺省交 IC 重写：交不上（本测试没配外部 Agent）时台词照样挪好、回 rewrite_error', async () => {
  const w = world();
  const { status, j } = await call(w, { moves: [{ from: w.b.id, to: w.a.id, text: S1 }] });
  assert.equal(status, 200, JSON.stringify(j)); assert.equal(j.rewrite, 'video_prompt');
  assert.ok(j.job || j.rewrite_error);
  assert.equal(core.Shots.get(w.a.id).dialogue, '江澈（OS）：' + S1);
});

test('拒绝：不相邻 400、改字 400、rewrite 非法 400，库不变', async () => {
  const w = world();
  assert.equal((await call(w, { moves: [{ from: w.b.id, to: w.d.id, text: '江澈：不存在。' }] })).status, 400);
  assert.equal((await call(w, { moves: [{ from: w.d.id, to: w.a.id, text: '回来吃饭。' }] })).status, 400);
  assert.equal((await call(w, { rewrite: 'x', moves: [] })).status, 400);
  assert.equal(core.Shots.get(w.b.id).dialogue, L14);
});
