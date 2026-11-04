// WebGL2 executor for compiled effects (PLAN-DEVICES.md, level C): the same passes as engine.ts for phones
// whose Chrome gives no WebGPU adapter at all (Exynos/Xclipse, old drivers). Runs inside the render worker.
//
// 2D effects only: processors (compute) and 3D scenes stay WebGPU-only and are hidden from the gallery.
// The WGSL of the ops is translated to GLSL ES 3.00 (glsl.ts); this file supplies what that skips: the
// header (uniform blocks mirroring the WebGPU bindings), a fullscreen triangle and `main`.
//
// One GL context draws everything. A thumbnail renders into its own textures and its present pass goes
// to the corner of the main canvas, from where it is copied into the thumbnail's 2D canvas.
//
// Images are stored with row 0 = top of the picture, like the WebGPU engine, so the ops see the same
// uv and FC; only the present pass flips, because the default framebuffer's row 0 is the bottom.

import { compileEffect, MAX_PARAMS, MAX_PASS_INPUTS, type CompiledEffect, type CompiledPass } from '../graph/compile';
import type { EffectGraph } from '../graph/types';
import { OUTPUTS } from '../graph/types';
import { HOUSE, STAMP_MAX, type EngineStats } from './engine';
import { wgslToGlsl } from './glsl';
import { buildGlyphAtlas, buildStampAtlas, stampCodes, STAMP_CHARS, STAMP_H, STAMP_W } from './glyphs';
import type { Renderer } from './renderer';

const VERTEX = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vUV = p;
}`;

/** Mirrors HEADER in compile.ts: same blocks, same names. */
const FRAGMENT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(std140) uniform Globals { float time; float dt; vec2 res; vec4 camFit; } G;
layout(std140) uniform Params { vec4 P[64]; };
uniform sampler2D t_cam, t_o0, t_o1, t_o2, t_o3, t_glyphs, T0, T1, T2, T3;
in vec2 vUV;
out vec4 fragColor;
vec4 sampleCam(vec2 uv) {
  vec2 q = (uv - 0.5) * G.camFit.xy + 0.5;
  if (G.camFit.z > 0.5) q.x = 1.0 - q.x;
  return textureLod(t_cam, q, 0.0);
}
`;

/** Texture units: camera, o0–o3, glyph atlas, then the pass inputs T0–T3. */
const UNITS: [string, number][] = [
  ['t_cam', 0], ['t_o0', 1], ['t_o1', 2], ['t_o2', 3], ['t_o3', 4], ['t_glyphs', 5], ['T0', 6], ['T1', 7], ['T2', 8], ['T3', 9],
];
const INPUT_UNIT = 6;

const RAMP = `const vec3 RAMP[16] = vec3[16](
  vec3(0.12549, 0.08235, 0.2), vec3(0.14510, 0.14118, 0.27451), vec3(0.14510, 0.30196, 0.43922), vec3(0.08627, 0.43137, 0.47843),
  vec3(0.32157, 0.76471, 0.24706), vec3(0.69804, 0.85098, 0.25882), vec3(0.98824, 0.96471, 0.37647), vec3(1.0, 1.0, 1.0),
  vec3(0.12549, 0.08235, 0.2), vec3(0.18431, 0.11373, 0.30588), vec3(0.27843, 0.14510, 0.47843), vec3(0.40000, 0.18824, 0.62353),
  vec3(0.54902, 0.24706, 0.74902), vec3(0.71765, 0.38824, 0.83922), vec3(0.90980, 0.70588, 0.94118), vec3(1.0, 0.95686, 1.0));`;

// The house look, a port of PRESENT_WGSL in engine.ts: keep the two in step.
const PRESENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D src, font;
uniform float uXerox, uRamp, uLevels, uDither, uStamp, uCount, uCellH, uMode;
uniform uint uChars[${STAMP_MAX}];
in vec2 vUV;
out vec4 fragColor;
const float ATLAS_COUNT = ${STAMP_CHARS.length}.0;
const float CHAR_ASPECT = ${STAMP_W / STAMP_H};
${RAMP}
vec3 rampColor(uint i) { return RAMP[min(uint(uMode), 1u) * 8u + min(i, 7u)]; }
float bayer4(uvec2 p) {
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(p.y % 4u) * 4u + (p.x % 4u)] + 0.5) / 16.0;
}
vec3 rampAt(float t) {
  float x = clamp(t, 0.0, 1.0) * 7.0;
  uint i = uint(min(floor(x), 6.0));
  return mix(rampColor(i), rampColor(i + 1u), x - float(i));
}
float stampInk(vec2 px, vec2 res) {
  uint n = uint(uCount);
  float ch = uCellH;
  float cw = ch * CHAR_ASPECT;
  float margin = ch * 1.2;
  vec2 origin = vec2(res.x - margin - float(n) * cw, res.y - margin - ch);
  vec2 q = (px - origin) / vec2(cw, ch);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= float(n) || q.y >= 1.0) return 0.0;
  uint k = uint(q.x);
  uint idx = uChars[k];
  return textureLod(font, vec2((float(idx) + fract(q.x)) / ATLAS_COUNT, q.y), 0.0).r;
}
void main() {
  vec2 res = vec2(textureSize(src, 0));
  // the default framebuffer has row 0 at the bottom; the picture's row 0 is its top
  vec2 pos = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec3 c = clamp(textureLod(src, pos / res, 0.0).rgb, vec3(0.0), vec3(1.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (uXerox > 0.5) {
    fragColor = l > 0.42 ? vec4(rampColor(7u), 1.0) : vec4(rampColor(0u), 1.0);
    return;
  }
  l = mix(l, l * l * (3.0 - 2.0 * l), 0.5);
  float steps = max(uLevels, 2.0) - 1.0;
  float b = bayer4(uvec2(pos / max(uDither, 1.0)));
  float t = clamp(floor(l * steps + b) / steps, 0.0, 1.0);
  vec3 col = mix(c, rampAt(t), clamp(uRamp, 0.0, 1.0));
  if (uStamp > 0.5) {
    float d = max(floor(uCellH * 0.07), 1.0);
    float outline = max(
      max(stampInk(pos + vec2(d, 0.0), res), stampInk(pos - vec2(d, 0.0), res)),
      max(stampInk(pos + vec2(0.0, d), res), stampInk(pos - vec2(0.0, d), res)));
    col = mix(col, rampColor(0u), outline);
    col = mix(col, rampColor(6u), stampInk(pos, res));
  }
  fragColor = vec4(col, 1.0);
}`;

// Animated test card, a port of TESTCARD_WGSL (desktop, ?source=test).
const TESTCARD = `#version 300 es
precision highp float;
uniform float uTime;
uniform vec2 uRes;
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec2 uv = vUV;
  vec3 col = vec3(0.12549, 0.08235, 0.2);
  if (uv.y < 0.33) {
    vec3 bars[8] = vec3[8](
      vec3(1.0), vec3(0.98824, 0.96471, 0.37647), vec3(0.69804, 0.85098, 0.25882), vec3(0.32157, 0.76471, 0.24706),
      vec3(0.08627, 0.43137, 0.47843), vec3(0.14510, 0.30196, 0.43922), vec3(0.14510, 0.14118, 0.27451), vec3(0.12549, 0.08235, 0.2));
    col = bars[min(int(uv.x * 8.0), 7)];
  } else if (uv.y > 0.85) {
    col = vec3(floor(uv.x * 16.0) / 15.0);
  } else {
    vec2 px = uv * uRes;
    float grid = step(0.96, fract(px.x / 48.0)) + step(0.96, fract(px.y / 48.0));
    col = mix(col, vec3(0.08627, 0.43137, 0.47843), clamp(grid, 0.0, 1.0));
    float asp = uRes.x / uRes.y;
    vec2 c = vec2(0.5 + 0.28 * sin(uTime * 0.7), 0.58 + 0.12 * cos(uTime * 1.1));
    float d = length(vec2((uv.x - c.x) * asp, uv.y - c.y));
    float disc = 1.0 - smoothstep(0.17, 0.18, d);
    float shade = 0.35 + 0.65 * clamp(1.0 - d / 0.18 + (c.x - uv.x), 0.0, 1.0);
    col = mix(col, vec3(shade), disc);
  }
  fragColor = vec4(col, 1.0);
}`;

const PRESENT_SIZE = 32 + STAMP_MAX * 4;

interface Program {
  program: WebGLProgram;
  globals: number;
  params: number;
}

interface LoadedEffect {
  graph: EffectGraph;
  compiled: CompiledEffect;
  programs: Program[];
  temps: Map<string, { tex: WebGLTexture; w: number; h: number }>;
}

type Tex = { tex: WebGLTexture; w: number; h: number };

/** One surface running one effect: the viewfinder or a thumbnail. */
class GlStage {
  effect: LoadedEffect | null = null;
  xeroxFrames = 0;
  lastTime = 0;
  /** Print the date-back stamp on this frame (photos, recording). */
  stamp = false;

  private globals: WebGLBuffer;
  private globalsData = new Float32Array(8);
  private params: WebGLBuffer;
  private paramsData = new Float32Array(MAX_PARAMS);
  private paramsDirty = true;
  private outputs: Tex[][] = [];
  private frame = 0;
  private seenCam = -1;
  private stampChars = new Uint32Array(STAMP_MAX);
  private stampCount = 0;
  private copy: OffscreenCanvasRenderingContext2D | null = null;

  constructor(
    private e: GlEngine,
    readonly canvas: OffscreenCanvas,
    /** Thumbnails copy their picture into this canvas; the viewfinder is the GL canvas itself. */
    private thumb: boolean,
  ) {
    const gl = e.gl;
    this.globals = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.globals);
    gl.bufferData(gl.UNIFORM_BUFFER, 32, gl.DYNAMIC_DRAW);
    this.params = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.params);
    gl.bufferData(gl.UNIFORM_BUFFER, MAX_PARAMS * 4, gl.DYNAMIC_DRAW);
    if (thumb) this.copy = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    this.resize(canvas.width, canvas.height);
  }

  get size(): [number, number] {
    return [this.canvas.width, this.canvas.height];
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    for (const pair of this.outputs) for (const t of pair) this.e.gl.deleteTexture(t.tex);
    this.outputs = OUTPUTS.map(() => [0, 1].map(() => this.e.makeTexture(width, height)));
    this.updateCamFit();
    if (this.effect) this.allocateTemps(this.effect);
  }

  setEffect(loaded: LoadedEffect) {
    const old = this.effect;
    this.allocateTemps(loaded);
    this.effect = loaded;
    if (old) for (const t of old.temps.values()) this.e.gl.deleteTexture(t.tex);
    this.paramsData.set(loaded.compiled.values);
    this.paramsDirty = true;
    this.seenCam = -1;
    // clear feedback so the new effect starts clean
    for (const pair of this.outputs) for (const t of pair) this.e.clear(t);
  }

  setStampText(text: string) {
    const codes = stampCodes(text).slice(0, STAMP_MAX);
    this.stampChars.fill(0);
    this.stampChars.set(codes);
    this.stampCount = codes.length;
  }

  setParam(slot: number, value: number) {
    this.paramsData[slot] = value;
    this.paramsDirty = true;
  }

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
  }

  encode(time: number, dt: number) {
    const eff = this.effect;
    if (!eff) return;
    const gl = this.e.gl;
    const g = this.globalsData;
    g[0] = time;
    g[1] = dt;
    g[7] = this.e.camVersion !== this.seenCam ? 1 : 0;
    this.seenCam = this.e.camVersion;
    const skip = eff.graph.ticked === true && g[7] < 0.5 && this.frame > 0;
    if (!skip) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.globals);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, g);
      if (this.paramsDirty) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.params);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.paramsData);
        this.paramsDirty = false;
      }
      this.runPasses(eff);
    }

    const xerox = this.xeroxFrames > 0 ? 1 : 0;
    if (this.xeroxFrames > 0) this.xeroxFrames--;
    const displayIndex = OUTPUTS.indexOf(eff.compiled.display);
    // after a skipped frame the last one written is the other parity
    const parity = this.frame & 1;
    this.present(this.outputs[displayIndex][skip ? parity ^ 1 : parity], xerox);
    if (!skip) this.frame++;
  }

  passCount() {
    return (this.effect?.compiled.passes.length ?? 0) + 1;
  }

  destroy() {
    const gl = this.e.gl;
    for (const pair of this.outputs) for (const t of pair) gl.deleteTexture(t.tex);
    if (this.effect) for (const t of this.effect.temps.values()) gl.deleteTexture(t.tex);
    gl.deleteBuffer(this.globals);
    gl.deleteBuffer(this.params);
  }

  private runPasses(eff: LoadedEffect) {
    const gl = this.e.gl;
    const parity = this.frame & 1;
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.globals);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.params);
    // reads of o0…o3 always see the previous frame: the texture not written this frame
    this.e.bind(1, this.outputs[0][parity ^ 1].tex);
    this.e.bind(2, this.outputs[1][parity ^ 1].tex);
    this.e.bind(3, this.outputs[2][parity ^ 1].tex);
    this.e.bind(4, this.outputs[3][parity ^ 1].tex);
    this.e.bind(0, this.e.cam.tex);
    this.e.bind(5, this.e.glyphs);
    eff.compiled.passes.forEach((p, i) => {
      const target = p.target.kind === 'output' ? this.outputs[OUTPUTS.indexOf(p.target.id)][parity] : eff.temps.get(p.target.id)!;
      for (let k = 0; k < MAX_PASS_INPUTS; k++) this.e.bind(INPUT_UNIT + k, p.inputs[k] ? eff.temps.get(p.inputs[k])!.tex : this.e.dummy);
      const prog = eff.programs[i];
      gl.useProgram(prog.program);
      this.e.target(target);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
  }

  private present(src: Tex, xerox: number) {
    const gl = this.e.gl;
    const [W, H] = this.size;
    const u = this.e.presentLocs;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.e.presentProgram);
    this.e.bind(0, src.tex);
    this.e.bind(1, this.e.stampFont);
    gl.uniform1i(u.src, 0);
    gl.uniform1i(u.font, 1);
    gl.uniform1f(u.xerox, xerox);
    gl.uniform1f(u.ramp, HOUSE.ramp);
    gl.uniform1f(u.levels, HOUSE.levels);
    gl.uniform1f(u.dither, H < 300 ? 1 : HOUSE.dither);
    gl.uniform1f(u.stamp, this.stamp ? 1 : 0);
    gl.uniform1f(u.count, this.stampCount);
    gl.uniform1f(u.cellH, Math.max(8, Math.round(H * 0.022)));
    gl.uniform1f(u.mode, this.e.grade);
    gl.uniform1uiv(u.chars, this.stampChars);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.thumb) {
      // it was drawn in the bottom-left corner of the main canvas: copy it out
      this.copy!.drawImage(this.e.canvas, 0, this.e.canvas.height - H, W, H, 0, 0, W, H);
    }
  }

  allocateTemps(eff: LoadedEffect) {
    for (const t of eff.temps.values()) this.e.gl.deleteTexture(t.tex);
    eff.temps.clear();
    const [W, H] = this.size;
    for (const t of eff.compiled.temps) {
      eff.temps.set(t.id, this.e.makeTexture(Math.max(2, Math.round(W * t.scale)), Math.max(2, Math.round(H * t.scale))));
    }
  }
}

export class GlEngine implements Renderer {
  readonly mode = 'gl' as const;
  readonly compute = false;
  readonly gl: WebGL2RenderingContext;
  readonly main: GlStage;
  readonly dummy: WebGLTexture;
  readonly glyphs: WebGLTexture;
  readonly stampFont: WebGLTexture;
  readonly presentProgram: WebGLProgram;
  readonly presentLocs: Record<'src' | 'font' | 'xerox' | 'ramp' | 'levels' | 'dither' | 'stamp' | 'count' | 'cellH' | 'mode' | 'chars', WebGLUniformLocation | null>;

  cam: Tex;
  camSize: [number, number] = [0, 0];
  mirror = false;
  zoom = 1;
  camVersion = 0;
  grade = 0;
  onError: (message: string) => void = () => {};

  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private halfFloat: boolean;
  private testProgram: WebGLProgram;
  private testLocs: { time: WebGLUniformLocation | null; res: WebGLUniformLocation | null };
  private testDivider = 1;
  private testFrame = 0;
  private thumbs = new Map<string, GlStage>();
  private thumbOrder: string[] = [];
  private thumbCursor = 0;
  private programs = new Map<string, Promise<Program>>();
  private frame = 0;
  private bound = new Map<number, WebGLTexture | null>();

  private constructor(readonly canvas: OffscreenCanvas, gl: WebGL2RenderingContext, glyphs: HTMLCanvasLike, stampFont: HTMLCanvasLike) {
    this.gl = gl;
    // float render targets keep feedback precise (values go above 1); 8 bit is the fallback
    this.halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.fbo = gl.createFramebuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.dummy = this.makeTexture(1, 1).tex;
    this.glyphs = this.imageTexture(glyphs);
    this.stampFont = this.imageTexture(stampFont);
    this.cam = this.makeCamTexture(16, 16);

    this.presentProgram = this.link(VERTEX, PRESENT);
    gl.useProgram(this.presentProgram);
    const loc = (n: string) => gl.getUniformLocation(this.presentProgram, n);
    this.presentLocs = {
      src: loc('src'), font: loc('font'), xerox: loc('uXerox'), ramp: loc('uRamp'), levels: loc('uLevels'), dither: loc('uDither'),
      stamp: loc('uStamp'), count: loc('uCount'), cellH: loc('uCellH'), mode: loc('uMode'), chars: loc('uChars'),
    };
    this.testProgram = this.link(VERTEX, TESTCARD);
    this.testLocs = { time: gl.getUniformLocation(this.testProgram, 'uTime'), res: gl.getUniformLocation(this.testProgram, 'uRes') };

    this.main = new GlStage(this, canvas, false);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onError('GPU PERDIDA: contexto WebGL perdido');
    });
  }

  static async create(canvas: OffscreenCanvas): Promise<GlEngine> {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('SIN WEBGL2');
    const [glyphs, stampFont] = await Promise.all([GlEngine.atlas(buildGlyphAtlas), GlEngine.atlas(buildStampAtlas)]);
    return new GlEngine(canvas, gl, glyphs, stampFont);
  }

  private static async atlas(build: () => Promise<OffscreenCanvas>): Promise<HTMLCanvasLike> {
    try {
      return await build();
    } catch {
      // no atlas: LETRA / the stamp draw nothing instead of failing the whole engine
      return new OffscreenCanvas(1, 1);
    }
  }

  // ---- shared GL helpers (used by the stages)

  makeTexture(w: number, h: number): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.sampling(gl.LINEAR);
    this.bound.clear();
    return { tex, w, h };
  }

  private sampling(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private imageTexture(source: HTMLCanvasLike): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    this.sampling(gl.LINEAR);
    return tex;
  }

  private makeCamTexture(w: number, h: number): Tex {
    const gl = this.gl;
    this.camSize = [w, h];
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.sampling(gl.LINEAR);
    this.bound.clear();
    return { tex, w, h };
  }

  bind(unit: number, tex: WebGLTexture) {
    // the same texture often stays bound across passes
    if (this.bound.get(unit) === tex) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.bound.set(unit, tex);
  }

  /** Render into `t` (viewport and framebuffer). */
  target(t: Tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.viewport(0, 0, t.w, t.h);
  }

  clear(t: Tex) {
    const gl = this.gl;
    this.target(t);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? '';
      const lines = source.split('\n');
      // "ERROR: 0:123: message": show the offending line
      const where = /0:(\d+)/.exec(log);
      const line = where ? `\n  ${lines[Number(where[1]) - 1] ?? ''}` : '';
      gl.deleteShader(s);
      throw new Error(`GLSL: ${log.trim().split('\n')[0]}${line}`);
    }
    return s;
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, this.shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, this.shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`GLSL link: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  /** The fragment shader of a compiled pass; exposed for tests. */
  static fragmentSource(p: CompiledPass): string {
    return `${FRAGMENT_HEADER}\n${wgslToGlsl(p.body)}\nvoid main() {\n  FC = gl_FragCoord.xy;\n  fragColor = clamp(${p.call.replaceAll('in.uv', 'vUV')}, vec4(0.0), vec4(64.0));\n}\n`;
  }

  /** Programs are cached by source; compiled one per task so a gallery of effects does not freeze the page. */
  private program(p: CompiledPass): Promise<Program> {
    const source = GlEngine.fragmentSource(p);
    let cached = this.programs.get(source);
    if (!cached) {
      cached = new Promise<Program>((resolve, reject) => {
        setTimeout(() => {
          try {
            const gl = this.gl;
            const program = this.link(VERTEX, source);
            gl.useProgram(program);
            for (const [name, unit] of UNITS) gl.uniform1i(gl.getUniformLocation(program, name), unit);
            const globals = gl.getUniformBlockIndex(program, 'Globals');
            const params = gl.getUniformBlockIndex(program, 'Params');
            if (globals !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, globals, 0);
            if (params !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, params, 1);
            resolve({ program, globals, params });
          } catch (e) {
            reject(e);
          }
        }, 0);
      });
      cached.catch(() => this.programs.delete(source));
      this.programs.set(source, cached);
    }
    return cached;
  }

  // ---- Renderer

  resize(width: number, height: number) {
    this.main.resize(width, height);
  }

  uploadFrame(frame: VideoFrame, mirror: boolean) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const gl = this.gl;
    try {
      if (w !== this.camSize[0] || h !== this.camSize[1]) {
        gl.deleteTexture(this.cam.tex);
        this.cam = this.makeCamTexture(w, h);
        this.forEachStage((s) => s.updateCamFit());
      }
      if (mirror !== this.mirror) {
        this.mirror = mirror;
        this.forEachStage((s) => s.updateCamFit());
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.cam.tex);
      this.bound.set(0, this.cam.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame as unknown as TexImageSource);
      this.camVersion++;
    } finally {
      frame.close();
    }
  }

  setTestCamFps(fps: number) {
    this.testDivider = fps > 0 ? Math.max(1, Math.round(60 / fps)) : 1;
  }

  renderTestCard(time: number) {
    const [w, h] = [720, 1280];
    const resized = this.camSize[0] !== w || this.camSize[1] !== h;
    if (!resized && this.testFrame++ % this.testDivider !== 0) return;
    const gl = this.gl;
    if (resized) {
      this.mirror = false;
      gl.deleteTexture(this.cam.tex);
      this.cam = this.makeCamTexture(w, h);
      this.forEachStage((s) => s.updateCamFit());
    }
    this.target(this.cam);
    gl.useProgram(this.testProgram);
    gl.uniform1f(this.testLocs.time, time);
    gl.uniform2f(this.testLocs.res, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.camVersion++;
  }

  async setEffect(graph: EffectGraph) {
    const loaded = await this.load(graph);
    this.main.setEffect(loaded);
    this.main.xeroxFrames = 5;
    return loaded.compiled;
  }

  async addThumb(id: string, canvas: OffscreenCanvas, graph: EffectGraph) {
    const loaded = await this.load(graph);
    this.thumbs.get(id)?.destroy();
    const stage = new GlStage(this, canvas, true);
    stage.setEffect(loaded);
    this.thumbs.set(id, stage);
    this.thumbOrder = [...this.thumbs.keys()];
  }

  setParam(slot: number, value: number) {
    this.main.setParam(slot, value);
  }

  setGrade(mode: number) {
    this.grade = mode === 1 ? 1 : 0;
  }

  setZoom(zoom: number) {
    this.zoom = Math.max(1, zoom);
    this.forEachStage((s) => s.updateCamFit());
  }

  /** Renders, round-robin, one thumbnail, then the viewfinder (the thumbnail borrows the canvas corner first). */
  render(time: number, dt: number) {
    if (!this.main.effect) return;
    if (this.thumbOrder.length) {
      const id = this.thumbOrder[this.thumbCursor++ % this.thumbOrder.length];
      const t = this.thumbs.get(id)!;
      t.encode(time, t.lastTime ? time - t.lastTime : dt);
      t.lastTime = time;
    }
    this.main.encode(time, dt);
    this.frame++;
  }

  stats(): EngineStats {
    const [width, height] = this.main.size;
    return { width, height, passes: this.main.passCount(), gpuMs: null };
  }

  private async load(graph: EffectGraph): Promise<LoadedEffect> {
    const compiled = compileEffect(graph);
    if (compiled.passes.some((p) => !p.body)) throw new Error('EFECTO SOLO WEBGPU');
    const programs: Program[] = [];
    for (const p of compiled.passes) programs.push(await this.program(p));
    return { graph, compiled, programs, temps: new Map() };
  }

  private forEachStage(fn: (s: GlStage) => void) {
    fn(this.main);
    for (const s of this.thumbs.values()) fn(s);
  }
}

type HTMLCanvasLike = OffscreenCanvas;
