// Hydra-style chainable DSL. It only *builds* an EffectGraph (PLAN.md §3);
// nothing runs here, so every effect is plain JSON underneath.
//
//   export default effect({ id: 'espejo', code: '12', name: 'Espejo' }, (m) => {
//     const k = cam().kaleid(4).modulateRotate(osc(3, 0.1), 0.3);
//     m.macro('LADOS', k.parent(), 'sides', 2, 12);
//     k.citrink(1).out(0);
//   });

import type { EffectGraph, Macro, NodeSpec, OutputId } from '../graph/types';
import { OPS } from '../ops/registry';

type N = number | undefined;

class Builder {
  nodes: Record<string, NodeSpec> = {};
  outputs: Partial<Record<OutputId, string>> = {};
  macros: Macro[] = [];
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

  // modulation
  modulate(other: Chain, amount?: number) { return this.bin('modulate', other, [amount]); }
  modulateScale(other: Chain, multiple?: number, offset?: number) {
    return this.bin('modulateScale', other, [multiple, offset]);
  }
  modulateRotate(other: Chain, multiple?: number, offset?: number) {
    return this.bin('modulateRotate', other, [multiple, offset]);
  }

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

export interface MacroApi {
  macro(label: string, chain: Chain, param: string, min: number, max: number): void;
}

export function effect(meta: EffectMeta, body: (m: MacroApi) => void): EffectGraph {
  if (current) throw new Error('effect(...) cannot be nested');
  const b = new Builder();
  current = b;
  try {
    body({
      macro(label, chain, param, min, max) {
        const node = b.nodes[chain.id];
        if (!node?.params || !(param in node.params)) throw new Error(`${chain.id} has no param "${param}"`);
        b.macros.push({ label, target: `${chain.id}.${param}`, range: [min, max] });
      },
    });
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
  };
}
