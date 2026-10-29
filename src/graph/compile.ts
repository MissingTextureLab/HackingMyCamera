// EffectGraph → one fused WGSL fragment shader per written output buffer.
//
// H1 only materializes at output buffers: every chain reachable from an output
// is fused into that output's shader, and buffer reads sample the previous
// frame (ping-pong). Neighbourhood ops (blur, edge…) add more boundaries in H2.

import type { EffectGraph, OutputId } from './types';
import { OUTPUTS } from './types';
import { OPS, PRELUDE, SNIPPET_DEPS } from '../ops/registry';

/** Max f32 params per effect: P is array<vec4f, 64>. */
export const MAX_PARAMS = 256;

export interface CompiledPass {
  output: OutputId;
  wgsl: string;
}

export interface CompiledEffect {
  passes: CompiledPass[];
  /** "<nodeId>.<param>" → slot in the params uniform. */
  slots: Record<string, number>;
  /** Initial uniform contents, MAX_PARAMS long. */
  values: Float32Array;
  display: OutputId;
  macros: { label: string; slot: number; min: number; max: number }[];
}

// Binding layout shared by every effect pass; the runtime mirrors it.
export const HEADER = /* wgsl */ `
struct Globals {
  time: f32,
  dt: f32,
  res: vec2f,
  camFit: vec4f, // xy: uv scale for cover fit, z: mirror (0/1)
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<uniform> P: array<vec4f, 64>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var t_cam: texture_2d<f32>;
@group(0) @binding(4) var t_o0: texture_2d<f32>;
@group(0) @binding(5) var t_o1: texture_2d<f32>;
@group(0) @binding(6) var t_o2: texture_2d<f32>;
@group(0) @binding(7) var t_o3: texture_2d<f32>;

fn sampleCam(uv: vec2f) -> vec4f {
  var q = (uv - 0.5) * G.camFit.xy + 0.5;
  if (G.camFit.z > 0.5) { q.x = 1.0 - q.x; }
  return textureSampleLevel(t_cam, samp, q, 0.0);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VSOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

const COMPONENT = ['x', 'y', 'z', 'w'];
const slotExpr = (s: number) => `P[${s >> 2}].${COMPONENT[s & 3]}`;
const fnName = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;

export function compileEffect(graph: EffectGraph): CompiledEffect {
  const slots: Record<string, number> = {};
  const values = new Float32Array(MAX_PARAMS);
  let nextSlot = 0;

  // Validate every node up front so errors name the node.
  for (const [id, node] of Object.entries(graph.nodes)) {
    const def = OPS[node.op];
    if (!def) throw new Error(`node ${id}: unknown op "${node.op}"`);
    const want = def.kind === 'combine' || def.kind === 'combineCoord' ? 2 : def.kind === 'texture' || def.kind === 'source' ? 0 : 1;
    const got = node.in?.length ?? 0;
    if (got !== want) throw new Error(`node ${id}: "${node.op}" needs ${want} input(s), has ${got}`);
    for (const src of node.in ?? []) {
      if (!graph.nodes[src]) throw new Error(`node ${id}: input "${src}" does not exist`);
    }
  }

  const param = (id: string, name: string): string => {
    const node = graph.nodes[id];
    const def = OPS[node.op].params.find((p) => p.name === name)!;
    const value = node.params?.[name] ?? def.default;
    const key = `${id}.${name}`;
    if (!(key in slots)) {
      if (nextSlot >= MAX_PARAMS) throw new Error(`effect ${graph.id}: more than ${MAX_PARAMS} params`);
      slots[key] = nextSlot;
      values[nextSlot++] = value;
    }
    return slotExpr(slots[key]);
  };

  const passes: CompiledPass[] = [];
  for (const output of OUTPUTS) {
    const root = graph.outputs[output];
    if (!root) continue;
    if (!graph.nodes[root]) throw new Error(`${output}: node "${root}" does not exist`);

    const order: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string) => {
      const s = state.get(id);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`cycle through node ${id}; use a buffer (o0…o3) for feedback`);
      state.set(id, 'visiting');
      for (const src of graph.nodes[id].in ?? []) visit(src);
      state.set(id, 'done');
      order.push(id);
    };
    visit(root);

    const snippets = new Set<string>();
    const addSnippet = (op: string) => {
      if (snippets.has(op)) return;
      for (const dep of SNIPPET_DEPS[op] ?? []) addSnippet(dep);
      if (OPS[op].wgsl) snippets.add(op);
    };

    const fns: string[] = [];
    for (const id of order) {
      const node = graph.nodes[id];
      const def = OPS[node.op];
      addSnippet(node.op);
      const args = def.params.filter((p) => !p.structural).map((p) => param(id, p.name));
      const extra = args.length ? ', ' + args.join(', ') : '';
      const [a, b] = (node.in ?? []).map(fnName);
      let body: string;
      switch (def.kind) {
        case 'texture':
          if (node.op === 'camera') body = 'sampleCam(uv)';
          else {
            const index = Math.round(node.params?.index ?? 0);
            if (index < 0 || index > 3) throw new Error(`node ${id}: buffer index ${index} out of range`);
            body = `textureSampleLevel(t_o${index}, samp, uv, 0.0)`;
          }
          break;
        case 'source':
          body = `op_${node.op}(uv${extra})`;
          break;
        case 'coord':
          body = `${a}(op_${node.op}(uv${extra}))`;
          break;
        case 'color':
          body = `op_${node.op}(${a}(uv)${extra})`;
          break;
        case 'combine':
          body = `op_${node.op}(${a}(uv), ${b}(uv)${extra})`;
          break;
        case 'combineCoord':
          body = `${a}(op_${node.op}(uv, ${b}(uv)${extra}))`;
          break;
      }
      fns.push(`fn ${fnName(id)}(uv: vec2f) -> vec4f {\n  return ${body};\n}`);
    }

    const wgsl = [
      HEADER,
      PRELUDE,
      ...[...snippets].map((op) => OPS[op].wgsl!.trim()),
      ...fns,
      `@fragment\nfn fs(in: VSOut) -> @location(0) vec4f {\n  FC = in.pos.xy;\n  return clamp(${fnName(root)}(in.uv), vec4f(0.0), vec4f(1.0));\n}`,
    ].join('\n\n');
    passes.push({ output, wgsl });
  }

  if (!passes.some((p) => p.output === graph.display)) throw new Error(`display ${graph.display} is never written`);

  const macros = graph.macros.map((m) => {
    if (!(m.target in slots)) throw new Error(`macro "${m.label}": ${m.target} is not a uniform param`);
    return { label: m.label, slot: slots[m.target], min: m.range[0], max: m.range[1] };
  });

  return { passes, slots, values, display: graph.display, macros };
}
