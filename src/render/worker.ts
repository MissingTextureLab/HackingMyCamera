// Render worker: owns the GPU, the canvas, the camera frames and the encoder,
// so the UI thread can never stall a frame.

import { Engine } from '../gpu/engine';
import { Recorder } from '../capture/recorder';
import { Signals } from '../signals';
import { validateEffect } from '../graph/validate';
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
const signals = new Signals();
const writeParam = (slot: number, value: number) => engine!.setParam(slot, value);
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
  // the date-back stamp goes on what is captured, not on the viewfinder
  engine.main.stamp = recorder.active || photoRequested;
  signals.update(now / 1000, dt, writeParam);
  engine.render(now / 1000, dt);

  // Both read the canvas, so they must run in this task, right after submit.
  if (recorder.active) recorder.frame(now);
  if (photoRequested) {
    photoRequested = false;
    snapshot().catch(fail);
    // after the read, so effects can react without spoiling the photo
    signals.trigger('taken', now / 1000);
  }

  fpsFrames++;
  if (now - fpsSince > 500) {
    fps = (fpsFrames * 1000) / (now - fpsSince);
    fpsFrames = 0;
    fpsSince = now;
    post({ type: 'stats', fps, stats: engine.stats(), source });
  }
}

/** "FX07 TRAMA 26.10.30": catalogue code, effect, date, like a film camera's data back. */
function stampText(code: string, name: string) {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `FX${code.padStart(2, '0')} ${name} ${two(d.getFullYear() % 100)}.${two(d.getMonth() + 1)}.${two(d.getDate())}`;
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
      case 'frame':
        // one-by-one frames (no MediaStreamTrackProcessor): drop any stream reader first
        if (reader) {
          reader.cancel().catch(() => {});
          reader = null;
        }
        source = 'camera';
        if (engine) engine.uploadFrame(msg.frame, msg.mirror);
        else msg.frame.close();
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
        // graphs may come from files or the editor: never trust their shape
        const graph = validateEffect(msg.graph);
        const compiled = await engine!.setEffect(graph);
        engine!.main.setStampText(stampText(graph.code, graph.name));
        signals.bind(graph.mods, compiled.slots, compiled.values);
        post({ type: 'effect', id: graph.id, macros: macrosOf(compiled) });
        break;
      }
      case 'param':
        engine?.setParam(msg.slot, msg.value);
        break;
      case 'grade':
        engine?.setGrade(msg.mode);
        break;
      case 'zoom':
        engine?.setZoom(msg.digital);
        break;
      case 'touch':
        signals.setTouch(msg.state);
        break;
      case 'motion':
        signals.setMotion(msg.state);
        break;
      case 'thumb':
        await engine!.addThumb(msg.id, msg.canvas, validateEffect(msg.graph));
        break;
      case 'photo':
        photoRequested = true;
        signals.trigger('shot', performance.now() / 1000);
        break;
      case 'recStart':
        signals.trigger('shot', performance.now() / 1000);
        signals.trigger('taken', performance.now() / 1000);
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
