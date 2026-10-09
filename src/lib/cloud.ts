/* « Mon espace » côté navigateur : enregistrement automatique du projet en ligne, liste, ouverture, suppression.
   Les images des plans partent à part (une par niveau) et seulement quand elles ont changé. */
import { useEffect, useState } from "react";
import { useCredits } from "./creditsStore";
import { authHeader } from "./firebase";
import { useLang } from "./i18n";
import { useProject } from "./store";
import { projectStats, projectThumb } from "./thumb";
import { uid, type Background, type Project } from "./types";
import type { ProjectSummary } from "./projects";

export type { ProjectSummary };

const api = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-lang": useLang.getState().lang, ...(await authHeader()), ...(init.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status });
  return j;
};

/** Ré-encode une image trop lourde (même taille en pixels : la lecture du plan s'appuie sur ses dimensions). */
async function lighten(src: string, max = 950_000): Promise<string | null> {
  if (src.length <= max) return src;
  const img = new Image();
  img.src = src;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(img, 0, 0);
  for (const q of [0.8, 0.7, 0.6, 0.5, 0.4]) {
    const out = cv.toDataURL("image/jpeg", q);
    if (out.length <= max) return out;
  }
  return null; // vraiment trop lourde : le projet part sans cette image
}

// empreinte rapide d'une image, pour ne renvoyer que celles qui ont changé
const print = (s: string) => `${s.length}:${s.slice(64, 96)}:${s.slice(-32)}`;
const sent = new Map<string, string>(); // `${projet}/${clé}` → empreinte envoyée

/** Retire les images du projet (remplacées par « img0 », « img1 »…) et renvoie celles à envoyer. */
async function split(p: Project, id: string) {
  const copy: Project = JSON.parse(JSON.stringify(p));
  const found: [string, Background][] = [];
  if (copy.background) found.push(["img0", copy.background]);
  copy.levels?.forEach((L, i) => L.data?.background && found.push([`img${i + 1}`, L.data.background]));
  const images: Record<string, string> = {};
  const keys: string[] = [];
  for (const [k, bg] of found) {
    if (!bg.src.startsWith("data:")) continue;
    const fp = print(bg.src);
    if (sent.get(`${id}/${k}`) !== fp) {
      const light = await lighten(bg.src);
      if (!light) {
        bg.src = "";
        continue;
      }
      images[k] = light;
    }
    keys.push(k);
    bg.src = `xwe:${k}`;
  }
  return { copy, images, keys };
}

/** Enregistre le projet dans « Mon espace ». */
export async function saveProject(p: Project, id: string) {
  const originals = new Map<string, string>();
  if (p.background) originals.set("img0", p.background.src);
  p.levels?.forEach((L, i) => L.data?.background && originals.set(`img${i + 1}`, L.data.background.src));
  const { copy, images, keys } = await split(p, id);
  await api(`/api/projets/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name: p.name, json: JSON.stringify(copy), thumb: projectThumb(p), stats: projectStats(p), images, keys }),
  });
  for (const k of keys) sent.set(`${id}/${k}`, print(originals.get(k)!));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return ((await api("/api/projets")) as { projects: ProjectSummary[] }).projects;
}

/** Ouvre un projet : le JSON, avec ses images remises en place. */
export async function openProject(id: string): Promise<Project> {
  const r = (await api(`/api/projets/${id}`)) as { json: string; images: Record<string, string> };
  const p = JSON.parse(r.json) as Project;
  const put = (bg: Background | null | undefined, key: string) => {
    if (!bg) return;
    const k = bg.src.startsWith("xwe:") ? bg.src.slice(4) : key;
    bg.src = r.images[k] ?? "";
    if (bg.src) sent.set(`${id}/${k}`, print(bg.src));
  };
  put(p.background, "img0");
  p.levels?.forEach((L, i) => put(L.data?.background, `img${i + 1}`));
  // une image perdue : on garde le projet, sans le plan en fond
  if (p.background && !p.background.src) p.background = null;
  p.levels?.forEach((L) => L.data?.background && !L.data.background.src && (L.data.background = null));
  return { ...p, id };
}

export const renameProject = (id: string, name: string) => api(`/api/projets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
export const deleteProject = (id: string) => api(`/api/projets/${id}`, { method: "DELETE" });

export type LedgerEntry = { delta: number; reason: string; at: number };
export async function creditHistory(): Promise<LedgerEntry[]> {
  return ((await api("/api/compte/historique")) as { history: LedgerEntry[] }).history;
}

/* ---------- enregistrement automatique ---------- */

export type SaveStatus = "off" | "waiting" | "saving" | "saved" | "error";

// dernier état du projet déjà en ligne (rien à renvoyer tant qu'il n'a pas changé)
let lastSaved: Project | null = null;
/** le projet vient d'être ouvert depuis « Mon espace » : il est déjà à jour en ligne */
export const markSaved = (p: Project) => {
  lastSaved = p;
};

const hasContent = (p: Project) => p.walls.length > 0 || p.rooms.length > 0 || !!p.background || (p.levels?.length ?? 0) > 1;

/** Tant que l'utilisateur est connecté, chaque modification du projet part dans « Mon espace » (2,5 s après la dernière). */
export function useAutosave(): SaveStatus {
  const user = useCredits((s) => s.user);
  const project = useProject((s) => s.project);
  const [status, setStatus] = useState<SaveStatus>("off");
  useEffect(() => {
    if (!user || !hasContent(project) || project === lastSaved) return;
    const t = setTimeout(async () => {
      setStatus("saving");
      const run = async (id: string) => {
        await saveProject(project, id);
        if (project.id !== id) useProject.getState().patch({ id });
        lastSaved = useProject.getState().project;
      };
      try {
        await run(project.id ?? uid() + uid());
        setStatus("saved");
      } catch (e) {
        // projet d'un autre compte (ouvert depuis un fichier, ou autre session) : il devient une copie à soi
        if ((e as { status?: number }).status === 403) {
          try {
            await run(uid() + uid());
            setStatus("saved");
            return;
          } catch {}
        }
        setStatus("error");
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [user, project]);
  if (!user) return "off";
  // une modification attend son tour : « Enregistré » ne s'affiche plus tant qu'elle n'est pas partie
  if (status === "saved" && project !== lastSaved) return "waiting";
  return status;
}
