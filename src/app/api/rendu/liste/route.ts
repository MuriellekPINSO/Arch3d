import { accountFrom } from "@/lib/credits";
import { FAL_READY } from "@/lib/fal";
import { hideFal, listFal } from "@/lib/falRender";
import { ADMIN_READY } from "@/lib/firebaseAdmin";

/* Les rendus du compte connecté (photos, vidéos, films), pour les retrouver après avoir fermé le panneau,
   rechargé la page ou changé d'appareil. DELETE ?id= : retire un rendu de la liste. */

export async function GET(request: Request) {
  if (!FAL_READY || !ADMIN_READY) return Response.json({ items: [] });
  const a = await accountFrom(request);
  if (!a) return Response.json({ items: [], needLogin: true }, { status: 401 });
  return Response.json({ items: await listFal(a.id) });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!FAL_READY || !ADMIN_READY || !/^fal_[\w-]{8,60}$/.test(id)) return Response.json({ ok: false }, { status: 400 });
  const a = await accountFrom(request);
  if (!a) return Response.json({ ok: false, needLogin: true }, { status: 401 });
  return Response.json({ ok: await hideFal(a.id, id) });
}
