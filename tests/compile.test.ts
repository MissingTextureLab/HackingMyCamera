import { describe, expect, it } from 'vitest';
import { cam, effect, noise, o } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import type { EffectGraph } from '../src/graph/types';
import { PRESETS } from '../src/presets';

describe('compileEffect', () => {
  it('fuses a whole chain into one pass', () => {
    const g = effect({ id: 't', code: '00', name: 'T' }, () => {
      cam().modulate(noise(3, 0.1), 0.2).kaleid(5).hue(0.1).out(0);
    });
    const c = compileEffect(g);
    expect(c.passes).toHaveLength(1);
    const w = c.passes[0].wgsl;
    expect(w).toContain('fn op_kaleid');
    expect(w).toContain('fn op_noise');
    expect(w).not.toContain('fn op_osc');
    expect(w).toMatch(/@fragment\s+fn fs/);
    // 3 (noise: 2, modulate: 1) + kaleid 1 + hue 1
    expect(Object.keys(c.slots)).toHaveLength(5);
  });

  it('puts param values in uniform slots, not in the shader', () => {
    const a = compileEffect(effect({ id: 'a', code: '0', name: 'A' }, () => cam().hue(0.1).out(0)));
    const b = compileEffect(effect({ id: 'a', code: '0', name: 'A' }, () => cam().hue(0.9).out(0)));
    expect(a.passes[0].wgsl).toBe(b.passes[0].wgsl);
    expect(a.values[0]).toBeCloseTo(0.1);
    expect(b.values[0]).toBeCloseTo(0.9);
  });

  it('bakes buffer indices and reads the previous frame', () => {
    const g = effect({ id: 'fb', code: '0', name: 'F' }, () => {
      o(1).blend(cam(), 0.1).out(0);
      cam().out(1);
    });
    const c = compileEffect(g);
    expect(c.passes.map((p) => p.target)).toEqual([
      { kind: 'output', id: 'o0' },
      { kind: 'output', id: 'o1' },
    ]);
    expect(c.passes[0].wgsl).toContain('textureSampleLevel(t_o1, samp, uv, 0.0)');
  });

  it('materializes only what a filter reads', () => {
    const g = effect({ id: 'f', code: '0', name: 'F' }, () => {
      cam().contrast(1.2).blur(4).hue(0.1).out(0);
    });
    const c = compileEffect(g);
    // contrast chain → temp, blur H → temp, blur V → temp, hue + output
    expect(c.passes).toHaveLength(4);
    const [pre, h, v, out] = c.passes;
    expect(pre.target.kind).toBe('temp');
    expect(pre.wgsl).toContain('fn op_contrast');
    expect(h.inputs).toEqual([pre.target.id]);
    expect(v.inputs).toEqual([h.target.id]);
    expect(out.target).toEqual({ kind: 'output', id: 'o0' });
    expect(out.inputs).toEqual([v.target.id]);
    expect(out.wgsl).toContain('fn op_hue');
    expect(out.wgsl).not.toContain('fn op_contrast');
    expect(c.temps.map((t) => t.id)).toEqual([pre.target.id, h.target.id, v.target.id]);
  });

  it('runs bloom at half resolution and feeds the original to its last pass', () => {
    const g = effect({ id: 'b', code: '0', name: 'B' }, () => cam().bloom().out(0));
    const c = compileEffect(g);
    const half = c.temps.filter((t) => t.scale === 0.5);
    expect(half).toHaveLength(3);
    const last = c.passes[c.passes.length - 2]; // before the output copy
    expect(last.inputs).toHaveLength(2);
    expect(last.inputs[0]).toBe(c.passes[0].target.id); // the camera, materialized
  });

  it('renders a 3D scene into a temp with depth and param accessors', () => {
    const g = effect({ id: 's', code: '0', name: 'S' }, (m) => {
      const r = cam().relief(0.7);
      m.macro('H', r, 'height', 0, 1);
      r.hue(0.1).out(0);
    });
    const c = compileEffect(g);
    const scene = c.passes.find((p) => p.draws)!;
    expect(scene.draws!.map((d) => d.vs)).toEqual(['vs_fill', 'vs_line']);
    expect(scene.inputs).toHaveLength(1);
    expect(scene.wgsl).toMatch(/fn p_height\(\) -> f32 \{\s+return P\[\d+\]\.[xyzw];/);
    expect(c.temps.find((t) => t.id === scene.target.id)?.depth).toBe(true);
    // what comes after the scene is fused as usual and samples it
    const out = c.passes[c.passes.length - 1];
    expect(out.inputs).toEqual([scene.target.id]);
    expect(out.wgsl).toContain('fn op_hue');
  });

  it('gives displace both its inputs as textures', () => {
    const g = effect({ id: 'd', code: '0', name: 'D' }, () => cam().displace(noise(3), 2).out(0));
    const c = compileEffect(g);
    const disp = c.passes.find((p) => p.wgsl.includes('fn PASS') && p.inputs.length === 2)!;
    expect(disp).toBeDefined();
    expect(c.passes.filter((p) => p.target.kind === 'temp')).toHaveLength(3);
  });

  it('includes snippet dependencies', () => {
    const g = effect({ id: 'r', code: '0', name: 'R' }, () => cam().modulateRotate(noise(), 1).out(0));
    const w = compileEffect(g).passes[0].wgsl;
    expect(w).toContain('fn op_rotate');
    expect(w).toContain('fn op_modulateRotate');
  });

  it('rejects cycles, unknown ops and wrong arity', () => {
    const base = (nodes: EffectGraph['nodes']): EffectGraph => ({
      id: 'x', code: '0', name: 'X', version: 1, nodes, outputs: { o0: 'a' }, display: 'o0', macros: [], mods: [],
    });
    expect(() => compileEffect(base({ a: { op: 'hue', in: ['b'] }, b: { op: 'hue', in: ['a'] } }))).toThrow(/cycle/);
    expect(() => compileEffect(base({ a: { op: 'nope' } }))).toThrow(/unknown op/);
    expect(() => compileEffect(base({ a: { op: 'blend', in: ['b'] }, b: { op: 'camera' } }))).toThrow(/needs 2 input/);
  });

  it('compiles every preset and resolves its macros', () => {
    for (const p of PRESETS) {
      const c = compileEffect(p);
      expect(c.passes.length).toBeGreaterThan(0);
      expect(c.macros).toHaveLength(p.macros.length);
    }
  });
});
