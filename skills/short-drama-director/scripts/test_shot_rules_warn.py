"""H13（WARN · 2026-11-18 第30章）：全景场景图配中近景 / 心声不动嘴 / 手持道具位置 / 眼镜 / 混合镜心声与电话声走后期。仅用标准库。"""
from pathlib import Path
import os
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_prompt as validator

LOC = "The reference images are identity and location references only. "
GOOD_CLOSE = ("Medium shot, framed from the waist up; each face is about one quarter of the frame height. "
              "__MINIMAX_H3_REF_1__ is Jiang Che. __MINIMAX_H3_REF_2__ is the background behind Jiang Che: the green wall. "
              "Use __MINIMAX_H3_REF_2__ for the background only, partially. " + LOC +
              "0-4s: Jiang Che sits still and looks right, lips closed.")
BAD_CLOSE = ("__MINIMAX_H3_REF_1__ is Jiang Che. __MINIMAX_H3_REF_2__ is the dining room. " + LOC +
             "Layout from __MINIMAX_H3_REF_2__: round tables, green chairs, a gold relief, a chandelier, marble pillars, a bar counter on the right. "
             "0s: medium shot of Jiang Che at the table.")


def h13(text, env=None):
    old = os.environ.get("H3_SHOT_RULES")
    try:
        if env is None:
            os.environ.pop("H3_SHOT_RULES", None)
        else:
            os.environ["H3_SHOT_RULES"] = env
        issues, warns, _ = validator.validate_h3(text)
    finally:
        if old is None:
            os.environ.pop("H3_SHOT_RULES", None)
        else:
            os.environ["H3_SHOT_RULES"] = old
    return [w for w in warns if w.startswith("H13")], [i for i in issues if i.startswith("H13")]


class FramingTests(unittest.TestCase):
    def test_good_close_shot_passes(self):
        w, _ = h13(GOOD_CLOSE)
        self.assertEqual([x for x in w if x.startswith("H13a")], [])

    def test_bad_close_shot_warns_all_four(self):
        w, issues = h13(BAD_CLOSE)
        a = [x for x in w if x.startswith("H13a")]
        self.assertEqual(len(a), 4, a)  # 景别不在最前、没写死、保留度、布局清单过长
        self.assertEqual(issues, [], "默认只告警")

    def test_wide_shot_not_judged(self):
        w, _ = h13(BAD_CLOSE.replace("0s: medium shot", "0s: wide shot"))
        self.assertEqual([x for x in w if x.startswith("H13a")], [])

    def test_ref2va_sections(self):
        txt = ("subject_definitions: <Subject 1> is Jiang Che.\n"
               "summary: Medium close-up from the chest up; the face fills about one third of the frame height.\n"
               "retention_analysis: __MINIMAX_H3_REF_2__: partially_preserved - background only: the green wall behind him\n"
               "detailed_description: Medium close-up of <Subject 1>. The reference images are identity and location references only.\n"
               "overall_soundscape: room tone.\nnon_diegetic_music: N/A\n")
        w, _ = h13(txt)
        self.assertEqual([x for x in w if x.startswith("H13a")], [])
        w2, _ = h13(txt.replace("partially_preserved - background only:", "fully_preserved -"))
        self.assertEqual(len([x for x in w2 if x.startswith("H13a")]), 1)


class OsPropGlassesTests(unittest.TestCase):
    def test_os_needs_no_mouthing(self):
        base = "Jiang Che (S1) says in an off-screen voiceover: <d>[Chinese] 这是幻觉？</d> while his lips remain completely closed."
        self.assertTrue(any(x.startswith("H13b") for x in h13(base)[0]))
        ok = base + " His lips stay closed throughout the shot; he does not mouth the words."
        self.assertFalse(any(x.startswith("H13b") for x in h13(ok)[0]))

    def test_prop_position(self):
        bad = "0-3s: Xu Manning holds a paper cup of milk tea and listens."
        self.assertTrue(any(x.startswith("H13c") for x in h13(bad)[0]))
        ok = bad + " She holds the cup at chest level the whole time; it never goes to her mouth."
        self.assertFalse(any(x.startswith("H13c") for x in h13(ok)[0]))

    def test_glasses(self):
        self.assertTrue(any(x.startswith("H13d") for x in h13("Jiang Che wears thin black glasses and smiles.")[0]))
        self.assertFalse(any(x.startswith("H13d") for x in h13("Jiang Che, no glasses, smiles.")[0]))
        self.assertFalse(any(x.startswith("H13d") for x in h13("The classmates clink their wine glasses.")[0]))

    def test_modes(self):
        w, i = h13(BAD_CLOSE, env="block")
        self.assertEqual(w, [])
        self.assertTrue(i)
        w, i = h13(BAD_CLOSE, env="off")
        self.assertEqual((w, i), ([], []))


MIXED_BAD = ("0-3s: Medium close-up of Xu Manning. Xu Manning (S2) says: <d>[Chinese] 你点好了吗？</d> Then her mouth closes. "
             "3-6s: Jiang Che (S1) says in an off-screen voiceover: <d>[Chinese] 这菜单也太贵了。</d> while his lips remain completely closed; "
             "his lips stay closed throughout the shot; he does not mouth the words.")
MIXED_GOOD = ("0-3s: Medium close-up of Xu Manning. Xu Manning (S2) says: <d>[Chinese] 你点好了吗？</d> Then her mouth closes. "
              "3-6s: Jiang Che's eyes narrow and slide to the menu; he sets the cup down on the table, his lips resting closed.")
PURE_OS = ("An off-screen male inner-monologue voice (S1), tense, rapid, narrates <d>[Chinese] 这是幻觉？</d>. "
           "Nobody on screen is speaking; Jiang Che only listens to his own thoughts with his lips closed; "
           "his lips stay closed throughout the shot; he does not mouth the words.")


def all_warns(text, env=None):
    old = os.environ.get("H3_SHOT_RULES")
    try:
        if env is None:
            os.environ.pop("H3_SHOT_RULES", None)
        else:
            os.environ["H3_SHOT_RULES"] = env
        issues, warns, _ = validator.validate_h3(text)
    finally:
        if old is None:
            os.environ.pop("H3_SHOT_RULES", None)
        else:
            os.environ["H3_SHOT_RULES"] = old
    return warns, issues


class MixedOsPostTests(unittest.TestCase):
    def test_mixed_shot_with_os_voice_warns(self):
        w, i = h13(MIXED_BAD)
        self.assertTrue(any(x.startswith("H13e") for x in w), w)
        self.assertEqual(i, [], "默认只告警")

    def test_mixed_shot_os_in_post_passes(self):
        w, _ = h13(MIXED_GOOD)
        self.assertFalse(any(x.startswith("H13e") for x in w), w)

    def test_pure_os_shot_not_mixed(self):
        w, _ = h13(PURE_OS)
        self.assertFalse(any(x.startswith("H13e") for x in w), w)

    def test_os_voice_reference_line_counts(self):
        txt = ("__MINIMAX_H3_REF_3__ is Jiang Che's voice (S1), used only as an off-screen inner voice-over, not spoken by anyone on screen. "
               + MIXED_GOOD)
        w, _ = h13(txt)
        self.assertTrue(any(x.startswith("H13e") for x in w), w)

    def test_h9_phrase_hint_suppressed_in_mixed_shot(self):
        txt = MIXED_BAD.replace("Jiang Che (S1) says in an off-screen voiceover:", "Jiang Che's inner voiceover (S1):")
        w, _ = all_warns(txt)
        self.assertTrue(any(x.startswith("H13e") for x in w), w)
        self.assertFalse(any(x.startswith("H9") and "off-screen voiceover" in x for x in w), w)
        w_off, _ = all_warns(txt, env="off")
        self.assertTrue(any(x.startswith("H9") and "off-screen voiceover" in x for x in w_off), w_off)

    def test_block_mode(self):
        w, i = h13(MIXED_BAD, env="block")
        self.assertTrue(any(x.startswith("H13e") for x in i), i)


PHONE_BAD = ("0-3s: Medium close-up of Jiang Che, phone pressed to his ear. "
             "The voice on the other end of the line says: <d>[Chinese] 你到哪了？</d> "
             "3-6s: Jiang Che (S1) says: <d>[Chinese] 马上到。</d> Then his mouth closes.")
PHONE_GOOD = ("0-3s: Medium close-up of Jiang Che, phone pressed to his ear; he listens, brows knitting, his lips resting closed. "
              "3-6s: Jiang Che (S1) says: <d>[Chinese] 马上到。</d> Then his mouth closes.")


class PhoneVoicePostTests(unittest.TestCase):
    def test_far_end_voice_in_segment_warns(self):
        w, i = h13(PHONE_BAD)
        self.assertTrue(any(x.startswith("H13f") for x in w), w)
        self.assertEqual(i, [], "默认只告警")

    def test_call_taker_acting_normally_passes(self):
        w, _ = h13(PHONE_GOOD)
        self.assertFalse(any(x.startswith(("H13f", "H13g", "H13e")) for x in w), w)

    def test_phone_voice_reference_line_warns(self):
        w, _ = h13("__MINIMAX_H3_REF_4__ is the phone voice of Su Qing. " + PHONE_GOOD)
        self.assertTrue(any(x.startswith("H13f") for x in w), w)

    def test_silent_party_in_frame_warns(self):
        w, _ = h13(PHONE_GOOD + " Split screen: Su Qing on the other end in her office.")
        self.assertTrue(any(x.startswith("H13g") for x in w), w)
        w2, _ = h13(PHONE_GOOD + " The caller appears in frame at the door.")
        self.assertTrue(any(x.startswith("H13g") for x in w2), w2)

    def test_phone_block_mode(self):
        w, i = h13(PHONE_BAD, env="block")
        self.assertTrue(any(x.startswith("H13f") for x in i), i)


if __name__ == "__main__":
    unittest.main()
