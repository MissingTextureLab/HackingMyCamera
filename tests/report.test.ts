import { describe, expect, it } from 'vitest';
import type { GpuProbe, Probe } from '../src/app/probe';
import { FAST_MS, proposeTier, reportRows, reportText } from '../src/app/report';

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const gpu = (o: Partial<GpuProbe> = {}): GpuProbe => ({
  attempts: { hp: true, plain: true, fallback: false },
  vendor: 'qualcomm',
  architecture: 'adreno-8xx',
  software: false,
  features: ['timestamp-query'],
  limits: { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 2 ** 27, maxComputeInvocationsPerWorkgroup: 256, maxColorAttachments: 8 },
  device: true,
  benchMs: 4,
  ...o,
});

const probe = (o: Partial<Probe> = {}): Probe => ({
  date: '2026-11-04',
  env: { ua: UA, secure: true, android: 14, model: 'SM-S928B' },
  screen: '412x915@3.5',
  standalone: false,
  gpu: gpu(),
  worker: { gpu: true, adapter: true, offscreenWebgpu: true },
  gl: { ok: true, renderer: 'Adreno (TM) 830', floatRT: true, halfFloatRT: true, floatLinear: true, benchMs: 5 },
  media: { camera: true, trackProcessor: true, videoEncoder: true, avc1080: true, recorderMp4: true },
  ...o,
});

const noAdapter = gpu({ attempts: { hp: false, plain: false, fallback: false }, device: false, benchMs: undefined });

describe('?diag tier', () => {
  it('gives A to a fast WebGPU phone', () => {
    expect(proposeTier(probe())).toEqual({ tier: 'A', reasons: [] });
  });

  it('gives B when WebGPU works but the GPU is slow', () => {
    expect(proposeTier(probe({ gpu: gpu({ benchMs: FAST_MS * 2 }) })).tier).toBe('B');
  });

  it('falls to C without an adapter but with WebGL2', () => {
    const t = proposeTier(probe({ gpu: noAdapter }));
    expect(t).toEqual({ tier: 'C', reasons: ['SIN ADAPTADOR'] });
  });

  it('does not count the software adapter as WebGPU', () => {
    const t = proposeTier(probe({ gpu: gpu({ attempts: { hp: false, plain: false, fallback: true }, software: true }) }));
    expect(t.tier).toBe('C');
    expect(t.reasons).toContain('WEBGPU POR SOFTWARE');
  });

  it('needs WebGPU in the worker, where the engine runs', () => {
    expect(proposeTier(probe({ worker: { gpu: true, adapter: false, offscreenWebgpu: false } })).reasons).toContain('SIN WEBGPU EN WORKER');
  });

  it('has nothing to offer without WebGPU and WebGL2', () => {
    const t = proposeTier(probe({ gpu: null, gl: { ok: false, floatRT: false, halfFloatRT: false, floatLinear: false } }));
    expect(t).toEqual({ tier: '-', reasons: ['SIN WEBGPU', 'SIN WEBGL2'] });
  });
});

describe('?diag report', () => {
  it('names the phone and the GPU, and ends with the raw JSON', () => {
    const rows = Object.fromEntries(reportRows(probe({ gpu: noAdapter })));
    expect(rows['MÓVIL']).toBe('SM-S928B · ANDROID 14');
    expect(rows['NAVEGADOR']).toBe('CHROME 130');
    expect(rows['WEBGL2']).toContain('Adreno (TM) 830');
    expect(rows['VELOCIDAD WEBGPU']).toBeUndefined();
    const text = reportText(probe());
    const json = text.split('\n').at(-1)!;
    expect(JSON.parse(json.slice('JSON: '.length)).env.model).toBe('SM-S928B');
  });
});
