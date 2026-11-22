"""画外音声源/index.json 检查（WARN · 2026-11-18）。仅用标准库。"""
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_vo_sources as cvs


def make(clips, files=("ch30/s05_os_江澈.wav", "ch30/s07_phone_苏晴.wav", "声线样本/江澈.wav", "声线样本/苏晴.wav")):
    d = tempfile.mkdtemp(prefix="vo_src_")
    for f in files:
        p = Path(d) / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"RIFF")
    (Path(d) / "index.json").write_text(json.dumps({"version": 1, "clips": clips}, ensure_ascii=False), encoding="utf-8")
    return d


GOOD = [
    {"clip": "ch30/s05_os_江澈.wav", "speaker": "江澈", "kind": "os", "chapter": 30, "shot": "s05",
     "window": {"start": 3.0, "end": 6.0}, "line": "这菜单也太贵了。", "voice_sample": "声线样本/江澈.wav"},
    {"clip": "ch30/s07_phone_苏晴.wav", "speaker": "苏晴", "kind": "phone", "chapter": 30, "shot": "s07",
     "window": {"start": 1.0, "end": 4.5}, "line": "你到哪了？", "voice_sample": "声线样本/苏晴.wav"},
]


class VoSourceIndexTests(unittest.TestCase):
    def test_good_index_passes(self):
        self.assertEqual(cvs.check_index(make(GOOD)), [])

    def test_missing_index(self):
        d = tempfile.mkdtemp(prefix="vo_src_")
        self.assertTrue(cvs.check_index(d)[0].startswith("V0"))

    def test_bad_window_and_missing_sample(self):
        bad = [dict(GOOD[0], window={"start": 5, "end": 5}, voice_sample="")]
        w = cvs.check_index(make(bad))
        self.assertTrue(any(x.startswith("V2") for x in w), w)
        self.assertTrue(any(x.startswith("V3") for x in w), w)

    def test_one_clip_per_person(self):
        bad = [dict(GOOD[0], speaker="江澈、苏晴")]
        self.assertTrue(any(x.startswith("V4") for x in cvs.check_index(make(bad))))
        bad2 = [GOOD[0], dict(GOOD[1], clip=GOOD[0]["clip"])]
        self.assertTrue(any(x.startswith("V4") for x in cvs.check_index(make(bad2))))

    def test_overlap_and_two_samples(self):
        second = dict(GOOD[0], window={"start": 5.0, "end": 7.0}, voice_sample="声线样本/苏晴.wav")
        w = cvs.check_index(make([GOOD[0], second]))
        self.assertTrue(any(x.startswith("V5") for x in w), w)
        self.assertTrue(any(x.startswith("V7") for x in w), w)

    def test_missing_clip_file_and_strict_exit(self):
        bad = [dict(GOOD[0], clip="ch30/missing.wav")]
        d = make(bad)
        self.assertTrue(any(x.startswith("V1") for x in cvs.check_index(d)))
        self.assertEqual(cvs.main([d]), 0, "默认只告警")
        self.assertEqual(cvs.main([d, "--strict"]), 1)


if __name__ == "__main__":
    unittest.main()
