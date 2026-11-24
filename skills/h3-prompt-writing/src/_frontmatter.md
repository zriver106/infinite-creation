---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. Also covers storyboard-contract driven multi-segment generation: drafting a storyboard.json from a novel/script with a local or remote LLM, then compiling it into consistent per-segment H3 prompts (Ref2VA/T2VA first segment + FL2VA continuations) with no repeated segments and no positional or identity drift.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---
