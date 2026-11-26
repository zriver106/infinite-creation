<!-- rulebook: id=H2L tier=volume when=expression_slang -->
## H2L 流行语、段子与谐音（冷门）

### 〔H2L-001〕 Slang, jokes and homophones — moved verbatim from H2-001 (items 10, 11 and the 谐音 example), 2026-11-25

Items 0 and 0b and the v4.4 rule are in volume H2C, read with every 【表现】 shot.

**10. Display text vs voiced text.** The storyboard `dialogue` field is the on-screen subtitle text; `<d></d>` is what the voice actually says. They are identical for every line, except a censor-safe homophone line marked `【表现】Ln｜谐音｜配音替换：「X」读作「Y」` — then `<d>` carries Y, not X. Example: `dialogue` = `主角：我cy！`, so write `<d>[Chinese] 我去！</d>`. Never put 「我cy」 inside `<d>`, never voice the original swear word, and keep every other line inside `<d>` character-for-character equal to `dialogue`.
- The voiced word for the censor-safe exclamation is 我去 (never 我超, which H3 pronounces close to the swear word). Delivery: `He blurts out <d>[Chinese] 我去！</d> under his breath, short and punchy, a clear "wǒ qù".` Keep the speaker's lip-sync natural for a spoken line (this is not an OS line).

**11. Slang and comeback delivery.** A line upgraded with slang or a comeback (marked `【表现】Ln｜流行语…` or `【表现】Ln｜段子…`) is acted, not decorated: a half-second beat of silence after the other person's line, then <Name> answers flatly, one eyebrow slightly raised, a small one-sided smirk, eyes steady on the other person; if the other person's face is visible in the shot, his own face shows at least in profile while he speaks (see E-001 in volume E2); then he goes straight back to business. No VFX, no chibi and no text on screen for these lines.

**正例（谐音）：** storyboard `dialogue` = `主角：我cy！`, visual first line `【表现】L1｜谐音｜配音替换：「我cy！」读作「我去！」` → `The lead glances left and right down the empty corridor, leans in over the gold bar and blurts out <d>[Chinese] 我去！</d> under his breath, short and punchy, a clear "wǒ qù".`
