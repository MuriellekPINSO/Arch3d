/* Firebase côté serveur (SDK Admin) : vérifie qui est connecté et tient les crédits dans Firestore.
   Clé du compte de service : FIREBASE_SERVICE_ACCOUNT_BASE64 (le fichier JSON téléchargé dans la console Firebase,
   encodé en base64 par `npm run firebase:cle -- chemin/vers/cle.json`, qui l'écrit dans .env.local sans l'afficher).
   En test local, les émulateurs Firebase suffisent (FIRESTORE_EMULATOR_HOST et FIREBASE_AUTH_EMULATOR_HOST). */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const RAW = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "";
const EMULATED = !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

/** comptes, crédits et paiements disponibles */
export const ADMIN_READY = RAW.length > 0 || EMULATED;

function app(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (RAW) {
    const sa = JSON.parse(Buffer.from(RAW, "base64").toString("utf8")) as { project_id: string; client_email: string; private_key: string };
    return initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }), projectId: sa.project_id });
  }
  return initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "demo-xwe" });
}

export const adminAuth = () => getAuth(app());
export const firestore = () => getFirestore(app());
