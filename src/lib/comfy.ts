import "server-only";

/* Rendus IA open source avec ComfyUI sur GPU :
   - photo : Qwen-Image-Edit 2511 (ou 2509) + Lightning (capture 3D → photo réaliste), guidé par la carte de
     profondeur exacte de la 3D pour que murs, portes et fenêtres restent ceux du plan ;
   - visite : photo de la première image d'un plan de la visite guidée, puis Wan 2.2 Fun Control qui suit la
     profondeur de la visite image par image (la caméra et la géométrie sont celles de la 3D) ;
   - vidéo : Wan 2.2 image → vidéo 14B + accélération 4 étapes (photo → plan de 5 s, libre).
   Les modèles sont choisis d'après ce que le ComfyUI du pod propose (noms de fichiers des templates RunPod compris).
   Deux façons de joindre le GPU :
   - RunPod Serverless (RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY) : on ne paie que pendant les calculs ;
   - un ComfyUI direct (COMFYUI_URL), par exemple un pod joint par tunnel SSH. */

export const COMFY = process.env.COMFYUI_URL?.replace(/\/$/, "") ?? "";
const RP_ENDPOINT = process.env.RUNPOD_ENDPOINT_ID ?? "";
const RP_KEY = process.env.RUNPOD_API_KEY ?? "";
export const SERVERLESS = !!(RP_ENDPOINT && RP_KEY);
export const CONFIGURED = SERVERLESS || !!COMFY;

export const PHOTO_PROMPT =
  "Change the image to a realistic photograph. Turn this 3D render into a real interior photograph: keep exactly the same " +
  "room layout, walls, doors, windows, camera angle and furniture positions. Natural daylight through the windows, " +
  "soft realistic shadows, real materials (wood parquet, matte painted plaster walls, fabric upholstery), " +
  "professional real-estate photography, 24mm lens, high detail.";

/* vue maquette (de dessus, murs coupés) : une vraie maison vue du ciel, pas une maquette posée dans une pièce */
export const AERIAL_PROMPT =
  "Change the image to a realistic photograph. Turn this 3D model into a real house photographed from above by a drone, " +
  "roof removed to show the interior (architectural cutaway view of a real built house, not a miniature model). Keep exactly " +
  "the same floor plan, walls, rooms, doors, windows and furniture positions. Real materials: plastered walls, tiled and wooden floors, " +
  "real furniture, the house stands on its real plot with grass and paving around it. Natural sunlight, realistic architectural visualization.";

/* vue façade (maquette fermée, toit-terrasse) : la vraie maison, photographiée de l'extérieur */
export const FACADE_PROMPT =
  "Change the image to a realistic photograph. Turn this 3D model into a real photograph of this exact house exterior: " +
  "a contemporary single-storey villa in a residential neighborhood of Cotonou, Benin, flat concrete roof with parapet, " +
  "smooth plastered walls painted in warm light tones, real windows with aluminium frames and glass, wooden entrance door, " +
  "paved courtyard, tropical garden with palm trees and bougainvillea, blue sky, warm afternoon sunlight. Keep exactly the " +
  "same building shape, proportions, walls, windows and doors. Professional architectural photography.";

export const FACADE_VIDEO_PROMPT =
  "Slow smooth drone shot slowly orbiting around this real house exterior, steady camera, warm afternoon sunlight, " +
  "tropical garden, realistic architectural video, no people.";

export const AERIAL_VIDEO_PROMPT =
  "Slow smooth drone orbit around this real house seen from above with the roof removed, steady camera, natural sunlight, " +
  "realistic architectural visualization, no people.";

export const VIDEO_PROMPT =
  "Slow smooth forward dolly shot through this real house interior, steady camera, natural daylight, " +
  "realistic materials, cinematic real-estate video, no people.";

/* ajoutée quand la carte de profondeur accompagne la capture (image 2) */
export const DEPTH_PROMPT =
  " Image 2 is the exact depth map of image 1 (white = near, black = far): every wall, opening, ceiling edge and piece of " +
  "furniture must stay exactly where the depth map places it, with the same proportions. Do not add, remove or move " +
  "anything. Output only the realistic color photograph of image 1.";

export const TOUR_VIDEO_PROMPT =
  "Smooth steady walkthrough of this real house interior, the camera follows the control video exactly, natural daylight, " +
  "realistic materials, the same furniture and finishes as the reference photo, cinematic real-estate video, no people.";

const VIDEO_NEGATIVE = "blurry, distorted geometry, warped walls, flickering, people, person, silhouette, text, watermark, low quality, cartoon, 3d render";

type Node = { class_type: string; inputs: Record<string, unknown> };
export type Workflow = Record<string, Node>;

/* ---------- modèles présents sur le pod ---------- */

type Spec = unknown[];
type Info = Record<string, { input: { required?: Record<string, Spec>; optional?: Record<string, Spec> } }>;
let infoCache: { at: number; data: Info } | null = null;

/** Description des nœuds du ComfyUI (relue toutes les 30 s : on installe parfois des modèles en cours de séance). */
async function objectInfo() {
  if (!infoCache || Date.now() - infoCache.at > 30_000) infoCache = { at: Date.now(), data: await (await comfy("/object_info")).json() };
  return infoCache.data;
}

/** Valeurs proposées par une liste déroulante (ancien et nouveau format de ComfyUI). */
function choices(info: Info, node: string, input: string): string[] {
  const spec = info[node]?.input.required?.[input] ?? info[node]?.input.optional?.[input];
  if (!spec) return [];
  if (Array.isArray(spec[0])) return spec[0] as string[];
  const opts = (spec[1] as { options?: unknown[] } | undefined)?.options;
  return Array.isArray(opts) ? opts.map((o) => (typeof o === "string" ? o : (o as { key: string }).key)) : [];
}

const pick = (list: string[], ...tests: ((f: string) => boolean)[]) => {
  for (const t of tests) {
    const f = list.find(t);
    if (f) return f;
  }
  return null;
};
const has = (...res: RegExp[]) => (f: string) => res.every((r) => r.test(f));
const fp8 = /fp8|e4m3/i;
const notMerged = (f: string) => !/lightning/i.test(f); // modèle avec Lightning déjà fusionné : on garde la LoRA à part

export interface Models {
  qwen: { unet: string; clip: string; vae: string; lightning: string | null; steps: number; real: string | null; v2511: boolean; refMethod: boolean };
  wan: { clip: string; vae: string };
  i2v: { high: string | null; low: string | null; loraHigh: string | null; loraLow: string | null };
  control: { high: string; low: string } | null;
  /** affinage et passage en 1080p (SeedVR2, téléchargé tout seul au premier usage) */
  seedvr2: { dit: string; vae: string } | null;
  /** images intermédiaires (RIFE / FILM) */
  interp: string | null;
}

const DEFAULTS: Models = {
  qwen: {
    unet: "qwen_image_edit_2511_fp8mixed.safetensors",
    clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    vae: "qwen_image_vae.safetensors",
    lightning: "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors",
    steps: 8,
    real: null,
    v2511: true,
    refMethod: true,
  },
  wan: { clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", vae: "wan_2.1_vae.safetensors" },
  i2v: {
    high: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    low: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    loraHigh: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    loraLow: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
  },
  control: { high: "wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors", low: "wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors" },
  seedvr2: null,
  interp: null,
};

/** Choisit les fichiers parmi ceux du pod : 2511 de préférence, fp8 de préférence (48 Go suffisent). */
export async function pickModels(): Promise<Models> {
  if (SERVERLESS) return DEFAULTS; // pas d'accès direct au ComfyUI : noms des fichiers installés par install_models.py
  const info = await objectInfo();
  const unets = choices(info, "UNETLoader", "unet_name");
  const loras = choices(info, "LoraLoaderModelOnly", "lora_name");
  const clips = choices(info, "CLIPLoader", "clip_name");
  const vaes = choices(info, "VAELoader", "vae_name");
  const missing = (what: string): never => {
    throw new Error(`Modèle absent sur le pod : ${what} (lancer scripts/runpod/install_models.py)`);
  };

  const edit =
    pick(unets, (f) => has(/qwen.*edit.*2511/i, fp8)(f) && notMerged(f), (f) => /qwen.*edit.*2511/i.test(f) && notMerged(f)) ??
    pick(unets, has(/qwen.*edit.*2509/i, fp8), has(/qwen.*edit.*2509/i)) ??
    missing("Qwen-Image-Edit 2511");
  const v2511 = /2511/.test(edit);
  const version = v2511 ? /2511/ : /2509/;
  const l8 = pick(loras, has(/qwen.*edit/i, version, /lightning/i, /8.?steps/i));
  const l4 = pick(loras, has(/qwen.*edit/i, version, /lightning/i, /4.?steps/i));
  const qwen = {
    unet: edit,
    clip: pick(clips, has(/qwen_2\.5_vl_7b/i, fp8), has(/qwen_2\.5_vl_7b/i)) ?? missing("encodeur de texte Qwen 2.5 VL 7B"),
    vae: pick(vaes, has(/qwen_image_vae/i)) ?? missing("VAE Qwen-Image"),
    lightning: l8 ?? l4,
    steps: l8 ? 8 : l4 ? 4 : 30,
    // LoRA « tout en photo réelle » (faite pour 2509) : QWEN_ANYTHING2REAL=0 pour comparer sans
    real: process.env.QWEN_ANYTHING2REAL === "0" ? null : pick(loras, has(/anything2real/i)),
    v2511,
    refMethod: v2511 && "FluxKontextMultiReferenceLatentMethod" in info,
  };
  const wan = {
    clip: pick(clips, has(/umt5_xxl/i, fp8), has(/umt5_xxl/i)) ?? DEFAULTS.wan.clip,
    vae: pick(vaes, has(/wan_2\.1_vae/i)) ?? DEFAULTS.wan.vae,
  };
  const expert = (kind: RegExp, noise: RegExp) => pick(unets, has(/wan2\.2/i, kind, noise, fp8), has(/wan2\.2/i, kind, noise));
  const ctlHigh = expert(/fun_control/i, /high_noise/i);
  const ctlLow = expert(/fun_control/i, /low_noise/i);
  return {
    qwen,
    wan,
    i2v: {
      high: expert(/i2v/i, /high_noise/i),
      low: expert(/i2v/i, /low_noise/i),
      loraHigh: pick(loras, has(/wan2\.2_i2v.*lightx2v.*4steps/i, /high_noise/i)),
      loraLow: pick(loras, has(/wan2\.2_i2v.*lightx2v.*4steps/i, /low_noise/i)),
    },
    control: ctlHigh && ctlLow ? { high: ctlHigh, low: ctlLow } : null,
    seedvr2: (() => {
      const dits = choices(info, "SeedVR2LoadDiTModel", "model");
      const vaes2 = choices(info, "SeedVR2LoadVAEModel", "model");
      const dit = pick(dits, has(/7b_sharp/i, fp8), has(/7b/i, fp8), has(/3b/i, fp8), () => true);
      return dit && vaes2.length ? { dit, vae: vaes2[0] } : null;
    })(),
    interp: pick(choices(info, "FrameInterpolationModelLoader", "model_name"), has(/rife_v4\.26\./i), has(/rife/i), () => true),
  };
}

/** Qualité max : 720p accéléré (4 étapes), puis affinage 1080p (SeedVR2) et 32 images/s (RIFE).
    20 étapes complètes coûtaient 23 min pour un gain bien moindre que l'affinage, qui prend moins d'une minute. */
export type VideoQuality = "rapide" | "max";

/* ---------- workflows ---------- */
/* Les nœuds sont préfixés (« q3… », « v3… ») pour qu'un même workflow puisse enchaîner plusieurs plans
   (film complet) en ne chargeant chaque modèle qu'une fois. */

type Ref = [string, number];

/** Qwen-Image-Edit + accélération Lightning (+ LoRA photo réelle), chargé une fois. */
function qwenLoaders(wf: Workflow, m: Models["qwen"]) {
  let model: Ref = ["qunet", 0];
  wf.qunet = { class_type: "UNETLoader", inputs: { unet_name: m.unet, weight_dtype: "default" } };
  wf.qclip = { class_type: "CLIPLoader", inputs: { clip_name: m.clip, type: "qwen_image", device: "default" } };
  wf.qvae = { class_type: "VAELoader", inputs: { vae_name: m.vae } };
  for (const [k, lora] of [["qfast", m.lightning], ["qreal", m.real]] as const) {
    if (!lora) continue;
    wf[k] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: lora, strength_model: 1 } };
    model = [k, 0];
  }
  wf.qshift = { class_type: "ModelSamplingAuraFlow", inputs: { model, shift: m.v2511 ? 3.1 : 3 } };
  wf.qnorm = { class_type: "CFGNorm", inputs: { model: ["qshift", 0], strength: 1 } };
  return { model: ["qnorm", 0] as Ref, clip: ["qclip", 0] as Ref, vae: ["qvae", 0] as Ref };
}

/** Capture 3D (+ profondeur) → photo réaliste. Renvoie le nœud qui sort l'image décodée. */
function qwenEdit(wf: Workflow, m: Models["qwen"], L: ReturnType<typeof qwenLoaders>, image: string, depth: string | null, prompt: string, seed: number, p = "q") {
  const id = (k: string) => `${p}${k}`;
  wf[id("img")] = { class_type: "LoadImage", inputs: { image } };
  wf[id("scale")] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [id("img"), 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 8 } };
  const images: Record<string, Ref> = { image1: [id("scale"), 0] };
  if (depth) {
    wf[id("dimg")] = { class_type: "LoadImage", inputs: { image: depth } };
    wf[id("dscale")] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [id("dimg"), 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 8 } };
    images.image2 = [id("dscale"), 0];
  }
  const encode = (k: string, text: string): Ref => {
    wf[id(k)] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: L.clip, prompt: text, vae: L.vae, ...images } };
    if (!m.refMethod) return [id(k), 0];
    // 2511 : façon de placer les images de référence recommandée par le workflow officiel
    wf[id(`${k}ref`)] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: [id(k), 0], reference_latents_method: "index_timestep_zero" } };
    return [id(`${k}ref`), 0];
  };
  const positive = encode("pos", depth ? prompt + DEPTH_PROMPT : prompt);
  const negative = encode("neg", "");
  wf[id("latent")] = { class_type: "VAEEncode", inputs: { pixels: [id("scale"), 0], vae: L.vae } };
  wf[id("sample")] = {
    class_type: "KSampler",
    inputs: {
      model: L.model, seed, steps: m.steps, cfg: m.lightning ? 1 : 3, sampler_name: "euler", scheduler: "simple",
      positive, negative, latent_image: [id("latent"), 0], denoise: 1,
    },
  };
  wf[id("decode")] = { class_type: "VAEDecode", inputs: { samples: [id("sample"), 0], vae: L.vae } };
  return [id("decode"), 0] as Ref;
}

export function photoWorkflow(m: Models, image: string, depth: string | null, prompt: string, seed: number): Workflow {
  const wf: Workflow = {};
  const out = qwenEdit(wf, m.qwen, qwenLoaders(wf, m.qwen), image, depth, prompt, seed);
  wf.save = { class_type: "SaveImage", inputs: { images: out, filename_prefix: "plan3d/photo" } };
  return wf;
}

/** Les deux experts de Wan 2.2 (composition puis détails), encodeur de texte et VAE, chargés une fois.
    4 étapes avec l'accélération lightx2v, 20 sinon. */
function wanLoaders(wf: Workflow, m: Models, experts: { high: string; low: string; loraHigh: string | null; loraLow: string | null }, shift: number) {
  const fast = !!(experts.loraHigh && experts.loraLow);
  const load = (k: string, unet: string, lora: string | null): Ref => {
    wf[`${k}a`] = { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } };
    let model: Ref = [`${k}a`, 0];
    if (fast && lora) {
      wf[`${k}b`] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: lora, strength_model: 1 } };
      model = [`${k}b`, 0];
    }
    wf[`${k}c`] = { class_type: "ModelSamplingSD3", inputs: { model, shift } };
    return [`${k}c`, 0];
  };
  wf.clip = { class_type: "CLIPLoader", inputs: { clip_name: m.wan.clip, type: "wan", device: "default" } };
  wf.vae = { class_type: "VAELoader", inputs: { vae_name: m.wan.vae } };
  return { high: load("h", experts.high, experts.loraHigh), low: load("l", experts.low, experts.loraLow), steps: fast ? 4 : 20, cfg: fast ? 1 : 3.5 };
}

/** Consigne de la vidéo (et consigne négative commune). */
function wanPrompt(wf: Workflow, prompt: string, p = "") {
  wf[`${p}pos`] = { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } };
  wf[`${p}neg`] = { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: VIDEO_NEGATIVE } };
  return { pos: [`${p}pos`, 0] as Ref, neg: [`${p}neg`, 0] as Ref };
}

/** Échantillonnage en deux temps (expert bruit fort puis bruit faible) et décodage : renvoie les images. */
function wanSample(wf: Workflow, W: ReturnType<typeof wanLoaders>, cond: string, seed: number, p = ""): Ref {
  const sampler = (model: Ref, latent: Ref, start: number, end: number, first: boolean): Node => ({
    class_type: "KSamplerAdvanced",
    inputs: {
      model, add_noise: first ? "enable" : "disable", noise_seed: seed, steps: W.steps, cfg: W.cfg, sampler_name: "euler",
      scheduler: "simple", positive: [cond, 0], negative: [cond, 1], latent_image: latent,
      start_at_step: start, end_at_step: end, return_with_leftover_noise: first ? "enable" : "disable",
    },
  });
  wf[`${p}s1`] = sampler(W.high, [cond, 2], 0, W.steps / 2, true);
  wf[`${p}s2`] = sampler(W.low, [`${p}s1`, 0], W.steps / 2, 10000, false);
  wf[`${p}dec`] = { class_type: "VAEDecode", inputs: { samples: [`${p}s2`, 0], vae: ["vae", 0] } };
  return [`${p}dec`, 0];
}

/** Images → vidéo enregistrée ; en qualité max, affinage 1080p (SeedVR2) et 32 images/s (RIFE). */
function wanFinish(wf: Workflow, frames: Ref, prefix: string, m: Models, quality: VideoQuality, seed: number) {
  let fps = 16;
  if (quality === "max" && m.seedvr2) {
    // SeedVR2 : affine matières et arêtes et passe le petit côté à 1080 px, par paquets d'images qui se chevauchent
    wf.svDit = { class_type: "SeedVR2LoadDiTModel", inputs: { model: m.seedvr2.dit, device: "cuda:0" } };
    wf.svVae = { class_type: "SeedVR2LoadVAEModel", inputs: { model: m.seedvr2.vae, device: "cuda:0" } };
    wf.sv = {
      class_type: "SeedVR2VideoUpscaler",
      inputs: {
        image: frames, dit: ["svDit", 0], vae: ["svVae", 0], seed, resolution: 1080, max_resolution: 1920,
        batch_size: 13, uniform_batch_size: false, color_correction: "lab", temporal_overlap: 2,
      },
    };
    frames = ["sv", 0];
  }
  if (quality === "max" && m.interp) {
    // une image intermédiaire entre chaque paire : 32 images/s, mouvement fluide
    wf.fiModel = { class_type: "FrameInterpolationModelLoader", inputs: { model_name: m.interp } };
    wf.fi = { class_type: "FrameInterpolate", inputs: { interp_model: ["fiModel", 0], images: frames, multiplier: 2 } };
    frames = ["fi", 0];
    fps = 32;
  }
  wf.vid = { class_type: "CreateVideo", inputs: { images: frames, fps } };
  wf.save = { class_type: "SaveVideo", inputs: { video: ["vid", 0], filename_prefix: prefix, format: "auto" } };
}

function controlLoaders(wf: Workflow, m: Models) {
  if (!m.control) throw new Error("Wan 2.2 Fun Control absent sur le pod (scripts/runpod/install_models.py controle)");
  // mêmes accélérations 4 étapes que l'image → vidéo, décalage 8 (workflow officiel)
  return wanLoaders(wf, m, { ...m.control, loraHigh: m.i2v.loraHigh, loraLow: m.i2v.loraLow }, 8);
}

/** Wan 2.2 Fun Control : suit la profondeur `control` image par image, avec l'aspect de l'image `ref`. */
function controlShot(
  wf: Workflow,
  W: ReturnType<typeof wanLoaders>,
  text: { pos: Ref; neg: Ref },
  ref: Ref,
  control: string,
  seed: number,
  size: { width: number; height: number; frames: number },
  p = "",
): Ref {
  // l'APNG de profondeur se lit comme une suite d'images
  wf[`${p}ctl`] = { class_type: "LoadImage", inputs: { image: control } };
  wf[`${p}fc`] = {
    class_type: "Wan22FunControlToVideo",
    inputs: {
      positive: text.pos, negative: text.neg, vae: ["vae", 0], width: size.width, height: size.height, length: size.frames, batch_size: 1,
      ref_image: ref, control_video: [`${p}ctl`, 0],
    },
  };
  return wanSample(wf, W, `${p}fc`, seed, p);
}

export function videoWorkflow(m: Models, image: string, prompt: string, seed: number, width = 1280, height = 720, frames = 81): Workflow {
  if (!m.i2v.high || !m.i2v.low) throw new Error("vidéo libre : Wan 2.2 image → vidéo absent sur le pod (scripts/runpod/install_models.py video)");
  const wf: Workflow = {};
  const W = wanLoaders(wf, m, { ...m.i2v, high: m.i2v.high, low: m.i2v.low }, 5);
  const t = wanPrompt(wf, prompt);
  wf.img = { class_type: "LoadImage", inputs: { image } };
  wf.i2v = {
    class_type: "WanImageToVideo",
    inputs: { positive: t.pos, negative: t.neg, vae: ["vae", 0], start_image: ["img", 0], width, height, length: frames, batch_size: 1 },
  };
  wanFinish(wf, wanSample(wf, W, "i2v", seed), "plan3d/video", m, "rapide", seed);
  return wf;
}

/** Plan de la visite : photo réaliste de la première image (Qwen, guidé par la profondeur), puis Wan 2.2 Fun Control
    qui suit la profondeur de chaque image en gardant l'aspect de cette photo. */
export function tourWorkflow(
  m: Models,
  files: { image: string; depth: string; control: string },
  photoPrompt: string,
  videoPrompt: string,
  seed: number,
  width: number,
  height: number,
  frames: number,
  quality: VideoQuality = "rapide",
): Workflow {
  const wf: Workflow = {};
  const W = controlLoaders(wf, m);
  const photo = qwenEdit(wf, m.qwen, qwenLoaders(wf, m.qwen), files.image, files.depth, photoPrompt, seed);
  wf.photo = { class_type: "SaveImage", inputs: { images: photo, filename_prefix: "plan3d/visite-photo" } };
  const out = controlShot(wf, W, wanPrompt(wf, videoPrompt), photo, files.control, seed, { width, height, frames });
  wanFinish(wf, out, "plan3d/visite", m, quality, seed);
  return wf;
}

/** Photo déjà rendue, animée par un petit mouvement de caméra de la 3D (profondeur image par image). */
export function animateWorkflow(
  m: Models,
  files: { image: string; control: string },
  prompt: string,
  seed: number,
  width: number,
  height: number,
  frames: number,
  quality: VideoQuality = "rapide",
): Workflow {
  const wf: Workflow = { img: { class_type: "LoadImage", inputs: { image: files.image } } };
  const W = controlLoaders(wf, m);
  const out = controlShot(wf, W, wanPrompt(wf, prompt), ["img", 0], files.control, seed, { width, height, frames });
  wanFinish(wf, out, "plan3d/video", m, quality, seed);
  return wf;
}

export interface FilmShot {
  image: string; // première image de la 3D
  depth: string; // sa profondeur
  control: string; // profondeur image par image
  photoPrompt: string;
  videoPrompt: string;
}

/** Film complet : chaque plan (façade puis pièces de la visite) devient photo réaliste puis vidéo fidèle ; les plans
    sont mis bout à bout dans une seule vidéo. Même graine partout : mêmes matières d'un plan à l'autre. */
export function filmWorkflow(m: Models, shots: FilmShot[], seed: number, width: number, height: number, frames: number, quality: VideoQuality): Workflow {
  if (!shots.length) throw new Error("aucun plan à filmer");
  const wf: Workflow = {};
  const W = controlLoaders(wf, m);
  const Q = qwenLoaders(wf, m.qwen);
  let film: Ref | null = null;
  shots.forEach((s, i) => {
    const photo = qwenEdit(wf, m.qwen, Q, s.image, s.depth, s.photoPrompt, seed, `q${i}`);
    if (i === 0) wf.poster = { class_type: "SaveImage", inputs: { images: photo, filename_prefix: "plan3d/film-affiche" } };
    const clip = controlShot(wf, W, wanPrompt(wf, s.videoPrompt, `v${i}`), photo, s.control, seed, { width, height, frames }, `v${i}`);
    if (!film) film = clip;
    else {
      wf[`join${i}`] = { class_type: "ImageBatch", inputs: { image1: film, image2: clip } };
      film = [`join${i}`, 0];
    }
  });
  wanFinish(wf, film!, "plan3d/film", m, quality, seed);
  return wf;
}

// ComfyUI protégé par ComfyUI-Login (templates RunPod) : jeton = première ligne de ComfyUI/login/PASSWORD
const TOKEN = process.env.COMFYUI_TOKEN ?? "";

async function comfy(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set("Authorization", `Bearer ${TOKEN}`);
  // le pod passe par le relais HTTPS de RunPod : une coupure passagère se rattrape en réessayant
  // (sauf la mise en file d'un calcul : il ne doit jamais partir deux fois)
  const tries = path === "/prompt" ? 1 : 4;
  let r: Response | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetch(COMFY + path, { ...init, headers, signal: AbortSignal.timeout(90_000), cache: "no-store" });
      if (r.status !== 502 && r.status !== 503 && r.status !== 504) break;
      if (attempt >= tries) break;
    } catch (e) {
      if (attempt >= tries) throw new Error(`ComfyUI ${path} injoignable (${(e as Error).message})`);
    }
    await new Promise((ok) => setTimeout(ok, 1500 * attempt));
  }
  if (!r!.ok) throw new Error(`ComfyUI ${path} : ${r!.status} ${(await r!.text()).slice(0, 500)}`);
  return r!;
}

/** Complète les réglages obligatoires absents par leur valeur par défaut (ComfyUI en ajoute au fil des versions). */
async function complete(wf: Workflow) {
  const all = await objectInfo();
  for (const node of Object.values(wf)) {
    const info = all[node.class_type];
    if (!info) throw new Error(`Nœud ComfyUI absent : ${node.class_type}`);
    for (const [name, spec] of Object.entries(info.input.required ?? {})) {
      if (name in node.inputs) continue;
      const opts = (spec[1] ?? {}) as { default?: unknown; options?: ({ key: string } | string)[] };
      if ("default" in opts) node.inputs[name] = opts.default;
      else if (Array.isArray(spec[0]) && spec[0].length) node.inputs[name] = spec[0][0];
      else if (opts.options?.length) {
        const first = opts.options[0];
        node.inputs[name] = typeof first === "string" ? first : first.key;
      }
    }
  }
  return wf;
}

export async function uploadImage(png: Blob, name: string) {
  const form = new FormData();
  form.append("image", png, name);
  form.append("overwrite", "true");
  const res = (await (await comfy("/upload/image", { method: "POST", body: form })).json()) as { name: string };
  return res.name;
}

export async function queue(wf: Workflow) {
  const body = JSON.stringify({ prompt: await complete(wf), client_id: "plan3d" });
  const res = (await (await comfy("/prompt", { method: "POST", body, headers: { "Content-Type": "application/json" } })).json()) as {
    prompt_id: string;
  };
  return res.prompt_id;
}

export interface JobState {
  status: "running" | "done" | "error";
  files: { filename: string; subfolder: string; type: string; video: boolean }[];
  error?: string;
  position?: number; // place dans la file d'attente
}

export async function jobState(id: string): Promise<JobState> {
  const hist = (await (await comfy(`/history/${id}`)).json()) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs: Record<string, Record<string, unknown>> }>;
  const h = hist[id];
  if (!h) {
    const q = (await (await comfy("/queue")).json()) as { queue_running: unknown[][]; queue_pending: unknown[][] };
    const pending = q.queue_pending.findIndex((x) => x[1] === id);
    return { status: "running", files: [], position: pending >= 0 ? pending + 1 : 0 };
  }
  if (h.status?.status_str === "error") {
    // [« execution_error », { node_type, exception_message… }] : on garde le nœud et le message
    const last = h.status.messages?.at(-1) as [string, { node_type?: string; exception_message?: string }] | undefined;
    const detail = last?.[1]?.exception_message ? `${last[1].node_type ?? "ComfyUI"} : ${last[1].exception_message.trim()}` : JSON.stringify(last);
    return { status: "error", files: [], error: detail.slice(0, 400) };
  }
  const files: JobState["files"] = [];
  for (const out of Object.values(h.outputs))
    for (const f of (out.images ?? out.videos ?? []) as { filename: string; subfolder: string; type: string }[])
      files.push({ ...f, video: /\.(mp4|webm|mov)$/i.test(f.filename) });
  return { status: "done", files };
}

export async function viewFile(filename: string, subfolder: string, type: string) {
  const q = new URLSearchParams({ filename, subfolder, type });
  return comfy(`/view?${q}`);
}

/* ---------- interface commune aux deux modes ---------- */

export interface RenderFile {
  url: string; // lien de téléchargement (relais de l'app, ou data: URL en Serverless)
  video: boolean;
}
export interface RenderState {
  status: "running" | "done" | "error";
  files: RenderFile[];
  error?: string;
  queued?: boolean; // en attente d'un GPU (démarrage à froid en Serverless)
}

const rp = async (path: string, init?: RequestInit) => {
  const r = await fetch(`https://api.runpod.ai/v2/${RP_ENDPOINT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${RP_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`RunPod ${path} : ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

/** Lance un rendu ; renvoie l'identifiant du calcul. `build` reçoit les noms des fichiers envoyés, dans l'ordre. */
export async function startRender(build: (names: string[]) => Workflow, files: { mime: string; base64: string }[]) {
  const stamp = Date.now();
  const named = files.map((f, i) => {
    const ext = f.mime.split("/")[1] === "jpeg" ? "jpg" : f.mime.split("/")[1];
    return { ...f, name: `plan3d-${stamp}-${i}.${ext}` };
  });
  if (SERVERLESS) {
    // le worker-comfyui reçoit les images avec le workflow (pas d'envoi séparé)
    const images = named.map((f) => ({ name: f.name, image: f.base64 }));
    const res = (await rp("/run", { method: "POST", body: JSON.stringify({ input: { workflow: build(named.map((f) => f.name)), images } }) })) as {
      id: string;
    };
    return `rp-${res.id}`;
  }
  // envois par 4 en parallèle (un film en compte une trentaine)
  const names: string[] = new Array(named.length);
  for (let i = 0; i < named.length; i += 4)
    await Promise.all(
      named.slice(i, i + 4).map(async (f, k) => {
        names[i + k] = await uploadImage(new Blob([Buffer.from(f.base64, "base64")], { type: f.mime }), f.name);
      }),
    );
  return queue(build(names));
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };

export async function renderState(id: string): Promise<RenderState> {
  if (id.startsWith("rp-")) {
    const r = (await rp(`/status/${id.slice(3)}`)) as {
      status: string;
      error?: string;
      output?: { images?: { filename: string; type: string; data: string }[]; errors?: string[]; error?: string };
    };
    if (r.status === "IN_QUEUE" || r.status === "IN_PROGRESS") return { status: "running", files: [], queued: r.status === "IN_QUEUE" };
    if (r.status !== "COMPLETED") return { status: "error", files: [], error: r.error ?? r.output?.error ?? r.status };
    const files = (r.output?.images ?? []).map((f) => {
      const ext = f.filename.split(".").pop()?.toLowerCase() ?? "png";
      const video = /^(mp4|webm|mov)$/.test(ext);
      return { video, url: f.type === "s3_url" ? f.data : `data:${MIME[ext] ?? "application/octet-stream"};base64,${f.data}` };
    });
    if (!files.length) return { status: "error", files: [], error: r.output?.errors?.join(" · ") ?? "aucun fichier produit" };
    return { status: "done", files };
  }
  const st = await jobState(id);
  return {
    status: st.status,
    error: st.error,
    files: st.files.map((f) => ({
      video: f.video,
      url: `/api/rendu/fichier?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type })}`,
    })),
  };
}
