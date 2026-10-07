import {
  AERIAL_PROMPT,
  AERIAL_VIDEO_PROMPT,
  CONFIGURED,
  FACADE_PROMPT,
  FACADE_VIDEO_PROMPT,
  PHOTO_PROMPT,
  TOUR_VIDEO_PROMPT,
  VIDEO_PROMPT,
  animateWorkflow,
  filmWorkflow,
  photoWorkflow,
  pickModels,
  renderState,
  startRender,
  tourWorkflow,
  videoWorkflow,
} from "@/lib/comfy";

/* Rendu IA : POST lance un calcul sur le GPU (RunPod Serverless ou ComfyUI direct), GET ?id= donne son état. */

const notConfigured = () =>
  Response.json(
    { error: "Rendu IA non configuré : ajoutez RUNPOD_ENDPOINT_ID et RUNPOD_API_KEY (ou COMFYUI_URL) dans .env.local." },
    { status: 503 },
  );

// max : 720p, puis affinée en 1080p (SeedVR2) et 32 images/s (RIFE)
const SIZES = { rapide: [832, 480], hd: [1280, 720], max: [1280, 720] } as const;
const TOUR_FRAMES = 81;

const dataURL = (s: string | undefined, types = "png|jpeg|webp") => {
  const m = new RegExp(`^data:(image/(?:${types}));base64,(.+)$`).exec(s ?? "");
  return m ? { mime: m[1], base64: m[2] } : null;
};

export async function POST(request: Request) {
  if (!CONFIGURED) return notConfigured();
  const body = (await request.json()) as {
    mode: "photo" | "video" | "visite" | "anime" | "film"; // anime : photo animée ; film : tous les plans bout à bout
    image: string;
    depth?: string; // carte de profondeur de la même vue (PNG)
    control?: string; // visite : profondeur image par image (APNG)
    extra?: string;
    size?: "hd" | "rapide" | "max";
    view?: "facade" | "aerien" | "interieur"; // façade, maquette en coupe (de dessus) ou à hauteur d'yeux
    shots?: { image: string; depth: string; control: string; view: "facade" | "interieur" }[]; // film
  };
  if (body.mode === "film") return film(body);
  const image = dataURL(body.image);
  const depth = body.depth ? dataURL(body.depth, "png") : null;
  const control = body.control ? dataURL(body.control, "png") : null;
  const valid =
    image &&
    (body.mode === "photo" || body.mode === "video" || (body.mode === "visite" && depth && control) || (body.mode === "anime" && control)) &&
    (!body.depth || depth) &&
    (!body.control || control);
  if (!valid) return Response.json({ error: "Requête invalide." }, { status: 400 });
  // consigne de base + ambiance libre éventuelle (« lumière du soir, style afro-chic »…)
  const extra = (body.extra ?? "").trim().slice(0, 400);
  const withExtra = (base: string) => base + (extra.length >= 3 ? ` ${extra}` : "");
  const PROMPTS = {
    facade: [FACADE_PROMPT, FACADE_VIDEO_PROMPT],
    aerien: [AERIAL_PROMPT, AERIAL_VIDEO_PROMPT],
    interieur: [PHOTO_PROMPT, VIDEO_PROMPT],
  } as const;
  const [photoPrompt, videoPrompt] = PROMPTS[body.view ?? "interieur"];
  const seed = Math.floor(Math.random() * 2 ** 31);
  const [w, h] = SIZES[body.size ?? "hd"];
  const quality = body.size === "max" ? "max" : "rapide";
  try {
    const m = await pickModels();
    let id: string;
    if (body.mode === "visite")
      id = await startRender(
        ([img, dep, ctl]) => tourWorkflow(m, { image: img, depth: dep, control: ctl }, withExtra(PHOTO_PROMPT), withExtra(TOUR_VIDEO_PROMPT), seed, w, h, TOUR_FRAMES, quality),
        [image, depth!, control!],
      );
    else if (body.mode === "anime")
      id = await startRender(([img, ctl]) => animateWorkflow(m, { image: img, control: ctl }, withExtra(videoPrompt), seed, w, h, TOUR_FRAMES, quality), [image, control!]);
    else if (body.mode === "photo")
      id = await startRender(([img, dep]) => photoWorkflow(m, img, dep ?? null, withExtra(photoPrompt), seed), depth ? [image, depth] : [image]);
    else id = await startRender(([img]) => videoWorkflow(m, img, withExtra(videoPrompt), seed, w, h), [image]);
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: `Rendu impossible : ${(e as Error).message}` }, { status: 502 });
  }
}

const MAX_SHOTS = 16;

/** Film complet : chaque plan arrive avec sa première image, sa profondeur et sa profondeur image par image. */
async function film(body: { shots?: { image: string; depth: string; control: string; view: "facade" | "interieur" }[]; extra?: string; size?: "hd" | "rapide" | "max" }) {
  const shots = (body.shots ?? []).slice(0, MAX_SHOTS).map((s) => ({
    image: dataURL(s.image),
    depth: dataURL(s.depth, "png"),
    control: dataURL(s.control, "png"),
    view: s.view === "facade" ? ("facade" as const) : ("interieur" as const),
  }));
  if (!shots.length || shots.some((s) => !s.image || !s.depth || !s.control)) return Response.json({ error: "Requête invalide." }, { status: 400 });
  const extra = (body.extra ?? "").trim().slice(0, 400);
  const withExtra = (base: string) => base + (extra.length >= 3 ? ` ${extra}` : "");
  const [w, h] = SIZES[body.size ?? "hd"];
  const seed = Math.floor(Math.random() * 2 ** 31);
  try {
    const m = await pickModels();
    const files = shots.flatMap((s) => [s.image!, s.depth!, s.control!]);
    const id = await startRender(
      (names) =>
        filmWorkflow(
          m,
          shots.map((s, i) => ({
            image: names[i * 3],
            depth: names[i * 3 + 1],
            control: names[i * 3 + 2],
            photoPrompt: withExtra(s.view === "facade" ? FACADE_PROMPT : PHOTO_PROMPT),
            videoPrompt: withExtra(s.view === "facade" ? FACADE_VIDEO_PROMPT : TOUR_VIDEO_PROMPT),
          })),
          seed,
          w,
          h,
          TOUR_FRAMES,
          body.size === "max" ? "max" : "rapide",
        ),
      files,
    );
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: `Rendu impossible : ${(e as Error).message}` }, { status: 502 });
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
