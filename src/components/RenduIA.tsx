"use client";
/* Rendus IA open source (pod GPU) : la vue 3D devient une photo réaliste, puis une vidéo de 5 s. */
import { useEffect, useRef, useState } from "react";
import { Download, Film, ImageIcon, Loader2, Sparkles, X } from "lucide-react";

type View = "facade" | "aerien" | "interieur";

type Item = {
  id: string; // identifiant du calcul sur le pod
  kind: "photo" | "video";
  view: View;
  status: "running" | "done" | "error";
  queued?: boolean;
  url?: string;
  error?: string;
  t0: number;
  took?: number;
};

const toDataURL = (blob: Blob) =>
  new Promise<string>((ok) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.readAsDataURL(blob);
  });

export default function RenduIA({
  canvasRef,
  onClose,
  name,
  view,
  prepare,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onClose: () => void;
  name: string;
  view: "maquette" | "interieur";
  /** met la 3D dans l'état idéal pour l'IA (vrais sols, meubles, toit et cadrage pour la façade) ;
      renvoie de quoi rétablir les réglages */
  prepare: (kind: View) => Promise<() => void>;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  // suivi des calculs en cours
  useEffect(() => {
    const t = setInterval(async () => {
      setNow(Date.now());
      for (const it of itemsRef.current.filter((x) => x.status === "running")) {
        const r = await fetch(`/api/rendu?id=${it.id}`).then((x) => x.json()).catch(() => null);
        if (!r) continue;
        if (r.status === "running") {
          if (r.queued !== it.queued) setItems((list) => list.map((x) => (x.id === it.id ? { ...x, queued: r.queued } : x)));
          continue;
        }
        setItems((list) =>
          list.map((x) =>
            x.id === it.id
              ? { ...x, status: r.status, url: r.files?.[0]?.url, error: r.error, took: Math.round((Date.now() - x.t0) / 1000) }
              : x,
          ),
        );
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const start = async (kind: "photo" | "video", image: string, v: View, size?: "hd" | "rapide") => {
    setError(null);
    const r = await fetch("/api/rendu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: kind, image, extra, size, view: v }),
    })
      .then((x) => x.json())
      .catch(() => ({ error: "Serveur injoignable." }));
    if (r.error) return setError(r.error);
    setItems((l) => [{ id: r.id, kind, view: v, status: "running", t0: Date.now() }, ...l]);
  };

  const photoOfView = async (v: View) => {
    const c = canvasRef.current;
    if (!c) return setError("Pas de vue 3D à rendre.");
    const restore = await prepare(v);
    const png = c.toDataURL("image/png");
    restore();
    start("photo", png, v);
  };

  const animate = async (it: Item, size: "hd" | "rapide") => {
    if (!it.url) return;
    const blob = await fetch(it.url).then((r) => r.blob());
    start("video", await toDataURL(blob), it.view, size);
  };

  return (
    <div className="absolute bottom-5 right-5 z-20 flex max-h-[calc(100%-110px)] w-[360px] flex-col overflow-hidden rounded-2xl bg-paper shadow-2xl ring-1 ring-line">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 font-display text-[15px] font-semibold">
          <Sparkles className="size-4 text-accent" /> Rendu IA réaliste
        </div>
        <button onClick={onClose} className="rounded-full p-1 text-muted hover:bg-cream">
          <X className="size-4" />
        </button>
      </div>
      <div className="space-y-2.5 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted">
          {view === "maquette"
            ? "Depuis la maquette : la façade de la vraie maison (toit-terrasse ajouté, cadrage automatique), ou une vue en coupe vue du ciel. Pour une pièce, passez en Visite libre."
            : "Placez-vous dans une pièce, puis transformez la vue en photo réaliste. Une photo peut ensuite être animée en vidéo de 5 s."}
        </p>
        <input
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Ambiance (facultatif) : lumière du soir, style afro-chic…"
          className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        />
        {view === "maquette" ? (
          <div className="flex gap-2">
            <button onClick={() => photoOfView("facade")} className="flex flex-[3] items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:brightness-105">
              <ImageIcon className="size-4" /> Façade réaliste
            </button>
            <button onClick={() => photoOfView("aerien")} className="flex flex-[2] items-center justify-center gap-1.5 rounded-xl bg-cream py-2.5 text-sm font-medium text-ink hover:bg-sand">
              Vue en coupe
            </button>
          </div>
        ) : (
          <button onClick={() => photoOfView("interieur")} className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:brightness-105">
            <ImageIcon className="size-4" /> Photo réaliste de cette vue · ~20 s
          </button>
        )}
        {error && <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink">{error}</p>}
      </div>
      <div className="scroll-soft min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {items.map((it) => (
          <div key={it.id} className="overflow-hidden rounded-xl bg-white ring-1 ring-line">
            {it.status === "running" && (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted">
                <Loader2 className="size-4 animate-spin text-accent" />
                {it.queued ? "Démarrage du GPU…" : `${it.kind === "photo" ? "Photo" : "Vidéo"} en cours…`} {Math.round((now - it.t0) / 1000)} s
              </div>
            )}
            {it.status === "error" && <div className="px-3 py-3 text-xs text-accent">Échec : {it.error}</div>}
            {it.status === "done" && it.url && (
              <>
                {it.kind === "photo" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.url} alt="Rendu réaliste" className="block w-full" />
                ) : (
                  <video src={it.url} controls autoPlay loop muted playsInline className="block w-full" />
                )}
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 text-xs">
                  <span className="mr-auto text-muted">{it.took} s</span>
                  {it.kind === "photo" && (
                    <>
                      <button onClick={() => animate(it, "rapide")} className="inline-flex items-center gap-1 rounded-lg bg-cream px-2 py-1 font-medium hover:bg-sand" title="480p, environ 1 min 30">
                        <Film className="size-3.5" /> Vidéo rapide
                      </button>
                      <button onClick={() => animate(it, "hd")} className="inline-flex items-center gap-1 rounded-lg bg-ink px-2 py-1 font-medium text-paper hover:brightness-110" title="720p, environ 4 min">
                        <Film className="size-3.5" /> Vidéo HD
                      </button>
                    </>
                  )}
                  <a
                    href={it.url}
                    download={`${name}-${it.kind}-${it.id.slice(0, 6)}.${it.kind === "photo" ? "png" : "mp4"}`}
                    className="inline-flex items-center gap-1 rounded-lg bg-cream px-2 py-1 font-medium hover:bg-sand"
                  >
                    <Download className="size-3.5" />
                  </a>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
