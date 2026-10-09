import { COMFY, viewFile } from "@/lib/comfy";

/* Relais des images et vidéos produites par le pod GPU (le navigateur ne parle jamais directement au pod).
   Les vidéos se lisent par morceaux (requêtes Range, exigées par Safari) : le fichier est gardé un moment en mémoire
   plutôt que redemandé au pod à chaque morceau. */

const cache = new Map<string, { buf: Uint8Array; type: string; at: number }>();
const KEEP = 15 * 60_000;

async function fetchFile(filename: string, subfolder: string, type: string) {
  const key = `${type}/${subfolder}/${filename}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit;
  const r = await viewFile(filename, subfolder, type);
  const file = { buf: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("Content-Type") ?? "application/octet-stream", at: Date.now() };
  if (/\.(png|jpe?g|webp)$/i.test(filename)) file.type = file.type.startsWith("image/") ? file.type : "image/png";
  if (/\.mp4$/i.test(filename)) file.type = "video/mp4";
  if (/\.webm$/i.test(filename)) file.type = "video/webm";
  for (const [k, v] of cache) if (Date.now() - v.at > KEEP) cache.delete(k);
  cache.set(key, file);
  return file;
}

// ces réponses vont à une balise <img> ou <video> : pas d'en-tête x-lang, on suit la langue du navigateur
const say = (request: Request, fr: string, en: string) => (/^fr\b/i.test(request.headers.get("Accept-Language") ?? "fr") ? fr : en);

export async function GET(request: Request) {
  if (!COMFY) return new Response(say(request, "non configuré", "not configured"), { status: 503 });
  const q = new URL(request.url).searchParams;
  const filename = q.get("filename") ?? "";
  const subfolder = q.get("subfolder") ?? "";
  const type = q.get("type") ?? "output";
  if (!/^[\w.-]+$/.test(filename) || !/^[\w/-]*$/.test(subfolder) || subfolder.includes("..") || type !== "output")
    return new Response(say(request, "refusé", "refused"), { status: 400 });
  const { buf, type: mime } = await fetchFile(filename, subfolder, type);
  const size = buf.byteLength;
  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
  if (!range) return new Response(buf as BodyInit, { headers: { ...headers, "Content-Length": String(size) } });
  // « bytes=a-b », « bytes=a- » ou « bytes=-n » (les n derniers octets)
  let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2] || "0", 10);
  let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1) as BodyInit, {
    status: 206,
    headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}
