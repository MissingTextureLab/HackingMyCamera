# HackingMyCamera — Plan de arquitectura

Cámara-instrumento: PWA a pantalla completa que pasa la imagen de la cámara por un motor de efectos propio con lenguaje visual de Hydra y TouchDesigner, hace fotos y graba vídeo.

Estado (2026-10-30):
- **H1 hecho** y probado en el Android real: motor WebGPU en worker, DSL, compilador con fusión, foto JPEG y vídeo MP4 (WebCodecs + Mediabunny).
- **H2 hecho**, verificado en escritorio con la carta de ajuste; pendiente de probar en el móvil:
  - compilador multipaso y filtros de vecindad (blur, edge, sharpen, displace, bloom a media resolución);
  - gestos (arrastre A/B, pellizco = zoom óptico + digital, giro = macro C, doble toque = reset);
  - señales LFO y tacto;
  - galería de 10 efectos con miniaturas en vivo, cada uno sobre una cuestión visual distinta (ver DESIGN.md, "La galería");
  - formato JSON con validador.
- **H3 hecho**, verificado en escritorio con la carta de ajuste y giroscopio simulado; pendiente de probar en el móvil:
  - nodo `render3d` propio (sin Three.js): geometría generada en la GPU, con profundidad;
  - tres escenas: RELIEVE, NUBE y CIUDAD;
  - señal `motion`: inclinación del móvil.
  - La señal `image` (luminancia y movimiento de la cámara) queda pendiente.
- **H4 en curso:**
  - Hecho y verificado con el build de producción: PWA instalable (manifest a pantalla completa en vertical, icono propio en la identidad), service worker que precachea app, worker y fuentes, y fuentes empaquetadas sin Google Fonts. Funciona sin conexión.
  - Desplegada en GitHub Pages: https://missingtexturelab.github.io/HackingMyCamera/ (repo público `MissingTextureLab/HackingMyCamera`, una Action publica en cada push a `main`).
  - Revisión de la galería (2026-10-30): los 13 efectos rehechos para que cada uno responda a una sola cuestión visual (ver DESIGN.md, "La galería"); escenas 3D con encuadre fijo y balanceo; primer procesador de cómputo (ORDEN).
  - FX-51 PÉRDIDA (2026-11-01): datamosh, port del decodificador de niccolofanton/data-mosh con vectores medidos en la cámara; verificado en escritorio con la carta de ajuste y probado en el Android real. Ver `PLAN-DATAMOSH.md`.
  - Pendiente: cajón de parámetros.
- **Fuera del alcance por decisión del usuario:** micrófono, tanto como señal como audio en la grabación.
- Identidad visual: `DESIGN.md`.

Entorno disponible: Node 22.20, npm 10.9, pnpm 10.20, git 2.49. Falta `cloudflared` (túnel HTTPS para probar en el móvil).

---

## 1. Idea central del motor

Hydra y TouchDesigner son dos interfaces sobre el mismo concepto: **un grafo de operaciones sobre imágenes**. La diferencia está en dónde se materializan las texturas:

- **Hydra** compone funciones. Toda fuente es `vec4 f(vec2 uv)`, las transformaciones de coordenadas se aplican *antes* de muestrear y `modulate` deforma coordenadas con otra fuente. Toda la cadena se compila a **un solo fragment shader**, sin texturas intermedias.
- **TouchDesigner** materializa cada nodo (TOP) en una textura. Eso permite operaciones de vecindad (blur, edge, displace con mapas), multipaso (bloom) y feedback explícito.

**Decisión:** un único modelo de datos (grafo JSON) y un **compilador** que fusiona todo lo fusionable en un pase (estilo Hydra) e inserta un *límite de materialización* (render a textura) solo donde hace falta:

- antes de una operación de vecindad (blur, edge, sharpen, bloom);
- en la lectura de un buffer de feedback;
- cuando un nodo se usa en varios sitios y es caro reevaluarlo (heurística por coste);
- antes de un procesador de cómputo o de un nodo 3D.

Así, la cadena estilo Hydra sale barata (1 pase) y el grafo estilo TD sigue siendo posible sin un motor aparte.

### Taxonomía de operaciones

| Familia | Firma GLSL | Ejemplos | Fusionable |
|---|---|---|---|
| `source` | `vec4 (vec2 uv)` | osc, noise, voronoi, shape, gradient, solid, `src(cam)`, `src(o0)` | sí |
| `coord` | `vec2 (vec2 uv)` | rotate, scale, scroll, pixelate, kaleid, repeat, polar | sí |
| `color` | `vec4 (vec4 c)` | hue, posterize, contrast, colorama, invert, threshold, level, ramp/LUT | sí |
| `combine` | `vec4 (vec4 a, vec4 b)` | blend, add, mult, diff, mask, layer, composite | sí |
| `combineCoord` | `vec2 (vec2 uv, vec4 c)` | modulate, modulateScale, modulateRotate, displace | sí |
| `neighborhood` | pase propio, entrada materializada | blur (separable), edge, sharpen, median, bloom | no |
| `feedback` | buffers ping-pong `o0..o3` | trails, echo, reaction-diffusion | límite |
| `render3d` | pase con geometría | grid desplazado, nube de puntos, instancias | límite |
| `processor` | cómputo (futuro WebGPU) | partículas, flujo óptico, histograma | límite |

**Parámetros:** cada parámetro numérico es un `uniform`. Cambiar un valor o una modulación no recompila; solo un cambio de **estructura** del grafo genera shader nuevo. Los programas se cachean por hash estructural.

---

## 2. Formato del efecto (JSON)

El mismo archivo vale para presets de la galería, para el editor (H5) y para guardar y compartir.

```json
{
  "id": "liquid-mirror",
  "name": "Liquid Mirror",
  "version": 1,
  "nodes": {
    "cam":  { "op": "camera" },
    "n":    { "op": "noise",    "params": { "scale": 3, "speed": 0.15 } },
    "warp": { "op": "modulate", "in": ["cam", "n"], "params": { "amount": 0.08 } },
    "k":    { "op": "kaleid",   "in": ["warp"],     "params": { "sides": 6 } },
    "prev": { "op": "buffer",   "params": { "index": 0 } },
    "trail":{ "op": "scale",    "in": ["prev"],     "params": { "amount": 1.01 } },
    "mix":  { "op": "blend",    "in": ["k", "trail"], "params": { "amount": 0.85 } }
  },
  "outputs": { "o0": "mix" },
  "display": "o0",
  "macros": [
    { "label": "Warp",  "target": "warp.amount", "range": [0, 0.4] },
    { "label": "Trail", "target": "mix.amount",  "range": [0.5, 0.98] }
  ],
  "mods": [
    { "target": "warp.amount", "source": "audio.low", "range": [0.02, 0.3], "smooth": 0.85 },
    { "target": "k.sides",     "source": "touch.x",   "range": [3, 12], "quantize": 1 }
  ]
}
```

- `nodes`: mapa id → `{ op, in?, params? }`. Las entradas se resuelven por id, sin posiciones implícitas.
- `outputs`: qué nodo escribe en cada buffer de salida (`o0..o3`). `buffer` lee el frame anterior de ese buffer.
- `macros`: los 1–3 controles que la UI expone con el gesto XY (ver §7).
- `mods`: enlaces señal → parámetro (ver §4).
- Se valida con un esquema (zod o un validador propio pequeño) al cargarlo. Un efecto inválido no rompe la app: se marca en la galería.

---

## 3. DSL estilo Hydra (TypeScript)

Es azúcar sintáctico que **construye el grafo JSON** de §2. No ejecuta nada por sí mismo.

```ts
const fx = src(cam)
  .modulate(noise(3, 0.15), mod('audio.low', 0.02, 0.3))
  .kaleid(mod('touch.x', 3, 12, { quantize: 1 }))
  .blend(o(0).scale(1.01), 0.85)
  .out(0);

registerEffect('liquid-mirror', fx);   // → mismo JSON que arriba
```

Hay una diferencia deliberada con Hydra. Hydra admite funciones flecha como parámetro (`() => Math.sin(time)`), que no se pueden serializar. Aquí **todo lo dinámico es una modulación declarativa** (`mod(...)`, `lfo(...)`), de modo que cualquier efecto se guarda como JSON, se comparte y se edita en la app.

Más adelante (H5) el DSL puede evaluarse dentro de la app como modo "live coding" sobre texto, con el mismo resultado.

---

## 4. Señales de modulación (el equivalente a los CHOP)

Cada fuente produce escalares por frame en un registro común (`signals.get('audio.low')`).

| Fuente | Canales | Notas |
|---|---|---|
| `time` | `t`, `dt`, `beat` | reloj global, pausable |
| `lfo` | sine, saw, square, tri, random-step, smooth-noise | frecuencia y fase por instancia |
| `audio` | `level`, `low`, `mid`, `high`, `onset` | `AnalyserNode` sobre el micro; FFT agrupada en bandas y detección de onsets por flujo espectral |
| `touch` | `x`, `y`, `down`, `vx`, `vy`, `count`, `pinch` | sobre el canvas; no compite con los gestos de la UI (ver §7) |
| `motion` | `tiltX`, `tiltY`, `shake` | `DeviceOrientation/Motion`; en iOS requiere permiso tras un gesto |
| `image` | `luma`, `motion` | analizando la propia cámara en GPU a 8×8 con lectura asíncrona (sin bloquear el frame) |

Mapeo por enlace: `range`, `curve` (lin/exp/log), `smooth` (filtro de un polo), `quantize`, `invert`. Sin asignaciones por frame: buffers `Float32Array` preasignados.

---

## 5. Capa GPU: WebGPU-only (decidido)

Dispositivo objetivo: **Android con Adreno 8xx (Qualcomm)**, verificado en webgpureport.org el 2026-10-29. Soporte completo de WebGPU, y además:

- `shader-f16`: shaders en media precisión, más rápidos en móvil.
- `subgroups` (tamaño 64): reducciones rápidas para histogramas, luminancia media y análisis de imagen.
- `timestamp-query`: **tiempo real de GPU por pase** en el HUD, no solo fps.
- `float32-filterable` / `float32-blendable` / `rg11b10ufloat-renderable`: feedback en float sin bandas.
- HDR canvas soportado.
- **WebGPU + OffscreenCanvas en workers**: el render puede vivir en un worker, así la UI nunca bloquea un frame.

**Decisión:** backend único WebGPU (WGSL). El IR de pases se mantiene como frontera, de modo que un backend WebGL2 sigue siendo posible si algún día hace falta, pero no se escribe ahora. Todo lo que abajo dice "GLSL" pasa a ser WGSL, y los `processor` de cómputo son de primera clase desde H2.

**Render en worker** (a validar en el spike de H1):
- La cámara llega al worker como `VideoFrame` (`MediaStreamTrackProcessor`) y se importa sin copia con `importExternalTexture`.
- La grabación se hace con WebCodecs (`VideoEncoder`, H.264 por hardware) + muxer mp4 dentro del worker, en lugar de `canvas.captureStream` + `MediaRecorder`. Da mp4 nativo, bitrate controlado y no depende del canvas del hilo principal.
- Si el spike falla, el plan B es renderizar en el hilo principal con `MediaRecorder`, tal como describe §6.

```
Grafo JSON ──► Compilador ──► IR de pases ──► Backend WebGPU ──► GPU
                (fusión,       (pase = shader
                 límites)       + entradas +
                                salida + uniforms)
```

**Frontera elegida: el IR de pases.** El compilador produce una lista ordenada de pases. Cada pase lleva:

- id de programa: el hash estructural de los snippets que fusiona;
- entradas (texturas o buffers) y destino (target y formato);
- tabla de uniforms.

El backend es dueño de todo lo que depende de la API: contexto, texturas, framebuffers, pool de targets, compilación y generación de shader.

- **Snippets por backend.** Cada op declara su implementación GLSL (y WGSL cuando exista el backend WebGPU). Son de 5 a 30 líneas cada uno, unos 40 en total. Escribir cada op dos veces es más barato y fiable que meter un transpilador GLSL→WGSL (naga en WASM pesa más de 1 MB y falla en casos límite).
- **El cómputo entra como `processor`.** Un procesador consume texturas y produce texturas, así que el grafo nunca ve buffers de cómputo. En WebGL2 un procesador puede existir en versión "GPGPU por fragment shader" (ping-pong de texturas float; las partículas son viables así) o marcarse como solo-WebGPU y ocultarse en la galería si el dispositivo no lo soporta.
- **Formatos:** los buffers de feedback van en `RGBA16F` cuando hay `EXT_color_buffer_float`. Con 8 bits, el feedback con decay lento se queda "pegado" y hace bandas. Si no hay half-float, se usa `RGBA8` con dithering.

Ver §10, decisión 2: recomiendo valorar **WebGPU-only** si tu móvil lo soporta.

---

## 6. Cámara, foto y grabación

**Cámara**
- `getUserMedia` con `facingMode`; luego `enumerateDevices` para elegir lentes concretas (gran angular, tele) cuando el navegador las expone.
- El cambio en caliente detiene el track anterior y crea uno nuevo. El efecto sigue corriendo sobre el último frame o un fundido, sin pantalla negra.
- Subida a textura solo cuando hay frame nuevo (`requestVideoFrameCallback`). La cámara suele ir a 30 fps y el render a 60, lo que mantiene suave el feedback.
- Resolución de stream por defecto: **1280×720** para la vista. Subir 1080p cada frame es caro en bastantes Android. Configurable.
- **Fuente de prueba** (`?source=test`): carta de ajuste animada o vídeo local en lugar de la cámara. Es imprescindible para desarrollar y verificar en el navegador del escritorio sin webcam.

**Foto**
- Se re-renderiza un frame del grafo a la **resolución del stream** en un target aparte y se exporta con `toBlob`. Los buffers de feedback se muestrean escalados, así que el resultado coincide con lo que ves.
- No uso `ImageCapture.takePhoto` (resolución del sensor): no pasa por los efectos ni por el feedback y solo existe en Chrome Android.

**Vídeo**
- `canvas.captureStream(fps)` + pista de audio del micro → `MediaRecorder`.
- Selección de formato por `isTypeSupported`, en este orden de preferencia: `video/mp4;codecs=avc1` (Safari, Chrome reciente) → `video/webm;codecs=vp9` → `vp8`.
- **Canvas de salida de tamaño fijo durante la grabación.** La escala dinámica de resolución actúa sobre los targets internos; la salida final se escala al canvas fijo. Si el canvas cambia de tamaño a mitad de grabación, `MediaRecorder` produce artefactos o corta.
- Mejora futura si hace falta control fino (bitrate, mp4 garantizado): WebCodecs + muxer mp4.

**Guardar y compartir**
- Web Share API con archivos (`navigator.canShare({ files })`). En iPhone es la vía para guardar en Fotos.
- Fallback: descarga directa.

---

## 7. Interfaz

- **Svelte 5.** Compila a JS mínimo, tiene reactividad fina sin virtual DOM y transiciones nativas: todo lo que pide una UI animada sobre un canvas que ya consume la GPU. Preact añade VDOM sin ganar nada aquí; con DOM puro, el editor (H5) se vuelve laborioso.
- **Lienzo a sangre completa**, con la UI flotando encima en la zona del pulgar (tercio inferior).
- **Gesto principal:** arrastrar sobre la imagen controla las 2 macros del efecto (pad XY); pellizcar controla la tercera. Así se toca el efecto sin abrir menús.
- **Galería:** tira horizontal tipo dial encima del obturador, con miniaturas vivas. Para no renderizar 10 efectos por frame, se actualiza **una miniatura por frame** en round-robin a ~96 px; parecen vivas a coste casi cero.
- **Obturador:** toque = foto, mantener = grabar (patrón conocido, una mano).
- **Cajón de parámetros** (deslizar hacia arriba): todos los parámetros y modulaciones del efecto.
- **HUD de depuración** (triple toque en una esquina): fps, ms/frame, resolución interna, nº de pases. Sirve para medir en tu móvil real.
- **Robustez:** Screen Wake Lock para que no se apague la pantalla; precompilación de shaders de los efectos vecinos en la galería (`KHR_parallel_shader_compile`) para que cambiar de efecto no dé tirón.

---

## 8. Escenas 3D (H3)

**Decisión: nodo `render3d` propio, sin Three.js por ahora.**

Las escenas que reaccionan a la cámara son, en esencia, geometría simple con un vertex shader que lee una textura:

- malla desplazada por luminancia;
- nube de puntos con el color de cada píxel;
- vóxeles o instancias extruidas;
- túneles.

Es el patrón Geometry COMP + Render TOP de TouchDesigner, y cabe en ~300 líneas propias (matrices, cámara orbital, instancing).

Three.js obligaría a compartir contexto WebGL con su gestor de estado (frágil) o a usar otro contexto. Con otro contexto no se comparten texturas, y cada frame habría que copiar la imagen. Lo traería solo si un día quieres modelos glTF o iluminación PBR, y quedaría aislado en un nodo.

---

## 9. Estructura, herramientas y verificación

```
src/
  main.ts
  app/          bucle principal, estado global, cableado
  gpu/          interfaz Backend + webgl2/ (contexto, targets, pool, programas)
  graph/        tipos y esquema JSON, validación, compilador (fusión → IR), ejecutor
  ops/          librería de ops por familia (sources, coords, colors, combine,
                neighborhood, feedback, render3d) con sus snippets GLSL
  dsl/          API encadenable estilo Hydra → grafo
  signals/      time, lfo, audio, touch, motion, image, mapeo
  io/           cámara y fuente de prueba
  capture/      foto, grabador, compartir
  presets/      efectos JSON de la galería
  ui/           componentes Svelte
public/         manifest, iconos
tests/          Vitest: DSL→grafo, compilador (snapshots de GLSL), mapeo de señales
```

**Herramientas**
- Vite + TypeScript estricto, pnpm, Vitest.
- `vite-plugin-pwa` para manifest y service worker.
- git inicializado en local desde H1 (sin remoto hasta que lo digas).

**Probar en el móvil**
- La cámara exige HTTPS. Opción recomendada: `cloudflared tunnel --url http://localhost:5173`, que da HTTPS válido y deja registrar el service worker (hay que instalar `cloudflared`).
- Alternativa: `@vitejs/plugin-basic-ssl` en la LAN. Usa certificado autofirmado: el navegador avisa y el service worker no se registra.
- Despliegue estable para instalar la PWA (GitHub Pages o Cloudflare Pages): en H4, con tu visto bueno.

**Verificación por hito**
- Lo funcional (compila, renderiza, captura, graba) lo verifico en el navegador integrado con la fuente de prueba, con capturas.
- Los **fps reales solo se pueden medir en tu teléfono**. La emulación móvil del escritorio no emula la GPU del móvil. Para eso está el HUD; en Android también sirve la depuración remota (`chrome://inspect` por USB).
- Hay una página `/debug` que compila todos los presets y lista errores de shader.

**Criterio de rendimiento ajustado**
- 60 fps sostenidos en el preset más pesado no es realista en todos los móviles con calentamiento térmico.
- Propuesta: **objetivo 60 fps, suelo de 30 fps**, con el escalado dinámico de resolución (escalones 1 → 0.85 → 0.7 → 0.5, con histéresis) actuando antes de bajar del suelo.

**Licencias**
- hydra-synth es AGPL-3.0: se replican conceptos y nombres de operaciones, **sin copiar su código ni sus snippets GLSL**.
- TouchDesigner: solo conceptos.

---

## Hitos

| Hito | Entrega | Hecho cuando |
|---|---|---|
| **H1** | Scaffold, spike de render en worker (VideoFrame → WebGPU → WebCodecs), backend WebGPU mínimo, cámara + fuente de prueba, DSL con ~12 ops (osc, noise, voronoi, src, rotate, scale, kaleid, pixelate, modulate, hue, blend, feedback/o0), compilador con fusión, pantalla completa, foto, grabación, HUD | Una cadena con feedback corre en el móvil por el túnel; la foto y el vídeo se guardan y coinciden con la vista |
| **H2** | Formato JSON + validador, ops de vecindad (blur, edge, displace, bloom), límites de materialización, señales (lfo, audio, touch), macros, galería con 8–10 presets | Se cambia de efecto sin tirones; el audio y el tacto modulan en vivo |
| **H3** | Nodo `render3d` (malla desplazada, nube de puntos, instancias), señales `motion` e `image` | Al menos 2 escenas 3D reactivas en la galería |
| **H4** | UI definitiva con la identidad visual elegida, PWA instalable, wake lock, despliegue | Instalada en el móvil, abre a pantalla completa y funciona sin conexión salvo la cámara |
| **H5** | Editor en la app: grafo de nodos visual + modo texto con el DSL; guardar e importar efectos | Creas un efecto nuevo en el móvil y aparece en la galería |

Antes de H1 no hay grafo JSON completo: el DSL de H1 ya genera el grafo, pero el esquema formal, el validador y los presets en archivo llegan en H2.

---

## 10. Decisiones abiertas (necesito tu respuesta)

1. ~~Teléfono~~ → **Android** (Adreno 8xx). Hay Fullscreen API real, bloqueo de orientación y vibración háptica (`navigator.vibrate`); el rendimiento se mide con depuración remota (`chrome://inspect`).

2. ~~WebGL2 o WebGPU~~ → **WebGPU-only** (ver §5).

3. **Dirección estética de la interfaz** — pendiente de tus referencias. Las tres direcciones de abajo quedan como punto de partida, no como menú cerrado: (los efectos cubren todo el espectro; esto es la "carcasa"):
   - **A · Señal / Broadcast.** Monitor de emisión: cartas de ajuste, fósforo ámbar sobre negro, monoespaciada (Departure Mono), transiciones con glitch de sincronía, clics de relé como sonido de interfaz.
   - **B · Instrumento de laboratorio** *(recomendada)*. Como un sintetizador modular u osciloscopio: negro profundo, un solo acento naranja señal (#FF4F00), etiquetas técnicas diminutas, valores numéricos visibles, movimiento seco y preciso. Tipografía: Departure Mono + una serif de contraste para los nombres de efecto. No compite con la imagen y encaja con la idea de "cámara-instrumento".
   - **C · Líquido / Psicodelia.** La propia UI se deforma con el efecto (paneles que refractan la imagen), formas orgánicas, serif expresiva (Fraunces), movimiento elástico. Muy llamativa, pero compite con los efectos y cansa antes.

Todo lo demás (Svelte 5, 3D propio, resolución de foto, formato JSON, frontera del IR, criterio de 30/60 fps) lo doy por decidido salvo que quieras cambiar algo.
