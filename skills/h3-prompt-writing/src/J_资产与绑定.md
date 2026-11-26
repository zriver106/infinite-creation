<!-- rulebook: id=J tier=volume when=binding,scene -->
## J 资产与绑定

### 〔J-001〕 Scene reference image time-of-day and lighting — 场景图时段光色一致

H3 copies the lighting of a bound scene reference image almost unchanged: time of day, sun angle, warm or cool cast, and which lamps are lit. Text such as "use it only as a layout reference; do not take its lighting" does not override it. Before binding a scene reference, look up its class in the project's scene time-and-lighting table (built by looking at the images; the asset description's 状态 field is not reliable): daylight from above / low-angle warm sun / night / interior artificial light / multi-panel board; lamps lit or not; indoor, outdoor or car.

1. **Blocking errors are only clear conflicts.** (a) Day and night reversed: a night shot bound to a daylight or warm-sun image, or a day shot bound to a night image. (b) The image has lamps lit and the shot gives no reason for them: the shot says the lights are off, or it is a daytime exterior and the shot never mentions lamps. (c) Indoor and outdoor light sources that cannot match: an exterior shot bound to a purely artificially lit interior image, or an interior shot bound to an exterior image.
2. **Explainable differences are warnings, not unbinding.** Warm vs cool, early morning vs late afternoon, "morning" vs a low warm sun, lamps on in an interior: keep the image and rewrite the prompt's lighting to match it (e.g. the balcony image has a low warm sun, so write `early-morning warm low sun with long shadows`). Never write lighting that contradicts the bound image.
3. **Inherit first.** If shots of the same scene have already been rendered and accepted with a scene image, later shots of that scene bind the same image and describe the same light, unless that image has a blocking error for this shot.
4. **Fixing a blocking error.** (a) Bind another final image of the same place whose time and lighting match. (b) Otherwise unbind the scene image and write the layout in the prompt as text, inside `detailed_description` after the style and lighting sentences: `Location (no scene reference image is used for this shot; build the place from this description): <the place, its main surfaces and furniture, depth, and what is on screen-left / screen-right>.` Remove the scene's `subject_definitions` and `retention_analysis` lines and every `(__MINIMAX_H3_REF_n__)` that pointed at it, renumber the remaining references in binding order, and change "identity and location references only" to "identity references only". Keep the shot's time-of-day and lighting sentence. Never keep a conflicting image with a "layout reference only" disclaimer.

### 〔J-002〕 Close framing on a wide scene reference — 场景图是全景、本镜是中景/近景/特写

When the bound scene reference image is a wide or establishing shot and this shot is a medium shot, a medium close-up or a close-up, H3 copies the whole wide layout from the image and shrinks the characters to fit it. For every such shot:

1. **The shot-size sentence comes first and is explicit.** It is the first sentence of the prompt (free-text prompts) or the first sentence of `summary` and of `detailed_description` (Ref2VA sections; `subject_definitions` stays first). Name the size, the body crop and the face size, e.g. `Medium shot, framed from the waist up; each face is about one quarter of the frame height.` / `Medium close-up from the chest up; the face fills about one third of the frame height.` / `Close-up of the lead's face; the face fills most of the frame height.` (中景/腰部以上/脸约占画面高度 1/4). Do not open with the location.
2. **The scene reference describes only the background visible behind the character.** Its definition says what this framing shows behind and beside the character (e.g. `__MINIMAX_H3_REF_2__ is the background behind the lead: the green wall with the gold peony relief`), not the whole room.
3. **Retention is "background only / partially".** Ref2VA: `__MINIMAX_H3_REF_n__: partially_preserved - background only: <what is visible behind the character>`. Free text: `use __MINIMAX_H3_REF_n__ for the background only, partially`. Never `fully_preserved` for the scene in such a shot.
4. **The layout list keeps only what this shot can show.** Keep the items behind or next to the character in this framing; drop the far door, distant tables, the ceiling chandelier and anything else that cannot be in frame at this size.
5. If the scene image itself is already a medium or close view of that spot, rules 2–4 are already met; rule 1 still applies.

#### 〔J-003〕 J-003【待测】不用 IC 自建资产（G11）

绑定的人物、场景、道具都要是我方登记过的资产（描述里有「我方资产ID…审核：final」）；没有的不绑，报管理会话补资产，不让 IC 自己画一张顶上。

#### 〔J-004〕 J-004【待测】已归档、勿用的资产不绑（G26）

资产标了归档或勿用的，一律不绑；剧情还要用的，先有可用定稿再写这一镜。

#### 〔J-005〕 【待测】绑场景图前核对用途：图是什么地方，这一镜就在什么地方（G08，txt L100）

- 原则：H3 几乎原样照场景图画（J-001 讲的是光线，场所的结构同理）。图像别的场所时，提示词里再怎么写「这是某某部门」也改不过来。场景图合不合格由资产环节审（adapt-rules J-002），本条是写稿前的最后一道核对。
- 适用条件：每个绑了场景图的镜，写提示词之前；写视频提示词的人。
- 正确写法：
  1. 读场景资产描述里的用途、必须有的标志物、不能像的场所，和这一镜分镜写的地点、这场戏要做的事对一遍。对得上才写。
  2. 对不上，或图里明显有别的场所才有的结构：不绑着它硬写，也不靠一句「只当布局参考」去压；在报告里写明，退回换图或补资产（adapt-rules J-002、J-003）。
  3. 提示词里的场所描述照图和资产描述写，不写图里没有的标志物，不写和图冲突的场所名。
  4. 同一个场景、同一剧情阶段的各镜绑同一张合格的图（阶段变了按 adapt J-006 换登记过的阶段变体）、写同一句场所句（F-005）；不因为这一镜的图不合适就单独换一张别处的图顶替。一个地点全剧只认一个场景资产（adapt-rules J-004）；地点名和登记表对不上的，报告。
  5. 场所句只起加固作用，可以点出这是哪类场所、有哪两三样标志物；不能拿它当图不合格的补救。
- 可用短句：
  - `The scene is <an ordinary open-plan office area>: <rows of desks with monitors, a filing cabinet, a potted plant by the window>; it stays this same place from the first frame to the last.`
  - 报告句：`Scene check: the bound scene image's stated use matches this shot's location and action.`
  - 报告句：`Shot <n>: the bound scene image looks like <another kind of place> (it shows <the conflicting structure>); returned for a new scene image, prompt not written.`
- 错误案例：见 `C:\Users\usazr\Documents\moviePro\docs\通用规则_错误案例.md` CASE-028
