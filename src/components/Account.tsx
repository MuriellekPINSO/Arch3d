"use client";
/* Compte : bouton « Se connecter » ou solde + menu du compte, et la fenêtre de connexion (Google ou email). */
import { useState } from "react";
import {
  createUserWithEmailAndPassword, GoogleAuthProvider, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup,
} from "firebase/auth";
import { Coins, Loader2, LogOut, Mail, MailCheck, UserRound, X } from "lucide-react";
import { clientAuth, FIREBASE_READY } from "@/lib/firebase";
import { useCredits } from "@/lib/creditsStore";
import { useTr } from "@/lib/i18n";
import { FREE_CREDITS } from "@/lib/offres";
import { CreditsBadge } from "./Credits";

/** message lisible pour les erreurs de connexion Firebase */
function authError(code: string, tr: (fr: string, en: string) => string) {
  const m: Record<string, [string, string]> = {
    "auth/invalid-credential": ["Email ou mot de passe incorrect.", "Wrong email or password."],
    "auth/wrong-password": ["Email ou mot de passe incorrect.", "Wrong email or password."],
    "auth/user-not-found": ["Aucun compte avec cet email.", "No account with this email."],
    "auth/email-already-in-use": ["Un compte existe déjà avec cet email : connectez-vous.", "An account already uses this email: sign in instead."],
    "auth/weak-password": ["Mot de passe trop court : 6 caractères au moins.", "Password too short: at least 6 characters."],
    "auth/invalid-email": ["Adresse email invalide.", "Invalid email address."],
    "auth/popup-blocked": ["Le navigateur a bloqué la fenêtre Google : autorisez les fenêtres pour ce site.", "The browser blocked the Google window: allow pop-ups for this site."],
    "auth/too-many-requests": ["Trop d'essais : réessayez dans quelques minutes.", "Too many attempts: try again in a few minutes."],
    "auth/network-request-failed": ["Pas de connexion internet.", "No internet connection."],
  };
  const t = m[code];
  return t ? tr(t[0], t[1]) : tr("Connexion impossible pour le moment.", "Sign-in failed for now.");
}

/** en-tête : solde et menu du compte, ou bouton de connexion */
export function AccountArea({ className = "" }: { className?: string }) {
  const tr = useTr();
  const { user, authReady, setLoginOpen, logout, setBuyOpen } = useCredits();
  const [open, setOpen] = useState(false);
  if (!FIREBASE_READY || !authReady) return null;
  if (!user)
    return (
      <button
        onClick={() => setLoginOpen(true)}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-3 py-1.5 text-sm font-semibold text-accent hover:brightness-95 ${className}`}
        title={tr(`${FREE_CREDITS} crédits offerts à l'inscription`, `${FREE_CREDITS} free credits when you sign up`)}
      >
        <UserRound className="size-4" /> {tr("Se connecter", "Sign in")}
      </button>
    );
  const initial = (user.name ?? user.email ?? "?").trim()[0]?.toUpperCase();
  return (
    <div className={`relative flex items-center gap-1.5 ${className}`}>
      <CreditsBadge />
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={tr("Mon compte", "My account")} className="grid size-9 place-items-center overflow-hidden rounded-full bg-ink text-sm font-semibold text-paper">
        {/* eslint-disable-next-line @next/next/no-img-element -- petite photo Google, servie par Google */}
        {user.photo ? <img src={user.photo} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : initial}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-2xl bg-paper p-2 shadow-xl ring-1 ring-line">
            <div className="px-3 py-2">
              <div className="truncate text-sm font-medium">{user.name ?? user.email}</div>
              {user.name && <div className="truncate text-xs text-muted">{user.email}</div>}
            </div>
            <VerifyNotice />
            <button
              onClick={() => {
                setOpen(false);
                setBuyOpen(true);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-cream"
            >
              <Coins className="size-4 text-accent" /> {tr("Acheter des crédits", "Buy credits")}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                logout();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-cream"
            >
              <LogOut className="size-4 text-muted" /> {tr("Se déconnecter", "Sign out")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** compte email pas encore vérifié : les crédits offerts arrivent après le lien reçu par mail */
export function VerifyNotice() {
  const tr = useTr();
  const user = useCredits((s) => s.user);
  const refresh = useCredits((s) => s.refresh);
  const [state, setState] = useState<"idle" | "sent" | "checking">("idle");
  if (!user || user.verified) return null;
  const check = async () => {
    const u = clientAuth()?.currentUser;
    if (!u) return;
    setState("checking");
    await u.reload();
    useCredits.setState({ user: { ...user, verified: u.emailVerified } });
    await refresh(true); // nouveau jeton, qui porte l'adresse vérifiée
    setState("idle");
  };
  return (
    <div className="m-1 space-y-2 rounded-xl bg-accent-soft p-3 text-xs leading-relaxed text-ink">
      <p>
        {tr(
          `Vérifiez votre adresse : ouvrez le lien reçu par mail pour recevoir vos ${FREE_CREDITS} crédits offerts.`,
          `Verify your address: open the link we emailed you to get your ${FREE_CREDITS} free credits.`,
        )}
      </p>
      <div className="flex gap-1.5">
        <button onClick={check} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-white px-2 py-1.5 font-medium ring-1 ring-line">
          {state === "checking" ? <Loader2 className="size-3.5 animate-spin" /> : <MailCheck className="size-3.5" />} {tr("C'est fait", "Done")}
        </button>
        <button
          onClick={async () => {
            const u = clientAuth()?.currentUser;
            if (u) await sendEmailVerification(u).catch(() => {});
            setState("sent");
          }}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-white px-2 py-1.5 font-medium ring-1 ring-line"
        >
          <Mail className="size-3.5" /> {state === "sent" ? tr("Mail renvoyé", "Email sent") : tr("Renvoyer", "Resend")}
        </button>
      </div>
    </div>
  );
}

/** fenêtre de connexion */
export function LoginDialog() {
  const tr = useTr();
  const { loginOpen, setLoginOpen, refresh } = useCredits();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  if (!loginOpen) return null;
  const auth = clientAuth();

  const done = async () => {
    setLoginOpen(false);
    setPassword("");
    await refresh(true);
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(authError((e as { code?: string }).code ?? "", tr));
    } finally {
      setBusy(false);
    }
  };

  const google = () =>
    run(async () => {
      await signInWithPopup(auth!, new GoogleAuthProvider());
      await done();
    });
  const withEmail = () =>
    run(async () => {
      if (mode === "up") {
        const c = await createUserWithEmailAndPassword(auth!, email.trim(), password);
        await sendEmailVerification(c.user).catch(() => {});
      } else await signInWithEmailAndPassword(auth!, email.trim(), password);
      await done();
    });
  const reset = () =>
    run(async () => {
      if (!email.trim()) return setError(tr("Entrez d'abord votre email.", "Enter your email first."));
      await sendPasswordResetEmail(auth!, email.trim());
      setInfo(tr("Mail envoyé : suivez le lien pour choisir un nouveau mot de passe.", "Email sent: follow the link to choose a new password."));
    });

  const input = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-base outline-none focus:border-accent sm:text-sm";
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-ink/40 backdrop-blur-sm sm:place-items-center" onClick={() => !busy && setLoginOpen(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-paper p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl ring-1 ring-line sm:rounded-3xl sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight">{mode === "in" ? tr("Se connecter", "Sign in") : tr("Créer un compte", "Create an account")}</h2>
            <p className="mt-1 text-sm text-muted">
              {tr(
                `Pour les photos et vidéos réalistes. ${FREE_CREDITS} crédits offerts à l'inscription.`,
                `For realistic photos and videos. ${FREE_CREDITS} free credits when you sign up.`,
              )}
            </p>
          </div>
          <button onClick={() => setLoginOpen(false)} disabled={busy} className="rounded-full p-1.5 text-muted hover:bg-cream" aria-label={tr("Fermer", "Close")}>
            <X className="size-5" />
          </button>
        </div>

        <button
          onClick={google}
          disabled={busy}
          className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-2xl bg-white py-3 font-medium ring-1 ring-line transition hover:ring-sand disabled:opacity-50"
        >
          <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {tr("Continuer avec Google", "Continue with Google")}
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-line" /> {tr("ou avec votre email", "or with your email")} <span className="h-px flex-1 bg-line" />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            withEmail();
          }}
          className="space-y-3"
        >
          <label className="block text-sm">
            <span className="text-muted">Email</span>
            <input type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-muted">{tr("Mot de passe", "Password")}</span>
            <input
              type="password"
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          </label>
          {error && <p className="rounded-xl bg-accent-soft px-3 py-2 text-sm text-ink">{error}</p>}
          {info && <p className="rounded-xl bg-[#e3efe7] px-3 py-2 text-sm text-ink">{info}</p>}
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3 font-medium text-white shadow-sm transition hover:brightness-105 disabled:opacity-50"
          >
            {busy && <Loader2 className="size-5 animate-spin" />}
            {mode === "in" ? tr("Se connecter", "Sign in") : tr("Créer mon compte", "Create my account")}
          </button>
        </form>

        <div className="mt-3 flex items-center justify-between text-sm">
          <button onClick={() => setMode(mode === "in" ? "up" : "in")} className="font-medium text-accent">
            {mode === "in" ? tr("Créer un compte", "Create an account") : tr("J'ai déjà un compte", "I already have an account")}
          </button>
          {mode === "in" && (
            <button onClick={reset} className="text-muted hover:text-ink">
              {tr("Mot de passe oublié ?", "Forgot password?")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
