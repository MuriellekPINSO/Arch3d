import type { NextConfig } from "next";

// Connexion Google : la page de connexion de Firebase passe par l'adresse de Xwé (/__/auth/…),
// pour que la fenêtre de Google affiche le site de Xwé et pas l'adresse interne du projet Firebase.
const FIREBASE_HOST = `https://${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.firebaseapp.com`;

const nextConfig: NextConfig = {
  rewrites() {
    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return [];
    return [
      { source: "/__/auth/:path*", destination: `${FIREBASE_HOST}/__/auth/:path*` },
      { source: "/__/firebase/:path*", destination: `${FIREBASE_HOST}/__/firebase/:path*` },
    ];
  },
};

export default nextConfig;
