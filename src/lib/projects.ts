/* Projets enregistrés en ligne (« Mon espace »), dans Firestore, côté serveur uniquement.
   xwe_projects/{id}               propriétaire, nom, dates, vignette, chiffres clés, projet en JSON (sans les images)
   xwe_projects/{id}/images/{clé}  images des plans importés (une par niveau), chacune sous 1 Mo
   Un document Firestore ne dépasse pas 1 Mo : le projet et ses images sont rangés à part. */
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { firestore } from "./firebaseAdmin";

export type ProjectSummary = { id: string; name: string; updatedAt: number; thumb: string; stats: ProjectStats };
export type ProjectStats = { rooms: number; area: number; levels: number };

const col = () => firestore().collection("xwe_projects");
const ID = /^[A-Za-z0-9_-]{4,40}$/;
const millis = (t: unknown) => (t && typeof (t as Timestamp).toMillis === "function" ? (t as Timestamp).toMillis() : 0);

export const validId = (id: string) => ID.test(id);

/** projets de l'utilisateur, du plus récent au plus ancien (sans le contenu, pour la liste) */
export async function listProjects(uid: string): Promise<ProjectSummary[]> {
  const snap = await col().where("owner", "==", uid).select("name", "updatedAt", "thumb", "stats").get();
  return snap.docs
    .map((d) => ({
      id: d.id,
      name: String(d.get("name") ?? ""),
      updatedAt: millis(d.get("updatedAt")),
      thumb: String(d.get("thumb") ?? ""),
      stats: (d.get("stats") as ProjectStats) ?? { rooms: 0, area: 0, levels: 1 },
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** le projet complet, avec ses images ; null s'il n'existe pas ou n'appartient pas à cet utilisateur */
export async function getProject(uid: string, id: string) {
  const doc = await col().doc(id).get();
  if (!doc.exists || doc.get("owner") !== uid) return null;
  const imgs = await doc.ref.collection("images").get();
  return {
    json: String(doc.get("json")),
    images: Object.fromEntries(imgs.docs.map((d) => [d.id, String(d.get("src"))])),
  };
}

/** Enregistre (ou crée) un projet. Les images envoyées remplacent celles de même clé ; celles qui ne servent plus sont effacées.
    Renvoie false si ce projet appartient à quelqu'un d'autre. */
export async function saveProject(
  uid: string,
  id: string,
  p: { name: string; json: string; thumb: string; stats: ProjectStats; images: Record<string, string>; keys: string[] },
) {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (doc.exists && doc.get("owner") !== uid) return false;
  const batch = firestore().batch();
  batch.set(
    ref,
    {
      owner: uid,
      name: p.name.slice(0, 120),
      json: p.json,
      thumb: p.thumb,
      stats: p.stats,
      updatedAt: FieldValue.serverTimestamp(),
      ...(doc.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  for (const [k, src] of Object.entries(p.images)) batch.set(ref.collection("images").doc(k), { src });
  const old = await ref.collection("images").listDocuments();
  for (const d of old) if (!p.keys.includes(d.id)) batch.delete(d);
  await batch.commit();
  return true;
}

export async function renameProject(uid: string, id: string, name: string) {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.get("owner") !== uid) return false;
  await ref.update({ name: name.slice(0, 120), updatedAt: FieldValue.serverTimestamp() });
  return true;
}

export async function deleteProject(uid: string, id: string) {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.get("owner") !== uid) return false;
  await firestore().recursiveDelete(ref);
  return true;
}

/** derniers mouvements de crédits (offerts, achats, rendus, remboursements) */
export async function creditHistory(uid: string, limit = 60) {
  const snap = await firestore().collection("xwe_accounts").doc(uid).collection("ledger").orderBy("at", "desc").limit(limit).get();
  return snap.docs.map((d) => ({ delta: Number(d.get("delta")), reason: String(d.get("reason")), at: millis(d.get("at")) }));
}
