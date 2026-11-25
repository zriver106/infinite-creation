---
name: h3-camera-moves
description: 运镜与镜头手法（MiniMax H3，都市写实 3D 半写实短剧）。拆分镜标非 FIXED 镜头形态、一镜内要切镜、要用登场低角度/弧形环绕/POV/滑动变焦/遮挡点/手持/低机位跟拍时按需读取；补 h3-prompt-writing H1-003、fight-v44.md 和 sd-storyboard-engine S14 没写的条款：非固定机位算难事、运镜四段写法、一镜一种人声与切镜模板、切点六项、眼线切、声桥、跳时、远景开场名额、双人镜收、多人镜一镜一场景，以及八种大师镜头的收与不收。单独读取，不计入写稿分卷 40,000 字预算。含【待测】条目，照样执行。
---

# 运镜与镜头手法（h3-camera-moves）

版本：h3-camera-moves-草稿-2026.11.25-r00（未上线）。

## 用法

1. 什么时候读：分镜 `camera` 不是 `FIXED`；一条分镜里有 `CUT@` 或要写两个以上 `[Shot N]`；分镜点名了 CAM-011–018 的某种手法。调用 `skill(name="h3-camera-moves")`，不计入 brief 的分卷预算。
2. 和已有规则的关系：镜头形态 FIXED/MOVE/ONE-TAKE/CUT@、一镜到底模板、时空白板照 H1-003 和 S14；MOVE 句式、打斗、步态照 `fight-v44.md`；镜头族和名额照 `short-drama-camera-system.md`。本技能只补那里没有的条款，不重复。
3. 优先级不变：心声镜正面近景，固定或慢推；Q 版插入那一两秒机位不动；有系统面板、大动作、接链的镜固定机位（M51 第 2 条）。本技能任何一条都不推翻这些。
4. 本技能没写、又拿不准的，按 h3-prompt-writing 地图第 4 步 `report_rule_gap` 登记，不自己编写法。

## 一、镜头与切点（手册已有、IC 未收）

### CAM-001 非固定机位算一件难事（手册 M41 难事⑦、M51 第 2 条）
- 原则：模型一镜只做好一件难事。运镜不是固定机位，算一件。难事清单：②出口台词 ③大动作 ④接链起势或段末两秒静止 ⑤手物接触 ⑥两人以上同框且不止一人有动作 ⑦非固定机位 ⑧模型画的界面。
- 适用条件：每条 `camera` 为 MOVE / ONE-TAKE 的分镜和提示词。
- 正确写法：先逐镜数难事。M41 允许的组合表里没有含⑦的组合，所以运镜镜里只放一个人的动作和眼、眉、头、肩反应；有台词、大动作、手物接触、两人同时动或界面时，要么改 FIXED，要么在本段内拆镜（拆的是镜不是段）。心声画外音不算出口台词，心声镜慢推只算一件。
  `The camera pushes in with small amplitude at slow speed toward <Name>'s face; he only lowers his eyes and his jaw tightens.`
- 错误写法：一镜里既慢推又让他说台词、伸手接过文件；镜头环绕的同时两个人都在走动。

### CAM-002 运镜句写全四段（手册 M51 第 4 条）
- 原则：只写「镜头推近」，H3 自己决定从哪推到哪、停在哪。
- 适用条件：所有 MOVE / ONE-TAKE 镜的运镜句。
- 正确写法：起始（机位、高度、距离、构图）→ 路径（运动类型 + 幅度 + 速度，用 base-en §4.3 的词：push in / pull out / pan / truck / tilt / pedestal / arc / tracking）→ 对焦目标 → 结束构图和停稳时刻。仍是一句、只写一次。
  `The camera starts at eye level about two metres in front of <Name> in a medium shot, pushes in with small amplitude at slow speed, keeps focus on his eyes, and settles into a close-up of his face by 4s, then holds.`
- 错误写法：`dynamic camera`、`cinematic movement`；每镜都推；无动机环绕、甩镜；路径越轴或穿墙。

### CAM-003 一个 `[Shot N]` 只有一种人声；切镜模板；太短就报告拆镜（手册 M33 第 6 条、0.5「镜」；原 h3 SKILL 拆分时丢失，现补）
- 原则：`[Shot N]` 是两个切点之间的一个镜头。有画外音（心声、电话那头、系统声）的镜头不放任何出口台词，有出口台词的镜头不放画外音。人声窗口整个落在自己的镜头里，不跨切点、不跨段，离本镜切点或结尾 ≥ 0.8 秒（按整秒写 ≥ 1 秒）。
- 适用条件：IC 一条分镜的 `dialogue` 里同时有出口台词和画外音；或要在一条分镜里写两个以上 `[Shot N]`。
- 正确写法：两种人声分成两个镜头，中间硬切，每个镜头 ≥ 3 秒。第一个镜头不写时间戳，后面的镜头写严格递增的切点，格式照 base-en §4.2、ref-en §5.1：
  `[Shot 1] <景别和机位句> … <Name> (S1) says: <d>[Chinese] …</d> [Shot 2] At 00:06.000, the camera cuts to a frontal close-up of <Name>, who listens with his lips naturally together. An off-screen male inner-monologue voice (S2) … narrates <d>[Chinese] …</d>`
  画外音镜头用 h3 心声节的固定句、自然闭嘴句和眼眉头肩表演。说话人编号按本镜第一次听到的顺序。
  分镜太短、放不下两个 ≥ 3 秒的镜头：不硬塞，报告写 `Shot <n>: spoken line and off-screen voice need two camera shots of ≥ 3 s; the storyboard shot is too short; returned to storyboard for a split.`
- 错误写法：同一个 `[Shot N]` 里先说台词、再在「自己的时间块」里放心声（2026-11-22 旧写法，已作废）；把切点写成 `At 00:06.000 [Shot 2]`（顺序反了，官方是 `[Shot 2] At 00:06.000,`）；心声窗口跨过切点。

### CAM-004 每个切点写六项（分镜手册 §4 表）
- 原则：只写「丝滑转场」「切到他」，模型不知道切前切后各是什么。
- 适用条件：段内每两个 `[Shot N]` 之间，以及前后两条分镜的边界。
- 正确写法：分镜里写全六项，提示词里落到切点句和前后两个镜头的首句：①触发与时点（哪一秒、哪个动作/目光/声音完成后）②切前（景别、视高、朝向、人在画面哪侧、手和物在哪、动作到哪一步）③方式（连续运镜、动作匹配切、眼线切、证据/反应切、声音先行、明确跳时，选一种）④路线（运镜写起点→方向→速度变化→落点→何时停；剪接写从哪幅直接到哪幅）⑤切后（方向、眼线、姿态怎么接上，下一个动作何时开始）⑥声音（什么延续、什么停、何时起新声）。没有切镜时写「同一镜头继续」。
  `[Shot 2] At 00:05.000, right after <Name> turns his head to screen-right, the camera cuts to a close-up of the phone screen on the desk at screen-right; the same air-conditioner hum continues.`
- 错误写法：`smooth transition`；遮挡、甩镜、叠化当成掩盖错位的默认补丁；写了一镜到底又偷偷写 `cuts to`。

### CAM-005 眼线切：先给方向，证据读清再切反应（分镜手册 §4「选择方式的依据」）
- 原则：观众还没看清被看的东西就切回人脸，信息丢了。
- 适用条件：人物看手机、文件、屏幕、门外，或听到消息后要给反应。
- 正确写法：切前镜头写清他朝画面哪侧看；被看物镜头停够读清的时间（有可读字照 M60 / 贴字表，至少 2 秒）；之后才切反应镜。不是每句轮流反打。
  `0-1s: <Name>'s eyes move down to screen-left. [Shot 2] At 00:02.000, the camera cuts to a close-up of the bank slip in his left hand … held for two seconds. [Shot 3] At 00:05.000, the camera cuts back to a close-up of <Name>; only now his brows draw together.`
- 错误写法：证据镜 0.5 秒一闪就切；反应先于证据出现。

### CAM-006 声桥只用于非人声（分镜手册 §4「声桥」；和 base-en 冲突，见末尾）
- 原则：后场声音提前进入叫声音先行，前面的声音延续到后画面叫声音延续。手册规定人声窗口不跨切点，所以声桥只用环境声、效果声、铃声、音乐。
- 适用条件：切点两边要用声音连起来；电话、门铃、广播先响后见。
- 正确写法：写实际秒点和听者反应，防止「电话还没响，主角先知道是谁」。
  `At 4s the phone on the desk starts ringing off-screen; <Name> looks toward screen-right. [Shot 2] At 00:05.000, the camera cuts to a close-up of the ringing phone; the ringtone continues seamlessly across the cut.`
- 错误写法：用 `<scenetrans>` 让一句台词或心声跨切点；铃声没响人先回头。

### CAM-007 跳时交代地点变化和持物去向（分镜手册 §4「跳时省略」）
- 原则：可以省掉没有新信息的返程，但物件不能凭空换手、消失。
- 适用条件：切点前后时间不连续或地点变了。
- 正确写法：切后镜头首句写新地点、两个以上地标和物件现在在哪；切点用 `the shot transitions to`。和上一镜同空间的才算连续。
  `[Shot 2] At 00:06.000, the shot transitions to later that evening in the rented room: the same black backpack now lies on the bed at screen-left, and <Name> sits at the desk.`
- 错误写法：同一个镜头里从街上「走进」另一个不相连的房间；背包在下一镜突然出现在别人手里。

### CAM-008 同场远景/大全景开场全章只用一次（手册 M40 第 3 条）
- 原则：每段都用远景开场，节奏拖、空间重复交代。
- 适用条件：同一场景的段首 `[Shot 1]`。
- 正确写法：这个场景第一次出现时用一次远景/大全景开场，镜长 3.0–3.5 秒，镜里必须有动作；之后同场景的段首用全景或更近。
  `Wide shot, the camera about eight metres back at eye level: the night-market street, <Name> walking in from screen-left toward the noodle stall at screen-right.`
- 错误写法：同场景第 2、3 段又用 `extreme wide shot` 开场；远景开场镜里没人动。

### CAM-009 单人镜来回切后用双人镜收（手册 M48 第 6 条）
- 原则：一直单人正反打，观众读不出两人的相对位置。
- 适用条件：同一场景连续几镜单人镜来回切。
- 正确写法：收在一个侧面双人中景，写清两人各在画面哪侧、中间隔着什么；本段镜数不够就放下一段开头（镜数上限优先）。戴配饰和不戴的人不同框（M47）。
  `Side two-shot, medium shot at eye level: two people in frame, <A> on screen-left facing right, <B> on screen-right facing left, the counter between them.`
- 错误写法：整场全是单人镜；用过肩镜收（已禁）。

### CAM-010 多人镜一镜一个场景（手册 M48 第 10 条、M05）
- 原则：同框两人及以上的 `[Shot N]` 里换场景，模型会让人瞬移、背景混在一起。
- 适用条件：两人以上同框的镜头，剧情要换场景。
- 正确写法：换场景处切镜（CAM-007 写法），或按 M06 分段；切后那一镜重新写人数和每人位置（M48 第 5 条）。
- 错误写法：镜头跟着两人从走廊一路走进办公室，中间没有切点。

## 二、八种大师镜头（知识库「八种电影级大师镜头」，按本剧口径改写）

通用约束：一镜一种运动；不做无动机环绕；心声镜不用这些手法（正面近景，固定或慢推）；有台词、面板、冲击命中、大动作的镜不用运动手法（CAM-001）；名额照 `short-drama-camera-system.md` 重技法表。以下全部【待测】。

### CAM-011 低角度登场（斯皮尔伯格镜头）【待测】
- 原则：人物从画面下方升起撑满画框，压迫感、气场。原片是右移→升起→绕背→转正面三种运动，本剧只收「机位固定、人物升起」。
- 适用条件：强者首次登场、反派压场、主角站起反击。站起是大动作（M45），所以机位固定、无台词；计入大仰角名额（每集 ≤ 3）。不写广角，3D 人物用广角会拉长头身比。
- 正确写法：`Low-angle medium shot, the camera at knee height about two metres in front of <Name>, tilted up. The camera holds a fixed position (static shot) for the whole shot. <Name> rises from the sofa below the frame edge until his head and shoulders fill the upper half of the frame, his proportions unchanged.`
- 错误写法：`Spielberg shot, wide-angle lens, the camera orbits behind him then swings to the front` —— 三种运动加广角畸变。

### CAM-012 弧形环绕（环绕运镜）【待测】
- 原则：只收小角度弧形（H3 的 `arc shot`），不收 360 度环绕；必须有动机（关系揭示、高光一刻）。
- 适用条件：单人、站定、没有台词和手物接触；弧线不越轴（M48 第 2 条），起止都在轴线同一侧；每场 ≤ 1、全片 ≤ 3。
- 正确写法：`The camera arcs slowly with small amplitude from <Name>'s left front to directly in front of him, about a quarter circle, staying on the same side of the line, keeping him centre frame; he lifts his chin and looks straight ahead.`
- 错误写法：`360-degree orbit around him`；心声镜环绕；绕到另一侧导致左右互换。

### CAM-013 主观视角（POV）【待测】
- 原则：镜头当成人物的眼睛，用于发现、看证据、被逼近。
- 适用条件：通常作 CAM-005 的被看物镜；POV 主人不入画，也不在这一镜说话；画面里出现他的手时写明是谁的哪只手（M48 第 11 条），手物接触仍算难事；只用 `shakes slightly`；每场 ≤ 1、全片 ≤ 3。
- 正确写法：`POV shot from <Name>'s eyes at standing height: his own right hand holds the phone low at the bottom of the frame; ahead, <B> walks toward the camera down the corridor. The camera shakes slightly with his breathing.`
- 错误写法：POV 镜里又写 `<Name> stands in the corridor` 出现他的全身；剧烈晃动当恐怖片拍。

### CAM-014 滑动变焦（希区柯克变焦）【待测】
- 原则：人物大小不变、背景拉伸，表现认知崩塌、真相击穿。H3 运镜表没有现成词，用「后拉 + 光学推进」两个动作同时写。
- 适用条件：只用在全集心理最失衡的一刻；FIXED 的人物，只有眼眉反应，无台词、无心声、无面板；背景要有纵深线条（走廊、长街）并绑了场景图；名额从严（见末尾冲突）。
- 正确写法：`Medium close-up of <Name> in the corridor. The camera pulls out at slow speed while zooming in at the same rate, so his face stays exactly the same size in frame while the corridor behind him stretches away; the movement is smooth and even. He stares ahead, eyes widening.`
- 错误写法：只写 `zoom in` 或 `dolly zoom`；同一镜再加环绕；把它当普通推镜到处用。

### CAM-015 FPV 穿越（不收）
- 本剧不用：都市写实没有飙车、飞行这类题材；FPV 是俯冲→贴近→漂移→拉升多段高速运动，违反一镜一种运动；路线穿越大片没有场景参考图的空间；高速下人物一致性和「不穿墙」都保不住。分镜点名 FPV 时改成 CAM-018 跟拍或固定全景，并在报告里写明。

### CAM-016 遮挡转场（只收成跨镜遮挡点）【待测】
- 原则：原片在一个镜头里借前景遮挡换场景，违反 CAM-010 和 S14 第 7 条（伪一镜到底只在两条分镜之间用完全遮挡点），所以镜内换场景不收。
- 适用条件：两条分镜之间要藏剪辑点；遮挡物是场景里登记过的柱子、门框、人物背部或暗部，不临时加路人（未登记的路人不入画）。
- 正确写法：前一镜结尾 `In the last second the camera trucks right at slow speed past the concrete pillar in the foreground, which fully covers the frame.`；后一镜开头 `The video begins with the same grey pillar sliding off the lens to screen-left, revealing <Name> at the office door`，两边运动方向、速度、光线一致。IC 不做首尾帧接链，后一镜要自己写全起始状态。
- 错误写法：`a passer-by blocks the camera and the scene changes to a café` 写在同一个镜头里。

### CAM-017 轻微手持感【待测】
- 原则：纪实感、人物互动更真实。晃动必须有来源（行驶的车厢、奔跑、紧张），只用「轻微」。
- 适用条件：车内、地铁、紧张对峙前；心声镜、面板镜、冲击命中镜不用；手持就是这一镜唯一的运动，不再叠推拉；剧烈晃动计入 `short-drama-camera-system.md` 名额（每集 ≤ 3 段落）。
- 正确写法：`The camera shakes slightly, as if handheld inside the moving bus, staying about one metre from <Name>; she glances up at the camera, then smiles.`
- 错误写法：`shaky cam throughout`、`shakes strongly` 用在对话戏；手持再加 `pushes in and out`。

### CAM-018 低机位背后跟拍（跟拍镜头）【待测】
- 原则：跟在人物身后半米到一米，临场感强，用于赶路、进入新环境。只收第三人称背后跟拍，第一人称归 CAM-013。
- 适用条件：同一空间内行走，沿途有地标；被跟的人背对镜头，不说话（说话人要脸入画）；步态照 `fight-v44.md` 第 2 条；整条只有这一种运动。
- 正确写法：`The camera follows <Name> from behind at waist height, about one metre back (tracking shot), at walking speed along the alley, passing the closed shutter of a repair shop on screen-left; he walks with long strides, shoulders swinging, and slows over the last two steps.`
- 错误写法：跟拍中途 `the camera swings around to his face`；被跟的人背对镜头说台词。

## 三、自检（交稿前逐镜）
1. 非 FIXED 镜难事只有运镜一件（CAM-001）；运镜句四段齐全、只写一次（CAM-002）。
2. 每个 `[Shot N]` 只有一种人声，切点格式 `[Shot N] At MM:SS.mmm,`，每个镜头 ≥ 3 秒，人声不跨切点（CAM-003、006）。
3. 每个切点六项齐（CAM-004）；证据镜停够再切反应（CAM-005）；跳时写了地点和持物（CAM-007）。
4. 远景开场每场景全章一次（CAM-008）；单人镜来回后有双人镜（CAM-009）；多人镜没有镜内换场景（CAM-010）。
5. 用了 CAM-011–018 的：名额没超，没有用在心声、面板、冲击、台词镜，没有叠第二种运动。

## 四、和现有规则的冲突（待总导定，定之前按手册条款写）
- base-en §4.4 允许用 `<scenetrans>` 让台词跨切点；手册 M33 第 6 条和第 5 章禁止人声跨切点。本技能按手册（CAM-006）。
- M41 允许组合表没有含⑦的组合；S14 第 3 条把「两人边走边说」列为最好做的一镜到底，`fight-v44.md` 的 ONE-TAKE 逼近正例也是运镜加两人动作。按手册即应拆镜。
- 滑动变焦名额：`short-drama-camera-system.md` 写全片 ≤ 1，本次需求写每集 ≤ 1。草稿暂按「全片 ≤ 1」从严。
- `short-drama-camera-system.md` 主张「平静镜头优先微运镜」，和 M51 第 2 条「非固定机位算难事」、H1-003「无标记按 FIXED」方向相反；本技能按手册。
- 3D 基底禁「特写 × 平视正面」（camera-system §三·五），心声镜又规定正面近景；本技能不动心声镜写法。
