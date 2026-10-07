"use client";
/* Rendus IA open source (pod GPU) : la vue 3D devient une photo réaliste, puis une vidéo de 5 s ;
   ou un plan de la visite guidée filmé tel quel, que l'IA habille en suivant la profondeur de chaque image. */
import { useEffect, useRef, useState } from "react";
import { Clapperboard, Download, Film, ImageIcon, Loader2, Route, Sparkles, X } from "lucide-react";
import { SHOT_FRAMES, type CaptureAPI, type ShotPose } from "./three/capture";

type View = "facade" | "aerien" | "interieur";
type Size = "hd" | "rapide" | "max"; // max : 720p affinée en 1080p, 32 images/s

type Item = {
  id: string; // identifiant du calcul sur le pod
  kind: "photo" | "video" | "visite" | "anime" | "film";
  view: View;
  status: "running" | "done" | "error";
  queued?: boolean;
  url?: string;
  photo?: string; // visite : la photo de la première image
  depth?: string; // profondeur envoyée à l'IA (objet local, pour vérifier)
  pose?: ShotPose; // point de vue de la photo, pour l'animer depuis la même vue
  title?: string;
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
  capture,
  stops,
  filmRooms,
  currentStop,
  onClose,
  name,
  view,
  prepare,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  capture: React.RefObject<CaptureAPI | null>;
  /** pièces de la visite guidée, dans l'ordre */
  stops: string[];
  /** identifiants de ces pièces */
  stopRooms: string[];
  /** pièces du film complet, dans l'ordre de la visite (sans les très petites) */
  filmRooms: { id: string; name: string }[];
  currentStop: number;
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
  const [lock, setLock] = useState(true); // géométrie verrouillée par la carte de profondeur
  const [stop, setStop] = useState(() => Math.max(0, currentStop));
  const [filming, setFilming] = useState<{ done: number; total: number } | null>(null);
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
        const files = (r.files ?? []) as { url: string; video: boolean }[];
        const main = it.kind === "photo" ? files.find((f) => !f.video) : files.find((f) => f.video);
        setItems((list) =>
          list.map((x) =>
            x.id === it.id
              ? {
                  ...x,
                  status: r.status,
                  url: main?.url ?? files[0]?.url,
                  photo: it.kind === "visite" || it.kind === "film" ? files.find((f) => !f.video)?.url : undefined,
                  error: r.error,
                  took: Math.round((Date.now() - x.t0) / 1000),
                }
              : x,
          ),
        );
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const start = async (
    kind: Item["kind"],
    image: string,
    v: View,
    opts: { size?: Size; depth?: string; control?: string; preview?: string; title?: string; pose?: ShotPose } = {},
  ) => {
    setError(null);
    const r = await fetch("/api/rendu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: kind, image, extra, size: opts.size, view: v, depth: opts.depth, control: opts.control }),
    })
      .then((x) => x.json())
      .catch(() => ({ error: "Serveur injoignable." }));
    if (r.error) return setError(r.error);
    setItems((l) => [{ id: r.id, kind, view: v, status: "running", t0: Date.now(), depth: opts.preview, title: opts.title, pose: opts.pose }, ...l]);
  };

  const photoOfView = async (v: View) => {
    const c = canvasRef.current;
    if (!c) return setError("Pas de vue 3D à rendre.");
    const restore = await prepare(v);
    let png: string;
    let depth: Blob | null = null;
    let pose: ShotPose | undefined;
    try {
      png = c.toDataURL("image/png");
      pose = capture.current?.pose();
      if (lock) depth = (await capture.current?.depthOfView()) ?? null;
    } catch (e) {
      return setError(`Capture impossible : ${(e as Error).message}`);
    } finally {
      restore();
    }
    start("photo", png, v, { pose, ...(depth ? { depth: await toDataURL(depth), preview: URL.createObjectURL(depth) } : {}) });
  };

  /** Anime une photo : la 3D refait sa vue et bouge un peu (travelling avant dans une pièce, rotation autour de la
      maison sinon) ; l'IA suit cette profondeur image par image, avec l'aspect de la photo. */
  const animate = async (it: Item, size: Size) => {
    if (!it.url) return;
    const photo = await toDataURL(await fetch(it.url).then((r) => r.blob()));
    const api = capture.current;
    if (!it.pose || !api) return start("video", photo, it.view, { size }); // photo sans point de vue connu : vidéo libre
    const [w, h] = size === "rapide" ? [832, 480] : [1280, 720];
    setError(null);
    setFilming({ done: 0, total: 1 });
    const restore = await prepare(it.view);
    let control: Blob;
    try {
      control = (await api.moveShot(it.pose, it.view === "interieur" ? "dolly" : "orbit", w, h, (done, total) => setFilming({ done, total }))).control;
    } catch (e) {
      return setError(`Préparation impossible : ${(e as Error).message}`);
    } finally {
      restore();
      setFilming(null);
    }
    start("anime", photo, it.view, { size, control: await toDataURL(control), preview: URL.createObjectURL(control), title: "Photo animée" });
  };

  /** Film complet : la façade (rotation lente), puis chaque pièce dans l'ordre de la visite guidée (5 s par plan),
      rendus par l'IA et mis bout à bout dans une seule vidéo. */
  const filmAll = async (size: Size) => {
    const api = capture.current;
    if (!api) return setError("La 3D n'est pas prête.");
    const [w, h] = size === "rapide" ? [832, 480] : [1280, 720];
    const rooms = filmRooms.slice(0, 15).map((r) => r.id);
    const total = (rooms.length + 1) * SHOT_FRAMES;
    let done = 0;
    const step = (d: number) => setFilming({ done: done + d, total });
    setError(null);
    setFilming({ done: 0, total });
    const shots: { shot: Awaited<ReturnType<CaptureAPI["tourShot"]>>; view: "facade" | "interieur" }[] = [];
    try {
      let restore = await prepare("facade");
      try {
        shots.push({ shot: await api.moveShot(api.pose(), "orbit", w, h, step), view: "facade" });
        done += SHOT_FRAMES;
      } finally {
        restore();
      }
      restore = await prepare("interieur");
      try {
        for (let i = 0; i < rooms.length; i++) {
          // film : chaque pièce filmée depuis son meilleur angle, comme par un photographe immobilier
          shots.push({ shot: await api.roomShot(rooms[i], w, h, step), view: "interieur" });
          done += SHOT_FRAMES;
        }
      } finally {
        restore();
      }
    } catch (e) {
      return setError(`Préparation impossible : ${(e as Error).message}`);
    } finally {
      setFilming(null);
    }
    setError(null);
    const payload = await Promise.all(
      shots.map(async ({ shot, view }) => ({ image: shot.first, depth: await toDataURL(shot.firstDepth), control: await toDataURL(shot.control), view })),
    );
    const r = await fetch("/api/rendu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "film", size, extra, shots: payload }),
    })
      .then((x) => x.json())
      .catch(() => ({ error: "Serveur injoignable." }));
    if (r.error) return setError(r.error);
    setItems((l) => [{ id: r.id, kind: "film", view: "interieur", status: "running", t0: Date.now(), title: `Film complet · ${shots.length} plans` }, ...l]);
  };
  /** durée de calcul estimée sur L40S, en minutes */
  const filmMinutes = (size: Size) => Math.round((Math.min(filmRooms.length, 15) + 1) * (size === "rapide" ? 1.3 : size === "hd" ? 2.6 : 3.4) + (size === "max" ? 2 : 0));

  /** Filme un plan de la visite guidée (profondeur image par image) et l'envoie à l'IA. */
  const filmTour = async (size: Size) => {
    const api = capture.current;
    if (!api) return setError("La 3D n'est pas prête.");
    const [w, h] = size === "rapide" ? [832, 480] : [1280, 720];
    setError(null);
    setFilming({ done: 0, total: 1 });
    const restore = await prepare("interieur");
    let shot: Awaited<ReturnType<CaptureAPI["tourShot"]>>;
    try {
      shot = await api.tourShot(stop, w, h, (done, total) => setFilming({ done, total }));
    } catch (e) {
      return setError(`Préparation impossible : ${(e as Error).message}`);
    } finally {
      restore();
      setFilming(null);
    }
    const [depth, control] = await Promise.all([toDataURL(shot.firstDepth), toDataURL(shot.control)]);
    start("visite", shot.first, "interieur", { size, depth, control, preview: URL.createObjectURL(shot.control), title: stops[stop] });
  };

  const btn = "inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium";
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
        <label className="flex cursor-pointer items-start gap-2 text-xs leading-snug text-muted">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="mt-0.5 accent-[var(--color-accent)]" />
          <span>
            <span className="font-medium text-ink">Géométrie verrouillée</span> : la profondeur exacte de la 3D accompagne la capture, murs et
            ouvertures restent ceux du plan.
          </span>
        </label>

        {filmRooms.length > 0 && (
          <div className="space-y-2 rounded-xl bg-ink p-3 text-paper">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Clapperboard className="size-4 text-accent" /> Film complet de la maison
            </div>
            <p className="text-xs leading-relaxed text-paper/70">
              La façade, puis chaque pièce filmée depuis son meilleur angle, dans l&apos;ordre de la visite ({Math.min(filmRooms.length, 15)} pièces,
              5 s chacune), en une seule vidéo fidèle au plan.
            </p>
            {!filming && (
              <div className="flex gap-1.5">
                {(
                  [
                    ["rapide", "480p"],
                    ["hd", "720p"],
                    ["max", "1080p max"],
                  ] as const
                ).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => filmAll(k)}
                    className={`flex flex-1 flex-col items-center rounded-lg py-1.5 text-xs font-medium ${k === "max" ? "bg-accent text-white hover:brightness-105" : "bg-paper/10 hover:bg-paper/20"}`}
                    title="Durée de calcul estimée sur le GPU"
                  >
                    {l}
                    <span className="text-[10px] font-normal opacity-75">~{filmMinutes(k)} min</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {view === "interieur" && stops.length > 0 && (
          <div className="space-y-2 rounded-xl bg-cream/60 p-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Route className="size-4 text-accent" /> Vidéo fidèle de la visite
            </div>
            <p className="text-xs leading-relaxed text-muted">
              La caméra suit la visite guidée (entrée dans la pièce puis tour du regard, 5 s). L&apos;IA reçoit la profondeur de chaque image : elle habille la
              3D sans rien inventer.
            </p>
            <select
              value={stop}
              onChange={(e) => setStop(Number(e.target.value))}
              disabled={!!filming}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm outline-none focus:border-accent"
            >
              {stops.map((s, i) => (
                <option key={i} value={i}>
                  {i + 1}. {s}
                </option>
              ))}
            </select>
            {filming ? null : (
              <div className="flex gap-2">
                <button onClick={() => filmTour("rapide")} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-xs font-medium ring-1 ring-line hover:bg-sand" title="480p, quelques minutes">
                  <Film className="size-3.5" /> Rapide 480p
                </button>
                <button onClick={() => filmTour("hd")} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-xs font-medium ring-1 ring-line hover:bg-sand" title="720p, quelques minutes">
                  <Film className="size-3.5" /> HD 720p
                </button>
                <button onClick={() => filmTour("max")} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink py-2 text-xs font-medium text-paper hover:brightness-110" title="1080p affinée, 32 images/s : environ 5 min">
                  <Sparkles className="size-3.5" /> Qualité max
                </button>
              </div>
            )}
          </div>
        )}
        {filming && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin text-accent" /> Images de profondeur {filming.done} / {filming.total}…
          </div>
        )}
        {error && <p className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-ink">{error}</p>}
      </div>
      <div className="scroll-soft min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {items.map((it) => (
          <div key={it.id} className="overflow-hidden rounded-xl bg-white ring-1 ring-line">
            {it.status === "running" && (
              <>
                {(it.kind === "visite" || it.kind === "anime") && it.depth && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.depth} alt="Profondeur envoyée à l'IA" className="block w-full opacity-80" />
                )}
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin text-accent" />
                  {it.queued ? "Démarrage du GPU…" : `${it.kind === "photo" ? "Photo" : it.kind === "visite" ? `Visite · ${it.title ?? ""}` : "Vidéo"} en cours…`}{" "}
                  {Math.round((now - it.t0) / 1000)} s
                </div>
              </>
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
                  <span className="mr-auto text-muted">
                    {it.title ? `${it.title} · ` : ""}
                    {it.took} s
                  </span>
                  {it.kind === "photo" && (
                    <>
                      <button onClick={() => animate(it, "rapide")} disabled={!!filming} className={`${btn} bg-cream hover:bg-sand disabled:opacity-40`} title="480p, environ 1 min 30 : la caméra bouge un peu, la géométrie reste celle de la 3D">
                        <Film className="size-3.5" /> Vidéo rapide
                      </button>
                      <button onClick={() => animate(it, "hd")} disabled={!!filming} className={`${btn} bg-cream hover:bg-sand disabled:opacity-40`} title="720p, quelques minutes : la caméra bouge un peu, la géométrie reste celle de la 3D">
                        <Film className="size-3.5" /> Vidéo HD
                      </button>
                      <button onClick={() => animate(it, "max")} disabled={!!filming} className={`${btn} bg-ink text-paper hover:brightness-110 disabled:opacity-40`} title="1080p affinée, 32 images/s : environ 5 min">
                        <Sparkles className="size-3.5" /> Qualité max
                      </button>
                    </>
                  )}
                  {it.photo && (
                    <a href={it.photo} target="_blank" rel="noreferrer" className={`${btn} bg-cream hover:bg-sand`} title="Photo de départ, qui donne l'aspect de la vidéo">
                      Photo
                    </a>
                  )}
                  {it.depth && (
                    <a href={it.depth} download={`${name}-profondeur-${it.id.slice(0, 6)}.png`} className={`${btn} bg-cream hover:bg-sand`} title="Profondeur envoyée à l'IA">
                      Profondeur
                    </a>
                  )}
                  <a
                    href={it.url}
                    download={`${name}-${it.kind}-${it.id.slice(0, 6)}.${it.kind === "photo" ? "png" : "mp4"}`}
                    className={`${btn} bg-cream hover:bg-sand`}
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
