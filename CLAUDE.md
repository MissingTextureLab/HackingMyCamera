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
pnpm build
```

`?source=test` forces the animated test card instead of the camera (desktop, no webcam).

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
src/graph/     types.ts (EffectGraph JSON), compile.ts (graph → fused WGSL per output buffer)
src/ops/       registry.ts: every op as a WGSL snippet + params; PRELUDE helpers, Citrink ramp
src/dsl/       chainable Hydra-style builder → EffectGraph (pure, no GPU)
src/presets/   gallery effects written with the DSL
src/gpu/       engine.ts: WebGPU runtime (buffers o0–o3 ping-pong rgba16float, present + xerox pass, test card, timestamp queries)
src/render/    worker.ts (owns GPU, canvas, camera frames, recorder), protocol.ts (messages)
src/io/        camera.ts: getUserMedia → MediaStreamTrackProcessor → transferred stream
src/capture/   recorder.ts: Mediabunny CanvasSource → mp4 (video only for now)
src/app/       Svelte 5 UI (App, Shutter, EffectStrip)
```

## Engine rules

- Ops follow the kind signatures documented at the top of `src/ops/registry.ts`; the compiler depends on them.
- Param values are uniforms (`P[]`), so changing values never recompiles; only structure does. Structural params (buffer index) are baked.
- Buffer reads (`o(i)`) always see the previous frame.
- Canvas reads for photo/recording must happen in the same task right after `queue.submit` (see `loop` in the worker).
- Render size: long side capped at 1920, even dimensions (H.264).
- Never copy code from hydra-synth (AGPL); names and ideas only.
