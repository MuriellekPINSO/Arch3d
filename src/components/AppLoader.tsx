"use client";
import dynamic from "next/dynamic";

/* L'app vit entièrement dans le navigateur (projet sauvegardé en local, WebGL) : pas de rendu serveur. */
const App = dynamic(() => import("./App"), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm text-muted">Chargement…</div>,
});

export default function AppLoader() {
  return <App />;
}
