import { accountFrom } from "@/lib/credits";
import { FAL_READY, uploadSlot } from "@/lib/fal";
import { ADMIN_READY } from "@/lib/firebaseAdmin";

/* Adresse d'envoi signée chez fal.ai : le navigateur y dépose directement l'image, la profondeur ou la vidéo de profondeur
   (sans passer par Vercel, qui refuse les envois de plus de 4,5 Mo). Réservé aux comptes connectés. */
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4" };

export async function POST(request: Request) {
  if (!FAL_READY) return Response.json({ error: "rendus indisponibles" }, { status: 503 });
  const a = ADMIN_READY ? await accountFrom(request) : null;
  if (ADMIN_READY && !a) return Response.json({ error: "connexion requise", needLogin: true }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { type?: string } | null;
  const ext = TYPES[body?.type ?? ""];
  if (!ext) return Response.json({ error: "type de fichier refusé" }, { status: 400 });
  try {
    return Response.json(await uploadSlot(body!.type!, `xwe-${Date.now()}.${ext}`));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
