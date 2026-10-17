/* fal.ai, côté serveur uniquement : les mêmes modèles open source que sur le pod, payés à l'usage, sans GPU à allumer.
   Clé : FAL_KEY (enregistrée par `npm run fal:cle`). Les fichiers partent du navigateur directement chez fal
   (adresse d'envoi signée fournie ici), les calculs passent par la file d'attente de fal. */

const KEY = process.env.FAL_KEY ?? "";
export const FAL_READY = KEY.length > 0;
// FAL_API_BASE : seulement pour les tests (faux fal local) ; sinon les vraies adresses de fal
const TEST_BASE = process.env.FAL_API_BASE?.replace(/\/$/, "") ?? "";
const REST = TEST_BASE || "https://rest.fal.ai";
const QUEUE = TEST_BASE ? `${TEST_BASE}/queue` : "https://queue.fal.run";

const auth = { Authorization: `Key ${KEY}`, "Content-Type": "application/json" };
// fichiers envoyés et produits : effacés par fal au bout de 30 jours
const LIFETIME = JSON.stringify({ expiration_duration_seconds: 30 * 24 * 3600 });

async function json(r: Response) {
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const d = j.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? JSON.stringify(d).slice(0, 300) : (j.message as string) ?? `HTTP ${r.status}`;
    throw new Error(`fal : ${msg}`);
  }
  return j;
}

/** adresse d'envoi signée (le navigateur y dépose le fichier) et adresse du fichier une fois déposé */
export async function uploadSlot(contentType: string, fileName: string) {
  const j = await json(
    await fetch(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      method: "POST",
      headers: { ...auth, "X-Fal-Object-Lifecycle": LIFETIME },
      body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    }),
  );
  return { uploadUrl: String(j.upload_url), fileUrl: String(j.file_url) };
}

/** une adresse de fichier produite par l'envoi ci-dessus, ou par un calcul fal */
export const isFalFile = (u: unknown): u is string =>
  typeof u === "string" && u.length < 600 && (/^https:\/\/([\w-]+\.)*fal\.(media|ai|run)\//.test(u) || (!!TEST_BASE && u.startsWith(`${TEST_BASE}/`)));

export type FalJob = { endpoint: string; requestId: string; statusUrl: string; responseUrl: string };

/** met un calcul dans la file d'attente de fal */
export async function submit(endpoint: string, input: Record<string, unknown>): Promise<FalJob> {
  const j = await json(
    await fetch(`${QUEUE}/${endpoint}`, { method: "POST", headers: { ...auth, "X-Fal-Object-Lifecycle": LIFETIME }, body: JSON.stringify(input) }),
  );
  const app = endpoint.split("/").slice(0, 2).join("/"); // suivi et résultat : par l'application, sans le sous-chemin
  const id = String(j.request_id);
  return {
    endpoint,
    requestId: id,
    statusUrl: String(j.status_url ?? `${QUEUE}/${app}/requests/${id}/status`),
    responseUrl: String(j.response_url ?? `${QUEUE}/${app}/requests/${id}`),
  };
}

/** état d'un calcul : en file, en cours, terminé (avec son résultat) ou en échec */
export async function poll(job: FalJob): Promise<{ state: "queued" | "running" | "done" | "error"; output?: Record<string, unknown>; error?: string }> {
  const s = await json(await fetch(job.statusUrl, { headers: auth, cache: "no-store" }));
  if (s.status === "IN_QUEUE") return { state: "queued" };
  if (s.status === "IN_PROGRESS") return { state: "running" };
  if (s.status !== "COMPLETED") return { state: "error", error: String(s.status) };
  try {
    return { state: "done", output: await json(await fetch(job.responseUrl, { headers: auth, cache: "no-store" })) };
  } catch (e) {
    return { state: "error", error: (e as Error).message };
  }
}
