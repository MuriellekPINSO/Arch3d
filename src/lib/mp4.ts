/* Vidéo MP4 (H.264) d'une suite d'images de profondeur en gris, encodée dans le navigateur (WebCodecs).
   fal.ai veut une vraie vidéo pour guider Wan 2.2 ; le pod ComfyUI, lui, lit l'APNG. */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

const CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e01f"];

export const canEncodeMp4 = () => typeof window !== "undefined" && "VideoEncoder" in window && "VideoFrame" in window;

export class GrayMP4 {
  private muxer: Muxer<ArrayBufferTarget>;
  private enc: VideoEncoder;
  private i = 0;
  private failure: Error | null = null;
  private rgba: Uint8ClampedArray;

  private constructor(private w: number, private h: number, private fps: number, codec: string) {
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: w, height: h, frameRate: fps }, fastStart: "in-memory" });
    this.enc = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => (this.failure = e as Error),
    });
    // profondeur : peu de détails, un débit modeste suffit et garde le fichier léger
    this.enc.configure({ codec, width: w, height: h, bitrate: 3_000_000, framerate: fps });
    this.rgba = new Uint8ClampedArray(w * h * 4);
  }

  /** null si le navigateur ne sait pas encoder en H.264 */
  static async create(w: number, h: number, fps: number): Promise<GrayMP4 | null> {
    if (!canEncodeMp4()) return null;
    for (const codec of CODECS) {
      const ok = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 3_000_000, framerate: fps }).catch(() => null);
      if (ok?.supported) return new GrayMP4(w, h, fps, codec);
    }
    return null;
  }

  async add(gray: Uint8Array) {
    if (this.failure) throw this.failure;
    for (let p = 0, q = 0; p < gray.length; p++, q += 4) {
      this.rgba[q] = this.rgba[q + 1] = this.rgba[q + 2] = gray[p];
      this.rgba[q + 3] = 255;
    }
    const us = 1_000_000 / this.fps;
    const frame = new VideoFrame(this.rgba, { format: "RGBA", codedWidth: this.w, codedHeight: this.h, timestamp: Math.round(this.i * us), duration: Math.round(us) });
    this.enc.encode(frame, { keyFrame: this.i % 16 === 0 });
    frame.close();
    this.i++;
    // ne pas laisser la file de l'encodeur grossir sans fin
    while (this.enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
  }

  async finish(): Promise<Blob> {
    await this.enc.flush();
    if (this.failure) throw this.failure;
    this.enc.close();
    this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: "video/mp4" });
  }
}
