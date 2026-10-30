// EffectGraph → an ordered list of render passes (the IR the GPU backend runs).
//
// Everything that can be fused is fused into one fragment shader (Hydra-style).
// A node is *materialized* (rendered to its own texture) only when a filter
// needs to read its neighbourhood: filters and the inputs of filters.
// Each output buffer (o0…o3) gets one final pass; buffer reads (`o(i)`) see
// the previous frame. See PLAN.md §1 and §5.

import type { EffectGraph, OutputId } from './types';
import { OUTPUTS } from './types';
import { arity, FILTER_PRELUDE, OPS, PRELUDE, SCENE_PRELUDE, SNIPPET_DEPS, type SceneDraw } from '../ops/registry';

/** Bindings of a processor (compute) pass; the runtime mirrors it. */
export const COMPUTE_HEADER = /* wgsl */ `
struct Globals {
  time: f32,
  dt: f32,
  res: vec2f,
  camFit: vec4f,
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<uniform> P: array<vec4f, 64>;
@group(0) @binding(2) var T0: texture_2d<f32>;
@group(0) @binding(3) var OUT: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var samp: sampler;
`;

/** Max f32 params per effect: P is array<vec4f, 64>. */
export const MAX_PARAMS = 256;
/** Textures a single pass can read besides the camera and o0–o3 (T0…T3). */
export const MAX_PASS_INPUTS = 4;

export type PassTarget = { kind: 'output'; id: OutputId } | { kind: 'temp'; id: string };

export interface CompiledPass {
  /** Shader source; identical sources share a pipeline. */
  wgsl: string;
  /** Temp texture ids bound as T0…T3, in order. */
  inputs: string[];
  target: PassTarget;
  /** 3D scene: draw calls with a depth buffer. Absent: one fullscreen triangle (vs/fs). */
  draws?: SceneDraw[];
  /** Processor: a compute pass (entry `main`), one workgroup per column of its target. */
  compute?: boolean;
}

export interface TempTexture {
  id: string;
  /** Resolution relative to the output. */
  scale: number;
  /** Needs a depth buffer of the same size (3D scenes). */
  depth?: boolean;
  /** Written by a compute pass (storage texture). */
  storage?: boolean;
}

export interface CompiledEffect {
  passes: CompiledPass[];
  temps: TempTexture[];
  /** "<nodeId>.<param>" → slot in the params uniform. */
  slots: Record<string, number>;
  /** Initial uniform contents, MAX_PARAMS long. */
  values: Float32Array;
  display: OutputId;
  macros: { label: string; slot: number; min: number; max: number }[];
}

// Binding layout shared by every pass; the runtime mirrors it.
export const HEADER = /* wgsl */ `
struct Globals {
  time: f32,
  dt: f32,
  res: vec2f,
  camFit: vec4f, // xy: uv scale for cover fit and zoom, z: mirror (0/1)
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<uniform> P: array<vec4f, 64>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var t_cam: texture_2d<f32>;
@group(0) @binding(4) var t_o0: texture_2d<f32>;
@group(0) @binding(5) var t_o1: texture_2d<f32>;
@group(0) @binding(6) var t_o2: texture_2d<f32>;
@group(0) @binding(7) var t_o3: texture_2d<f32>;
@group(0) @binding(8) var t_glyphs: texture_2d<f32>;
@group(1) @binding(0) var T0: texture_2d<f32>;
@group(1) @binding(1) var T1: texture_2d<f32>;
@group(1) @binding(2) var T2: texture_2d<f32>;
@group(1) @binding(3) var T3: texture_2d<f32>;

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
const safe = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');
const fnName = (id: string) => `n_${safe(id)}`;

function fragment(body: string) {
  return `@fragment\nfn fs(in: VSOut) -> @location(0) vec4f {\n  FC = in.pos.xy;\n  return clamp(${body}, vec4f(0.0), vec4f(64.0));\n}`;
}

export function compileEffect(graph: EffectGraph): CompiledEffect {
  const nodes = graph.nodes;
  const slots: Record<string, number> = {};
  const values = new Float32Array(MAX_PARAMS);
  let nextSlot = 0;

  // Validate every node up front so errors name the node.
  for (const [id, node] of Object.entries(nodes)) {
    const def = OPS[node.op];
    if (!def) throw new Error(`node ${id}: unknown op "${node.op}"`);
    const want = arity(def);
    const got = node.in?.length ?? 0;
    if (got !== want) throw new Error(`node ${id}: "${node.op}" needs ${want} input(s), has ${got}`);
    for (const src of node.in ?? []) {
      if (!nodes[src]) throw new Error(`node ${id}: input "${src}" does not exist`);
    }
  }

  const param = (id: string, name: string): string => {
    const node = nodes[id];
    const def = OPS[node.op].params.find((p) => p.name === name)!;
    const key = `${id}.${name}`;
    if (!(key in slots)) {
      if (nextSlot >= MAX_PARAMS) throw new Error(`effect ${graph.id}: more than ${MAX_PARAMS} params`);
      slots[key] = nextSlot;
      values[nextSlot++] = node.params?.[name] ?? def.default;
    }
    return slotExpr(slots[key]);
  };
  const paramArgs = (id: string) =>
    OPS[nodes[id].op].params.filter((p) => !p.structural).map((p) => param(id, p.name));

  // Filters, 3D scenes and whatever feeds them must exist as textures.
  const materialized = new Set<string>();
  for (const [id, node] of Object.entries(nodes)) {
    const kind = OPS[node.op].kind;
    if (kind === 'filter' || kind === 'render3d' || kind === 'processor') {
      materialized.add(id);
      for (const src of node.in ?? []) materialized.add(src);
    }
  }

  const passes: CompiledPass[] = [];
  const temps = new Map<string, number>();
  const depthTemps = new Set<string>();
  const storageTemps = new Set<string>();
  const done = new Set<string>();
  const inProgress = new Set<string>();

  /**
   * One fused pass rooted at `root`. Materialized nodes other than an expanded
   * root are sampled from their textures (and rendered first).
   */
  const fusedPass = (root: string, expandRoot: boolean, target: PassTarget) => {
    const order: string[] = [];
    const inputs: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const asTexture = (id: string) => materialized.has(id) && !(expandRoot && id === root);

    const visit = (id: string) => {
      const s = state.get(id);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`cycle through node ${id}; use a buffer (o0…o3) for feedback`);
      state.set(id, 'visiting');
      if (asTexture(id)) {
        materialize(id);
        if (!inputs.includes(id)) inputs.push(id);
      } else {
        for (const src of nodes[id].in ?? []) visit(src);
      }
      state.set(id, 'done');
      order.push(id);
    };
    visit(root);
    if (inputs.length > MAX_PASS_INPUTS) {
      throw new Error(`pass for ${root} reads ${inputs.length} textures; at most ${MAX_PASS_INPUTS}`);
    }

    const snippets = new Set<string>();
    const addSnippet = (op: string) => {
      if (snippets.has(op)) return;
      for (const dep of SNIPPET_DEPS[op] ?? []) addSnippet(dep);
      if (OPS[op].wgsl) snippets.add(op);
    };

    const fns: string[] = [];
    for (const id of order) {
      const node = nodes[id];
      const def = OPS[node.op];
      let body: string;
      if (asTexture(id)) {
        body = `textureSampleLevel(T${inputs.indexOf(id)}, samp, uv, 0.0)`;
      } else {
        addSnippet(node.op);
        const args = paramArgs(id);
        const extra = args.length ? ', ' + args.join(', ') : '';
        const [a, b] = (node.in ?? []).map(fnName);
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
          case 'filter':
          case 'render3d':
          case 'processor':
            throw new Error(`internal: ${def.kind} ${id} reached the fuser`);
        }
      }
      fns.push(`fn ${fnName(id)}(uv: vec2f) -> vec4f {\n  return ${body};\n}`);
    }

    const wgsl = [HEADER, PRELUDE, ...[...snippets].map((op) => OPS[op].wgsl!.trim()), ...fns, fragment(`${fnName(root)}(in.uv)`)].join('\n\n');
    passes.push({ wgsl, inputs, target });
  };

  /** Ensures node `id` has been rendered into the temp texture of the same name. */
  const materialize = (id: string) => {
    if (done.has(id)) return;
    if (inProgress.has(id)) throw new Error(`cycle through node ${id}; use a buffer (o0…o3) for feedback`);
    inProgress.add(id);
    const node = nodes[id];
    const def = OPS[node.op];
    if (def.kind === 'filter') {
      const ins = node.in ?? [];
      ins.forEach(materialize);
      const args = paramArgs(id);
      def.passes!.forEach((fp, k) => {
        const last = k === def.passes!.length - 1;
        const tempId = last ? id : `${id}#${k}`;
        temps.set(tempId, fp.scale ?? 1);
        const inputs = fp.inputs.map((ref) => (ref.startsWith('in') ? ins[Number(ref.slice(2))] : `${id}#${ref.slice(1)}`));
        const call = `PASS(in.uv${args.length ? ', ' + args.join(', ') : ''})`;
        const wgsl = [HEADER, PRELUDE, FILTER_PRELUDE, fp.wgsl.trim(), fragment(call)].join('\n\n');
        passes.push({ wgsl, inputs, target: { kind: 'temp', id: tempId } });
      });
    } else if (def.kind === 'processor') {
      const input = node.in![0];
      materialize(input);
      temps.set(id, def.compute!.scale ?? 1);
      storageTemps.add(id);
      const accessors = def.params
        .filter((p) => !p.structural)
        .map((p) => `fn p_${p.name}() -> f32 {\n  return ${param(id, p.name)};\n}`);
      const wgsl = [COMPUTE_HEADER, PRELUDE, ...accessors, def.compute!.wgsl.trim()].join('\n\n');
      passes.push({ wgsl, inputs: [input], target: { kind: 'temp', id }, compute: true });
    } else if (def.kind === 'render3d') {
      const input = node.in![0];
      materialize(input);
      temps.set(id, 1);
      depthTemps.add(id);
      // the scene reads its params through p_<name>() so the vertex stage can too
      const accessors = def.params
        .filter((p) => !p.structural)
        .map((p) => `fn p_${p.name}() -> f32 {\n  return ${param(id, p.name)};\n}`);
      const wgsl = [HEADER, PRELUDE, SCENE_PRELUDE, ...accessors, def.scene!.wgsl.trim()].join('\n\n');
      passes.push({ wgsl, inputs: [input], target: { kind: 'temp', id }, draws: def.scene!.draws });
    } else {
      temps.set(id, 1);
      fusedPass(id, true, { kind: 'temp', id });
    }
    inProgress.delete(id);
    done.add(id);
  };

  for (const output of OUTPUTS) {
    const root = graph.outputs[output];
    if (!root) continue;
    if (!nodes[root]) throw new Error(`${output}: node "${root}" does not exist`);
    fusedPass(root, false, { kind: 'output', id: output });
  }

  if (!passes.some((p) => p.target.kind === 'output' && p.target.id === graph.display)) {
    throw new Error(`display ${graph.display} is never written`);
  }

  const macros = graph.macros.map((m) => {
    if (!(m.target in slots)) throw new Error(`macro "${m.label}": ${m.target} is not a uniform param`);
    return { label: m.label, slot: slots[m.target], min: m.range[0], max: m.range[1] };
  });
  for (const mod of graph.mods) {
    if (!(mod.target in slots)) throw new Error(`mod: ${mod.target} is not a uniform param`);
  }

  return {
    passes,
    temps: [...temps].map(([id, scale]) => ({
      id,
      scale,
      ...(depthTemps.has(id) ? { depth: true } : {}),
      ...(storageTemps.has(id) ? { storage: true } : {}),
    })),
    slots,
    values,
    display: graph.display,
    macros,
  };
}
