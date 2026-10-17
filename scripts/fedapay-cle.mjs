// Enregistre la clé secrète FedaPay dans .env.local, sans l'afficher, après l'avoir vérifiée auprès de FedaPay.
// Tableau de bord FedaPay (sandbox.fedapay.com pour les tests) → menu API → clé secrète, puis :  npm run fedapay:cle
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // la clé tapée ou collée ne s'affiche pas
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
      else if (s === "\r\n" || s === "\n") rl.output.write(s);
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

const key = await ask("Collez la clé secrète FedaPay (sk_sandbox_… ou sk_live_…), puis Entrée : ");
if (!/^sk_(sandbox|live)_[A-Za-z0-9_-]{8,}$/.test(key)) {
  console.error("Ce n'est pas une clé secrète FedaPay : elle commence par sk_sandbox_ (test) ou sk_live_ (réel).");
  process.exit(1);
}
const live = key.startsWith("sk_live_");
const base = live ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1";
const r = await fetch(`${base}/currencies`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }).catch(() => null);
if (!r || !r.ok) {
  console.error(`FedaPay refuse cette clé (${r ? `HTTP ${r.status}` : "pas de réponse"}). Vérifiez qu'elle est complète et qu'elle vient bien du mode ${live ? "réel" : "test"}.`);
  process.exit(1);
}
const line = `FEDAPAY_SECRET_KEY=${key}`;
const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
writeFileSync(".env.local", /^FEDAPAY_SECRET_KEY=.*$/m.test(env) ? env.replace(/^FEDAPAY_SECRET_KEY=.*$/m, line) : `${env.replace(/\n*$/, "\n")}${line}\n`);
console.log(`Clé FedaPay ${live ? "RÉELLE" : "de test"} vérifiée et enregistrée dans .env.local.`);
