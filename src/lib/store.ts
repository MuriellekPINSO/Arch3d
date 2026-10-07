"use client";
/* État du projet (zustand), avec annuler / rétablir et sauvegarde locale.
   Les sélecteurs doivent renvoyer des valeurs stables (champ du store ou primitive) :
   un objet ou un tableau recréé à chaque lecture provoque une boucle de rendu. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Background, Opening, Project, Room, Wall } from "./types";

export const EMPTY_PROJECT: Project = {
  name: "Nouveau projet",
  walls: [],
  openings: [],
  rooms: [],
  background: null,
  styleId: "contemporain",
  furnished: true,
};

type Data = Pick<Project, "walls" | "openings" | "rooms" | "background" | "furniture" | "levels" | "level">;

interface Store {
  project: Project;
  past: Data[];
  future: Data[];
  /** applique une modification et l'enregistre dans l'historique */
  commit: (fn: (p: Project) => Partial<Project>) => void;
  /** modification hors historique (nom, style…) */
  patch: (p: Partial<Project>) => void;
  undo: () => void;
  redo: () => void;
  load: (p: Project) => void;
  addWalls: (w: Wall[]) => void;
  updateWall: (id: string, w: Partial<Wall>) => void;
  addOpening: (o: Opening) => void;
  updateOpening: (id: string, o: Partial<Opening>) => void;
  addRoom: (r: Room) => void;
  updateRoom: (id: string, r: Partial<Room>) => void;
  /** pièce d'un niveau quelconque (le niveau actif est dans rooms, les autres dans levels) */
  updateRoomIn: (level: number, id: string, r: Partial<Room>) => void;
  remove: (id: string) => void;
  setBackground: (b: Background | null) => void;
}

/* localStorage peut être plein (image de plan trop lourde) ou indisponible : on ne casse pas l'app pour ça. */
const safeStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* quota dépassé : le projet reste en mémoire */
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const snapshot = (p: Project): Data => ({
  walls: p.walls,
  openings: p.openings,
  rooms: p.rooms,
  background: p.background,
  furniture: p.furniture,
  levels: p.levels,
  level: p.level,
});

export const useProject = create<Store>()(
  persist(
    (set, get) => ({
      project: EMPTY_PROJECT,
      past: [],
      future: [],
      commit: (fn) =>
        set((s) => ({
          past: [...s.past.slice(-49), snapshot(s.project)],
          future: [],
          project: { ...s.project, ...fn(s.project) },
        })),
      patch: (p) => set((s) => ({ project: { ...s.project, ...p } })),
      undo: () =>
        set((s) => {
          const prev = s.past[s.past.length - 1];
          if (!prev) return s;
          return { past: s.past.slice(0, -1), future: [snapshot(s.project), ...s.future], project: { ...s.project, ...prev } };
        }),
      redo: () =>
        set((s) => {
          const nxt = s.future[0];
          if (!nxt) return s;
          return { future: s.future.slice(1), past: [...s.past, snapshot(s.project)], project: { ...s.project, ...nxt } };
        }),
      load: (p) => set({ project: p, past: [], future: [] }),
      addWalls: (w) => get().commit((p) => ({ walls: [...p.walls, ...w] })),
      updateWall: (id, w) => get().commit((p) => ({ walls: p.walls.map((x) => (x.id === id ? { ...x, ...w } : x)) })),
      addOpening: (o) => get().commit((p) => ({ openings: [...p.openings, o] })),
      updateOpening: (id, o) => get().commit((p) => ({ openings: p.openings.map((x) => (x.id === id ? { ...x, ...o } : x)) })),
      addRoom: (r) => get().commit((p) => ({ rooms: [...p.rooms, r] })),
      updateRoom: (id, r) => get().commit((p) => ({ rooms: p.rooms.map((x) => (x.id === id ? { ...x, ...r } : x)) })),
      updateRoomIn: (level, id, r) => {
        const p = get().project;
        if (level === (p.level ?? 0) || !p.levels?.[level]?.data) return get().updateRoom(id, r);
        get().commit((q) => ({
          levels: q.levels!.map((l, i) =>
            i === level && l.data ? { ...l, data: { ...l.data, rooms: l.data.rooms.map((x) => (x.id === id ? { ...x, ...r } : x)) } } : l,
          ),
        }));
      },
      remove: (id) =>
        get().commit((p) => ({
          walls: p.walls.filter((x) => x.id !== id),
          openings: p.openings.filter((x) => x.id !== id && x.wallId !== id),
          rooms: p.rooms.filter((x) => x.id !== id),
        })),
      setBackground: (b) => get().commit(() => ({ background: b })),
    }),
    {
      name: "plan3d.projet",
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ project: s.project }),
    },
  ),
);
