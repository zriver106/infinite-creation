<!-- rulebook: id=E tier=volume when=dialogue -->
## E 人声与台词

### 〔E-001〕 Faceless speaker vs a visible face — 看不见脸的人别和露脸的人同镜开口

H3 gives each spoken `<d>` line to whoever *looks like* the speaker on screen and uses that face's voice, even when the line is tagged with the right `(Sx)` and the voice references are correct. 2026-11-16: shot 17, over-the-shoulder with the lead's back in the foreground, and shot 21, the lead at the door with his back to the camera — in both, the shop owner's face was the only face on screen, and the lead's short reply came out in the owner's voice. Speaking with the back turned is a legitimate shot; the problem is only a faceless speaker next to a visible face. For every spoken line (not OS, not a phone voice from the other end):

1. **A speaker whose face can't be seen may speak only when no one else's face is visible in the shot** — a lone figure from behind, an empty frame, a voice from beyond the door or out of frame are all fine.
2. **If another face is visible, a faceless speaker gets that person's voice.** Fix it one of three ways: the speaker turns his head so at least a profile with the mouth shows while he speaks (`he stops at the door and turns his head over his shoulder, face and mouth in profile to the camera, and says …`); or the line goes into its own shot in which no one else's face is visible; or only the speaker stays in frame. If the storyboard hands you such a shot, change it this way and say so in your report.
3. **No over-the-shoulder shots at all:** never write an over-the-shoulder or 过肩/越肩 framing, including over the shoulder of someone looking at a phone. A phone being looked at becomes a separate close-up insert of the phone screen; a conversation is single-person shot / reverse shot plus a side two-shot medium shot with both faces in profile. If the storyboard hands you an over-the-shoulder shot, rewrite it this way and say so in your report. (Turning the head *over his shoulder* as an action is fine; this bans the framing only.)
4. **The listener's lips stay closed** while the other person speaks: `<Listener> listens with his lips closed.`

#### 〔E-002〕 第2、3集通过后转正：**The caller is a bound character (TR-V02).** In a phone shot the person on the other end is in `character_ids` even when off screen, or IC attaches no voice reference and the voice drifts. Write `It is the same voice in the room and through the phone receiver.`

### 〔E-003〕 Dialogue window = visible speaking mouth — 台词时间窗与可见开口对齐

H3 places each `<d>` line by the time window it is written in and lip-syncs it to a face it can see. If the window falls while the speaker is still off screen, walking in, turned away or covered, the line is either given to another visible face or heard with no matching mouth. 2026-11-18 (a1 16-R-V1 #18): the female classmate's line was written for 3-6s but she was turned sideways with a hand at her cheek; QC could not confirm her lips. The rewrite said "0-3s nobody speaks; the line starts at 3s; she turns three-quarter to the camera, mouth visible, hand never covers it", and it passed. For every shot with a line:

1. **An on-screen line sits only in a window where its speaker is already in frame, facing the camera at least three-quarter (hard rule: a pure profile or a back view never counts as a visible mouth), mouth clearly visible and not covered (no hand, cup, phone or other person in front of it), and doing a speaking action** (turning or leaning toward the listener, a gesture). Write the start second: `the line starts at <t>s`.
2. **Before the speaker enters the frame, while he walks in, while his back is turned or his mouth is hidden, there is no on-screen line.** Move the line to a window where rule 1 holds, or write it as an off-screen voice (画外音): `an off-screen voice (Sx), <emotion>, says <d>[Chinese] …</d>; nobody on screen moves their lips`, or leave the window without dialogue.
3. **Say when a window is silent:** `0-3s (no dialogue: nobody says a word in this window)`. When a shot has one line, name it as the only dialogue window.
4. **Inner monologue (OS), phone voices from the other end and the system voice are always off-screen voices** and follow the OS and faceless-speaker sections above; they need no visible speaking mouth, and every visible face keeps its lips closed during them. (IC 947e856 wording)
5. **Check before you hand over:** for each `<d>` line list window -> speaker -> in frame and at least three-quarter to the camera (not pure profile, not back view)? -> mouth visible? -> speaking action? Any "no" must be fixed, not just noted.

#### 〔E-004〕 **Every line is voiced by H3 in the shot itself, OS and phone voices included.**
   - Every line in the shot's `dialogue` field (spoken, OS, phone voice) appears in `video_prompt` as a `<d>[Chinese] …</d>` line, word for word the same. A change to a line changes `dialogue`, `sub_shots` and `video_prompt` together; read all three back and check they match.
   - Mixed shots (spoken dialogue + OS): the OS line uses the fixed OS sentence of the Inner-Monologue section (`An off-screen male/female inner-monologue voice (Sx), … narrates <d>…</d>. Nobody on screen is speaking; <Name> only listens to his/her own thoughts with his/her lips closed.`). Give it its own time block, written as closed-mouth acting with the face and closed mouth visible; put each spoken line in its own block before or after, never interleaved, with ≥ 0.8 s between blocks (2026-11-22; time fields are whole seconds, so in practice ≥ 1 s). Speaker IDs follow the order the voices are first heard in the shot.
   - No batch edit, lint fix or template may delete or skip a `<d>` line. After any batch edit, compare every shot's `<d>` text with its `dialogue` field before writing back.

#### 〔E-005〕 **Phone voices (the far end of a call) are voiced by H3 too.** Write the caller's line as a `<d>` line with the caller's own speaker ID, described as the voice heard through the phone, e.g. `the caller's voice (S2) comes faintly through the phone's earpiece, tinny and slightly compressed, <emotion>, <pace>: <d>[Chinese] …</d>`, and bind the caller's own voice reference (`__MINIMAX_H3_REF_n__ is <Caller>'s voice (S2)`), so the timbre stays the same in every shot of the call.
   - The on-screen call-taker acts normally: phone at the ear, listening reactions (brows, gaze, nod, free hand), and their own spoken replies as normal `<d>` lines with visible mouth. While the far end talks, the call-taker's lips rest closed.
   - The far end may be shown: either as its own shot in the caller's location, or inside the call shot with hard cuts to the caller (at most 2 cuts per shot, every cut at least 1 s, each cut shows exactly one person). When the caller is on screen her line is an ordinary spoken line with her mouth visible; when she is not, it is the earpiece voice above. Bind the caller in `character_ids` and her location in `scene_ids`, and use the same voice reference in both cases. Never a split screen or an inset.
   - Rule 9 of the Inner-Monologue section (listening wording, banned call/conversation words) still applies to an OS speaker on the phone.

#### 〔E-006〕 **Voice references keep one timbre per person.** A character's voice reference is the same sample for every line they have in any shot (spoken, OS, phone), so the voice never changes between shots. Never bind two different samples to one character.

#### 〔E-007〕 台词的情绪、语速、音量描述（原 Output Rules）

- **Annotate every spoken line's delivery (emotion + speech pace + tone/volume) with a bias toward high energy**: before each `<d>…</d>`, after the speaker ID `(Sx)`, explicitly state how the line is spoken — emotion (furious / ecstatic / frantic / explosive / urgent / breathless / anxious / annoyed / amused / sad / nervous / hesitant / calm …), pace (fast / hurried / breathless / rapid-fire / measured / slow / drawn-out / hesitant …), and tone or volume (shout / cry out / whisper / murmur / rising / trembling / flat …). Pick the high-tension end of these lists unless the beat genuinely calls for calm. Never write a bare `S1 says, <d>…</d>` with no delivery description. Vary delivery and intensity between lines, speakers, and emotional turns within the same shot instead of one flat monotone. Follow the delivery wording shown in `references/ref-en.txt` (e.g. `exclaims with light annoyance`, `says in a casual young male voice with a playful tone and an easy conversational pace`, `replies … with an amused cadence`) — and prefer its higher-energy phrasings for conflict, urgency, or strong emotion. **Exception for inner monologue:** the delivery description applies to the voice only; the on-screen face never acts the line with the mouth. For an OS line use the Inner-Monologue rule 8 sentence `An off-screen male inner-monologue voice (S1), <emotion>, <pace>, <timbre> narrates <d>…</d>.` (V2 6#3): no name, no `says` / `in an off-screen voiceover`, nothing about the mouth after `</d>`.

#### 〔E-008〕 E-005【待测】音色参考编号按 IC 装配顺序（TR-E01、G12）

IC 装配参考素材的顺序固定为：人物图 → 场景图 → 道具图 → 有台词的说话人的音色。写 `__MINIMAX_H3_REF_n__ is <name>'s voice (Sx)` 时，n 按 brief 里 references 列出的顺序数，不越界、不写反；没有音色参考的角色不写音色句。

#### 〔E-009〕 E-008【待测】无台词镜写静默锁（TR-E03、G15）

dialogue 为空的镜写 `Silence lock: the whole shot is silent; every person in the frame keeps the lips naturally together and still, the jaw relaxed.`，不写诱导张嘴的动作（mouth opens to snap back、starts to say 等）。

#### 〔E-010〕 【待测】`dialogue` 就是字幕原文：逐字校对，改台词后报重新导出（G18，txt L70、L132）

- 原则：导出时字幕文字只取 `dialogue`（导出合成通用规则 X-001）。`dialogue` 里的错字会原样上屏；`dialogue` 和 `<d>` 不一致，成片就是语音和字幕不符。本条是 E-004 第 1 条的补充，不改 E-004。
- 适用条件：每个有台词的镜；写稿、改稿、批量修改后交稿前；写稿的人。
- 正确写法：
  1. 交稿前把每句 `dialogue` 对照剧本原句逐字读一遍，重点查同音字、近音字和漏字、多字；错字改 `dialogue`，同时按 E-004 改 `<d>` 和 `sub_shots`。
  3. 已经出过片或导出过的镜改了台词，在报告里写明「台词已改，该集字幕需重新导出」，旧字幕不能沿用（X-003 第 6 条）。
- 可用短句：
  - 报告句：`Dialogue proofread: every dialogue line matches the script character for character; dialogue = <d> in every shot.`
  - 报告句：`Line changed in shot <n>: subtitles of this episode must be re-exported.`
- 错误案例：见 `C:\Users\usazr\Documents\moviePro\docs\通用规则_错误案例.md` CASE-001、CASE-005

#### 〔E-011〕 【待测】`<d>` 的说话人、`dialogue` 的说话人、绑定人物和音色参考是同一个人（G13，txt L84）

- 原则：H3 把一句台词交给谁说，看的是提示词里这句话写在谁名下、这个人有没有绑进来。说话人写错或没绑，台词就落到画面里别的人身上。F-001 第 7 条管动作主体，本条管说话人；E-001、E-003 管说话人看不看得见，本条管说话人是不是对的那个人。
- 适用条件：每个有出口台词的镜；写稿、改稿、批量修改后交稿前；写稿的人。
- 正确写法：
  1. 每个 `<d>` 的说话人和 `dialogue` 里这一句的说话人是同一个人，名字照抄，不换成同场别的人。
  2. 这个说话人在 brief 的绑定人物里：有他的人物定义句；有音色参考的，音色句 `__MINIMAX_H3_REF_n__ is <name>'s voice (Sx)` 写的是他（编号按 E-008）。同一镜里一人一个 `(Sx)`，一句话从头到尾不换号。
  3. 同镜有别的人在画时，写清这句是谁说、谁没说：说话人写出他的位置和说话动作；紧挨着的、容易被当成说话人的那个人，写明他这时不说话、在听或在看。
  4. 说话人是背景里或邻桌的小角色：他说这句的时候让他入画、看得见（E-003），用位置把他和主要人物分开（`the guest at the table behind <Name>`）；画面放不下就把这句单独切成一镜。
  5. 说话人不在 brief 的绑定里：不把这句话写给在画的别人，不写一个没绑定的人让模型自己配声；在报告里写明，退回分镜补绑（adapt-rules S-017）。
  6. 交稿前逐句列：`<d>` → `dialogue` 说话人 → 绑定人物 → 音色句，四项对得上才交。
- 可用短句：
  - `<Name B> (S2), the guest at the table behind <Name A>, leans forward and says <d>[Chinese] …</d>; <Name A> says nothing in this window and only turns his head to look.`
  - `Only <Name B> speaks in this shot; every other person in the frame stays silent and listens.`
  - 报告句：`Speaker check: every <d> speaker equals the dialogue speaker, is a bound character of this shot, and has the matching voice line.`
  - 报告句：`Shot <n>: speaker <name> is not bound; returned to storyboard, line not reassigned.`
- 错误案例：见 `C:\Users\usazr\Documents\moviePro\docs\通用规则_错误案例.md` CASE-023

#### 〔E-012〕 【待测】`<d>` 里的数字写汉字口语读法；关键词要念得清（TR-V14，txt L18、L23）

- 原则：H3 照 `<d>` 里的字念。写阿拉伯数字，读法由模型自己猜；写书面全读，念出来不像人说话；关键词念得含糊，观众会听成别的词。数字各种情况怎么写由 adapt-rules R-003 定，本条只管提示词里怎么落。
- 适用条件：`<d>` 里有数字、金额、号码或听错会改变意思的关键词的镜；写稿的人。
- 正确写法：
  1. `<d>` 里念出来的数字全部写汉字，不出现阿拉伯数字、小数点、百分号、货币符号和单位缩写。
  3. `dialogue` 里的数字还是阿拉伯数字或书面全读时，按 R-003 改成口语汉字，`dialogue`、`<d>`、`sub_shots` 三处一起改，并在报告里写明改了哪一句。只改读法，不改数值。
  4. 有关键词的那句话，语气描述（E-007）里加上说得清楚、关键词略重，可以像 H2 分册谐音例子那样在引号里注一次拼音；这一句不写含糊、嘟囔、极快这类会吃字的语气。
  5. 关键词和上下文里另一个说得通的词只差一个音时，不靠语气硬撑：按 R-003 第 7 条换说法，三处同改，在报告里写明。
  6. 画面里显示的数字（屏幕、界面、价签）照各自的规则写，不受本条限制；同一个数在画面和台词里数值要一样。
- 可用短句：
  - `<Name> (Sx), flat and a little bitter, at an easy pace, says <d>[Chinese] 月薪才三千五。</d>`
  - `<Name> (Sx) asks clearly and evenly, with a slight stress on the key word, a clear "jīn jià": <d>[Chinese] …</d>`
  - 报告句：`Numbers check: every number inside <d> is written in Chinese characters in its spoken form and equals the dialogue field; values unchanged.`
  - 报告句：`Shot <n>: number / key word rewritten to its spoken form in dialogue, <d> and sub_shots.`
- 错误案例：见 `C:\Users\usazr\Documents\moviePro\docs\通用规则_错误案例.md` CASE-024、CASE-025
