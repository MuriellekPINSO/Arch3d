import { COMFY, viewFile } from "@/lib/comfy";

/* Relais des images et vidéos produites par le pod GPU (le navigateur ne parle jamais directement au pod). */
export async function GET(request: Request) {
  if (!COMFY) return new Response("non configuré", { status: 503 });
  const q = new URL(request.url).searchParams;
  const filename = q.get("filename") ?? "";
  const subfolder = q.get("subfolder") ?? "";
  const type = q.get("type") ?? "output";
  if (!/^[\w.-]+$/.test(filename) || !/^[\w/-]*$/.test(subfolder) || subfolder.includes("..") || type !== "output")
    return new Response("refusé", { status: 400 });
  const r = await viewFile(filename, subfolder, type);
  return new Response(r.body, {
    headers: {
      "Content-Type": r.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
