// Enregistre la clé API fal.ai dans .env.local, sans l'afficher, après l'avoir vérifiée auprès de fal.
// fal.ai → Settings → API Keys → Create key (elle a la forme identifiant:secret), puis :  npm run fal:cle
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // la clé tapée ou collée ne s'affiche pas
    rl._writeToOutput = (s) => {
      if (s.includes(question) || s === "\r\n" || s === "\n") rl.output.write(s);
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

const key = await ask("Collez la clé API fal.ai (identifiant:secret), puis Entrée : ");
if (!/^[\w-]{8,}:[\w-]{8,}$/.test(key)) {
  console.error("Ce n'est pas une clé fal.ai : elle a la forme identifiant:secret (deux parties séparées par deux-points).");
  process.exit(1);
}
// vérification sans frais : fal prépare un envoi de fichier, rien n'est calculé
const r = await fetch("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
  method: "POST",
  headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ content_type: "text/plain", file_name: "verification.txt" }),
}).catch(() => null);
if (!r || !r.ok) {
  console.error(`fal.ai refuse cette clé (${r ? `HTTP ${r.status}` : "pas de réponse"}). Vérifiez qu'elle est complète.`);
  process.exit(1);
}
const line = `FAL_KEY=${key}`;
const env = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
writeFileSync(".env.local", /^FAL_KEY=.*$/m.test(env) ? env.replace(/^FAL_KEY=.*$/m, line) : `${env.replace(/\n*$/, "\n")}\n# fal.ai : rendus IA (photos et vidéos)\n${line}\n`);
console.log("Clé fal.ai vérifiée et enregistrée dans .env.local.");
