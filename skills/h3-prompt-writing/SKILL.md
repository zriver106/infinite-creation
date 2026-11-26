---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. Also covers storyboard-contract driven multi-segment generation: drafting a storyboard.json from a novel/script with a local or remote LLM, then compiling it into consistent per-segment H3 prompts (Ref2VA/T2VA first segment + FL2VA continuations) with no repeated segments and no positional or identity drift.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---
<!-- rulebook:generated rules-e1a18ccb94 本文件由 M\工具\rulebook_build.py 从 src/ 生成，不要手改 -->

## 地图（写视频提示词）：使用方法

1. 先读本地图和下面的基础规则（到本文件「基础规则结束」那一行为止）。改编（剧本、分镜）规则在 adapt-rules，写提示词时不读。
2. 只读当前步骤要用的分册：按下表的行号，调用 `skill_lines(h3-prompt-writing, 起行, 止行)` 读那一段；用不到的分册不读。写提示词时，IC 在每镜 brief 的 `required_ranges` 里列出本镜要读的段，照单读。
3. 拿不准、遇到新情况、或觉得「应该这样写」时，先回本地图查；有规则一律以规则为准。
4. 查过确实没有规则，才凭判断做，并调用 `report_rule_gap` 登记（什么情况、怎么做的、为什么），不自己编一套固定写法。
5. 每段最后一行是「本段校验码」。保存时把读过各段的校验码放进 `ranges_ack`，IC 核对，对不上不收。
6. 一镜要读的规则（基础+本镜分卷）合计超过 80,000 字（brief 里 `too_dense`），说明这一镜太满：不写，报回分镜层拆成两镜（各 7–8 秒），不删规则。

| 段 | 内容 | 层级 | 行号 | 什么时候读 |
|---|---|---|---|---|
| A | A 铁律与流程 | 基础（已在上面，必读） | L47–L100 | 每次 |
| B | B 提示词格式与标签 | 基础（已在上面，必读） | L102–L157 | 每次 |
| F | F 一致性（人物、服装、场景、道具、站位、人数） | 基础（已在上面，必读） | L159–L205 | 每次 |
| C | C 心声 | 分册 | L210–L261 | 有心声 |
| C2 | C2 心声闭嘴嘴形表 | 分册 | L263–L285 | 有心声 |
| D | D 系统声与光幕 | 分册 | L287–L304 | 每次 |
| E0 | E0 静默与人声背景（E-009、E-013） | 分册 | L306–L319 | 每次 |
| E | E 人声与台词 | 分册 | L321–L404 | 有台词 |
| E2 | E2 多人同镜（开口、视线） | 分册 | L406–L420 | 两人及以上、call |
| FX | F9 一致性细则（待测：前景半截头肩、机位景别、座位姿态、桌面道具、背景人群、视线、开场状态句、关键道具） | 分册 | L422–L479 | 两人及以上、有道具、桌面、车、绑了场景 |
| P | P 手机（FX-011、FX-012） | 分册 | L481–L501 | phone |
| PC | PC 通话声音（E-002、E-005） | 分册 | L503–L511 | call |
| F5V | F5 多人同场多视角定义图（_MV） | 分册 | L513–L528 | 两人及以上 |
| H1 | H1 镜头、运镜与打戏节奏 | 分册 | L530–L579 | 有运镜、动作、打戏 |
| H1W | H1W 行进中的戏与静态对话（H1-005） | 分册 | L581–L596 | walk |
| H2C | H2C 表现通用 | 分册 | L598–L607 | 有【表现】行 |
| H2 | H2 Q版与特效 | 分册 | L609–L669 | 【表现】Q版/特效 |
| H2L | H2L 流行语与谐音 | 分册 | L671–L683 | 【表现】流行语/谐音/段子 |
| H2G | H2G 开场画面与光幕位置（每镜必读） | 分册 | L685–L697 | 每次 |
| J | J 资产与绑定 | 分册 | L699–L743 | 绑定、参考图有疑问、绑了场景 |
| L | L 现实逻辑与剧情 | 分册 | L745–L774 | 有交易、冲突、回忆 |
| B2 | B2 生成模式、全参考与多段（冷门） | 分册 | L776–L817 | 用到时再查 |
| Q | Q 审片 | 分册 | L819–L945 | 用到时再查 |
| X | X 导出、合成与交付 | 分册 | L947–L1130 | 用到时再查 |

地图结束。下面是基础规则。
本段校验码：3AA3881B

## A 铁律与流程

### 〔A-002〕 【通用】铁律：规则先进 IC，写稿、改稿、出片只走 IC 工作流

由来：Andy 11-23 20:20–20:27 原话：「要同步好才开工」「要走ic工作流.改东西也一样」「没走ic工作流出来的片子一律作废」「质量就算没问题可能风格也不对」「这个是铁律要写进手册」（会话做管理见第4条）。手册第0章 0.0 同文。本条优先于其他技能正文和任何会话派单。

1. **先同步、再开工。** 规则改了，先同步进 IC 技能并核对已经生效（在 IC 里拼出一条提示词，看得到新规则原文），才写稿、出片。
2. **写稿、改稿、返修只走 IC 工作流。** 剧本、分镜、视频提示词的新写和修改都由 IC 工作流完成（`write_shot_video_prompt`、提示词撰写任务、阶段任务等）。外部会话不得手写稿后直接写库（PATCH、SQL、脚本批量写回都算）。改一句也走 IC。
3. **没走 IC 工作流出来的片子一律作废。** 作废看来源，不看单镜质量（质量没问题，风格也可能不对）。先归档，不删除；对应的镜回到 IC 工作流重写、重出。导出前由导出环节或管理会话按 X-011 核写入来源（写稿不做）。
4. **会话做管理，IC 做生产。** 指挥系统各会话负责查缺补漏、给 IC 补规则和技能、保证 IC 持续运转、资产生成和绑定；写稿、改稿、出片由 IC 工作流完成。
5. **对 IC 内的写作者：** 你就是这条工作流。接到写稿或改稿任务时，按本技能和对应阶段技能写；不要把稿子交给外部去改再写库。发现规则缺口时，在报告里写明，由管理会话补进技能。
6. **不准代写、不准脚本建镜；「走 IC」硬定义（手册 0.0 第5、6条）。** 「走 IC」是指通过 IC 自己的方法或接口（例如 write-prompts）去调用，由 IC 自己读规则、自己生成稿子；给 IC 的输入只能是问题描述和规则编号。以下三种都不算走 IC：外部代写整句交给 IC 照抄；用脚本改字、建镜；从外部直接写库（POST 或 PATCH /shots、改 ic.db）。**对写作者**：revision_requirement 只当问题和规则编号读；里面有英文句子或句式、`<d>`、REF 定义、`<情绪>` 类占位、「代写」「整套模板」的，不照抄，按规则书自己写，并 `report_rule_gap` 登记「requirement 含代写整句」。

### 〔A-003〕 【通用】作废的审片经验：「正脸改成微侧或低头（为防口型）」

由来：总导 2026-11-23 20:33 拍板，依据 A-002 铁律与心声镜核查（为防口型改背向、低头侧脸，都出自外部会话的审片经验，不在手册里）。

1. 这条经验作废，以手册 M33 第7条为准：镜头只按剧情选，不为防口型背身、遮脸、专选背影，也不为防口型改成低头、侧脸。正脸近景照常可以承载心声；防口型靠 C-001 的紧闭嘴声明、每段闭嘴嘴形和 narrates 声音句、第8条不带人名和说话动词的声音句、第12条镜头负载（M33 第3、10条，r19）和 M34。
2. M33 第6、7、8条现在是错误，不是提醒（检查器 `inner_voice_check_m33_678.py`）：一个镜头（`[Shot N]`）里不能既有心声又有出口台词；不写背向镜头、脸转开、只见后脑、捂嘴、遮脸、「为防口型」；心声窗口写明「The inner voice runs from Xs to Ys」，到切点或段末、两句之间、与对白之间都至少 0.8 秒。

### 〔A-005〕 【通用】文案问题提前解决，出片链不等稿

剧本、分镜、提示词、修改要求、服装描述的问题都在出片前由 IC 工作流改好（管理会话提前开新会话，按集或按段并发），过门禁后用 `--after` 进出片链；GPU 不等稿。写提示词时发现本镜文案与原著或绑定对不上，在报告里写明。

### 〔A-004〕 【通用】三处同改，作废不删除

1. **三处同改（TR-V18 已并进 h3-prompt-writing「Visual follows the prompt」节）。** 改镜头写法（景别、机位、站位、动作、台词）时，`visual`、`camera`、`sub_shots`、`video_prompt` 一起改；只改一处，渲染出来的还是旧的。台词改动同时改 `dialogue`、`<d>`、`sub_shots`。
2. **看不懂的镜作废，不删除（TR-V11）。** 观众看不懂的镜（没交代的回忆、莫名其妙的一拍）标作废（retire），不删；作废后，下一镜按「相邻镜站位」（TR-V10；提示词套见 F 段，改编套见 S 段）重新接上上一镜的结尾站位。

### 〔A-006〕 【待测】【通用】改稿只增不删锁

- 目的：重写时不丢已有的锁。
- 做法：改一镜前先列旧稿的锁句（服装 ID、人数、防重复、场景、背景人群、视线、闭嘴、身份、道具数量）；新稿逐项保留，措辞可改，内容不减。
- 要求：缺了就补回再存。只有三种情况可删：修改要求明说删；剧情变了（离场、换装那一拍）；旧锁违反现行规则（如 R22 已废的外貌描述）。报告写明删了哪条、依据。旧写法按现行口径重写并写明规则号；全剧存量扫描由管理会话按 X-010 做。
- 校验：报告写「旧锁 N 条，保留 N 条，删 0 条」；写库前比对新旧锁标签，丢锁退回（钩子待加）。
- 正例：只改语气的重写，服装 ID、人数句、场景锁都在。
- 反例：重写心声窗口时服装 ID 丢了，成片换了衣服。

### 〔A-007〕 【待测】【通用】写提示词前读本章剧本和原著：剧情事实照原著、镜头设计照分镜、台词照剧本（2026-11-26 用户点出，主会话定口径）

- 目的：用户原话：「写提示词的时候不光要看剧本，还要看原著」「剧本并不能很好地呈现原著表达的东西，这个时候就要去思考了」。
- 做法：写或重写一镜前，读 brief 里的 `chapter_script`、`chapter_novel`（已在线上 brief 里，每章第一镜带上）和本镜的 `source_rule`，弄懂原著要读者感受到什么（惊讶、窘迫、得意、温情）。分三层写：①剧情事实以原著为准：谁在场、做什么动作、有什么反应、时间、天气；②镜头设计照分镜：景别、机位、时长、切点；③台词照剧本（`dialogue`，E-004）。
- 要求：原著有、剧本没表达出来的感受，在不改镜头设计的前提下，用表情、动作和环境补上，不只把剧本一句翻成英文。剧情事实与原著冲突时提示词按原著写，报告列镜号，由管理会话开 visual 重写任务把 visual、sub_shots 改齐（A-004 三处同改）；镜头设计或台词有问题退回分镜。
- 校验：报告写「已读本章剧本与原著」，列出按原著改了哪些事实。
- 正例：原著是清晨散步、见人打太极、他站到队尾跟练，就照这个写；原著写「换成以前早气喘如狗了」，就写他跑完轻松调匀呼吸、低头看手、嘴角带笑。反例：只看分镜一句写成边跑边看；只写「他在跑步，心声：……」。

### 〔L-005〕 【待测】日常动作按现实常识写，能力提升不改日常行为（2026-11-26 用户点出）

- 目的：用户原话：「一定要符合常识，除非特殊能力赋予的东西可以表现不一样」「主角能力提升了，手机使用姿势也不会变」。
- 做法：用手机、开车、吃饭、走路、开门，照现实里普通人的做法写（手机见 FX-012）。
- 要求：只有剧情明确交代的特殊能力或系统效果才可不同；能力提升不改日常行为。
- 校验：自问现实里有人这样做吗。
- 正例：升级后照常低头看手机、开门上车。反例：手机举到脸前屏幕朝外；车无故倒着进来。
本段校验码：51FBD233

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
- **Character appearance: write only the clothing ID, never a look description (R22, rewritten 2026-11-23 rulepack-lock-20261123; 总导 2026-11-23 03:36 批准)**: a character's image reference carries the face, age, hair texture, skin, build, fabric, materials, shoes, accessories and trims, so the prompt never describes them. (1) **Reference line = who, not what they look like:** write character name + role/identity, e.g. `__MINIMAX_H3_REF_1__ is Ye Xueji's spirit body`; never add age, facial features, face shape, skin, build, materials, shoes, accessories or trims. (2) **When to write the clothing ID:** write one short clothing ID — colour + main garment + hair, e.g. `grey-blue short-sleeved T-shirt, dark grey trousers, short black hair` — for each bound character (a) in every shot with two or more people on screen, (b) in every shot, solo shots included, of a scene where any shot has two or more people on screen, and (c) whenever the story puts the character in a state the bound image does not show (injury, dirt, wet, exhaustion): add that state as words after the clothing ID, at the degree the novel gives, e.g. `a small scrape on the right cheekbone`. A solo shot in a scene that only ever has one person writes no clothing ID. A garment told apart by its length may add the bare body part (`bare lower legs visible`, F-001 item 2): the part only, never skin tone or texture. (3) **Where the words come from:** copy the clothing ID from the bound costume asset (or the character asset when no costume is bound) and from the costume-state trajectory table when one exists; keep it word-for-word identical in every shot of the scene until the story changes the costume (see *Same-scene presence and costume lock* items 2, 4 and 11). Write it in the reference line or the headcount lock sentence, never as a separate appearance paragraph. (4) **Never** write `keep the look of __MINIMAX_H3_REF_N__`, `keep the look of each reference`, `stay faithful to the reference image` or any similar sentence (these make the shot drift into the reference image at its end); end the prompt with the live-scene lock instead, e.g. `The last frame is still the live <scene> scene.` (5) If the task input supplies a character's look (asset description, character bible, continuity notes, 「角色一致性」 line), take only the clothing ID out of it under (2)–(3); do not copy anything else. This rule overrides the `keeps the look of <Picture N>` advice in references/ref-en.txt. Scenes, props and environments are not covered by this rule — describe them normally.
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

#### 〔B-006〕 【待定】画风基线

唯一风格句由总导定稿后写入本条；定稿前不改各镜现有风格句，也不写任何把画面锁到参考图的句子（见本类「不写画风锁定句」）。
本段校验码：E045F7A8

## F 一致性（人物、服装、场景、道具、站位、人数）

### 〔F-001〕 Same-scene presence and costume lock — 同场在场人物入画 + 服装锁

H3 only draws people who have a reference and are named in the prompt, and it freely swaps faces and clothes between references. For every shot with two or more people:

1. **Everyone the storyboard places in frame is a reference and is named.** If the scene's blocking map / whiteboard puts a present character inside this framing (edge of frame, soft-focus foreground, back view included), that character must be in the shot's references and must be written into the 0s opening with screen side, facing and state (`lips closed` if silent; in a shot that overlaps an inner-voice window keep their lips closed as in C-001 rule 7, never other mouth words). Never drop a present character just because he has no line. If the framing really excludes him, say where he is (`off screen-left`).
2. **Write a clothing ID for each person (R22 (2))** in `subject_definitions` and again in the 0s opening: colour + garment + hair, copied from the bound costume asset (`__MINIMAX_H3_REF_2__ is <A>: dark green long-sleeve shirt, slicked-back black hair`). A story state that the bound image does not show is added as words after the ID, see item 11. `fully_preserved` alone is not enough. Only the clothing ID: no faces, ages, materials or accessories. **Asset match (Andy 2026-11-24, 待测):** top, bottom, outerwear and shoes keep the asset's garment type and main colour (asset knee-length shorts → `knee-length shorts`, never `trousers`, `pants` or `jeans`; any garment told apart by its length or absence — shorts, short sleeves, sleeveless, short skirt, barefoot — also names the bare body part whenever it is in frame, e.g. `bare lower legs visible`, `bare forearms`, so it does not drift into the longer version); never add a garment the asset lacks. If the storyboard `visual` disagrees with the asset, write the asset and report the mismatch so `visual` is fixed too; gate COSTUME_ASSET_MISMATCH_PROMPT. **Colour words (待测):** copy them from the bound costume asset text (R22 (3)), not from the asset name or a loose label; a muted colour keeps a muted word with its tone (`muted dusty-rose red, matte`, `greyish olive`), never a stronger or more saturated word (`wine-red`, `crimson`, `bright red`) — close shots follow the words and drift to the stronger colour. If you can see the bound image and its colour clearly disagrees with the asset text, the image wins: write the image's colour and report the mismatch so the asset text is fixed (adapt-rules J-005). Same colour words, word for word, in every shot of the scene.
3. **Add the lock sentence** whenever two people could be confused (same sex, similar age, strongly contrasting clothes): `Each person's face and clothing come only from his or her own reference; never move one person's clothing onto another person. Exactly one person in the frame wears <garment>.`
4. **Costume inheritance.** Inside one scene and continuous time, a character keeps the costume reference he wore in the previous shots of that scene (same `costume_ids`) until the story shows a costume change (item 11). Write the same clothing ID, word for word, in every shot; a story state (injury, dirt) is added to it as words and does not by itself change `costume_ids`.
5. **The speaker is already in place at 0s.** Do not make the speaking character "enter / squeeze in / push to the centre" to take his speaking position; put him there from the first frame and state `only <clothing ID> moves his mouth; <others> keep their lips closed` (in a shot that also has an inner-voice window, the silent people stay silent with a closed mouth as in C-001 rule 7).
6. **Wide and crowd shots:** the named leads are at least medium size or in the foreground, with their clothing IDs; extras are described as "other guests" and must not wear a lead's colour.
7. **Who does the action comes from the novel/script, not from a similar-looking extra.** If the visual line names a character (e.g. "支架青年 deletes the clip"), the reference bound for that action must be that character; flag the shot if the binding names someone else.
8. **Headcount lock in every multi-person shot:** besides the count in the first sentence, write once in the body: `Exactly <N> people are in this shot and each of them appears only once: <A> (__MINIMAX_H3_REF_a__) in <clothing ID>; <B> (__MINIMAX_H3_REF_b__), a different man with a different face, <clothing ID>, never in <A's garment>. There is never a second <A> or any look-alike of him in the frame.` N counts only people on screen (voice-only and off-screen people are named as off screen).
9. **No limb without an owner, no second copy of anyone:** every body part at the frame edge or in the foreground belongs to a named, bound person on screen (name the owner, e.g. `<A>'s half-cropped head and right shoulder at the screen-left edge`; never as an over-the-shoulder or foreground-shoulder phrase, which the no-over-the-shoulder rule (E2 volume, E-001 item 3) and the gate r71 OFF_OTS_BANNED reject; never use the lead as that half-cropped edge figure while he is also elsewhere in the frame, see ic-lessons TR-B09). Never write a shoulder, arm, hand or back of a head that has no owner in the story, and never a second copy of anyone: `No stray shoulder, hand or arm without an owner enters the frame, and nobody appears twice.` This item does not decide whether an over-the-shoulder framing is allowed; that is section E "Faceless speaker" item 3 and the gate's own OFF_OTS_BANNED.
10. **Per-shot lock inside a scene:** items 2, 8 and 9 apply to every shot of the scene that binds the character, including solo shots, reaction shots and the last shots of the scene, not only the first ones. Solo shots too, in a scene where any shot has two or more people (R22 (2)(b)): a missing clothing ID is to be a gate ERROR (COSTUME_LOCK_MISSING_SOLO, pending).
11. **Costume change vs. story state:** inside a scene the costume reference and clothing ID stay the same. A **costume change** (changes clothes, puts on or takes off a coat) switches `costume_ids` only from the first shot where the novel or script shows it (or where the costume track logs an activity change as 常识推断, adapt S-023), and from that shot uses the new clothing ID. A **story state** (injured, dirty, wet, exhausted) is an overlay on the same costume: keep the current `costume_ids` and write the state as words after the clothing ID; bind a state image only when an approved one that matches the novel exists (listed in the trajectory table), and never bind a state image that does not match — words are better than a wrong image. How bad an injury or tiredness looks follows the novel's degree; a user ruling wins (the management session writes it into the task input or the asset's state description). A prop-holding variant (e.g. "holding the bouquet") is not a costume change: keep the costume and bind the prop. Read the costume-state trajectory table when one exists.
12. **Gaze lock when three or more people are on screen and someone speaks to a person who is not the lead:** `Gaze lock: whenever <A> speaks to <B> or listens to him, her eyes stay on <B>'s face and her head, shoulders and upper body are turned toward him; she never looks at <C> and never looks into the camera lens.` Add where B is on screen (screen side, standing or sitting) from the blocking. Missing: gate warning only; two people: FX-006.
13. **Voice references:** every voice IC attaches gets its own reference line, `__MINIMAX_H3_REF_k__ is <name>'s voice (Sx)`, with Sx in speaking order inside this shot (see Output Rules). A voice reference with no definition line is a duplicate-person risk.
14. **Scene lock:** the first body sentence names the location and two or more visible landmarks. A close-up with a blurred background still names one or two landmarks that remain recognisable in the blur. Use one negation only: `never a plain grey wall or a photo-studio backdrop`. IC always orders references as characters, then scenes, then props. Keep the scene reference early: do not bind background extras who are not needed (or bind a cropped single image, not a grey multi-view board), crop prop images, and never replace a detailed scene image with a rougher one.
- 案例（项目规则案例库，待建）：案-F-F001-E19S24-01、案-F-F001-E22S12-01、案-F-F001-E17S01-01

#### 〔F-002〕 第2、3集通过后转正：**Face-state lock follows the story (TR-V01).** A visible story state on the face (tiredness, puffy eyelids, eye bags, a fresh look after a win) has a start beat and an end beat from the novel. Before the end beat every shot of that character writes the state; from the end beat on every shot writes the new state and binds the matching state image if an approved one exists. Never write the state in only some shots. Write the state by shape and degree only, never by colour or darkness words around the eyes (manual M50 item 2). Wrong: the tired face written in #3 and #9 only. Right: `<name>'s lower eyelids are puffy and swollen, with clear eye bags.` in every shot before the beat; `<name>'s face is fresh and rested; the lower eyelids are smooth.` in every shot after it.

#### 〔F-003〕 第2、3集通过后转正：**Prop size lock (TR-V03).** A prop whose reference is a multi-view or a sized sheet gets one fixed real-world size sentence in every shot it appears in: `The <prop> is <real-world size copied from the prop asset sheet> and it never grows or shrinks.`

#### 〔F-004〕 第2、3集通过后转正：**Adjacent-shot position lock (TR-V10).** Every shot of a scene states who is on which side of whom (also after a push, pull or hug). Only for two shots in the same scene where the action is continuous does the next shot open with `The characters keep the same left-right positions as in the previous shot.` followed by who is on which side. After a camera change, a jump cut or a time skip, write only who is on which side of whom in the new framing. Describe people's positions only; never write a sentence that locks the camera or the frame to the previous shot. Right (continuous push): #12 opens `The characters keep the same left-right positions as in the previous shot: <A> stays on screen-left of <B>.` Right (#13 cuts to the reverse angle): `<A> is on <B>'s right, between him and the door.` Wrong: opening #13 with a sentence that ties its camera to the last frame of #12.

#### 〔F-005〕 第2、3集通过后转正：**Every shot binds a scene (TR-V12).** `scene_ids` is never empty; the gate already stops an empty `scene_ids` as an error (SCENE_UNBOUND). Same-scene shots share one scene sentence (see item 14 "Scene lock" in the section "Same-scene presence and costume lock — 同场在场人物入画 + 服装锁" above).

#### 〔F-006〕 **Hand props: write where the prop stays and where it never goes.** When a character holds anything that could go to the face (cup, glass, bottle, can, phone, cigarette, food, chopsticks), write its position for the whole shot, e.g. `she holds the cup at chest level the whole time; it never goes to her mouth`. If the story needs a sip or a call, write the exact second it is raised and when it comes down, and keep the mouth clear during any `<d>` line (see the dialogue-window section).

#### 〔F-007〕 **No glasses unless the story gives a reason.** Write `no glasses` into each character's lock (the look / costume lock sentence). A character who wears glasses by design keeps the same pair in every shot (`wears the thin black-rimmed glasses from his reference`); glasses never appear, disappear or change mid-shot.

### 〔F-008〕 【待测】【分镜】【提示词】人物身份：小角色也写服装 ID 和性别（G01、G02，人物一致性）

每个绑定的具名人物（包括中介、经理、同学、邻桌客人这类小角色，包括背影和虚焦里的人），定义句都写服装 ID（颜色＋衣物＋发型，照抄绑定的服装资产），并带一个性别词（a man / a woman），同章同场逐字一致；不能只写「名字，职业」（只写名字时中介被画成了女的）。按 h3-prompt-writing 的 R22，定义句不写脸、年龄、材质、配饰描写。主角和反复出现的角色，每镜加一句身份锁：同一个人、每镜同一张脸、性别不变、发型不变（句式同 h3-prompt-writing 同场节第 8 条的「a different man with a different face」写法）；人设没有的配饰（眼镜等）写明不戴。不写会改脸的特写（青筋暴起、疤），除非剧情要、而且有状态图。

### 〔F-009〕 【待测】【提示词】正式场合不改服装

- 目的：宴会、酒店、商业门店、办公室这类场合（同 adapt-rules S-001 第3条），模型会自己加西装、领带、胸牌、工牌。
- 做法：这类场合每个具名人物的服装 ID 后加一句 `<Name> wears exactly this outfit for the whole shot: no added jacket, tie, name badge or work badge.`（否定列举待测；画出来就改用 `<Name> wears exactly the outfit of the reference, nothing added.`）
- 要求：只从剧本写明换装那一拍起换（第11条）；资产没有的衣物、配饰不写。
- 校验：这类场合（按场景资产用途判定）缺这句，或写了 suit / tie / badge 而资产没有，门禁报警告（只报不拦）。
- 正例：售车店里主角照资产穿灰 T 恤，加上面那句。
- 反例：只写 formal setting，成片主角西装领带。
本段校验码：DAC2E861

