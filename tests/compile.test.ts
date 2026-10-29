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
    expect(c.passes.map((p) => p.output)).toEqual(['o0', 'o1']);
    expect(c.passes[0].wgsl).toContain('textureSampleLevel(t_o1, samp, uv, 0.0)');
  });

  it('includes snippet dependencies', () => {
    const g = effect({ id: 'r', code: '0', name: 'R' }, () => cam().modulateRotate(noise(), 1).out(0));
    const w = compileEffect(g).passes[0].wgsl;
    expect(w).toContain('fn op_rotate');
    expect(w).toContain('fn op_modulateRotate');
  });

  it('rejects cycles, unknown ops and wrong arity', () => {
    const base = (nodes: EffectGraph['nodes']): EffectGraph => ({
      id: 'x', code: '0', name: 'X', version: 1, nodes, outputs: { o0: 'a' }, display: 'o0', macros: [],
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
