# fight-v44.md｜h3-prompt-writing 打斗 / 冲击镜 / 反应镜 / MOVE 运镜 / 走位步态（v4.4，2026-11-16）

【必读】写打斗镜、冲击镜、反应镜、MOVE 运镜镜、走路逼近追逐镜之前读完本文件。本文件为 v4.4 准，覆盖 SKILL.md「Camera, one-take and fight shots」节的对应条；两处不一致时照本文件写。

## 适用场景

- 本镜是打斗的一环：人打人的冲击镜、被打者倒地的反应镜、打完之后的收束镜。
- 本镜 `camera` 字段标 `MOVE`（一个小幅慢速运镜）。
- 本镜有人走路、逼近、追逐（含 `ONE-TAKE` 逼近）。

## 与 SKILL.md 的关系

- 本文件各条是 v4.4 的正文，原样取自 2026-11-16 合并版；SKILL.md 里对应的旧句已删除或改成指向本文件的一句话。
- 第 1 条替换 SKILL.md 第 1 款里 `MOVE` 那一行；第 2 条加在第 2 款（one-take）末尾；第 3 条替换 SKILL.md 第 3 款开头句、Impact shot、Reaction shot 三行，并新增 Force、Injury 两条；第 4 条替换旧的「正例（冲击镜）」；第 5 条是新增反例。
- SKILL.md 该节原有的「正例（ONE-TAKE 逼近，节选）」和「反例」一行一字未改，分别搬到本文件第 2 条末尾和第 5 条开头；SKILL.md 里只留一句指向。
- SKILL.md 第 3 款原有的四条（Every exchange states four things、Attack axis、Taunts and shouting、Urban realistic fights）一字未改，搬到本文件第 3 条末尾；SKILL.md 里不再保留。
- SKILL.md 该节其余内容（FIXED / ONE-TAKE / CUT@ 写法、一镜到底模板、时空白板）不变，继续有效。
- 心声、Q 版与特效、开场「The video begins already inside…」、表现手段开关照 SKILL.md 执行，本文件不覆盖它们。

## 条目索引

1. `MOVE` 运镜句式：运镜类型 + 幅度 + 速度
2. 走路、逼近、追逐要写步态；正例：ONE-TAKE 逼近
3. 打斗镜：冲击镜（人打人，4–5 秒，双人入画）、反应镜（起幅是打完之后）、受力方向与幅度、伤情写法、每回合四项、攻击轴线、嘲讽喊话、不加特效
4. 正例：冲击镜（耳光）
5. 反例：原有一行 + 8d086e01 的提示词和成片

## 1. MOVE 运镜句式（替换 SKILL.md 第 1 款的 `MOVE` 行）

- `MOVE`: one small, slow move written once, in H3's own form — move type + amplitude + speed — e.g. `The camera pushes in with small amplitude at slow speed toward 〔who〕's face over the whole shot.` (other move types: `pans left/right`, `trucks left/right`, `tilts up`, `follows 〔who〕 (tracking shot)`); no second camera verb.

## 2. 走路、逼近、追逐的步态（v4.4 新增，接在 SKILL.md 第 2 款 one-take 各条之后）

- Walking, closing in and chasing need a gait, not just a destination (v4.4): stride, upper body and a change of speed, e.g. `strides forward with long steps, shoulders swinging, the bouquet jolting in the crook of his arm, speeding up, then slows over the last two steps and plants his back foot`. Never just `walks to` / `rushes at`, never one even speed from start to end.

下面这条 ONE-TAKE 逼近正例原在 SKILL.md 该节末尾，一字未改，搬到这里：

**正例（ONE-TAKE 逼近，节选）：** `This is one continuous take with no cuts from the first frame to the last. 0s: full shot, the camera starts behind A, about three metres away at chest height; A is centre frame with his back to the camera, car key in his right hand; far ahead by a black sedan, B and C stand on screen-right facing the camera. 0-4s: A strides forward; the camera follows at walking speed. 4-9s: A keeps walking, shoulders squared; the same unbroken move carries the camera past a numbered concrete pillar on screen-left, closing the distance; B's smile drops. 9-12s: the camera slows and settles into a medium close-up of the three: A on screen-left facing right, B right of centre and C at the far right, both facing left; A stares at B, lips pressed shut. The camera never passes through walls, glass, furniture or people.`

## 3. 打斗镜（替换 SKILL.md 第 3 款的开头句、Impact shot、Reaction shot）

**3. Fight shots.** The storyboard gives each exchange an impact shot (wind-up, one contact, follow-through and the first reaction, all in one shot) and, when the struck person goes down, a separate reaction shot (see sd-storyboard-engine 第 5b 条). Write them like this:
- **Impact shot, person hits person (`FIXED`, 4–5 s, no voice at all; v4.4, replaces the limb-only close-up):** both people are recognisable. Frame it as a side two-shot — `Medium close-up two-shot from the side at eye level: 〔attacker〕 on screen-left facing right, 〔target〕 on screen-right facing left, both in frame from the chest up, one arm's length apart.` (never an over-the-shoulder framing; banned 2026-11-22) Then write the chain in this order, with one contact only: `〔Attacker〕 has already stepped in, his camera-side 〔right〕 arm drawn back behind his shoulder, 〔palm open / fist clenched〕. He drives off his back foot, turns his hips and swings the whole arm in one arc; 〔the open palm〕 lands once on 〔target〕's camera-side 〔left cheek〕 with 〔one sharp crack〕. The hand carries on past 〔his face〕 and drops back to 〔attacker〕's side as his body follows half a step. 〔Target〕's head turns with the hand, away from the camera; his shoulders are pulled after it and he 〔sways and takes one step back / stumbles toward screen-right, off balance〕, still in frame at the last frame. 〔Attacker〕's chest heaves, his hand hanging at his side. Nobody speaks and no voice is heard in this shot.` Use whole-second time blocks only (`0-1s` wind-up, `1-2s` swing and contact, `2s to the end` follow-through and reaction); H3 does not follow sub-second marks. Anyone in frame shows at least a shoulder and the head; otherwise he is entirely off-screen — never `a hand enters from screen-left`, never a face or an arm cut by the frame edge. If the storyboard still hands you a limb-only close-up for a person-on-person hit and both characters are in the references, write it as this two-person impact shot and say so in your report. A hand hitting an object (table, door) keeps the old form: close-up of the hand and the object, the hand already moving in the first frame, the hit as the first action.
- **Reaction shot (`FIXED`, ≥ 3.5 s, no dialogue):** full shot or medium-full shot, whole body in frame, `screen-left / screen-right` positions restated. It opens after the hit, as a state: `0s: 〔attacker〕 stands on screen-left facing right, both hands down at his sides, chest heaving; 〔target〕 is right of centre, head turned away, already tipping toward screen-right.` Never mention the strike again anywhere in this prompt — no `slap`, `punch`, `kick`, `blow`, `just struck`, `after the hit`, `from the blow`, `his hand still at 〔target〕's face`, and do not label anyone `the attacker` / `the one being struck` in the reference lines (8d086e01: these words made H3 replay the hit at the start of the next shot). Write the fall or stumble in 3 visible stages with direction and distance (`two short stumbling steps toward screen-right → his knee gives way → he goes down on his side, shoulder first, within two steps of where he stood`), then a held end state with a small movement. While the other falls the attacker has a small continuous action (hand lowering, fingers closing into a fist, eyes following him down); anything bigger (a step forward, leaning over him) comes only after the fall has landed.
- **Force direction and scale (v4.4):** the struck body moves the way the striking limb keeps travelling — a straight punch or a push kick drives it along the attack axis, away from the attacker; a slap or a hook turns the head the way the hand sweeps and pulls the upper body after it. Copy the storyboard's size of reaction exactly (`half a step` stays half a step; a fall stays within the stated steps); never enlarge it with `flies back`, `is thrown`, `several steps`, `crashes` unless the storyboard says so; for fight reactions this takes precedence over the general forceful-action wording in Output Rules. A limb never rests on the target after contact: `the fist bounces back`, `the foot drops back to the ground`.
- **Injury wording (v4.4):** write only what the storyboard's 伤情台账 line gives, only in time blocks after the contact, and never copy the ledger line itself into the prompt. Level 1: `a faint, even flush slowly comes up on his camera-side 〔left〕 cheek, soft-edged, the skin texture unchanged`. Level 2 adds `a thin trace of blood at the corner of his mouth, not running`. Level 0: use no injury words at all — do not write `no blood` or `no bruise` either. Never write `handprint`, `red patch`, `crimson`, `swollen welt`, `bleeding`, blood that runs, drips or is spat out, or blood and stains on the ground. In later shots restate the injury as part of the opening state, same side and same level (`the same faint flush on his left cheek`). Objects on the ground (a tooth, a dropped bouquet) appear only if the 时空白板 lists them.
- **Every exchange states four things:** who strikes with what; hit or blocked, and where; the reaction; where both end up (screen side and facing). Never write `they fight`, `a scuffle breaks out`, `they brawl`, `a flurry of blows`.
- **Attack axis:** repeat it in every fight shot, e.g. `Throughout the shot, 〔A〕 stays on screen-left facing right and 〔B〕 on screen-right facing left.` Keep it identical across the whole fight unless the storyboard writes a circling path.
- **Taunts and shouting** go in their own shot or time block with light gestures only (pointing, wiping the mouth, glaring); never put a punch, slap or kick inside a spoken line's window. Keep ≥ 0.5 s between a spoken block and an impact.
- **Urban realistic fights have no glow, energy trails or slow-motion VFX** unless the expression switch for VFX is on and the storyboard asks for a specific effect; force is shown by body reaction and synchronous sound.

## 4. 正例（替换 SKILL.md 旧的「正例（冲击镜）」）

**正例（冲击镜，耳光，v4.4）：** `The camera holds a fixed position (static shot) for the whole shot. Medium close-up two-shot from the side at eye level: A on screen-left facing right, B on screen-right facing left, both in frame from the chest up, one arm's length apart. Throughout the shot, A stays on screen-left facing right and B on screen-right facing left. Nobody speaks and no voice is heard in this shot. 0-1s: A has already stepped in, his camera-side right arm drawn back behind his shoulder, palm open; B is still smirking. 1-2s: A drives off his back foot, turns his hips and swings the whole arm in one arc; the open palm lands once on B's camera-side left cheek with one sharp crack, carries on past his face and drops back to A's side as A's body follows half a step. 2-4s: B's head turns with the hand, away from the camera; his shoulders are pulled after it and he sways, taking one step back toward screen-right, a hand coming up to his cheek, where a faint, even flush slowly comes up; A's chest heaves, his right hand hanging at his side. Both are still in frame at the last frame.`

## 5. 反例（第一行原在 SKILL.md 该节末尾，一字未改搬来；第二行 v4.4 新增）

**反例：** `They fight fiercely, fast cuts, dynamic camera, epic action.`；一个 ONE-TAKE 镜里每个时间块都写一句 `the camera pushes in / pans / whips`；`A punches B while shouting <d>…</d>`；冲击镜里先写人物站着对视，再写出拳；反应镜只写 `B falls down` 不写怎么倒、倒在画面哪边。
**反例（v4.4 补，全部出自 8d086e01 的提示词和成片）：** `only the striking hand and forearm and B's head are in frame` —— 看不出谁打的，残手和半张脸贴在画面边；`a red handprint flushing up fast on the cheek … a thin thread of blood at the corner of his mouth` —— 深红色块加淌血，像贴上去的；反应镜写 `his right hand just lowered after the slap` / `twists toward screen-right from the blow` —— 这一巴掌在反应镜开头又演了一遍；`staggers two steps … crashes sideways` 没写方向和距离上限 —— 成片是往前走了四五步再整个人扑倒；`the fist stays pressed against the shoulder, trembling` —— 拳头贴在肩上停了两秒；`spits a mouthful of bloody saliva onto the tiles` —— 地上多出一滩前面没有的血；上一条结尾写 `the shot ends with the right foot already driving toward …`、下一条开头又写 `right leg just extended from the kick` —— 同一脚演了三遍。
