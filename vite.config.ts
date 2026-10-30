import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// `pnpm dev:tunnel` runs in mode "tunnel": the page is then served by a
// cloudflared quick tunnel on https :443, so the HMR socket must connect there too.
// `pnpm build:pages` runs in mode "pages": GitHub Pages serves the app under
// /HackingMyCamera/, so every URL (and the service worker scope) needs that base.
export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/HackingMyCamera/' : '/',
  plugins: [
    svelte(),
    // Installable, full screen, works offline after the first visit (the camera
    // itself needs no network). Fonts are bundled, so everything is precached.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Hacking My Camera',
        short_name: 'HMC',
        description: 'Cámara-instrumento: la cámara del móvil a través de un motor de efectos propio.',
        lang: 'es',
        start_url: '.',
        scope: '.',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'portrait',
        background_color: '#201533',
        theme_color: '#201533',
        categories: ['photo', 'multimedia'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' as const },
  server: {
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    hmr: mode === 'tunnel' ? { clientPort: 443, protocol: 'wss' } : undefined,
  },
}));
