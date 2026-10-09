import { accountFrom } from "@/lib/credits";
import { ADMIN_READY } from "@/lib/firebaseAdmin";
import { deleteProject, getProject, renameProject, saveProject, validId, type ProjectStats } from "@/lib/projects";

/* Un projet de « Mon espace » : l'ouvrir (GET), l'enregistrer (PUT), le renommer (PATCH), le supprimer (DELETE). */
type Ctx = { params: Promise<{ id: string }> };

const MAX_JSON = 900_000; // un document Firestore ne dépasse pas 1 Mo
const MAX_IMAGE = 1_000_000;

async function who(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!validId(id)) return { error: Response.json({ error: "projet invalide" }, { status: 400 }) };
  const a = ADMIN_READY ? await accountFrom(request) : null;
  if (!a) return { error: Response.json({ error: "connexion requise" }, { status: 401 }) };
  return { id, uid: a.id };
}
const notFound = () => Response.json({ error: "projet introuvable" }, { status: 404 });

export async function GET(request: Request, ctx: Ctx) {
  const w = await who(request, ctx);
  if ("error" in w) return w.error;
  const p = await getProject(w.uid, w.id);
  return p ? Response.json(p) : notFound();
}

export async function PUT(request: Request, ctx: Ctx) {
  const w = await who(request, ctx);
  if ("error" in w) return w.error;
  const b = (await request.json().catch(() => null)) as {
    name?: string;
    json?: string;
    thumb?: string;
    stats?: ProjectStats;
    images?: Record<string, string>;
    keys?: string[];
  } | null;
  const images = b?.images ?? {};
  const keys = b?.keys ?? [];
  const ok =
    b &&
    typeof b.json === "string" &&
    b.json.length <= MAX_JSON &&
    typeof b.name === "string" &&
    (b.thumb ?? "").length <= 40_000 &&
    keys.every((k) => /^img\d{1,2}$/.test(k)) &&
    Object.entries(images).every(([k, v]) => keys.includes(k) && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length <= MAX_IMAGE);
  if (!ok) return Response.json({ error: "projet trop lourd ou invalide" }, { status: 400 });
  const stats = { rooms: Number(b.stats?.rooms) || 0, area: Number(b.stats?.area) || 0, levels: Number(b.stats?.levels) || 1 };
  const saved = await saveProject(w.uid, w.id, { name: b.name!, json: b.json!, thumb: b.thumb ?? "", stats, images, keys });
  return saved ? Response.json({ ok: true }) : Response.json({ error: "ce projet appartient à un autre compte" }, { status: 403 });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const w = await who(request, ctx);
  if ("error" in w) return w.error;
  const b = (await request.json().catch(() => null)) as { name?: string } | null;
  const name = (b?.name ?? "").trim();
  if (!name) return Response.json({ error: "nom vide" }, { status: 400 });
  return (await renameProject(w.uid, w.id, name)) ? Response.json({ ok: true }) : notFound();
}

export async function DELETE(request: Request, ctx: Ctx) {
  const w = await who(request, ctx);
  if ("error" in w) return w.error;
  return (await deleteProject(w.uid, w.id)) ? Response.json({ ok: true }) : notFound();
}
