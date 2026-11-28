// 首尾帧控制 S3：用灰模 + 结构控制 + 人物定妆参考出一张写实关键帧（首帧或尾帧）。
// 做法（第 1 章第 18 镜实测定下，临时规则「首尾帧控制审图」第二节）：
//   Qwen-Image-Edit 2511 + Lightning 4 步；DiffSynth ControlNet 补丁：线稿 1.0 + 深度 0.6 叠加；
//   灰模当底图做图生图（重绘 0.9：脸那一面肤色、后脑黑，把朝向带进来）；人物定妆图接编辑编码器 image1–3。
// 走 backend.generateTask（GPU 闸门 + 端点池，和出片同一套排队），一次一张。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateTask, uploadTaskInput, downloadTaskOutput } from './backend.js';
import { resolveProjectPath } from './refs.js';
import { rigRel } from './camera-rig.js';

export const KEYFRAME_DEFAULTS = Object.freeze({
  unet: 'qwen_image_edit_2511_fp8mixed.safetensors',
  lora: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
  clip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
  canny: 'qwen_image_canny_diffsynth_controlnet.safetensors',
  depth: 'qwen_image_depth_diffsynth_controlnet.safetensors',
  shift: 3.1, steps: 4, cfg: 1.0,
  edge_strength: 1.0, depth_strength: 0.6, denoise: 0.9,
  megapixels: 1.0,
});

export function keyframeSettings(cfg) {
  return { ...KEYFRAME_DEFAULTS, ...((cfg && cfg.keyframeRig && cfg.keyframeRig.models) || {}), ...((cfg && cfg.keyframeRig && cfg.keyframeRig.params) || {}) };
}

/** 约 1 MP、宽高都是 16 的倍数、保持比例。 */
export function targetSize(w, h, mp = 1.0) {
  const s = Math.sqrt((mp * 1048576) / (w * h));
  return { W: Math.max(256, Math.round((w * s) / 16) * 16), H: Math.max(256, Math.round((h * s) / 16) * 16) };
}

/**
 * 组工作流（纯函数，测试直接比结构）。
 * @param inp { edge, depth, gray, refs:[name…≤3]（已上传到 ComfyUI input 的文件名）, prompt, seed, W, H, prefix }
 */
export function buildKeyframeWorkflow(inp, settings = KEYFRAME_DEFAULTS) {
  const S = settings;
  const scale = (id, src) => ({ [id]: { class_type: 'ImageScale', inputs: { image: [src, 0], upscale_method: 'lanczos', width: inp.W, height: inp.H, crop: 'center' } } });
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: S.unet, weight_dtype: 'default' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: S.lora, strength_model: 1.0 } },
    3: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: S.shift } },
    4: { class_type: 'CLIPLoader', inputs: { clip_name: S.clip, type: 'qwen_image', device: 'default' } },
    5: { class_type: 'VAELoader', inputs: { vae_name: S.vae } },
    6: { class_type: 'LoadImage', inputs: { image: inp.edge } },
    ...scale('61', '6'),
    7: { class_type: 'ModelPatchLoader', inputs: { name: S.canny } },
    8: { class_type: 'QwenImageDiffsynthControlnet', inputs: { model: ['3', 0], model_patch: ['7', 0], vae: ['5', 0], image: ['61', 0], strength: S.edge_strength } },
    9: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['4', 0], prompt: inp.prompt } },
    10: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['4', 0], prompt: '' } },
    12: { class_type: 'KSampler', inputs: { model: ['8', 0], positive: ['9', 0], negative: ['10', 0], latent_image: null, seed: Number(inp.seed) || 0, steps: S.steps, cfg: S.cfg, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0 } },
    13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    14: { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: inp.prefix || 'ic_keyframe' } },
  };
  if (inp.depth) {
    wf[21] = { class_type: 'LoadImage', inputs: { image: inp.depth } };
    Object.assign(wf, scale('211', '21'));
    wf[22] = { class_type: 'ModelPatchLoader', inputs: { name: S.depth } };
    wf[23] = { class_type: 'QwenImageDiffsynthControlnet', inputs: { model: ['8', 0], model_patch: ['22', 0], vae: ['5', 0], image: ['211', 0], strength: S.depth_strength } };
    wf[12].inputs.model = ['23', 0];
  }
  const refs = (inp.refs || []).slice(0, 3);
  if (refs.length) wf[9].inputs.vae = ['5', 0];
  refs.forEach((name, i) => {
    const id = String(30 + i);
    wf[id] = { class_type: 'LoadImage', inputs: { image: name } };
    wf[9].inputs['image' + (i + 1)] = [id, 0];
  });
  if (inp.gray) {
    wf[15] = { class_type: 'LoadImage', inputs: { image: inp.gray } };
    Object.assign(wf, scale('151', '15'));
    wf[16] = { class_type: 'VAEEncode', inputs: { pixels: ['151', 0], vae: ['5', 0] } };
    wf[12].inputs.latent_image = ['16', 0];
    wf[12].inputs.denoise = inp.denoise != null ? inp.denoise : S.denoise;
    if (Array.isArray(inp.mask) && inp.mask.length === 4) {
      // 局部重画：只在 mask 框（0–1）里重画，框外保持底图
      const [x0, y0, x1, y1] = inp.mask.map(Number);
      const bx = Math.max(0, Math.round(x0 * inp.W)); const by = Math.max(0, Math.round(y0 * inp.H));
      const bw = Math.max(8, Math.round((x1 - x0) * inp.W)); const bh = Math.max(8, Math.round((y1 - y0) * inp.H));
      wf[40] = { class_type: 'SolidMask', inputs: { value: 0.0, width: inp.W, height: inp.H } };
      wf[41] = { class_type: 'SolidMask', inputs: { value: 1.0, width: bw, height: bh } };
      wf[42] = { class_type: 'MaskComposite', inputs: { destination: ['40', 0], source: ['41', 0], x: bx, y: by, operation: 'add' } };
      wf[43] = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['16', 0], mask: ['42', 0] } };
      wf[12].inputs.latent_image = ['43', 0];
    }
  } else {
    wf[11] = { class_type: 'EmptySD3LatentImage', inputs: { width: inp.W, height: inp.H, batch_size: 1 } };
    wf[12].inputs.latent_image = ['11', 0];
  }
  return Object.fromEntries(Object.entries(wf).map(([k, v]) => [String(k), v]));
}

/**
 * 出一张关键帧，存到 frames/rig/<shotId>/cand/<which>_s<seed>.png，返回相对路径。
 * @param views  renderRig 返回的 first/last：{ gray, depth, edge }（项目内相对路径）
 * @param refAbs 人物定妆图的本机绝对路径（≤3）
 */
export async function generateKeyframe(cfg, projectId, shotId, which, views, { prompt, refAbs = [], seed = 7, size = [1280, 720], jobId, isAborted, init = '', mask = null, denoise = null, tag: outTag = '', deps = {} } = {}) {
  const gen = deps.generateTask || generateTask; const up = deps.uploadTaskInput || uploadTaskInput; const dl = deps.downloadTaskOutput || downloadTaskOutput;
  if (!views || !views.edge) throw new Error('没有' + (which === 'last' ? '尾' : '首') + '帧的线稿控制图，先渲灰模');
  const S = keyframeSettings(cfg);
  const { W, H } = targetSize(size[0], size[1], S.megapixels);
  const tag = 'ic_kf_' + String(shotId).slice(0, 8) + '_' + which + '_' + crypto.randomBytes(3).toString('hex');
  const upload = async (rel, kind) => {
    const abs = path.isAbsolute(rel) ? rel : resolveProjectPath(projectId, rel);
    if (!abs || !fs.existsSync(abs)) throw new Error('文件不存在：' + rel);
    return up(cfg, abs, tag + '_' + kind + path.extname(abs).toLowerCase());
  };
  const edge = await upload(views.edge, 'edge');
  const depth = views.depth ? await upload(views.depth, 'depth') : '';
  const gray = (init || views.gray) ? await upload(init || views.gray, init ? 'init' : 'gray') : '';
  const refs = [];
  for (const [i, a] of refAbs.slice(0, 3).entries()) refs.push(await upload(a, 'ref' + (i + 1)));
  const wf = buildKeyframeWorkflow({ edge, depth, gray, refs, prompt, seed, W, H, mask, denoise, prefix: 'ic_keyframe/' + tag }, S);
  const r = await gen(cfg, wf, { jobId, isAborted });
  const img = (r.outputs || []).find((o) => /\.(png|jpe?g|webp)$/i.test(o.filename || ''));
  if (!img) throw new Error('关键帧没有产出图片');
  const buf = await dl(cfg, img);
  const rel = rigRel(shotId, 'cand', which + '_s' + seed + (outTag ? '_' + outTag : '') + '.png');
  const abs = resolveProjectPath(projectId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { rel, prompt_id: r.prompt_id, seed, W, H };
}
