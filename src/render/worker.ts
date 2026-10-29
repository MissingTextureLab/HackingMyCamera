// Render worker: owns the GPU, the canvas, the camera frames and the encoder,
// so the UI thread can never stall a frame.

import { Engine } from '../gpu/engine';
import { Recorder } from '../capture/recorder';
import type { FromWorker, MacroInfo, ToWorker } from './protocol';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
  requestAnimationFrame(cb: (t: number) => void): number;
}
const scope = self as unknown as WorkerScope;
const post = (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer);
const fail = (e: unknown) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) });

let engine: Engine | null = null;
const recorder = new Recorder();
let source: 'camera' | 'test' = 'test';
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let pendingResize: [number, number] | null = null;
let photoRequested = false;
let last = 0;
let fpsFrames = 0;
let fpsSince = 0;
let fps = 0;

// Long side capped: hardware H.264 encoders top out around 1920 px, and it keeps
// the fused shaders cheap on the phone. Even sizes for the encoder.
const MAX_SIDE = 1920;
function fit(width: number, height: number): [number, number] {
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  return [Math.max(2, Math.round((width * k) / 2) * 2), Math.max(2, Math.round((height * k) / 2) * 2)];
}

async function readFrames(stream: ReadableStream<VideoFrame>, mirror: boolean) {
  await reader?.cancel().catch(() => {});
  const r = stream.getReader();
  reader = r;
  source = 'camera';
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done || reader !== r) {
        value?.close();
        break;
      }
      if (engine) engine.uploadFrame(value, mirror);
      else value.close();
    }
  } catch (e) {
    if (reader === r) fail(e);
  }
}

function loop(now: number) {
  scope.requestAnimationFrame(loop);
  if (!engine) return;
  const dt = last ? (now - last) / 1000 : 1 / 60;
  last = now;

  if (pendingResize && !recorder.active) {
    engine.resize(...pendingResize);
    pendingResize = null;
  }
  if (source === 'test') engine.renderTestCard(now / 1000);
  engine.render(now / 1000, dt);

  // Both read the canvas, so they must run in this task, right after submit.
  if (recorder.active) recorder.frame(now);
  if (photoRequested) {
    photoRequested = false;
    snapshot().catch(fail);
  }

  fpsFrames++;
  if (now - fpsSince > 500) {
    fps = (fpsFrames * 1000) / (now - fpsSince);
    fpsFrames = 0;
    fpsSince = now;
    post({ type: 'stats', fps, stats: engine.stats(), source });
  }
}

async function snapshot() {
  const canvas = engine!.canvas;
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  const out = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  out.getContext('2d')!.drawImage(frame, 0, 0);
  frame.close();
  const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  post({ type: 'photo', blob });
}

function macrosOf(compiled: Awaited<ReturnType<Engine['setEffect']>>): MacroInfo[] {
  return compiled.macros.map((m) => ({ ...m, value: compiled.values[m.slot] }));
}

scope.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        const [w, h] = fit(msg.width, msg.height);
        msg.canvas.width = w;
        msg.canvas.height = h;
        engine = await Engine.create(msg.canvas);
        engine.onError = fail;
        post({ type: 'ready' });
        scope.requestAnimationFrame(loop);
        break;
      }
      case 'frames':
        readFrames(msg.stream, msg.mirror);
        break;
      case 'testSource':
        await reader?.cancel().catch(() => {});
        reader = null;
        source = 'test';
        break;
      case 'resize':
        pendingResize = fit(msg.width, msg.height);
        break;
      case 'effect': {
        const compiled = await engine!.setEffect(msg.graph);
        post({ type: 'effect', id: msg.graph.id, macros: macrosOf(compiled) });
        break;
      }
      case 'warm':
        for (const g of msg.graphs) await engine!.warm(g).catch((err) => fail(`${g.id}: ${err.message}`));
        break;
      case 'param':
        engine?.setParam(msg.slot, msg.value);
        break;
      case 'photo':
        photoRequested = true;
        break;
      case 'recStart':
        await recorder.begin(engine!.canvas, performance.now());
        post({ type: 'recStarted' });
        break;
      case 'recStop':
        try {
          post({ type: 'recStopped', blob: await recorder.end() });
        } catch (err) {
          post({ type: 'recStopped', blob: null, error: err instanceof Error ? err.message : String(err) });
        }
        break;
    }
  } catch (err) {
    fail(err);
  }
});
