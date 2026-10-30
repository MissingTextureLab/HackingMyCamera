import { describe, expect, it } from 'vitest';
import { cam, effect, o } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';

describe('linked macros', () => {
  const g = effect({ id: 'e', code: '0', name: 'E' }, (m) => {
    const s = o(0).slit(cam(), 2, 0.72, 0, 0.4);
    m.macro('GASTO', s, 'wear', 0, 1, [[s, 'speed', 0.5, 4.25]]);
    s.out(0);
  });

  it('compiles the links to their own slots and ranges', () => {
    const c = compileEffect(g);
    const [mac] = c.macros;
    expect(mac.links).toEqual([{ slot: c.slots[g.macros[0].links![0].target], min: 0.5, max: 4.25 }]);
    expect(mac.links![0].slot).not.toBe(mac.slot);
  });

  it('survives the validator', () => {
    expect(validateEffect(JSON.parse(JSON.stringify(g)))).toEqual(g);
  });

  it('rejects a mod on a linked param', () => {
    expect(() =>
      effect({ id: 'e', code: '0', name: 'E' }, (m) => {
        const s = o(0).slit(cam());
        m.macro('GASTO', s, 'wear', 0, 1, [[s, 'speed', 0.5, 4]]);
        m.mod(s, 'speed', { kind: 'lfo', shape: 'sine', rate: 1 }, 0, 1);
        s.out(0);
      }),
    ).toThrow(/both a macro and a mod/);
  });
});
