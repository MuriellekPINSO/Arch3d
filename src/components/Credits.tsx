"use client";
/* Crédits : la pastille du solde (en-tête) et la fenêtre d'achat, payée par FedaPay (mobile money ou carte). */
import { useState } from "react";
import { Coins, Loader2, ShieldCheck, X } from "lucide-react";
import { useCredits } from "@/lib/creditsStore";
import { authHeader } from "@/lib/firebase";
import { useLang, useTr } from "@/lib/i18n";
import { CLIP_COST, FREE_CREDITS, PACKS, PHOTO_COST, formatUsd, formatXof, type PackId } from "@/lib/offres";

/** pastille du solde ; un clic ouvre l'achat */
export function CreditsBadge({ className = "" }: { className?: string }) {
  const tr = useTr();
  const credits = useCredits((s) => s.credits);
  const open = useCredits((s) => s.setBuyOpen);
  return (
    <button
      onClick={() => open(true)}
      title={tr("Vos crédits pour les photos et vidéos réalistes", "Your credits for realistic photos and videos")}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-3 py-1.5 text-sm font-semibold text-accent transition hover:brightness-95 ${className}`}
    >
      <Coins className="size-4" />
      <span className="tabular-nums">{credits ?? "…"}</span>
      <span className="font-medium max-sm:hidden">{tr("crédits", "credits")}</span>
    </button>
  );
}

/** fenêtre d'achat de crédits */
export function BuyCredits() {
  const tr = useTr();
  const lang = useLang((s) => s.lang);
  const { buyOpen, setBuyOpen, credits, payment, sandbox } = useCredits();
  const [pack, setPack] = useState<PackId>("pro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // devise affichée : FCFA en français, dollars en anglais, au choix ensuite
  const [cur, setCur] = useState<"xof" | "usd" | null>(null);
  if (!buyOpen) return null;
  const L = (p: [string, string]) => (lang === "en" ? p[1] : p[0]);
  const currency = cur ?? (lang === "en" ? "usd" : "xof");
  const chosen = PACKS.find((p) => p.id === pack)!;

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await fetch("/api/paiement", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-lang": lang, ...(await authHeader()) },
        body: JSON.stringify({ pack }),
      }).then((x) => x.json())) as { url?: string; error?: string; needLogin?: boolean };
      if (r.needLogin) {
        setBuyOpen(false);
        useCredits.getState().setLoginOpen(true);
        return;
      }
      if (!r.url) throw new Error(r.error ?? tr("Paiement impossible.", "Payment failed."));
      window.location.href = r.url; // page de paiement FedaPay, qui revient ensuite sur l'app
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-ink/40 backdrop-blur-sm sm:place-items-center" onClick={() => !busy && setBuyOpen(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-t-3xl bg-paper p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-3xl sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight">{tr("Acheter des crédits", "Buy credits")}</h2>
            <p className="mt-1 text-sm text-muted">
              {tr("Solde actuel : ", "Current balance: ")}
              <b className="text-ink tabular-nums">{credits ?? "…"}</b> {tr("crédits", "credits")}
            </p>
          </div>
          <button onClick={() => setBuyOpen(false)} disabled={busy} className="rounded-full p-1.5 text-muted hover:bg-cream" aria-label={tr("Fermer", "Close")}>
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <div className="flex rounded-full bg-cream p-0.5 text-xs font-semibold" role="group" aria-label={tr("Devise", "Currency")}>
            {(
              [
                ["xof", "FCFA"],
                ["usd", "$ USD"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setCur(k)}
                aria-pressed={currency === k}
                className={`rounded-full px-3 py-1 transition ${currency === k ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {PACKS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPack(p.id)}
              className={`relative rounded-2xl p-3.5 text-left transition ${pack === p.id ? "bg-white ring-2 ring-accent" : "bg-white ring-1 ring-line hover:ring-sand"}`}
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">{L(p.name)}</div>
              <div className="mt-1 font-display text-2xl font-semibold tabular-nums">{p.credits}</div>
              <div className="text-xs text-muted">{tr("crédits", "credits")}</div>
              <div className="mt-2 text-base font-semibold tabular-nums">{currency === "usd" ? formatUsd(p.usd, lang) : formatXof(p.xof)}</div>
              <div className="text-[11px] tabular-nums text-muted">{currency === "usd" ? formatXof(p.xof) : `≈ ${formatUsd(p.usd, lang)}`}</div>
              {p.note && <div className={`mt-0.5 text-[11px] ${p.best ? "text-accent" : "text-leaf"}`}>{L(p.note)}</div>}
            </button>
          ))}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          {tr(
            `Une photo réaliste coûte ${PHOTO_COST} crédits, une vidéo de pièce ${CLIP_COST.rapide} à ${CLIP_COST.max} crédits selon la qualité. La maison 3D, la visite et l'aménagement restent gratuits. ${FREE_CREDITS} crédits sont offerts à l'ouverture.`,
            `A realistic photo costs ${PHOTO_COST} credits, a room video ${CLIP_COST.rapide} to ${CLIP_COST.max} credits depending on quality. The 3D house, the tour and the interior design stay free. ${FREE_CREDITS} credits are offered to start.`,
          )}
        </p>

        {error && <p className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm text-ink">{error}</p>}

        <button
          onClick={buy}
          disabled={busy || !payment}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <ShieldCheck className="size-5" />}
          {payment
            ? tr(`Payer ${formatXof(chosen.xof)} (≈ ${formatUsd(chosen.usd, lang)})`, `Pay ${formatUsd(chosen.usd, lang)} (${formatXof(chosen.xof)})`)
            : tr("Paiement bientôt disponible", "Payment coming soon")}
        </button>
        <p className="mt-2 text-center text-xs text-muted">
          {tr(
            "MTN MoMo, Moov Money, Celtiis ou carte bancaire, via FedaPay. Le paiement se fait en FCFA : une carte en dollars ou en euros est convertie par votre banque.",
            "MTN MoMo, Moov Money, Celtiis or bank card, via FedaPay. Payment is made in FCFA: a card in dollars or euros is converted by your bank.",
          )}
          {payment && sandbox && <b className="ml-1 text-accent">{tr("Mode test : aucun vrai paiement.", "Test mode: no real payment.")}</b>}
        </p>
      </div>
    </div>
  );
}
