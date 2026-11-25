---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. Also covers storyboard-contract driven multi-segment generation: drafting a storyboard.json from a novel/script with a local or remote LLM, then compiling it into consistent per-segment H3 prompts (Ref2VA/T2VA first segment + FL2VA continuations) with no repeated segments and no positional or identity drift.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---
<!-- rulebook:generated rules-22516d023c 本文件由 M\工具\rulebook_build.py 从 src/ 生成，不要手改 -->

## 地图（写视频提示词）：使用方法

1. 先读本地图和下面的基础规则（到本文件「基础规则结束」那一行为止）。改编（剧本、分镜）规则在 adapt-rules，写提示词时不读。
2. 只读当前步骤要用的分册：按下表的行号，调用 `skill_lines(h3-prompt-writing, 起行, 止行)` 读那一段；用不到的分册不读。写提示词时，IC 在每镜 brief 的 `required_ranges` 里列出本镜要读的段，照单读。
3. 拿不准、遇到新情况、或觉得「应该这样写」时，先回本地图查；有规则一律以规则为准。
4. 查过确实没有规则，才凭判断做，并调用 `report_rule_gap` 登记（什么情况、怎么做的、为什么），不自己编一套固定写法。
5. 每段最后一行是「本段校验码」。保存时把读过各段的校验码放进 `ranges_ack`，IC 核对，对不上不收。
6. 一镜要读的分册超过 40,000 字（brief 里 `too_dense`），说明这一镜太满：不写，报回分镜层拆成两镜（各 7–8 秒），不删规则。

| 段 | 内容 | 层级 | 行号 | 什么时候读 |
|---|---|---|---|---|
| A | A 铁律与流程 | 基础（已在上面，必读） | L39–L67 | 每次 |
| B | B 提示词格式与标签 | 基础（已在上面，必读） | L69–L124 | 每次 |
| C | C 心声 | 基础（已在上面，必读） | L126–L177 | 每次 |
| D | D 系统声与光幕 | 基础（已在上面，必读） | L179–L196 | 每次 |
| F | F 一致性（人物、服装、场景、道具、站位、人数） | 基础（已在上面，必读） | L198–L234 | 每次 |
| C2 | C2 心声闭嘴嘴形表 | 分册 | L239–L261 | 有心声 |
| E | E 人声与台词 | 分册 | L263–L360 | 有台词 |
| FX | F9 一致性细则（待测：前景半截头肩、机位景别、座位姿态、桌面道具、背景人群、视线、开场状态句、关键道具） | 分册 | L362–L397 | 两人及以上、有道具、桌面、车、绑了场景 |
| F5V | F5 多人同场多视角定义图（_MV） | 分册 | L399–L413 | 两人及以上 |
| H1 | H1 镜头、运镜与打戏节奏 | 分册 | L415–L462 | 有运镜、动作、打戏 |
| H2 | H2 Q 版、特效、流行语与谐音（冷门） | 分册 | L464–L534 | 本镜用到 Q 版、特效、流行语、谐音或段子（分镜有【表现】行） |
| H2G | H2G 开场画面与光幕位置（每镜必读） | 分册 | L536–L548 | 每次 |
| J | J 资产与绑定 | 分册 | L550–L594 | 绑定、参考图有疑问、绑了场景 |
| L | L 现实逻辑与剧情 | 分册 | L596–L624 | 有交易、冲突、回忆 |
| B2 | B2 生成模式、全参考与多段（冷门） | 分册 | L626–L667 | 用到时再查 |
| Q | Q 审片 | 分册 | L669–L794 | 用到时再查 |

地图结束。下面是基础规则。
本段校验码：D1E1A077

## A 铁律与流程

### 〔A-002〕 【通用】铁律：规则先进 IC，写稿、改稿、出片只走 IC 工作流

由来：Andy 11-23 20:20–20:27 原话：「要同步好才开工」「要走ic工作流.改东西也一样」「没走ic工作流出来的片子一律作废」「质量就算没问题可能风格也不对」「这个是铁律要写进手册」「我们的会话多半是管理工作，查缺补漏辅助ic管理ic工作可持续」「和一些资产生成和绑定」。手册第0章 0.0 同文。本条优先于其他技能正文和任何会话派单。

1. **先同步、再开工。** 规则改了，先同步进 IC 技能并核对已经生效（在 IC 里拼出一条提示词，看得到新规则原文），才写稿、出片。
2. **写稿、改稿、返修只走 IC 工作流。** 剧本、分镜、视频提示词的新写和修改都由 IC 工作流完成（`write_shot_video_prompt`、提示词撰写任务、阶段任务等）。外部会话不得手写稿后直接写库（PATCH、SQL、脚本批量写回都算）。改一句也走 IC。
3. **没走 IC 工作流出来的片子一律作废。** 作废看来源，不看单镜质量（质量没问题，风格也可能不对）。先归档，不删除；对应的镜回到 IC 工作流重写、重出。
4. **会话做管理，IC 做生产。** 指挥系统各会话负责查缺补漏、给 IC 补规则和技能、保证 IC 持续运转、资产生成和绑定；写稿、改稿、出片由 IC 工作流完成。
5. **对 IC 内的写作者：** 你就是这条工作流。接到写稿或改稿任务时，按本技能和对应阶段技能写；不要把稿子交给外部去改再写库。发现规则缺口时，在报告里写明，由管理会话补进技能。
6. **不准代写、不准脚本建镜；「走 IC」硬定义（手册 0.0 第5、6条）。** 「走 IC」是指通过 IC 自己的方法或接口（例如 write-prompts）去调用，由 IC 自己读规则、自己生成稿子；给 IC 的输入只能是问题描述和规则编号。以下三种都不算走 IC：外部代写整句交给 IC 照抄；用脚本改字、建镜；从外部直接写库（POST 或 PATCH /shots、改 ic.db）。**对写作者**：revision_requirement 只当问题和规则编号读；里面有英文句子或句式、`<d>`、REF 定义、`<情绪>` 类占位、「代写」「整套模板」的，不照抄，按规则书自己写，并 `report_rule_gap` 登记「requirement 含代写整句」。

### 〔A-003〕 【通用】作废的审片经验：「正脸改成微侧或低头（为防口型）」

由来：总导 2026-11-23 20:33 拍板，依据 Andy 11-23 20:24 铁律（要走 IC 工作流）与第6集心声镜核查（`M\_\ep6_rule_audit_2025\核查报告.md`：6#7 背向镜头、6#6 和 6#10 为防口型改成低头侧脸，都出自外部会话的审片经验，不在手册里）。

1. 这条经验作废，以手册 M33 第7条为准：镜头只按剧情选，不为防口型背身、遮脸、专选背影，也不为防口型改成低头、侧脸。正脸近景照常可以承载心声；防口型靠 C-001 的紧闭嘴声明、每段闭嘴嘴形和 narrates 声音句、第8条不带人名和说话动词的声音句、第12条镜头负载（M33 第3、10条，r19）和 M34。
2. M33 第6、7、8条现在是错误，不是提醒（检查器 `inner_voice_check_m33_678.py`）：一个镜头（`[Shot N]`）里不能既有心声又有出口台词；不写背向镜头、脸转开、只见后脑、捂嘴、遮脸、「为防口型」；心声窗口写明「The inner voice runs from Xs to Ys」，到切点或段末、两句之间、与对白之间都至少 0.8 秒。

### 〔A-005〕 【通用】文案问题提前解决，出片链不等稿

剧本、分镜、提示词、修改要求、服装描述的问题都在出片前由 IC 工作流改好（管理会话提前开新会话，按集或按段并发），过门禁后用 `--after` 进出片链；GPU 不等稿。写提示词时发现本镜文案与原著或绑定对不上，在报告里写明。

### 〔A-004〕 【通用】三处同改，作废不删除

1. **三处同改（TR-V18 已并进 h3-prompt-writing「Visual follows the prompt」节）。** 改镜头写法（景别、机位、站位、动作、台词）时，`visual`、`camera`、`sub_shots`、`video_prompt` 一起改；只改一处，渲染出来的还是旧的。台词改动同时改 `dialogue`、`<d>`、`sub_shots`。
2. **看不懂的镜作废，不删除（TR-V11）。** 观众看不懂的镜（没交代的回忆、莫名其妙的一拍）标作废（retire），不删；作废后，下一镜按「相邻镜站位」（TR-V10；提示词套见 F 段，改编套见 S 段）重新接上上一镜的结尾站位。
本段校验码：8AF4F0CB

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
- **Character appearance: write only the clothing ID, never a look description (R22, rewritten 2026-11-23 rulepack-lock-20261123; 总导 2026-11-23 03:36 批准)**: a character's image reference carries the face, age, hair texture, skin, build, fabric, materials, shoes, accessories and trims, so the prompt never describes them. (1) **Reference line = who, not what they look like:** write character name + role/identity, e.g. `__MINIMAX_H3_REF_1__ is Ye Xueji's spirit body`; never add age, facial features, face shape, skin, build, materials, shoes, accessories or trims. (2) **When to write the clothing ID:** write one short clothing ID — colour + main garment + hair, e.g. `grey-blue short-sleeved T-shirt, dark grey trousers, short black hair` — for each bound character (a) in every shot with two or more people on screen, (b) in every shot, solo shots included, of a scene where any shot has two or more people on screen, and (c) whenever the story puts the character in a state the bound image does not show (injury, dirt, wet, exhaustion): add that state as words after the clothing ID, e.g. `right cheek red and swollen, a trace of blood at the mouth corner`. A solo shot in a scene that only ever has one person writes no clothing ID. (3) **Where the words come from:** copy the clothing ID from the bound costume asset (or the character asset when no costume is bound) and from the costume-state trajectory table when one exists; keep it word-for-word identical in every shot of the scene until the story changes the costume (see *Same-scene presence and costume lock* items 2, 4 and 11). Write it in the reference line or the headcount lock sentence, never as a separate appearance paragraph. (4) **Never** write `keep the look of __MINIMAX_H3_REF_N__`, `keep the look of each reference`, `stay faithful to the reference image` or any similar sentence (these make the shot drift into the reference image at its end); end the prompt with the live-scene lock instead, e.g. `The last frame is still the live <scene> scene.` (5) If the task input supplies a character's look (asset description, character bible, continuity notes, 「角色一致性」 line), take only the clothing ID out of it under (2)–(3); do not copy anything else. This rule overrides the `keeps the look of <Picture N>` advice in references/ref-en.txt. Scenes, props and environments are not covered by this rule — describe them normally.
- **Make every character action emotion-driven and physically specific**: never write only inert/still verbs (stands / sits / walks / looks) with no force. State the action's intensity, speed, and body language so the motion has visible energy (e.g. `slams the table`, `paces frantically`, `clenches his fists`, `leans in intensely`, `snatches the letter`, `stumbles back breathless`) — and keep the action consistent with that line's emotion. Static characters plus a monotonous read come across as lazy; give each beat visible, purposeful movement. **Inner-monologue exception:** in an OS block the force goes into the eyes, brows, head, hands and body only — never into the mouth (see “Inner-Monologue (OS / 心声) Shots”).
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
- **Speaker IDs follow the speaking order inside this shot**: each IC shot is its own video, and H3 gives `(S1)` to the first voice heard in it and `(S2)` to the next new voice (`references/ref-en.txt` §5.4). So the first voice in this shot, OS included, is `(S1)`; never fix an ID for the whole chapter. The voice-reference line uses the same ID as that character's lines, whatever its REF number (`__MINIMAX_H3_REF_4__ is Jiang Che's voice (S2)` is fine); in the OS fixed sentences `(S1)` means the OS speaker's ID in this shot. Jobs 70f12d2f shot 17 and 231e6bc2 shots 1–2 tagged the shop owner, who spoke first, `(S2)`: both voices came out swapped.

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
本段校验码：5B10EA48

## C 心声

### 〔C-001〕 Inner-Monologue (OS / 心声) Shots — hard rule (r19 rewrite 2026-11-24, Andy 18:34–18:48; template = the Han Zhicheng inner-voice shot Andy approved)

An inner-monologue line is a character's silent thought heard as voice-over. The character on screen must **never** move their lips for it. H3 lip-syncs any `<d>` line to whoever looks like the speaker unless the prompt makes the closed mouth explicit, so follow these rules exactly whenever a shot contains an inner-monologue line.
**Void (r19):** the 17:25 version of rule 8 (`<Name> (S1) … says in an off-screen voiceover`): name + `says` binds the voice to the visible person. The template is the V2 6#3 (1D5C7A14) sentence `An off-screen male inner-monologue voice (S1), <emotion>, <pace>, <timbre> narrates <d>…</d>.` (rule 8).

**1. How to recognise an OS line.** A dialogue/sub-shot line is inner monologue when the speaker label carries `（OS）` / `(OS)` / `（内心）` / `（心声）` / `（内心独白）`, or the shot text says 内心独白 / 心声 / inner voice / inner monologue for that line. Phone voices, the system voice 系统 and the narrator 旁白 are not OS (see their own sections).

**2. Shot structure (best case; the storyboard stage should already deliver it).** (IC 947e856, the rule version of episodes 1–5; aligned 2026-11-25 dea54623)
- Consecutive OS lines in the same scene (nobody else speaks between them) go in one shot, shot ≤ 15 s. The OS shot has no spoken line from anyone (no dialogue, no phone voice, no system voice).
- Several OS lines in one shot are the normal case. If spoken lines are mixed in, the OS lines are still written as voice in the prompt and generated by H3: each OS line uses the fixed OS sentence of rule 8 with its `<d>`, word for word the same as the shot's `dialogue` field (see E-004 in section E (人声与台词), revised 2026-11-22; the old “OS goes to post” rule is void). Do not drop any line or rewrite two lines into one. Write it as follows: give each OS line its own time block, written as closed-mouth acting; keep the OS speaker's face and closed mouth visible in every OS block; put any spoken line in its own block **before or after** the OS blocks, never interleaved, and end that block with the speaker's mouth closing. Keep a ≥ 0.5 s silent beat between blocks.

**3. Shot declaration and mouth shape — copy verbatim, only fill the `<…>` slots (IC 4690428 old method, restored 2026-11-24 main seq1320).**
- Shot declaration (once, right after the style/subject lines): `Inner-monologue shot for <Name>: nobody on screen speaks aloud. <Name>'s lips stay pressed tightly shut for the whole shot and never part; teeth never visible; he never sighs, gasps, laughs, grins or breathes through his mouth; all emotion shows in his eyes, brows, head and hands.` (use she/her for a female speaker.)
- Mouth shape (once per OS block): `Mouth shape: <closed-mouth phrase from the table below>.`

**5. Expression must match the meaning of the line.** First decide the line's emotion from what it says, then take the matching row. All mouth shapes are closed, no teeth. Adjacent OS lines (in the same shot and in neighbouring shots) must use different mouth shapes and change at least one of eyes / brows / head / hands; never pick a shape that contradicts the line just to vary it. Rows 11 and 16 only in a subtle version, rarely. The table is section C2 (loaded for every OS shot).

**4. Banned inside any OS block** (they open the mouth): grin, laugh, chuckle, giggle, smile showing teeth, sigh, gasp, pant, huff, exhale through the mouth, sucks in a gasp, mutter, murmur, whisper, mouths, says, tells, replies, answers, talks, exclaims, shouts, yells, cries out, blurts, says aloud, speaks, jaw drops, mouth falls/hangs open, lips part, half-open mouth, bares teeth, bites his lip, sips/drinks, eats. Describe the voice with adjectives (tense, hushed, rapid, rising, trembling, low, bright, biting, almost breaking), never with speech-act verbs. The only verb the off-screen voice gets is `narrates`, and its subject is always `An off-screen male/female inner-monologue voice (S1)`, never the character's name.(IC 4690428 old method, restored 2026-11-24 main seq1320)

**5. Emotion through concrete eye, eyelid and hand actions; 2–3 actions per window (M34 rules 2–3).** Write what the camera sees, like the approved shot: `his pointing right hand hangs frozen in mid-air, eyes round behind his glasses, one eyelid twitching`; `his eyeballs dart left and right, his brows knot together and his right hand slowly sinks`. Choose from: gaze darts / narrows / widens, an eyelid twitches or droops, brows knot / lift, a small nod / shake / tilt, shoulders drop / square, a hand freezes, tightens, sinks or rests. Match the line; neighbouring OS lines change at least one of them. After the window, write the start point (something visible) and the end point `保持到镜头结束 / until the last frame` (M34 rule 4). A shot that is only voice-over gets a visible action chain with a new visible change at least every 3 s; no staring, sitting still or waiting to fill time (M34 rule 5).

**6. No eating, food, chopsticks, spoon, cup or drink actions during an OS window.** Inside an OS window the hands do not pick up, peel, turn, lift or bring food, chopsticks, a spoon, a cup or a glass anywhere; nothing goes toward the face. If the story needs eating or drinking, put it in a time block that does not overlap the OS window, or let the hands rest still (on the table / out of frame). Story props that stay away from the face (a phone held at chest level, a document) are fine.

**7. Framing.** For every OS block: frontal or near-frontal (within ±30°) close-up or medium close-up of the OS speaker, face and mouth clearly visible in the centre of frame, camera steady or a slow push-in. This overrides any general preference for angled/side views. Do not hide the mouth (no hand over mouth, no back to camera, no wide shot, no head bowed, no cup at the lips) — the closed mouth must be visible. Anyone else in frame stays silent with a closed mouth and is in the background, out of focus or in profile. (IC 4690428 old method, restored 2026-11-24 main seq1320)

**8. Fixed voice sentences — copy verbatim, only fill the `<…>` slots (IC 4690428 old method, restored 2026-11-24 main seq1320).**
- Voice reference line: `__MINIMAX_H3_REF_n__ is <Name>'s voice (S1), used only as an off-screen inner voice-over, not spoken by anyone on screen.`
- Each OS line: `An off-screen male inner-monologue voice (S1), <emotion>, <pace>, <voice quality>, narrates <d>[Chinese] <original line, unchanged></d>. Nobody on screen is speaking; <Name> only listens to his own thoughts with his lips closed.` (use `female` / `her` for a female speaker.)
- **Inner-voice (OS) shots: lips closed throughout, no mouthing.** Besides the official `while his lips remain completely closed`, write `his lips stay closed throughout the shot; he does not mouth the words` for every OS line. The face may react (eyes, brows, breath); the mouth never moves in time with the voice. (IC 947e856 “Inner voice, hand props and glasses” rule 1)
- No name, no `<Subject k>` before `(Sx)`; the only verb is `narrates` (never `says`, `in an off-screen voiceover`).
- Emotion turn inside one line: `at <t>s his expression shifts to <emotion B>, mouth still closed: <mouth phrase B>.`

**9. OS while the character is on the phone.** He is listening: `<Name> is listening, phone held at his ear, not talking; the person on the other end is the one heard.` Add one listening reaction with the eyes, brows, head or free hand (`his brows knit as he listens`, `a slow small nod`). Do not use `call`, `phone call`, `phone conversation`, `on a call with`, `talking into the phone`, `answers`, `replies`, `responds`, `argues`, `chats`, `conversation`. Rules 3–7 still apply.

**10. Energy rules apply to the voice and to eyes, eyelids, brows, head, shoulders and hands only** — never to the mouth or breath. **No ledger words** anywhere in the prompt (`台词：无`, `无对白`, `（沉默）`, `（内心）`, `OS`, `心声`): H3 reads them aloud. Inside `<d>` only the language tag and the original words. `summary` only says whose inner voice sounds, never its content; never write 默念 / 在心里说 / 独白 / 开口 / 嘴唇动了动 (M33 rule 9; X33).

**11. Self-check before returning the prompt.** (IC 947e856 rule 9; aligned 2026-11-25 dea54623) Every OS line of the shot's `dialogue` field appears in the prompt as a `<d>` line, word for word, in mixed shots too (see E-004); every OS line uses the fixed sentence of rule 8 (`An off-screen male/female inner-monologue voice (S1), … narrates <d>…</d>. Nobody on screen is speaking; <Name> only listens to his/her own thoughts with his/her lips closed.`); the character's name never appears in the same sentence as says/speaks/talks/narrates or right before `(S1)`; phone shots follow rule 9 (listening, no call/conversation/answering words); the shot declaration is present; each OS block has a frontal close-up and one mouth-shape phrase that matches the line; no banned word from rule 4 appears in an OS block; no Chinese ledger words outside `<d>`; the first voice in the shot is `(S1)` and each voice-reference line uses that character's ID.

**12. Shot load (M33 rule 10, r19; rate r19b).** One thinker per shot: only one person's inner voice. Rate of each line = `<d>` characters without punctuation ÷ its `runs from` seconds (English counts syllables): above 6/s is an error, gate blocks; above 5 up to 6/s (6.0 included) is a warning, passes (Andy 20:08). Too fast: longer window or ask the storyboard layer to split the shot; never speed up or cut `<d>` words.

#### 〔C-002〕 第2、3集通过后转正：**Inner voice runs over action and stays short (TR-V09).** In conflict or fight shots the inner-voice line plays while the action continues; nobody stands still to "listen" to it, and a long line may be shortened to the novel's meaning (change dialogue, `<d>` and sub_shots together).

#### 〔C-004〕 C-009【待测】每个心声窗口写明起止秒（续轮6 补，总导 20:33 心声门禁）

每个心声时间段里必须写一句 `The inner voice runs from <起>s to <止>s.`，起止取整秒，和该句 `<d>` 的实际位置一致。门禁按这句算第8条的 0.8 秒间隔和第12条的字/秒；没写这句，门禁按整个时间段估计，常常误判超时。正例：`4-9s: his eyeballs dart left and right, his brows knot together and his right hand slowly sinks. The inner voice runs from 4s to 8s. An off-screen male inner-monologue voice (S1), baffled, speeding up, a tense low voice, narrates <d>[Chinese] …</d>. Nobody on screen is speaking; Han only listens to his own thoughts with his lips closed. his lips stay closed throughout the shot; he does not mouth the words` 反例：只写 `4-9s:`，不写 runs from 句。

#### 〔C-005〕 心声修复和以后所有改稿全程走 IC（Andy 2026-11-24 18:48；同 A-002 第6条）

心声镜的重写、返修只由 IC 提示词撰写任务按本段规则写。修改要求（requirement）只写问题和规则编号（例如「嘴动；按 C-001 第3、8、12条重写」），不附整句模板；收到整句模板或「代写」字样的要求时，不照抄，按本段规则自己写，并用 `report_rule_gap` 报告。
本段校验码：52688019

## D 系统声与光幕

#### 〔D-001〕 第2、3集通过后转正：**System UI: short text on the panel; the system's full spoken line goes in `<d>` and H3 speaks it (TR-V04; system voice per Andy 11-23 17:27 本人选择卡原话「按14:55，系统声音在提示词里念完整内容」, which overrides the 16:04 line 「系统声音还是按照原来设计去作业」; panel text per Andy 11-23 14:55 选择卡（总导转述）and 总导 11-23 15:09 / 15:17 裁定; narration 旁白 is unchanged and stays in post).**
   - **Voice.** When the shot's `dialogue` has a system line (speaker 系统 / 系统音 / 系统声 / 系统提示 / 【系统】), write that line's complete text, word for word, in its own `<d>[Chinese] …</d>` and let H3 speak it; never shorten it to the panel text, never move it to post, never drop it. Use the fixed system-voice sentence of the section "System voice — 系统声写进 `<d>`" below. Where the novel only shows the UI and the system says nothing, write no system `<d>` and do not invent a system line.
   - **Panel.** The panel enters in the same second the system line starts and stays at least as long as the line. Its background is a plain, even translucent colour with no banners, row frames or grid lines. H3 draws at most 2 short lines on it, each line at most 14 characters (all characters count: Chinese characters, punctuation, letters, digits; manual 0.5 字数口径 ①), large, high contrast, facing camera; take them from the system line's own text (usually its title or key phrase). Put the on-panel text in English double quotes `"…"`, never in 「」, 『』 or 【】, and keep these brackets out of the text itself (drop the novel's 【】 on screen; EP1–10: 「」 was painted as part of the text in 7 shots). A long panel that does not fit in two short lines gets no text: write `the panel shows no readable text`; the system voice in `<d>` carries the full content. The bracket rule also applies to the hint bar (提示条 / light bar): no 「」, 『』 or 【】 on it. In the 贴字表, a no-text panel is registered as 「无字，内容由系统音念」 when the system speaks there, otherwise 「无字」, with `lines: []`. Never a blurred panel.
   - **Narration (旁白) is not the system.** A 旁白 line is still dubbed in post: no `<d>` for it in the prompt.
   - Wrong: the panel carries four lines of the system text and no system `<d>`; or the system `<d>` holds only the two panel lines; or a `<d>` is invented for a UI the novel never voices. Right: panel `"交易成功"` / `"获得灵气 +10"`, and `An unseen synthetic system voice (S2) …, says <d>[Chinese] 交易成功，获得灵气+10，当前修为……</d>` with the full original line.
   -

### 〔D-002〕 System voice — 系统声写进 `<d>`，由 H3 直出

1. **Who.** A dialogue line whose speaker, with brackets removed, is 系统 / 系统音 / 系统声 / 系统提示 / 系统提示音 / 系统女声 / 系统男声 is a system line. 「系统面板：」 or 「江澈（系统）：」 are not system lines.
2. **Fixed sentence (one per series, copied word for word every time; manual M30 item 1 example).** `An unseen synthetic system voice (Sx) that belongs to no one in the frame, a calm, clear, neutral young female synthetic voice with a faint electronic edge, speaking at a moderate pace, says <d>[Chinese] <complete system line, unchanged></d>.` If the shot binds a system-voice audio asset, add `in the same voice referenced from __MINIMAX_H3_REF_N__` after `pace,`. Never give the system a character's voice reference; never write `<Name> says` for it.
3. **Timing.** The panel (or hint bar) appears in the same second the system `<d>` starts and stays until it ends. The system voice is an off-screen voice, so handbook M33 rule 6 applies: the camera shot (`[Shot N]`) that carries it has no spoken line; spoken lines go in another camera shot after a hard cut, ≥ 0.8 s (in practice ≥ 1 s) away (see "One kind of voice per camera shot" below). It may overlap the listener's action. Speaker IDs follow the order the voices are first heard.
4. **The listener.** Everyone visible keeps the mouth closed while the system speaks: write `<Listener> listens with his lips closed.` (IC 947e856 listener sentence) and act with eyes / brows / head only; no mouth or breath words.
5. **Panel text** follows TR-V04 (the "System UI: short text on the panel" item at the top of this section D): ≤ 2 short lines, ≤ 14 characters each, English quotes, taken from the system line.
6. **Not in scope.** Narration 旁白 and broadcast-style narrators are not changed by this rule; 旁白 stays in post. The workflow manual package r81 that carries the same change is still under review; this section is the IC side only.
本段校验码：0C01EF81

## F 一致性（人物、服装、场景、道具、站位、人数）

### 〔F-001〕 Same-scene presence and costume lock — 同场在场人物入画 + 服装锁

H3 only draws people who have a reference and are named in the prompt, and it freely swaps faces and clothes between references. A1 QC lost people and mixed clothes in 7 shots: 5-1 #8/#10/#12 and 19-2 #18 / 20-1 #5 (a seated table-mate was left out of `character_ids` because he had no line, so he vanished), 16-R-V1 #18 (the lead in a crowded wide shot was drawn in another character's dark green shirt), 17-2 #22 (the host got the side-table classmate's orange polo), 20-2 #27 (the speaker was written as "squeezing in from behind", so H3 put the wrong man in the centre and gave him the line). For every shot with two or more people:

1. **Everyone the storyboard places in frame is a reference and is named.** If the scene's blocking map / whiteboard puts a present character inside this framing (edge of frame, soft-focus foreground, back view included), that character must be in the shot's references and must be written into the 0s opening with screen side, facing and state (`lips closed` if silent; in a shot that overlaps an inner-voice window keep their lips closed as in C-001 rule 7, never other mouth words). Never drop a present character just because he has no line. If the framing really excludes him, say where he is (`off screen-left`).
2. **Write a clothing ID for each person (R22 (2))** in `subject_definitions` and again in the 0s opening: colour + garment + hair, copied from the bound costume asset (`__MINIMAX_H3_REF_2__ is Han Zixiao: dark green long-sleeve shirt, slicked-back black hair`). A story state that the bound image does not show is added as words after the ID (`right cheek red and swollen`), see item 11. `fully_preserved` alone is not enough. Only the clothing ID: no faces, ages, materials or accessories. **Asset match (Andy 2026-11-24, 待测):** top, bottom, outerwear and shoes keep the asset's garment type and main colour (asset knee-length shorts → `knee-length shorts`, never `trousers`, `pants` or `jeans`); never add a garment the asset lacks. If the storyboard `visual` disagrees with the asset, write the asset and report the mismatch so `visual` is fixed too; gate COSTUME_ASSET_MISMATCH_PROMPT.
3. **Add the lock sentence** whenever two people could be confused (same sex, similar age, strongly contrasting clothes): `Each person's face and clothing come only from his or her own reference; never move one person's clothing onto another person. Exactly one person in the frame wears <garment>.`
4. **Costume inheritance.** Inside one scene and continuous time, a character keeps the costume reference he wore in the previous shots of that scene (same `costume_ids`) until the story shows a costume change (item 11). Write the same clothing ID, word for word, in every shot; a story state (injury, dirt) is added to it as words and does not by itself change `costume_ids`.
5. **The speaker is already in place at 0s.** Do not make the speaking character "enter / squeeze in / push to the centre" to take his speaking position; put him there from the first frame and state `only <clothing ID> moves his mouth; <others> keep their lips closed` (in a shot that also has an inner-voice window, the silent people stay silent with a closed mouth as in C-001 rule 7).
6. **Wide and crowd shots:** the named leads are at least medium size or in the foreground, with their clothing IDs; extras are described as "other guests" and must not wear a lead's colour.
7. **Who does the action comes from the novel/script, not from a similar-looking extra.** If the visual line names a character (e.g. "支架青年 deletes the clip"), the reference bound for that action must be that character; flag the shot if the binding names someone else.
8. **Headcount lock in every multi-person shot:** besides the count in the first sentence, write once in the body: `Exactly <N> people are in this shot and each of them appears only once: <A> (__MINIMAX_H3_REF_a__) in <clothing ID>; <B> (__MINIMAX_H3_REF_b__), a different man with a different face, <clothing ID>, never in <A's garment>. There is never a second <A> or any look-alike of him in the frame.` N counts only people on screen (voice-only and off-screen people are named as off screen).
9. **No limb without an owner, no second copy of anyone:** every body part at the frame edge or in the foreground belongs to a named, bound person on screen (name the owner, e.g. `Han Zixiao's half-cropped head and right shoulder at the screen-left edge`; never as an over-the-shoulder or foreground-shoulder phrase, which the no-over-the-shoulder rule (section E, "Faceless speaker" item 3) and the gate r71 OFF_OTS_BANNED reject; never use the lead as that half-cropped edge figure while he is also elsewhere in the frame, see ic-lessons TR-B09; examples changed 2026-11-23 IC规则同步 because the old ones conflicted with that rule). Never write a shoulder, arm, hand or back of a head that has no owner in the story, and never a second copy of anyone: `No stray shoulder, hand or arm without an owner enters the frame, and nobody appears twice.` A shoulder-only person with no owner at the edge was drawn as a second lead in ch3 #13. This item does not decide whether an over-the-shoulder framing is allowed; that is section E "Faceless speaker" item 3 and the gate's own OFF_OTS_BANNED.
10. **Per-shot lock inside a scene:** items 2, 8 and 9 apply to every shot of the scene that binds the character, including solo shots, reaction shots and the last shots of the scene, not only the first ones.
11. **Costume change vs. story state:** inside a scene the costume reference and clothing ID stay the same. A **costume change** (changes clothes, puts on or takes off a coat) switches `costume_ids` only from the first shot where the novel or script shows it, and from that shot uses the new clothing ID. A **story state** (injured, dirty, wet, exhausted) is an overlay on the same costume: keep the current `costume_ids` and write the state as words after the clothing ID; bind a state image only when an approved one that matches the novel exists (listed in the trajectory table), and never bind a state image that does not match (a slap gives a red swollen cheek and blood at the mouth, not scratches) — words are better than a wrong image. A prop-holding variant (e.g. "holding the bouquet") is not a costume change: keep the costume and bind the prop. Read the costume-state trajectory table when one exists.
12. **Gaze lock when three or more people are on screen and someone speaks to a person who is not the lead:** `Gaze lock: whenever <A> speaks to <B> or listens to him, her eyes stay on <B>'s face and her head, shoulders and upper body are turned toward him; she never looks at <C> and never looks into the camera lens.` Add where B is on screen (screen side, standing or sitting) from the blocking.
13. **Voice references:** every voice IC attaches gets its own reference line, `__MINIMAX_H3_REF_k__ is <name>'s voice (Sx)`, with Sx in speaking order inside this shot (see Output Rules). A voice reference with no definition line is a duplicate-person risk.
14. **Scene lock:** the first body sentence names the location and two or more visible landmarks. A close-up with a blurred background still names one or two landmarks that remain recognisable in the blur. Use one negation only: `never a plain grey wall or a photo-studio backdrop`. IC always orders references as characters, then scenes, then props. Keep the scene reference early: do not bind background extras who are not needed (or bind a cropped single image, not a grey multi-view board), crop prop images, and never replace a detailed scene image with a rougher one.

#### 〔F-002〕 第2、3集通过后转正：**Face-state lock follows the story (TR-V01).** A visible story state on the face (tiredness, puffy eyelids, eye bags, a fresh look after a win) has a start beat and an end beat from the novel. Before the end beat every shot of that character writes the state; from the end beat on every shot writes the new state and binds the matching state image if an approved one exists. Never write the state in only some shots. Write the state by shape and degree only, never by colour or darkness words around the eyes (manual M50 item 2). Wrong: the tired face written in #3 and #9 only. Right: `<name>'s lower eyelids are puffy and swollen, with clear eye bags.` in every shot before the beat; `<name>'s face is fresh and rested; the lower eyelids are smooth.` in every shot after it.

#### 〔F-003〕 第2、3集通过后转正：**Prop size lock (TR-V03).** A prop whose reference is a multi-view or a sized sheet gets one fixed real-world size sentence in every shot it appears in: `The <prop> is <real-world size copied from the prop asset sheet> and it never grows or shrinks.`

#### 〔F-004〕 第2、3集通过后转正：**Adjacent-shot position lock (TR-V10).** Every shot of a scene states who is on which side of whom (also after a push, pull or hug). Only for two shots in the same scene where the action is continuous does the next shot open with `The characters keep the same left-right positions as in the previous shot.` followed by who is on which side. After a camera change, a jump cut or a time skip, write only who is on which side of whom in the new framing. Describe people's positions only; never write a sentence that locks the camera or the frame to the previous shot. Right (continuous push): #12 opens `The characters keep the same left-right positions as in the previous shot: Han Zixiao stays on screen-left of Jiang Che.` Right (#13 cuts to the reverse angle): `Han Zixiao is on Jiang Che's right, between him and the door.` Wrong: opening #13 with a sentence that ties its camera to the last frame of #12.

#### 〔F-005〕 第2、3集通过后转正：**Every shot binds a scene (TR-V12).** `scene_ids` is never empty; the gate already stops an empty `scene_ids` as an error (SCENE_UNBOUND). Same-scene shots share one scene sentence (see item 14 "Scene lock" in the section "Same-scene presence and costume lock — 同场在场人物入画 + 服装锁" above).

#### 〔F-006〕 **Hand props: write where the prop stays and where it never goes.** When a character holds anything that could go to the face (cup, glass, bottle, can, phone, cigarette, food, chopsticks), write its position for the whole shot, e.g. `she holds the cup at chest level the whole time; it never goes to her mouth`. If the story needs a sip or a call, write the exact second it is raised and when it comes down, and keep the mouth clear during any `<d>` line (see the dialogue-window section).

#### 〔F-007〕 **No glasses unless the story gives a reason.** Write `no glasses` into each character's lock (the look / costume lock sentence). A character who wears glasses by design keeps the same pair in every shot (`wears the thin black-rimmed glasses from his reference`); glasses never appear, disappear or change mid-shot.

### 〔F-008〕 【待测】【分镜】【提示词】人物身份：小角色也写服装 ID 和性别（G01、G02，人物一致性）

每个绑定的具名人物（包括中介、经理、同学、邻桌客人这类小角色，包括背影和虚焦里的人），定义句都写服装 ID（颜色＋衣物＋发型，照抄绑定的服装资产），并带一个性别词（a man / a woman），同章同场逐字一致；不能只写「名字，职业」（只写名字时中介被画成了女的）。按 h3-prompt-writing 的 R22，定义句不写脸、年龄、材质、配饰描写（T9 G01 草案里的「大致年龄」不采用）。主角和反复出现的角色，每镜加一句身份锁：同一个人、每镜同一张脸、性别不变、发型不变（句式同 h3-prompt-writing 同场节第 8 条的「a different man with a different face」写法）；人设没有的配饰（眼镜等）写明不戴。不写会改脸的特写（青筋暴起、疤），除非剧情要、而且有状态图。
本段校验码：5C8B2593

