/* Firebase côté navigateur : la connexion (Google ou email). La configuration web est publique par nature
   (console Firebase → Paramètres du projet → Vos applications) ; la sécurité vient des règles et du serveur. */
import { getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
// test local avec l'émulateur d'authentification (ex. 127.0.0.1:9099)
const EMULATOR = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR;

export const FIREBASE_READY = !!config.apiKey && !!config.projectId;

let auth: Auth | null = null;
export function clientAuth(): Auth | null {
  if (!FIREBASE_READY || typeof window === "undefined") return null;
  if (!auth) {
    auth = getAuth(getApps()[0] ?? initializeApp(config));
    if (EMULATOR) connectAuthEmulator(auth, `http://${EMULATOR}`, { disableWarnings: true });
  }
  return auth;
}

/** en-tête d'authentification pour les appels à l'API de Xwé (jeton rafraîchi par Firebase si besoin) */
export async function authHeader(force = false): Promise<Record<string, string>> {
  const u = clientAuth()?.currentUser;
  return u ? { Authorization: `Bearer ${await u.getIdToken(force)}` } : {};
}
