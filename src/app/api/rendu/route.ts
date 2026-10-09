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
import { accountFrom, grant, recordRender, refundRender, spend } from "@/lib/credits";
import { renderCost, type Quality } from "@/lib/offres";
import { ADMIN_READY } from "@/lib/firebaseAdmin";

/* Rendu IA : POST lance un calcul sur le GPU (RunPod Serverless ou ComfyUI direct), GET ?id= donne son état. */

/** message dans la langue de l'interface (en-tête x-lang envoyé par le navigateur) */
const say = (request: Request, fr: string, en: string) => (request.headers.get("x-lang") === "en" ? en : fr);

// sans pod branché (RUNPOD_ENDPOINT_ID et RUNPOD_API_KEY, ou COMFYUI_URL, absents des variables d'environnement)
const notConfigured = (request: Request) =>
  Response.json(
    {
      error: say(
        request,
        "Rendu réaliste indisponible pour le moment : le serveur de calcul n'est pas branché.",
        "Realistic rendering is unavailable right now: the render server is not connected.",
      ),
    },
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
  if (!CONFIGURED) return notConfigured(request);
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
  if (body.mode === "film") return film(request, body);
  const image = dataURL(body.image);
  const depth = body.depth ? dataURL(body.depth, "png") : null;
  const control = body.control ? dataURL(body.control, "png") : null;
  const valid =
    image &&
    (body.mode === "photo" || body.mode === "video" || (body.mode === "visite" && depth && control) || (body.mode === "anime" && control)) &&
    (!body.depth || depth) &&
    (!body.control || control);
  if (!valid) return Response.json({ error: say(request, "Requête invalide.", "Invalid request.") }, { status: 400 });
  // le rendu se paie au lancement ; s'il ne part pas, ou échoue en route, les crédits reviennent
  const paid = await pay(request, renderCost(body.mode, (body.size ?? "hd") as Quality), body.mode);
  if (paid instanceof Response) return paid;
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
    if (paid.account) await recordRender(id, paid.account, paid.cost);
    return Response.json({ id, ...(paid.left !== null ? { credits: paid.left } : {}) });
  } catch (e) {
    if (paid.account) await grant(paid.account, paid.cost, "remboursement");
    return Response.json({ error: `${say(request, "Rendu impossible : ", "Render failed: ")}${(e as Error).message}` }, { status: 502 });
  }
}

const MAX_SHOTS = 16;

/** retire le prix du rendu, ou répond 402 avec le solde s'il manque des crédits */
async function pay(request: Request, cost: number, what: string): Promise<Response | { account: string | null; cost: number; left: number | null }> {
  // en local, tant que Firebase n'est pas configuré, les rendus restent possibles sans compte (pour tester le GPU)
  if (!ADMIN_READY && !process.env.VERCEL) return { account: null, cost: 0, left: null };
  if (!ADMIN_READY)
    return Response.json(
      { error: say(request, "Comptes indisponibles pour le moment : Firebase n'est pas branché.", "Accounts are unavailable right now: Firebase is not connected.") },
      { status: 503 },
    );
  const account = await accountFrom(request);
  if (!account)
    return Response.json(
      { error: say(request, "Connectez-vous pour lancer un rendu réaliste.", "Sign in to start a realistic render."), needLogin: true },
      { status: 401 },
    );
  const left = await spend(account.id, cost, `rendu ${what}`);
  if (left === null)
    return Response.json(
      {
        error: say(
          request,
          `Crédits insuffisants : ce rendu coûte ${cost} crédits, il vous en reste ${account.credits}.`,
          `Not enough credits: this render costs ${cost} credits, you have ${account.credits} left.`,
        ),
        needCredits: cost,
        credits: account.credits,
      },
      { status: 402 },
    );
  return { account: account.id, cost, left };
}

/** Film complet : chaque plan arrive avec sa première image, sa profondeur et sa profondeur image par image. */
async function film(request: Request, body: { shots?: { image: string; depth: string; control: string; view: "facade" | "interieur" }[]; extra?: string; size?: "hd" | "rapide" | "max" }) {
  const shots = (body.shots ?? []).slice(0, MAX_SHOTS).map((s) => ({
    image: dataURL(s.image),
    depth: dataURL(s.depth, "png"),
    control: dataURL(s.control, "png"),
    view: s.view === "facade" ? ("facade" as const) : ("interieur" as const),
  }));
  if (!shots.length || shots.some((s) => !s.image || !s.depth || !s.control)) return Response.json({ error: say(request, "Requête invalide.", "Invalid request.") }, { status: 400 });
  const paid = await pay(request, renderCost("film", (body.size ?? "hd") as Quality, shots.length), "film");
  if (paid instanceof Response) return paid;
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
    if (paid.account) await recordRender(id, paid.account, paid.cost);
    return Response.json({ id, ...(paid.left !== null ? { credits: paid.left } : {}) });
  } catch (e) {
    if (paid.account) await grant(paid.account, paid.cost, "remboursement");
    return Response.json({ error: `${say(request, "Rendu impossible : ", "Render failed: ")}${(e as Error).message}` }, { status: 502 });
  }
}

export async function GET(request: Request) {
  if (!CONFIGURED) return notConfigured(request);
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[\w-]{8,80}$/.test(id)) return Response.json({ error: say(request, "id manquant", "missing id") }, { status: 400 });
  try {
    const st = await renderState(id);
    if (st.status === "error" && ADMIN_READY) await refundRender(id).catch(() => {});
    return Response.json(st);
  } catch (e) {
    // coupure passagère : le calcul continue côté GPU, le navigateur redemandera
    return Response.json({ status: "running", files: [], warning: (e as Error).message });
  }
}
