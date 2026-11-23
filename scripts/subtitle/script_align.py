"""剧本对齐：字以镜头 dialogue 字段为准，时间以声音为准。

transcribe.py 调用 align_to_script()：
  1) 从 ic.db（只读）找到本次导出的章节，按 mergeVideos 同顺序取镜头；字幕文本只取 shots.dialogue
     （去掉「人物：」/「人物（OS）：」前缀），不从 <d>、narration、sub_shots、ASR 或其他字段取。
     用 ffprobe 量出每镜实际音轨时长，校验总长与待识别 WAV 一致；
  2) dialogue 切成字幕单元（按标点断句，单条 ≤16 字）；
  3) 剧本文字与 whisper 逐字时间做序列对齐（difflib），用 dialogue 文字替换识别文字（ASR 只提供时间）；
  4) 对不齐的镜头：在该镜时间窗内带剧本提示二次识别；仍不齐就退回该镜窗口内的能量发声区间（时间仍按 dialogue 字走）；
  5) 不在 dialogue 里的识别内容（幻觉、同音错字）自然被丢弃；超出片长的字幕去掉。
某镜有 <d> 或 narration 却没有 dialogue，或对齐失败：抛异常，由 transcribe.py 报错退出，不得回退 ASR 原文。
所有日志只写 stderr，stdout 协议不变。
"""

import difflib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import wave

MAX_CUE_CHARS = 16          # 单条字幕最多字数（不含标点）
CHAR_SEC = 0.2              # 估算语速：每字秒数（只用于补齐未匹配的首尾字）
END_PAD = 0.12              # 字幕在最后一个字发声结束后多留一点
MIN_CUE_SEC = 0.6           # 单条最短显示
SHOT_GUARD = 1.0            # 识别字时间允许越出镜头窗口的余量
DUR_TOL = 0.6               # 镜头总时长与 WAV 时长允许误差（秒）

PUNCT = set('，。！？、；：,.!?;:…—-~～·“”"\'‘’（）()《》<>【】[]「」 \t\r\n')
SENT_END = '。！？!?'
CLAUSE_END = '，、；：,;:—…'
TRAIL_STRIP = '，、；：,;:'


def log(*a):
    try:
        sys.stderr.write('[align] ' + ' '.join(str(x) for x in a) + '\n')
        sys.stderr.flush()
    except Exception:
        pass


# ---------------- 路径 / 数据库（只读） ----------------

def _root():
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def _data_dir():
    v = os.environ.get('IC_DATA_DIR')
    return os.path.abspath(v) if v else os.path.join(_root(), 'data')


def _db_path():
    v = os.environ.get('IC_DB_SQLITE_PATH')
    return os.path.abspath(v) if v else os.path.join(_data_dir(), 'ic.db')


def _media_dir():
    v = os.environ.get('IC_MEDIA_DIR')
    return os.path.abspath(v) if v else os.path.join(_data_dir(), 'projects')


def _connect_ro():
    p = _db_path().replace('\\', '/')
    if not p.startswith('/'):
        p = '/' + p
    return sqlite3.connect('file:' + p + '?mode=ro', uri=True, timeout=5)


def _project_file(pid, rel):
    if not rel:
        return None
    base = os.path.join(_media_dir(), pid)
    ab = os.path.abspath(os.path.join(base, rel))
    if not ab.startswith(os.path.abspath(base) + os.sep):
        return None
    return ab


def _narrative_shots(conn, pid, chapter):
    sql = ('SELECT s.idx, s.chapter, s.dialogue, s.narration, s.video_prompt_used, s.video_prompt, s.video_path, s.duration '
           'FROM shots s WHERE s.project_id = ? AND s.video_path IS NOT NULL AND s.video_path != \'\' AND s.status = \'done\' '
           'ORDER BY COALESCE((SELECT MIN(c.seq) FROM chapters c WHERE c.project_id = s.project_id AND c.title = s.chapter), 999999) ASC, s.idx ASC')
    rows = conn.execute(sql, (pid,)).fetchall()
    out = []
    for r in rows:
        if chapter and r[1] != chapter:
            continue
        ab = _project_file(pid, r[6])
        if not ab:
            continue
        out.append({'idx': r[0], 'chapter': r[1], 'dialogue': r[2] or '', 'narration': r[3] or '',
                    'prompt': r[4] or r[5] or '', 'path': ab, 'db_duration': float(r[7] or 0)})
    return out


def _candidates(conn, pid_arg, chapter_arg):
    if pid_arg:
        yield pid_arg, chapter_arg or ''
        return
    rows = conn.execute("SELECT project_id, type, checkpoint FROM jobs WHERE status = 'running' "
                        "ORDER BY (type = 'export') DESC, started_at DESC LIMIT 20").fetchall()
    seen = set()
    for pid, typ, cp in rows:
        try:
            cpj = json.loads(cp or '{}')
        except Exception:
            cpj = {}
        chs = []
        if typ == 'export':
            chs.append(cpj.get('subject') or '')
        else:
            for k in ('chapter', 'subject'):
                if cpj.get(k):
                    chs.append(cpj.get(k))
        for ch in chs:
            # 章节可能以 id 传入：换成标题
            r = conn.execute('SELECT title FROM chapters WHERE project_id = ? AND (title = ? OR id = ?)', (pid, ch, ch)).fetchone()
            if ch and r:
                ch = r[0]
            key = (pid, ch)
            if key in seen:
                continue
            seen.add(key)
            yield pid, ch


# ---------------- 时长测量 ----------------

def _ffprobe_bin():
    b = shutil.which('ffprobe')
    if b:
        return b
    f = shutil.which('ffmpeg')
    if f:
        c = os.path.join(os.path.dirname(f), 'ffprobe' + ('.exe' if os.name == 'nt' else ''))
        if os.path.exists(c):
            return c
    # Windows：winget 装的 FFmpeg 只写进用户 PATH，子进程环境里不一定有
    la = os.environ.get('LOCALAPPDATA')
    if os.name == 'nt' and la:
        import glob
        hits = sorted(glob.glob(os.path.join(la, 'Microsoft', 'WinGet', 'Packages', '*FFmpeg*', '*', 'bin', 'ffprobe.exe')))
        if hits:
            return hits[-1]
    return None


def _audio_duration(path, probe):
    if not probe:
        return None
    try:
        r = subprocess.run([probe, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration',
                            '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True, timeout=30)
        v = float((r.stdout or '').strip().splitlines()[0])
        return v if v > 0 else None
    except Exception:
        return None


def load_script(wav_total, project_id='', chapter=''):
    """返回 (shots, info)。shots 带 start/end（成片时间轴）。找不到可信剧本时抛异常。"""
    conn = _connect_ro()
    try:
        probe = _ffprobe_bin()
        tried = []
        for pid, ch in _candidates(conn, project_id, chapter):
            shots = _narrative_shots(conn, pid, ch)
            if not shots:
                tried.append((pid, ch, 'no shots'))
                continue
            t = 0.0
            ok = True
            for s in shots:
                d = _audio_duration(s['path'], probe)
                if d is None:
                    d = s['db_duration']
                    ok = ok and d > 0
                s['start'] = t
                s['end'] = t + d
                t += d
            tried.append((pid, ch, round(t, 2)))
            if ok and (not wav_total or abs(t - wav_total) <= max(DUR_TOL, wav_total * 0.004)):
                return shots, {'project_id': pid, 'chapter': ch, 'shots': len(shots), 'total': t}
        raise RuntimeError('找不到与音轨时长一致的章节：wav=%.2f 候选=%s' % (wav_total, tried))
    finally:
        conn.close()


# ---------------- 文本处理 ----------------

_CN_DIG = '零一二三四五六七八九'


def _num_cn(s):
    """阿拉伯数字 → 中文读法（对齐用）。>4 位或 0 开头按逐位读。"""
    if len(s) > 1 and s[0] == '0' or len(s) > 8:
        return ''.join(_CN_DIG[int(c)] for c in s)
    n = int(s)
    if n == 0:
        return '零'

    def four(x):
        units = ['', '十', '百', '千']
        out = ''
        zero = False
        for i in range(3, -1, -1):
            d = (x // (10 ** i)) % 10
            if d == 0:
                if out:
                    zero = True
                continue
            if zero:
                out += '零'
                zero = False
            out += _CN_DIG[d] + units[i]
        return out

    if n < 10000:
        r = four(n)
    else:
        hi, lo = divmod(n, 10000)
        r = four(hi) + '万' + (('零' if lo < 1000 else '') + four(lo) if lo else '')
    if r.startswith('一十'):
        r = r[1:]
    return r


def norm_chars(text):
    """剧本文本 → [(对齐用字符, 原文下标)]，去标点空白，数字转中文读法。"""
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isdigit() and ch.isascii():
            j = i
            while j < len(text) and text[j].isdigit() and text[j].isascii():
                j += 1
            for c in _num_cn(text[i:j]):
                out.append((c, i))
            i = j
            continue
        if ch not in PUNCT and not ch.isspace():
            out.append((ch.lower(), i))
        i += 1
    return out


def _plain_len(s):
    return len(norm_chars(s))


_SPEAKER_PREFIX = re.compile(r'^[^：:]{1,32}[：:]\s*')


def _strip_speaker_prefix(line):
    """去掉行首「不超过 32 字的说话人 + 冒号」，如 江澈：、江澈（OS）：、系统：。不改动句内冒号。"""
    return _SPEAKER_PREFIX.sub('', (line or '').strip()).strip()


def shot_lines(shot):
    """镜头字幕文本只取 ic.db shots.dialogue（去说话人前缀）。不从 <d>、narration 或其他字段取。"""
    lines = []
    for l in str(shot.get('dialogue') or '').splitlines():
        l = _strip_speaker_prefix(l)
        if l:
            lines.append(l)
    return lines


def _split_sentences(line):
    parts = []
    buf = ''
    i = 0
    while i < len(line):
        buf += line[i]
        if line[i] in SENT_END:
            j = i + 1
            while j < len(line) and (line[j] in SENT_END or line[j] in '”"’」）)'):
                buf += line[j]
                j += 1
            parts.append(buf)
            buf = ''
            i = j
            continue
        i += 1
    if buf.strip():
        parts.append(buf)
    return [p.strip() for p in parts if p.strip()]


def _split_clauses(sent):
    parts = []
    buf = ''
    for ch in sent:
        buf += ch
        if ch in CLAUSE_END:
            parts.append(buf)
            buf = ''
    if buf:
        if parts and not norm_chars(buf):
            parts[-1] += buf
        else:
            parts.append(buf)
    # 「——」这类连续符号并到前一段
    merged = []
    for p in parts:
        if merged and not norm_chars(p):
            merged[-1] += p
        else:
            merged.append(p)
    return merged


def _hard_split(piece):
    n = _plain_len(piece)
    k = (n + MAX_CUE_CHARS - 1) // MAX_CUE_CHARS
    target = (n + k - 1) // k
    out = []
    buf = ''
    cnt = 0
    for ch in piece:
        buf += ch
        if norm_chars(ch):
            cnt += 1
        if cnt >= target:
            out.append(buf)
            buf = ''
            cnt = 0
    if buf:
        if out and not norm_chars(buf):
            out[-1] += buf
        else:
            out.append(buf)
    return out


def split_cues(line):
    cues = []
    for sent in _split_sentences(line):
        if _plain_len(sent) <= MAX_CUE_CHARS:
            cues.append(sent)
            continue
        cur = ''
        for cl in _split_clauses(sent):
            if _plain_len(cl) > MAX_CUE_CHARS:
                if cur:
                    cues.append(cur)
                    cur = ''
                cues.extend(_hard_split(cl))
                continue
            if cur and _plain_len(cur) + _plain_len(cl) > MAX_CUE_CHARS:
                cues.append(cur)
                cur = cl
            else:
                cur += cl
        if cur:
            cues.append(cur)
    return [c.strip() for c in cues if norm_chars(c)]


def display_text(cue):
    t = cue.strip()
    while t and t[-1] in TRAIL_STRIP:
        t = t[:-1]
    return t.strip()


# ---------------- 识别结果 → 逐字时间 ----------------

_T2S = str.maketrans('階這說們個為們來時間後會對過還沒無話裡麼樣點邊錢塊與萬東車貸條電話聽見當開關係統錯讓給頭現發實體應寶歡謝',
                     '阶这说们个为们来时间后会对过还没无话里么样点边钱块与万东车贷条电话听见当开关系统错让给头现发实体应宝欢谢')


def asr_chars(segments_words, offset=0.0):
    """whisper words → [(字, start, end)]：一个 word 有多个字时均分时间。"""
    out = []
    for w in segments_words:
        txt = str(w.get('word', '')).translate(_T2S)
        try:
            s = float(w['start']) + offset
            e = float(w['end']) + offset
        except Exception:
            continue
        chars = []
        i = 0
        while i < len(txt):
            ch = txt[i]
            if ch.isdigit() and ch.isascii():
                j = i
                while j < len(txt) and txt[j].isdigit() and txt[j].isascii():
                    j += 1
                chars.extend(_num_cn(txt[i:j]))
                i = j
                continue
            if ch not in PUNCT and not ch.isspace():
                chars.append(ch.lower())
            i += 1
        if not chars:
            continue
        if e < s:
            e = s
        step = (e - s) / len(chars)
        for k, ch in enumerate(chars):
            out.append((ch, s + k * step, s + (k + 1) * step))
    return out


def words_of(result):
    ws = []
    for seg in (result.get('segments') or []):
        for w in seg.get('words') or []:
            ws.append(w)
    return ws


# ---------------- 能量发声检测 ----------------

class Energy:
    """人声频段（250–4000Hz）能量包络，10ms 一帧；按镜头分别取阈值，得到发声区间。"""

    def __init__(self, samples, rate, shots):
        import numpy as np
        self.np = np
        win = int(rate * 0.025)
        hop = int(rate * 0.01)
        n = max(0, (len(samples) - win) // hop)
        dbs = []
        f = np.fft.rfftfreq(win, 1.0 / rate)
        band = (f >= 250) & (f <= 4000)
        hann = np.hanning(win).astype('float32')
        step = 4000
        for i0 in range(0, n, step):
            i1 = min(n, i0 + step)
            idx = (np.arange(i0, i1) * hop)[:, None] + np.arange(win)[None, :]
            fr = samples[idx] * hann
            sp = np.abs(np.fft.rfft(fr, axis=1)) ** 2
            dbs.append(10 * np.log10(sp[:, band].sum(axis=1) + 1e-10))
        db = np.concatenate(dbs) if dbs else np.zeros(0)
        if len(db) > 3:
            db = np.convolve(db, np.ones(3) / 3, mode='same')
        self.db = db
        self.regions = []
        for sh in shots:
            self.regions.extend(self.voiced(sh['start'], sh['end']))
        self.regions.sort()

    def voiced(self, t0, t1):
        np = self.np
        a = max(0, int(t0 * 100))
        b = min(len(self.db), int(t1 * 100))
        if b - a < 10:
            return []
        seg = self.db[a:b]
        thr = max(np.percentile(seg, 15) + 10, seg.max() - 35)
        on = seg > thr
        out = []
        i = 0
        while i < len(on):
            if on[i]:
                j = i
                while j < len(on) and on[j]:
                    j += 1
                out.append([(a + i) / 100.0, (a + j) / 100.0])
                i = j
            else:
                i += 1
        merged = []
        for s, e in out:
            if merged and s - merged[-1][1] < 0.12:
                merged[-1][1] = e
            else:
                merged.append([s, e])
        return [(s, e) for s, e in merged if e - s >= 0.1]

    def refine(self, hit, lo, hi):
        """用首/末匹配字落在哪个发声区间来定字幕起止。

        whisper 的逐字时间里，句首字的起点常被拉到前面的静音里、句末字的终点常拖进后面的静音，
        但「首字的终点」「末字的起点」基本可信 → 用它们找所在（或紧邻）的发声区间，取区间起点/终点。
        hit = (k0, s0, e0, k1, s1, e1, n)：首末匹配字在句内的位置与时间，n 为句子字数。
        """
        k0, s0, e0, k1, s1, e1, n = hit
        R = self.regions
        # ---- 起点：离首个匹配字起点最近的发声起点（whisper 句首常偏早，故向后多看一点）
        start = None
        for r0, _ in R:
            if r0 < s0 - 0.5 or r0 > s0 + 0.8 or r0 < lo - 0.03 or r0 >= e1:
                continue
            if start is None or abs(r0 - s0) < abs(start - s0):
                start = r0
        if start is None:
            start = s0
        if k0 > 0:                       # 句首有没识别出的字（常见：呵呵、语气词）→ 允许再往前找
            win = min(1.5, k0 * 0.5 + 0.3)
            earlier = [r[0] for r in R if start - win <= r[0] < start - 0.05 and r[1] <= start + 0.05]
            if earlier:
                start = min(earlier)
            else:
                start = start - k0 * 0.15
        start = max(start, lo)
        # ---- 终点：末个匹配字的起点所在发声区间的终点（whisper 句末字的终点常拖进静音）
        end = None
        for r0, r1 in R:
            if r0 <= s1 + 0.03 and r1 >= s1 - 0.03:
                if r1 <= e1 + 0.5:
                    end = r1
                break
        if end is None:
            for _, r1 in R:
                if r1 < e1 - 0.5 or r1 > e1 + 0.5 or r1 <= start:
                    continue
                if end is None or abs(r1 - e1) < abs(end - e1):
                    end = r1
        if end is None:
            end = e1
        tail = n - 1 - k1
        if tail > 0:
            win = tail * 0.3 + 0.3
            later = [r[1] for r in R if end + 0.05 < r[1] <= end + win and r[0] >= end - 0.05]
            end = max(later) if later else end + tail * 0.15
        end = min(end, hi)
        if end - start < 0.2:
            return None
        return start, end


# ---------------- 对齐主体 ----------------

def _dialogue_lines(shot):
    """只取 dialogue（去说话人前缀）。narration 不再作为字幕来源。"""
    return list(shot_lines(shot))


def _has_d(shot):
    return bool(re.search(r'<d>(.*?)</d>', shot.get('prompt') or '', re.S))


def _display_map(shot, spoken_sents):
    """过审约定：<d> 写实际配音、dialogue 写屏幕显示的字。

    两边按句（。！？）切开后句数相同才一一对应；某句去标点后文字不同 → 该句显示 dialogue。
    返回与 spoken_sents 等长的列表：None 表示维持配音文本，否则为该句的显示文本。
    句数对不上、没有 <d>、或文字只差标点时全部维持现状。
    """
    keep = [None] * len(spoken_sents)
    if not _has_d(shot):
        return keep
    shown = []
    for l in _dialogue_lines(shot):
        shown.extend(_split_sentences(l))
    if len(shown) != len(spoken_sents):
        return keep
    out = []
    for sp, sh in zip(spoken_sents, shown):
        a = ''.join(c for c, _ in norm_chars(sp))
        b = ''.join(c for c, _ in norm_chars(sh))
        out.append(None if a == b or not b else sh)
    return out


def _missing_dialogue_shots(shots):
    """有 <d> 或 narration、却取不到 dialogue 的镜头号（不得回退到其他来源）。"""
    missing = []
    for s in shots:
        raw = str(s.get('dialogue') or '').strip()
        has_other = _has_d(s) or bool(str(s.get('narration') or '').strip())
        if has_other and not raw:
            missing.append(s.get('idx'))
    return missing


def _build_units(shots):
    missing = _missing_dialogue_shots(shots)
    if missing:
        raise RuntimeError('下列镜头没有 dialogue，已拒绝回退 <d>/narration/ASR：#' + ', #'.join(str(x) for x in missing))
    cues = []
    for si, s in enumerate(shots):
        sents = []
        for line in shot_lines(s):
            sents.extend(_split_sentences(line))
        for sent in sents:
            for c in split_cues(sent):
                cues.append({'shot': si, 'raw': c, 'text': display_text(c),
                             'chars': [ch for ch, _ in norm_chars(c)],
                             'shown_from_dialogue': True})
    if not cues:
        raise RuntimeError('本章没有可烧录的 dialogue 文本，已拒绝回退 ASR 或其他来源')
    return cues


def _match(cues, cue_ids, achars, shots, guard=SHOT_GUARD):
    """把 cue_ids 这些单元的剧本字与 achars 对齐，返回 {cue_id: [(pos_in_cue, start, end)]}。"""
    S = []
    owner = []
    for cid in cue_ids:
        for k, ch in enumerate(cues[cid]['chars']):
            S.append(ch)
            owner.append((cid, k))
    A = [c for c, _, _ in achars]
    sm = difflib.SequenceMatcher(None, S, A, autojunk=False)
    hits = {}
    for blk in sm.get_matching_blocks():
        for t in range(blk.size):
            cid, k = owner[blk.a + t]
            _, s, e = achars[blk.b + t]
            sh = shots[cues[cid]['shot']]
            if s < sh['start'] - guard or e > sh['end'] + guard:
                continue
            hits.setdefault(cid, []).append((k, s, e))
    return hits


def _ok(cue, h):
    n = len(cue['chars'])
    if not h:
        return False
    need = 1 if n <= 2 else max(2, int(round(n * 0.35)))
    return len(h) >= need


def _hit_info(cue, h):
    h = sorted(h)
    return (h[0][0], h[0][1], h[0][2], h[-1][0], h[-1][1], h[-1][2], len(cue['chars']))


def _time_from_hits(cue, h, sh):
    n = len(cue['chars'])
    h = sorted(h)
    k0, s0, _ = h[0]
    k1, _, e1 = h[-1]
    start = s0 - k0 * CHAR_SEC
    end = e1 + (n - 1 - k1) * CHAR_SEC
    return max(start, sh['start']), min(end, sh['end'])


def align_to_script(model, wav_path, result, transcribe_kwargs, project_id='', chapter='', emit=None):
    import numpy as np

    with wave.open(wav_path, 'rb') as w:
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
        width = w.getsampwidth()
        chn = w.getnchannels()
    if width != 2:
        raise RuntimeError('只支持 16bit WAV')
    samples = np.frombuffer(raw, dtype='<i2').astype('float32') / 32768.0
    if chn > 1:
        samples = samples.reshape(-1, chn).mean(axis=1)
    total = len(samples) / float(rate)

    shots, info = load_script(total, project_id, chapter)
    cues = _build_units(shots)
    if not cues:
        raise RuntimeError('剧本台词为空')
    log('章节', info, '字幕单元', len(cues))

    achars = asr_chars(words_of(result))
    hits = _match(cues, list(range(len(cues))), achars, shots)
    timing = {}
    src = {}
    hinfo = {}
    for cid, c in enumerate(cues):
        if _ok(c, hits.get(cid)):
            timing[cid] = _time_from_hits(c, hits[cid], shots[c['shot']])
            hinfo[cid] = _hit_info(c, hits[cid])
            src[cid] = 'asr'

    # 二次识别：镜头里有对不齐的句子 → 在镜头窗口内带剧本提示重识别
    bad_shots = sorted({c['shot'] for cid, c in enumerate(cues) if cid not in timing})
    for si in bad_shots:
        sh = shots[si]
        ids = [cid for cid, c in enumerate(cues) if c['shot'] == si]
        t0 = max(0.0, sh['start'] - 0.15)
        t1 = min(total, sh['end'] + 0.15)
        clip = samples[int(t0 * rate): int(t1 * rate)]
        if len(clip) < rate * 0.3:
            continue
        prompt = ''.join(cues[cid]['raw'] for cid in ids)
        try:
            kw = dict(transcribe_kwargs)
            kw.pop('verbose', None)
            r2 = model.transcribe(clip.astype('float32'), word_timestamps=True, initial_prompt=prompt,
                                  condition_on_previous_text=False, verbose=None, **kw)
            if not isinstance(r2, dict):
                segs = list(r2)
                r2 = {'segments': segs}
        except Exception as e:  # noqa: BLE001
            log('二次识别失败', si, e)
            continue
        a2 = asr_chars(words_of(r2), offset=t0)
        h2 = _match(cues, ids, a2, shots, guard=0.2)
        for cid in ids:
            if cid not in timing and _ok(cues[cid], h2.get(cid)):
                timing[cid] = _time_from_hits(cues[cid], h2[cid], sh)
                hinfo[cid] = _hit_info(cues[cid], h2[cid])
                src[cid] = 'asr2'
        if emit:
            emit({'type': 'progress', 'at': sh['end'], 'total': total})

    # 仍未对齐：退回镜头窗口内的能量发声区间
    energy = Energy(samples, rate, shots)
    for si in sorted({c['shot'] for cid, c in enumerate(cues) if cid not in timing}):
        sh = shots[si]
        ids = [cid for cid, c in enumerate(cues) if c['shot'] == si]
        i = 0
        while i < len(ids):
            if ids[i] in timing:
                i += 1
                continue
            j = i
            while j < len(ids) and ids[j] not in timing:
                j += 1
            run = ids[i:j]
            g0 = timing[ids[i - 1]][1] if i > 0 else sh['start']
            g1 = timing[ids[j]][0] if j < len(ids) else sh['end']
            vs = energy.voiced(g0, g1)
            if vs:
                v0, v1 = vs[0][0], vs[-1][1]
            else:
                v0, v1 = g0, g1
            need = sum(len(cues[c]['chars']) for c in run) * CHAR_SEC
            if not vs and need < v1 - v0:
                v1 = v0 + need
            lens = [max(1, len(cues[c]['chars'])) for c in run]
            tot = float(sum(lens))
            t = v0
            for c, L in zip(run, lens):
                d = (v1 - v0) * L / tot
                timing[c] = (t, t + d)
                src[c] = 'vad' if vs else 'est'
                t += d
            i = j

    # 钩到真实发声：首字/末字所在的发声区间决定起止（只对靠声音对上的句子做）
    order = sorted(timing.keys(), key=lambda c: (timing[c][0], c))
    for n, cid in enumerate(order):
        if cid not in hinfo:
            continue
        sh = shots[cues[cid]['shot']]
        prev_end = timing[order[n - 1]][1] if n > 0 else 0.0
        r = energy.refine(hinfo[cid], max(sh['start'], prev_end), sh['end'])
        if r:
            timing[cid] = r

    # 收尾：按时间排序、限长、去重叠、截掉超出片长的
    out = []
    order = sorted(timing.keys(), key=lambda c: (timing[c][0], c))
    for n, cid in enumerate(order):
        s, e = timing[cid]
        e = e + END_PAD
        if s >= total - 0.05:
            continue
        e = min(e, total)
        out.append([s, e, cues[cid]['text'], src[cid] + ('+dialogue' if cues[cid].get('shown_from_dialogue') else ''), cues[cid]['shot']])
    for n in range(len(out)):
        if n + 1 < len(out):
            nxt = out[n + 1][0]
            if out[n][1] > nxt:
                out[n][1] = nxt
            if out[n][1] - out[n][0] < MIN_CUE_SEC:
                out[n][1] = min(out[n][0] + MIN_CUE_SEC, nxt)
        else:
            if out[n][1] - out[n][0] < MIN_CUE_SEC:
                out[n][1] = min(out[n][0] + MIN_CUE_SEC, total)
    segs = [{'start': round(s, 3), 'end': round(e, 3), 'text': t} for s, e, t, _, _ in out if e > s and t]

    stat = {}
    for v in src.values():
        stat[v] = stat.get(v, 0) + 1
    log('对齐完成', stat)
    report = {'info': info, 'stat': stat, 'cues': [
        {'start': round(s, 3), 'end': round(e, 3), 'text': t, 'src': sr, 'shot_idx': shots[si]['idx']} for s, e, t, sr, si in out]}
    try:
        p = os.path.join(_data_dir(), 'subtitle', 'last_align.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    except Exception:
        pass
    # 安全阀：大部分句子都没能靠声音对上时，不冒险，交给调用方回退
    asr_n = stat.get('asr', 0) + stat.get('asr2', 0)
    if asr_n < len(cues) * 0.5:
        raise RuntimeError('对齐率过低 %d/%d' % (asr_n, len(cues)))
    return segs, report
