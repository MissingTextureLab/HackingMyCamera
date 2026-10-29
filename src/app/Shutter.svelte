<script lang="ts">
  // Tap: photo. Hold: record while held (DESIGN.md, Viewfinder).
  interface Props {
    recording: boolean;
    onphoto: () => void;
    onrecstart: () => void;
    onrecstop: () => void;
  }
  let { recording, onphoto, onrecstart, onrecstop }: Props = $props();

  const HOLD_MS = 350;
  let down = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holding = false;

  function press(e: PointerEvent) {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    down = true;
    holding = false;
    timer = setTimeout(() => {
      holding = true;
      onrecstart();
    }, HOLD_MS);
  }

  function release() {
    if (!down) return;
    down = false;
    clearTimeout(timer);
    if (holding) onrecstop();
    else onphoto();
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onphoto();
    }
  }
</script>

<button
  class="shutter"
  class:down
  class:rec={recording}
  type="button"
  aria-label="Foto; mantener para grabar"
  onpointerdown={press}
  onpointerup={release}
  onpointercancel={release}
  onkeydown={key}
><i></i></button>

<style>
  .shutter {
    justify-self: center;
    width: 76px;
    height: 76px;
    border-radius: var(--radius-knob);
    background: var(--panel);
    border: 2px solid var(--ink);
    display: grid;
    place-items: center;
    padding: 0;
    cursor: pointer;
    touch-action: none;
  }
  .shutter:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  i {
    display: block;
    width: 52px;
    height: 52px;
    border-radius: var(--radius-knob);
    background: var(--ink);
    transition:
      background var(--tick) var(--ease-step),
      width var(--tick) var(--ease-step),
      height var(--tick) var(--ease-step),
      border-radius var(--tick) var(--ease-step);
  }
  .down i {
    background: var(--panel-deep);
  }
  .rec i {
    background: var(--flash);
    width: 28px;
    height: 28px;
    border-radius: var(--radius-0);
  }
</style>
