import { describe, expect, it } from 'vitest';
import { GlEngine } from '../src/gpu/gl-engine';
import { wgslToGlsl } from '../src/gpu/glsl';
import { needs3d, needsCompute } from '../src/graph/compile';
import { compileEffect } from '../src/graph/compile';
import { PRESETS } from '../src/presets';

describe('WGSL → GLSL', () => {
  it('translates a small module with typed lets, int literals in float context and array locals', () => {
    const out = wgslToGlsl(`
fn f(x: f32, v: vec3f) -> vec3f {
  let k = 2;
  var w = array<f32, 3>(0.5, 1, 2);
  var acc = v * 2;
  for (var i = 0; i < 3; i++) { acc += w[i] * f32(k); }
  return select(acc, vec3f(1), x > 0.5);
}`);
    expect(out).toContain('vec3 f(float x, vec3 v)');
    expect(out).toContain('int k = 2;');
    expect(out).toContain('float[3] w = float[3](0.5, 1.0, 2.0);');
    expect(out).toContain('vec3 acc = (v * 2.0);');
    expect(out).toContain('(x > 0.5)');
  });

  it('renames GLSL keywords and uses lessThan for vector comparisons', () => {
    const out = wgslToGlsl(`fn g(a: vec2f, b: vec2f) -> bool { let half = 1.0; return all(a < b) && half > 0.0; }`);
    expect(out).toContain('half_');
    expect(out).toContain('lessThan(a, b)');
  });

  it('builds a full fragment shader for every effect the WebGL2 backend can run', () => {
    const gl = PRESETS.filter((p) => !needsCompute(p) && !needs3d(p));
    expect(gl.length).toBe(PRESETS.length - 4); // ORDEN, RELIEVE, CIUDAD, TALLA stay WebGPU-only
    for (const graph of gl) {
      for (const pass of compileEffect(graph).passes) {
        const src = GlEngine.fragmentSource(pass);
        expect(src, graph.id).toContain('void main()');
        expect(src, graph.id).not.toContain('in.uv');
      }
    }
  });

  it('translates every 2D pass of every preset', () => {
    const errors: string[] = [];
    for (const graph of PRESETS) {
      for (const [i, pass] of compileEffect(graph).passes.entries()) {
        if (!pass.body) continue; // processors and 3D scenes
        try {
          wgslToGlsl(pass.body);
        } catch (e) {
          errors.push(`${graph.id} pass ${i}: ${(e as Error).message}`);
        }
      }
    }
    expect(errors).toEqual([]);
  });
});
