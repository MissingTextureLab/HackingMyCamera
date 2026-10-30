// Op library. Each op is a small WGSL function; the compiler fuses chains of
// them into one fragment shader (Hydra-style) — see PLAN.md §1.
//
// Signatures by kind (the compiler relies on these):
//   source        fn op_<name>(uv: vec2f, ...params: f32) -> vec4f
//   coord         fn op_<name>(uv: vec2f, ...params) -> vec2f
//   color         fn op_<name>(c: vec4f, ...params) -> vec4f
//   combine       fn op_<name>(a: vec4f, b: vec4f, ...params) -> vec4f
//   combineCoord  fn op_<name>(uv: vec2f, c: vec4f, ...params) -> vec2f
//   texture       no snippet: the compiler samples a texture directly
//   filter        needs its inputs as textures (neighbourhood reads). Runs as
//                 its own pass(es); each pass defines
//                 fn PASS(uv: vec2f, ...params) -> vec4f
//                 reading its inputs as T0, T1 (see FILTER_PRELUDE).
//   render3d      draws geometry with depth into its own texture; reads its
//                 input image as T0 (also in the vertex stage). Params are
//                 read through generated accessors p_<name>(). See SCENE_PRELUDE.
//   processor     a compute shader writing its own texture (OpDef.compute).
//
// Module-scope names available to snippets: G (globals: time, dt, res, camFit),
// FC (fragment coordinate in pixels), PI, TAU, hash3, vnoise, luma,
// rgb2hsv, hsv2rgb, bayer4, CITRINK.
//
// No code here is taken from hydra-synth (AGPL); only op names and ideas.

export type OpKind = 'source' | 'coord' | 'color' | 'combine' | 'combineCoord' | 'texture' | 'filter' | 'render3d' | 'processor';

/** One draw call of a 3D scene: entry points and how many vertices (no vertex buffers). */
export interface SceneDraw {
  vs: string;
  fs: string;
  count: number;
}

export interface FilterPass {
  /** What T0, T1… are: the op's inputs ('in0', 'in1') or earlier passes ('p0'…). */
  inputs: string[];
  /** Resolution relative to the output. */
  scale?: number;
  wgsl: string;
}

export interface ParamDef {
  name: string;
  default: number;
  /** Baked into the shader instead of a uniform (e.g. which buffer to read). */
  structural?: boolean;
}

export interface OpDef {
  name: string;
  kind: OpKind;
  params: ParamDef[];
  wgsl?: string;
  /** filter only: number of image inputs */
  inputs?: number;
  /** filter only: the passes, in order; the last one is the op's result */
  passes?: FilterPass[];
  /** render3d only: WGSL with the entry points, and the draws, in order */
  scene?: { wgsl: string; draws: SceneDraw[] };
  /**
   * processor only: a compute shader with entry point `main`, dispatched with
   * one workgroup per output column. Reads its input as T0 (any size, through
   * `samp`), writes OUT, params via p_<name>(). See COMPUTE_HEADER.
   */
  compute?: { wgsl: string; scale?: number };
}

/** Number of inputs a node of this op must have. */
export function arity(def: OpDef): number {
  switch (def.kind) {
    case 'texture':
    case 'source':
      return 0;
    case 'combine':
    case 'combineCoord':
      return 2;
    case 'filter':
      return def.inputs ?? 1;
    case 'render3d':
    case 'processor':
      return 1;
    default:
      return 1;
  }
}

const p = (name: string, def: number, structural = false): ParamDef => ({ name, default: def, structural });

export const OPS: Record<string, OpDef> = {};
function def(op: OpDef) {
  OPS[op.name] = op;
}

/* ---------- textures ---------- */

def({ name: 'camera', kind: 'texture', params: [] });
def({ name: 'buffer', kind: 'texture', params: [p('index', 0, true)] });

/* ---------- sources ---------- */

def({
  name: 'osc',
  kind: 'source',
  params: [p('frequency', 60), p('sync', 0.1), p('offset', 0)],
  wgsl: /* wgsl */ `
fn op_osc(uv: vec2f, frequency: f32, sync: f32, offset: f32) -> vec4f {
  let ph = uv.x * frequency + G.time * sync * TAU;
  return vec4f(sin(ph - offset) * 0.5 + 0.5, sin(ph) * 0.5 + 0.5, sin(ph + offset) * 0.5 + 0.5, 1.0);
}`,
});

def({
  name: 'noise',
  kind: 'source',
  params: [p('scale', 10), p('speed', 0.1)],
  wgsl: /* wgsl */ `
fn op_noise(uv: vec2f, scale: f32, speed: f32) -> vec4f {
  let q = vec3f(uv * scale, G.time * speed * 4.0);
  let n = vnoise(q) * 0.65 + vnoise(q * 2.03 + 17.0) * 0.35;
  return vec4f(vec3f(n), 1.0);
}`,
});

def({
  name: 'voronoi',
  kind: 'source',
  params: [p('scale', 5), p('speed', 0.3), p('blending', 0.3)],
  wgsl: /* wgsl */ `
fn op_voronoi(uv: vec2f, scale: f32, speed: f32, blending: f32) -> vec4f {
  let asp = G.res.x / G.res.y;
  let q = vec2f(uv.x * asp, uv.y) * scale;
  let cell = floor(q);
  let f = fract(q);
  var best = 8.0;
  var id = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let h = vec2f(hash3(vec3f(cell + g, 1.7)), hash3(vec3f(cell + g, 9.3)));
      let o = 0.5 + 0.5 * sin(G.time * speed + TAU * h);
      let d = length(g + o - f);
      if (d < best) { best = d; id = h; }
    }
  }
  return vec4f(mix(vec3f(best), vec3f(id, best), blending), 1.0);
}`,
});

def({
  name: 'shape',
  kind: 'source',
  params: [p('sides', 3), p('radius', 0.3), p('smoothing', 0.01)],
  wgsl: /* wgsl */ `
fn op_shape(uv: vec2f, sides: f32, radius: f32, smoothing: f32) -> vec4f {
  var q = (uv - 0.5) * 2.0;
  q.x *= G.res.x / G.res.y;
  let n = max(floor(sides), 3.0);
  let seg = TAU / n;
  let a = atan2(q.x, q.y) + PI;
  let d = cos(floor(0.5 + a / seg) * seg - a) * length(q);
  let v = 1.0 - smoothstep(radius, radius + smoothing + 0.0001, d);
  return vec4f(vec3f(v), 1.0);
}`,
});

def({
  name: 'gradient',
  kind: 'source',
  params: [p('speed', 0)],
  wgsl: /* wgsl */ `
fn op_gradient(uv: vec2f, speed: f32) -> vec4f {
  return vec4f(uv, sin(G.time * speed) * 0.5 + 0.5, 1.0);
}`,
});

def({
  name: 'solid',
  kind: 'source',
  params: [p('r', 0), p('g', 0), p('b', 0)],
  wgsl: /* wgsl */ `
fn op_solid(uv: vec2f, r: f32, g: f32, b: f32) -> vec4f {
  return vec4f(r, g, b, 1.0);
}`,
});

/* ---------- coordinates ---------- */

def({
  name: 'rotate',
  kind: 'coord',
  params: [p('angle', 0), p('speed', 0)],
  wgsl: /* wgsl */ `
fn op_rotate(uv: vec2f, angle: f32, speed: f32) -> vec2f {
  let asp = G.res.x / G.res.y;
  let a = angle + G.time * speed;
  var q = uv - 0.5;
  q.x *= asp;
  q = vec2f(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y);
  q.x /= asp;
  return q + 0.5;
}`,
});

def({
  name: 'scale',
  kind: 'coord',
  params: [p('amount', 1.5), p('xMult', 1), p('yMult', 1), p('offsetX', 0.5), p('offsetY', 0.5)],
  wgsl: /* wgsl */ `
fn op_scale(uv: vec2f, amount: f32, xMult: f32, yMult: f32, offsetX: f32, offsetY: f32) -> vec2f {
  let o = vec2f(offsetX, offsetY);
  return (uv - o) / max(abs(amount * vec2f(xMult, yMult)), vec2f(0.0001)) * sign(amount) + o;
}`,
});

def({
  name: 'pixelate',
  kind: 'coord',
  params: [p('pixelX', 20), p('pixelY', 20)],
  wgsl: /* wgsl */ `
fn op_pixelate(uv: vec2f, pixelX: f32, pixelY: f32) -> vec2f {
  let n = max(vec2f(pixelX, pixelY), vec2f(1.0));
  return (floor(uv * n) + 0.5) / n;
}`,
});

def({
  name: 'kaleid',
  kind: 'coord',
  params: [p('sides', 4)],
  wgsl: /* wgsl */ `
fn op_kaleid(uv: vec2f, sides: f32) -> vec2f {
  let asp = G.res.x / G.res.y;
  var q = uv - 0.5;
  q.x *= asp;
  let seg = TAU / max(sides, 1.0);
  var a = atan2(q.y, q.x);
  a = abs((a - seg * floor(a / seg)) - seg * 0.5);
  var r = vec2f(cos(a), sin(a)) * length(q);
  r.x /= asp;
  return r + 0.5;
}`,
});

def({
  name: 'scroll',
  kind: 'coord',
  params: [p('x', 0), p('y', 0), p('speedX', 0), p('speedY', 0)],
  wgsl: /* wgsl */ `
fn op_scroll(uv: vec2f, x: f32, y: f32, speedX: f32, speedY: f32) -> vec2f {
  return fract(uv + vec2f(x + G.time * speedX, y + G.time * speedY));
}`,
});

def({
  name: 'repeat',
  kind: 'coord',
  params: [p('x', 3), p('y', 3)],
  wgsl: /* wgsl */ `
fn op_repeat(uv: vec2f, x: f32, y: f32) -> vec2f {
  return fract(uv * vec2f(x, y));
}`,
});

/* ---------- color ---------- */

def({
  name: 'hue',
  kind: 'color',
  params: [p('amount', 0.4)],
  wgsl: /* wgsl */ `
fn op_hue(c: vec4f, amount: f32) -> vec4f {
  var h = rgb2hsv(c.rgb);
  h.x = fract(h.x + amount);
  return vec4f(hsv2rgb(h), c.a);
}`,
});

def({
  name: 'posterize',
  kind: 'color',
  params: [p('bins', 3), p('gamma', 0.6)],
  wgsl: /* wgsl */ `
fn op_posterize(c: vec4f, bins: f32, gamma: f32) -> vec4f {
  let g = max(gamma, 0.01);
  let b = max(bins, 1.0);
  return vec4f(pow(floor(pow(max(c.rgb, vec3f(0.0)), vec3f(g)) * b) / b, vec3f(1.0 / g)), c.a);
}`,
});

def({
  name: 'contrast',
  kind: 'color',
  params: [p('amount', 1.6)],
  wgsl: /* wgsl */ `
fn op_contrast(c: vec4f, amount: f32) -> vec4f {
  return vec4f((c.rgb - 0.5) * amount + 0.5, c.a);
}`,
});

def({
  name: 'brightness',
  kind: 'color',
  params: [p('amount', 0.2)],
  wgsl: /* wgsl */ `
fn op_brightness(c: vec4f, amount: f32) -> vec4f {
  return vec4f(c.rgb + amount, c.a);
}`,
});

def({
  name: 'gain',
  kind: 'color',
  params: [p('amount', 0.9)],
  wgsl: /* wgsl */ `
fn op_gain(c: vec4f, amount: f32) -> vec4f {
  return vec4f(c.rgb * amount, c.a);
}`,
});

def({
  name: 'invert',
  kind: 'color',
  params: [p('amount', 1)],
  wgsl: /* wgsl */ `
fn op_invert(c: vec4f, amount: f32) -> vec4f {
  return vec4f(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
}`,
});

def({
  name: 'thresh',
  kind: 'color',
  params: [p('threshold', 0.5), p('tolerance', 0.04)],
  wgsl: /* wgsl */ `
fn op_thresh(c: vec4f, threshold: f32, tolerance: f32) -> vec4f {
  return vec4f(vec3f(smoothstep(threshold - tolerance, threshold + tolerance, luma(c.rgb))), c.a);
}`,
});

// Maps luminance onto the eight Citrink colours, optionally with an ordered
// dither at `scale` pixels per cell. `cycle` rotates the ramp.
def({
  name: 'citrink',
  kind: 'color',
  params: [p('amount', 1), p('dither', 0), p('cycle', 0), p('scale', 1)],
  wgsl: /* wgsl */ `
fn op_citrink(c: vec4f, amount: f32, dither: f32, cycle: f32, scale: f32) -> vec4f {
  let l = clamp(luma(c.rgb), 0.0, 1.0);
  let d = (bayer4(floor(FC / max(scale, 1.0))) - 0.5) * dither / 7.0;
  let k = i32(floor(clamp(l + d, 0.0, 0.9999) * 8.0));
  let idx = u32((k + i32(floor(cycle))) % 8 + 8) % 8u;
  return vec4f(mix(c.rgb, CITRINK[idx], amount), c.a);
}`,
});

/* ---------- combine ---------- */

def({
  name: 'blend',
  kind: 'combine',
  params: [p('amount', 0.5)],
  wgsl: /* wgsl */ `
fn op_blend(a: vec4f, b: vec4f, amount: f32) -> vec4f {
  return mix(a, b, amount);
}`,
});

def({
  name: 'add',
  kind: 'combine',
  params: [p('amount', 1)],
  wgsl: /* wgsl */ `
fn op_add(a: vec4f, b: vec4f, amount: f32) -> vec4f {
  return vec4f(a.rgb + b.rgb * amount, a.a);
}`,
});

def({
  name: 'mult',
  kind: 'combine',
  params: [p('amount', 1)],
  wgsl: /* wgsl */ `
fn op_mult(a: vec4f, b: vec4f, amount: f32) -> vec4f {
  return vec4f(a.rgb * mix(vec3f(1.0), b.rgb, amount), a.a);
}`,
});

def({
  name: 'lighten',
  kind: 'combine',
  params: [p('amount', 1)],
  wgsl: /* wgsl */ `
fn op_lighten(a: vec4f, b: vec4f, amount: f32) -> vec4f {
  return vec4f(max(a.rgb, b.rgb * amount), a.a);
}`,
});

def({
  name: 'diff',
  kind: 'combine',
  params: [],
  wgsl: /* wgsl */ `
fn op_diff(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(abs(a.rgb - b.rgb), 1.0);
}`,
});

/* ---------- modulation (coordinates driven by another texture) ---------- */

def({
  name: 'modulate',
  kind: 'combineCoord',
  params: [p('amount', 0.1)],
  wgsl: /* wgsl */ `
fn op_modulate(uv: vec2f, c: vec4f, amount: f32) -> vec2f {
  return uv + (c.rg - 0.5) * 2.0 * amount;
}`,
});

def({
  name: 'modulateScale',
  kind: 'combineCoord',
  params: [p('multiple', 1), p('offset', 1)],
  wgsl: /* wgsl */ `
fn op_modulateScale(uv: vec2f, c: vec4f, multiple: f32, offset: f32) -> vec2f {
  return (uv - 0.5) / max(offset + multiple * c.r, 0.0001) + 0.5;
}`,
});

def({
  name: 'modulateRotate',
  kind: 'combineCoord',
  params: [p('multiple', 1), p('offset', 0)],
  wgsl: /* wgsl */ `
fn op_modulateRotate(uv: vec2f, c: vec4f, multiple: f32, offset: f32) -> vec2f {
  return op_rotate(uv, offset + c.r * multiple, 0.0);
}`,
});

/* ---------- filters (neighbourhood; each runs as its own pass) ---------- */

// Blur runs at half resolution: a quarter of the pixels, and a blurred image
// loses nothing. `radius` stays in output pixels (half-res texels are 2 px).
const BLUR_H = /* wgsl */ `
fn PASS(uv: vec2f, radius: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  return gauss9(T0, uv, vec2f(px.x * radius * 0.125, 0.0));
}`;
const BLUR_V = /* wgsl */ `
fn PASS(uv: vec2f, radius: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  return gauss9(T0, uv, vec2f(0.0, px.y * radius * 0.125));
}`;

def({
  name: 'blur',
  kind: 'filter',
  params: [p('radius', 6)],
  passes: [
    { inputs: ['in0'], scale: 0.5, wgsl: BLUR_H },
    { inputs: ['p0'], scale: 0.5, wgsl: BLUR_V },
  ],
});

def({
  name: 'edge',
  kind: 'filter',
  params: [p('strength', 1.5)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, strength: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  let tl = lumaAt(T0, uv + px * vec2f(-1.0, -1.0));
  let tc = lumaAt(T0, uv + px * vec2f(0.0, -1.0));
  let tr = lumaAt(T0, uv + px * vec2f(1.0, -1.0));
  let ml = lumaAt(T0, uv + px * vec2f(-1.0, 0.0));
  let mr = lumaAt(T0, uv + px * vec2f(1.0, 0.0));
  let bl = lumaAt(T0, uv + px * vec2f(-1.0, 1.0));
  let bc = lumaAt(T0, uv + px * vec2f(0.0, 1.0));
  let br = lumaAt(T0, uv + px * vec2f(1.0, 1.0));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  return vec4f(vec3f(clamp(length(vec2f(gx, gy)) * strength, 0.0, 1.0)), 1.0);
}`,
    },
  ],
});

def({
  name: 'sharpen',
  kind: 'filter',
  params: [p('amount', 1)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, amount: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  let c = textureSampleLevel(T0, samp, uv, 0.0);
  let n = textureSampleLevel(T0, samp, uv + vec2f(0.0, -px.y), 0.0)
        + textureSampleLevel(T0, samp, uv + vec2f(0.0, px.y), 0.0)
        + textureSampleLevel(T0, samp, uv + vec2f(-px.x, 0.0), 0.0)
        + textureSampleLevel(T0, samp, uv + vec2f(px.x, 0.0), 0.0);
  return vec4f(c.rgb + (c.rgb * 4.0 - n.rgb) * amount, c.a);
}`,
    },
  ],
});

// TouchDesigner-style Displace: the second input is a height map; the image
// slides along the map's luminance gradient.
def({
  name: 'displace',
  kind: 'filter',
  inputs: 2,
  params: [p('amount', 1)],
  passes: [
    {
      inputs: ['in0', 'in1'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, amount: f32) -> vec4f {
  let px = 2.0 / vec2f(textureDimensions(T1));
  let g = vec2f(
    lumaAt(T1, uv + vec2f(px.x, 0.0)) - lumaAt(T1, uv - vec2f(px.x, 0.0)),
    lumaAt(T1, uv + vec2f(0.0, px.y)) - lumaAt(T1, uv - vec2f(0.0, px.y))) / (2.0 * px);
  return textureSampleLevel(T0, samp, uv - g * amount * 0.01, 0.0);
}`,
    },
  ],
});

// Bright pass + half-resolution separable blur, added back on top.
def({
  name: 'bloom',
  kind: 'filter',
  params: [p('threshold', 0.6), p('intensity', 1.2), p('radius', 8)],
  passes: [
    {
      inputs: ['in0'],
      scale: 0.5,
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, intensity: f32, radius: f32) -> vec4f {
  let c = textureSampleLevel(T0, samp, uv, 0.0);
  return vec4f(c.rgb * smoothstep(threshold, threshold + 0.15, luma(c.rgb)), 1.0);
}`,
    },
    {
      inputs: ['p0'],
      scale: 0.5,
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, intensity: f32, radius: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  return gauss9(T0, uv, vec2f(px.x * radius * 0.25, 0.0));
}`,
    },
    {
      inputs: ['p1'],
      scale: 0.5,
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, intensity: f32, radius: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  return gauss9(T0, uv, vec2f(0.0, px.y * radius * 0.25));
}`,
    },
    {
      inputs: ['in0', 'p2'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, intensity: f32, radius: f32) -> vec4f {
  let c = textureSampleLevel(T0, samp, uv, 0.0);
  let b = textureSampleLevel(T1, samp, uv, 0.0);
  return vec4f(c.rgb + b.rgb * intensity, c.a);
}`,
    },
  ],
});

// Print: halftone in two Citrink inks on white paper. Each plate is a screen
// at its own angle; the second plate is out of register by offset + jolt px.
// screen 0-2: dots, lines or cross-hatch; pair 0-3: which two inks.
def({
  name: 'riso',
  kind: 'filter',
  params: [p('offset', 3), p('cell', 7), p('gain', 1.1), p('screen', 0), p('pair', 0), p('jolt', 0)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
// ink pairs as CITRINK indices: first plate (shadows), second plate
var<private> INK_A: array<u32, 4> = array<u32, 4>(2u, 3u, 1u, 0u);
var<private> INK_B: array<u32, 4> = array<u32, 4>(5u, 6u, 4u, 6u);

fn cellInk(local: vec2f, ink: f32, screen: u32) -> f32 {
  let aa = 0.06;
  if (screen == 1u) {
    let half = ink * 0.5;
    return 1.0 - smoothstep(half - aa, half + aa, abs(local.y));
  }
  if (screen == 2u) {
    let half = ink * 0.32;
    return 1.0 - smoothstep(half - aa, half + aa, min(abs(local.x), abs(local.y)));
  }
  let radius = sqrt(ink) * 0.62;
  return 1.0 - smoothstep(radius - aa, radius + aa, length(local));
}

fn plate(pix: vec2f, cell: f32, angle: f32, gain: f32, screen: u32) -> f32 {
  let res = vec2f(textureDimensions(T0));
  let c = cos(angle);
  let s = sin(angle);
  let r = vec2f(c * pix.x + s * pix.y, -s * pix.x + c * pix.y) / cell;
  let cp = (floor(r) + 0.5) * cell;
  let centre = vec2f(c * cp.x - s * cp.y, s * cp.x + c * cp.y);
  let ink = clamp((1.0 - lumaAt(T0, centre / res)) * gain, 0.0, 1.0);
  return cellInk(fract(r) - 0.5, ink, screen);
}

fn PASS(uv: vec2f, offset: f32, cell: f32, gain: f32, screenF: f32, pairF: f32, jolt: f32) -> vec4f {
  let screen = u32(clamp(floor(screenF), 0.0, 2.0));
  let pair = u32(clamp(floor(pairF), 0.0, 3.0));
  let cs = max(cell, 2.0);
  let off = offset + jolt;
  let a = plate(FC, cs, 0.2618, gain, screen);
  let b = plate(FC + vec2f(off, off * 0.6), cs, 1.309, gain * 0.85, screen);
  var paper = vec3f(1.0);
  paper *= mix(vec3f(1.0), CITRINK[INK_A[pair]], a);
  paper *= mix(vec3f(1.0), CITRINK[INK_B[pair]], b);
  return vec4f(paper, 1.0);
}`,
    },
  ],
});

// Symmetry: facing mirrors. The previous frame, shrunk by `scale`, turned by
// `angle` and mirrored, sits inside a thin acid frame on top of the live image;
// feeding back, it nests forever. in0 = the camera, in1 = the previous frame.
def({
  name: 'abyss',
  kind: 'filter',
  inputs: 2,
  params: [p('scale', 0.78), p('angle', 0), p('shift', 0)],
  passes: [
    {
      inputs: ['in0', 'in1'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, scale: f32, angle: f32, shift: f32) -> vec4f {
  let asp = G.res.x / G.res.y;
  let k = clamp(scale, 0.05, 0.98);
  var q = uv - vec2f(0.5 + shift, 0.5);
  q.x *= asp;
  let c = cos(angle);
  let s = sin(angle);
  q = vec2f(c * q.x + s * q.y, -s * q.x + c * q.y) / k;
  q.x /= asp;
  let inner = q + 0.5;
  if (all(inner > vec2f(0.0)) && all(inner < vec2f(1.0))) {
    let edge = min(min(inner.x, 1.0 - inner.x), min(inner.y, 1.0 - inner.y));
    if (edge < 0.012 / k) {
      return vec4f(CITRINK[5], 1.0);
    }
    // each reflection is mirrored, like a mirror facing a mirror
    return textureSampleLevel(T1, samp, vec2f(1.0 - inner.x, inner.y), 0.0);
  }
  return textureSampleLevel(T0, samp, uv, 0.0);
}`,
    },
  ],
});

// Time: slit-scan. Past the line the live image; on the other side, history
// moves away from it `speed` pixels per frame, fed by the live pixels at the
// line. shape 0: horizontal line (history goes up), 1: vertical (goes left),
// 2: radial (rings grow outwards from a circle of radius `line`).
// in0 = the previous frame (o0), in1 = the camera.
def({
  name: 'slit',
  kind: 'filter',
  inputs: 2,
  params: [p('speed', 2), p('line', 0.72), p('shape', 0)],
  passes: [
    {
      inputs: ['in0', 'in1'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, speed: f32, line: f32, shape: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  let s = max(speed, 0.0);
  let mode = u32(clamp(floor(shape), 0.0, 2.0));
  if (mode == 1u) {
    if (uv.x >= line) { return textureSampleLevel(T1, samp, uv, 0.0); }
    return textureSampleLevel(T0, samp, uv + vec2f(s * px.x, 0.0), 0.0);
  }
  if (mode == 2u) {
    let asp = G.res.x / G.res.y;
    var q = uv - 0.5;
    q.x *= asp;
    let d = length(q);
    if (d <= line * 0.5) { return textureSampleLevel(T1, samp, uv, 0.0); }
    var back = q - q / max(d, 0.0001) * s * px.y;
    back.x /= asp;
    return textureSampleLevel(T0, samp, back + 0.5, 0.0);
  }
  if (uv.y >= line) { return textureSampleLevel(T1, samp, uv, 0.0); }
  return textureSampleLevel(T0, samp, uv + vec2f(0.0, s * px.y), 0.0);
}`,
    },
  ],
});

// Optics: anamorphic flare. Bright spots bleed long horizontal streaks, tinted
// with the palette, like a cinema lens. Bright pass and streak at quarter
// resolution; `reach` is in output pixels.
def({
  name: 'flare',
  kind: 'filter',
  params: [p('threshold', 0.75), p('reach', 400), p('intensity', 1.4)],
  passes: [
    {
      inputs: ['in0'],
      scale: 0.25,
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, reach: f32, intensity: f32) -> vec4f {
  let c = textureSampleLevel(T0, samp, uv, 0.0);
  return vec4f(c.rgb * smoothstep(threshold, threshold + 0.1, luma(c.rgb)), 1.0);
}`,
    },
    {
      inputs: ['p0'],
      scale: 0.25,
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, reach: f32, intensity: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  // 24 taps each side; one quarter-res texel is 4 output pixels
  let stepUv = reach / 96.0 * px.x;
  var acc = textureSampleLevel(T0, samp, uv, 0.0).rgb;
  var wsum = 1.0;
  for (var i = 1; i <= 24; i++) {
    let w = exp(-f32(i) * 0.12);
    let o = vec2f(stepUv * f32(i), 0.0);
    acc += (textureSampleLevel(T0, samp, uv + o, 0.0).rgb + textureSampleLevel(T0, samp, uv - o, 0.0).rgb) * w;
    wsum += 2.0 * w;
  }
  return vec4f(acc / wsum * 3.0, 1.0);
}`,
    },
    {
      inputs: ['in0', 'p1'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, reach: f32, intensity: f32) -> vec4f {
  let base = textureSampleLevel(T0, samp, uv, 0.0).rgb;
  let streak = textureSampleLevel(T1, samp, uv, 0.0).rgb;
  let tint = mix(vec3f(1.0), CITRINK[3] * 2.2, 0.55);
  return vec4f(base + streak * tint * intensity, 1.0);
}`,
    },
  ],
});

// Optics: barrel/pincushion distortion, radial chromatic aberration, vignette.
def({
  name: 'lens',
  kind: 'filter',
  params: [p('aberration', 1.2), p('barrel', 0.25), p('vignette', 0.6)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, aberration: f32, barrel: f32, vignette: f32) -> vec4f {
  let asp = G.res.x / G.res.y;
  var q = uv - 0.5;
  q.x *= asp;
  let r2 = dot(q, q);
  let d = q * (1.0 + barrel * r2);
  let ca = aberration * 0.03 * r2;
  let uvR = vec2f(d.x * (1.0 + ca) / asp, d.y * (1.0 + ca)) + 0.5;
  let uvG = vec2f(d.x / asp, d.y) + 0.5;
  let uvB = vec2f(d.x * (1.0 - ca) / asp, d.y * (1.0 - ca)) + 0.5;
  var col = vec3f(
    textureSampleLevel(T0, samp, uvR, 0.0).r,
    textureSampleLevel(T0, samp, uvG, 0.0).g,
    textureSampleLevel(T0, samp, uvB, 0.0).b);
  col *= 1.0 - vignette * smoothstep(0.15, 0.85, sqrt(r2));
  return vec4f(col, 1.0);
}`,
    },
  ],
});

// Type: the image written in Martian Mono. Cells are 3:4 like the glyphs;
// brighter cells get denser characters from the atlas (src/gpu/glyphs.ts),
// lit with the light end of the Citrink ramp on the darkest colour.
def({
  name: 'ascii',
  kind: 'filter',
  params: [p('cell', 12), p('contrast', 1.3)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, cell: f32, contrast: f32) -> vec4f {
  let cw = max(floor(cell), 4.0);
  let size = vec2f(cw, floor(cw * 4.0 / 3.0));
  let res = vec2f(textureDimensions(T0));
  let id = floor(FC / size);
  let c = textureSampleLevel(T0, samp, (id + 0.5) * size / res, 0.0);
  let l = clamp((luma(c.rgb) - 0.5) * contrast + 0.5, 0.0, 1.0);
  let gi = min(floor(l * 16.0), 15.0);
  let local = fract(FC / size);
  let on = textureSampleLevel(t_glyphs, samp, vec2f((gi + local.x) / 16.0, local.y), 0.0).r;
  let ink = CITRINK[u32(clamp(3.0 + l * 4.99, 3.0, 7.0))];
  return vec4f(mix(CITRINK[0], ink, on), 1.0);
}`,
    },
  ],
});

// Tessellation: stained glass. A coarse grid of seeds where busy cells (where
// the image has edges) split into four, so the glass is fine where there is
// detail and broad where it is calm. Each cell takes the colour at its seed,
// with lead lines in the darkest Citrink colour.
def({
  name: 'vitral',
  kind: 'filter',
  params: [p('scale', 10), p('border', 0.08), p('jitter', 0.5), p('detail', 0.6)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn detailAt(p: vec2f, r: f32) -> f32 {
  return abs(lumaAt(T0, p + vec2f(r, 0.0)) - lumaAt(T0, p - vec2f(r, 0.0)))
       + abs(lumaAt(T0, p + vec2f(0.0, r)) - lumaAt(T0, p - vec2f(0.0, r)));
}

fn PASS(uv: vec2f, scale: f32, border: f32, jitter: f32, detail: f32) -> vec4f {
  let asp = G.res.x / G.res.y;
  let sc = max(scale, 1.0);
  let q = vec2f(uv.x * asp, uv.y) * sc;
  let cell = floor(q);
  var d1 = 8.0;
  var d2 = 8.0;
  var seed = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = cell + vec2f(f32(x), f32(y));
      let centreUv = vec2f((g.x + 0.5) / sc / asp, (g.y + 0.5) / sc);
      let busy = detailAt(centreUv, 0.5 / sc) * 4.0 > 1.0 - clamp(detail, 0.0, 1.0);
      let n = select(1, 2, busy);
      for (var sy = 0; sy < n; sy++) {
        for (var sx = 0; sx < n; sx++) {
          let sub = vec2f(f32(sx), f32(sy));
          let h = vec2f(hash3(vec3f(g + sub * 0.37, 3.1)), hash3(vec3f(g + sub * 0.37, 7.7)));
          let pt = g + (sub + 0.5 + jitter * 0.45 * sin(G.time * 0.4 + TAU * h)) / f32(n);
          let d = length(pt - q);
          if (d < d1) { d2 = d1; d1 = d; seed = pt; }
          else if (d < d2) { d2 = d; }
        }
      }
    }
  }
  let c = textureSampleLevel(T0, samp, vec2f(seed.x / sc / asp, seed.y / sc), 0.0);
  let glass = smoothstep(0.0, max(border, 0.001), d2 - d1);
  return vec4f(mix(CITRINK[0], c.rgb, glass), 1.0);
}`,
    },
  ],
});

// Signal: analogue video. Per-line jitter, a rolling tracking band with snow,
// chroma bleed and scanlines. `desync` (0-1) loses the sync: the picture
// rolls, the horizontal hold slips and the snow takes over.
def({
  name: 'vhs',
  kind: 'filter',
  params: [p('tracking', 0.5), p('noise', 0.6), p('bleed', 1.2), p('desync', 0)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, tracking: f32, noise: f32, bleed: f32, desync: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  let t = G.time;
  let ds = clamp(desync, 0.0, 1.0);
  let nz = noise + ds * 0.8;
  let inBand = 1.0 - smoothstep(0.0, 0.05, abs(fract(uv.y - t * 0.11) - 0.5));
  let row = floor(uv.y / px.y);
  let jitter = (hash3(vec3f(row, floor(t * 30.0), 1.0)) - 0.5) * nz * 0.006;
  let tear = inBand * tracking * 0.05 * (hash3(vec3f(floor(t * 12.0), row * 0.01, 3.0)) - 0.3);
  // vertical roll and slipping horizontal hold
  let roll = ds * fract(t * 0.6);
  let hold = ds * (uv.y - 0.5) * 0.18;
  let u = vec2f(uv.x + jitter + tear + hold, fract(uv.y + roll));
  let shift = vec2f(bleed * 3.0 * px.x, 0.0);
  var col = vec3f(
    textureSampleLevel(T0, samp, u + shift, 0.0).r,
    textureSampleLevel(T0, samp, u, 0.0).g,
    textureSampleLevel(T0, samp, u - shift, 0.0).b);
  col *= 0.8 + 0.2 * step(0.5, fract(FC.y * 0.5));
  let snow = hash3(vec3f(FC, floor(t * 60.0)));
  col = mix(col, vec3f(snow), clamp(inBand * nz * 0.4 + ds * 0.35, 0.0, 1.0));
  return vec4f(col, 1.0);
}`,
    },
  ],
});

// Glitch: real pixel sorting, on the GPU. One workgroup per column (at half
// resolution): every run of pixels whose brightness is within [low, high] is
// sorted by brightness, upwards or downwards (dir); the rest stays put.
// Trick: a run's pixels get the key "run start + brightness", the others
// their own row index, so one bitonic sort of the whole column sorts each run
// in place without moving anything else.
def({
  name: 'sort',
  kind: 'processor',
  params: [p('low', 0.35), p('high', 1), p('dir', 0)],
  compute: {
    scale: 0.5,
    wgsl: /* wgsl */ `
const N: u32 = 1024u;
var<workgroup> keys: array<f32, 1024>;
var<workgroup> cols: array<u32, 1024>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(OUT);
  let x = wg.x;
  let h = min(size.y, N);
  let lo = p_low();
  let hi = max(p_high(), lo);
  let up = p_dir() < 0.5;

  for (var k = 0u; k < 4u; k++) {
    let i = li * 4u + k;
    if (i < h) {
      let c = textureSampleLevel(T0, samp, (vec2f(f32(x), f32(i)) + 0.5) / vec2f(size), 0.0);
      cols[i] = pack4x8unorm(clamp(c, vec4f(0.0), vec4f(1.0)));
      keys[i] = luma(c.rgb);
    } else {
      keys[i] = 1e9;
      cols[i] = 0u;
    }
  }
  workgroupBarrier();

  // one walk down the column turns brightness into sort keys
  if (li == 0u) {
    var start = 0u;
    var inRun = false;
    for (var i = 0u; i < h; i++) {
      let l = keys[i];
      let sel = l >= lo && l <= hi;
      if (sel && !inRun) { start = i; }
      inRun = sel;
      keys[i] = select(f32(i), f32(start) + select(1.0 - l, l, up) * 0.999, sel);
    }
  }
  workgroupBarrier();

  // bitonic sort; each thread owns 4 indices and handles the pairs it leads
  for (var kk = 2u; kk <= N; kk = kk << 1u) {
    for (var j = kk >> 1u; j > 0u; j = j >> 1u) {
      for (var t = 0u; t < 4u; t++) {
        let i = li * 4u + t;
        let ixj = i ^ j;
        if (ixj > i) {
          let ascending = (i & kk) == 0u;
          let a = keys[i];
          let b = keys[ixj];
          if ((a > b) == ascending) {
            keys[i] = b;
            keys[ixj] = a;
            let ca = cols[i];
            cols[i] = cols[ixj];
            cols[ixj] = ca;
          }
        }
      }
      workgroupBarrier();
    }
  }

  for (var k = 0u; k < 4u; k++) {
    let i = li * 4u + k;
    if (i < h) {
      textureStore(OUT, vec2u(x, i), unpack4x8unorm(cols[i]));
    }
  }
  // rows past N (only on very tall outputs) are copied untouched
  for (var i = N + li; i < size.y; i += 256u) {
    textureStore(OUT, vec2u(x, i), textureSampleLevel(T0, samp, (vec2f(f32(x), f32(i)) + 0.5) / vec2f(size), 0.0));
  }
}`,
  },
});

/* ---------- 3D scenes (geometry from vertex_index, no vertex buffers) ---------- */

// Relief: the image as terrain, drawn as ridge lines with hidden-line removal
// (a dark fill draws first and occludes what's behind). `rows` is a uniform:
// the draws cover RELIEF_ROWS_MAX rows and the unused ones collapse off screen.
const RELIEF_COLS = 128;
const RELIEF_ROWS_MAX = 140;
def({
  name: 'relief',
  kind: 'render3d',
  params: [p('height', 0.5), p('yaw', 0), p('pitch', 0.3), p('dist', 3), p('thickness', 1.6), p('rows', 60)],
  scene: {
    draws: [
      { vs: 'vs_fill', fs: 'fs_fill', count: (RELIEF_COLS - 1) * (RELIEF_ROWS_MAX - 1) * 6 },
      { vs: 'vs_line', fs: 'fs_line', count: (RELIEF_COLS - 1) * RELIEF_ROWS_MAX * 6 },
    ],
    wgsl: /* wgsl */ `
const COLS: u32 = ${RELIEF_COLS}u;
const ROWS_MAX: u32 = ${RELIEF_ROWS_MAX}u;
// outside the clip volume: triangles made of it are dropped
const HIDDEN: vec4f = vec4f(2.0, 2.0, 2.0, 1.0);

fn rowCount() -> u32 {
  return u32(clamp(p_rows(), 4.0, f32(ROWS_MAX)));
}

fn reliefPos(c: u32, r: u32) -> vec3f {
  let uv = vec2f(f32(c) / f32(COLS - 1u), f32(r) / f32(rowCount() - 1u));
  let depth = 2.0 * G.res.y / G.res.x; // keep the image proportions on the floor
  let h = luma(imageAt(uv).rgb) * p_height();
  return vec3f((uv.x - 0.5) * 2.0, h, (uv.y - 0.5) * depth);
}

fn reliefCamera() -> mat4x4f {
  return orbit(p_yaw(), p_pitch(), p_dist(), vec3f(0.0, 0.1, 0.0));
}

struct V3 {
  @builtin(position) pos: vec4f,
  @location(0) shade: f32,
};

@vertex
fn vs_fill(@builtin(vertex_index) i: u32) -> V3 {
  let quad = i / 6u;
  let k = i % 6u;
  var dc = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var dr = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let row = quad / (COLS - 1u);
  var o: V3;
  o.shade = 0.0;
  if (row + 1u >= rowCount()) {
    o.pos = HIDDEN;
    return o;
  }
  o.pos = reliefCamera() * vec4f(reliefPos(quad % (COLS - 1u) + dc[k], row + dr[k]), 1.0);
  return o;
}

@fragment
fn fs_fill(in: V3) -> @location(0) vec4f {
  return vec4f(CITRINK[0], 1.0);
}

// Each ridge segment is a screen-space quad, so lines keep their thickness.
@vertex
fn vs_line(@builtin(vertex_index) i: u32) -> V3 {
  let seg = i / 6u;
  let k = i % 6u;
  let c = seg % (COLS - 1u);
  let r = seg / (COLS - 1u);
  var o: V3;
  o.shade = 0.0;
  if (r >= rowCount()) {
    o.pos = HIDDEN;
    return o;
  }
  let cam = reliefCamera();
  let pa = reliefPos(c, r);
  let pb = reliefPos(c + 1u, r);
  let a = cam * vec4f(pa, 1.0);
  let b = cam * vec4f(pb, 1.0);
  var ends = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var side = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
  let d = normalize((b.xy / b.w - a.xy / a.w) * G.res + vec2f(0.00001, 0.0));
  let n = vec2f(-d.y, d.x) * p_thickness() / G.res;
  let q = select(a, b, ends[k] == 1u);
  // nudge towards the camera so the line wins over its own fill
  o.pos = vec4f(q.xy + n * side[k] * q.w, q.z - 0.002 * q.w, q.w);
  o.shade = (pa.y + pb.y) * 0.5 / max(p_height(), 0.001);
  return o;
}

@fragment
fn fs_line(in: V3) -> @location(0) vec4f {
  return vec4f(CITRINK[u32(clamp(4.0 + in.shade * 3.99, 4.0, 7.0))], 1.0);
}`,
  },
});

// Cloud: one point per sample, coloured by the camera, pushed in depth by its
// luminance. Brighter points are bigger; `drift` lets them float on a slow
// noise field so the volume reads even with a still camera.
const CLOUD_X = 120;
const CLOUD_Y = 210;
def({
  name: 'cloud',
  kind: 'render3d',
  params: [p('depth', 0.9), p('size', 3), p('yaw', 0.5), p('pitch', 0.18), p('dist', 2.7), p('drift', 0.05)],
  scene: {
    draws: [{ vs: 'vs_points', fs: 'fs_points', count: CLOUD_X * CLOUD_Y * 6 }],
    wgsl: /* wgsl */ `
const NX: u32 = ${CLOUD_X}u;
const NY: u32 = ${CLOUD_Y}u;

struct VP {
  @builtin(position) pos: vec4f,
  @location(0) col: vec3f,
  @location(1) corner: vec2f,
};

@vertex
fn vs_points(@builtin(vertex_index) i: u32) -> VP {
  let id = i / 6u;
  let k = i % 6u;
  let uv = (vec2f(f32(id % NX), f32(id / NX)) + 0.5) / vec2f(f32(NX), f32(NY));
  let c = imageAt(uv);
  let l = luma(c.rgb);
  let asp = G.res.x / G.res.y;
  let t = G.time * 0.3;
  let drift = vec3f(
    vnoise(vec3f(uv * 6.0, t)),
    vnoise(vec3f(uv * 6.0 + 11.0, t)),
    vnoise(vec3f(uv * 6.0 + 23.0, t))) - 0.5;
  let world = vec3f((uv.x - 0.5) * 2.0 * asp, (0.5 - uv.y) * 2.0, (l - 0.5) * p_depth()) + drift * p_drift();
  let clip = orbit(p_yaw(), p_pitch(), p_dist(), vec3f(0.0)) * vec4f(world, 1.0);
  var cx = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  var cy = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
  let corner = vec2f(cx[k], cy[k]);
  let size = p_size() * (0.35 + 1.3 * l);
  var o: VP;
  // a constant clip-space offset becomes smaller in NDC the further away it is
  o.pos = vec4f(clip.xy + corner * size / G.res * p_dist(), clip.z, clip.w);
  o.col = c.rgb;
  o.corner = corner;
  return o;
}

@fragment
fn fs_points(in: VP) -> @location(0) vec4f {
  if (dot(in.corner, in.corner) > 1.0) { discard; }
  return vec4f(in.col, 1.0);
}`,
  },
});

// City: a block per cell, as tall as the image is bright, coloured by height
// along the Citrink ramp and lit from one side. Seen isometric: no perspective.
const CITY_X = 32;
const CITY_Z = 56;
const CUBE_FACES: [number, number, number][][] = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
];
const CUBE_NORMALS = ['1.0, 0.0, 0.0', '-1.0, 0.0, 0.0', '0.0, 1.0, 0.0', '0.0, -1.0, 0.0', '0.0, 0.0, 1.0', '0.0, 0.0, -1.0'];
const v3 = (v: number[]) => `vec3f(${v.map((x) => x.toFixed(1)).join(', ')})`;
def({
  name: 'city',
  kind: 'render3d',
  params: [p('height', 0.8), p('yaw', 0.785), p('pitch', 0.6155), p('zoom', 1.7), p('gap', 0.15)],
  scene: {
    draws: [{ vs: 'vs_city', fs: 'fs_city', count: CITY_X * CITY_Z * 36 }],
    wgsl: /* wgsl */ `
const CX: u32 = ${CITY_X}u;
const CZ: u32 = ${CITY_Z}u;
var<private> CUBE: array<vec3f, 36> = array<vec3f, 36>(${CUBE_FACES.flat().map(v3).join(', ')});
var<private> NORMALS: array<vec3f, 6> = array<vec3f, 6>(${CUBE_NORMALS.map((n) => `vec3f(${n})`).join(', ')});

struct VC {
  @builtin(position) pos: vec4f,
  @location(0) col: vec3f,
};

@vertex
fn vs_city(@builtin(vertex_index) i: u32) -> VC {
  let id = i / 36u;
  let k = i % 36u;
  let gx = id % CX;
  let gz = id / CX;
  let uv = (vec2f(f32(gx), f32(gz)) + 0.5) / vec2f(f32(CX), f32(CZ));
  let l = luma(imageAt(uv).rgb);
  let depth = 2.0 * G.res.y / G.res.x;
  let cellW = 2.0 / f32(CX);
  let cellD = depth / f32(CZ);
  let g = clamp(p_gap(), 0.0, 0.9);
  let h = 0.01 + l * p_height();
  let base = vec3f(-1.0 + f32(gx) * cellW, 0.0, -depth * 0.5 + f32(gz) * cellD);
  let local = CUBE[k];
  let world = base + vec3f((g * 0.5 + local.x * (1.0 - g)) * cellW, local.y * h, (g * 0.5 + local.z * (1.0 - g)) * cellD);
  let light = 0.45 + 0.55 * max(dot(NORMALS[k / 6u], normalize(vec3f(0.4, 0.9, 0.3))), 0.0);
  var o: VC;
  o.pos = isoCamera(p_yaw(), p_pitch(), p_zoom(), vec3f(0.0, 0.2, 0.0)) * vec4f(world, 1.0);
  o.col = CITRINK[u32(clamp(1.0 + l * 6.99, 1.0, 7.0))] * light;
  return o;
}

@fragment
fn fs_city(in: VC) -> @location(0) vec4f {
  return vec4f(in.col, 1.0);
}`,
  },
});

// Carve: the image as a textured relief. A dense grid, each vertex pushed
// towards the camera by its brightness (`sharp` > 1 keeps only the brightest
// parts high); the image itself is the texture, so steep walls stretch it into
// streaks and spikes. Facets get a little light from their own normal.
const CARVE_X = 180;
const CARVE_Y = 320;
def({
  name: 'carve',
  kind: 'render3d',
  params: [p('depth', 0.6), p('yaw', -0.18), p('pitch', 0.12), p('dist', 3.2), p('sharp', 1), p('mono', 1)],
  scene: {
    draws: [{ vs: 'vs_carve', fs: 'fs_carve', count: (CARVE_X - 1) * (CARVE_Y - 1) * 6 }],
    wgsl: /* wgsl */ `
const MX: u32 = ${CARVE_X}u;
const MY: u32 = ${CARVE_Y}u;

struct VM {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) world: vec3f,
};

@vertex
fn vs_carve(@builtin(vertex_index) i: u32) -> VM {
  let quad = i / 6u;
  let k = i % 6u;
  var dc = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var dr = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let c = quad % (MX - 1u) + dc[k];
  let r = quad / (MX - 1u) + dr[k];
  let uv = vec2f(f32(c) / f32(MX - 1u), f32(r) / f32(MY - 1u));
  let asp = G.res.x / G.res.y;
  let l = luma(imageAt(uv).rgb);
  let z = pow(clamp(l, 0.0, 1.0), max(p_sharp(), 0.1)) * p_depth();
  let world = vec3f((uv.x - 0.5) * 2.0 * asp, (0.5 - uv.y) * 2.0, z);
  var o: VM;
  o.pos = orbit(p_yaw(), p_pitch(), p_dist(), vec3f(0.0, 0.0, p_depth() * 0.3)) * vec4f(world, 1.0);
  o.uv = uv;
  o.world = world;
  return o;
}

@fragment
fn fs_carve(in: VM) -> @location(0) vec4f {
  let c = imageAt(in.uv).rgb;
  let n = normalize(cross(dpdx(in.world), dpdy(in.world)));
  let light = 0.7 + 0.45 * abs(dot(n, normalize(vec3f(-0.3, 0.5, 0.8))));
  let col = mix(c, vec3f(luma(c)), clamp(p_mono(), 0.0, 1.0)) * light;
  return vec4f(col, 1.0);
}`,
  },
});

/** Helpers for 3D scenes: projection, an orbit camera and the input image. */
export const SCENE_PRELUDE = /* wgsl */ `
fn perspective(fovy: f32, aspect: f32, near: f32, far: f32) -> mat4x4f {
  let f = 1.0 / tan(fovy * 0.5);
  let nf = 1.0 / (near - far);
  // WebGPU clip depth is 0…1
  return mat4x4f(
    vec4f(f / aspect, 0.0, 0.0, 0.0),
    vec4f(0.0, f, 0.0, 0.0),
    vec4f(0.0, 0.0, far * nf, -1.0),
    vec4f(0.0, 0.0, far * near * nf, 0.0));
}

// (\`target\` is a reserved word in WGSL)
fn lookAt(eye: vec3f, focus: vec3f) -> mat4x4f {
  let z = normalize(eye - focus);
  let x = normalize(cross(vec3f(0.0, 1.0, 0.0), z));
  let y = cross(z, x);
  return mat4x4f(
    vec4f(x.x, y.x, z.x, 0.0),
    vec4f(x.y, y.y, z.y, 0.0),
    vec4f(x.z, y.z, z.z, 0.0),
    vec4f(-dot(x, eye), -dot(y, eye), -dot(z, eye), 1.0));
}

/** Perspective camera orbiting \`focus\`: yaw around Y, pitch up from the horizon. */
fn orbit(yaw: f32, pitch: f32, dist: f32, focus: vec3f) -> mat4x4f {
  let pt = clamp(pitch, -1.4, 1.4);
  let eye = focus + max(dist, 0.1) * vec3f(cos(pt) * sin(yaw), sin(pt), cos(pt) * cos(yaw));
  return perspective(0.8, G.res.x / G.res.y, 0.05, 50.0) * lookAt(eye, focus);
}

fn ortho(halfH: f32, aspect: f32, near: f32, far: f32) -> mat4x4f {
  let h = max(halfH, 0.01);
  let w = h * aspect;
  return mat4x4f(
    vec4f(1.0 / w, 0.0, 0.0, 0.0),
    vec4f(0.0, 1.0 / h, 0.0, 0.0),
    vec4f(0.0, 0.0, 1.0 / (near - far), 0.0),
    vec4f(0.0, 0.0, near / (near - far), 1.0));
}

/** Orthographic camera (isometric at yaw 45°, pitch 35.26°); \`halfH\` is the visible half height. */
fn isoCamera(yaw: f32, pitch: f32, halfH: f32, focus: vec3f) -> mat4x4f {
  let pt = clamp(pitch, -1.4, 1.4);
  let eye = focus + 10.0 * vec3f(cos(pt) * sin(yaw), sin(pt), cos(pt) * cos(yaw));
  return ortho(halfH, G.res.x / G.res.y, 0.1, 30.0) * lookAt(eye, focus);
}

fn imageAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(T0, samp, uv, 0.0);
}
`;

/** Helpers for filter passes: separable 9-tap gaussian and luminance lookup. */
export const FILTER_PRELUDE = /* wgsl */ `
fn lumaAt(t: texture_2d<f32>, uv: vec2f) -> f32 {
  return luma(textureSampleLevel(t, samp, uv, 0.0).rgb);
}

fn gauss9(t: texture_2d<f32>, uv: vec2f, step: vec2f) -> vec4f {
  var w = array<f32, 5>(0.2270, 0.1945, 0.1216, 0.0540, 0.0162);
  var acc = textureSampleLevel(t, samp, uv, 0.0) * w[0];
  for (var i = 1; i < 5; i++) {
    let o = step * f32(i);
    acc += (textureSampleLevel(t, samp, uv + o, 0.0) + textureSampleLevel(t, samp, uv - o, 0.0)) * w[i];
  }
  return acc;
}
`;

/** Ops whose snippet calls another op's snippet. */
export const SNIPPET_DEPS: Record<string, string[]> = {
  modulateRotate: ['rotate'],
};

/** Always included: shared helpers the snippets rely on. */
export const PRELUDE = /* wgsl */ `
const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;

var<private> FC: vec2f;

var<private> CITRINK: array<vec3f, 8> = array<vec3f, 8>(
  vec3f(0.12549, 0.08235, 0.2),
  vec3f(0.14510, 0.14118, 0.27451),
  vec3f(0.14510, 0.30196, 0.43922),
  vec3f(0.08627, 0.43137, 0.47843),
  vec3f(0.32157, 0.76471, 0.24706),
  vec3f(0.69804, 0.85098, 0.25882),
  vec3f(0.98824, 0.96471, 0.37647),
  vec3f(1.0, 1.0, 1.0)
);

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn rgb2hsv(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 0.00001) {
    if (mx == c.r) { h = (c.g - c.b) / d; }
    else if (mx == c.g) { h = 2.0 + (c.b - c.r) / d; }
    else { h = 4.0 + (c.r - c.g) / d; }
    h = fract(h / 6.0);
  }
  let s = select(0.0, d / mx, mx > 0.00001);
  return vec3f(h, s, mx);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = fract(c.x + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0;
  let rgb = clamp(abs(k - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn bayer4(p: vec2f) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  let x = u32(p.x) % 4u;
  let y = u32(p.y) % 4u;
  return (m[y * 4u + x] + 0.5) / 16.0;
}
`;
