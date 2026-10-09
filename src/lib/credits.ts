/* Comptes et crédits dans Firestore, côté serveur uniquement (le navigateur n'y a aucun accès direct).
   La base est partagée avec un autre projet : toutes les collections de Xwé commencent par xwe_.
   xwe_accounts/{uid}            solde, email, bonus d'accueil
   xwe_accounts/{uid}/ledger/…   chaque mouvement : offert, achat, rendu, remboursement
   xwe_payments/{transaction}    paiements FedaPay
   xwe_renders/{id}              rendus payés, pour rembourser une seule fois celui qui échoue */
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, firestore } from "./firebaseAdmin";
import { getTransaction } from "./fedapay";
import { FREE_CREDITS } from "./offres";

export type Account = { id: string; credits: number; email: string | null; verified: boolean };

const accounts = () => firestore().collection("xwe_accounts");
const entry = (delta: number, reason: string, ref?: string) => ({ delta, reason, ref: ref ?? null, at: FieldValue.serverTimestamp() });

/** L'utilisateur connecté, d'après son jeton Firebase (en-tête Authorization: Bearer …), ou null.
    Son compte est créé à sa première venue. Les crédits offerts arrivent avec une adresse vérifiée
    (Google l'est d'office ; un compte email l'est après le lien reçu par mail) : on ne les gagne pas en
    créant des adresses à la chaîne. */
export async function accountFrom(request: Request): Promise<Account | null> {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  let user: { uid: string; email?: string; email_verified?: boolean };
  try {
    user = await adminAuth().verifyIdToken(h.slice(7));
  } catch {
    return null;
  }
  const verified = !!user.email_verified;
  const ref = accounts().doc(user.uid);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() as { credits: number; email: string | null; bonus: boolean } | undefined;
    const bonus = verified && !d?.bonus;
    const credits = (d?.credits ?? 0) + (bonus ? FREE_CREDITS : 0);
    if (!d) tx.set(ref, { credits, email: user.email ?? null, bonus: verified, createdAt: FieldValue.serverTimestamp() });
    else if (bonus) tx.update(ref, { credits: FieldValue.increment(FREE_CREDITS), bonus: true });
    if (bonus) tx.set(ref.collection("ledger").doc(), entry(FREE_CREDITS, "offert"));
    return { id: user.uid, credits, email: user.email ?? null, verified };
  });
}

/** retire n crédits si le solde suffit ; renvoie le nouveau solde, ou null s'il manque des crédits */
export async function spend(uid: string, n: number, reason: string, ref?: string): Promise<number | null> {
  const doc = accounts().doc(uid);
  return firestore().runTransaction(async (tx) => {
    const credits = Number((await tx.get(doc)).get("credits") ?? 0);
    if (credits < n) return null;
    tx.update(doc, { credits: FieldValue.increment(-n) });
    tx.set(doc.collection("ledger").doc(), entry(-n, reason, ref));
    return credits - n;
  });
}

export async function grant(uid: string, n: number, reason: string, ref?: string) {
  const doc = accounts().doc(uid);
  const batch = firestore().batch();
  batch.update(doc, { credits: FieldValue.increment(n) });
  batch.set(doc.collection("ledger").doc(), entry(n, reason, ref));
  await batch.commit();
}

const renderDoc = (id: string) => firestore().collection("xwe_renders").doc(id.replace(/\//g, "_"));

/** un rendu payé est noté, pour pouvoir le rembourser s'il échoue */
export async function recordRender(id: string, uid: string, cost: number) {
  await renderDoc(id).set({ account: uid, cost, refunded: false, at: FieldValue.serverTimestamp() });
}

/** rendu échoué : ses crédits reviennent, une seule fois */
export async function refundRender(id: string) {
  const ref = renderDoc(id);
  await firestore().runTransaction(async (tx) => {
    const r = (await tx.get(ref)).data() as { account: string; cost: number; refunded: boolean } | undefined;
    if (!r || r.refunded) return;
    const acc = accounts().doc(r.account);
    tx.update(ref, { refunded: true });
    tx.update(acc, { credits: FieldValue.increment(r.cost) });
    tx.set(acc.collection("ledger").doc(), entry(r.cost, "remboursement", id));
  });
}

const paymentDoc = (id: string) => firestore().collection("xwe_payments").doc(id);

export async function recordPayment(p: { transactionId: string; account: string; pack: string; credits: number; amount: number }) {
  await paymentDoc(p.transactionId).set({
    account: p.account,
    pack: p.pack,
    credits: p.credits,
    amount: p.amount,
    status: "pending",
    credited: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Vérifie la transaction auprès de FedaPay et, si elle est payée du bon montant, crédite le compte une seule fois.
    Appelée au retour du client et par la notification de FedaPay : la première qui passe crédite. */
export async function settlePayment(transactionId: string): Promise<{ status: string; credits: number; credited: boolean } | null> {
  const ref = paymentDoc(transactionId);
  const first = await ref.get();
  if (!first.exists) return null; // transaction inconnue : pas créée par Xwé
  const t = await getTransaction(transactionId);
  return firestore().runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data() as { account: string; credits: number; amount: number; credited: boolean };
    const pay = t.status === "approved" && t.amount === p.amount && !p.credited;
    tx.update(ref, { status: t.status, updatedAt: FieldValue.serverTimestamp(), ...(pay ? { credited: true } : {}) });
    if (pay) {
      const acc = accounts().doc(p.account);
      tx.update(acc, { credits: FieldValue.increment(p.credits) });
      tx.set(acc.collection("ledger").doc(), entry(p.credits, "achat", transactionId));
    }
    // credited : ce paiement a bien ajouté ses crédits (maintenant ou à un passage précédent)
    return { status: t.status, credits: p.credits, credited: p.credited || pay };
  });
}
