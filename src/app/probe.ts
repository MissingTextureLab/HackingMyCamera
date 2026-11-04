// Device probe for `?diag`: what this phone can do (WebGPU, WebGL2, camera/video APIs) and how fast it draws.
// Runs on the main thread, except the worker check: the engine lives in a worker, so that is what really counts.
// The verdict (tier) and the report text are pure, in report.ts.

import { readEnv, type Env } from './diagnose';

export interface GpuProbe {
  /** requestAdapter with high-performance / plain / forceFallbackAdapter, in the order Engine.create tries them. */
  attempts: { hp: boolean; plain: boolean; fallback: boolean };
  vendor?: string;
  architecture?: string;
  description?: string;
  /** The adapter we got is the software one (SwiftShader). */
  software: boolean;
  features: string[];
  limits: { maxTextureDimension2D: number; maxStorageBufferBindingSize: number; maxComputeInvocationsPerWorkgroup: number; maxColorAttachments: number };
  device: boolean;
  deviceError?: string;
  /** Average ms per 1280×720 frame of the reference shader; undefined if it could not run. */
  benchMs?: number;
}

export interface GlProbe {
  ok: boolean;
  renderer?: string;
  vendor?: string;
  maxTexture?: number;
  floatRT: boolean;
  halfFloatRT: boolean;
  floatLinear: boolean;
  benchMs?: number;
}

export interface WorkerProbe {
  gpu: boolean;
  adapter: boolean;
  offscreenWebgpu: boolean;
}

export interface MediaProbe {
  camera: boolean;
  trackProcessor: boolean;
  videoEncoder: boolean;
  avc1080: boolean;
  recorderMp4: boolean;
}

export interface Probe {
  date: string;
  env: Env;
  memory?: number;
  cores?: number;
  screen: string;
  standalone: boolean;
  gpu: GpuProbe | null;
  /** null when the worker did not answer in time. */
  worker: WorkerProbe | null;
  gl: GlProbe;
  media: MediaProbe;
}

export const BENCH_W = 1280;
export const BENCH_H = 720;

// Reference load: fbm per pixel, in both shading languages, same arithmetic. Only the ms matter, not the image.
const WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn h(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn n(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2f(1.0, 0.0)), u.x), mix(h(i + vec2f(0.0, 1.0)), h(i + vec2f(1.0, 1.0)), u.x), u.y);
}
@fragment fn fs(@builtin(position) q: vec4f) -> @location(0) vec4f {
  var p = q.xy / 64.0;
  var a = 0.0;
  var w = 0.5;
  for (var k = 0; k < 24; k++) {
    a += w * n(p);
    p = p * 2.03 + vec2f(a, -a);
    w *= 0.5;
    if (w < 0.01) { w = 0.5; }
  }
  return vec4f(a, a * 0.5, 1.0 - a, 1.0);
}`;

const GLSL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const GLSL_FS = `#version 300 es
precision highp float;
out vec4 col;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), u.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 p = gl_FragCoord.xy / 64.0;
  float a = 0.0;
  float w = 0.5;
  for (int k = 0; k < 24; k++) {
    a += w * n(p);
    p = p * 2.03 + vec2(a, -a);
    w *= 0.5;
    if (w < 0.01) w = 0.5;
  }
  col = vec4(a, a * 0.5, 1.0 - a, 1.0);
}`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Times `frame` (`sync` must resolve once the GPU is done): a short run decides how many frames to measure. */
async function bench(frame: () => void, sync: () => Promise<unknown> | void): Promise<number> {
  const run = async (n: number) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame();
    await sync();
    return (performance.now() - t0) / n;
  };
  const first = await run(3); // also warms up the pipeline
  return run(first > 100 ? 5 : 20);
}

async function probeGpu(): Promise<GpuProbe | null> {
  if (!navigator.gpu) return null;
  const req = (o?: GPURequestAdapterOptions) => navigator.gpu.requestAdapter(o).catch(() => null);
  const hp = await req({ powerPreference: 'high-performance' });
  const plain = await req();
  const fallback = await req({ forceFallbackAdapter: true });
  const adapter = hp ?? plain ?? fallback;
  const out: GpuProbe = {
    attempts: { hp: !!hp, plain: !!plain, fallback: !!fallback },
    software: false,
    features: [],
    limits: { maxTextureDimension2D: 0, maxStorageBufferBindingSize: 0, maxComputeInvocationsPerWorkgroup: 0, maxColorAttachments: 0 },
    device: false,
  };
  if (!adapter) return out;

  // `info` arrived in Chrome 127; older ones only have the deprecated isFallbackAdapter
  const info = adapter.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
  out.vendor = info?.vendor || undefined;
  out.architecture = info?.architecture || undefined;
  out.description = info?.description || undefined;
  out.software = !!(info?.isFallbackAdapter ?? (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter) || (!hp && !plain);
  out.features = [...adapter.features].sort();
  const l = adapter.limits;
  out.limits = {
    maxTextureDimension2D: l.maxTextureDimension2D,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
    maxColorAttachments: l.maxColorAttachments,
  };

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (e) {
    out.deviceError = msg(e);
    return out;
  }
  out.device = true;
  try {
    const module = device.createShaderModule({ code: WGSL });
    const format: GPUTextureFormat = 'rgba16float'; // the engine's buffer format
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
    const view = device.createTexture({ size: [BENCH_W, BENCH_H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT }).createView();
    out.benchMs = await bench(
      () => {
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        device.queue.submit([enc.finish()]);
      },
      () => device.queue.onSubmittedWorkDone(),
    );
  } catch (e) {
    out.deviceError = `BENCH: ${msg(e)}`;
  }
  device.destroy();
  return out;
}

function glContext(): WebGL2RenderingContext | null {
  const canvas = document.createElement('canvas');
  canvas.width = BENCH_W;
  canvas.height = BENCH_H;
  return canvas.getContext('webgl2', { antialias: false, depth: false });
}

function probeGl(gl: WebGL2RenderingContext | null): GlProbe {
  const out: GlProbe = { ok: false, floatRT: false, halfFloatRT: false, floatLinear: false };
  if (!gl) return out;
  out.ok = true;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  out.renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  out.vendor = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
  out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  out.floatRT = !!gl.getExtension('EXT_color_buffer_float');
  out.halfFloatRT = out.floatRT || !!gl.getExtension('EXT_color_buffer_half_float');
  out.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  return out;
}

async function benchGl(gl: WebGL2RenderingContext): Promise<number> {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'GLSL');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, GLSL_VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, GLSL_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'GLSL');
  gl.useProgram(prog);
  gl.viewport(0, 0, BENCH_W, BENCH_H);
  const px = new Uint8Array(4);
  // readPixels stalls until the GPU is done: that is the sync point
  return bench(
    () => gl.drawArrays(gl.TRIANGLES, 0, 3),
    () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
  );
}

function probeWorker(): Promise<WorkerProbe | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const done = (v: WorkerProbe | null) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    worker.onmessage = (e: MessageEvent<WorkerProbe>) => done(e.data);
    worker.onerror = () => done(null);
  });
}

async function probeMedia(): Promise<MediaProbe> {
  let avc1080 = false;
  if ('VideoEncoder' in globalThis) {
    try {
      // H.264 high profile at the render cap
      avc1080 = !!(await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080 })).supported;
    } catch {}
  }
  return {
    camera: !!navigator.mediaDevices?.getUserMedia,
    trackProcessor: 'MediaStreamTrackProcessor' in globalThis,
    videoEncoder: 'VideoEncoder' in globalThis,
    avc1080,
    recorderMp4: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4'),
  };
}

/** Runs every check in order; `step` names what is running, for the screen. */
export async function probe(step: (what: string) => void): Promise<Probe> {
  step('NAVEGADOR');
  const env = await readEnv();
  const nav = navigator as Navigator & { deviceMemory?: number };
  step('WEBGPU');
  const gpu = await probeGpu().catch(() => null);
  step('WORKER');
  const worker = await probeWorker();
  step('WEBGL2');
  const ctx = glContext();
  const gl = probeGl(ctx);
  if (ctx) {
    gl.benchMs = await benchGl(ctx).catch(() => undefined);
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
  }
  step('CÁMARA Y VÍDEO');
  const media = await probeMedia();
  return {
    date: new Date().toISOString().slice(0, 10),
    env,
    memory: nav.deviceMemory,
    cores: navigator.hardwareConcurrency || undefined,
    screen: `${screen.width}x${screen.height}@${Math.round(devicePixelRatio * 100) / 100}`,
    standalone: matchMedia('(display-mode: standalone)').matches,
    gpu,
    worker,
    gl,
    media,
  };
}
