// Records the render canvas to mp4 with WebCodecs (via Mediabunny), inside the
// worker. Video only for now; microphone audio comes with the audio signals (H2).

import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny';

export class Recorder {
  private output: Output<Mp4OutputFormat, BufferTarget> | null = null;
  private source: CanvasSource | null = null;
  private start = 0;
  private last = 0;
  private inFlight = false;
  private failed: string | null = null;

  get active() {
    return this.output !== null;
  }

  async begin(canvas: OffscreenCanvas, now: number) {
    if (this.output) return;
    const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], {
      width: canvas.width,
      height: canvas.height,
    });
    if (!codec) throw new Error('SIN CODIFICADOR');
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 1 });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    this.output = output;
    this.source = source;
    this.start = now;
    this.last = now;
    this.failed = null;
  }

  /**
   * Call right after the frame was submitted, in the same task, so the canvas
   * still holds it. Frames are dropped while the encoder is busy.
   */
  frame(now: number) {
    const source = this.source;
    if (!source || this.inFlight || this.failed) return;
    const t = (now - this.start) / 1000;
    const d = Math.max((now - this.last) / 1000, 1 / 120);
    this.last = now;
    this.inFlight = true;
    source
      .add(t, d)
      .catch((e: unknown) => (this.failed = String(e)))
      .finally(() => (this.inFlight = false));
  }

  async end(): Promise<Blob> {
    const output = this.output;
    this.output = null;
    this.source = null;
    if (!output) throw new Error('NO GRABA');
    if (this.failed) {
      await output.cancel();
      throw new Error(this.failed);
    }
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  }
}
