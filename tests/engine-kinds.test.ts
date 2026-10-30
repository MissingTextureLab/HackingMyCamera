import { describe, expect, it } from 'vitest';
import { cam, effect, event, o } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';
import { eventValue, EVENT_DECAY, Signals } from '../src/signals';

describe('processor (compute) passes', () => {
  it('compiles to a compute pass writing a storage temp', () => {
    const g = effect({ id: 'p', code: '0', name: 'P' }, (m) => {
      const s = cam().sort(0.3, 1, 0);
      m.macro('U', s, 'low', 0, 1);
      s.hue(0.1).out(0);
    });
    const c = compileEffect(g);
    const sort = c.passes.find((p) => p.compute)!;
    expect(sort.draws).toBeUndefined();
    expect(sort.inputs).toHaveLength(1);
    expect(sort.wgsl).toContain('@compute @workgroup_size(256)');
    expect(sort.wgsl).toMatch(/fn p_low\(\) -> f32/);
    const temp = c.temps.find((t) => t.id === sort.target.id)!;
    expect(temp).toMatchObject({ storage: true, scale: 0.5 });
    // the fused pass after it samples the sorted texture
    expect(c.passes[c.passes.length - 1].inputs).toEqual([sort.target.id]);
  });
});

describe('two-input filters with feedback', () => {
  it('feeds the previous frame to abyss and slit', () => {
    for (const build of [() => cam().abyss(o(0)), () => o(0).slit(cam())]) {
      const g = effect({ id: 'f', code: '0', name: 'F' }, () => build().out(0));
      const c = compileEffect(g);
      const filter = c.passes.find((p) => p.inputs.length === 2)!;
      expect(filter).toBeDefined();
      // one of the inputs is the o0 buffer, materialized from the previous frame
      const reads = c.passes.filter((p) => p.wgsl.includes('textureSampleLevel(t_o0'));
      expect(reads).toHaveLength(1);
    }
  });
});

describe('event signal', () => {
  it('pulses from 1 to 0 over EVENT_DECAY', () => {
    expect(eventValue(undefined, 10)).toBe(0);
    expect(eventValue(10, 10)).toBe(1);
    expect(eventValue(10, 10 + EVENT_DECAY / 2)).toBeCloseTo(0.25);
    expect(eventValue(10, 10 + EVENT_DECAY)).toBeCloseTo(0);
  });

  it('drives a mod after a shot', () => {
    const g = effect({ id: 'e', code: '0', name: 'E' }, (m) => {
      const r = cam().riso();
      m.mod(r, 'jolt', event('shot'), 0, 18);
      r.out(0);
    });
    const c = compileEffect(g);
    const s = new Signals();
    s.bind(g.mods, c.slots, c.values);
    const out = new Map<number, number>();
    s.update(5, 1 / 60, (slot, v) => out.set(slot, v));
    expect(out.get(c.slots[g.mods[0].target])).toBe(0);
    s.trigger('shot', 5);
    s.update(5, 1 / 60, (slot, v) => out.set(slot, v));
    expect(out.get(c.slots[g.mods[0].target])).toBe(18);
  });

  it('is accepted by the validator', () => {
    const g = effect({ id: 'e', code: '0', name: 'E' }, (m) => {
      const r = cam().riso();
      m.mod(r, 'jolt', event('shot'), 0, 18);
      r.out(0);
    });
    expect(validateEffect(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });
});
