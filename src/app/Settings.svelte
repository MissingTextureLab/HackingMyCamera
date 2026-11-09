<script lang="ts">
  // Capture settings: size, rate and quality. Camera size and rate restart the camera.
  import { SIDES, type Settings } from './settings';

  interface Props {
    settings: Settings;
    onchange: (patch: Partial<Settings>) => void;
    onclose: () => void;
  }
  let { settings, onchange, onclose }: Props = $props();

  const FPS = [30, 60] as const;
  const QUALITY = [
    { value: 0, label: 'BAJA' },
    { value: 1, label: 'MEDIA' },
    { value: 2, label: 'ALTA' },
  ] as const;
</script>

<div class="settings" role="dialog" aria-label="Ajustes de captura">
  <header>
    <button class="label tool" type="button" onclick={onclose}>CERRAR</button>
    <span class="label title">AJUSTES</span>
  </header>

  <section>
    <h2 class="label">RESOLUCIÓN</h2>
    <div class="opts">
      {#each SIDES as o (o.value)}
        <button class="label tool" type="button" aria-pressed={settings.side === o.value} onclick={() => onchange({ side: o.value })}>{o.label}</button>
      {/each}
    </div>
  </section>

  <section>
    <h2 class="label">FPS</h2>
    <div class="opts">
      {#each FPS as f (f)}
        <button class="label tool" type="button" aria-pressed={settings.fps === f} onclick={() => onchange({ fps: f })}>{f}</button>
      {/each}
    </div>
  </section>

  <section>
    <h2 class="label">CALIDAD</h2>
    <div class="opts">
      {#each QUALITY as o (o.value)}
        <button class="label tool" type="button" aria-pressed={settings.quality === o.value} onclick={() => onchange({ quality: o.value })}>{o.label}</button>
      {/each}
    </div>
  </section>

  <p class="hint label">MANTÉN PULSADO UN EFECTO PARA MARCARLO FAVORITO. LOS FAVORITOS VAN PRIMERO.</p>
</div>

<style>
  .settings {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: var(--viewfinder);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: env(safe-area-inset-top, 0px) var(--space-4) env(safe-area-inset-bottom, 0px);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--lagoon);
  }
  .title {
    color: var(--ink-muted);
  }
  h2 {
    margin: 0 0 var(--space-2);
    color: var(--ink-muted);
    font-weight: 400;
  }
  .opts {
    display: flex;
    gap: var(--space-2);
  }
  .tool {
    min-height: 48px;
    padding: 0 var(--space-3);
    border: 1px solid var(--lagoon);
    border-radius: var(--radius-0);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
  .opts .tool {
    flex: 1;
  }
  .tool[aria-pressed='true'] {
    background: var(--acid);
    border-color: var(--acid);
    color: var(--ink-fixed);
  }
  .tool:focus-visible {
    outline: var(--stroke) solid var(--focus);
  }
  .hint {
    margin: 0;
    color: var(--ink-muted);
  }
</style>
