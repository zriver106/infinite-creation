"""画外音声源索引检查（WARN · 2026-11-18）：<project>/画外音声源/index.json。

规则（h3-prompt-writing「Inner voice, hand props and glasses」第 4–6 条）：混合镜心声和电话那头的声音不进生成段，
后期按说话人本人的声线样本出声源片，一人一条，存项目 画外音声源/ 并在 index.json 登记时间窗。
默认只告警、退出码 0；--strict 有告警时退出码 1。仅用标准库。

index.json：{"version": 1, "clips": [{"clip": "ch30/s05_os_江澈.wav", "speaker": "江澈", "kind": "os",
  "chapter": 30, "shot": "s05", "window": {"start": 3.0, "end": 6.0}, "line": "原句", "voice_sample": "声线样本/江澈.wav"}]}
clip、voice_sample 为相对 画外音声源/ 的路径（也可写绝对路径）。
"""
import argparse
import json
import os
import re
import sys

KINDS = ("os", "phone", "narration", "system")
MULTI_SPEAKER_RE = re.compile(r"[、,，/&＆+＋]|\band\b|和|与")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_index(folder):
    """返回告警列表（字符串，V1–V8 开头）。"""
    out = []
    idx = os.path.join(folder, "index.json")
    if not os.path.isfile(idx):
        return ["V0 缺 index.json：画外音声源/ 下每条声源片都要在 index.json 登记（clip、speaker、kind、chapter、shot、window、line、voice_sample）"]
    try:
        with open(idx, "rb") as f:
            data = json.loads(f.read().decode("utf-8-sig"))
    except (OSError, ValueError) as e:
        return [f"V0 index.json 读不了：{e}"]
    clips = data.get("clips") if isinstance(data, dict) else None
    if not isinstance(clips, list):
        return ["V0 index.json 缺 clips 列表"]

    def _path(p):
        return p if os.path.isabs(p) else os.path.join(folder, p)

    by_clip = {}
    by_shot = {}
    sample_of = {}
    for i, c in enumerate(clips):
        tag = f"#{i + 1}"
        if not isinstance(c, dict):
            out.append(f"V0 {tag} 不是对象")
            continue
        clip = str(c.get("clip") or "").strip()
        spk = str(c.get("speaker") or "").strip()
        tag = f"#{i + 1} {clip or '(无 clip)'}"
        if not clip:
            out.append(f"V1 {tag} 缺 clip 路径")
        elif not os.path.isfile(_path(clip)):
            out.append(f"V1 {tag} 声源片文件不存在")
        if not spk:
            out.append(f"V3 {tag} 缺 speaker")
        elif MULTI_SPEAKER_RE.search(spk):
            out.append(f"V4 {tag} speaker「{spk}」像是多人——一条声源片只放一个人")
        kind = str(c.get("kind") or "").strip()
        if kind not in KINDS:
            out.append(f"V6 {tag} kind「{kind}」不在 {'/'.join(KINDS)} 里")
        w = c.get("window") if isinstance(c.get("window"), dict) else {}
        s, e = w.get("start"), w.get("end")
        if not (_num(s) and _num(e)) or s < 0 or e <= s:
            out.append(f"V2 {tag} 时间窗无效（window.start/end 秒数，end > start ≥ 0）：{c.get('window')!r}")
            s = e = None
        vs = str(c.get("voice_sample") or "").strip()
        if not vs:
            out.append(f"V3 {tag} 缺 voice_sample——声源片要用说话人本人的声线样本（与其出口台词同一份），音色才对得上")
        elif not os.path.isfile(_path(vs)):
            out.append(f"V3 {tag} voice_sample 文件不存在：{vs}")
        if spk and vs:
            prev = sample_of.setdefault(spk, vs)
            if os.path.normcase(os.path.normpath(prev)) != os.path.normcase(os.path.normpath(vs)):
                out.append(f"V7 {tag} {spk} 用了两份不同的声线样本（{prev} / {vs}）——同一人只用一份，音色才一致")
        if clip:
            if clip in by_clip and by_clip[clip] != spk:
                out.append(f"V4 {tag} 同一个声源片登记给了两个人（{by_clip[clip]} / {spk}）——一人一条")
            by_clip.setdefault(clip, spk)
        if s is not None and spk:
            key = (str(c.get("chapter")), str(c.get("shot")), spk)
            for (s2, e2, t2) in by_shot.get(key, []):
                if s < e2 and s2 < e:
                    out.append(f"V5 {tag} 与 {t2} 同一镜同一人时间窗重叠（{s}-{e} / {s2}-{e2}）")
            by_shot.setdefault(key, []).append((s, e, tag))
        if not str(c.get("line") or "").strip():
            out.append(f"V8 {tag} 缺 line（原句）")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="画外音声源/index.json 检查（默认只告警）")
    ap.add_argument("folder", help="项目的 画外音声源 目录")
    ap.add_argument("--strict", action="store_true", help="有告警时退出码 1")
    a = ap.parse_args(argv)
    warns = check_index(a.folder)
    for w in warns:
        print("WARN", w)
    print(f"画外音声源检查：{len(warns)} 条告警")
    return 1 if (a.strict and warns) else 0


if __name__ == "__main__":
    sys.exit(main())
