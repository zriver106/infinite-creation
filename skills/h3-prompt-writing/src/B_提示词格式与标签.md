<!-- rulebook: id=B tier=base when=always -->
## B 提示词格式与标签

# H3 Prompt Writing

### 〔B-001〕 Project rule: no in-shot score — `non_diegetic_music: N/A`

Every shot's video prompt in this project writes the music section as exactly `non_diegetic_music: N/A`, in the base modes and in Ref2VA alike. No music is generated inside a shot.

- Why: all scoring is laid in post when the chapter is assembled, from the chapter BGM and its cue table (`set_chapter_music` / `set_chapter_music_cues`). Music generated inside a shot clashes with the chapter BGM and breaks the main track's resume-from-breakpoint after a silent or inserted segment.
- This overrides the music examples in `references/base-en.txt` §4.7 and `references/ref-en.txt` §6; they remain a format reference only.
- Do not describe background music, score, BGM or a soundtrack anywhere else in the prompt either (not in `overall_soundscape`, not in the body). Sound the characters can hear in the scene (a radio, a ringtone, a street musician) is ambience: write it in `overall_soundscape` only when the story needs it.
- Free-text prompts (the `Sound: … Background music: …` style) write no music sentence at all; if a music slot must be filled, write `Background music: none.` The `Sound:` sentence carries only sound heard in the scene. When rewriting an existing prompt that has a `Background music:` sentence, delete it.
- Do not bind `music` assets as a shot's audio reference (`audios`); only voice and sfx assets go there.
- The render-time music check (`lib/core/music-check.js`) warns when `non_diegetic_music` is not N/A, when an H3-sectioned prompt has no `non_diegetic_music` section, or when a shot binds a `music` asset.

### 〔B-002〕 Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- **Character appearance: write only the clothing ID, never a look description (R22, rewritten 2026-11-23 rulepack-lock-20261123; 总导 2026-11-23 03:36 批准)**: a character's image reference carries the face, age, hair texture, skin, build, fabric, materials, shoes, accessories and trims, so the prompt never describes them. (1) **Reference line = who, not what they look like:** write character name + role/identity, e.g. `__MINIMAX_H3_REF_1__ is Ye Xueji's spirit body`; never add age, facial features, face shape, skin, build, materials, shoes, accessories or trims. (2) **When to write the clothing ID:** write one short clothing ID — colour + main garment + hair, e.g. `grey-blue short-sleeved T-shirt, dark grey trousers, short black hair` — for each bound character (a) in every shot with two or more people on screen, (b) in every shot, solo shots included, of a scene where any shot has two or more people on screen, and (c) whenever the story puts the character in a state the bound image does not show (injury, dirt, wet, exhaustion): add that state as words after the clothing ID, at the degree the novel gives, e.g. `a small scrape on the right cheekbone`. A solo shot in a scene that only ever has one person writes no clothing ID. (3) **Where the words come from:** copy the clothing ID from the bound costume asset (or the character asset when no costume is bound) and from the costume-state trajectory table when one exists; keep it word-for-word identical in every shot of the scene until the story changes the costume (see *Same-scene presence and costume lock* items 2, 4 and 11). Write it in the reference line or the headcount lock sentence, never as a separate appearance paragraph. (4) **Never** write `keep the look of __MINIMAX_H3_REF_N__`, `keep the look of each reference`, `stay faithful to the reference image` or any similar sentence (these make the shot drift into the reference image at its end); end the prompt with the live-scene lock instead, e.g. `The last frame is still the live <scene> scene.` (5) If the task input supplies a character's look (asset description, character bible, continuity notes, 「角色一致性」 line), take only the clothing ID out of it under (2)–(3); do not copy anything else. This rule overrides the `keeps the look of <Picture N>` advice in references/ref-en.txt. Scenes, props and environments are not covered by this rule — describe them normally.
- **Make every character action emotion-driven and physically specific**: never write only inert/still verbs (stands / sits / walks / looks) with no force. State the action's intensity, speed, and body language so the motion has visible energy (e.g. `slams the table`, `paces frantically`, `clenches his fists`, `leans in intensely`, `snatches the letter`, `stumbles back breathless`) — and keep the action consistent with that line's emotion. Static characters plus a monotonous read come across as lazy; give each beat visible, purposeful movement. **Inner-monologue exception:** in an OS block the force goes into the eyes, brows, head, hands and body only — never into the mouth (see “Inner-Monologue (OS / 心声) Shots”).
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
- **Speaker IDs follow the speaking order inside this shot**: each IC shot is its own video, and H3 gives `(S1)` to the first voice heard in it and `(S2)` to the next new voice (`references/ref-en.txt` §5.4). So the first voice in this shot, OS included, is `(S1)`; never fix an ID for the whole chapter. The voice-reference line uses the same ID as that character's lines, whatever its REF number (`__MINIMAX_H3_REF_4__ is the lead's voice (S2)` is fine); in the OS fixed sentences `(S1)` means the OS speaker's ID in this shot. Jobs 70f12d2f shot 17 and 231e6bc2 shots 1–2 tagged the shop owner, who spoke first, `(S2)`: both voices came out swapped.

### 〔B-003〕 No style-lock sentence; live-action lock instead — 不写画风锁定句，改写实景锁

H3 reads any sentence that ties the shot's look to a reference image as "show the reference image". The end of the shot, or the whole shot, then turns into the reference picture, a character sheet or a grey backdrop, and the reference's rendering style is locked in.

1. **Applies to:** every shot and every field that reaches H3 (`subject_definitions`, `summary`, `detailed_description`, `retention_analysis`, sub_shots).
2. **Never write:** `keep the look of __MINIMAX_H3_REF_n__`, `keeps the rendering style of the reference images`, `stay faithful to the reference image`, `same as (the) reference`, or any paraphrase that asks the shot to look like a reference. Identity already comes from the definition line (`__MINIMAX_H3_REF_k__ is <name>: <clothing ID>`); no extra "keep the look" wording is needed.
3. **Write instead (when the bound image is a sheet, a multi-view board or has a grey background, or the shot ends on a still beat):** at the start `From the first frame to the last frame this is the live-action <location>; it never turns into a reference image, a blank background or a grey studio backdrop.` and at the end `The last frame is still the same live-action <location>.`
4. **Wrong:** `... she turns back to the window, keeping the look of __MINIMAX_H3_REF_1__.` **Right:** `... she turns back to the window. The last frame is still the same live-action seafood buffet restaurant.`
5. **Check:** h3_prompt_lint ERROR `STYLE_REF_KEEP` (r66, extended r85) already blocks these phrases before rendering. When you rewrite a shot, delete the sentence from that shot. Do not widen a fix to other shots only for this sentence; how existing hits in untouched shots are cleared is decided by 总导.

### 〔B-004〕 Visual follows the prompt — 改提示词就同步重写 visual

`video_prompt` is what renders. Whenever you write or change a shot's `video_prompt`, rewrite these parts of that shot's `visual` from the new prompt in the same PATCH, then read the two back together:
- who is in frame, who enters or exits, and who is only a voice;
- whether each person stands, sits or walks, and where each one is;
- movement direction and camera direction;
- what each hand holds and where the props sit;
- what any system UI or screen shows;
- the end-frame state.

When `visual` and the prompt disagree, the prompt wins and `visual` is rewritten to match.
- **Never edit only `visual` to get past a lint check if that makes it contradict the prompt.** Example: writing "the panel has not appeared yet" when the prompt opens the panel at 1 s. Fix the prompt or the binding instead, or report the lint item and ask for a waiver.
- Before handing a batch in, compare each changed shot's `visual` with its prompt on the items above. List every contradiction in the report.

#### 〔B-005〕 B-005【待测】IC 提示词的时间段只用整秒（TR-V13）

`N-Ms:` 时间段、`runs from` 句里的秒数一律写整数；不写 0.5s 这类小数。

#### 〔B-006〕 B-008【待定】画风基线

唯一风格句由总导定稿后写入本条；定稿前不改各镜现有风格句，也不写任何把画面锁到参考图的句子（见本类「不写画风锁定句」）。
