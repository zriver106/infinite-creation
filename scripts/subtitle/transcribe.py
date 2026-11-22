#!/usr/bin/env python3
"""Whisper 语音识别（方案照搬 audio2srt）+ 剧本对齐。

stdout 只输出 JSON Lines，Node 侧逐行解析：
    {"type":"stage","stage":"load"|"transcribe"}
    {"type":"progress","at":12.3,"total":180.0}
    {"type":"done","segments":[{"start":0.0,"end":1.2,"text":"..."}]}
    {"type":"error","message":"..."}

tqdm 进度条与 torch 告警都走 stderr，不影响 stdout 协议。

剧本对齐（script_align.py）：打开逐字时间戳，从 ic.db 只读取出本章剧本台词，
字以剧本为准、时间以声音为准；对齐任何环节失败都退回原始 whisper 分段，不影响导出。
设环境变量 IC_SUBTITLE_ALIGN=0 可关闭对齐，恢复原行为。
"""

import argparse
import json
import sys
import wave


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def wav_duration(path):
    """本项目传入的 WAV 恒为 16k/mono/pcm_s16le；读不到就返回 0（进度条退化为百分比未知）。"""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate() or 16000
            return w.getnframes() / float(rate)
    except Exception:
        return 0.0


def main():
    import os

    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="16kHz mono WAV")
    ap.add_argument("--model", required=True, help="本地 .pt 模型绝对路径")
    ap.add_argument("--language", default="auto", help="auto 或 whisper 语言代码")
    ap.add_argument("--device", default="", help="cpu / cuda；留空由 whisper 自选")
    ap.add_argument("--project-id", default="", help="剧本对齐用：项目 id（留空自动从运行中的导出任务识别）")
    ap.add_argument("--chapter", default="", help="剧本对齐用：章节标题")
    args = ap.parse_args()

    # macOS Finder / Windows 控制台可能不是 UTF-8，中文输出会直接崩
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    align_on = os.environ.get("IC_SUBTITLE_ALIGN", "1") != "0"

    total = wav_duration(args.audio)
    emit({"type": "stage", "stage": "load"})

    import whisper  # 延迟导入：torch 初始化要几秒，先让调用方收到 stage

    model_kwargs = {}
    if args.device in ("cpu", "cuda"):
        model_kwargs["device"] = args.device
    model = whisper.load_model(args.model, **model_kwargs)

    emit({"type": "stage", "stage": "transcribe"})
    transcribe_kwargs = {"verbose": None}
    if args.language and args.language != "auto":
        transcribe_kwargs["language"] = args.language

    segments = []
    raw_segments = []

    def push(seg):
        raw_segments.append(seg)
        start = float(seg["start"])
        end = float(seg["end"])
        text = str(seg.get("text", "")).strip()
        if not text or end <= start:
            return
        segments.append({"start": start, "end": end, "text": text})
        emit({"type": "progress", "at": end, "total": total or end})

    run_kwargs = dict(transcribe_kwargs)
    if align_on:
        run_kwargs["word_timestamps"] = True
    try:
        result = model.transcribe(args.audio, **run_kwargs)
    except Exception as e:  # noqa: BLE001
        if not align_on:
            raise
        sys.stderr.write("[align] 逐字时间戳识别失败，按原方式重跑：%s\n" % e)
        align_on = False
        result = model.transcribe(args.audio, **transcribe_kwargs)
    # verbose=None 时 whisper 返回生成器（可边解码边报进度），部分版本仍返回 dict。
    if isinstance(result, dict):
        for seg in result.get("segments") or []:
            push(seg)
    else:
        for seg in result:
            push(seg)

    if align_on:
        try:
            import script_align

            aligned, _ = script_align.align_to_script(
                model, args.audio, {"segments": raw_segments}, transcribe_kwargs,
                project_id=args.project_id, chapter=args.chapter, emit=emit,
            )
            if aligned:
                segments = aligned
        except Exception as e:  # noqa: BLE001 —— 对齐失败一律回退原始识别结果
            sys.stderr.write("[align] 剧本对齐失败，回退原始识别：%s\n" % e)

    emit({"type": "done", "segments": segments})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": str(e)})
        sys.exit(1)
