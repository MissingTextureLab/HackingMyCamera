// Hydra-style chainable DSL. It only *builds* an EffectGraph (PLAN.md §3);
// nothing runs here, so every effect is plain JSON underneath.
//
//   export default effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
//     const k = cam().kaleid(4).modulateRotate(osc(3, 0.1), 0.3);
//     m.macro('LADOS', k.parent(), 'sides', 2, 12);
//     k.citrink(1).out(0);
//   });

import type { EffectGraph, EventChannel, LfoShape, Macro, Mod, MotionChannel, NodeSpec, OutputId, SignalSource, TouchChannel } from '../graph/types';
import { OPS } from '../ops/registry';

type N = number | undefined;

class Builder {
  nodes: Record<string, NodeSpec> = {};
  outputs: Partial<Record<OutputId, string>> = {};
  macros: Macro[] = [];
  mods: Mod[] = [];
  private count = 0;

  add(op: string, inputs: Chain[], args: N[]): Chain {
    const def = OPS[op];
    if (!def) throw new Error(`Unknown op "${op}"`);
    for (const c of inputs) {
      if (c.builder !== this) throw new Error(`"${op}": input chain belongs to another effect`);
    }
    if (args.length > def.params.length) {
      throw new Error(`"${op}" takes ${def.params.length} params, got ${args.length}`);
    }
    const params: Record<string, number> = {};
    def.params.forEach((p, i) => (params[p.name] = args[i] ?? p.default));
    const id = `${op}${this.count++}`;
    const node: NodeSpec = { op };
    if (inputs.length) node.in = inputs.map((c) => c.id);
    if (def.params.length) node.params = params;
    this.nodes[id] = node;
    return new Chain(this, id);
  }
}

let current: Builder | null = null;

function builder(): Builder {
  if (!current) throw new Error('DSL calls must run inside effect(...)');
  return current;
}

export class Chain {
  constructor(
    readonly builder: Builder,
    readonly id: string,
  ) {}

  private un(op: string, args: N[]) {
    return this.builder.add(op, [this], args);
  }
  private bin(op: string, other: Chain, args: N[]) {
    return this.builder.add(op, [this, other], args);
  }

  /** The chain this node was built on (its first input), for addressing macros. */
  parent(): Chain {
    const first = this.builder.nodes[this.id].in?.[0];
    if (!first) throw new Error(`${this.id} has no input`);
    return new Chain(this.builder, first);
  }

  // coordinates
  rotate(angle?: number, speed?: number) { return this.un('rotate', [angle, speed]); }
  scale(amount?: number, xMult?: number, yMult?: number, offsetX?: number, offsetY?: number) {
    return this.un('scale', [amount, xMult, yMult, offsetX, offsetY]);
  }
  pixelate(pixelX?: number, pixelY?: number) { return this.un('pixelate', [pixelX, pixelY]); }
  kaleid(sides?: number) { return this.un('kaleid', [sides]); }
  scroll(x?: number, y?: number, speedX?: number, speedY?: number) { return this.un('scroll', [x, y, speedX, speedY]); }
  repeat(x?: number, y?: number) { return this.un('repeat', [x, y]); }

  // color
  hue(amount?: number) { return this.un('hue', [amount]); }
  gain(amount?: number) { return this.un('gain', [amount]); }
  posterize(bins?: number, gamma?: number) { return this.un('posterize', [bins, gamma]); }
  contrast(amount?: number) { return this.un('contrast', [amount]); }
  brightness(amount?: number) { return this.un('brightness', [amount]); }
  invert(amount?: number) { return this.un('invert', [amount]); }
  thresh(threshold?: number, tolerance?: number) { return this.un('thresh', [threshold, tolerance]); }
  citrink(amount?: number, dither?: number, cycle?: number, scale?: number) {
    return this.un('citrink', [amount, dither, cycle, scale]);
  }

  // combine
  blend(other: Chain, amount?: number) { return this.bin('blend', other, [amount]); }
  add(other: Chain, amount?: number) { return this.bin('add', other, [amount]); }
  mult(other: Chain, amount?: number) { return this.bin('mult', other, [amount]); }
  diff(other: Chain) { return this.bin('diff', other, []); }
  /** This on frames with a new camera frame, `held` (usually a buffer holding this) on the rest. */
  latch(held: Chain) { return this.bin('latch', held, []); }
  /** Per channel max(this, other * amount). */
  lighten(other: Chain, amount?: number) { return this.bin('lighten', other, [amount]); }
  /** Feedback smoke: the image rises and swirls a little every frame, blurring as it ages. */
  smoke(amount?: number) { return this.un('smoke', [amount]); }
  /** Real composite video: encode and decode NTSC-style; chroma bleed, rainbows and dot crawl (`artifact`). */
  composite(bleed?: number, artifact?: number, snow?: number) { return this.un('composite', [bleed, artifact, snow]); }
  /** Cathode-ray tube: curved glass, 480 scanline beams, aperture grille, and a magnet at (mx, my). */
  crt(curve?: number, mask?: number, mx?: number, my?: number, magnet?: number, wave?: number) { return this.un('crt', [curve, mask, mx, my, magnet, wave]); }
  /** Motion since `previous` (usually the last camera frame in a buffer): px per frame per 8 px block. */
  flow(previous: Chain) { return this.bin('flow', previous, []); }
  /** Datamosh: drags this along a `motion` map (from flow), a `block` of pixels at a time. */
  mosh(motion: Chain, drag?: number, block?: number) { return this.bin('mosh', motion, [drag, block]); }
  /**
   * Block-matching motion of this (the camera) against `previous` (the camera at the last tick,
   * `cam().latch(o(3))`): one vector per 16 px block, kept in `state` (the buffer it is written to,
   * usually o(2)) between ticks. See `motion` in the registry for how to read the result.
   */
  motion(previous: Chain, state: Chain, sustain?: number, calm?: number) {
    return this.builder.add('motion', [this, previous, state], [sustain, calm]);
  }
  /** Debug view: this image dimmed, with an arrow per block along the `motion` map. */
  scope(motion: Chain, gain?: number) { return this.bin('scope', motion, [gain]); }
  /**
   * Datamosh decoder (port of niccolofanton/data-mosh): this is the camera, `history` the buffer
   * the result is written back to (the reference frame), `motion` the map from `motion`.
   * Every uniform of the original is a param, with its default; drive `recover` with the trigger.
   */
  decode(history: Chain, motion: Chain) { return this.builder.add('decode', [this, history, motion], []); }
  /** Colours a grey freshness buffer by age: green while fresh, dim purple past `knee`. */
  aging(knee?: number) { return this.un('aging', [knee]); }

  // modulation
  modulate(other: Chain, amount?: number) { return this.bin('modulate', other, [amount]); }
  modulateScale(other: Chain, multiple?: number, offset?: number) {
    return this.bin('modulateScale', other, [multiple, offset]);
  }
  modulateRotate(other: Chain, multiple?: number, offset?: number) {
    return this.bin('modulateRotate', other, [multiple, offset]);
  }

  // neighbourhood filters (each one is its own pass)
  blur(radius?: number) { return this.un('blur', [radius]); }
  edge(strength?: number) { return this.un('edge', [strength]); }
  sharpen(amount?: number) { return this.un('sharpen', [amount]); }
  bloom(threshold?: number, intensity?: number, radius?: number) { return this.un('bloom', [threshold, intensity, radius]); }
  /** Real bloom: wide, smooth halo from a 5-level down/up pyramid. `spread` 0-1 weighs the wide levels. */
  glow(threshold?: number, intensity?: number, spread?: number) { return this.un('glow', [threshold, intensity, spread]); }
  /** Slides this image along the luminance gradient of `map` (TouchDesigner Displace). */
  displace(map: Chain, amount?: number) { return this.bin('displace', map, [amount]); }
  /** Two-ink halftone on paper, second plate out of register by `offset` px. */
  /** Comic-book print: solid shadows, soft fine screen, inked contours, textured paper. */
  comic(cell?: number, offset?: number, ink?: number, lines?: number, jolt?: number) {
    return this.un('comic', [cell, offset, ink, lines, jolt]);
  }
  /** variant 0-11: ink pair (variant % 4) and screen: dots, lines, cross (variant / 4). */
  riso(offset?: number, cell?: number, gain?: number, variant?: number, jolt?: number) {
    return this.un('riso', [offset, cell, gain, variant, jolt]);
  }
  /** Slit-scan: this chain is the history (usually o(0)), `live` feeds it at `line`. */
  /** shape 0: horizontal, 1: vertical, 2: radial. */
  slit(live: Chain, speed?: number, line?: number, shape?: number, wear?: number) {
    return this.bin('slit', live, [speed, line, shape, wear]);
  }
  /** Facing mirrors: `previous` (usually o(0)) nested on top of this, worn down by `crush` per bounce. */
  abyss(previous: Chain, scale?: number, angle?: number, shift?: number, crush?: number) {
    return this.bin('abyss', previous, [scale, angle, shift, crush]);
  }
  lens(aberration?: number, barrel?: number, vignette?: number) { return this.un('lens', [aberration, barrel, vignette]); }
  /** Anamorphic streaks from bright spots; `reach` in output pixels. */
  flare(threshold?: number, reach?: number, intensity?: number) { return this.un('flare', [threshold, reach, intensity]); }
  ascii(cell?: number, contrast?: number, stroke?: number, split?: number) {
    return this.un('ascii', [cell, contrast, stroke, split]);
  }

  // 3D scenes (rendered with depth into their own texture)
  relief(height?: number, yaw?: number, pitch?: number, dist?: number, thickness?: number, rows?: number) {
    return this.un('relief', [height, yaw, pitch, dist, thickness, rows]);
  }
  cloud(depth?: number, size?: number, yaw?: number, pitch?: number, dist?: number, drift?: number) {
    return this.un('cloud', [depth, size, yaw, pitch, dist, drift]);
  }
  /** Textured relief: the image pushed towards the camera by its brightness. */
  carve(depth?: number, yaw?: number, pitch?: number, dist?: number, sharp?: number, mono?: number) {
    return this.un('carve', [depth, yaw, pitch, dist, sharp, mono]);
  }
  /** Isometric: `zoom` is the visible half height in scene units. */
  city(height?: number, yaw?: number, pitch?: number, zoom?: number, gap?: number) {
    return this.un('city', [height, yaw, pitch, zoom, gap]);
  }
  /** Cells split into four where the image is busy; `detail` 0-1 is how easily. */
  vitral(scale?: number, border?: number, jitter?: number, detail?: number) { return this.un('vitral', [scale, border, jitter, detail]); }
  vhs(tracking?: number, noise?: number, bleed?: number, desync?: number) { return this.un('vhs', [tracking, noise, bleed, desync]); }
  /** Pixel sorting (compute): runs within [low, high] brightness, dir 0 = up, 1 = down. */
  sort(low?: number, high?: number, dir?: number) { return this.un('sort', [low, high, dir]); }

  out(index: 0 | 1 | 2 | 3 = 0) {
    this.builder.outputs[`o${index}`] = this.id;
  }
}

// sources
export const cam = () => builder().add('camera', [], []);
export const o = (index: 0 | 1 | 2 | 3) => builder().add('buffer', [], [index]);
export const osc = (frequency?: number, sync?: number, offset?: number) => builder().add('osc', [], [frequency, sync, offset]);
export const noise = (scale?: number, speed?: number) => builder().add('noise', [], [scale, speed]);
export const voronoi = (scale?: number, speed?: number, blending?: number) => builder().add('voronoi', [], [scale, speed, blending]);
export const shape = (sides?: number, radius?: number, smoothing?: number) => builder().add('shape', [], [sides, radius, smoothing]);
export const gradient = (speed?: number) => builder().add('gradient', [], [speed]);
export const solid = (r?: number, g?: number, b?: number) => builder().add('solid', [], [r, g, b]);

export interface EffectMeta {
  id: string;
  code: string;
  name: string;
  display?: OutputId;
}

// signal sources for m.mod(...)
export const lfo = (shape: LfoShape, rate: number, phase?: number): SignalSource =>
  phase === undefined ? { kind: 'lfo', shape, rate } : { kind: 'lfo', shape, rate, phase };
export const touch = (channel: TouchChannel): SignalSource => ({ kind: 'touch', channel });
export const motion = (channel: MotionChannel): SignalSource => ({ kind: 'motion', channel });
/** A pulse on an event (1 → 0 in 0.6 s): 'shot' = photo or start of recording. */
export const event = (channel: EventChannel): SignalSource => ({ kind: 'event', channel });

export interface MacroApi {
  /**
   * Exposes a param to the gestures: 1st = drag x, 2nd = drag y, 3rd = two-finger twist.
   * `links` ([chain, param, min, max]) follow the same gesture over their own ranges.
   */
  macro(label: string, chain: Chain, param: string, min: number, max: number, links?: [Chain, string, number, number][]): void;
  /** Like macro, but always on the two-finger twist (C), leaving the drag free. */
  twist(label: string, chain: Chain, param: string, min: number, max: number, links?: [Chain, string, number, number][]): void;
  /** Drives a param from a signal every frame. Don't target a param that is also a macro. */
  mod(chain: Chain, param: string, source: SignalSource, min: number, max: number, opts?: { smooth?: number; quantize?: number }): void;
}

export function effect(meta: EffectMeta, body: (m: MacroApi) => void): EffectGraph {
  if (current) throw new Error('effect(...) cannot be nested');
  const b = new Builder();
  current = b;
  try {
    const target = (chain: Chain, param: string) => {
      const node = b.nodes[chain.id];
      if (!node?.params || !(param in node.params)) throw new Error(`${chain.id} has no param "${param}"`);
      return `${chain.id}.${param}`;
    };
    const macro = (label: string, chain: Chain, param: string, min: number, max: number, links?: [Chain, string, number, number][]): Macro => ({
      label,
      target: target(chain, param),
      range: [min, max],
      ...(links?.length ? { links: links.map(([c, p, lo, hi]) => ({ target: target(c, p), range: [lo, hi] as [number, number] })) } : {}),
    });
    body({
      macro(label, chain, param, min, max, links) {
        b.macros.push(macro(label, chain, param, min, max, links));
      },
      twist(label, chain, param, min, max, links) {
        b.macros.push({ ...macro(label, chain, param, min, max, links), gesture: 2 });
      },
      mod(chain, param, source, min, max, opts = {}) {
        b.mods.push({ target: target(chain, param), source, range: [min, max], ...opts });
      },
    });
    const clash = b.mods.find((m) => b.macros.some((x) => x.target === m.target || x.links?.some((l) => l.target === m.target)));
    if (clash) throw new Error(`${clash.target} is both a macro and a mod`);
  } finally {
    current = null;
  }
  const display = meta.display ?? 'o0';
  if (!b.outputs[display]) throw new Error(`effect "${meta.id}" never writes ${display}`);
  return {
    id: meta.id,
    code: meta.code,
    name: meta.name,
    version: 1,
    nodes: b.nodes,
    outputs: b.outputs,
    display,
    macros: b.macros,
    mods: b.mods,
  };
}
