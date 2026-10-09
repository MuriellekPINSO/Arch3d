/* Compte et solde affichés dans l'interface. Le vrai solde vit sur le serveur (/api/compte, dans Firestore). */
import { create } from "zustand";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { authHeader, clientAuth } from "./firebase";

export type User = { uid: string; email: string | null; name: string | null; photo: string | null; verified: boolean };

type CreditsState = {
  user: User | null;
  /** l'état de connexion est connu (Firebase a répondu) */
  authReady: boolean;
  credits: number | null;
  /** comptes branchés côté serveur (Firebase Admin) */
  accounts: boolean;
  /** FedaPay est branché */
  payment: boolean;
  /** mode test FedaPay : aucun vrai paiement */
  sandbox: boolean;
  buyOpen: boolean;
  loginOpen: boolean;
  setBuyOpen: (v: boolean) => void;
  setLoginOpen: (v: boolean) => void;
  setCredits: (n: number) => void;
  refresh: (force?: boolean) => Promise<void>;
  init: () => void;
  logout: () => Promise<void>;
};

// une seule lecture à la fois (le mode strict de React lance les effets deux fois en développement)
let inflight: Promise<void> | null = null;
let started = false;

export const useCredits = create<CreditsState>()((set, get) => ({
  user: null,
  authReady: false,
  credits: null,
  accounts: false,
  payment: false,
  sandbox: true,
  buyOpen: false,
  loginOpen: false,
  setBuyOpen: (buyOpen) => {
    // acheter demande d'être connecté
    if (buyOpen && !get().user) return set({ loginOpen: true });
    set({ buyOpen });
  },
  setLoginOpen: (loginOpen) => set({ loginOpen }),
  setCredits: (credits) => set({ credits }),
  refresh: (force = false) => {
    inflight ??= (async () => {
      try {
        const r = (await fetch("/api/compte", { cache: "no-store", headers: await authHeader(force) }).then((x) => x.json())) as {
          signedIn: boolean;
          credits: number | null;
          verified: boolean;
          accounts: boolean;
          payment: boolean;
          sandbox: boolean;
        };
        set({ credits: r.credits, accounts: r.accounts, payment: r.payment, sandbox: r.sandbox });
      } catch {
        /* hors ligne : on garde l'affichage précédent */
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  init: () => {
    if (started) return;
    started = true;
    const auth = clientAuth();
    if (!auth) {
      set({ authReady: true });
      get().refresh();
      return;
    }
    onAuthStateChanged(auth, (u) => {
      set({
        authReady: true,
        user: u ? { uid: u.uid, email: u.email, name: u.displayName, photo: u.photoURL, verified: u.emailVerified } : null,
        credits: null,
      });
      get().refresh();
    });
  },
  logout: async () => {
    const auth = clientAuth();
    if (auth) await signOut(auth);
    set({ buyOpen: false });
  },
}));
