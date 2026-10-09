/* Langue de l'interface (français ou anglais), retenue dans le navigateur.
   Au premier passage, on suit la langue du navigateur : français s'il est en français, anglais sinon.
   Les textes restent écrits à côté de leur usage : tr("Plan", "Floor plan"). */
import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { OPENING_DEFAULTS, OPENING_LABELS_EN, ROOM_LABELS, ROOM_LABELS_EN, type OpeningKind, type RoomType } from "./types";

export type Lang = "fr" | "en";

const guess = (): Lang => (typeof navigator !== "undefined" && navigator.language && !/^fr\b/i.test(navigator.language) ? "en" : "fr");

// localStorage peut être indisponible (navigation privée) : la langue reste alors en mémoire
const storage = createJSONStorage(() => ({
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
    } catch {}
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
}));

export const useLang = create<{ lang: Lang; setLang: (l: Lang) => void }>()(
  persist((set) => ({ lang: guess(), setLang: (lang) => set({ lang }) }), { name: "xwe-langue", storage }),
);

/** Dans un composant : `const tr = useTr()` puis `tr("Bonjour", "Hello")` ; se met à jour au changement de langue. */
export function useTr() {
  const lang = useLang((s) => s.lang);
  return useCallback((fr: string, en: string) => (lang === "en" ? en : fr), [lang]);
}

/** Hors composant (messages d'avancement, noms créés par l'app) : la langue du moment. */
export const tx = (fr: string, en: string) => (useLang.getState().lang === "en" ? en : fr);

export const roomLabel = (t: RoomType) => tx(ROOM_LABELS[t], ROOM_LABELS_EN[t]);
export const openingLabel = (k: OpeningKind) => tx(OPENING_DEFAULTS[k].label, OPENING_LABELS_EN[k]);
