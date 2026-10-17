"use client";
/* Rendus IA : la vue 3D devient une photo réaliste, la visite guidée devient une vraie vidéo (une pièce ou tout
   l'appartement). Géométrie fidèle au plan : l'IA reçoit la profondeur exacte de la 3D et ne fait qu'habiller.
   Les rendus sont suivis par useRenders (src/lib/rendersStore.ts) : ils continuent panneau fermé. */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronsLeftRight, Clapperboard, Download, Expand, Film, Loader2, Sparkles, Trash2, X } from "lucide-react";
import { SHOT_FRAMES, type CaptureAPI, type ShotPose } from "./three/capture";
import { useLang, useTr } from "@/lib/i18n";
import { useCredits } from "@/lib/creditsStore";
import { authHeader, FIREBASE_READY } from "@/lib/firebase";
import { renderCost } from "@/lib/offres";
import { renderEta, useRenders, type RenderItem, type RenderSize as Size, type RenderView as View } from "@/lib/rendersStore";

/** le serveur répond dans la langue de l'interface */
const langHeader = () => ({ "x-lang": useLang.getState().lang });

const toDataURL = (blob: Blob) =>
  new Promise<string>((ok) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.readAsDataURL(blob);
  });

/** ambiances en un clic : le libellé suit la langue, la consigne envoyée à l'IA reste en anglais */
const MOODS = [
  { fr: "Matin lumineux", en: "Bright morning", p: "bright natural morning daylight" },
  { fr: "Coucher de soleil", en: "Sunset", p: "warm golden-hour sunset light" },
  { fr: "Soirée", en: "Evening", p: "evening ambiance, warm interior lights on" },
  { fr: "Afro-chic", en: "Afro-chic", p: "afro-chic decor with wax fabrics, rattan, carved wood and plants" },
  { fr: "Moderne épuré", en: "Modern minimal", p: "modern minimalist decor, clean lines" },
  { fr: "Haut de gamme", en: "High-end", p: "high-end finishes, marble and brass details" },
];

const SIZES: { k: Size; fr: string; en: string; res: string }[] = [
  { k: "rapide", fr: "Standard", en: "Standard", res: "480p" },
  { k: "hd", fr: "HD", en: "HD", res: "720p" },
  { k: "max", fr: "Max", en: "Max", res: "1080p" },
];

const R = () => useRenders.getState();
/** nouvelle carte « en préparation » ; renvoie son identifiant provisoire */
const begin = (p: Omit<RenderItem, "id" | "t0" | "status">) => {
  const id = `tmp_${Math.random().toString(36).slice(2, 10)}`;
  R().add({ ...p, id, status: "preparing", t0: Date.now() });
  return id;
};
/** le calcul est parti : la carte prend l'identifiant du serveur */
const launched = (id: string, real: string) => R().patch(id, { id: real, status: "running", t0: Date.now() });

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
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const items = useRenders((s) => s.items);
  const busy = useRenders((s) => s.busy);
  const credits = useCredits((s) => s.credits);
  const user = useCredits((s) => s.user);
  const [moods, setMoods] = useState<number[]>([]);
  const [free, setFree] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lock, setLock] = useState(true); // géométrie verrouillée par la carte de profondeur
  const [scope, setScope] = useState<"tout" | "piece">("tout");
  const [stop, setStop] = useState(() => Math.max(0, currentStop));
  const [size, setSize] = useState<Size>("hd");
  const [open, setOpen] = useState<RenderItem | null>(null); // rendu affiché en grand
  const [animating, setAnimating] = useState<string | null>(null); // photo dont on choisit la qualité d'animation
  // « Mes rendus » d'emblée si quelque chose tourne ou vient d'arriver
  const [tab, setTab] = useState<"creer" | "rendus">(() =>
    R().items.some((x) => x.fresh || (x.status !== "done" && x.status !== "error")) ? "rendus" : "creer",
  );
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState(false); // film complet : un second clic confirme
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);

  const running = items.some((x) => x.status !== "done" && x.status !== "error");
  const fresh = items.some((x) => x.fresh);
  const shown = items.length ? tab : "creer";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  // ce qui est affiché ici est vu : plus de pastille sur le bouton
  useEffect(() => {
    if (shown === "rendus") R().markSeen();
  }, [items, shown]);

  const onFal = () => useCredits.getState().renders === "fal";
  const extra = () => [...moods.map((i) => MOODS[i].p), free.trim()].filter(Boolean).join(", ");
  const noMp4 = () =>
    tr(
      "Ce navigateur ne sait pas préparer la vidéo : utilisez Chrome, Edge ou Safari récent.",
      "This browser cannot prepare the video: use a recent Chrome, Edge or Safari.",
    );

  /** dépose un fichier chez fal.ai (adresse d'envoi signée par le serveur) et renvoie son adresse */
  const toFal = async (x: Blob | string): Promise<string> => {
    if (typeof x === "string" && x.startsWith("https://")) return x; // déjà chez fal (une photo rendue)
    const blob = typeof x === "string" ? await (await fetch(x)).blob() : x;
    const type = blob.type || "image/png";
    const slot = (await fetch("/api/rendu/televersement", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...langHeader(), ...(await authHeader()) },
      body: JSON.stringify({ type }),
    }).then((r) => r.json())) as { uploadUrl?: string; fileUrl?: string; error?: string; needLogin?: boolean };
    if (!slot.uploadUrl || !slot.fileUrl) throw Object.assign(new Error(slot.error ?? "envoi refusé"), { needLogin: slot.needLogin });
    const put = await fetch(slot.uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": type } });
    if (!put.ok) throw new Error(`envoi : HTTP ${put.status}`);
    return slot.fileUrl;
  };

  const fail = (id: string, msg: string) => R().patch(id, { status: "error", error: msg });
  const sendFailed = (id: string, e: unknown) => {
    if ((e as { needLogin?: boolean }).needLogin) useCredits.getState().setLoginOpen(true);
    fail(id, `${tr("Envoi à l'IA impossible", "Could not send to the AI")} : ${(e as Error).message}`);
  };

  /** vérifie le solde avant de capturer ; s'il manque des crédits, on propose d'en acheter (le serveur revérifie) */
  const afford = (cost: number) => {
    setError(null);
    if (R().busy) return false; // une capture à la fois : la caméra est occupée
    // sans Firebase (test local), pas de compte ni de crédits
    if (!FIREBASE_READY) return true;
    // un rendu demande un compte : on propose de se connecter avant de capturer
    if (!useCredits.getState().user) {
      useCredits.getState().setLoginOpen(true);
      return false;
    }
    const c = useCredits.getState().credits;
    if (c === null || c >= cost) return true;
    setError(
      tr(`Il vous faut ${cost} crédits pour ce rendu, il vous en reste ${c}.`, `This render needs ${cost} credits, you have ${c} left.`),
    );
    useCredits.getState().setBuyOpen(true);
    return false;
  };
  /** réponse du serveur au lancement : nouveau solde, ou achat proposé s'il manque des crédits */
  const paid = (r: { error?: string; needCredits?: number; credits?: number; needLogin?: boolean }) => {
    if (typeof r.credits === "number") useCredits.getState().setCredits(r.credits);
    if (r.needCredits) useCredits.getState().setBuyOpen(true);
    if (r.needLogin) useCredits.getState().setLoginOpen(true);
  };

  /** lance le calcul ; la carte « tmp_ » prend l'identifiant du serveur */
  const post = async (id: string, body: Record<string, unknown>) => {
    const r = await fetch("/api/rendu", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...langHeader(), ...(await authHeader()) },
      body: JSON.stringify(body),
    })
      .then((x) => x.json())
      .catch(() => ({ error: tr("Serveur injoignable.", "Server unreachable.") }));
    paid(r);
    if (r.error) return fail(id, r.error);
    launched(id, r.id);
  };

  /** un seul plan (photo, photo animée, une pièce de la visite) : envoi des fichiers puis lancement */
  const sendOne = async (
    id: string,
    kind: RenderItem["kind"],
    v: View,
    f: { image?: string; photo?: string; depth?: Blob; control?: Blob; video?: Blob },
    o: { size?: Size; title?: string; pose?: ShotPose } = {},
  ) => {
    R().patch(id, { status: "sending" });
    let body: Record<string, unknown>;
    if (onFal()) {
      // fal.ai : les fichiers partent d'abord chez fal, le serveur ne reçoit que leurs adresses
      if (kind !== "photo" && kind !== "video" && !f.video) return fail(id, noMp4());
      try {
        const shot =
          kind === "anime"
            ? { photo: await toFal(f.photo!), control: await toFal(f.video!), view: v }
            : {
                image: await toFal(f.image!),
                ...(f.depth ? { depth: await toFal(f.depth) } : {}),
                ...(f.video ? { control: await toFal(f.video) } : {}),
                view: v,
              };
        if ("image" in shot) R().patch(id, { before: shot.image }); // l'adresse chez fal remplace l'image locale
        body = { mode: kind, size: o.size, extra: extra(), shots: [shot], title: o.title, pose: o.pose };
      } catch (e) {
        return sendFailed(id, e);
      }
    } else {
      const [depth, control] = await Promise.all([f.depth && toDataURL(f.depth), f.control && toDataURL(f.control)]);
      body = { mode: kind, image: f.image ?? f.photo, extra: extra(), size: o.size, view: v, depth, control };
    }
    await post(id, body);
  };

  /** Photo réaliste de la vue affichée (façade, vue du ciel ou pièce). */
  const photoOfView = async (v: View) => {
    if (!afford(renderCost("photo"))) return;
    const c = canvasRef.current;
    if (!c) return setError(tr("Pas de vue 3D à rendre.", "No 3D view to render."));
    const title = v === "facade" ? tr("Façade", "Façade") : v === "aerien" ? tr("Vue du ciel", "Aerial view") : stops[currentStop] || undefined;
    setTab("rendus");
    const id = begin({ kind: "photo", view: v, title });
    R().setBusy(true);
    const restore = await prepare(v);
    let png: string;
    let depth: Blob | null = null;
    let pose: ShotPose | undefined;
    try {
      png = c.toDataURL("image/png");
      pose = capture.current?.pose();
      if (lock) depth = (await capture.current?.depthOfView()) ?? null;
    } catch (e) {
      return fail(id, `${tr("Capture impossible", "Capture failed")} : ${(e as Error).message}`);
    } finally {
      restore();
      R().setBusy(false);
    }
    R().patch(id, { before: png, pose });
    await sendOne(id, "photo", v, { image: png, ...(depth ? { depth } : {}) }, { pose, title });
  };

  /** Anime une photo : la 3D refait sa vue et bouge un peu ; l'IA suit cette profondeur avec l'aspect de la photo. */
  const animate = async (it: RenderItem, s: Size) => {
    setAnimating(null);
    if (!it.url || !afford(renderCost("anime", s))) return;
    const api = capture.current;
    setTab("rendus");
    const id = begin({ kind: "anime", view: it.view, size: s, before: it.url, title: it.title });
    // chez fal, la photo y est déjà : on passe son adresse ; pour le pod, on l'envoie en entier
    const photo = onFal() ? it.url : await toDataURL(await fetch(it.url).then((r) => r.blob()));
    if (!it.pose || !api) return sendOne(id, "video", it.view, { image: photo }, { size: s, title: it.title }); // vue inconnue : vidéo libre
    const [w, h] = s === "rapide" ? [832, 480] : [1280, 720];
    R().setBusy(true);
    const restore = await prepare(it.view);
    let shot: Awaited<ReturnType<CaptureAPI["moveShot"]>>;
    try {
      shot = await api.moveShot(it.pose, it.view === "interieur" ? "dolly" : "orbit", w, h, (d, t) => R().patch(id, { prep: d / t }));
    } catch (e) {
      return fail(id, `${tr("Préparation impossible", "Preparation failed")} : ${(e as Error).message}`);
    } finally {
      restore();
      R().setBusy(false);
    }
    await sendOne(id, "anime", it.view, { photo, control: shot.control, video: shot.video }, { size: s, title: it.title });
  };

  /** Vidéo d'une pièce : la caméra suit la visite guidée (entrée puis tour du regard, 5 s). */
  const tourOne = async (s: Size) => {
    if (!afford(renderCost("visite", s))) return;
    const api = capture.current;
    if (!api) return setError(tr("La 3D n'est pas prête.", "The 3D view is not ready."));
    const [w, h] = s === "rapide" ? [832, 480] : [1280, 720];
    setTab("rendus");
    const id = begin({ kind: "visite", view: "interieur", size: s, title: stops[stop] });
    R().setBusy(true);
    const restore = await prepare("interieur");
    let shot: Awaited<ReturnType<CaptureAPI["tourShot"]>>;
    try {
      shot = await api.tourShot(stop, w, h, (d, t) => R().patch(id, { prep: d / t }));
    } catch (e) {
      return fail(id, `${tr("Préparation impossible", "Preparation failed")} : ${(e as Error).message}`);
    } finally {
      restore();
      R().setBusy(false);
    }
    R().patch(id, { before: shot.first });
    await sendOne(id, "visite", "interieur", { image: shot.first, depth: shot.firstDepth, control: shot.control, video: shot.video }, { size: s, title: stops[stop] });
  };

  /** Visite de tout l'appartement : la façade, puis chaque pièce dans l'ordre de la visite guidée (5 s chacune),
      rendues par l'IA et mises bout à bout dans une seule vidéo. */
  const tourAll = async (s: Size) => {
    if (!afford(renderCost("film", s, filmShots))) return;
    const api = capture.current;
    if (!api) return setError(tr("La 3D n'est pas prête.", "The 3D view is not ready."));
    const [w, h] = s === "rapide" ? [832, 480] : [1280, 720];
    const rooms = filmRooms.slice(0, 15).map((r) => r.id);
    const total = (rooms.length + 1) * SHOT_FRAMES;
    const title = tr(`Tout l'appartement · ${rooms.length} pièces`, `Whole home · ${rooms.length} rooms`);
    setTab("rendus");
    const id = begin({ kind: "film", view: "interieur", size: s, title, shots: rooms.length + 1 });
    let done = 0;
    let shown = -1;
    const step = (d: number) => {
      const p = Math.floor(((done + d) / total) * 100);
      if (p !== shown) R().patch(id, { prep: (shown = p) / 100 });
    };
    const shots: { shot: Awaited<ReturnType<CaptureAPI["tourShot"]>>; view: "facade" | "interieur" }[] = [];
    R().setBusy(true);
    try {
      let restore = await prepare("facade");
      try {
        shots.push({ shot: await api.moveShot(api.pose(), "orbit", w, h, step), view: "facade" });
        R().patch(id, { before: shots[0].shot.first });
        done += SHOT_FRAMES;
      } finally {
        restore();
      }
      restore = await prepare("interieur");
      try {
        for (let i = 0; i < rooms.length; i++) {
          // chaque pièce filmée depuis son meilleur angle, comme par un photographe immobilier
          shots.push({ shot: await api.roomShot(rooms[i], w, h, step), view: "interieur" });
          done += SHOT_FRAMES;
        }
      } finally {
        restore();
      }
    } catch (e) {
      return fail(id, `${tr("Préparation impossible", "Preparation failed")} : ${(e as Error).message}`);
    } finally {
      R().setBusy(false);
    }
    R().patch(id, { status: "sending" });
    let payload: Record<string, unknown>[];
    if (onFal()) {
      if (shots.some(({ shot }) => !shot.video)) return fail(id, noMp4());
      try {
        payload = [];
        // plan par plan : quelques envois en parallèle, pas des dizaines d'un coup
        for (const { shot, view: v } of shots) {
          const [image, depth, control] = await Promise.all([toFal(shot.first), toFal(shot.firstDepth), toFal(shot.video!)]);
          payload.push({ image, depth, control, view: v });
        }
        R().patch(id, { before: payload[0].image as string });
      } catch (e) {
        return sendFailed(id, e);
      }
    } else
      payload = await Promise.all(
        shots.map(async ({ shot, view: v }) => ({ image: shot.first, depth: await toDataURL(shot.firstDepth), control: await toDataURL(shot.control), view: v })),
      );
    await post(id, { mode: "film", size: s, extra: extra(), shots: payload, title });
  };

  const filmShots = Math.min(filmRooms.length, 15) + 1;
  const canAll = filmRooms.length > 0;
  const canOne = stops.length > 0;
  const tourScope = canAll && (scope === "tout" || !canOne) ? "tout" : "piece";
  const tourCost = tourScope === "tout" ? renderCost("film", size, filmShots) : renderCost("visite", size);
  const tourEta = tourScope === "tout" ? renderEta("film", size, filmShots, onFal()) : renderEta("visite", size, 1, onFal());
  const tourLength = tourScope === "tout" ? filmShots * 5 : 5;
  const minutes = (s: number) => (s < 90 ? `${Math.max(10, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`);
  const first = items.length === 0;

  return (
    <div className="absolute inset-x-3 bottom-3 z-20 flex max-h-[calc(100%-124px)] flex-col overflow-hidden rounded-3xl bg-paper shadow-2xl ring-1 ring-line sm:inset-x-auto sm:bottom-5 sm:right-5 sm:max-h-[calc(100%-110px)] sm:w-[392px]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold">{tr("Photos et vidéos réalistes", "Realistic photos & videos")}</div>
        {FIREBASE_READY && user && credits !== null && (
          <button
            onClick={() => useCredits.getState().setBuyOpen(true)}
            className="shrink-0 rounded-full bg-cream px-2.5 py-1 text-xs font-medium hover:bg-sand"
            title={tr("Acheter des crédits", "Buy credits")}
          >
            {credits} {tr("crédits", "credits")}
          </button>
        )}
        <button onClick={onClose} className="shrink-0 rounded-full p-1 text-muted hover:bg-cream" aria-label={tr("Fermer", "Close")}>
          <X className="size-4" />
        </button>
      </div>

      {items.length > 0 && (
        <div className="flex gap-4 border-b border-line px-4 text-sm font-medium" role="tablist">
          {(["creer", "rendus"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={shown === k}
              onClick={() => setTab(k)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 py-2.5 ${shown === k ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {k === "creer" ? tr("Créer", "Create") : tr("Mes rendus", "My renders")}
              {k === "rendus" && (
                <span className={`rounded-full px-1.5 text-[11px] ${fresh ? "bg-leaf text-white" : "bg-cream text-muted"}`}>{items.length}</span>
              )}
              {k === "rendus" && running && <Loader2 className="size-3.5 animate-spin text-accent" />}
            </button>
          ))}
        </div>
      )}

      <div className="scroll-soft min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {error && <p className="rounded-xl bg-accent-soft px-3 py-2 text-xs text-ink">{error}</p>}
        {shown === "creer" ? (
          <>
            {first && (
              <div className="overflow-hidden rounded-2xl ring-1 ring-line">
                <Compare before="/rendu/exemple-avant.jpg" after="/rendu/exemple-apres.jpg" labels={[tr("Votre 3D", "Your 3D"), tr("Photo IA", "AI photo")]} hint />
                <p className="bg-white px-3 py-2 text-xs leading-relaxed text-muted">
                  {tr(
                    "Votre 3D devient une vraie photo, puis une vraie vidéo. Les murs, portes et fenêtres restent exactement ceux du plan.",
                    "Your 3D becomes a real photo, then a real video. Walls, doors and windows stay exactly as on the plan.",
                  )}
                </p>
              </div>
            )}

            {/* ---------- ambiance ---------- */}
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">{tr("Ambiance (facultatif)", "Mood (optional)")}</div>
              <div className="flex flex-wrap gap-1.5">
                {MOODS.map((m, i) => {
                  const on = moods.includes(i);
                  return (
                    <button
                      key={i}
                      onClick={() => setMoods((l) => (on ? l.filter((x) => x !== i) : [...l, i]))}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ring-1 transition ${on ? "bg-ink text-paper ring-ink" : "bg-white text-ink ring-line hover:bg-cream"}`}
                    >
                      {on && <Check className="size-3" />}
                      {lang === "en" ? m.en : m.fr}
                    </button>
                  );
                })}
              </div>
              <input
                value={free}
                onChange={(e) => setFree(e.target.value)}
                placeholder={tr("Autre envie : parquet clair, rideaux en lin…", "Anything else: light parquet, linen curtains…")}
                className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
            </div>

            {/* ---------- 1. photo ---------- */}
            <section className="rounded-2xl bg-white p-3 ring-1 ring-line">
              <div className="flex items-start gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Camera className="size-[18px]" />
                </span>
                <div className="min-w-0">
                  <div className="font-display text-[15px] font-semibold leading-tight">{tr("Photo réaliste", "Realistic photo")}</div>
                  <p className="text-xs leading-snug text-muted">
                    {view === "maquette"
                      ? tr("De la maison vue de dehors. Pour une pièce, passez en Visite et placez-vous dedans.", "Of the house from outside. For a room, switch to Tour and stand in it.")
                      : tr("Exactement ce que vous voyez à l'écran : placez-vous, cadrez, déclenchez.", "Exactly what you see on screen: stand, frame, shoot.")}
                  </p>
                </div>
              </div>
              <div className="mt-2.5 flex gap-2">
                {view === "maquette" ? (
                  <>
                    <Launch onClick={() => photoOfView("facade")} disabled={busy} main label={tr("Façade", "Façade")} cost={renderCost("photo")} eta={minutes(renderEta("photo", "hd", 1, onFal()))} />
                    <Launch onClick={() => photoOfView("aerien")} disabled={busy} label={tr("Vue du ciel", "Aerial view")} cost={renderCost("photo")} eta={minutes(renderEta("photo", "hd", 1, onFal()))} />
                </>
            ) : (
              <Launch onClick={() => photoOfView("interieur")} disabled={busy} main label={tr("Prendre la photo", "Take the photo")} cost={renderCost("photo")} eta={minutes(renderEta("photo", "hd", 1, onFal()))} />
            )}
          </div>
        </section>

        {/* ---------- 2. vidéo de la visite guidée ---------- */}
        {(canAll || canOne) && (
          <section className="rounded-2xl bg-ink p-3 text-paper">
            <div className="flex items-start gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-paper/10 text-accent">
                <Clapperboard className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <div className="font-display text-[15px] font-semibold leading-tight">{tr("Vidéo de la visite guidée", "Guided tour video")}</div>
                <p className="text-xs leading-snug text-paper/70">
                  {tr("La visite de la 3D, filmée comme une vraie vidéo, pièce après pièce.", "The 3D tour, filmed as a real video, room after room.")}
                </p>
              </div>
            </div>

            {canAll && canOne && (
              <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-xl bg-paper/10 p-1 text-xs font-medium">
                {(["tout", "piece"] as const).map((k) => (
                  <button key={k} onClick={() => setScope(k)} aria-pressed={tourScope === k} className={`rounded-lg py-1.5 ${tourScope === k ? "bg-paper text-ink" : "text-paper/80 hover:bg-paper/10"}`}>
                    {k === "tout" ? tr(`Tout l'appartement`, "Whole home") : tr("Une pièce", "One room")}
                  </button>
                ))}
              </div>
            )}
            {tourScope === "tout" ? (
              <p className="mt-2 line-clamp-3 text-xs leading-snug text-paper/70">
                {tr(
                  `La façade, puis ${filmRooms.length > 15 ? 15 : filmRooms.length} pièces dans l'ordre de la visite : ${filmRooms.slice(0, 15).map((r) => r.name).join(", ")}.`,
                  `The façade, then ${Math.min(filmRooms.length, 15)} rooms in tour order: ${filmRooms.slice(0, 15).map((r) => r.name).join(", ")}.`,
                )}
              </p>
            ) : (
              <select
                value={stop}
                onChange={(e) => setStop(Number(e.target.value))}
                className="mt-2 w-full rounded-xl bg-paper px-2.5 py-1.5 text-sm text-ink outline-none"
              >
                {stops.map((s, i) => (
                  <option key={i} value={i}>
                    {i + 1}. {s}
                  </option>
                ))}
              </select>
            )}

            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              {SIZES.map((o) => (
                <button
                  key={o.k}
                  onClick={() => setSize(o.k)}
                  aria-pressed={size === o.k}
                  className={`rounded-xl py-1.5 text-center text-xs font-medium ring-1 ${size === o.k ? "bg-paper/15 ring-paper/60" : "ring-paper/15 hover:bg-paper/10"}`}
                >
                  {lang === "en" ? o.en : o.fr}
                  <span className="block text-[10px] font-normal text-paper/60">{o.res}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                if (tourScope === "tout" && !confirm) return setConfirm(true);
                setConfirm(false);
                return tourScope === "tout" ? tourAll(size) : tourOne(size);
              }}
              disabled={busy}
              className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white hover:brightness-105 disabled:opacity-50 ${confirm ? "bg-leaf" : "bg-accent"}`}
            >
              {confirm ? <Check className="size-4" /> : <Film className="size-4" />}
              {confirm ? tr(`Confirmer : ${tourCost} crédits`, `Confirm: ${tourCost} credits`) : tr("Créer la vidéo", "Create the video")}
              {!confirm && <span className="font-normal opacity-80">· {tourCost} {tr("crédits", "credits")}</span>}
            </button>
            <p className="mt-1.5 text-center text-[11px] text-paper/60">
              {tr(`Vidéo de ${tourLength} s · prête en ~${minutes(tourEta)}`, `${tourLength} s video · ready in ~${minutes(tourEta)}`)}
            </p>
          </section>
        )}

        <label className="flex cursor-pointer items-start gap-2 pt-1 text-[11px] leading-snug text-muted">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="mt-px accent-[var(--color-accent)]" />
          <span>{tr("Garder exactement les murs et ouvertures du plan (recommandé)", "Keep walls and openings exactly as on the plan (recommended)")}</span>
        </label>
        </>
        ) : (
          /* ---------- mes rendus ---------- */
          <div className="space-y-2.5">
            {running && (
              <p className="text-xs leading-snug text-muted">
                {tr("Vous pouvez fermer ce panneau et continuer : on vous prévient dès que c'est prêt.", "You can close this panel and keep working: we'll let you know when it's ready.")}
              </p>
            )}
            {items.map((it) => (
              <Card
                key={it.id}
                it={it}
                now={now}
                onFal={onFal()}
                busy={busy}
                animating={animating === it.id}
                onOpen={() => setOpen(it)}
                onAnimate={() => setAnimating((x) => (x === it.id ? null : it.id))}
                onAnimateSize={(s) => animate(it, s)}
                name={name}
              />
            ))}
            <button onClick={() => setTab("creer")} className="w-full rounded-xl py-2 text-xs font-medium text-accent hover:bg-cream">
              + {tr("Créer une autre photo ou vidéo", "Create another photo or video")}
            </button>
          </div>
        )}
      </div>

      {open && <Lightbox it={items.find((x) => x.id === open.id) ?? open} name={name} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** bouton de lancement : libellé, prix et durée */
function Launch({ onClick, disabled, main, label, cost, eta }: { onClick: () => void; disabled?: boolean; main?: boolean; label: string; cost: number; eta: string }) {
  const tr = useTr();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 flex-col items-center rounded-xl py-2 text-sm font-medium disabled:opacity-50 ${main ? "bg-accent text-white hover:brightness-105" : "bg-cream text-ink hover:bg-sand"}`}
    >
      {label}
      <span className="text-[11px] font-normal opacity-80">
        {cost} {tr("crédits", "credits")} · ~{eta}
      </span>
    </button>
  );
}

/** avant / après : on glisse pour comparer la 3D et la photo de l'IA */
function Compare({ before, after, labels, hint, big }: { before: string; after: string; labels: [string, string]; hint?: boolean; big?: boolean }) {
  const [x, setX] = useState(hint ? 62 : 50);
  // petit va-et-vient au premier affichage : on comprend qu'on peut glisser
  useEffect(() => {
    if (!hint) return;
    const steps = [38, 55];
    const ts = steps.map((v, i) => setTimeout(() => setX(v), 700 + i * 650));
    return () => ts.forEach(clearTimeout);
  }, [hint]);
  return (
    <div className={`relative select-none overflow-hidden bg-ink ${big ? "mx-auto w-fit rounded-2xl" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt={labels[1]} className={`block ${big ? "max-h-[78vh] max-w-full" : "w-full"}`} draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={before}
        alt={labels[0]}
        className="absolute inset-0 size-full object-cover"
        style={{ clipPath: `inset(0 ${100 - x}% 0 0)`, transition: hint ? "clip-path 500ms ease" : undefined }}
        draggable={false}
      />
      <div className="pointer-events-none absolute inset-y-0" style={{ left: `${x}%`, transition: hint ? "left 500ms ease" : undefined }}>
        <div className="h-full w-0.5 -translate-x-1/2 bg-white/90 shadow" />
        <div className="absolute left-0 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-ink shadow-lg">
          <ChevronsLeftRight className="size-4" />
        </div>
      </div>
      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-ink/70 px-2 py-0.5 text-[11px] font-medium text-paper">{labels[0]}</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-white">{labels[1]}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={x}
        onChange={(e) => setX(Number(e.target.value))}
        aria-label={`${labels[0]} / ${labels[1]}`}
        className="absolute inset-0 size-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}

function kindLabel(it: RenderItem, tr: (fr: string, en: string) => string) {
  if (it.kind === "film") return it.title ?? tr("Tout l'appartement", "Whole home");
  const what = it.kind === "photo" ? tr("Photo", "Photo") : it.kind === "anime" ? tr("Photo animée", "Animated photo") : tr("Vidéo", "Video");
  return it.title ? `${what} · ${it.title}` : what;
}

function ago(t: number, tr: (fr: string, en: string) => string, now: number) {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return tr("à l'instant", "just now");
  if (m < 60) return tr(`il y a ${m} min`, `${m} min ago`);
  const h = Math.round(m / 60);
  if (h < 24) return tr(`il y a ${h} h`, `${h} h ago`);
  return new Date(t).toLocaleDateString();
}

/** une carte de « Vos rendus » : la vue 3D qui se transforme, puis le résultat */
function Card({
  it,
  now,
  onFal,
  busy,
  animating,
  onOpen,
  onAnimate,
  onAnimateSize,
  name,
}: {
  it: RenderItem;
  now: number;
  onFal: boolean;
  busy: boolean;
  animating: boolean;
  onOpen: () => void;
  onAnimate: () => void;
  onAnimateSize: (s: Size) => void;
  name: string;
}) {
  const tr = useTr();
  const video = it.kind !== "photo";
  const btn = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium";

  if (it.status === "done" && it.url)
    return (
      <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-line">
        <button onClick={onOpen} className="group relative block w-full" title={tr("Voir en grand", "View large")}>
          {video ? (
            <video src={it.url} autoPlay loop muted playsInline className="block w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={it.url} alt={kindLabel(it, tr)} className="block w-full" />
          )}
          <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-ink/60 text-paper opacity-0 transition group-hover:opacity-100">
            <Expand className="size-3.5" />
          </span>
          {it.fresh && <span className="absolute left-2 top-2 rounded-full bg-leaf px-2 py-0.5 text-[11px] font-medium text-white">{tr("Nouveau", "New")}</span>}
        </button>
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <div className="mr-auto min-w-0">
            <div className="truncate text-xs font-medium">{kindLabel(it, tr)}</div>
            <div className="text-[11px] text-muted">{ago(it.t0, tr, now)}</div>
          </div>
          {it.kind === "photo" && (it.pose || !onFal) && (
            <button onClick={onAnimate} disabled={busy} className={`${btn} ${animating ? "bg-ink text-paper" : "bg-accent-soft text-ink hover:brightness-95"} disabled:opacity-40`}>
              <Film className="size-3.5" /> {tr("Animer", "Animate")}
            </button>
          )}
          <a href={it.url} download={`${name}-${it.kind}-${it.id.slice(-6)}.${video ? "mp4" : "jpg"}`} target="_blank" rel="noreferrer" className={`${btn} bg-cream hover:bg-sand`} title={tr("Télécharger", "Download")}>
            <Download className="size-3.5" />
          </a>
          <button onClick={() => useRenders.getState().remove(it.id)} className={`${btn} text-muted hover:bg-cream`} title={tr("Retirer de la liste", "Remove from list")}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
        {animating && (
          <div className="border-t border-line bg-cream/50 px-2.5 py-2">
            <div className="mb-1.5 text-[11px] text-muted">{tr("Vidéo de 5 s depuis cette vue, la caméra avance doucement :", "5 s video from this view, the camera moves gently:")}</div>
            <div className="grid grid-cols-3 gap-1.5">
              {SIZES.map((o) => (
                <button key={o.k} onClick={() => onAnimateSize(o.k)} className="rounded-lg bg-white py-1.5 text-center text-xs font-medium ring-1 ring-line hover:bg-sand">
                  {tr(o.fr, o.en)} {o.res}
                  <span className="block text-[10px] font-normal text-muted">
                    {renderCost("anime", o.k)} {tr("crédits", "credits")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );

  if (it.status === "error")
    return (
      <div className="flex items-start gap-2 rounded-2xl bg-white px-3 py-2.5 ring-1 ring-line">
        <div className="mr-auto min-w-0 text-xs">
          <div className="font-medium">{kindLabel(it, tr)}</div>
          <div className="text-accent">
            {tr("N'a pas abouti", "Did not complete")} : {it.error}
          </div>
          {it.id.startsWith("fal_") && <div className="text-muted">{tr("Vos crédits vous ont été rendus.", "Your credits were refunded.")}</div>}
        </div>
        <button onClick={() => useRenders.getState().remove(it.id)} className={`${btn} text-muted hover:bg-cream`} title={tr("Retirer", "Remove")}>
          <X className="size-3.5" />
        </button>
      </div>
    );

  // en préparation, en route ou en calcul : la vue 3D envoyée, qui « se développe »
  const eta = renderEta(it.kind, it.size, it.shots, onFal);
  const elapsed = (now - it.t0) / 1000;
  const p =
    it.status === "preparing" ? 0.04 + (it.prep ?? 0) * 0.12 : it.status === "sending" ? 0.17 : Math.min(0.96, 0.18 + (elapsed / eta) * 0.78);
  const left = Math.max(0, eta - elapsed);
  const label =
    it.status === "preparing"
      ? video
        ? tr(`On filme la 3D… ${Math.round((it.prep ?? 0) * 100)} %`, `Filming the 3D… ${Math.round((it.prep ?? 0) * 100)}%`)
        : tr("Capture de la vue…", "Capturing the view…")
      : it.status === "sending"
        ? tr("Envoi à l'IA…", "Sending to the AI…")
        : it.queued
          ? tr("En file d'attente…", "In the queue…")
          : it.stage === "merge"
            ? tr("Montage de la vidéo…", "Editing the video…")
            : it.stage === "video" || (video && it.kind !== "visite" && it.kind !== "film")
              ? tr("L'IA tourne la vidéo…", "The AI is shooting the video…")
              : it.kind === "photo"
                ? tr("L'IA développe votre photo…", "The AI is developing your photo…")
                : tr("L'IA crée les images…", "The AI is creating the images…");
  return (
    <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-line">
      <div className="relative aspect-[3/2] overflow-hidden bg-cream">
        {it.before && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={it.before} alt="" className="absolute inset-0 size-full scale-105 object-cover blur-[2px] saturate-50" />
        )}
        <div className="xwe-shimmer absolute inset-0" />
        <div className="absolute inset-x-3 bottom-3 rounded-xl bg-paper/90 px-3 py-2 shadow backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {it.status === "running" && !it.queued && (
              <span className="shrink-0 font-normal text-muted">
                {left > 5 ? `~${left < 90 ? `${Math.round(left / 5) * 5} s` : `${Math.round(left / 60)} min`}` : tr("presque…", "almost…")}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sand">
            <div className="h-full rounded-full bg-accent transition-[width] duration-1000" style={{ width: `${p * 100}%` }} />
          </div>
        </div>
      </div>
      <div className="truncate px-2.5 py-2 text-xs font-medium">{kindLabel(it, tr)}</div>
    </div>
  );
}

/** le rendu en grand : photo comparée à la 3D, ou vidéo */
function Lightbox({ it, name, onClose }: { it: RenderItem; name: string; onClose: () => void }) {
  const tr = useTr();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!it.url) return null;
  const video = it.kind !== "photo";
  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-ink/90 p-3 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 pb-3 text-paper" onClick={(e) => e.stopPropagation()}>
        <div className="mr-auto min-w-0 truncate font-display text-base font-semibold">{kindLabel(it, tr)}</div>
        <a
          href={it.url}
          download={`${name}-${it.kind}-${it.id.slice(-6)}.${video ? "mp4" : "jpg"}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full bg-paper px-3 py-1.5 text-sm font-medium text-ink hover:bg-cream"
        >
          <Download className="size-4" /> {tr("Télécharger", "Download")}
        </a>
        <button onClick={onClose} className="rounded-full bg-paper/15 p-2 hover:bg-paper/25" aria-label={tr("Fermer", "Close")}>
          <X className="size-4" />
        </button>
      </div>
      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 place-items-center" onClick={(e) => e.stopPropagation()}>
        <div className="w-full">
          {video ? (
            <video src={it.url} controls autoPlay loop playsInline className="mx-auto block max-h-[78vh] max-w-full rounded-2xl bg-black" />
          ) : it.before ? (
            <Compare big before={it.before} after={it.url} labels={[tr("Votre 3D", "Your 3D"), tr("Photo IA", "AI photo")]} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={it.url} alt={kindLabel(it, tr)} className="mx-auto block max-h-[78vh] max-w-full rounded-2xl" />
          )}
        </div>
      </div>
      {!video && it.before && (
        <p className="pt-3 text-center text-xs text-paper/70">{tr("Glissez pour comparer avec la 3D", "Drag to compare with the 3D")}</p>
      )}
    </div>,
    document.body,
  );
}
