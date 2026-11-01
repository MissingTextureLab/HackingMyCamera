# Plan — Datamosh (FX-51 PÉRDIDA): port de `niccolofanton/data-mosh`

Estado: F0–F4 hechas; FX-51 PÉRDIDA está en la galería y funciona en el Android real (2026-11-01). Queda cerrar F5 (MUDA).
Reescrito el 2026-11-01. Complementa `PLAN.md` y `DESIGN.md`; si algo choca, mandan esos dos.

Referencia: https://github.com/niccolofanton/data-mosh (carpeta `datamosh-demo/src/datamosh/`),
código de *Feeding a Decoder the Wrong Frame* (Codrops). Licencia MIT, © 2026 Niccolò Fanton.
Los assets del repo (cielo, bailarina, sala) **no** se usan y no están bajo esa licencia.

---

## 0. Prompt para la sesión de implementación

```text
Vas a portar a HackingMyCamera el datamosh de https://github.com/niccolofanton/data-mosh
(carpeta datamosh-demo/src/datamosh/): un decodificador de vídeo simulado en un fragment shader
que hace  nuevo fotograma = warp(fotograma anterior, vectores de movimiento) + residuo,  sin que
la referencia se refresque nunca mientras se mantiene el disparador.

Lee antes: CLAUDE.md, PLAN.md §1 y §5, DESIGN.md y PLAN-DATAMOSH.md entero. El código de
referencia está descargado, solo para leer, en
C:\Users\34658\AppData\Local\Temp\claude\C--Users-34658-Documents-GitHub-HackingMyCamera\b2f658ca-9090-4d7b-b219-eb65b890932f\scratchpad\data-mosh-ref\
(shaders.ts es el decodificador; index.ts es la lógica de disparo y recuperación; debug.ts son
los valores por defecto). Si no está, bájalo con `gh api`. No ejecutes nada de ese repo.

"Literal" significa: traduce el shader GLSL a WGSL línea por línea, con los mismos nombres,
los mismos pasos y los mismos valores por defecto. No lo "mejores" ni lo simplifiques. Lo único
que cambia es de dónde salen los vectores de movimiento (ver §2) y el disparador (ver §4).

Es una obra derivada de código MIT: conserva el aviso de copyright y el texto de la licencia
(NOTICE en la raíz y una cabecera en el op).

Reglas innegociables (CLAUDE.md): ops con las firmas de src/ops/registry.ts; un pase lee como
mucho 4 texturas; los parámetros son uniforms; los buffers se leen con el fotograma anterior;
sin micrófono; identidad Citrink; código y comentarios en inglés, texto de UI en español y
mayúsculas. Windows con Controlled Folder Access: ejecuta vitest/vite/svelte-check desde el
mirror (scripts/mirror.sh) y aplica los cambios a archivos existentes con un script de Node.

Orden: las fases de PLAN-DATAMOSH.md §6. Cada una termina verificada antes de empezar la
siguiente. Si algo del shader no se puede traducir tal cual, para y dilo; no lo cambies en silencio.
Sin commit hasta que se pida.
```

---

## 1. Qué hace el original

```text
new frame = warp(previous frame, motion vectors) + residual
```

1. Un **velocity pass** escribe el movimiento en pantalla de cada píxel del plano 3D. Donde no hay geometría, lo reconstruye con la profundidad y la cámara anterior.
2. Un **shader decodificador** (todo el efecto está ahí) lee `pFrame`, su propia salida del frame anterior, y la arrastra por los vectores:
   - un vector por **macrobloque** (por defecto 8 px), con precisión de medio píxel;
   - bloques que se **saltan** (`skip`), que **roban el vector del vecino** (`mismatch`) o que **no llegan** (`lost`: rectángulos que parpadean y dejan el contenido viejo);
   - lectura de la historia con **Catmull-Rom** de 9 taps, para que la realimentación no se convierta en papilla;
   - un **residuo**: la diferencia de alta frecuencia entre la imagen buena y la predicha, solo donde la buena es más nítida, cuantizada en `residualQuant` escalones;
   - `uRecover` devuelve la imagen buena; `uKeyframe` fuerza un fotograma limpio.
3. El **manager** decide cuándo: mientras se mantiene el disparador `recover = 0`; al soltar sube a 1 en `fadeDuration` (370 ms); los sectores perdidos aparecen 300 ms después de empezar el gesto.
4. **El truco, que es un corte de plano.** Al pulsar, la escena salta a otro plano *después* de mostrar el frame actual. El buffer de realimentación aún tiene el plano viejo y el frame siguiente trae los vectores del nuevo: la imagen vieja es arrastrada por el movimiento de la nueva.

El original **no** mide movimiento a partir de imágenes: lo sabe, porque tiene la escena 3D.

---

## 2. Qué es literal y qué no puede serlo

| Pieza | En el original | Aquí |
|---|---|---|
| Shader decodificador | GLSL, `mainImageShader` | **Literal**, traducido a WGSL: op `decode` |
| Catmull-Rom, residuo, macrobloques, skip, mismatch, lost sectors, precisión de vector | uniforms con valores por defecto | **Literal**, mismos nombres y mismos valores |
| Vista de depuración (campo de color + flechas) y flechas sobre la imagen | dentro del shader | **Literal**, dentro de `decode` |
| Lógica de disparo (`recover`, fundido de 370 ms, retardo de 300 ms de los sectores perdidos, keyframe periódico) | `DataMoshManager.render` | **Literal**, como señales (§4) |
| **Vectores de movimiento** | velocidad de la geometría 3D + movimiento de cámara por profundidad | **No se puede.** Aquí no hay escena: se **estiman** de la cámara con el block matching de F1 (`motion`). Es el mismo tipo de dato que un códec real calcula |
| `parallax`, `uInvViewProjection`, `uPrevViewProjection*`, `readDepth` | movimiento de cámara en el fondo | **Se quitan.** El `motion` ya cubre todo el cuadro, fondo incluido |
| `uVelocity` en uv | vectores en uv | Los de `motion` están en píxeles de salida; se divide por `resolution` al leerlos |
| **El corte de plano** | `sceneCut`: salta a otra escena al pulsar | **No hay escena a la que saltar.** Se produce de forma natural: se mantiene el disparador y se apunta el móvil a otro sitio. La imagen vieja la arrastra el movimiento del plano nuevo, que es el mismo desajuste |
| Resolución de la historia (`resolutionScale`) | 0,2–1 | Se queda en 1: `uHistoryResolution = resolution` |
| Panel de control (Tweakpane) | todos los parámetros | No hay panel (PLAN H4: cajón de parámetros pendiente). Los valores por defecto son los del original; tres van a macros |

Dos consecuencias que hay que tener claras antes de empezar:

- **Con un vídeo real el efecto depende de que haya movimiento en la cámara.** Quieto, no pasa nada. Es lo que hace un decodificador de verdad.
- **Los vectores son una estimación.** Con poca textura (pared lisa), mala luz o mucho ruido, el block matching da vectores pobres. El original no tiene ese problema.

---

## 3. Qué se aprovecha de lo hecho

- **F0 (tick), hecha.** El decodificador es un lazo con estado: avanza una vez por fotograma de cámara (~30 fps), no por frame de render. Entre ticks devuelve su historia sin tocarla. El original corre a cada frame porque su escena también; aquí el vector representa el desplazamiento entre dos fotogramas de cámara y aplicarlo dos veces por fotograma lo duplicaría.
- **F1 (`motion`), escrita.** Es el sustituto del velocity pass. Su salida (vectores enteros por bloque de 16 px, con memoria entre ticks, guardados en `o2`) pasa a ser la entrada de `decode`. Falta verificarla (§6, F1).
- `scope` queda como herramienta de desarrollo para F1; la vista de depuración definitiva es la del propio `decode`. Se retira al acabar si sobra.

Lo que **se descarta** del plan anterior: el op `codec`, el parámetro `hold` en la macro A, `drag` y `block` propios. Los sustituye `decode` con los uniforms del original.

---

## 4. Disparador y señales

El original: *mantener pulsado = efecto; soltar = recuperación lineal en 370 ms*.

Aquí el equivalente es **mantener el dedo sobre la imagen**. Hace falta un canal nuevo en `src/signals/index.ts` porque `touch('down')` se suaviza igual en las dos direcciones, y el original sube de golpe y baja con un fundido lineal:

| Canal nuevo | Valor | Para qué |
|---|---|---|
| `touch('hold')` | 1 al instante al tocar; al soltar baja linealmente a 0 en `fadeDuration` | `uRecover = 1 − hold` |
| `touch('lost')` | 0 al empezar el gesto; pasa a 1 a los 300 ms y se queda así durante la recuperación | `uFrozenBlocks = lost · frozenBlocks` |

Notas:
- `Signals` ya guarda el estado de los canales de evento; estos dos necesitan además la marca de tiempo del último toque y de la última suelta.
- `uKeyframe` (keyframe periódico, `keyframeInterval` = 0 por defecto) se porta como parámetro `keyframe` sin señal asociada. Queda a 0, igual que el original.
- Un pellizco son dos dedos. Decidir en F3 si cuenta como disparador (el zoom mueve toda la imagen y la derretiría entera) o si solo cuenta un dedo.
- **Conflicto con los gestos de la casa.** Tocar la imagen también arrastra las macros A y B por posición absoluta (DESIGN.md, *Gestos*). Las dos cosas pasarán a la vez. Hay que elegir bien los rangos para que el punto medio de cada macro coincida con el valor por defecto del original (ver §5), o el primer toque cambiaría el efecto antes de empezar.

---

## 5. Op `decode` y preset

`decode`: filter con 3 entradas, un pase, a resolución completa.

- `in0` = la cámara (el `inputBuffer` del original)
- `in1` = la historia, `o(1)`: su propia salida del frame anterior (`pFrame`)
- `in2` = el campo de vectores, `o(2)`, escrito por `motion`

Los uniforms, con los nombres y los valores por defecto del original (`debug.ts`):

| Uniform | Defecto | Nota |
|---|---|---|
| `uMotionGain` | 1,5 | |
| `uBlockSize` | 8 | px |
| `uBlockiness` | 1 | 0 = warp suave por píxel (leer 4 centros de bloque y mezclar) |
| `uMvPrecision` | 2 | medio píxel |
| `uSkipThreshold` | 0 | |
| `uMismatch` | 0 | |
| `uFrozenBlocks` | 1 | multiplicado por `lost` |
| `uLostLayers` | 4 | |
| `uLostLife` | 50 | ms; `uTime` = `G.time · 1000` |
| `uLostScale` | 2,65 | |
| `uLostAspect` | 0,75 | |
| `uLostVariance` | 1 | |
| `uResidualGain` | 0,4 | el original guarda 4 y divide por 10 |
| `uResidualQuant` | 14 | |
| `uRecover` | 1 | `1 − hold` |
| `uKeyframe` | 0 | |
| `uDebugMotion`, `uDebugScale`, `uDebugField`, `uDebugArrows`, `uShowMotionArrows`, `uShowLostSectors` | 0 / 8 / 1 / 1 / 0 / 0 | solo desarrollo |

Preset (boceto, validar contra la API real):

```ts
// Compression: the decoder never gets its keyframe. Hold a finger on the image
// and the picture you had is dragged along by whatever moves in front of the
// lens, in blocks; let go and the real image fades back in.
const perdida = effect({ id: 'perdida', code: '51', name: 'Pérdida' }, (m) => {
  cam().latch(o(3)).out(3);
  const mv = cam().motion(o(3), o(2), 0.9, 0.012);
  mv.out(2);
  const rec = cam().decode(o(1), mv /* …uniforms con los valores por defecto… */);
  rec.out(1);
  rec.out(0);
  m.macro('ARRASTRE', rec, 'motionGain', 0, 3);          // A: mitad del recorrido = 1,5, el original
  m.macro('BLOQUE', rec, 'blockSize', 4, 12);            // B: punto medio = 8, el original
  m.twist('PAQUETES', rec, 'frozenBlocks', 0, 2);        // C: se recorta a 1 en el shader si hace falta
  m.mod(rec, 'recover', touch('hold'), 1, 0);
  m.mod(rec, 'lost', touch('lost'), 0, 1);   // the shader multiplies frozenBlocks by it
});
```

Pendiente de decidir en F3: los rangos de las macros (el original deja blockSize hasta 64; con el punto medio en 8 solo caben 4–12) y qué parámetros reciben macro y cuáles quedan fijos. `PAQUETES` en C es provisional.

Notas de traducción GLSL → WGSL a vigilar:
- `texture2D(pFrame, uv)` → `textureSampleLevel(T1, samp, uv, 0.0)`; el sampler del motor es lineal con borde fijo, como el `LinearFilter` del original.
- `mod`, `fract`, `atan(y, x)`, `mix` con vectores: la semántica es la misma salvo `mod` (en WGSL no existe: `x − y·floor(x/y)`).
- El shader original devuelve antes (`return`) cuando no hay nada que decodificar; en WGSL es lo mismo, pero con el tick: sin tick devuelve la historia.
- `hash13`/`hash23` usan `fract` sobre vectores; mantener las constantes tal cual, porque el aspecto de los sectores perdidos depende de ellas.
- Palabras reservadas de WGSL (`target`, `module`, `filter`, `active`…): renombrar lo que choque y dejar un comentario.
- El `clamp(…, 0, 64)` de `fragment()` en `compile.ts` recorta lo negativo; por eso los vectores van en cuatro canales (+x, +y, −x, −y)/4 (F1). `decode` devuelve color, que no se ve afectado.

---

## 6. Fases

| Fase | Entrega | Hecho cuando |
|---|---|---|
| **F0 — Tick** *(hecha 2026-11-01)* | `camVersion`, `camFit.w` por `Stage`, op `latch`, DSL, `?source=test&camfps=30` | Hecho y verificado en el navegador con la carta de ajuste |
| **F1 — `motion`** *(hecha 2026-11-01: patrón de +21,3/+8,5 px por tick → mide +20/+8; a 35,6/14,2 → 32–34/14; quieto da 0 y el vector decae ×0,9 por tick)* | Block matching de dos niveles con memoria; `scope`; DSL de tres entradas | Con un patrón de movimiento conocido, el vector medio apunta en el sentido y con la magnitud esperados; quieto da 0; un movimiento grande (>30 px por tick) sigue dando vectores coherentes; al parar el vector decae. **Falta medirlo, no solo mirarlo** (lectura numérica de `o2`) |
| **F2 — `decode`** *(escrita 2026-11-01; compila y derrite la imagen en el navegador; vistas de depuración y sectores perdidos sin comprobar a ojo)* | Traducción literal del shader a WGSL; preset con disparo manual (parámetro `recover`) | Con la carta de ajuste, forzando `recover = 0`: la imagen vieja se arrastra en bloques de 8 px por el movimiento nuevo; con `recover = 1` es la cámara. Las vistas de depuración (campo y flechas) coinciden con las del original. Los sectores perdidos aparecen. Sin tick no cambia nada |
| **F3 — Disparador** *(hecha 2026-11-01: canales `touch('hold')` y `touch('lost')`; dispara cualquier dedo, pellizco incluido, como el `pointerdown` del original; preset en la galería; la É del sello se escribe como E)* | Canales `hold` y `lost`; macros; decisión sobre el pellizco | Mantener el dedo derrite; soltar recupera en 370 ms; los sectores aparecen a los 300 ms; el primer toque no cambia el aspecto por culpa de las macros |
| **F4 — Móvil** *(hecha 2026-11-01: probado por túnel en el Android; funciona bien según el usuario; fps y ms de GPU sin anotar)* | Prueba por túnel en el Android real | ≥30 fps con el HUD; se lee bien a través de ÁCIDO y MORADO; el block matching da vectores utilizables con cámara real (esta es la parte que más puede fallar) |
| **F5 — Documentar** | `NOTICE` con la licencia MIT, cabecera en el op, DESIGN.md (12 preguntas), PLAN.md, CLAUDE.md (la regla "sin código de hydra-synth" sigue; este es MIT y se cita), decisión sobre MUDA | `pnpm test`, `pnpm check` y `pnpm build` en verde |

### Verificación

- **Tests (vitest):** DSL → grafo, compilador (pases, ≤4 texturas, índices de buffer), validador. El WGSL no se prueba sin GPU.
- **Visual:** `dev-mirror` + `?source=test`. Para ver el efecto con la carta de ajuste hace falta un "corte": en el mirror, y solo ahí, la carta cambia de patrón al mantener el puntero, para reproducir el desajuste del original.
- **Numérica (F1):** lectura de `o2` desde el worker en el mirror, con mediana de los vectores de los bloques que se mueven y la fase del patrón.
- **Móvil:** `pnpm dev:tunnel` + `pnpm tunnel`; los fps reales solo se miden ahí.

---

## 7. Riesgos

1. **Calidad de los vectores estimados (el mayor).** El efecto del original se ve limpio porque sus vectores son exactos. Con cámara real hay ruido, desenfoque de movimiento y zonas lisas. Si F4 sale mal, las salidas son más muestras por bloque en la búsqueda fina, una pirámide más y suavizado temporal; no tocar el decodificador.
2. **Granularidad.** Los vectores nacen en bloques de 16 px; `uBlockSize` por defecto es 8. Cada vector sirve a 2×2 macrobloques: los saltos, los sectores perdidos y el robo de vecino siguen siendo de 8 px, pero el movimiento no tiene esa resolución. Si se nota, F1 pasa a 8 px (4× de coste de búsqueda).
3. **Sin corte de plano, hace falta movimiento.** Ver §2. Si se echa de menos, la alternativa es dejar que el disparador también congele un fotograma de otra fuente (una foto hecha antes). No se hace sin pedirlo.
4. **Disparo y macros a la vez.** Ver §4.
5. **Pellizco.** Ver §4.
6. **Licencia.** MIT exige conservar el aviso. Hasta que el `NOTICE` exista, no se publica.
7. **Rendimiento.** `decode` hace ~9 taps de Catmull-Rom + 8 del residuo + 4 capas de sectores perdidos por píxel, más el block matching de F1 (~29 M lecturas por tick a 1080×1920). Medir con `timestamp-query` en el móvil antes de optimizar.

## 8. Fuera de alcance

- Escena 3D, velocity pass, parallax, panel Tweakpane y `resolutionScale`.
- Audio y micrófono.
- Manipulación real de bitstream.
- Los assets del repo original.
