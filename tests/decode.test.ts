import { describe, expect, it } from 'vitest';
import { cam, effect, o } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';
import { OPS } from '../src/ops/registry';

// The datamosh decoder (F2 of PLAN-DATAMOSH.md), a port of niccolofanton/data-mosh.
const mosh = () =>
  effect({ id: 'd', code: '00', name: 'D' }, () => {
    cam().latch(o(3)).out(3);
    const mv = cam().motion(o(3), o(2));
    mv.out(2);
    const rec = cam().decode(o(1), mv);
    rec.out(1);
    rec.out(0);
  });

const decodeId = (g: ReturnType<typeof mosh>) => Object.keys(g.nodes).find((id) => g.nodes[id].op === 'decode')!;

describe('decode', () => {
  it("keeps the original's defaults", () => {
    const defaults = Object.fromEntries(OPS.decode.params.map((p) => [p.name, p.default]));
    expect(defaults).toMatchObject({
      motionGain: 1.5,
      blockSize: 8,
      blockiness: 1,
      mvPrecision: 2,
      skipThreshold: 0,
      mismatch: 0,
      frozenBlocks: 1,
      lostLayers: 4,
      lostLife: 50,
      lostScale: 2.65,
      lostAspect: 0.75,
      lostVariance: 1,
      residualGain: 0.4,
      residualQuant: 14,
      recover: 1,
      keyframe: 0,
    });
  });

  it('reads the camera, its own last output and the motion map', () => {
    const g = mosh();
    const id = decodeId(g);
    const c = compileEffect(g);
    const pass = c.passes.find((p) => p.target.kind === 'temp' && p.target.id === id)!;
    expect(pass.inputs).toHaveLength(3);
    // its second input is o1, the buffer it writes: the decoder's reference frame
    const history = g.nodes[id].in![1];
    expect(g.nodes[history]).toEqual({ op: 'buffer', params: { index: 1 } });
    expect(c.passes.find((p) => p.target.kind === 'output' && p.target.id === 'o1')!.inputs).toEqual([id]);
  });

  it('holds between camera ticks and keeps the decode steps', () => {
    const g = mosh();
    const c = compileEffect(g);
    const w = c.passes.find((p) => p.target.kind === 'temp' && p.target.id === decodeId(g))!.wgsl;
    expect(w).toContain('G.camFit.w < 0.5');
    for (const fn of ['fn lostRegion', 'fn sampleHistory', 'fn residualAt', 'fn arrowAt', 'fn rawMotionAt']) {
      expect(w).toContain(fn);
    }
  });

  it('renders straight into its output when nothing else reads it', () => {
    const g = effect({ id: 'x', code: '00', name: 'X' }, () => {
      cam().sharpen(1).out(0);
    });
    const c = compileEffect(g);
    const last = c.passes[c.passes.length - 1];
    expect(last.target).toEqual({ kind: 'output', id: 'o0' });
    expect(c.temps.map((t) => t.id)).toHaveLength(1); // the camera; no copy of the result
  });

  it('does not for a filter that runs below full resolution', () => {
    const g = effect({ id: 'y', code: '00', name: 'Y' }, () => {
      cam().blur(4).out(0);
    });
    const c = compileEffect(g);
    // its half-resolution result is a temp that the output pass upsamples
    expect(c.temps.some((t) => t.scale === 0.5 && t.id.startsWith('blur'))).toBe(true);
    expect(c.passes.at(-1)!.inputs).toEqual([c.passes.at(-2)!.target.id]);
  });

  it('keeps a copy when two outputs or another node read the filter', () => {
    const c = compileEffect(mosh()); // decode is the root of o0 and o1
    expect(c.passes.filter((p) => p.target.kind === 'output' && ['o0', 'o1'].includes(p.target.id))).toHaveLength(2);
  });

  it('latent defaults to 0, so the port stays literal', () => {
    expect(OPS.decode.params.find((p) => p.name === 'latent')!.default).toBe(0);
  });

  it('survives validation', () => {
    expect(() => validateEffect(JSON.parse(JSON.stringify(mosh())))).not.toThrow();
  });
});
