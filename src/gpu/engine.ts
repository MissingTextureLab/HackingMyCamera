// WebGPU executor for compiled effects. Runs inside the render worker.
//
// The Engine owns what is shared: device, layouts, pipeline cache, the camera
// texture. A Stage is one surface that runs an effect: the main viewfinder or
// a gallery thumbnail. Each stage has its own output buffers (o0…o3,
// rgba16float, ping-ponged so reads see the previous frame), temps, params and
// canvas; it ends with a present pass that blits the display buffer to its
// canvas, optionally as a 1-bit "xerox" frame.

import { compileEffect, MAX_PARAMS, MAX_PASS_INPUTS, type CompiledEffect } from '../graph/compile';
import type { EffectGraph } from '../graph/types';
import { OUTPUTS } from '../graph/types';
import { buildGlyphAtlas, buildStampAtlas, stampCodes, STAMP_CHARS, STAMP_H, STAMP_W } from './glyphs';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

// The house look ("revelado Citrink"): every surface ends here, so the
// viewfinder, photos, videos and thumbnails share it. A gentle S curve, the
// luminance re-read along the Citrink ramp, quantized with a 2 px ordered
// dither; on captures, a date-back stamp in Doto, bottom right.
const PRESENT_WGSL = /* wgsl */ `
struct Present {
  xerox: f32,
  ramp: f32,
  levels: f32,
  dither: f32,
  stamp: f32,
  count: f32,
  cellH: f32,
  mode: f32,
  chars: array<vec4u, 8>,
};
@group(0) @binding(0) var<uniform> U: Present;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var font: texture_2d<f32>;

const ATLAS_COUNT: f32 = ${STAMP_CHARS.length}.0;
const CHAR_ASPECT: f32 = ${STAMP_W / STAMP_H};

// Two grades with the same tonal structure: 0 ÁCIDO (the Citrink ramp),
// 1 MORADO (the same steps of lightness, in violet).
var<private> RAMP: array<vec3f, 16> = array<vec3f, 16>(
  vec3f(0.12549, 0.08235, 0.2),
  vec3f(0.14510, 0.14118, 0.27451),
  vec3f(0.14510, 0.30196, 0.43922),
  vec3f(0.08627, 0.43137, 0.47843),
  vec3f(0.32157, 0.76471, 0.24706),
  vec3f(0.69804, 0.85098, 0.25882),
  vec3f(0.98824, 0.96471, 0.37647),
  vec3f(1.0, 1.0, 1.0),
  vec3f(0.12549, 0.08235, 0.2),
  vec3f(0.18431, 0.11373, 0.30588),
  vec3f(0.27843, 0.14510, 0.47843),
  vec3f(0.40000, 0.18824, 0.62353),
  vec3f(0.54902, 0.24706, 0.74902),
  vec3f(0.71765, 0.38824, 0.83922),
  vec3f(0.90980, 0.70588, 0.94118),
  vec3f(1.0, 0.95686, 1.0)
);

fn rampColor(i: u32) -> vec3f {
  return RAMP[min(u32(U.mode), 1u) * 8u + min(i, 7u)];
}

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn bayer4(p: vec2u) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(p.y % 4u) * 4u + (p.x % 4u)] + 0.5) / 16.0;
}

fn rampAt(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0) * 7.0;
  let i = u32(min(floor(x), 6.0));
  return mix(rampColor(i), rampColor(i + 1u), x - f32(i));
}

// coverage of the stamp text at pixel px (0 outside it)
fn stampInk(px: vec2f, res: vec2f) -> f32 {
  let n = u32(U.count);
  let ch = U.cellH;
  let cw = ch * CHAR_ASPECT;
  let margin = ch * 1.2;
  let origin = vec2f(res.x - margin - f32(n) * cw, res.y - margin - ch);
  let q = (px - origin) / vec2f(cw, ch);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= f32(n) || q.y >= 1.0) { return 0.0; }
  let k = u32(q.x);
  let idx = U.chars[k / 4u][k % 4u];
  return textureSampleLevel(font, samp, vec2f((f32(idx) + fract(q.x)) / ATLAS_COUNT, q.y), 0.0).r;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = clamp(textureSampleLevel(src, samp, in.uv, 0.0).rgb, vec3f(0.0), vec3f(1.0));
  var l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (U.xerox > 0.5) {
    // photocopy frame: hard threshold onto the darkest and lightest Citrink colours
    return select(vec4f(rampColor(0u), 1.0), vec4f(rampColor(7u), 1.0), l > 0.42);
  }
  l = mix(l, l * l * (3.0 - 2.0 * l), 0.5);
  let steps = max(U.levels, 2.0) - 1.0;
  let b = bayer4(vec2u(in.pos.xy / max(U.dither, 1.0)));
  let t = clamp(floor(l * steps + b) / steps, 0.0, 1.0);
  var col = mix(c, rampAt(t), clamp(U.ramp, 0.0, 1.0));
  if (U.stamp > 0.5) {
    let res = vec2f(textureDimensions(src));
    // a dark outline all round keeps the yellow legible on light images
    let d = max(floor(U.cellH * 0.07), 1.0);
    let outline = max(
      max(stampInk(in.pos.xy + vec2f(d, 0.0), res), stampInk(in.pos.xy - vec2f(d, 0.0), res)),
      max(stampInk(in.pos.xy + vec2f(0.0, d), res), stampInk(in.pos.xy - vec2f(0.0, d), res)));
    col = mix(col, rampColor(0u), outline);
    col = mix(col, rampColor(6u), stampInk(in.pos.xy, res));
  }
  return vec4f(col, 1.0);
}
`;

// Animated test card used when there is no camera (desktop, ?source=test).
const TESTCARD_WGSL = /* wgsl */ `
struct T { time: f32, pad0: f32, res: vec2f };
@group(0) @binding(0) var<uniform> U: T;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv;
  var col = vec3f(0.12549, 0.08235, 0.2);
  // colour bars in the top third
  if (uv.y < 0.33) {
    let bars = array<vec3f, 8>(
      vec3f(1.0), vec3f(0.98824, 0.96471, 0.37647), vec3f(0.69804, 0.85098, 0.25882), vec3f(0.32157, 0.76471, 0.24706),
      vec3f(0.08627, 0.43137, 0.47843), vec3f(0.14510, 0.30196, 0.43922), vec3f(0.14510, 0.14118, 0.27451), vec3f(0.12549, 0.08235, 0.2));
    col = bars[min(u32(uv.x * 8.0), 7u)];
  } else if (uv.y > 0.85) {
    // grey ramp
    col = vec3f(floor(uv.x * 16.0) / 15.0);
  } else {
    // grid with a moving lit disc: something for effects to chew on
    let px = uv * U.res;
    let grid = step(0.96, fract(px.x / 48.0)) + step(0.96, fract(px.y / 48.0));
    col = mix(col, vec3f(0.08627, 0.43137, 0.47843), clamp(grid, 0.0, 1.0));
    let asp = U.res.x / U.res.y;
    let c = vec2f(0.5 + 0.28 * sin(U.time * 0.7), 0.58 + 0.12 * cos(U.time * 1.1));
    let d = length(vec2f((uv.x - c.x) * asp, uv.y - c.y));
    let disc = 1.0 - smoothstep(0.17, 0.18, d);
    let shade = 0.35 + 0.65 * clamp(1.0 - d / 0.18 + (c.x - uv.x), 0.0, 1.0);
    col = mix(col, vec3f(shade), disc);
  }
  return vec4f(col, 1.0);
}
`;

export interface EngineStats {
  width: number;
  height: number;
  passes: number;
  gpuMs: number | null;
}

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

// Camera history for sampleCamAgo (BARRIDO's time machine): HISTORY_LAYERS
// frames at HISTORY_RATE per second (~2.1 s), long side HISTORY_SIZE px,
// shared by every stage. Stored raw; the cover fit is applied when reading.
const HISTORY_LAYERS = 64;
const HISTORY_RATE = 30;
const HISTORY_SIZE = 480;

const HISTORY_WGSL = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, in.uv, 0.0);
}
`;

/** The house look, shared by every surface (DESIGN.md, Revelado). */
const HOUSE = { ramp: 0.7, levels: 12, dither: 2 };
const STAMP_MAX = 32;
const PRESENT_SIZE = 32 + STAMP_MAX * 4;

interface LoadedEffect {
  graph: EffectGraph;
  compiled: CompiledEffect;
  /** Per compiled pass, one pipeline per draw (fullscreen passes have one). */
  pipelines: GPURenderPipeline[][];
  temps: Map<string, GPUTexture>;
  /** Depth buffers of 3D scene temps, by temp id. */
  depths: Map<string, GPUTexture>;
  /** group(1) per pass: its T0…T3 inputs. */
  inputGroups: GPUBindGroup[];
  /** Per pass: the compute pipeline and bind group of processor passes, null otherwise. */
  computePipelines: (GPUComputePipeline | null)[];
  computeGroups: (GPUBindGroup | null)[];
}

/** One surface running one effect: the viewfinder or a thumbnail. */
class Stage {
  readonly canvas: OffscreenCanvas;
  readonly context: GPUCanvasContext;
  effect: LoadedEffect | null = null;
  xeroxFrames = 0;
  lastTime = 0;

  private globals: GPUBuffer;
  private globalsData = new Float32Array(12);
  private params: GPUBuffer;
  private paramsData = new Float32Array(MAX_PARAMS);
  private paramsDirty = true;
  private outputs: GPUTexture[][] = [];
  private bindGroups: GPUBindGroup[] = [];
  private presentUniform: GPUBuffer;
  private presentData = new ArrayBuffer(PRESENT_SIZE);
  private presentF = new Float32Array(this.presentData, 0, 8);
  private presentU = new Uint32Array(this.presentData, 32, STAMP_MAX);
  private stampCount = 0;
  /** Print the date-back stamp on this frame (photos, recording). */
  stamp = false;
  private presentGroups = new Map<string, GPUBindGroup>();
  private frame = 0;

  constructor(
    private e: Engine,
    canvas: OffscreenCanvas,
  ) {
    const d = e.device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.context.configure({ device: d, format: e.format, alphaMode: 'opaque' });
    this.globals = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = d.createBuffer({ size: MAX_PARAMS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.presentUniform = d.createBuffer({ size: PRESENT_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resize(canvas.width, canvas.height);
  }

  get size(): [number, number] {
    return [this.canvas.width, this.canvas.height];
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    for (const pair of this.outputs) for (const t of pair) t.destroy();
    this.outputs = OUTPUTS.map(() =>
      [0, 1].map(() =>
        this.e.device.createTexture({
          size: [width, height],
          format: BUFFER_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
    );
    this.rebuildBindGroups();
    if (this.effect) this.allocateTemps(this.effect);
  }

  setEffect(loaded: LoadedEffect) {
    const old = this.effect;
    this.allocateTemps(loaded);
    this.effect = loaded;
    if (old) for (const t of [...old.temps.values(), ...old.depths.values()]) t.destroy();
    this.paramsData.set(loaded.compiled.values);
    this.paramsDirty = true;
    // clear feedback so the new effect starts clean
    const enc = this.e.device.createCommandEncoder();
    for (const pair of this.outputs) {
      for (const t of pair) {
        enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end();
      }
    }
    this.e.device.queue.submit([enc.finish()]);
  }

  setStampText(text: string) {
    const codes = stampCodes(text).slice(0, STAMP_MAX);
    this.presentU.fill(0);
    this.presentU.set(codes);
    this.stampCount = codes.length;
  }

  setParam(slot: number, value: number) {
    this.paramsData[slot] = value;
    this.paramsDirty = true;
  }

  /** Cover fit of the camera into this stage, with zoom and mirror. */
  updateCamFit() {
    const [cw, ch] = this.e.camSize;
    const [W, H] = this.size;
    if (!cw || !ch || !W || !H) return;
    const outAspect = W / H;
    const camAspect = cw / ch;
    const g = this.globalsData;
    g[2] = W;
    g[3] = H;
    g[4] = (camAspect > outAspect ? outAspect / camAspect : 1) / this.e.zoom;
    g[5] = (camAspect > outAspect ? 1 : camAspect / outAspect) / this.e.zoom;
    g[6] = this.e.mirror ? 1 : 0;
    g[7] = 0;
  }

  /** Encodes this stage's passes and its present into `enc`. */
  encode(enc: GPUCommandEncoder, time: number, dt: number, timestamps: GPUQuerySet | null) {
    const eff = this.effect;
    if (!eff) return;
    const d = this.e.device;
    const g = this.globalsData;
    g[0] = time;
    g[1] = dt;
    g[8] = this.e.histHead;
    g[9] = this.e.histFilled;
    g[10] = HISTORY_RATE;
    g[11] = HISTORY_LAYERS;
    d.queue.writeBuffer(this.globals, 0, g);
    if (this.paramsDirty) {
      d.queue.writeBuffer(this.params, 0, this.paramsData);
      this.paramsDirty = false;
    }

    const parity = this.frame & 1;
    eff.compiled.passes.forEach((p, i) => {
      const target = p.target.kind === 'output' ? this.outputs[OUTPUTS.indexOf(p.target.id)][parity] : eff.temps.get(p.target.id)!;
      if (p.compute) {
        const cp = enc.beginComputePass();
        cp.setPipeline(eff.computePipelines[i]!);
        cp.setBindGroup(0, eff.computeGroups[i]!);
        cp.dispatchWorkgroups(target.width);
        cp.end();
        return;
      }
      const depth = p.target.kind === 'temp' ? eff.depths.get(p.target.id) : undefined;
      const pass = enc.beginRenderPass({
        // 3D scenes clear to the darkest Citrink colour; 2D passes cover every pixel anyway
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: p.draws ? [0.12549, 0.08235, 0.2, 1] : [0, 0, 0, 1] }],
        depthStencilAttachment: depth
          ? { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' }
          : undefined,
        timestampWrites: timestamps && i === 0 ? { querySet: timestamps, beginningOfPassWriteIndex: 0 } : undefined,
      });
      pass.setBindGroup(0, this.bindGroups[parity]);
      pass.setBindGroup(1, eff.inputGroups[i]);
      const draws = p.draws ?? [{ count: 3 }];
      draws.forEach((d, k) => {
        pass.setPipeline(eff.pipelines[i][k]);
        pass.draw(d.count);
      });
      pass.end();
    });

    const xerox = this.xeroxFrames > 0 ? 1 : 0;
    if (this.xeroxFrames > 0) this.xeroxFrames--;
    const f = this.presentF;
    const [, H] = this.size;
    f[0] = xerox;
    f[1] = HOUSE.ramp;
    f[2] = HOUSE.levels;
    f[3] = H < 300 ? 1 : HOUSE.dither; // thumbnails: finer dither
    f[4] = this.stamp ? 1 : 0;
    f[5] = this.stampCount;
    f[6] = Math.max(8, Math.round(H * 0.022));
    f[7] = this.e.grade;
    d.queue.writeBuffer(this.presentUniform, 0, this.presentData);
    const displayIndex = OUTPUTS.indexOf(eff.compiled.display);
    const present = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: timestamps ? { querySet: timestamps, endOfPassWriteIndex: 1 } : undefined,
    });
    present.setPipeline(this.e.presentPipeline);
    present.setBindGroup(0, this.presentGroup(displayIndex, parity));
    present.draw(3);
    present.end();
    this.frame++;
  }

  passCount() {
    return (this.effect?.compiled.passes.length ?? 0) + 1; // + present
  }

  rebuildBindGroups() {
    if (!this.outputs.length) return;
    this.presentGroups.clear();
    this.updateCamFit();
    this.bindGroups = [0, 1].map((parity) =>
      this.e.device.createBindGroup({
        layout: this.e.layout,
        entries: [
          { binding: 0, resource: { buffer: this.globals } },
          { binding: 1, resource: { buffer: this.params } },
          { binding: 2, resource: this.e.sampler },
          { binding: 3, resource: this.e.cam.createView() },
          { binding: 8, resource: this.e.glyphs.createView() },
          { binding: 9, resource: this.e.history.createView({ dimension: '2d-array' }) },
          // reads always see the previous frame: the texture not written this frame
          ...OUTPUTS.map((_, i) => ({ binding: 4 + i, resource: this.outputs[i][parity ^ 1].createView() })),
        ],
      }),
    );
  }

  destroy() {
    for (const pair of this.outputs) for (const t of pair) t.destroy();
    if (this.effect) for (const t of [...this.effect.temps.values(), ...this.effect.depths.values()]) t.destroy();
    this.globals.destroy();
    this.params.destroy();
    this.presentUniform.destroy();
  }

  // Temp textures live with the effect and follow the stage size.
  private allocateTemps(eff: LoadedEffect) {
    for (const t of [...eff.temps.values(), ...eff.depths.values()]) t.destroy();
    eff.temps.clear();
    eff.depths.clear();
    const [W, H] = this.size;
    for (const t of eff.compiled.temps) {
      const size = [Math.max(2, Math.round(W * t.scale)), Math.max(2, Math.round(H * t.scale))];
      eff.temps.set(
        t.id,
        this.e.device.createTexture({
          size,
          format: BUFFER_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | (t.storage ? GPUTextureUsage.STORAGE_BINDING : 0),
        }),
      );
      if (t.depth) {
        eff.depths.set(t.id, this.e.device.createTexture({ size, format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT }));
      }
    }
    eff.inputGroups = eff.compiled.passes.map((p) =>
      this.e.device.createBindGroup({
        layout: this.e.inputLayout,
        entries: Array.from({ length: MAX_PASS_INPUTS }, (_, i) => ({
          binding: i,
          resource: (p.inputs[i] ? eff.temps.get(p.inputs[i])! : this.e.dummy).createView(),
        })),
      }),
    );
    eff.computeGroups = eff.compiled.passes.map((p) =>
      p.compute && p.target.kind === 'temp'
        ? this.e.device.createBindGroup({
            layout: this.e.computeLayout,
            entries: [
              { binding: 0, resource: { buffer: this.globals } },
              { binding: 1, resource: { buffer: this.params } },
              { binding: 2, resource: eff.temps.get(p.inputs[0])!.createView() },
              { binding: 3, resource: eff.temps.get(p.target.id)!.createView() },
              { binding: 4, resource: this.e.sampler },
            ],
          })
        : null,
    );
  }

  private presentGroup(outputIndex: number, parity: number) {
    const key = `${outputIndex}:${parity}`;
    let group = this.presentGroups.get(key);
    if (!group) {
      group = this.e.device.createBindGroup({
        layout: this.e.presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.presentUniform } },
          { binding: 1, resource: this.e.sampler },
          { binding: 2, resource: this.outputs[outputIndex][parity].createView() },
          { binding: 3, resource: this.e.stampFont.createView() },
        ],
      });
      this.presentGroups.set(key, group);
    }
    return group;
  }
}

export class Engine {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly sampler: GPUSampler;
  readonly layout: GPUBindGroupLayout;
  readonly inputLayout: GPUBindGroupLayout;
  readonly dummy: GPUTexture;
  /** LETRA's glyph atlas (see glyphs.ts). */
  readonly glyphs: GPUTexture;
  /** The stamp's Doto alphabet (see glyphs.ts). */
  readonly stampFont: GPUTexture;
  readonly presentPipeline: GPURenderPipeline;
  readonly main: Stage;

  cam: GPUTexture;
  camSize: [number, number] = [0, 0];
  /** Past camera frames (see HISTORY_LAYERS); a ring, newest at histHead. */
  history: GPUTexture;
  histHead = 0;
  histFilled = 0;
  private histTime = -Infinity;
  private historyPipeline: GPURenderPipeline;
  private historyGroup: GPUBindGroup | null = null;
  mirror = false;
  zoom = 1;
  /** Revelado mode, shared by every stage: 0 ÁCIDO, 1 MORADO. */
  grade = 0;

  private pipelineLayout: GPUPipelineLayout;
  readonly computeLayout: GPUBindGroupLayout;
  private computePipelineLayout: GPUPipelineLayout;
  private pipelineCache = new Map<string, Promise<GPURenderPipeline>>();
  private thumbs = new Map<string, Stage>();
  private thumbOrder: string[] = [];
  private thumbCursor = 0;

  private testPipeline: GPURenderPipeline;
  private testUniform: GPUBuffer;
  private testGroup: GPUBindGroup;

  private query: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null = null;
  private gpuMs: number | null = null;
  private frame = 0;

  onError: (message: string) => void = () => {};

  private constructor(device: GPUDevice, canvas: OffscreenCanvas, glyphs: GPUTexture, stampFont: GPUTexture) {
    this.glyphs = glyphs;
    this.stampFont = stampFont;
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // 3D scenes read params and textures in the vertex stage too
    const both = GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX;
    const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: both, texture: { sampleType: 'float' } });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: both, buffer: { type: 'uniform' } },
        { binding: 2, visibility: both, sampler: { type: 'filtering' } },
        tex(3), tex(4), tex(5), tex(6), tex(7), tex(8),
        { binding: 9, visibility: both, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      ],
    });
    this.inputLayout = device.createBindGroupLayout({
      entries: Array.from({ length: MAX_PASS_INPUTS }, (_, i) => tex(i)),
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, this.inputLayout] });
    const cs = GPUShaderStage.COMPUTE;
    this.computeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: cs, buffer: { type: 'uniform' } },
        { binding: 1, visibility: cs, buffer: { type: 'uniform' } },
        { binding: 2, visibility: cs, texture: { sampleType: 'float' } },
        { binding: 3, visibility: cs, storageTexture: { access: 'write-only', format: BUFFER_FORMAT } },
        { binding: 4, visibility: cs, sampler: { type: 'filtering' } },
      ],
    });
    this.computePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.computeLayout] });
    // fills T0…T3 slots a pass doesn't use
    this.dummy = device.createTexture({ size: [1, 1], format: BUFFER_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING });
    this.cam = this.makeCamTexture(16, 16);
    this.history = this.makeHistory(16, 16);

    const presentModule = device.createShaderModule({ code: PRESENT_WGSL });
    this.presentPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: this.format }] },
    });

    const historyModule = device.createShaderModule({ code: HISTORY_WGSL });
    this.historyPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: historyModule, entryPoint: 'vs' },
      fragment: { module: historyModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });

    const testModule = device.createShaderModule({ code: TESTCARD_WGSL });
    this.testPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: testModule, entryPoint: 'vs' },
      fragment: { module: testModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    this.testUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.testGroup = device.createBindGroup({
      layout: this.testPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.testUniform } }],
    });

    if (device.features.has('timestamp-query')) {
      this.query = {
        set: device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
      };
    }

    this.main = new Stage(this, canvas);
  }

  static async create(canvas: OffscreenCanvas): Promise<Engine> {
    if (!navigator.gpu) throw new Error('SIN WEBGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('SIN ADAPTADOR GPU');
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures });
    const [glyphs, stampFont] = await Promise.all([Engine.atlasTexture(device, buildGlyphAtlas), Engine.atlasTexture(device, buildStampAtlas)]);
    const engine = new Engine(device, canvas, glyphs, stampFont);
    device.lost.then((info) => engine.onError(`GPU PERDIDA: ${info.message}`));
    device.addEventListener('uncapturederror', (e) => engine.onError((e as GPUUncapturedErrorEvent).error.message));
    return engine;
  }

  private static async atlasTexture(device: GPUDevice, build: () => Promise<OffscreenCanvas>): Promise<GPUTexture> {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    try {
      const atlas = await build();
      const tex = device.createTexture({ size: [atlas.width, atlas.height], format: 'rgba8unorm', usage });
      device.queue.copyExternalImageToTexture({ source: atlas }, { texture: tex }, [atlas.width, atlas.height]);
      return tex;
    } catch {
      // no atlas: LETRA / the stamp draw nothing instead of failing the whole engine
      return device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage });
    }
  }

  get canvas() {
    return this.main.canvas;
  }

  resize(width: number, height: number) {
    this.main.resize(width, height);
  }

  /** Copies a camera frame into the camera texture. Closes the frame. */
  uploadFrame(frame: VideoFrame, mirror: boolean) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (w !== this.camSize[0] || h !== this.camSize[1]) this.replaceCam(w, h);
    if (mirror !== this.mirror) {
      this.mirror = mirror;
      this.forEachStage((s) => s.updateCamFit());
    }
    try {
      this.device.queue.copyExternalImageToTexture({ source: frame }, { texture: this.cam }, [w, h]);
    } finally {
      frame.close();
    }
  }

  /** Renders the test card into the camera texture (no real camera). */
  renderTestCard(time: number) {
    const [w, h] = [720, 1280];
    if (this.camSize[0] !== w || this.camSize[1] !== h) {
      this.mirror = false;
      this.replaceCam(w, h);
    }
    this.device.queue.writeBuffer(this.testUniform, 0, new Float32Array([time, 0, w, h]));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.cam.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.testPipeline);
    pass.setBindGroup(0, this.testGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Compiles and swaps in an effect on the viewfinder. The old one runs until pipelines are ready. */
  async setEffect(graph: EffectGraph) {
    const loaded = await this.load(graph);
    this.main.setEffect(loaded);
    this.main.xeroxFrames = 5;
    return loaded.compiled;
  }

  /** A gallery thumbnail (this also precompiles the effect for the viewfinder): its own small stage running `graph` with default params. */
  async addThumb(id: string, canvas: OffscreenCanvas, graph: EffectGraph) {
    const loaded = await this.load(graph);
    // Create the stage only now, with no await until it's registered: its bind
    // groups point at the current camera texture, which may be replaced meanwhile.
    this.thumbs.get(id)?.destroy();
    const stage = new Stage(this, canvas);
    stage.setEffect(loaded);
    this.thumbs.set(id, stage);
    this.thumbOrder = [...this.thumbs.keys()];
  }

  setParam(slot: number, value: number) {
    this.main.setParam(slot, value);
  }

  /** Digital zoom on the camera image (whatever the hardware zoom can't cover). */
  setGrade(mode: number) {
    this.grade = mode === 1 ? 1 : 0;
  }

  setZoom(zoom: number) {
    this.zoom = Math.max(1, zoom);
    this.forEachStage((s) => s.updateCamFit());
  }

  /** Renders the viewfinder and, round-robin, one thumbnail. */
  render(time: number, dt: number) {
    if (!this.main.effect) return;
    const enc = this.device.createCommandEncoder();
    if (time - this.histTime >= 1 / HISTORY_RATE) {
      // keep the nominal rate; after a stall, restart from now
      this.histTime = time - this.histTime > 0.25 ? time : this.histTime + 1 / HISTORY_RATE;
      this.storeHistory(enc);
    }
    const q = this.query;
    this.main.encode(enc, time, dt, q?.set ?? null);

    if (this.thumbOrder.length) {
      const id = this.thumbOrder[this.thumbCursor++ % this.thumbOrder.length];
      const t = this.thumbs.get(id)!;
      t.encode(enc, time, t.lastTime ? time - t.lastTime : dt, null);
      t.lastTime = time;
    }

    const sample = q && !q.busy && this.frame % 30 === 0;
    if (sample) {
      enc.resolveQuerySet(q.set, 0, 2, q.resolve, 0);
      enc.copyBufferToBuffer(q.resolve, 0, q.read, 0, 16);
    }
    this.device.queue.submit([enc.finish()]);
    if (sample) {
      q.busy = true;
      q.read.mapAsync(GPUMapMode.READ).then(
        () => {
          const t = new BigUint64Array(q.read.getMappedRange());
          const ns = Number(t[1] - t[0]);
          if (ns > 0 && ns < 1e9) this.gpuMs = ns / 1e6;
          q.read.unmap();
          q.busy = false;
        },
        () => (q.busy = false),
      );
    }
    this.frame++;
  }

  stats(): EngineStats {
    const [width, height] = this.main.size;
    return { width, height, passes: this.main.passCount(), gpuMs: this.gpuMs };
  }

  private async load(graph: EffectGraph): Promise<LoadedEffect> {
    const compiled = compileEffect(graph);
    const pipelines = await Promise.all(
      compiled.passes.map((p) =>
        p.compute
          ? Promise.resolve([])
          : p.draws
            ? Promise.all(p.draws.map((d) => this.pipeline(p.wgsl, d.vs, d.fs, true)))
            : Promise.all([this.pipeline(p.wgsl)]),
      ),
    );
    const computePipelines = await Promise.all(compiled.passes.map((p) => (p.compute ? this.computePipeline(p.wgsl) : null)));
    return { graph, compiled, pipelines, temps: new Map(), depths: new Map(), inputGroups: [], computePipelines, computeGroups: [] };
  }

  private forEachStage(fn: (s: Stage) => void) {
    fn(this.main);
    for (const s of this.thumbs.values()) fn(s);
  }

  private replaceCam(w: number, h: number) {
    this.cam.destroy();
    this.cam = this.makeCamTexture(w, h);
    this.history.destroy();
    this.history = this.makeHistory(w, h);
    this.forEachStage((s) => s.rebuildBindGroups());
  }

  /** Copies the camera, scaled down, into the next history layer. */
  private storeHistory(enc: GPUCommandEncoder) {
    this.historyGroup ??= this.device.createBindGroup({
      layout: this.historyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.cam.createView() },
      ],
    });
    this.histHead = (this.histHead + 1) % HISTORY_LAYERS;
    this.histFilled = Math.min(this.histFilled + 1, HISTORY_LAYERS);
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.history.createView({ dimension: '2d', baseArrayLayer: this.histHead, arrayLayerCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(this.historyPipeline);
    pass.setBindGroup(0, this.historyGroup);
    pass.draw(3);
    pass.end();
  }

  /** History textures follow the camera's aspect; a new camera starts with no past. */
  private makeHistory(w: number, h: number) {
    const k = HISTORY_SIZE / Math.max(w, h, 1);
    this.historyGroup = null;
    this.histFilled = 0;
    return this.device.createTexture({
      size: [Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k)), HISTORY_LAYERS],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private makeCamTexture(w: number, h: number) {
    this.camSize = [w, h];
    return this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private modules = new Map<string, Promise<GPUShaderModule>>();

  private module(wgsl: string): Promise<GPUShaderModule> {
    let m = this.modules.get(wgsl);
    if (!m) {
      m = (async () => {
        const module = this.device.createShaderModule({ code: wgsl });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((x) => x.type === 'error');
        if (errors.length) {
          const lines = wgsl.split('\n');
          throw new Error(errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}\n  ${lines[e.lineNum - 1] ?? ''}`).join('\n'));
        }
        return module;
      })();
      m.catch(() => this.modules.delete(wgsl));
      this.modules.set(wgsl, m);
    }
    return m;
  }

  private computeCache = new Map<string, Promise<GPUComputePipeline>>();

  private computePipeline(wgsl: string): Promise<GPUComputePipeline> {
    let p = this.computeCache.get(wgsl);
    if (!p) {
      p = this.module(wgsl).then((module) =>
        this.device.createComputePipelineAsync({ layout: this.computePipelineLayout, compute: { module, entryPoint: 'main' } }),
      );
      p.catch(() => this.computeCache.delete(wgsl));
      this.computeCache.set(wgsl, p);
    }
    return p;
  }

  /** Pipelines are cached by source and entry points; `depth` for 3D scenes. */
  private pipeline(wgsl: string, vs = 'vs', fs = 'fs', depth = false): Promise<GPURenderPipeline> {
    const key = `${vs}|${fs}|${depth}|${wgsl}`;
    let p = this.pipelineCache.get(key);
    if (!p) {
      p = this.module(wgsl).then((module) =>
        this.device.createRenderPipelineAsync({
          layout: this.pipelineLayout,
          vertex: { module, entryPoint: vs },
          fragment: { module, entryPoint: fs, targets: [{ format: BUFFER_FORMAT }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: depth ? { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal' } : undefined,
        }),
      );
      p.catch(() => this.pipelineCache.delete(key));
      this.pipelineCache.set(key, p);
    }
    return p;
  }
}
