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
//
// Module-scope names available to snippets: G (globals: time, dt, res, camFit),
// FC (fragment coordinate in pixels), PI, TAU, hash3, vnoise, luma,
// rgb2hsv, hsv2rgb, bayer4, CITRINK.
//
// No code here is taken from hydra-synth (AGPL); only op names and ideas.

export type OpKind = 'source' | 'coord' | 'color' | 'combine' | 'combineCoord' | 'texture' | 'filter';

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

// Print: AM halftone in two Citrink inks on white paper. Each plate is a grid of
// dots at its own screen angle; the second plate is out of register by
// `offset` pixels, like a risograph.
def({
  name: 'riso',
  kind: 'filter',
  params: [p('offset', 3), p('cell', 7), p('gain', 1.1)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn plate(pix: vec2f, cell: f32, angle: f32, gain: f32) -> f32 {
  let res = vec2f(textureDimensions(T0));
  let c = cos(angle);
  let s = sin(angle);
  let r = vec2f(c * pix.x + s * pix.y, -s * pix.x + c * pix.y) / cell;
  let id = floor(r) + 0.5;
  let cp = id * cell;
  let centre = vec2f(c * cp.x - s * cp.y, s * cp.x + c * cp.y);
  let ink = clamp((1.0 - lumaAt(T0, centre / res)) * gain, 0.0, 1.0);
  let radius = sqrt(ink) * 0.62;
  return 1.0 - smoothstep(radius - 0.06, radius + 0.06, length(fract(r) - 0.5));
}

fn PASS(uv: vec2f, offset: f32, cell: f32, gain: f32) -> vec4f {
  let cs = max(cell, 2.0);
  let a = plate(FC, cs, 0.2618, gain);
  let b = plate(FC + vec2f(offset, offset * 0.6), cs, 1.309, gain * 0.85);
  var paper = vec3f(1.0);
  paper *= mix(vec3f(1.0), CITRINK[2], a);
  paper *= mix(vec3f(1.0), CITRINK[5], b);
  return vec4f(paper, 1.0);
}`,
    },
  ],
});

// Time: slit-scan. Below `line` the live image; above it, history scrolls up
// `speed` pixels per frame, fed by the live row at the line. in0 = the
// previous frame (o0), in1 = the camera.
def({
  name: 'slit',
  kind: 'filter',
  inputs: 2,
  params: [p('speed', 2), p('line', 0.72)],
  passes: [
    {
      inputs: ['in0', 'in1'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, speed: f32, line: f32) -> vec4f {
  if (uv.y >= line) {
    return textureSampleLevel(T1, samp, uv, 0.0);
  }
  let px = 1.0 / vec2f(textureDimensions(T0));
  return textureSampleLevel(T0, samp, uv + vec2f(0.0, max(speed, 0.0) * px.y), 0.0);
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

// Type: the image as text. 5×5 glyphs ordered by ink density, lit with the
// light end of the Citrink ramp on the darkest colour.
const GLYPHS = [
  '.....|.....|.....|.....|.....',
  '.....|.....|.....|.....|..#..',
  '.....|..#..|.....|..#..|.....',
  '.....|.....|.###.|.....|.....',
  '.....|.###.|.....|.###.|.....',
  '.....|..#..|.###.|..#..|.....',
  '.....|.#.#.|..#..|.#.#.|.....',
  '.#.#.|#####|.#.#.|#####|.#.#.',
  '##..#|##.#.|..#..|.#.##|#..##',
  '.###.|#...#|#.###|#.##.|.####',
].map((g) => parseInt(g.replace(/\|/g, '').replace(/#/g, '1').replace(/\./g, '0'), 2));

def({
  name: 'ascii',
  kind: 'filter',
  params: [p('cell', 10), p('contrast', 1.3)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
var<private> GLYPHS: array<u32, 10> = array<u32, 10>(${GLYPHS.map((g) => `${g}u`).join(', ')});

fn PASS(uv: vec2f, cell: f32, contrast: f32) -> vec4f {
  let cs = max(floor(cell), 4.0);
  let res = vec2f(textureDimensions(T0));
  let id = floor(FC / cs);
  let c = textureSampleLevel(T0, samp, (id + 0.5) * cs / res, 0.0);
  let l = clamp((luma(c.rgb) - 0.5) * contrast + 0.5, 0.0, 1.0);
  let gi = u32(min(l * 10.0, 9.0));
  let g = vec2u(floor(fract(FC / cs) * 6.0));
  var on = 0.0;
  if (g.x < 5u && g.y < 5u) {
    on = f32((GLYPHS[gi] >> (24u - (g.y * 5u + g.x))) & 1u);
  }
  let ink = CITRINK[u32(clamp(3.0 + l * 4.99, 3.0, 7.0))];
  return vec4f(mix(CITRINK[0], ink, on), 1.0);
}`,
    },
  ],
});

// Tessellation: stained glass. Each Voronoi cell takes the colour at its seed,
// with lead lines in the darkest Citrink colour. Seeds drift with `jitter`.
def({
  name: 'vitral',
  kind: 'filter',
  params: [p('scale', 14), p('border', 0.08), p('jitter', 0.6)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, scale: f32, border: f32, jitter: f32) -> vec4f {
  let asp = G.res.x / G.res.y;
  let sc = max(scale, 1.0);
  let q = vec2f(uv.x * asp, uv.y) * sc;
  let cell = floor(q);
  let f = fract(q);
  var d1 = 8.0;
  var d2 = 8.0;
  var seed = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let h = vec2f(hash3(vec3f(cell + g, 3.1)), hash3(vec3f(cell + g, 7.7)));
      let pt = g + 0.5 + jitter * 0.45 * sin(G.time * 0.4 + TAU * h);
      let d = length(pt - f);
      if (d < d1) { d2 = d1; d1 = d; seed = cell + pt; }
      else if (d < d2) { d2 = d; }
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
// chroma bleed and scanlines.
def({
  name: 'vhs',
  kind: 'filter',
  params: [p('tracking', 0.5), p('noise', 0.6), p('bleed', 1.2)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, tracking: f32, noise: f32, bleed: f32) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(T0));
  let t = G.time;
  let inBand = 1.0 - smoothstep(0.0, 0.05, abs(fract(uv.y - t * 0.11) - 0.5));
  let row = floor(uv.y / px.y);
  let jitter = (hash3(vec3f(row, floor(t * 30.0), 1.0)) - 0.5) * noise * 0.006;
  let tear = inBand * tracking * 0.05 * (hash3(vec3f(floor(t * 12.0), row * 0.01, 3.0)) - 0.3);
  let u = vec2f(uv.x + jitter + tear, uv.y);
  let shift = vec2f(bleed * 3.0 * px.x, 0.0);
  var col = vec3f(
    textureSampleLevel(T0, samp, u + shift, 0.0).r,
    textureSampleLevel(T0, samp, u, 0.0).g,
    textureSampleLevel(T0, samp, u - shift, 0.0).b);
  col *= 0.8 + 0.2 * step(0.5, fract(FC.y * 0.5));
  let snow = hash3(vec3f(FC, floor(t * 60.0)));
  col = mix(col, vec3f(snow), inBand * noise * 0.4);
  return vec4f(col, 1.0);
}`,
    },
  ],
});

// Glitch: pixel sorting, approximated. Inside every run of pixels brighter than
// `threshold`, the first pixel of the run is dragged along `angle` for up to
// `reach` pixels.
def({
  name: 'sort',
  kind: 'filter',
  params: [p('threshold', 0.55), p('reach', 220), p('angle', 0)],
  passes: [
    {
      inputs: ['in0'],
      wgsl: /* wgsl */ `
fn PASS(uv: vec2f, threshold: f32, reach: f32, angle: f32) -> vec4f {
  let c = textureSampleLevel(T0, samp, uv, 0.0);
  if (luma(c.rgb) < threshold) { return c; }
  let px = 1.0 / vec2f(textureDimensions(T0));
  let dir = vec2f(sin(angle) * px.x, cos(angle) * px.y) * (reach / 24.0);
  var src = uv;
  for (var i = 1; i <= 24; i++) {
    let q = uv - dir * f32(i);
    if (luma(textureSampleLevel(T0, samp, q, 0.0).rgb) < threshold) { break; }
    src = q;
  }
  return textureSampleLevel(T0, samp, src, 0.0);
}`,
    },
  ],
});

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
