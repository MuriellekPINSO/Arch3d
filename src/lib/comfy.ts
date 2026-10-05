import "server-only";

/* Rendus IA open source avec ComfyUI sur GPU :
   - photo : Qwen-Image-Edit 2509 + Lightning 8 étapes + Anything2Real (capture 3D → photo réaliste) ;
   - vidéo : Wan 2.2 image → vidéo 14B + accélération 4 étapes (photo → plan de 5 s).
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

const VIDEO_NEGATIVE = "blurry, distorted geometry, warped walls, flickering, people, person, silhouette, text, watermark, low quality, cartoon, 3d render";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Workflow = Record<string, Node>;

export function photoWorkflow(image: string, prompt: string, seed: number): Workflow {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2509_fp8_e4m3fn.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors", strength_model: 1 } },
    "5": { class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: "Qwen-Image-Edit-2509-Anything2RealAlpha.safetensors", strength_model: 1 } },
    "6": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["5", 0], shift: 3 } },
    "7": { class_type: "CFGNorm", inputs: { model: ["6", 0], strength: 1 } },
    "8": { class_type: "LoadImage", inputs: { image } },
    "9": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["8", 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 8 } },
    "10": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], prompt, vae: ["3", 0], image1: ["9", 0] } },
    "11": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], prompt: "", vae: ["3", 0], image1: ["9", 0] } },
    "12": { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["3", 0] } },
    "13": {
      class_type: "KSampler",
      inputs: {
        model: ["7", 0], seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple",
        positive: ["10", 0], negative: ["11", 0], latent_image: ["12", 0], denoise: 1,
      },
    },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 0] } },
    "15": { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "plan3d/photo" } },
  };
}

export function videoWorkflow(image: string, prompt: string, seed: number, width = 1280, height = 720, frames = 81): Workflow {
  const expert = (id: string, unet: string, lora: string): Workflow => ({
    [`${id}a`]: { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    [`${id}b`]: { class_type: "LoraLoaderModelOnly", inputs: { model: [`${id}a`, 0], lora_name: lora, strength_model: 1 } },
    [`${id}c`]: { class_type: "ModelSamplingSD3", inputs: { model: [`${id}b`, 0], shift: 5 } },
  });
  const sampler = (model: string, latent: [string, number], start: number, end: number, first: boolean): Node => ({
    class_type: "KSamplerAdvanced",
    inputs: {
      model: [model, 0], add_noise: first ? "enable" : "disable", noise_seed: seed, steps: 4, cfg: 1, sampler_name: "euler",
      scheduler: "simple", positive: ["i2v", 0], negative: ["i2v", 1], latent_image: latent,
      start_at_step: start, end_at_step: end, return_with_leftover_noise: first ? "enable" : "disable",
    },
  });
  return {
    ...expert("h", "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"),
    ...expert("l", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"),
    clip: { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: prompt } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: VIDEO_NEGATIVE } },
    img: { class_type: "LoadImage", inputs: { image } },
    i2v: {
      class_type: "WanImageToVideo",
      inputs: { positive: ["pos", 0], negative: ["neg", 0], vae: ["vae", 0], start_image: ["img", 0], width, height, length: frames, batch_size: 1 },
    },
    // 4 étapes : 2 avec l'expert « bruit fort » (composition), 2 avec l'expert « bruit faible » (détails)
    s1: sampler("hc", ["i2v", 2], 0, 2, true),
    s2: sampler("lc", ["s1", 0], 2, 10000, false),
    dec: { class_type: "VAEDecode", inputs: { samples: ["s2", 0], vae: ["vae", 0] } },
    vid: { class_type: "CreateVideo", inputs: { images: ["dec", 0], fps: 16 } },
    save: { class_type: "SaveVideo", inputs: { video: ["vid", 0], filename_prefix: "plan3d/video", format: "auto" } },
  };
}

async function comfy(path: string, init?: RequestInit) {
  const r = await fetch(COMFY + path, { ...init, signal: AbortSignal.timeout(60_000), cache: "no-store" });
  if (!r.ok) throw new Error(`ComfyUI ${path} : ${r.status} ${(await r.text()).slice(0, 500)}`);
  return r;
}

let objectInfo: Record<string, { input: { required?: Record<string, unknown[]> } }> | null = null;

/** Complète les réglages obligatoires absents par leur valeur par défaut (ComfyUI en ajoute au fil des versions). */
async function complete(wf: Workflow) {
  objectInfo ??= await (await comfy("/object_info")).json();
  for (const node of Object.values(wf)) {
    const info = objectInfo![node.class_type];
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
  if (h.status?.status_str === "error") return { status: "error", files: [], error: JSON.stringify(h.status.messages?.slice(-1)).slice(0, 400) };
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

/** Lance un rendu ; renvoie l'identifiant du calcul. */
export async function startRender(build: (imageName: string) => Workflow, image: { mime: string; base64: string }) {
  const ext = image.mime.split("/")[1] === "jpeg" ? "jpg" : image.mime.split("/")[1];
  const name = `plan3d-${Date.now()}.${ext}`;
  if (SERVERLESS) {
    // le worker-comfyui reçoit l'image avec le workflow (pas d'envoi séparé)
    const res = (await rp("/run", { method: "POST", body: JSON.stringify({ input: { workflow: build(name), images: [{ name, image: image.base64 }] } }) })) as {
      id: string;
    };
    return `rp-${res.id}`;
  }
  const uploaded = await uploadImage(new Blob([Buffer.from(image.base64, "base64")], { type: image.mime }), name);
  return queue(build(uploaded));
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
