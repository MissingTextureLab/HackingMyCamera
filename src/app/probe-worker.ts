// `?diag`: can a worker reach WebGPU? The engine runs in one (src/render/worker.ts), so this is the check that counts.

const scope = self as unknown as { postMessage(m: unknown): void };

async function check() {
  const gpu = !!navigator.gpu;
  const adapter = gpu ? !!(await navigator.gpu.requestAdapter().catch(() => null)) : false;
  let offscreenWebgpu = false;
  try {
    offscreenWebgpu = !!new OffscreenCanvas(1, 1).getContext('webgpu');
  } catch {}
  scope.postMessage({ gpu, adapter, offscreenWebgpu });
}

check();
