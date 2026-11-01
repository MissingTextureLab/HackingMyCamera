import { describe, expect, it } from 'vitest';
import { cam, effect, touch } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';
import { stampCodes, STAMP_CHARS } from '../src/gpu/glyphs';
import { PRESETS } from '../src/presets';
import { gestureValue, HOLD_FADE, LOST_DELAY, Signals } from '../src/signals';

// The datamosh trigger (F3 of PLAN-DATAMOSH.md), as in niccolofanton/data-mosh.
describe('hold / lost', () => {
  const never = { pressAt: -Infinity, releaseAt: -Infinity };

  it('hold is 1 while touching and fades linearly after the release', () => {
    expect(gestureValue('hold', false, never, 10)).toBe(0);
    expect(gestureValue('hold', true, { pressAt: 9, releaseAt: -Infinity }, 10)).toBe(1);
    const g = { pressAt: 9, releaseAt: 10 };
    expect(gestureValue('hold', false, g, 10)).toBe(1);
    expect(gestureValue('hold', false, g, 10 + HOLD_FADE / 2)).toBeCloseTo(0.5);
    expect(gestureValue('hold', false, g, 10 + HOLD_FADE)).toBeCloseTo(0);
  });

  it('lost waits LOST_DELAY into a gesture and stays through the fade', () => {
    expect(gestureValue('lost', false, never, 10)).toBe(1);
    const g = { pressAt: 10, releaseAt: -Infinity };
    expect(gestureValue('lost', true, g, 10 + LOST_DELAY / 2)).toBe(0);
    expect(gestureValue('lost', true, g, 10 + LOST_DELAY)).toBe(1);
    expect(gestureValue('lost', false, { pressAt: 10, releaseAt: 10.5 }, 10.6)).toBe(1);
  });

  it('Signals times the gesture from the touch state', () => {
    const g = effect({ id: 'h', code: '00', name: 'H' }, (m) => {
      const c = cam().gain(1);
      m.mod(c, 'amount', touch('hold'), 1, 0);
      c.out(0);
    });
    const c = compileEffect(g);
    const s = new Signals();
    s.bind(g.mods, c.slots, c.values);
    const out: number[] = [];
    const write = (_: number, v: number) => out.push(v);

    s.update(1, 1 / 60, write);
    expect(out.pop()).toBe(1); // recover = 1: at rest
    s.setTouch({ ...s.touch, down: 1 });
    s.update(2, 1 / 60, write);
    expect(out.pop()).toBe(0); // held: decoding
    s.setTouch({ ...s.touch, down: 0 });
    s.update(3, 1 / 60, write);
    expect(out.pop()).toBe(0); // the release frame
    s.update(3 + HOLD_FADE / 2, 1 / 60, write);
    expect(out.pop()).toBeCloseTo(0.5);
    s.update(3 + HOLD_FADE, 1 / 60, write);
    expect(out.pop()).toBeCloseTo(1);
  });

  it('validates the new channels', () => {
    const g = effect({ id: 'v', code: '00', name: 'V' }, (m) => {
      const c = cam().gain(1);
      m.mod(c, 'amount', touch('lost'), 0, 1);
      c.out(0);
    });
    expect(() => validateEffect(JSON.parse(JSON.stringify(g)))).not.toThrow();
  });
});

describe('FX-51 PÉRDIDA', () => {
  const perdida = PRESETS.find((p) => p.id === 'perdida')!;

  it('is in the gallery after ORDEN, with three macros and the trigger', () => {
    expect(perdida.code).toBe('51');
    expect(PRESETS.map((p) => p.code)).toEqual([...PRESETS.map((p) => p.code)].sort((a, b) => Number(a) - Number(b)));
    expect(perdida.macros.map((m) => m.label)).toEqual(['ARRASTRE', 'BLOQUE', 'PAQUETES']);
    expect(perdida.mods.map((m) => m.source)).toEqual([
      { kind: 'touch', channel: 'hold' },
      { kind: 'touch', channel: 'lost' },
    ]);
  });

  it("puts the original's defaults at the middle of the drags", () => {
    const c = compileEffect(perdida);
    for (const m of c.macros.filter((x) => x.gesture < 2)) {
      expect((m.min + m.max) / 2).toBeCloseTo(c.values[m.slot]);
    }
  });

  it('feeds the decoder its own last output', () => {
    expect(perdida.display).toBe('o1');
    expect(perdida.outputs.o0).toBeUndefined();
    expect(() => validateEffect(JSON.parse(JSON.stringify(perdida)))).not.toThrow();
  });

  it('only redraws on camera ticks, with the fewest passes', () => {
    expect(perdida.ticked).toBe(true);
    const c = compileEffect(perdida);
    const copies = c.passes.filter((p) => p.target.kind === 'temp' && p.inputs.length === 0);
    // the camera, o3, o2 and o1: each is copied once
    expect(copies).toHaveLength(4);
    // the decoder writes o1 itself, with no copy after it
    const decoder = c.passes.find((p) => p.target.kind === 'output' && p.target.id === 'o1')!;
    expect(decoder.inputs).toHaveLength(3);
    expect(c.passes.filter((p) => p.target.kind === 'output' && p.target.id === 'o0')).toHaveLength(0);
  });

  it('stamps its name without dropping the accent letter', () => {
    const text = stampCodes('PÉRDIDA').map((i) => STAMP_CHARS[i]).join('');
    expect(text).toBe('PERDIDA');
    expect(stampCodes('SEÑAL').map((i) => STAMP_CHARS[i]).join('')).toBe('SEÑAL');
  });
});
