import { describe, expect, it } from 'vitest';
import { lfo, Signals, touchValue, type TouchSnapshot } from '../src/signals';
import { cam, effect, lfo as lfoSrc, touch } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';

const still: TouchSnapshot = { down: 0, x: 0.5, y: 0.5, vx: 0, vy: 0, count: 0, pinch: 1 };

describe('signals', () => {
  it('lfo shapes stay in 0…1 and hit their extremes', () => {
    for (const shape of ['sine', 'tri', 'saw', 'square', 'random', 'noise'] as const) {
      for (let i = 0; i < 200; i++) {
        const p = i / 37;
        const v = lfo(shape, p, Math.floor(p));
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(lfo('sine', 0, 0)).toBeCloseTo(0);
    expect(lfo('sine', 0.5, 0)).toBeCloseTo(1);
    expect(lfo('square', 0.75, 0)).toBe(1);
  });

  it('normalizes touch: still velocity is the middle, y grows upwards', () => {
    expect(touchValue(still, 'vx')).toBe(0.5);
    expect(touchValue({ ...still, y: 0 }, 'y')).toBe(1);
    expect(touchValue({ ...still, vx: 100 }, 'vx')).toBe(1);
  });

  it('maps, smooths and quantizes into the right uniform slot', () => {
    const g = effect({ id: 's', code: '0', name: 'S' }, (m) => {
      const k = cam().kaleid(4);
      m.mod(k, 'sides', touch('x'), 2, 10, { quantize: 1 });
      const h = k.hue(0);
      m.mod(h, 'amount', lfoSrc('saw', 1), 0, 1, { smooth: 0.5 });
      h.out(0);
    });
    const c = compileEffect(g);
    const s = new Signals();
    s.bind(g.mods, c.slots, c.values);
    s.setTouch({ ...still, x: 0.8 });
    const out = new Map<number, number>();
    s.update(0.5, 1 / 60, (slot, v) => out.set(slot, v));
    expect(out.get(c.slots[`${g.mods[0].target}`])).toBe(8); // 2 + 8 * 0.8 = 8.4 → 8
    const hue = out.get(c.slots[g.mods[1].target])!;
    expect(hue).toBeGreaterThan(0); // halfway from 0 towards 0.5
    expect(hue).toBeLessThan(0.5);
  });

  it('refuses a param that is both macro and mod', () => {
    expect(() =>
      effect({ id: 'x', code: '0', name: 'X' }, (m) => {
        const h = cam().hue();
        m.macro('H', h, 'amount', 0, 1);
        m.mod(h, 'amount', touch('x'), 0, 1);
        h.out(0);
      }),
    ).toThrow(/both a macro and a mod/);
  });
});
