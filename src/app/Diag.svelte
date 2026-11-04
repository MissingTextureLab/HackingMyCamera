<script lang="ts">
  import { onMount } from 'svelte';
  import { probe, type Probe } from './probe';
  import { proposeTier, reportRows, reportText, type Tier } from './report';

  let step = $state('');
  let failed = $state<string | null>(null);
  let result = $state<Probe | null>(null);
  let sent = $state<string | null>(null);
  /** Shown when the clipboard is refused: the report as text to select by hand. */
  let raw = $state<string | null>(null);

  const verdict = $derived(result ? proposeTier(result) : null);
  // NIVEL is shown big, the rest as rows
  const rows = $derived(result ? reportRows(result).filter(([k]) => k !== 'NIVEL') : []);
  const TIER_NAME: Record<Tier, string> = { A: 'COMPLETO', B: 'LIGERO', C: 'COMPATIBLE', '-': 'SIN GPU' };
  const fmt = (v: number | undefined) => (v === undefined ? '--' : v.toFixed(1));

  onMount(() => {
    probe((s) => (step = s))
      .then((p) => (result = p))
      .catch((e) => (failed = String(e instanceof Error ? e.message : e).toUpperCase()));
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(reportText(result!));
      sent = 'COPIADO';
    } catch {
      sent = 'NO SE PUDO COPIAR · MANTÉN PULSADO EL TEXTO';
      raw = reportText(result!);
    }
  }
  // the Android share sheet goes straight to WhatsApp & co.; the clipboard where there is none
  async function share() {
    if (!navigator.share) return copy();
    try {
      await navigator.share({ text: reportText(result!) });
      sent = 'ENVIADO';
    } catch (e) {
      if ((e as Error).name !== 'AbortError') await copy();
    }
  }
</script>

<main class="diag">
  <h1>DIAGNÓSTICO</h1>

  {#if !result}
    <p class="label status">{failed ?? `MIDIENDO · ${step}`}</p>
  {:else}
    <div class="readouts">
      <div class="cell a">
        <span class="k label">NIVEL</span>
        <span class="v">{verdict!.tier === '-' ? '--' : verdict!.tier}</span>
      </div>
      <div class="cell">
        <span class="k label">WEBGPU MS</span>
        <span class="v">{fmt(result.gpu?.benchMs)}</span>
      </div>
      <div class="cell">
        <span class="k label">WEBGL2 MS</span>
        <span class="v">{fmt(result.gl.benchMs)}</span>
      </div>
    </div>
    <p class="label why">{TIER_NAME[verdict!.tier]}{#each verdict!.reasons as r} · {r}{/each}</p>

    <dl>
      {#each rows as [k, v]}
        <dt class="label">{k}</dt>
        <dd class="label">{v}</dd>
      {/each}
    </dl>

    <div class="actions">
      <button class="label" onclick={share}>ENVIAR</button>
      <button class="label" onclick={copy}>COPIAR</button>
      <button class="label" onclick={() => location.replace(location.pathname)}>VOLVER</button>
    </div>
    {#if sent}<p class="label sent">{sent}</p>{/if}
    {#if raw}<pre class="raw">{raw}</pre>{/if}
  {/if}
</main>

<style>
  /* body never scrolls (the viewfinder owns it): this screen scrolls itself */
  .diag {
    position: fixed;
    inset: 0;
    overflow-y: auto;
    box-sizing: border-box;
    padding: var(--space-6) var(--space-4) var(--space-12);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 400;
    font-size: 36px;
    line-height: 1;
  }
  .status {
    color: var(--ink-muted);
  }

  .readouts {
    display: flex;
    gap: var(--space-2);
  }
  /* a header bar over a scan-line body (DESIGN.md, Capa HUD), as in the viewfinder readout */
  .cell {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  /* no plates on this screen: labels and readouts sit straight on the floor */
  .cell .k {
    color: var(--ink-muted);
    padding: var(--space-1) 0;
    border-bottom: 1px solid var(--lagoon);
  }
  .cell.a .k {
    color: var(--acid);
    border-bottom-color: var(--acid);
  }
  .cell .v {
    padding: var(--space-2) 0;
    font-family: var(--font-dot);
    font-size: 32px;
    line-height: 1;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .why {
    margin: 0;
    color: var(--ink);
  }

  dl {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2) var(--space-3);
    border-top: 1px solid var(--lagoon);
    padding-top: var(--space-3);
    user-select: text;
    -webkit-user-select: text;
  }
  dt {
    color: var(--ink-muted);
  }
  dd {
    margin: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
    text-transform: none;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  button {
    min-height: 48px;
    padding: 0 var(--space-4);
    border: 1px solid var(--lagoon);
    border-radius: var(--radius-0);
    background: none;
    color: var(--ink);
    cursor: pointer;
  }
  button:active {
    border-color: var(--acid);
    color: var(--acid);
  }
  .raw {
    margin: 0;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--lagoon);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 14px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
  .sent {
    align-self: flex-start;
    margin: 0;
    color: var(--flash);
  }
</style>
