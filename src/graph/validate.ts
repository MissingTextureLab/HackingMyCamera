// Checks untrusted JSON (a saved or imported effect, the editor's output)
// against the EffectGraph format and reports every problem with its path.
// Structure that only shows up when compiling (cycles, too many params or
// pass inputs) is checked by running the compiler too.

import { compileEffect } from './compile';
import type { EffectGraph, Macro, Mod, NodeSpec, OutputId, SignalSource } from './types';
import { OUTPUTS } from './types';
import { arity, OPS } from '../ops/registry';

export const FORMAT_VERSION = 1;
const LFO_SHAPES = ['sine', 'tri', 'saw', 'square', 'random', 'noise'];
const TOUCH_CHANNELS = ['x', 'y', 'down', 'vx', 'vy', 'count', 'pinch'];
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NODE_ID = /^[A-Za-z0-9_]{1,40}$/;

export class EffectValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`effect is not valid:\n- ${problems.join('\n- ')}`);
    this.name = 'EffectValidationError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Returns a clean EffectGraph or throws EffectValidationError listing every problem. */
export function validateEffect(input: unknown): EffectGraph {
  const errs: string[] = [];
  const err = (path: string, msg: string) => errs.push(`${path}: ${msg}`);

  if (!isObj(input)) throw new EffectValidationError(['(root): must be an object']);
  const g = input;

  if (!isStr(g.id) || !ID.test(g.id)) err('id', 'lowercase letters, digits and dashes, up to 32');
  if (!isStr(g.code) || !/^\d{1,3}$/.test(g.code)) err('code', 'catalogue number: 1–3 digits');
  if (!isStr(g.name) || g.name.length < 1 || g.name.length > 16) err('name', 'one word, 1–16 characters');
  if (g.version !== FORMAT_VERSION) err('version', `must be ${FORMAT_VERSION}`);

  // nodes
  const nodes: Record<string, NodeSpec> = {};
  if (!isObj(g.nodes) || Object.keys(g.nodes).length === 0) {
    err('nodes', 'must be a non-empty object');
  } else {
    for (const [id, raw] of Object.entries(g.nodes)) {
      const at = `nodes.${id}`;
      if (!NODE_ID.test(id)) err(at, 'node ids: letters, digits and _');
      if (!isObj(raw)) {
        err(at, 'must be an object');
        continue;
      }
      const def = isStr(raw.op) ? OPS[raw.op] : undefined;
      if (!def) {
        err(`${at}.op`, `unknown op ${JSON.stringify(raw.op)}`);
        continue;
      }
      const node: NodeSpec = { op: def.name };
      const want = arity(def);
      if (raw.in !== undefined || want > 0) {
        if (!Array.isArray(raw.in) || !raw.in.every(isStr)) err(`${at}.in`, `needs ${want} input id(s)`);
        else {
          if (raw.in.length !== want) err(`${at}.in`, `"${def.name}" needs ${want} input(s), has ${raw.in.length}`);
          for (const src of raw.in) if (!isObj(g.nodes) || !(src in g.nodes)) err(`${at}.in`, `input "${src}" does not exist`);
          if (want > 0) node.in = [...raw.in];
        }
      }
      if (raw.params !== undefined) {
        if (!isObj(raw.params)) err(`${at}.params`, 'must be an object');
        else {
          const params: Record<string, number> = {};
          for (const [k, v] of Object.entries(raw.params)) {
            if (!def.params.some((p) => p.name === k)) err(`${at}.params.${k}`, `"${def.name}" has no param "${k}"`);
            else if (!isNum(v)) err(`${at}.params.${k}`, 'must be a finite number');
            else params[k] = v;
          }
          if (Object.keys(params).length) node.params = params;
        }
      }
      if (def.name === 'buffer') {
        const index = node.params?.index ?? 0;
        if (!Number.isInteger(index) || index < 0 || index > 3) err(`${at}.params.index`, 'buffer index must be 0–3');
      }
      nodes[id] = node;
    }
  }

  // outputs and display
  const outputs: Partial<Record<OutputId, string>> = {};
  if (!isObj(g.outputs)) err('outputs', 'must map o0…o3 to node ids');
  else {
    for (const [k, v] of Object.entries(g.outputs)) {
      if (!OUTPUTS.includes(k as OutputId)) err(`outputs.${k}`, 'only o0, o1, o2, o3');
      else if (!isStr(v) || !(v in nodes)) err(`outputs.${k}`, `node ${JSON.stringify(v)} does not exist`);
      else outputs[k as OutputId] = v;
    }
  }
  const display = g.display as OutputId;
  if (!OUTPUTS.includes(display)) err('display', 'must be o0, o1, o2 or o3');
  else if (isObj(g.outputs) && !(display in g.outputs)) err('display', `${display} is never written`);

  // a param that can be a uniform: exists and is not structural
  const paramTarget = (path: string, target: unknown): string | null => {
    if (!isStr(target)) {
      err(path, 'must be "<nodeId>.<param>"');
      return null;
    }
    const dot = target.lastIndexOf('.');
    const [nodeId, param] = [target.slice(0, dot), target.slice(dot + 1)];
    const node = nodes[nodeId];
    const p = node && OPS[node.op].params.find((x) => x.name === param);
    if (!node) err(path, `node "${nodeId}" does not exist`);
    else if (!p) err(path, `"${node.op}" has no param "${param}"`);
    else if (p.structural) err(path, `"${param}" is fixed at compile time and can't be driven`);
    else return target;
    return null;
  };
  const range = (path: string, r: unknown): [number, number] | null => {
    if (Array.isArray(r) && r.length === 2 && r.every(isNum)) return [r[0], r[1]];
    err(path, 'must be [min, max]');
    return null;
  };

  // macros
  const macros: Macro[] = [];
  if (g.macros !== undefined && !Array.isArray(g.macros)) err('macros', 'must be an array');
  else if (Array.isArray(g.macros)) {
    if (g.macros.length > 3) err('macros', 'at most 3: drag x, drag y, two-finger twist');
    g.macros.forEach((m, i) => {
      const at = `macros[${i}]`;
      if (!isObj(m)) return err(at, 'must be an object');
      if (!isStr(m.label) || m.label.length < 1 || m.label.length > 12) err(`${at}.label`, '1–12 characters');
      const target = paramTarget(`${at}.target`, m.target);
      const r = range(`${at}.range`, m.range);
      if (target && r && isStr(m.label)) macros.push({ label: m.label, target, range: r });
    });
  }

  // mods
  const mods: Mod[] = [];
  if (g.mods !== undefined && !Array.isArray(g.mods)) err('mods', 'must be an array');
  else if (Array.isArray(g.mods)) {
    g.mods.forEach((m, i) => {
      const at = `mods[${i}]`;
      if (!isObj(m)) return err(at, 'must be an object');
      const target = paramTarget(`${at}.target`, m.target);
      const r = range(`${at}.range`, m.range);
      let source: SignalSource | null = null;
      const s = m.source;
      if (!isObj(s)) err(`${at}.source`, 'must be an object');
      else if (s.kind === 'lfo') {
        if (!isStr(s.shape) || !LFO_SHAPES.includes(s.shape)) err(`${at}.source.shape`, `one of ${LFO_SHAPES.join(', ')}`);
        else if (!isNum(s.rate) || s.rate <= 0 || s.rate > 30) err(`${at}.source.rate`, 'Hz, more than 0 and up to 30');
        else if (s.phase !== undefined && !isNum(s.phase)) err(`${at}.source.phase`, 'must be a number');
        else source = { kind: 'lfo', shape: s.shape as never, rate: s.rate, ...(isNum(s.phase) ? { phase: s.phase } : {}) };
      } else if (s.kind === 'touch') {
        if (!isStr(s.channel) || !TOUCH_CHANNELS.includes(s.channel)) err(`${at}.source.channel`, `one of ${TOUCH_CHANNELS.join(', ')}`);
        else source = { kind: 'touch', channel: s.channel as never };
      } else if (s.kind === 'motion') {
        if (s.channel !== 'x' && s.channel !== 'y') err(`${at}.source.channel`, 'one of x, y');
        else source = { kind: 'motion', channel: s.channel };
      } else if (s.kind === 'event') {
        if (s.channel !== 'shot' && s.channel !== 'taken') err(`${at}.source.channel`, 'one of shot, taken');
        else source = { kind: 'event', channel: s.channel };
      } else err(`${at}.source.kind`, 'must be "lfo", "touch", "motion" or "event"');
      if (m.smooth !== undefined && (!isNum(m.smooth) || m.smooth < 0 || m.smooth >= 1)) err(`${at}.smooth`, 'from 0 up to (not including) 1');
      if (m.quantize !== undefined && (!isNum(m.quantize) || m.quantize <= 0)) err(`${at}.quantize`, 'must be more than 0');
      if (target && r && source) {
        if (macros.some((x) => x.target === target)) err(`${at}.target`, `${target} is already a macro`);
        mods.push({
          target,
          source,
          range: r,
          ...(isNum(m.smooth) ? { smooth: m.smooth } : {}),
          ...(isNum(m.quantize) ? { quantize: m.quantize } : {}),
        });
      }
    });
  }

  if (errs.length) throw new EffectValidationError(errs);

  const graph: EffectGraph = {
    id: g.id as string,
    code: g.code as string,
    name: g.name as string,
    version: FORMAT_VERSION,
    nodes,
    outputs,
    display,
    macros,
    mods,
  };
  try {
    compileEffect(graph);
  } catch (e) {
    throw new EffectValidationError([`(graph): ${(e as Error).message}`]);
  }
  return graph;
}

/** Parses and validates effect JSON text. */
export function parseEffect(text: string): EffectGraph {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new EffectValidationError([`(json): ${(e as Error).message}`]);
  }
  return validateEffect(data);
}

/** Stable, readable JSON for saving and sharing. */
export function serializeEffect(graph: EffectGraph): string {
  return JSON.stringify(graph, null, 2) + '\n';
}
