/* Rendus IA sur fal.ai, côté serveur : enchaînement des étapes et suivi, état gardé dans Firestore (xwe_renders/{id}).
   photo  : la photo réaliste de la vue 3D (Qwen-Image-Edit 2511, guidé par la carte de profondeur)
   anime  : une photo déjà réaliste qui s'anime en suivant la profondeur de la 3D (Wan 2.2 VACE, mode profondeur)
   visite : la photo de la première image, puis la vidéo qui en part et suit la 3D
   film   : toutes les photos, toutes les vidéos, puis le montage bout à bout
   Chaque étape n'est lancée qu'une fois (réservée dans une transaction), même si plusieurs suivis arrivent en même temps. */
import { FieldValue } from "firebase-admin/firestore";
import { DEPTH_PROMPT, AERIAL_PROMPT, AERIAL_VIDEO_PROMPT, FACADE_PROMPT, FACADE_VIDEO_PROMPT, PHOTO_PROMPT, TOUR_VIDEO_PROMPT, VIDEO_PROMPT } from "./comfy";
import { poll, submit, type FalJob } from "./fal";
import { firestore } from "./firebaseAdmin";

const QWEN = "fal-ai/qwen-image-edit-2511";
const VACE = "fal-ai/wan-22-vace-fun-a14b/depth";
const MERGE = "fal-ai/ffmpeg-api/merge-videos";

export type FalView = "facade" | "aerien" | "interieur";
export type FalShot = { image?: string; depth?: string; control?: string; photo?: string; video?: string; view: FalView };
type Mode = "photo" | "anime" | "visite" | "film";
type Stage = "photo" | "video" | "merge";
type Size = "rapide" | "hd" | "max";

type Doc = {
  account: string;
  cost: number;
  refunded: boolean;
  mode: Mode;
  size: Size;
  extra: string;
  shots: FalShot[];
  stages: Stage[];
  stage: number;
  claimed: number; // dernière étape dont les calculs sont réservés ou lancés
  jobs: FalJob[]; // calculs de l'étape en cours, dans l'ordre des plans
  merged?: string;
  error?: string;
  done?: boolean;
  title?: string; // nom affiché (pièce filmée…)
  pose?: unknown; // point de vue 3D de la photo, pour l'animer plus tard depuis la même vue
  hidden?: boolean; // retiré de la liste par son auteur
  budget?: boolean; // coût réservé sur le plafond du jour (src/lib/budget.ts) au lancement
};

const col = () => firestore().collection("xwe_renders");
const pick = <T,>(p: Record<FalView, T>, v: FalView) => p[v] ?? p.interieur;
const PHOTO: Record<FalView, string> = { facade: FACADE_PROMPT, aerien: AERIAL_PROMPT, interieur: PHOTO_PROMPT };
const MOTION: Record<FalView, string> = { facade: FACADE_VIDEO_PROMPT, aerien: AERIAL_VIDEO_PROMPT, interieur: TOUR_VIDEO_PROMPT };

const stagesOf = (mode: Mode): Stage[] => (mode === "photo" ? ["photo"] : mode === "anime" ? ["video"] : mode === "visite" ? ["photo", "video"] : ["photo", "video", "merge"]);

/** Crée le rendu et lance sa première étape. */
export async function startFal(p: { account: string; cost: number; mode: Mode; size: Size; extra: string; shots: FalShot[]; title?: string; pose?: unknown }) {
  const id = `fal_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const { title, pose, ...rest } = p;
  const doc: Doc = { ...rest, ...(title ? { title } : {}), ...(pose ? { pose } : {}), refunded: false, budget: true, stages: stagesOf(p.mode), stage: 0, claimed: -1, jobs: [] };
  await col().doc(id).set({ ...doc, at: FieldValue.serverTimestamp() });
  await stepFal(id); // les calculs partent tout de suite
  return id;
}

/** Les calculs d'une étape, un par plan. */
function jobsFor(d: Doc, stage: Stage): { endpoint: string; input: Record<string, unknown> }[] {
  const extra = d.extra.length >= 3 ? ` ${d.extra}` : "";
  const seed = Math.floor(Math.random() * 2 ** 31);
  if (stage === "photo")
    return d.shots.map((s) => ({
      endpoint: QWEN,
      input: {
        prompt: pick(PHOTO, s.view) + extra + (s.depth ? DEPTH_PROMPT : ""),
        image_urls: s.depth ? [s.image, s.depth] : [s.image],
        num_inference_steps: 28,
        guidance_scale: 4.5,
        acceleration: "regular",
        output_format: "jpeg",
        seed,
      },
    }));
  if (stage === "video")
    return d.shots.map((s) => ({
      endpoint: VACE,
      input: {
        prompt: (d.mode === "anime" ? (s.view === "interieur" ? VIDEO_PROMPT : pick(MOTION, s.view)) : pick(MOTION, s.view)) + extra,
        video_url: s.control, // la profondeur de la 3D, image par image : la vidéo la suit telle quelle
        preprocess: false,
        first_frame_url: s.photo, // la photo réaliste ouvre la vidéo
        resolution: d.size === "rapide" ? "480p" : "720p",
        num_frames: 81,
        frames_per_second: 16,
        match_input_num_frames: true,
        num_interpolated_frames: d.size === "max" ? 1 : 0, // qualité max : 32 images/s
        interpolator_model: "rife",
        video_quality: "high",
        acceleration: "regular",
        seed,
      },
    }));
  return [{ endpoint: MERGE, input: { video_urls: d.shots.map((s) => s.video) } }];
}

export type FalState = { status: "running" | "done" | "error"; files: { url: string; video: boolean }[]; queued?: boolean; error?: string };

function result(d: Doc): FalState {
  const first = d.shots[0];
  if (d.mode === "photo") return { status: "done", files: [{ url: first.photo!, video: false }] };
  const video = d.mode === "film" ? d.merged! : first.video!;
  return { status: "done", files: [{ url: video, video: true }, ...(first.photo ? [{ url: first.photo, video: false }] : [])] };
}

/** Fait avancer le rendu d'un pas et dit où il en est. */
export async function stepFal(id: string): Promise<FalState> {
  const ref = col().doc(id);
  const d = (await ref.get()).data() as Doc | undefined;
  if (!d) return { status: "error", files: [], error: "rendu inconnu" };
  if (d.error) return { status: "error", files: [], error: d.error };
  if (d.done) return result(d);
  const stage = d.stages[d.stage];

  // 1. lancer l'étape, une seule fois
  if (d.claimed < d.stage) {
    const mine = await firestore().runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() as Doc;
      if (cur.claimed >= cur.stage) return false;
      tx.update(ref, { claimed: cur.stage });
      return true;
    });
    if (!mine) return { status: "running", files: [], queued: true };
    // rendus lancés avant le plafond de dépenses : seul le montage (quelques centimes) peut encore partir
    if (!d.budget && stage !== "merge") {
      const error = "rendu interrompu, relancez-le";
      await ref.update({ error });
      return { status: "error", files: [], error };
    }
    try {
      const jobs = await Promise.all(jobsFor(d, stage).map((j) => submit(j.endpoint, j.input)));
      await ref.update({ jobs });
    } catch (e) {
      await ref.update({ error: (e as Error).message });
      return { status: "error", files: [], error: (e as Error).message };
    }
    return { status: "running", files: [], queued: true };
  }
  if (!d.jobs.length) return { status: "running", files: [], queued: true }; // lancement en cours ailleurs

  // 2. suivre les calculs de l'étape
  const states = await Promise.all(d.jobs.map((j) => poll(j)));
  const failed = states.find((s) => s.state === "error");
  if (failed) {
    const error = failed.error ?? "échec du calcul";
    await ref.update({ error });
    return { status: "error", files: [], error };
  }
  if (states.some((s) => s.state !== "done")) return { status: "running", files: [], queued: states.every((s) => s.state === "queued") };

  // 3. étape terminée : on range les résultats et on passe à la suivante
  const shots = d.shots.map((s) => ({ ...s }));
  let merged = d.merged;
  states.forEach((s, i) => {
    const out = s.output ?? {};
    if (stage === "photo") shots[i].photo = String((out.images as { url: string }[] | undefined)?.[0]?.url ?? "");
    if (stage === "video") shots[i].video = String((out.video as { url: string } | undefined)?.url ?? "");
    if (stage === "merge") merged = String((out.video as { url: string } | undefined)?.url ?? "");
  });
  const missing = stage === "merge" ? !merged : shots.some((s) => !(stage === "photo" ? s.photo : s.video));
  if (missing) {
    await ref.update({ error: "fal n'a renvoyé aucun fichier" });
    return { status: "error", files: [], error: "fal n'a renvoyé aucun fichier" };
  }
  const next = d.stage + 1;
  const done = next >= d.stages.length;
  // seul celui qui passe l'étape l'écrit (les autres suivis voient l'étape déjà passée)
  const advanced = await firestore().runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as Doc;
    if (cur.stage !== d.stage) return false;
    tx.update(ref, { shots, ...(merged ? { merged } : {}), stage: next, jobs: [], ...(done ? { done: true } : {}) });
    return true;
  });
  if (done) return result({ ...d, shots, merged });
  if (advanced) return stepFal(id); // l'étape suivante part tout de suite
  return { status: "running", files: [] };
}

export type FalListed = {
  id: string;
  kind: Mode;
  size: Size;
  view: FalView;
  status: "running" | "done" | "error";
  stage: "photo" | "video" | "merge" | null; // étape en cours
  stages: number;
  stageNo: number;
  at: number;
  shots: number;
  before?: string; // la vue 3D envoyée (première image)
  url?: string; // le résultat principal
  photo?: string; // la photo de départ d'une vidéo
  title?: string;
  pose?: unknown;
  error?: string;
};

/** Les rendus d'un compte, du plus récent au plus ancien (sans index composé : tri en mémoire). */
export async function listFal(account: string, max = 30): Promise<FalListed[]> {
  const snap = await col().where("account", "==", account).get();
  return snap.docs
    .filter((x) => x.id.startsWith("fal_") && Array.isArray((x.data() as Doc).shots) && !(x.data() as Doc).hidden)
    .map((x) => {
      const d = x.data() as Doc & { at?: { toMillis(): number } };
      const first = d.shots[0] ?? { view: "interieur" as const };
      const status = d.error ? "error" : d.done ? "done" : "running";
      const url = d.done ? (d.mode === "photo" ? first.photo : d.mode === "film" ? d.merged : first.video) : undefined;
      return {
        id: x.id,
        kind: d.mode,
        size: d.size,
        view: first.view,
        status,
        stage: status === "running" ? (d.stages[d.stage] ?? null) : null,
        stages: d.stages.length,
        stageNo: d.stage,
        at: d.at?.toMillis() ?? 0,
        shots: d.shots.length,
        ...(first.image ? { before: first.image } : first.photo && d.mode === "anime" ? { before: first.photo } : {}),
        ...(url ? { url } : {}),
        ...(d.done && d.mode !== "photo" && first.photo ? { photo: first.photo } : {}),
        ...(d.title ? { title: d.title } : {}),
        ...(d.pose ? { pose: d.pose } : {}),
        ...(d.error ? { error: d.error } : {}),
      } satisfies FalListed;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

/** retire un rendu de la liste de son auteur (les fichiers restent chez fal jusqu'à leur expiration) */
export async function hideFal(account: string, id: string) {
  const ref = col().doc(id);
  const d = (await ref.get()).data() as Doc | undefined;
  if (!d || d.account !== account) return false;
  await ref.update({ hidden: true });
  return true;
}
