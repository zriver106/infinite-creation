---
name: image-prompt-writing
description: 为 Krea2 超写实文生图（t2i）与 Qwen-Image-Edit-2511 图生图（i2i）编写中英文提示词。使用时机：为漫剧项目生成人物三视图、场景环境图、道具白底图等资产生图，或基于参考图做一致性变体。输出 prompt 与 negative_prompt。
---

# 图像提示词编写（Krea2 t2i / Qwen i2i）

为资产生图工作流编写提示词。本工程文生图走 Krea2 超写实工作流（节点 CLIPTextEncode），图生图走 Qwen-Image-Edit-2511（参考图 + 指令）。

## 按资产类型选尺寸与构图

- **人物 character → 16:9**：角色设定图，左侧 1/3 为人物上半身脸部特写（头肩/胸部以上，突出五官/发型/神态/气质），右侧 2/3 为从头到脚的完整全身三视图（正面、侧面、背面，头顶到脚尖完整入画、不得裁切），同一人物外貌/服装/配色完全一致，简洁浅色背景，横向布局。
- **场景 scene → 16:9**：环境氛围、空间透视、光线与风格，画面完整可作背景。多视角定义图（`_MV`）按 adapt-rules 参考文件「资产出图与审图.md」的三步法出（先 A，再换视角出 B、C，D 平面图最后），不一次出四格。
- **道具 prop → 1:1**：纯白背景，画面只出现该道具本身，突出形状/材质/细节；道具自带的文字/标签/包装说明/品牌 logo 要保留并写清内容。

## prompt 编写规则

1. 结构化优于叙事化：按「主体 → 环境/背景 → 光照/材质/色调/视角」分类描述，1~3 句，80~150 字。
2. 先主体核心特征，再环境，最后细节（材质、光影、色调、镜头视角）。
3. 明确镜头视角（特写/中景/全景、正面/侧面/背面、平视/俯视/仰视）。
4. 风格照缺图单开头的「画风」段原文写（照片级写实；不写「动漫」「国漫」「二次元」「插画」和项目风格名）；人物、人群写「中国人长相，当代中国城市普通市民穿着」。
5. **真实文字只限道具包装**（包装标签、道具品牌名/logo），写清文字内容与位置；场景、人物图里不出现可读文字（招牌、屏幕文案等不画字），也不要字幕条、水印、签名或乱码。系统光幕等 UI 母版的字逐字照缺图单写。

## negative_prompt 规则

通用排除：`blurry, low quality, pixelated, distorted, watermark, oversaturated, artificial, plastic-looking`。
人物类额外排除：`extra fingers, deformed hands, mutated hands, fused fingers, plastic skin, over-smoothed`。
不要排除 `text, letters, words, logo, signature`——把文字写进负向提示词会让产品包装、书封、招牌上的字被擦掉。

## 输出

每个资产输出 JSON：`{"prompt":"...","negative_prompt":"..."}`。prompt 用英文（写实模型对英文响应更好），结构清晰、具体可执行。

## 调用方式

写好后用 `update_asset(id, {prompt, negative_prompt})` 写入对应资产，再用 `generate_asset_image(asset_id)` 或 `generate_assets_batch` 统一提交（批量时优先，避免反复切换工作流导致模型重载）。图生图变体用 `edit_asset_image(asset_id, prompt, reference_asset_id)`。人物换装用 `change_outfit(character_id, outfit)`（生成服装资产，category=costume）。若模型支持图片输入，写提示词前先用 `view_asset(asset_id)` 查看参考图，基于真实图写提示词。


## 本项目补丁：资产生成必须先复用素材库（2026-11-16）

完整判定步骤见同目录草稿的精神，以下为强制规则。需要规范原文时再 `skill_reference`。

1. 动手前先 `list_assets`。凡是 `source=uploaded` 且 `status=done`、已有图或音频的，必须按素材库原名引用。禁止为同一主体再 `create_asset` 近义名，禁止对这类资产 `update_asset` 写入或改写 `prompt`（否则旧逻辑会重画出图；代码已禁止自动覆盖，但仍不要去改提示词）。
2. 分镜的 characters / scenes / props / costumes 必须用库里的中文原名。系统已用 nameMatches 做去重和绑定，但不要自行把「邻座男同事」改成「男同事」碰运气。
3. 库里没有的人物、场景、道具才 `create_asset`。生成须符合我们的资产标准：全剧一种已定风格、一套角色一张脸；人物先出 B 基准（可用左特写+右三视图构图以适配工作流，外貌按基准描述）；服装只在真实换装事件时补，并挂 parent_id。特效/界面先复用已导入的 prop。非 final、仅候选的图不得当正式参考。
4. 角色缺 Q 版设定、且本章按 Q 版规则确需使用时：以该角色已上传 B 基准做图生图（`edit_asset_image` 或 `generate_asset_from_reference`），名称用「角色名·Q版设定」，描述写明 CHIBI、不是换身份。两种呈现：旁边加小人，或换成 Q 版头。只在极端情绪使用。（v4）先看任务里的「本项目表现手段开关」：「Q版插入」关掉时不建 Q 版资产。素材库已有「角色名·Q版设定」就直接复用，不再新建、不重画。新建时只在分镜确实排了 Q 版镜头之后再做；画成单人、全身、纯浅色背景的一张 Q 版形象（偏酷冷面、不卖萌，发型发色与服装配色同 B 基准），不要做三视图或多格拼板（拼板会被视频模型拍进画面）。这张图只作 Q 版参考，绝不替换、覆盖或重画我方上传的写实 B 基准。**（v4.2 硬规则）登记方式：** `create_asset(category="prop", name="角色名·Q版设定")` 后立即 `edit_asset_image(asset_id=新资产, reference_asset_id=该角色人物资产)` 出图；不要登记成 costume / age（IC 渲染时 costume / age 会替换写实主图，`lib/core/refs.js` `assembleShotReferences`）。Q 版镜头在分镜 `props` 里绑定它，渲染时作为独立参考图进 REF。全剧只有这一张，各章复用，不每章重画，不建近义名。
5. 已上传的 `category=voice` 必须先 `register_voice`（或素材库 PATCH voice_ref）登记到对应人物。已有 `voice_ref` 的人物禁止再 `design_voice`。

