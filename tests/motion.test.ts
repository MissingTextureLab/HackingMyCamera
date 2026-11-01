import { describe, expect, it } from 'vitest';
import { cam, effect, o } from '../src/dsl';
import { compileEffect, MAX_PASS_INPUTS } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';

// Block-matching motion (F1 of PLAN-DATAMOSH.md): the camera against the camera
// at the last tick, with last tick's vectors kept in o2.
const probe = () =>
  effect({ id: 'm', code: '00', name: 'M' }, (m) => {
    cam().latch(o(3)).out(3);
    const mv = cam().motion(o(3), o(2), 0.9, 0.012);
    mv.out(2);
    m.twist('SOSTÉN', mv, 'sustain', 0.5, 0.97);
    cam().scope(mv, 1).out(0);
  });

const motionId = (g: ReturnType<typeof probe>) => Object.keys(g.nodes).find((id) => g.nodes[id].op === 'motion')!;

describe('motion', () => {
  it('takes three images and two params in the graph', () => {
    const g = probe();
    const node = g.nodes[motionId(g)];
    expect(node.in).toHaveLength(3);
    expect(Object.keys(node.params!)).toEqual(['sustain', 'calm']);
  });

  it('survives validation', () => {
    expect(() => validateEffect(JSON.parse(JSON.stringify(probe())))).not.toThrow();
  });

  it('runs as luma at 1/2, one texel per block at 1/16, then full resolution', () => {
    const g = probe();
    const id = motionId(g);
    const c = compileEffect(g);
    const scale = (t: string) => c.temps.find((x) => x.id === t)?.scale;
    expect(scale(`${id}#0`)).toBe(0.5);
    expect(scale(`${id}#1`)).toBe(0.0625);
    expect(scale(id)).toBe(1);
  });

  it('never reads more textures than a pass can bind', () => {
    const c = compileEffect(probe());
    const temps = new Set(c.temps.map((t) => t.id));
    for (const p of c.passes) {
      expect(p.inputs.length).toBeLessThanOrEqual(MAX_PASS_INPUTS);
      for (const input of p.inputs) expect(temps.has(input)).toBe(true);
    }
  });

  it('feeds the vectors of the last tick to the search and to the memory pass', () => {
    const g = probe();
    const id = motionId(g);
    const c = compileEffect(g);
    const stateTemp = g.nodes[id].in![2];
    const search = c.passes.find((p) => p.target.kind === 'temp' && p.target.id === `${id}#1`)!;
    const memory = c.passes.find((p) => p.target.kind === 'temp' && p.target.id === id)!;
    expect(search.inputs).toEqual([`${id}#0`, stateTemp]);
    expect(memory.inputs).toEqual([`${id}#1`, stateTemp]);
    // the vectors go back into o2
    const write = c.passes.find((p) => p.target.kind === 'output' && p.target.id === 'o2')!;
    expect(write.inputs).toEqual([id]);
  });

  it('only searches and updates on camera ticks', () => {
    const g = probe();
    const id = motionId(g);
    const c = compileEffect(g);
    for (const t of [`${id}#1`, id]) {
      const pass = c.passes.find((p) => p.target.kind === 'temp' && p.target.id === t)!;
      expect(pass.wgsl).toContain('G.camFit.w < 0.5');
      expect(pass.wgsl).toContain('fn mvDecode');
    }
  });

  it('exposes sustain as a macro slot', () => {
    const c = compileEffect(probe());
    const macro = c.macros[0];
    expect(macro.label).toBe('SOSTÉN');
    expect(Object.values(c.slots)).toContain(macro.slot);
    expect(macro.gesture).toBe(2);
  });
});

describe('scope', () => {
  it('draws over an image and a motion map in one pass', () => {
    const c = compileEffect(probe());
    const scope = c.passes.find((p) => p.wgsl.includes('fn seg('))!;
    expect(scope.inputs).toHaveLength(2);
    // nothing reads it, so it renders straight into the output
    expect(scope.target).toEqual({ kind: 'output', id: 'o0' });
  });
});
