# Hacking My Camera

Camera-instrument PWA for Android: the phone camera runs through our own WebGPU effects engine (Hydra / TouchDesigner aesthetics, no hydra-synth), takes photos and records mp4.

- Architecture and milestones: `PLAN.md` (§10 holds the decisions taken).
- Visual identity: `DESIGN.md` + `design-tokens.json` (mirrored in `src/styles/tokens.css`). Every UI change follows it: Citrink colours only, Rubik Glitch ≥ 30 px, Martian Mono labels, Doto readouts, no shadows/blur/transparency, sabotage only on events. Published design system: https://claude.ai/artifact/WEhnfzQVEAveVo2Lfpj2qg
- UI copy is Spanish, caps, short. Code and comments in English.

## Commands

```sh
pnpm dev          # vite on :5173 (host exposed for the phone)
pnpm test         # vitest (engine: DSL + compiler)
pnpm check        # svelte-check
pnpm build        # PWA: manifest + Workbox service worker (precaches app, worker and fonts)
pnpm preview      # serve the build (the service worker only runs here, not in dev)
node scripts/icons.mjs   # re-rasterize public/icon-*.png after changing the icon (keep in sync with public/icon.svg)
```

Fonts are bundled from `@fontsource/*` (imported in `src/main.ts`); there are no requests to Google Fonts, so the installed app works offline.

`?source=test` forces the animated test card instead of the camera (desktop, no webcam).

### Deployment

Live at https://missingtexturelab.github.io/HackingMyCamera/ (repo `MissingTextureLab/HackingMyCamera`, public). Every push to `main` runs `.github/workflows/pages.yml`: tests, `pnpm build:pages` (base `/HackingMyCamera/`), deploy. Install on the phone from Chrome: ⋮ → Install app.

### Testing on the phone (camera needs HTTPS)

```sh
pnpm dev:tunnel   # vite on :5174 in mode "tunnel" (HMR over wss :443)
pnpm tunnel       # cloudflared quick tunnel → prints https://<random>.trycloudflare.com
```

Open the printed URL in Chrome on the phone. The URL changes every time the tunnel restarts.

### Windows: Controlled Folder Access

This machine has Defender's Controlled Folder Access on, and the repo lives under `Documents`. Node is blocked from creating files there, so Vite, Vitest and svelte-check **hang silently** (or fail with ENOENT in `node_modules/.vite-temp`). Until node.exe is allowed or the repo moves out of `Documents`, run tools from a mirror:

```sh
sh scripts/mirror.sh <dir outside Documents>   # copies sources, installs once
```

`.claude/launch.json` has a `dev-mirror` config (port 5174) pointing at the session scratchpad mirror; re-run the mirror script after editing.

## Layout

```
src/graph/     types.ts (EffectGraph JSON, mods), compile.ts (graph → ordered passes: fused WGSL,
               materialized only where a filter reads neighbours), validate.ts (JSON → checked graph)
src/ops/       registry.ts: every op as a WGSL snippet + params; filters as pass lists; PRELUDE helpers, Citrink ramp
src/dsl/       chainable Hydra-style builder → EffectGraph (pure, no GPU); m.macro / m.mod
src/signals/   LFO + touch sources, mapped onto params every frame (runs in the worker)
src/presets/   gallery effects written with the DSL
src/gpu/       engine.ts: Engine (device, pipelines, camera texture) + Stage per surface
               (viewfinder, each live thumbnail): o0–o3 ping-pong, temps, present + xerox pass
src/render/    worker.ts (owns GPU, canvases, camera frames, recorder, signals), protocol.ts (messages)
src/io/        camera.ts: getUserMedia → MediaStreamTrackProcessor → transferred stream; hardware zoom
               motion.ts: DeviceOrientation tilt relative to a reference pose (the `motion` signal)
src/capture/   recorder.ts: Mediabunny CanvasSource → mp4 (video only)
src/app/       Svelte 5 UI (App, Shutter, EffectStrip) and gestures.ts (drag / pinch / twist / double tap)
```

## Engine rules

- Ops follow the kind signatures documented at the top of `src/ops/registry.ts`; the compiler depends on them.
- Param values are uniforms (`P[]`), so changing values never recompiles; only structure does. Structural params (buffer index) are baked.
- Buffer reads (`o(i)`) always see the previous frame.
- Filters (blur, edge, sharpen, displace, bloom) read neighbours, so their inputs are rendered to temp textures; keep chains fused otherwise. A pass reads at most 4 temps.
- 3D scenes (`render3d` ops: relief, cloud, city) build geometry from `vertex_index` (no vertex buffers), render with a depth buffer into a temp, and read params via generated `p_<name>()` accessors so the vertex stage can use them.
- Processors (`kind: 'processor'`, e.g. `sort`) are compute shaders: one workgroup per output column, read their input through `samp`, write a storage temp (rgba16float). Bindings: `COMPUTE_HEADER` in compile.ts.
- The present pass is the house look ("revelado", DESIGN.md): S curve, Citrink gradient map, 2 px Bayer dither (`HOUSE` in engine.ts) and, on captures only, the date-back stamp (Doto atlas, `Stage.stamp` / `setStampText`). Design effects to read well through it.
- Binding 8 of group 0 is LETRA's glyph atlas (`src/gpu/glyphs.ts`, built in the worker from Martian Mono and sorted by ink density).
- Signals: `lfo`, `touch`, `motion` (tilt, currently unused by presets) and `event` (`shot` pulses on photo / start of recording).
- Patching under Documents: when Edit/Write fail with ENOENT on a `.tmp` file (Controlled Folder Access), apply changes with a Node script that edits files in place.
- WGSL reserved words bite (`target`, `module`, …): avoid them as names in snippets; the engine shows compile errors as an on-screen notice.
- Effects from outside the code (files, editor) go through `validateEffect`; the worker validates every graph it receives.
- Macros are axes between two named poles (`m.macro([pole, pole], [[chain, param, from, to], …], at)`): never "off → max", both ends must be strong looks; one axis moves several params; `at` is the resting position the compiler writes into the initial uniforms. A param belongs to at most one macro, and is either a macro target or a mod (signals), never both.
- No microphone: the user doesn't want audio input or audio in recordings.
- Canvas reads for photo/recording must happen in the same task right after `queue.submit` (see `loop` in the worker).
- Render size: long side capped at 1920, even dimensions (H.264).
- Never copy code from hydra-synth (AGPL); names and ideas only.
