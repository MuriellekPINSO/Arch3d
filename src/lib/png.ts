/* PNG en niveaux de gris, fixe ou animé (APNG), encodé dans le navigateur sans dépendance.
   Sert aux cartes de profondeur envoyées à l'IA : sans perte, et ComfyUI lit un APNG comme une suite d'images. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function bytes(n: number, write: (dv: DataView) => void) {
  const b = new Uint8Array(n);
  write(new DataView(b.buffer));
  return b;
}

async function zlib(data: Uint8Array) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* filtre Paeth sur chaque ligne : les dégradés de profondeur se compressent très bien */
function filtered(gray: Uint8Array, w: number, h: number) {
  const out = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1);
    const r = y * w;
    const p = r - w;
    out[o] = y ? 4 : 1;
    for (let x = 0; x < w; x++) {
      const a = x ? gray[r + x - 1] : 0;
      let pred = a;
      if (y) {
        const b = gray[p + x];
        const c = x ? gray[p + x - 1] : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + 1 + x] = (gray[r + x] - pred) & 0xff;
    }
  }
  return out;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const header = (w: number, h: number) =>
  chunk(
    "IHDR",
    bytes(13, (dv) => {
      dv.setUint32(0, w);
      dv.setUint32(4, h);
      dv.setUint8(8, 8); // 8 bits
      dv.setUint8(9, 0); // niveaux de gris
    }),
  );
const END = chunk("IEND", new Uint8Array(0));

export async function grayPNG(gray: Uint8Array, w: number, h: number) {
  return new Blob([SIGNATURE, header(w, h), chunk("IDAT", await zlib(filtered(gray, w, h))), END] as BlobPart[], { type: "image/png" });
}

/** APNG : on ajoute les images une à une (nombre connu d'avance), puis `blob()`. */
export class GrayAPNG {
  private parts: Uint8Array[];
  private seq = 0;
  private count = 0;

  constructor(private w: number, private h: number, private frames: number, private fps: number) {
    const actl = chunk(
      "acTL",
      bytes(8, (dv) => {
        dv.setUint32(0, frames);
        dv.setUint32(4, 0); // en boucle
      }),
    );
    this.parts = [SIGNATURE, header(w, h), actl];
  }

  async add(gray: Uint8Array) {
    if (this.count >= this.frames) throw new Error("APNG : trop d'images");
    this.parts.push(
      chunk(
        "fcTL",
        bytes(26, (dv) => {
          dv.setUint32(0, this.seq++);
          dv.setUint32(4, this.w);
          dv.setUint32(8, this.h);
          dv.setUint16(20, 1); // durée = 1 / fps
          dv.setUint16(22, this.fps);
        }),
      ),
    );
    const data = await zlib(filtered(gray, this.w, this.h));
    if (this.count === 0) this.parts.push(chunk("IDAT", data));
    else {
      const fd = new Uint8Array(4 + data.length);
      new DataView(fd.buffer).setUint32(0, this.seq++);
      fd.set(data, 4);
      this.parts.push(chunk("fdAT", fd));
    }
    this.count++;
  }

  blob() {
    if (this.count !== this.frames) throw new Error(`APNG : ${this.count} images sur ${this.frames}`);
    return new Blob([...this.parts, END] as BlobPart[], { type: "image/png" });
  }
}
