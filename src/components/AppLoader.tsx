"use client";
import dynamic from "next/dynamic";
import Logo from "./Logo";

/* L'app vit entièrement dans le navigateur (projet sauvegardé en local, WebGL) : pas de rendu serveur.
   Pendant le chargement, le logo seul : pas de texte, donc rien à traduire avant de connaître la langue. */
const App = dynamic(() => import("./App"), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center">
      <Logo className="h-14 w-auto animate-pulse" />
    </div>
  ),
});

export default function AppLoader() {
  return <App />;
}
