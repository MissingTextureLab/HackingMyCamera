// `?diag`: can a worker reach WebGPU? The engine runs in one (src/render/worker.ts), so this is the check that counts.

const scope = self as unknown as { postMessage(m: unknown): void };

async function check() {
  const gpu = !!navigator.gpu;
  const req = (o?: GPURequestAdapterOptions) => navigator.gpu.requestAdapter(o).catch(() => null);
  // like Engine.create: a compatibility-mode adapter counts too
  const adapter = gpu ? !!((await req()) ?? (await req({ featureLevel: 'compatibility' } as GPURequestAdapterOptions))) : false;
  let offscreenWebgpu = false;
  try {
    offscreenWebgpu = !!new OffscreenCanvas(1, 1).getContext('webgpu');
  } catch {}
  scope.postMessage({ gpu, adapter, offscreenWebgpu });
}

check();
