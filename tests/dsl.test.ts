import { describe, expect, it } from 'vitest';
import { cam, effect, noise, o, osc } from '../src/dsl';

describe('dsl', () => {
  it('builds a graph with defaults filled in', () => {
    const g = effect({ id: 't', code: '00', name: 'Test' }, () => {
      cam().modulate(noise(3), 0.2).kaleid().out(0);
    });
    expect(g.outputs.o0).toBeDefined();
    const kaleid = g.nodes[g.outputs.o0!];
    expect(kaleid.op).toBe('kaleid');
    expect(kaleid.params).toEqual({ sides: 4 });
    const mod = g.nodes[kaleid.in![0]];
    expect(mod.op).toBe('modulate');
    expect(mod.params).toEqual({ amount: 0.2 });
    expect(g.nodes[mod.in![1]].params).toEqual({ scale: 3, speed: 0.1 });
  });

  it('serializes to plain JSON', () => {
    const g = effect({ id: 't', code: '00', name: 'Test' }, (m) => {
      const b = o(0).scale(1.01).blend(cam(), 0.1);
      m.macro('MIX', b, 'amount', 0, 1);
      b.out(0);
    });
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    expect(g.macros).toEqual([{ label: 'MIX', target: `${g.outputs.o0}.amount`, range: [0, 1] }]);
  });

  it('rejects calls outside effect() and unknown macro params', () => {
    expect(() => osc()).toThrow(/inside effect/);
    expect(() =>
      effect({ id: 't', code: '00', name: 'T' }, (m) => {
        const c = cam().hue();
        m.macro('X', c, 'nope', 0, 1);
        c.out(0);
      }),
    ).toThrow(/no param "nope"/);
  });

  it('requires the display output to be written', () => {
    expect(() => effect({ id: 't', code: '00', name: 'T' }, () => cam().out(1))).toThrow(/never writes o0/);
  });
});
