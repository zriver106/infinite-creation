---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. Also covers storyboard-contract driven multi-segment generation: drafting a storyboard.json from a novel/script with a local or remote LLM, then compiling it into consistent per-segment H3 prompts (Ref2VA/T2VA first segment + FL2VA continuations) with no repeated segments and no positional or identity drift.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---
<!-- rulebook:generated rules-2026.11.23-2244 本文件由 M\工具\rulebook_build.py 从 src/ 生成，不要手改 -->

## 地图（写视频提示词）：使用方法

1. 先读本地图和下面的基础规则（到本文件「基础规则结束」那一行为止）。改编（剧本、分镜）规则在 adapt-rules，写提示词时不读。
2. 只读当前步骤要用的分册：按下表的行号，调用 `skill_lines(h3-prompt-writing, 起行, 止行)` 读那一段；用不到的分册不读。写提示词时，IC 在每镜 brief 的 `required_ranges` 里列出本镜要读的段，照单读。
3. 拿不准、遇到新情况、或觉得「应该这样写」时，先回本地图查；有规则一律以规则为准。
4. 查过确实没有规则，才凭判断做，并调用 `report_rule_gap` 登记（什么情况、怎么做的、为什么），不自己编一套固定写法。
5. 每段最后一行是「本段校验码」。保存时把读过各段的校验码放进 `ranges_ack`，IC 核对，对不上不收。
6. 一镜要读的规则超过预算（brief 里 `too_dense`），说明这一镜太满：不写，报回分镜层拆成两镜（各 7–8 秒），不删规则。

| 段 | 内容 | 层级 | 行号 | 什么时候读 |
|---|---|---|---|---|
| A | A 铁律与流程 | 基础（已在上面，必读） | L37–L62 | 每次 |
| B | B 提示词格式与标签 | 基础（已在上面，必读） | L64–L119 | 每次 |
| C | C 心声 | 基础（已在上面，必读） | L121–L169 | 每次 |
| D | D 系统声与光幕 | 基础（已在上面，必读） | L171–L188 | 每次 |
| F | F 一致性（人物、服装、场景、道具、站位、人数） | 基础（已在上面，必读） | L190–L226 | 每次 |
| E | E 人声与台词 | 分册 | L231–L279 | 有台词 |
| FX | F9 一致性细则（待测：前景半截头肩、机位景别、座位姿态、桌面道具、背景人群、视线、开场状态句、关键道具） | 分册 | L281–L316 | 两人及以上、有道具、桌面、车、绑了场景 |
| F5V | F5 多人同场多视角定义图（_MV） | 分册 | L318–L332 | 两人及以上 |
| H1 | H1 镜头、运镜与打戏节奏 | 分册 | L334–L361 | 有运镜、动作、打戏 |
| H2 | H2 Q 版、特效、流行语与谐音（冷门） | 分册 | L363–L438 | 开了表现开关或有 Q 版/特效 |
| J | J 资产与绑定 | 分册 | L440–L468 | 绑定、参考图有疑问、绑了场景 |
| L | L 现实逻辑与剧情 | 分册 | L470–L481 | 有交易、冲突、回忆 |
| B2 | B2 生成模式、全参考与多段（冷门） | 分册 | L483–L524 | 用到时再查 |
| Q | Q 审片 | 分册 | L526–L547 | 用到时再查 |

地图结束。下面是基础规则。
本段校验码：B8C30152

## A 铁律与流程

#### 第2、3集通过后转正：**Retire, do not delete (TR-V11).** A shot the viewer cannot follow (an unexplained memory, a confusing beat) is retired, not deleted; then the next shot is re-joined to the previous shot's last pose with item 10.

### 【通用】铁律：规则先进 IC，写稿、改稿、出片只走 IC 工作流

由来：Andy 11-23 20:20–20:27 原话：「要同步好才开工」「要走ic工作流.改东西也一样」「没走ic工作流出来的片子一律作废」「质量就算没问题可能风格也不对」「这个是铁律要写进手册」「我们的会话多半是管理工作，查缺补漏辅助ic管理ic工作可持续」「和一些资产生成和绑定」。手册第0章 0.0 同文。本条优先于其他技能正文和任何会话派单。

1. **先同步、再开工。** 规则改了，先同步进 IC 技能并核对已经生效（在 IC 里拼出一条提示词，看得到新规则原文），才写稿、出片。
2. **写稿、改稿、返修只走 IC 工作流。** 剧本、分镜、视频提示词的新写和修改都由 IC 工作流完成（`write_shot_video_prompt`、提示词撰写任务、阶段任务等）。外部会话不得手写稿后直接写库（PATCH、SQL、脚本批量写回都算）。改一句也走 IC。
3. **没走 IC 工作流出来的片子一律作废。** 作废看来源，不看单镜质量（质量没问题，风格也可能不对）。先归档，不删除；对应的镜回到 IC 工作流重写、重出。
4. **会话做管理，IC 做生产。** 指挥系统各会话负责查缺补漏、给 IC 补规则和技能、保证 IC 持续运转、资产生成和绑定；写稿、改稿、出片由 IC 工作流完成。
5. **对 IC 内的写作者：** 你就是这条工作流。接到写稿或改稿任务时，按本技能和对应阶段技能写；不要把稿子交给外部去改再写库。发现规则缺口时，在报告里写明，由管理会话补进技能。

### 【通用】作废的审片经验：「正脸改成微侧或低头（为防口型）」

由来：总导 2026-11-23 20:33 拍板，依据 Andy 11-23 20:24 铁律（要走 IC 工作流）与第6集心声镜核查（`M\_\ep6_rule_audit_2025\核查报告.md`：6#7 背向镜头、6#6 和 6#10 为防口型改成低头侧脸，都出自外部会话的审片经验，不在手册里）。

1. 这条经验作废，以手册 M33 第7条为准：镜头只按剧情选，不为防口型背身、遮脸、专选背影，也不为防口型改成低头、侧脸。正脸近景照常可以承载心声；防口型靠自然闭嘴句（M33 第3条）和 M34。
2. M33 第6、7、8条现在是错误，不是提醒（检查器 `inner_voice_check_m33_678.py`）：一个镜头（`[Shot N]`）里不能既有心声又有出口台词；不写背向镜头、脸转开、只见后脑、捂嘴、遮脸、「为防口型」；心声窗口写明「The inner voice runs from Xs to Ys」，到切点或段末、两句之间、与对白之间都至少 0.8 秒。

### 【通用】三处同改，作废不删除

1. **三处同改（TR-V18 已并进 h3-prompt-writing「Visual follows the prompt」节）。** 改镜头写法（景别、机位、站位、动作、台词）时，`visual`、`camera`、`sub_shots`、`video_prompt` 一起改；只改一处，渲染出来的还是旧的。台词改动同时改 `dialogue`、`<d>`、`sub_shots`。
2. **看不懂的镜作废，不删除（TR-V11）。** 观众看不懂的镜（没交代的回忆、莫名其妙的一拍）标作废（retire），不删；作废后，下一镜按【分镜】第 6 条重新接上上一镜的结尾站位。
本段校验码：9B8EBBC1

## B 提示词格式与标签

# H3 Prompt Writing

### Project rule: no in-shot score — `non_diegetic_music: N/A`

Every shot's video prompt in this project writes the music section as exactly `non_diegetic_music: N/A`, in the base modes and in Ref2VA alike. No music is generated inside a shot.

- Why: all scoring is laid in post when the chapter is assembled, from the chapter BGM and its cue table (`set_chapter_music` / `set_chapter_music_cues`). Music generated inside a shot clashes with the chapter BGM and breaks the main track's resume-from-breakpoint after a silent or inserted segment.
- This overrides the music examples in `references/base-en.txt` §4.7 and `references/ref-en.txt` §6; they remain a format reference only.
- Do not describe background music, score, BGM or a soundtrack anywhere else in the prompt either (not in `overall_soundscape`, not in the body). Sound the characters can hear in the scene (a radio, a ringtone, a street musician) is ambience: write it in `overall_soundscape` only when the story needs it.
- Free-text prompts (the `Sound: … Background music: …` style) write no music sentence at all; if a music slot must be filled, write `Background music: none.` The `Sound:` sentence carries only sound heard in the scene. When rewriting an existing prompt that has a `Background music:` sentence, delete it.
- Do not bind `music` assets as a shot's audio reference (`audios`); only voice and sfx assets go there.
- The render-time music check (`lib/core/music-check.js`) warns when `non_diegetic_music` is not N/A, when an H3-sectioned prompt has no `non_diegetic_music` section, or when a shot binds a `music` asset.

### Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- **Character appearance: write only the clothing ID, never a look description (R22, rewritten 2026-11-23 rulepack-lock-20261123; 总导 2026-11-23 03:36 批准)**: a character's image reference carries the face, age, hair texture, skin, build, fabric, materials, shoes, accessories and trims, so the prompt never describes them. (1) **Reference line = who, not what they look like:** write character name + role/identity, e.g. `__MINIMAX_H3_REF_1__ is Ye Xueji's spirit body`; never add age, facial features, face shape, skin, build, materials, shoes, accessories or trims. (2) **When to write the clothing ID:** write one short clothing ID — colour + main garment + hair, e.g. `grey-blue short-sleeved T-shirt, dark grey trousers, short black hair` — for each bound character (a) in every shot with two or more people on screen, (b) in every shot, solo shots included, of a scene where any shot has two or more people on screen, and (c) whenever the story puts the character in a state the bound image does not show (injury, dirt, wet, exhaustion): add that state as words after the clothing ID, e.g. `right cheek red and swollen, a trace of blood at the mouth corner`. A solo shot in a scene that only ever has one person writes no clothing ID. (3) **Where the words come from:** copy the clothing ID from the bound costume asset (or the character asset when no costume is bound) and from the costume-state trajectory table when one exists; keep it word-for-word identical in every shot of the scene until the story changes the costume (see *Same-scene presence and costume lock* items 2, 4 and 11). Write it in the reference line or the headcount lock sentence, never as a separate appearance paragraph. (4) **Never** write `keep the look of __MINIMAX_H3_REF_N__`, `keep the look of each reference`, `stay faithful to the reference image` or any similar sentence (these make the shot drift into the reference image at its end); end the prompt with the live-scene lock instead, e.g. `The last frame is still the live <scene> scene.` (5) If the task input supplies a character's look (asset description, character bible, continuity notes, 「角色一致性」 line), take only the clothing ID out of it under (2)–(3); do not copy anything else. This rule overrides the `keeps the look of <Picture N>` advice in references/ref-en.txt. Scenes, props and environments are not covered by this rule — describe them normally.
- **Make every character action emotion-driven and physically specific**: never write only inert/still verbs (stands / sits / walks / looks) with no force. State the action's intensity, speed, and body language so the motion has visible energy (e.g. `slams the table`, `paces frantically`, `clenches his fists`, `leans in intensely`, `snatches the letter`, `stumbles back breathless`) — and keep the action consistent with that line's emotion. Static characters plus a monotonous read come across as lazy; give each beat visible, purposeful movement. **Inner-monologue exception:** in an OS block the force goes into the eyes, brows, head, hands and body only — never into the mouth (see “Inner-Monologue (OS / 心声) Shots”).
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
- **Speaker IDs follow the speaking order inside this shot**: each IC shot is its own video, and H3 gives `(S1)` to the first voice heard in it and `(S2)` to the next new voice (`references/ref-en.txt` §5.4). So the first voice in this shot, OS included, is `(S1)`; never fix an ID for the whole chapter. The voice-reference line uses the same ID as that character's lines, whatever its REF number (`__MINIMAX_H3_REF_4__ is Jiang Che's voice (S2)` is fine); in the OS fixed sentences `(S1)` means the OS speaker's ID in this shot. Jobs 70f12d2f shot 17 and 231e6bc2 shots 1–2 tagged the shop owner, who spoke first, `(S2)`: both voices came out swapped.

### No style-lock sentence; live-action lock instead — 不写画风锁定句，改写实景锁

H3 reads any sentence that ties the shot's look to a reference image as "show the reference image". The end of the shot, or the whole shot, then turns into the reference picture, a character sheet or a grey backdrop, and the reference's rendering style is locked in.

1. **Applies to:** every shot and every field that reaches H3 (`subject_definitions`, `summary`, `detailed_description`, `retention_analysis`, sub_shots).
2. **Never write:** `keep the look of __MINIMAX_H3_REF_n__`, `keeps the rendering style of the reference images`, `stay faithful to the reference image`, `same as (the) reference`, or any paraphrase that asks the shot to look like a reference. Identity already comes from the definition line (`__MINIMAX_H3_REF_k__ is <name>: <clothing ID>`); no extra "keep the look" wording is needed.
3. **Write instead (when the bound image is a sheet, a multi-view board or has a grey background, or the shot ends on a still beat):** at the start `From the first frame to the last frame this is the live-action <location>; it never turns into a reference image, a blank background or a grey studio backdrop.` and at the end `The last frame is still the same live-action <location>.`
4. **Wrong:** `... she turns back to the window, keeping the look of __MINIMAX_H3_REF_1__.` **Right:** `... she turns back to the window. The last frame is still the same live-action seafood buffet restaurant.`
5. **Check:** h3_prompt_lint ERROR `STYLE_REF_KEEP` (r66, extended r85) already blocks these phrases before rendering. When you rewrite a shot, delete the sentence from that shot. Do not widen a fix to other shots only for this sentence; how existing hits in untouched shots are cleared is decided by 总导.

### Visual follows the prompt — 改提示词就同步重写 visual

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

#### B-005【待测】IC 提示词的时间段只用整秒（TR-V13）

`N-Ms:` 时间段、`runs from` 句里的秒数一律写整数；不写 0.5s 这类小数。

#### B-008【待定】画风基线

唯一风格句由总导定稿后写入本条；定稿前不改各镜现有风格句，也不写任何把画面锁到参考图的句子（见本类「不写画风锁定句」）。
本段校验码：B8834DC5

## C 心声

### Inner-Monologue (OS / 心声) Shots — hard rule (rewritten 2026-11-23 18:45 to the handbook M33/M34 method; Andy 18:40, 总导 18:40 批)

An inner-monologue line is a character's thought heard as an off-screen voice. H3 voices it in the shot (`<d>`), and the people in the picture keep a natural, still, closed mouth. **Source of truth: `docs/AI_Short_Drama_H3_Rules.md` M33 (L621–658) and M34 (L660–668).**

**1. How to recognise an OS line.** A dialogue/sub-shot line is inner monologue when the speaker label carries `（OS）` / `(OS)` / `（内心）` / `（心声）` / `（内心独白）`, or the shot text says 内心独白 / 心声 / inner voice / inner monologue for that line. Phone voices, the system voice 系统 and the narrator 旁白 are not OS (see their own sections: the system voice is written in `<d>` with its own sentence; 旁白 stays in post).

**2. Every line is in `<d>`, word for word.** Handbook M33 rule 1 (L629), verbatim: 「心声和电话声必须写进段文件 `<d>`，由 H3 直接生成，禁止再删掉或改走后期配音。`<d>` 正文与 `windows.text` / dialogue 逐字一致。」 Do not drop, merge or rewrite any OS line. One kind of voice per camera shot (M33 rule 6, L634; see "One kind of voice per camera shot" in the section "Inner voice, hand props and glasses" below): a camera shot (`[Shot N]`) with an OS window has no spoken line at all; keep ≥ 0.8 s between an OS window and a neighbouring dialogue window, and ≥ 0.8 s from the OS window's end to the cut / shot end (M33 rule 8, L637).

**3. Natural-close sentence at the start (M33 rule 3, L631) — copy verbatim.** Handbook text: 「画外音镜里看得见脸的每个人物，在起始状态里写自然闭嘴句：`〔他/她〕双唇自然合拢，嘴角放平，下颌放松，整个镜头里〔他/她〕只用眼睛、眉头和肩膀表现情绪。`；这一镜最后的保持句里写 `双唇一直自然合拢`。画面里没有人、或看不到人物的脸时不写。」
- In `video_prompt` (English), before the first time block that contains an OS line, write for every person whose face is visible: `His lips are naturally together, the corners of his mouth are level and his jaw is relaxed; for the whole shot he shows emotion only with his eyes, brows and shoulders.` (female: `Her lips are naturally together, the corners of her mouth are level and her jaw is relaxed; for the whole shot she shows emotion only with her eyes, brows and shoulders.`; a name may replace the first `His/Her`).
- In `visual` / `sub_shots` (Chinese) write the handbook sentence itself: `他双唇自然合拢，嘴角放平，下颌放松，整个镜头里他只用眼睛、眉头和肩膀表现情绪。`
- In each OS time block you may write once, as is: `Lips: lips stay closed, no lip movement.` Nothing else about the mouth.
- The last hold sentence of the shot (after the last OS block starts) contains `his lips stay naturally together` (female `her lips stay naturally together`), e.g. `He stays in frame until the last frame, eyes still on the screen-left table edge, his lips stay naturally together.`; Chinese `visual`: `双唇一直自然合拢，保持到镜头结束。`

**4. No mouth or breath words anywhere in the shot — negated ones are errors too (M33 禁止 L645, M33 检查 L647, M34 rule 1 L662).** Handbook M34 rule 1, verbatim: 「和画外音窗口重叠的整镜里，画面人物不写叹气、呼气、吸气、呼吸、起伏、喘、撇嘴、抿嘴、咬唇、吞咽、张嘴笑、冷哼、嘴唇颤、胸口起伏（呼吸类词算嘴部词，英文 breath、breathing、sigh、chest rising 同样不写；完整词表和白名单见 M33「检查（错误，嘴部词）」）。」 The M33 check list (L647) also counts: 张嘴、张开嘴、开口、嘴唇动、嘴唇颤、嘴动、喘、喘气、喘息、喊、大喊、叫喊、说话、说着、说道、念叨、嘟囔、喃喃、低语、耳语、小声说、呼吸、起伏、吸气、叹气, `open(s) his/her mouth`, `lips move`, `pant`, `shout`, `speak`, `murmur`, `mutter`, `whisper`, `breath`, `breathing`, `sigh`, `chest rising`.
- This applies to the whole text of every shot that overlaps an OS window (not only the OS block), in `video_prompt`, `visual`, `sub_shots` and `camera`. Writing "never sighs", "does not mouth the words", "lips pressed shut", "tightly sealed", "no smile", "Nobody on screen is speaking" is the same error as writing the action.
- Also do not write in such a shot (IC checker list): pressed / tightly shut / sealed / pursed / pout, teeth, tongue, grin, smile, smirk, laugh, chuckle, scoff, snort, huff, gasp, exhale, inhale, swallow, gulp, chew, bite, talk, yell, lip-sync; 嘴、唇、齿、抿、紧闭、口型、嘴角、咧嘴、笑出声、叹、哼. A frozen smile is written as 「闭着嘴的笑」 only if the story needs it (M34 rule 2), otherwise move it to the next shot without voice.
- Whitelist (the complete list, L647): the natural-close sentence and the hold sentence of rule 3, `lips stay closed, no lip movement`, and — in a shot that also has another person's spoken line — that speaker's own speaking description inside his own dialogue window.
- Inside `<d>` the original words are never edited, whatever they contain.

**5. Emotion through eyes, brows, head and shoulders; 2–3 actions per window (M34 rules 2–3, L663–664).** Handbook, verbatim: 「情绪用眼神、眉头、头、肩膀表现」「每个画外音窗口内人物动作 2–3 个；关键情绪拍不挤在窗口之后的几秒里：不动嘴的眼神、眉毛变化放在窗口末尾，窗口后的尾段按剩余时长重新数动作（≤ 2.5 秒最多 2 件）。」 Pick 2–3 visible actions from: gaze moves / narrows / widens, brows knit / lift, small nod / shake / tilt of the head, shoulders drop / square, a hand tightens or rests. Match them to the meaning of the line; neighbouring OS lines change at least one of eyes / brows / head / shoulders. After the window, write the start point (something visible) and the end point `保持到镜头结束 / until the last frame` (M34 rule 4, L665). A shot that is only voice-over gets a visible action chain with a new visible change at least every 3 s; no staring, sitting still or waiting to fill time (M34 rule 5, L666).

**6. No eating, food, chopsticks, spoon, cup or drink actions during an OS window.** Inside an OS window the hands do not pick up, peel, turn, lift or bring food, chopsticks, a spoon, a cup or a glass anywhere; nothing goes toward the face. If the story needs eating or drinking, put it in a time block that does not overlap the OS window, or let the hands rest still (on the table / out of frame). Story props that stay away from the face (a phone held at chest level, a document) are fine.

**7. Shot choice only by the plot — no avoidance tricks (M33 rule 7, L635).** Handbook, verbatim: 「镜头语言（正后方背影、物件特写、反应镜、空镜、正脸近景）只按剧情选，不为防对口型而选，没有比例上限。不用任何回避写法：不捂嘴、不背身、不遮脸，不为防口型专门选背影或空镜。」 A wide shot where the mouth is too small to read, or a phone-screen / document / hand close-up with no face, may carry the voice (L636). Do **not** demand a frontal close-up "with the mouth visible" for OS; do not cover the mouth with a hand, phone, cup or object; do not turn the character's back to hide it. **Void:** the review tip "turn the frontal face slightly aside or bow the head to prevent lip-sync" is void. A bowed head, a three-quarter face or looking at a phone is chosen only when the story needs it, never to hide the mouth; a frontal close-up may carry the inner voice, and lip-sync is prevented by the natural-close sentence (rule 3) and rule 4.

**8. Fixed voice sentences — copy verbatim, only fill the `<…>` slots.**
- Voice reference line: `__MINIMAX_H3_REF_n__ is <Name>'s voice (S1), used only as an off-screen inner voice-over, not spoken by anyone on screen.`
- Shot declaration (once, after the subject lines): `Inner-monologue shot for <Name>: the voice belongs to no one in the picture, and all emotion shows in his eyes, his brows and his shoulders, with small movements of his head.` (she/her for a female speaker).
- Each OS line: `An off-screen male inner-monologue voice (S1), <emotion>, <pace>, <voice quality>, narrates <d>[Chinese] <original line, unchanged></d>. The voice belongs to no one in the picture; <Name> only listens to his own thoughts.` (`female` / `her` for a female speaker).
- The voice is an independent, unnamed off-screen voice whose timbre comes from the REF audio line; never put the character's name and a speech verb in the same sentence (no `<Name> says / speaks / narrates`, no `<Name> (S1) …<d>`). Describe the voice with adjectives (tense, hushed, rapid, rising, trembling, low, bright, biting); the only verb it gets is `narrates`, its subject is always `An off-screen male/female inner-monologue voice (Sx)`.
- An emotion turn inside one line: `at <t>s his gaze / brows / head / shoulders shift to <emotion B>` — never a mouth change.

**9. OS while the character is on the phone.** He is listening: `<Name> is listening, phone held at his ear, not talking; the person on the other end is the one heard.` Add one listening reaction with the eyes, brows, head or free hand (`his brows knit as he listens`, `a slow small nod`). Do not use `call`, `phone call`, `phone conversation`, `on a call with`, `talking into the phone`, `answers`, `replies`, `responds`, `argues`, `chats`, `conversation`. Rules 3–7 still apply (natural-close sentence, no mouth words).

**10. Energy rules apply to the voice and to eyes, brows, head, shoulders and hands only** — never to the mouth or breath. **No ledger words** anywhere in the prompt (`台词：无`, `无对白`, `（沉默）`, `（内心）`, `OS`, `心声`): H3 reads them aloud. Inside `<d>` only the language tag and the original words. `summary` only says whose inner voice sounds, never its content; never write 默念 / 在心里说 / 独白 / 开口 / 嘴唇动了动 (M33 rule 9, L638; X33 L644).

**11. Self-check before returning the prompt (block, not warn).** For every shot that has an OS line: (a) every OS line of `dialogue` is a `<d>` line, word for word; (b) the natural-close sentence of rule 3 is before the first OS block for each visible face, and the hold sentence with `lips stay naturally together` is after the last OS block starts; (c) zero words from rule 4 outside the whitelist, negated ones included, in `video_prompt`, `visual`, `sub_shots` and `camera`; (d) no food / chopsticks / cup action inside an OS window; (e) 2–3 actions per OS window; (f) no mouth-covering, back-turning or face-hiding chosen to avoid lip-sync; (g) fixed voice sentences of rule 8 used, no name + speech verb. (h) one kind of voice per camera shot: no `[Shot N]` holds both an off-screen voice window and a spoken line (M33 rule 6); (i) no avoidance framing anywhere in `video_prompt`, `visual`, `sub_shots` or `camera`: no back to the camera, face turned away, only the back of the head, seen from behind, covered mouth or face, and no wording such as "to avoid lip-sync" (M33 rule 7; negated wording and a phone screen facing away are fine; the M44 phone exception keeps a back view of the call-taker allowed); (j) every off-screen window is written with `The inner voice runs from Xs to Ys.` and ends ≥ 0.8 s before the cut or the end of the video, ≥ 0.8 s from the next off-screen window and ≥ 0.8 s from any spoken window (M33 rule 8). The project checker `M\_\inner_voice_check\inner_voice_check.py` implements (b)–(e); its successor `M\工具\inner_voice_check_m33_678.py` also implements (h)–(j). Any ERROR must be fixed before the prompt is saved.

#### 第2、3集通过后转正：**Inner voice runs over action and stays short (TR-V09).** In conflict or fight shots the inner-voice line plays while the action continues; nobody stands still to "listen" to it, and a long line may be shortened to the novel's meaning (change dialogue, `<d>` and sub_shots together).

#### **Inner-voice (OS) shots follow the Inner-Monologue section above (handbook M33/M34; rewritten 2026-11-23).** Write the natural-close sentence at the start and `his lips stay naturally together` in the last hold sentence; the face reacts only with the eyes, brows, head and shoulders. Never add mouth or breath wording such as `lips remain completely closed`, `does not mouth the words` or `breath` — negated mouth words are errors too (M33 L647).

#### C-009【待测】每个心声窗口写明起止秒（续轮6 补，总导 20:33 心声门禁）

每个心声时间段里必须写一句 `The inner voice runs from <起>s to <止>s.`，起止取整秒，和该句 `<d>` 的实际位置一致。门禁按这句算第8条的 0.8 秒间隔；没写这句，门禁按整个时间段估计，常常误判超时。正例：`4-9s: … The inner voice runs from 5s to 8s. An off-screen male inner-monologue voice (S1) … narrates <d>[Chinese] …</d>.` 反例：只写 `4-9s:`，不写 runs from 句。
本段校验码：BA68CA5D

## D 系统声与光幕

#### 第2、3集通过后转正：**System UI: short text on the panel; the system's full spoken line goes in `<d>` and H3 speaks it (TR-V04; system voice per Andy 11-23 17:27 本人选择卡原话「按14:55，系统声音在提示词里念完整内容」, which overrides the 16:04 line 「系统声音还是按照原来设计去作业」; panel text per Andy 11-23 14:55 选择卡（总导转述）and 总导 11-23 15:09 / 15:17 裁定; narration 旁白 is unchanged and stays in post).**
   - **Voice.** When the shot's `dialogue` has a system line (speaker 系统 / 系统音 / 系统声 / 系统提示 / 【系统】), write that line's complete text, word for word, in its own `<d>[Chinese] …</d>` and let H3 speak it; never shorten it to the panel text, never move it to post, never drop it. Use the fixed system-voice sentence of the section "System voice — 系统声写进 `<d>`" below. Where the novel only shows the UI and the system says nothing, write no system `<d>` and do not invent a system line.
   - **Panel.** The panel enters in the same second the system line starts and stays at least as long as the line. Its background is a plain, even translucent colour with no banners, row frames or grid lines. H3 draws at most 2 short lines on it, each line at most 14 characters (all characters count: Chinese characters, punctuation, letters, digits; manual 0.5 字数口径 ①), large, high contrast, facing camera; take them from the system line's own text (usually its title or key phrase). Put the on-panel text in English double quotes `"…"`, never in 「」, 『』 or 【】, and keep these brackets out of the text itself (drop the novel's 【】 on screen; EP1–10: 「」 was painted as part of the text in 7 shots). A long panel that does not fit in two short lines gets no text: write `the panel shows no readable text`; the system voice in `<d>` carries the full content. The bracket rule also applies to the hint bar (提示条 / light bar): no 「」, 『』 or 【】 on it. In the 贴字表, a no-text panel is registered as 「无字，内容由系统音念」 when the system speaks there, otherwise 「无字」, with `lines: []`. Never a blurred panel.
   - **Narration (旁白) is not the system.** A 旁白 line is still dubbed in post: no `<d>` for it in the prompt.
   - Wrong: the panel carries four lines of the system text and no system `<d>`; or the system `<d>` holds only the two panel lines; or a `<d>` is invented for a UI the novel never voices. Right: panel `"交易成功"` / `"获得灵气 +10"`, and `An unseen synthetic system voice (S2) …, says <d>[Chinese] 交易成功，获得灵气+10，当前修为……</d>` with the full original line.
   -

### System voice — 系统声写进 `<d>`，由 H3 直出

1. **Who.** A dialogue line whose speaker, with brackets removed, is 系统 / 系统音 / 系统声 / 系统提示 / 系统提示音 / 系统女声 / 系统男声 is a system line. 「系统面板：」 or 「江澈（系统）：」 are not system lines.
2. **Fixed sentence (one per series, copied word for word every time; manual M30 item 1 example).** `An unseen synthetic system voice (Sx) that belongs to no one in the frame, a calm, clear, neutral young female synthetic voice with a faint electronic edge, speaking at a moderate pace, says <d>[Chinese] <complete system line, unchanged></d>.` If the shot binds a system-voice audio asset, add `in the same voice referenced from __MINIMAX_H3_REF_N__` after `pace,`. Never give the system a character's voice reference; never write `<Name> says` for it.
3. **Timing.** The panel (or hint bar) appears in the same second the system `<d>` starts and stays until it ends. The system voice is an off-screen voice, so handbook M33 rule 6 applies: the camera shot (`[Shot N]`) that carries it has no spoken line; spoken lines go in another camera shot after a hard cut, ≥ 0.8 s (in practice ≥ 1 s) away (see "One kind of voice per camera shot" below). It may overlap the listener's action. Speaker IDs follow the order the voices are first heard.
4. **The listener.** Everyone visible keeps the mouth closed while the system speaks: use the natural-close sentence of the Inner-Monologue section (`<Name>'s lips are naturally together, the corners of his mouth are level and his jaw is relaxed`) and act with eyes / brows / head only; no mouth or breath words.
5. **Panel text** follows TR-V04 (item 4 of "Rules verified by passed episodes 2 and 3"): ≤ 2 short lines, ≤ 14 characters each, English quotes, taken from the system line.
6. **Not in scope.** Narration 旁白 and broadcast-style narrators are not changed by this rule; 旁白 stays in post. The workflow manual package r81 that carries the same change is still under review; this section is the IC side only.
本段校验码：9FB7378A

## F 一致性（人物、服装、场景、道具、站位、人数）

### Same-scene presence and costume lock — 同场在场人物入画 + 服装锁

H3 only draws people who have a reference and are named in the prompt, and it freely swaps faces and clothes between references. A1 QC lost people and mixed clothes in 7 shots: 5-1 #8/#10/#12 and 19-2 #18 / 20-1 #5 (a seated table-mate was left out of `character_ids` because he had no line, so he vanished), 16-R-V1 #18 (the lead in a crowded wide shot was drawn in another character's dark green shirt), 17-2 #22 (the host got the side-table classmate's orange polo), 20-2 #27 (the speaker was written as "squeezing in from behind", so H3 put the wrong man in the centre and gave him the line). For every shot with two or more people:

1. **Everyone the storyboard places in frame is a reference and is named.** If the scene's blocking map / whiteboard puts a present character inside this framing (edge of frame, soft-focus foreground, back view included), that character must be in the shot's references and must be written into the 0s opening with screen side, facing and state (`lips closed` if silent; in a shot that overlaps an inner-voice window use the natural-close sentence of the Inner-Monologue section instead, never other mouth words). Never drop a present character just because he has no line. If the framing really excludes him, say where he is (`off screen-left`).
2. **Write a clothing ID for each person (R22 (2))** in `subject_definitions` and again in the 0s opening: colour + garment + hair, copied from the bound costume asset (`__MINIMAX_H3_REF_2__ is Han Zixiao: dark green long-sleeve shirt, slicked-back black hair`). A story state that the bound image does not show is added as words after the ID (`right cheek red and swollen`), see item 11. `fully_preserved` alone is not enough. Only the clothing ID: no faces, ages, materials or accessories.
3. **Add the lock sentence** whenever two people could be confused (same sex, similar age, strongly contrasting clothes): `Each person's face and clothing come only from his or her own reference; never move one person's clothing onto another person. Exactly one person in the frame wears <garment>.`
4. **Costume inheritance.** Inside one scene and continuous time, a character keeps the costume reference he wore in the previous shots of that scene (same `costume_ids`) until the story shows a costume change (item 11). Write the same clothing ID, word for word, in every shot; a story state (injury, dirt) is added to it as words and does not by itself change `costume_ids`.
5. **The speaker is already in place at 0s.** Do not make the speaking character "enter / squeeze in / push to the centre" to take his speaking position; put him there from the first frame and state `only <clothing ID> moves his mouth; <others> keep their lips closed` (in a shot that also has an inner-voice window, the silent people get the natural-close sentence of the Inner-Monologue section instead).
6. **Wide and crowd shots:** the named leads are at least medium size or in the foreground, with their clothing IDs; extras are described as "other guests" and must not wear a lead's colour.
7. **Who does the action comes from the novel/script, not from a similar-looking extra.** If the visual line names a character (e.g. "支架青年 deletes the clip"), the reference bound for that action must be that character; flag the shot if the binding names someone else.
8. **Headcount lock in every multi-person shot:** besides the count in the first sentence, write once in the body: `Exactly <N> people are in this shot and each of them appears only once: <A> (__MINIMAX_H3_REF_a__) in <clothing ID>; <B> (__MINIMAX_H3_REF_b__), a different man with a different face, <clothing ID>, never in <A's garment>. There is never a second <A> or any look-alike of him in the frame.` N counts only people on screen (voice-only and off-screen people are named as off screen).
9. **No limb without an owner, no second copy of anyone:** every body part at the frame edge or in the foreground belongs to a named, bound person on screen (name the owner, e.g. `Han Zixiao's half-cropped head and right shoulder at the screen-left edge`; never as an over-the-shoulder or foreground-shoulder phrase, which item 3 and the gate r71 OFF_OTS_BANNED reject; never use the lead as that half-cropped edge figure while he is also elsewhere in the frame, see ic-lessons TR-B09; examples changed 2026-11-23 IC规则同步 because the old ones conflicted with item 3). Never write a shoulder, arm, hand or back of a head that has no owner in the story, and never a second copy of anyone: `No stray shoulder, hand or arm without an owner enters the frame, and nobody appears twice.` A shoulder-only person with no owner at the edge was drawn as a second lead in ch3 #13. This item does not decide whether an over-the-shoulder framing is allowed; that is item 3 above and the gate's own OFF_OTS_BANNED.
10. **Per-shot lock inside a scene:** items 2, 8 and 9 apply to every shot of the scene that binds the character, including solo shots, reaction shots and the last shots of the scene, not only the first ones.
11. **Costume change vs. story state:** inside a scene the costume reference and clothing ID stay the same. A **costume change** (changes clothes, puts on or takes off a coat) switches `costume_ids` only from the first shot where the novel or script shows it, and from that shot uses the new clothing ID. A **story state** (injured, dirty, wet, exhausted) is an overlay on the same costume: keep the current `costume_ids` and write the state as words after the clothing ID; bind a state image only when an approved one that matches the novel exists (listed in the trajectory table), and never bind a state image that does not match (a slap gives a red swollen cheek and blood at the mouth, not scratches) — words are better than a wrong image. A prop-holding variant (e.g. "holding the bouquet") is not a costume change: keep the costume and bind the prop. Read the costume-state trajectory table when one exists.
12. **Gaze lock when three or more people are on screen and someone speaks to a person who is not the lead:** `Gaze lock: whenever <A> speaks to <B> or listens to him, her eyes stay on <B>'s face and her head, shoulders and upper body are turned toward him; she never looks at <C> and never looks into the camera lens.` Add where B is on screen (screen side, standing or sitting) from the blocking.
13. **Voice references:** every voice IC attaches gets its own reference line, `__MINIMAX_H3_REF_k__ is <name>'s voice (Sx)`, with Sx in speaking order inside this shot (see Output Rules). A voice reference with no definition line is a duplicate-person risk.
14. **Scene lock:** the first body sentence names the location and two or more visible landmarks. A close-up with a blurred background still names one or two landmarks that remain recognisable in the blur. Use one negation only: `never a plain grey wall or a photo-studio backdrop`. IC always orders references as characters, then scenes, then props. Keep the scene reference early: do not bind background extras who are not needed (or bind a cropped single image, not a grey multi-view board), crop prop images, and never replace a detailed scene image with a rougher one.

#### 第2、3集通过后转正：**Face-state lock follows the story (TR-V01).** A visible story state on the face (tiredness, puffy eyelids, eye bags, a fresh look after a win) has a start beat and an end beat from the novel. Before the end beat every shot of that character writes the state; from the end beat on every shot writes the new state and binds the matching state image if an approved one exists. Never write the state in only some shots. Write the state by shape and degree only, never by colour or darkness words around the eyes (manual M50 item 2). Wrong: the tired face written in #3 and #9 only. Right: `<name>'s lower eyelids are puffy and swollen, with clear eye bags.` in every shot before the beat; `<name>'s face is fresh and rested; the lower eyelids are smooth.` in every shot after it.

#### 第2、3集通过后转正：**Prop size lock (TR-V03).** A prop whose reference is a multi-view or a sized sheet gets one fixed real-world size sentence in every shot it appears in: `The <prop> is <real-world size copied from the prop asset sheet> and it never grows or shrinks.`

#### 第2、3集通过后转正：**Adjacent-shot position lock (TR-V10).** Every shot of a scene states who is on which side of whom (also after a push, pull or hug). Only for two shots in the same scene where the action is continuous does the next shot open with `The characters keep the same left-right positions as in the previous shot.` followed by who is on which side. After a camera change, a jump cut or a time skip, write only who is on which side of whom in the new framing. Describe people's positions only; never write a sentence that locks the camera or the frame to the previous shot. Right (continuous push): #12 opens `The characters keep the same left-right positions as in the previous shot: Han Zixiao stays on screen-left of Jiang Che.` Right (#13 cuts to the reverse angle): `Han Zixiao is on Jiang Che's right, between him and the door.` Wrong: opening #13 with a sentence that ties its camera to the last frame of #12.

#### 第2、3集通过后转正：**Every shot binds a scene (TR-V12).** `scene_ids` is never empty; the gate already stops an empty `scene_ids` as an error (SCENE_UNBOUND). Same-scene shots share one scene sentence (see item 14 "Scene lock" in the section "Same-scene presence and costume lock — 同场在场人物入画 + 服装锁" above).

#### **Hand props: write where the prop stays and where it never goes.** When a character holds anything that could go to the face (cup, glass, bottle, can, phone, cigarette, food, chopsticks), write its position for the whole shot, e.g. `she holds the cup at chest level the whole time; it never goes to her mouth`. If the story needs a sip or a call, write the exact second it is raised and when it comes down, and keep the mouth clear during any `<d>` line (see the dialogue-window section).

#### **No glasses unless the story gives a reason.** Write `no glasses` into each character's lock (the look / costume lock sentence). A character who wears glasses by design keeps the same pair in every shot (`wears the thin black-rimmed glasses from his reference`); glasses never appear, disappear or change mid-shot.

### 【待测】【分镜】【提示词】人物身份：小角色也写服装 ID 和性别（G01、G02，人物一致性）

每个绑定的具名人物（包括中介、经理、同学、邻桌客人这类小角色，包括背影和虚焦里的人），定义句都写服装 ID（颜色＋衣物＋发型，照抄绑定的服装资产），并带一个性别词（a man / a woman），同章同场逐字一致；不能只写「名字，职业」（只写名字时中介被画成了女的）。按 h3-prompt-writing 的 R22，定义句不写脸、年龄、材质、配饰描写（T9 G01 草案里的「大致年龄」不采用）。主角和反复出现的角色，每镜加一句身份锁：同一个人、每镜同一张脸、性别不变、发型不变（句式同 h3-prompt-writing 同场节第 8 条的「a different man with a different face」写法）；人设没有的配饰（眼镜等）写明不戴。不写会改脸的特写（青筋暴起、疤），除非剧情要、而且有状态图。
本段校验码：F711D06E

