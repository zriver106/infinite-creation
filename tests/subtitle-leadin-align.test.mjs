// 11-28 跟进2 报：第 1 章 3 镜带承接 22 帧，导出合并前剪掉了（66 帧 = 2.75 秒），字幕对齐按未剪的时长找章节，对不上直接 500。
// script_align.load_script 必须按导出同一口径（shot_videos 选中候选的 lead_in_frames，24 帧/秒）扣掉承接部分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PY = process.platform === 'win32' ? 'python' : 'python3';
function havePy() { try { execFileSync(PY, ['-c', 'import sqlite3'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('字幕对齐：承接镜按 lead_in_frames/24 扣时长，总长对上剪过的音轨', { skip: !havePy() && '没有 python' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-align-'));
  const db = path.join(tmp, 'ic.db');
  const script = path.resolve('scripts/subtitle/script_align.py');
  const py = `
import sqlite3, sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(script))})
db = ${JSON.stringify(db)}
c = sqlite3.connect(db)
c.executescript('''
CREATE TABLE chapters(project_id, title, seq);
CREATE TABLE shots(id, project_id, idx, chapter, dialogue, narration, video_prompt_used, video_prompt, video_path, duration, status);
CREATE TABLE shot_videos(id, project_id, shot_id, video_path, selected, lead_in_frames);
INSERT INTO chapters VALUES('p','c1',1);
INSERT INTO shots VALUES('s1','p',1,'c1','A：一','', '', '', 'shots/a.mp4', 5, 'done');
INSERT INTO shots VALUES('s2','p',2,'c1','B：二','', '', '', 'shots/b.mp4', 6, 'done');
INSERT INTO shot_videos VALUES('v1','p','s1','shots/a.mp4',1,0);
INSERT INTO shot_videos VALUES('v2','p','s2','shots/b.mp4',1,22);
''')
c.commit(); c.close()
import script_align as a
a._connect_ro = lambda: sqlite3.connect(db)
a._audio_duration = lambda p, probe: None          # 没有真文件：走 db_duration
a._ffprobe_bin = lambda: None
a._project_file = lambda pid, rel: '/x/' + rel
shots, info = a.load_script(5 + 6 - 22 / 24.0, 'p', 'c1')
print(json.dumps({'total': info['total'], 'second_start': shots[1]['start'], 'second_end': shots[1]['end']}))
`;
  const out = JSON.parse(execFileSync(PY, ['-I', '-c', py], { encoding: 'utf8' }).trim().split(/\r?\n/).pop());
  assert.ok(Math.abs(out.total - (11 - 22 / 24)) < 1e-6, '总长扣掉 22 帧');
  assert.equal(out.second_start, 5);
  assert.ok(Math.abs(out.second_end - (11 - 22 / 24)) < 1e-6);
});
