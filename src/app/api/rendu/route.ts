import { AERIAL_PROMPT, AERIAL_VIDEO_PROMPT, CONFIGURED, FACADE_PROMPT, FACADE_VIDEO_PROMPT, PHOTO_PROMPT, VIDEO_PROMPT, photoWorkflow, renderState, startRender, videoWorkflow } from "@/lib/comfy";

/* Rendu IA : POST lance un calcul sur le GPU (RunPod Serverless ou ComfyUI direct), GET ?id= donne son état. */

const notConfigured = () =>
  Response.json(
    { error: "Rendu IA non configuré : ajoutez RUNPOD_ENDPOINT_ID et RUNPOD_API_KEY (ou COMFYUI_URL) dans .env.local." },
    { status: 503 },
  );

export async function POST(request: Request) {
  if (!CONFIGURED) return notConfigured();
  const body = (await request.json()) as {
    mode: "photo" | "video";
    image: string;
    extra?: string;
    size?: "hd" | "rapide";
    view?: "facade" | "aerien" | "interieur"; // façade, maquette en coupe (de dessus) ou à hauteur d'yeux
  };
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(body.image ?? "");
  if (!m || (body.mode !== "photo" && body.mode !== "video")) return Response.json({ error: "Requête invalide." }, { status: 400 });
  // consigne de base + ambiance libre éventuelle (« lumière du soir, style afro-chic »…)
  const extra = (body.extra ?? "").trim().slice(0, 400);
  const PROMPTS = {
    facade: [FACADE_PROMPT, FACADE_VIDEO_PROMPT],
    aerien: [AERIAL_PROMPT, AERIAL_VIDEO_PROMPT],
    interieur: [PHOTO_PROMPT, VIDEO_PROMPT],
  } as const;
  const base = PROMPTS[body.view ?? "interieur"][body.mode === "photo" ? 0 : 1];
  const prompt = base + (extra.length >= 3 ? ` ${extra}` : "");
  const seed = Math.floor(Math.random() * 2 ** 31);
  const build = (name: string) =>
    body.mode === "photo"
      ? photoWorkflow(name, prompt, seed)
      : body.size === "rapide"
        ? videoWorkflow(name, prompt, seed, 832, 480)
        : videoWorkflow(name, prompt, seed, 1280, 720);
  try {
    return Response.json({ id: await startRender(build, { mime: m[1], base64: m[2] }) });
  } catch (e) {
    return Response.json({ error: `Le serveur de rendu ne répond pas : ${(e as Error).message}` }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!CONFIGURED) return notConfigured();
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[\w-]{8,80}$/.test(id)) return Response.json({ error: "id manquant" }, { status: 400 });
  try {
    return Response.json(await renderState(id));
  } catch (e) {
    // coupure passagère : le calcul continue côté GPU, le navigateur redemandera
    return Response.json({ status: "running", files: [], warning: (e as Error).message });
  }
}
