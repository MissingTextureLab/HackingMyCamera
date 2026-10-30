import { describe, expect, it } from 'vitest';
import { EffectValidationError, parseEffect, serializeEffect, validateEffect } from '../src/graph/validate';
import { PRESETS } from '../src/presets';

const minimal = () => ({
  id: 'prueba',
  code: '99',
  name: 'Prueba',
  version: 1,
  nodes: { c: { op: 'camera' }, h: { op: 'hue', in: ['c'], params: { amount: 0.2 } } },
  outputs: { o0: 'h' },
  display: 'o0',
  macros: [{ label: 'TONO', target: 'h.amount', range: [0, 1] }],
  mods: [],
});

const problems = (input: unknown): string[] => {
  try {
    validateEffect(input);
  } catch (e) {
    if (e instanceof EffectValidationError) return e.problems;
    throw e;
  }
  return [];
};

describe('validateEffect', () => {
  it('accepts every preset and round-trips through JSON', () => {
    for (const p of PRESETS) {
      expect(parseEffect(serializeEffect(p))).toEqual(p);
    }
  });

  it('accepts a minimal hand-written effect', () => {
    expect(validateEffect(minimal()).nodes.h.params).toEqual({ amount: 0.2 });
  });

  it('reports every problem with its path', () => {
    const bad = {
      ...minimal(),
      id: 'Bad Id',
      nodes: {
        c: { op: 'camera' },
        h: { op: 'hue', in: ['nope'], params: { amount: 'x', extra: 1 } },
        z: { op: 'zap' },
      },
      outputs: { o5: 'h' },
    };
    const p = problems(bad);
    expect(p).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^id:/),
        expect.stringMatching(/^nodes\.h\.in: input "nope"/),
        expect.stringMatching(/^nodes\.h\.params\.amount: must be a finite number/),
        expect.stringMatching(/^nodes\.h\.params\.extra: "hue" has no param/),
        expect.stringMatching(/^nodes\.z\.op: unknown op/),
        expect.stringMatching(/^outputs\.o5:/),
        expect.stringMatching(/^display: o0 is never written/),
      ]),
    );
  });

  it('checks macros and mods', () => {
    const g = minimal();
    const p = problems({
      ...g,
      nodes: { ...g.nodes, b: { op: 'buffer', params: { index: 0 } } },
      macros: [{ label: 'TONO', target: 'h.amount', range: [0] }, { label: 'B', target: 'b.index', range: [0, 3] }],
      mods: [
        { target: 'h.amount', source: { kind: 'lfo', shape: 'sine', rate: 1 }, range: [0, 1] },
        { target: 'h.amount', source: { kind: 'lfo', shape: 'wobble', rate: 1 }, range: [0, 1] },
        { target: 'h.amount', source: { kind: 'touch', channel: 'z' }, range: [0, 1], smooth: 1 },
      ],
    });
    expect(p).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^macros\[0\]\.range/),
        expect.stringMatching(/^macros\[1\]\.target: "index" is fixed/),
        expect.stringMatching(/^mods\[1\]\.source\.shape/),
        expect.stringMatching(/^mods\[2\]\.source\.channel/),
        expect.stringMatching(/^mods\[2\]\.smooth/),
      ]),
    );
  });

  it('flags a mod on a macro param', () => {
    const g = minimal();
    const p = problems({ ...g, mods: [{ target: 'h.amount', source: { kind: 'touch', channel: 'x' }, range: [0, 1] }] });
    expect(p).toEqual([expect.stringMatching(/already a macro/)]);
  });

  it('surfaces compile errors such as cycles', () => {
    const g = minimal();
    const p = problems({ ...g, nodes: { a: { op: 'hue', in: ['b'] }, b: { op: 'hue', in: ['a'] } }, outputs: { o0: 'a' }, macros: [] });
    expect(p).toEqual([expect.stringMatching(/cycle/)]);
  });

  it('rejects broken JSON text clearly', () => {
    expect(() => parseEffect('{ nope')).toThrow(/\(json\)/);
  });
});
