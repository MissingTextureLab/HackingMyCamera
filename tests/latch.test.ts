import { describe, expect, it } from 'vitest';
import { cam, effect, o } from '../src/dsl';
import { compileEffect } from '../src/graph/compile';
import { validateEffect } from '../src/graph/validate';

// "Camera tick": camera frames arrive at ~30 fps on a 60 fps render loop, so
// stateful effects step on G.camFit.w (set per stage by the engine) and `latch`
// keeps a buffer as the camera at the last tick.
const holdCamera = () =>
  effect({ id: 'l', code: '00', name: 'L' }, () => {
    cam().latch(o(3)).out(3);
    cam().out(0);
  });

describe('latch', () => {
  it('is a two-input node in the graph', () => {
    const g = holdCamera();
    const latch = Object.values(g.nodes).find((n) => n.op === 'latch')!;
    expect(latch.in).toHaveLength(2);
    expect(latch.params).toBeUndefined();
  });

  it('survives validation', () => {
    expect(() => validateEffect(JSON.parse(JSON.stringify(holdCamera())))).not.toThrow();
  });

  it('selects on the camera tick and reads its own buffer from the previous frame', () => {
    const c = compileEffect(holdCamera());
    const pass = c.passes.find((p) => p.target.kind === 'output' && p.target.id === 'o3')!;
    expect(pass.wgsl).toContain('fn op_latch');
    expect(pass.wgsl).toContain('G.camFit.w > 0.5');
    expect(pass.wgsl).toContain('sampleCam(uv)');
    expect(pass.wgsl).toContain('textureSampleLevel(t_o3, samp, uv, 0.0)');
  });

  it('stays fused: no extra pass, no uniforms', () => {
    const c = compileEffect(holdCamera());
    expect(c.passes).toHaveLength(2);
    expect(Object.keys(c.slots)).toHaveLength(0);
  });
});
