"""H10b：non_diegetic_music 不是 N/A → WARN（2026-11-18，镜内不生成配乐）。仅用标准库。"""
from pathlib import Path
import ast
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_prompt as validator

BASE = ("integrated_multimodal_description: A man stands in the rain.\n"
        "overall_soundscape: Rain taps on the window.\n"
        "non_diegetic_music: {}\n")


def h10b(text):
    issues, warns, _ = validator.validate_h3(text)
    return [w for w in warns if w.startswith("H10b")], issues


class NdmWarnTests(unittest.TestCase):
    def test_na_passes(self):
        for v in ("N/A", "n/a", "N/A.", "None", "NONE.", "silence", "Silence.", "没有配乐", "没有配乐。"):
            w, _ = h10b(BASE.format(v))
            self.assertEqual(w, [], v)

    def test_only_four_values(self):
        for v in ("无", "无配乐", "No music.", "na", "-"):
            w, _ = h10b(BASE.format(v))
            self.assertEqual(len(w), 1, v)

    def test_blank_section_is_ndm_missing(self):
        for v in ("", ".", "。", "   "):
            w, _ = h10b(BASE.format(v))
            self.assertEqual(len(w), 1, repr(v))
            self.assertIn("ndm_missing", w[0], repr(v))
        txt = "Sound: rain on the window. Background music: ."
        w = [x for x in validator.validate_h3(txt)[1] if x.startswith("H10b")]
        self.assertEqual(len(w), 1)
        self.assertIn("ndm_missing", w[0])

    def test_values_match_js(self):
        js = (Path(__file__).resolve().parents[3] / "lib" / "core" / "music-check.js").read_text(encoding="utf-8")
        m = re.search(r"^export const EMPTY_MUSIC_VALUES = (\[[^\]]*\]);", js, re.M)
        self.assertIsNotNone(m, "music-check.js 里找不到 EMPTY_MUSIC_VALUES")
        self.assertEqual(ast.literal_eval(m.group(1)), validator.H10B_EMPTY_MUSIC_VALUES)
        self.assertEqual(validator.H10B_EMPTY_MUSIC_VALUES, ["silence", "没有配乐", "N/A", "none"])

    def test_free_text_background_music_warns(self):
        txt = "Sound: rain on the window. Background music: a low cello line under the line."
        w = [x for x in validator.validate_h3(txt)[1] if x.startswith("H10b")]
        self.assertEqual(len(w), 1)
        ok = "Sound: rain on the window. Background music: none."
        self.assertEqual([x for x in validator.validate_h3(ok)[1] if x.startswith("H10b")], [])

    def test_music_warns_not_blocks(self):
        w, issues = h10b(BASE.format("Sparse piano notes at a slow tempo."))
        self.assertEqual(len(w), 1)
        self.assertFalse(any(i.startswith("H10b") for i in issues), "只告警不报错")


if __name__ == "__main__":
    unittest.main()
