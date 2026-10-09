// Écrit la clé du compte de service Firebase dans .env.local, sans jamais l'afficher.
// Console Firebase → Paramètres du projet → Comptes de service → Générer une nouvelle clé privée (fichier JSON), puis :
//   npm run firebase:cle -- ~/Downloads/mon-projet-firebase-adminsdk.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Indiquez le fichier JSON : npm run firebase:cle -- chemin/vers/cle.json");
  process.exit(1);
}
const sa = JSON.parse(readFileSync(file, "utf8"));
if (!sa.private_key || !sa.client_email || !sa.project_id) {
  console.error("Ce fichier n'est pas une clé de compte de service Firebase.");
  process.exit(1);
}
const line = `FIREBASE_SERVICE_ACCOUNT_BASE64=${Buffer.from(JSON.stringify(sa)).toString("base64")}`;
const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
const next = /^FIREBASE_SERVICE_ACCOUNT_BASE64=.*$/m.test(env)
  ? env.replace(/^FIREBASE_SERVICE_ACCOUNT_BASE64=.*$/m, line)
  : `${env.replace(/\n*$/, "\n")}${line}\n`;
writeFileSync(".env.local", next);
console.log(`Clé du projet « ${sa.project_id} » enregistrée dans .env.local (${sa.client_email}).`);
console.log("Pour Vercel : vercel env add FIREBASE_SERVICE_ACCOUNT_BASE64 production, puis collez la même valeur.");
