"use client";
/* Les rendus IA (photos, vidéos, films) : suivis pour toute l'app, même panneau fermé. Ceux faits chez fal.ai sont
   relus depuis le compte (/api/rendu/liste) : on les retrouve après un rechargement ou sur un autre appareil. */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { ShotPose } from "@/components/three/capture";
import { useCredits } from "./creditsStore";
import { authHeader } from "./firebase";
import { useLang } from "./i18n";

export type RenderKind = "photo" | "video" | "visite" | "anime" | "film";
export type RenderView = "facade" | "aerien" | "interieur";
export type RenderSize = "rapide" | "hd" | "max";

export type RenderItem = {
  id: string; // calcul chez fal ou sur le pod ; « tmp_… » tant qu'il n'est pas lancé
  kind: RenderKind;
  view: RenderView;
  size?: RenderSize;
  status: "preparing" | "sending" | "running" | "done" | "error";
  prep?: number; // préparation dans le navigateur, de 0 à 1
  queued?: boolean;
  stage?: "photo" | "video" | "merge" | null; // étape en cours chez fal
  shots?: number; // nombre de plans (film)
  before?: string; // la vue 3D envoyée à l'IA
  url?: string; // le résultat
  photo?: string; // la photo qui ouvre une vidéo
  pose?: ShotPose; // point de vue de la photo, pour l'animer depuis la même vue
  title?: string;
  error?: string;
  t0: number;
  took?: number;
  fresh?: boolean; // terminé et pas encore regardé
};

type State = {
  items: RenderItem[];
  owner: string | null;
  /** une capture occupe la 3D (la caméra bouge) : une seule à la fois */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  add: (it: RenderItem) => void;
  patch: (id: string, p: Partial<RenderItem>) => void;
  remove: (id: string) => Promise<void>;
  markSeen: () => void;
  load: () => Promise<void>;
  poll: () => Promise<RenderItem[]>;
};

const lang = () => ({ "x-lang": useLang.getState().lang });

export const useRenders = create<State>((set, get) => ({
  items: [],
  owner: null,
  busy: false,
  setBusy: (busy) => set({ busy }),
  add: (it) => set({ items: [it, ...get().items] }),
  patch: (id, p) => set({ items: get().items.map((x) => (x.id === id ? { ...x, ...p } : x)) }),
  remove: async (id) => {
    set({ items: get().items.filter((x) => x.id !== id) });
    if (id.startsWith("fal_"))
      await fetch(`/api/rendu/liste?id=${id}`, { method: "DELETE", headers: { ...lang(), ...(await authHeader()) } }).catch(() => {});
  },
  markSeen: () => {
    if (get().items.some((x) => x.fresh)) set({ items: get().items.map((x) => (x.fresh ? { ...x, fresh: false } : x)) });
  },

  /** relit les rendus du compte ; garde ceux qui se préparent encore dans ce navigateur */
  load: async () => {
    const uid = useCredits.getState().user?.uid ?? null;
    if (!uid) return;
    const r = (await fetch("/api/rendu/liste", { headers: { ...lang(), ...(await authHeader()) }, cache: "no-store" })
      .then((x) => x.json())
      .catch(() => null)) as { items?: Listed[] } | null;
    if (!r?.items || useCredits.getState().user?.uid !== uid) return;
    const mine = new Map(get().items.map((x) => [x.id, x]));
    const server: RenderItem[] = r.items.map((s) => {
      const local = mine.get(s.id);
      return {
        id: s.id,
        kind: s.kind,
        view: s.view,
        size: s.size,
        status: s.status,
        stage: s.stage,
        shots: s.shots,
        before: s.before ?? local?.before,
        url: s.url,
        photo: s.photo,
        pose: (s.pose as ShotPose | undefined) ?? local?.pose,
        title: s.title ?? local?.title,
        error: s.error,
        t0: s.at || local?.t0 || Date.now(),
        took: local?.took,
        fresh: local ? local.fresh || (local.status !== "done" && s.status === "done") : false,
      };
    });
    const known = new Set(server.map((x) => x.id));
    const pending = get().items.filter((x) => !known.has(x.id) && (x.id.startsWith("tmp_") || !x.id.startsWith("fal_")));
    set({ items: [...pending, ...server], owner: uid });
  },

  /** fait avancer les calculs en cours (chez fal, chaque étape part quand on demande où il en est) */
  poll: async () => {
    const running = get().items.filter((x) => x.status === "running" && !x.id.startsWith("tmp_"));
    const finished: RenderItem[] = [];
    await Promise.all(
      running.map(async (it) => {
        const r = await fetch(`/api/rendu?id=${it.id}`, { headers: lang(), cache: "no-store" })
          .then((x) => x.json())
          .catch(() => null);
        // réponse inattendue (coupure, identifiant inconnu) : on redemandera
        if (!r || !["running", "done", "error"].includes(r.status)) return;
        if (r.status === "running") {
          if (r.queued !== it.queued) get().patch(it.id, { queued: r.queued });
          return;
        }
        if (r.status === "error") useCredits.getState().refresh();
        const files = (r.files ?? []) as { url: string; video: boolean }[];
        const main = it.kind === "photo" ? files.find((f) => !f.video) : files.find((f) => f.video);
        const p: Partial<RenderItem> = {
          status: r.status,
          url: main?.url ?? files[0]?.url,
          photo: it.kind === "photo" ? undefined : files.find((f) => !f.video)?.url,
          error: r.error,
          took: Math.round((Date.now() - it.t0) / 1000),
          fresh: r.status === "done",
        };
        get().patch(it.id, p);
        finished.push({ ...it, ...p });
      }),
    );
    return finished;
  },
}));

// en développement seulement : les scripts de test (Chrome sans fenêtre) remplissent la liste à la main
if (process.env.NODE_ENV === "development" && typeof window !== "undefined") (window as unknown as { __xweRenders?: unknown }).__xweRenders = useRenders;

type Listed = {
  id: string;
  kind: RenderKind;
  size: RenderSize;
  view: RenderView;
  status: "running" | "done" | "error";
  stage: "photo" | "video" | "merge" | null;
  shots: number;
  at: number;
  before?: string;
  url?: string;
  photo?: string;
  title?: string;
  pose?: unknown;
  error?: string;
};

/** Durée de calcul attendue, en secondes (chez fal : plans calculés en parallèle ; sur le pod : l'un après l'autre). */
export function renderEta(kind: RenderKind, size: RenderSize = "hd", shots = 1, onFal = true) {
  const clip = onFal ? { rapide: 120, hd: 240, max: 330 }[size] : { rapide: 80, hd: 160, max: 360 }[size];
  const photo = onFal ? 25 : 20;
  if (kind === "photo") return photo;
  if (kind === "anime" || kind === "video") return clip;
  if (kind === "visite") return photo + clip;
  // film : toutes les photos, toutes les vidéos, puis le montage
  return onFal ? photo + clip * Math.ceil(shots / 4) + 45 : shots * (photo + clip) + 60;
}

/** Suivi permanent, monté une fois dans l'app : relit le compte, fait avancer les calculs, prévient quand c'est prêt. */
export function useRenderWatch(onReady: (it: RenderItem) => void) {
  const uid = useCredits((s) => s.user?.uid ?? null);
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  useEffect(() => {
    const s = useRenders.getState();
    if (uid !== s.owner) useRenders.setState({ items: s.items.filter((x) => x.id.startsWith("tmp_")), owner: uid });
    if (uid) void useRenders.getState().load();
  }, [uid]);
  useEffect(() => {
    let tick = 0;
    const t = setInterval(async () => {
      const done = await useRenders.getState().poll();
      done.forEach((it) => ready.current(it));
      // les étapes (photos → vidéos → montage) se relisent de temps en temps
      if (++tick % 8 === 0 && useRenders.getState().items.some((x) => x.status === "running" && x.id.startsWith("fal_")))
        void useRenders.getState().load();
    }, 2500);
    return () => clearInterval(t);
  }, []);
}
