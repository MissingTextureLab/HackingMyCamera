// WebGPU executor for compiled effects. Runs inside the render worker.
//
// Per frame: one fullscreen pass per written output buffer (o0…o3, rgba16float,
// ping-ponged so reads see the previous frame), then a present pass that blits
// the display buffer to the canvas, optionally as a 1-bit "xerox" frame.

import { compileEffect, MAX_PARAMS, type CompiledEffect } from '../graph/compile';
import type { EffectGraph, OutputId } from '../graph/types';
import { OUTPUTS } from '../graph/types';

const BUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

const PRESENT_WGSL = /* wgsl */ `
struct Present { xerox: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<uniform> U: Present;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

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
  let c = textureSampleLevel(src, samp, in.uv, 0.0);
  if (U.xerox > 0.5) {
    // photocopy frame: hard threshold onto the darkest and lightest Citrink colours
    let l = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return select(vec4f(0.12549, 0.08235, 0.2, 1.0), vec4f(1.0), l > 0.42);
  }
  return vec4f(c.rgb, 1.0);
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

interface LoadedEffect {
  graph: EffectGraph;
  compiled: CompiledEffect;
  pipelines: Map<OutputId, GPURenderPipeline>;
}

export interface EngineStats {
  width: number;
  height: number;
  passes: number;
  gpuMs: number | null;
}

export class Engine {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly canvas: OffscreenCanvas;

  private globals: GPUBuffer;
  private globalsData = new Float32Array(8);
  private params: GPUBuffer;
  private paramsData = new Float32Array(MAX_PARAMS);
  private paramsDirty = true;
  private sampler: GPUSampler;
  private layout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private pipelineCache = new Map<string, Promise<GPURenderPipeline>>();

  private cam: GPUTexture;
  private camSize: [number, number] = [0, 0];
  private mirror = false;
  private outputs: GPUTexture[][] = [];
  private bindGroups: GPUBindGroup[] = [];
  private frame = 0;

  private presentPipeline: GPURenderPipeline;
  private presentUniform: GPUBuffer;
  private presentGroups = new Map<string, GPUBindGroup>();
  private xeroxFrames = 0;

  private testPipeline: GPURenderPipeline;
  private testUniform: GPUBuffer;
  private testGroup: GPUBindGroup;

  private effect: LoadedEffect | null = null;

  private query: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null = null;
  private gpuMs: number | null = null;

  onError: (message: string) => void = () => {};

  private constructor(device: GPUDevice, canvas: OffscreenCanvas) {
    this.device = device;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.globals = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ size: MAX_PARAMS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        tex(3), tex(4), tex(5), tex(6), tex(7),
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });

    this.cam = this.makeCamTexture(16, 16);

    const presentModule = device.createShaderModule({ code: PRESENT_WGSL });
    this.presentPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
    this.presentUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

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

    this.resize(canvas.width, canvas.height);
  }

  static async create(canvas: OffscreenCanvas): Promise<Engine> {
    if (!navigator.gpu) throw new Error('SIN WEBGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('SIN ADAPTADOR GPU');
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures });
    const engine = new Engine(device, canvas);
    device.lost.then((info) => engine.onError(`GPU PERDIDA: ${info.message}`));
    device.addEventListener('uncapturederror', (e) => engine.onError((e as GPUUncapturedErrorEvent).error.message));
    return engine;
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
        this.device.createTexture({
          size: [width, height],
          format: BUFFER_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
    );
    this.rebuildBindGroups();
    this.updateCamFit();
  }

  /** Copies a camera frame into the camera texture. Closes the frame. */
  uploadFrame(frame: VideoFrame, mirror: boolean) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (w !== this.camSize[0] || h !== this.camSize[1]) {
      this.cam.destroy();
      this.cam = this.makeCamTexture(w, h);
      this.rebuildBindGroups();
    }
    if (mirror !== this.mirror) {
      this.mirror = mirror;
      this.updateCamFit();
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
      this.cam.destroy();
      this.cam = this.makeCamTexture(w, h);
      this.rebuildBindGroups();
      this.mirror = false;
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

  /** Compiles and swaps in an effect. The old one keeps running until pipelines are ready. */
  async setEffect(graph: EffectGraph) {
    const compiled = compileEffect(graph);
    const pipelines = new Map<OutputId, GPURenderPipeline>();
    await Promise.all(
      compiled.passes.map(async (p) => pipelines.set(p.output, await this.pipeline(p.wgsl))),
    );
    this.effect = { graph, compiled, pipelines };
    this.paramsData.set(compiled.values);
    this.paramsDirty = true;
    // clear feedback so the new effect starts clean
    const enc = this.device.createCommandEncoder();
    for (const pair of this.outputs) {
      for (const t of pair) {
        enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end();
      }
    }
    this.device.queue.submit([enc.finish()]);
    this.xeroxFrames = 5;
    return compiled;
  }

  /** Precompiles an effect's pipelines without switching to it. */
  async warm(graph: EffectGraph) {
    await Promise.all(compileEffect(graph).passes.map((p) => this.pipeline(p.wgsl)));
  }

  setParam(slot: number, value: number) {
    this.paramsData[slot] = value;
    this.paramsDirty = true;
  }

  render(time: number, dt: number) {
    const eff = this.effect;
    if (!eff) return;
    const g = this.globalsData;
    g[0] = time;
    g[1] = dt;
    this.device.queue.writeBuffer(this.globals, 0, g);
    if (this.paramsDirty) {
      this.device.queue.writeBuffer(this.params, 0, this.paramsData);
      this.paramsDirty = false;
    }

    const parity = this.frame & 1;
    const enc = this.device.createCommandEncoder();
    const passes = eff.compiled.passes;
    passes.forEach((p, i) => {
      const target = this.outputs[OUTPUTS.indexOf(p.output)][parity];
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: this.query && i === 0 ? { querySet: this.query.set, beginningOfPassWriteIndex: 0 } : undefined,
      });
      pass.setPipeline(eff.pipelines.get(p.output)!);
      pass.setBindGroup(0, this.bindGroups[parity]);
      pass.draw(3);
      pass.end();
    });

    const xerox = this.xeroxFrames > 0 ? 1 : 0;
    if (this.xeroxFrames > 0) this.xeroxFrames--;
    this.device.queue.writeBuffer(this.presentUniform, 0, new Float32Array([xerox, 0, 0, 0]));
    const display = this.outputs[OUTPUTS.indexOf(eff.compiled.display)][parity];
    const present = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: this.query ? { querySet: this.query.set, endOfPassWriteIndex: 1 } : undefined,
    });
    present.setPipeline(this.presentPipeline);
    present.setBindGroup(0, this.presentGroup(display, parity));
    present.draw(3);
    present.end();

    const q = this.query;
    const sample = q && !q.busy && this.frame % 30 === 0;
    if (sample) {
      enc.resolveQuerySet(q.set, 0, 2, q.resolve, 0);
      enc.copyBufferToBuffer(q.resolve, 0, q.read, 0, 16);
    }
    this.device.queue.submit([enc.finish()]);
    if (sample) {
      q.busy = true;
      q.read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(q.read.getMappedRange());
        const ns = Number(t[1] - t[0]);
        if (ns > 0 && ns < 1e9) this.gpuMs = ns / 1e6;
        q.read.unmap();
        q.busy = false;
      }, () => (q.busy = false));
    }
    this.frame++;
  }

  stats(): EngineStats {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      passes: (this.effect?.compiled.passes.length ?? 0) + 1,
      gpuMs: this.gpuMs,
    };
  }

  private makeCamTexture(w: number, h: number) {
    this.camSize = [w, h];
    this.updateCamFit();
    return this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  // Cover fit: scale camera uv so the frame fills the output without stretching.
  private updateCamFit() {
    const [cw, ch] = this.camSize;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!cw || !ch || !W || !H) return;
    const outAspect = W / H;
    const camAspect = cw / ch;
    const g = this.globalsData;
    g[2] = W;
    g[3] = H;
    g[4] = camAspect > outAspect ? outAspect / camAspect : 1;
    g[5] = camAspect > outAspect ? 1 : camAspect / outAspect;
    g[6] = this.mirror ? 1 : 0;
    g[7] = 0;
  }

  private rebuildBindGroups() {
    if (!this.outputs.length) return;
    this.presentGroups.clear();
    this.bindGroups = [0, 1].map((parity) =>
      this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.globals } },
          { binding: 1, resource: { buffer: this.params } },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.cam.createView() },
          // reads always see the previous frame: the texture not written this frame
          ...OUTPUTS.map((_, i) => ({ binding: 4 + i, resource: this.outputs[i][parity ^ 1].createView() })),
        ],
      }),
    );
  }

  private presentGroup(texture: GPUTexture, parity: number) {
    const key = `${this.outputs.findIndex((pair) => pair.includes(texture))}:${parity}`;
    let group = this.presentGroups.get(key);
    if (!group) {
      group = this.device.createBindGroup({
        layout: this.presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.presentUniform } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: texture.createView() },
        ],
      });
      this.presentGroups.set(key, group);
    }
    return group;
  }

  private pipeline(wgsl: string): Promise<GPURenderPipeline> {
    let p = this.pipelineCache.get(wgsl);
    if (!p) {
      p = (async () => {
        const module = this.device.createShaderModule({ code: wgsl });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) {
          const lines = wgsl.split('\n');
          throw new Error(errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}\n  ${lines[e.lineNum - 1] ?? ''}`).join('\n'));
        }
        return this.device.createRenderPipelineAsync({
          layout: this.pipelineLayout,
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: BUFFER_FORMAT }] },
        });
      })();
      p.catch(() => this.pipelineCache.delete(wgsl));
      this.pipelineCache.set(wgsl, p);
    }
    return p;
  }
}
