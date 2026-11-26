<!-- rulebook: id=PC tier=volume when=call -->
## PC 通话声音（E-002、E-005；打电话、视频通话时读，2026-11-26 从 E 原样移入）

#### 〔E-002〕 第2、3集通过后转正：**The caller is a bound character (TR-V02).** In a phone shot the person on the other end is in `character_ids` even when off screen, or IC attaches no voice reference and the voice drifts. Write `It is the same voice in the room and through the phone receiver.`

#### 〔E-005〕 **Phone voices (the far end of a call) are voiced by H3 too.** Write the caller's line as a `<d>` line with the caller's own speaker ID, described as the voice heard through the phone, e.g. `the caller's voice (S2) comes faintly through the phone's earpiece, tinny and slightly compressed, <emotion>, <pace>: <d>[Chinese] …</d>`, and bind the caller's own voice reference (`__MINIMAX_H3_REF_n__ is <Caller>'s voice (S2)`), so the timbre stays the same in every shot of the call.
   - The on-screen call-taker acts normally: phone at the ear, listening reactions (brows, gaze, nod, free hand), and their own spoken replies as normal `<d>` lines with visible mouth. While the far end talks, the call-taker's lips rest closed.
   - The far end may be shown: either as its own shot in the caller's location, or inside the call shot with hard cuts to the caller (at most 2 cuts per shot, every cut at least 1 s, each cut shows exactly one person). When the caller is on screen her line is an ordinary spoken line with her mouth visible; when she is not, it is the earpiece voice above. Bind the caller in `character_ids` and her location in `scene_ids`, and use the same voice reference in both cases. Never a split screen or an inset.
   - Rule 9 of the Inner-Monologue section (listening wording, banned call/conversation words) still applies to an OS speaker on the phone.
