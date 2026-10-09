import { accountFrom } from "@/lib/credits";
import { ADMIN_READY } from "@/lib/firebaseAdmin";
import { listProjects } from "@/lib/projects";

/* « Mon espace » : la liste des projets de l'utilisateur connecté. */
export async function GET(request: Request) {
  const a = ADMIN_READY ? await accountFrom(request) : null;
  if (!a) return Response.json({ error: "connexion requise" }, { status: 401 });
  return Response.json({ projects: await listProjects(a.id) });
}
