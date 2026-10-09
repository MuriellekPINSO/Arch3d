/* FedaPay (paiement mobile money et carte, en FCFA) par son API REST, côté serveur uniquement.
   Variables : FEDAPAY_SECRET_KEY (sk_sandbox_… en test, sk_live_… en vrai), FEDAPAY_WEBHOOK_SECRET (wh_…).
   L'environnement se déduit de la clé ; FEDAPAY_ENV=sandbox|live le force. */
import { createHmac, timingSafeEqual } from "node:crypto";

const KEY = process.env.FEDAPAY_SECRET_KEY ?? "";
const LIVE = (process.env.FEDAPAY_ENV ?? (KEY.startsWith("sk_live") ? "live" : "sandbox")) === "live";
// FEDAPAY_API_BASE : seulement pour les tests (faux FedaPay local)
const BASE = process.env.FEDAPAY_API_BASE || (LIVE ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1");

export const FEDAPAY_READY = KEY.length > 0;
export const FEDAPAY_SANDBOX = !LIVE;

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const msg = (j.message as string) ?? (j.error as string) ?? `HTTP ${r.status}`;
    throw new Error(`FedaPay : ${msg}`);
  }
  return j;
}

// l'API range l'objet sous sa classe : { "v1/transaction": { … } }
type Tx = { id: number | string; status: string; amount: number; currency_id?: number };
const unwrap = (j: Record<string, unknown>) => (j["v1/transaction"] ?? j.transaction ?? j) as Tx;

/** crée la transaction et renvoie l'adresse de la page de paiement FedaPay */
export async function createTransaction(p: {
  description: string;
  amount: number;
  callbackUrl: string;
  email?: string;
  metadata?: Record<string, string>;
}) {
  const t = unwrap(
    await call("POST", "/transactions", {
      description: p.description,
      amount: p.amount,
      currency: { iso: "XOF" },
      callback_url: p.callbackUrl,
      ...(p.email ? { customer: { email: p.email } } : {}),
      ...(p.metadata ? { custom_metadata: p.metadata } : {}),
    }),
  );
  const tok = (await call("POST", `/transactions/${t.id}/token`)) as { url?: string; token?: string };
  if (!tok.url) throw new Error("FedaPay : pas de lien de paiement");
  return { id: String(t.id), url: tok.url };
}

/** état réel d'une transaction, demandé à FedaPay (on ne se fie jamais à ce qu'annonce l'adresse de retour) */
export async function getTransaction(id: string) {
  const t = unwrap(await call("GET", `/transactions/${encodeURIComponent(id)}`));
  return { id: String(t.id), status: t.status, amount: Number(t.amount) };
}

/** Signature des notifications : en-tête « t=<horodatage>,s=<HMAC-SHA256 hex de "<t>.<corps>"> », 5 min de tolérance. */
export function verifyWebhook(payload: string, header: string | null, secret: string, tolerance = 300) {
  if (!header || !secret) return false;
  let t = -1;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = parseInt(v, 10);
    if (k === "s" && v) sigs.push(v);
  }
  if (t < 0 || !sigs.length) return false;
  if (Math.floor(Date.now() / 1000) - t > tolerance) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex"));
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}
