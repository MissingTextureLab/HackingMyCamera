import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// `pnpm dev:tunnel` runs in mode "tunnel": the page is then served by a
// cloudflared quick tunnel on https :443, so the HMR socket must connect there too.
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  worker: { format: 'es' as const },
  server: {
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    hmr: mode === 'tunnel' ? { clientPort: 443, protocol: 'wss' } : undefined,
  },
}));
