# Plan — Una app, varios niveles según el teléfono

Estado: propuesta (2026-11-04). F0, F1 y F1b hechas (falta recoger informes). Complementa `PLAN.md` (§5 "WebGPU-only") y `DESIGN.md`; si algo choca, mandan esos dos.

Motivo: varios amigos abren la app y ven **SIN ADAPTADOR GPU**. Hoy el motor es solo WebGPU y solo se probó en un Adreno 8xx (Android real, `PLAN.md` §5). Un móvil sin WebGPU ve la pantalla de error y nada más.

---

## 1. Idea: un solo build, el nivel se decide al arrancar

No conviene hacer "una versión por Android":

- Es una PWA que se instala desde un enlace; varias URLs/builds se desincronizan y duplican el mantenimiento.
- Chrome se actualiza solo y trae WebGPU por separado del Android (versión de Chrome + driver + GPU), así que la versión de Android dice poco.
- Lo que decide es **qué puede hacer ese móvil**: ¿hay WebGPU?, ¿qué límites tiene?, ¿aguanta los fps?

Por eso: **un único bundle y un sondeo de capacidades al arrancar** que elige un *nivel*. Los motores pesados se cargan con `import()` dinámico para que el nivel alto no cargue código del bajo (y entran igual en la precarga del service worker).

## 2. Niveles

| Nivel | Cuándo | Motor | Qué cambia |
|---|---|---|---|
| **A · completo** | WebGPU y pasa la prueba de velocidad | WebGPU (hoy) | Todo: 57 ops, 3D, `sort` (cómputo), miniaturas vivas, render hasta 1920 |
| **B · ligero** | WebGPU pero GPU justa (límites bajos, fps bajos en la prueba, `deviceMemory` ≤ 4) | WebGPU, mismos shaders | Render ≤ 1280 (o 960), miniaturas vivas solo la visible y a menos fps, menos temps si no hay mejora visible, sin efectos marcados como pesados |
| **C · compatible** | Sin adaptador WebGPU (Android < 12, GPU no soportada, drivers en lista negra) pero **WebGL2** | WebGL2 (backend nuevo) | Efectos que no necesitan cómputo; `sort` y otros `processor` ocultos en la galería; render ≤ 1280 |
| **— · sin GPU** | Ni WebGPU ni WebGL2 | ninguno | Pantalla de error con el motivo (F0, ya hecha). No se construye nada más |

Se descarta un nivel "Canvas2D por CPU": con los efectos de esta app no daría una experiencia parecida y costaría más que el backend WebGL2.

## 3. El sondeo (`src/gpu/tier.ts`, nuevo, puro donde se pueda)

Entradas, de más a menos fiable:

1. `navigator.gpu` + `requestAdapter` (los tres intentos que ya hace `Engine.create`) → hay WebGPU o no.
2. `adapter.info` (vendor, architecture), `adapter.limits` (`maxStorageBufferBindingSize`, `maxComputeInvocationsPerWorkgroup`, `maxTextureDimension2D`) y `adapter.features`.
3. `navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion'])` (el UA de Chrome está congelado en "Android 10", no sirve para la versión), `navigator.deviceMemory`, `hardwareConcurrency`.
4. **Prueba de velocidad** (~1 s, tras el primer render): se pinta una cadena de referencia (feedback + un filtro) y se mide el tiempo de frame (`timestamp-query` si existe, si no `rAF`). Resultado en `localStorage` por modelo + versión de Chrome; si no cambia, no se repite.
5. **Degradación en marcha**: si el p95 del frame supera el presupuesto durante ~3 s, baja un nivel (o un escalón de resolución) sin recargar. Nunca sube solo.
6. Manual: `?tier=a|b|c` para probar, y más adelante un ajuste "CALIDAD" en la interfaz.

Salida: `{ backend: 'webgpu' | 'webgl2' | 'none', tier: 'A' | 'B' | 'C', caps, reasons[] }`. Los `reasons` alimentan la pantalla de error y el informe copiable.

Los *knobs* que cambia un nivel viven en un solo objeto (`TierConfig`): tope de render, número y fps de miniaturas, formato de búfer, bitrate de grabación, lista de ops permitidas. El motor y la UI solo leen eso, no preguntan por el modelo.

## 4. Efectos que declaran lo que necesitan

Cada op/preset lleva `requires?: ('compute' | 'float16' | 'vertexPull' | 'heavy')[]`:

- `sort` → `compute`; `relief`, `cloud`, `city` → `vertexPull` + `heavy`; los filtros más caros (bloom, displace encadenado) → `heavy`.
- La galería filtra por el `TierConfig`, y `validateEffect` rechaza un efecto cuyo `requires` no cumple el nivel (así un JSON externo tampoco rompe un móvil justo).
- Es barato y sirve a B y C por igual: hacerlo antes que el backend WebGL2.

## 5. Backend WebGL2 (nivel C): lo caro

Hoy `src/ops/registry.ts` (2.5k líneas) es WGSL; `PLAN.md` §5 ya decía que cada op puede declarar un segundo snippet por backend y que meter un transpilador WGSL→GLSL pesa y falla en los casos límite. Lo que hay que hacer:

1. **IR de pases como frontera.** `compile.ts` ya produce pases ordenados; el backend nuevo consume ese IR. Hay que comprobar que el IR no arrastra nada de WGSL (nombres de bindings, `P[]`).
2. **GLSL por op**: 57 ops (9 color, 6 combine, 7 coord, 22 filter, 6 source, 2 texture, 4 render3d, 1 processor) más 3 `combineCoord`. Se portan por grupos y se prueban comparando contra WebGPU con imágenes de referencia (tolerancia por canal).
3. **Búferes**: `rgba16float` necesita `EXT_color_buffer_float` / `EXT_color_buffer_half_float`; sin ellos, caer a `rgba8` y marcarlo (el feedback se ve distinto: el nivel C avisa).
4. **3D** (`render3d`): `gl_VertexID` equivale a `vertex_index`, así que es viable; es lo último.
5. **Procesadores** (`sort`): el nivel C los oculta; si luego se quiere, GPGPU por fragment shader.
6. **Cámara**: `camera.ts` ya tiene el camino `<video>` + `requestVideoFrameCallback`, sin cambios.
7. **Foto/vídeo**: foto igual (OffscreenCanvas); vídeo con WebCodecs si existe, si no `MediaRecorder` (sin audio, como pide `CLAUDE.md`).
8. **Revelado** (curva S, mapa Citrink, dither Bayer, sello de fecha): se reescribe el present pass en GLSL; es la parte que da la identidad, así que se compara a ojo en el móvil.

Estimación gruesa: es varias veces el tamaño de cualquier otra fase del proyecto. Por eso no se empieza hasta saber cuántos móviles de los amigos lo necesitan (F1).

## 6. Fases

| Fase | Contenido | Hecho cuando |
|---|---|---|
| **F0** | Pantalla de error con motivo, specs del móvil, copiar informe y reintentar (`src/app/diagnose.ts`) | **Hecha** (tests y `svelte-check` pasan; falta verla en un móvil) |
| **F1** | `?diag` (`src/app/Diag.svelte`, `probe.ts`, `report.ts`): sondeo completo (adaptador, worker, límites, WebGL2, vídeo, prueba de velocidad WebGPU y WebGL2 a 1280×720) y nivel propuesto; ENVIAR (menú compartir de Android) / COPIAR, con el JSON crudo al final. **Hecha**; falta pedir a 8–10 amigos que lo abran y lo pasen, y abrirlo en el móvil de referencia (Adreno 8xx) para calibrar `FAST_MS` / `SLOW_MS` en `report.ts` | Tabla de dispositivos real: modelo, Android, Chrome, ¿WebGPU?, ms |
| **F1b** | **Modo compatible de WebGPU** (WebGPU sobre OpenGL ES): `Engine.create` lo intenta antes del adaptador por software; la galería oculta los `processor` si el dispositivo no llega a 256 invocaciones; `?gpu=compat` lo fuerza en cualquier Chrome para probar; `?diag` lo sondea. Puede rescatar móviles sin Vulkan válido sin escribir el backend WebGL2. Probado en Chrome 152 de escritorio forzado (las 12 miniaturas sin errores de validación); **falta un móvil real** | Un móvil que veía SIN ADAPTADOR GPU abre la app y dice MODO COMPATIBLE |
| **F2** | `tier.ts` + `TierConfig` + nivel B en WebGPU (tope de render, miniaturas, degradación en marcha) | Un móvil justo llega a 30 fps estables en la galería |
| **F3** | `requires` en ops/presets + filtro en galería + `validateEffect` | Un móvil sin cómputo no ve `sort` y no se rompe |
| **F4** | Backend WebGL2 (§5), solo si F1 y F1b muestran que hace falta (móviles sin adaptador ni en modo compatible) | Los efectos del nivel C coinciden con WebGPU dentro de tolerancia y se ven bien en un móvil sin WebGPU |
| **F5** | Telemetría opcional (consentida): nivel elegido, fps, motivo de fallo | Se sabe qué fracción usa cada nivel |

## 7. Qué se sabe y qué no

- Chrome para Android lanzó WebGPU con Chrome 121, en Android 12+, con GPU Qualcomm y ARM y Vulkan 1.1. Está escrito de memoria: **comprobar** con `webgpureport.org` en cada móvil de F1 antes de darlo por hecho (el soporte se amplía con las versiones).
- No se sabe qué móviles tienen los amigos; F1 existe para saberlo antes de decidir F4.
- El nivel B está por calibrar: los números (1280/960, presupuestos de frame) salen de F1 y F2, no de aquí.

## 8. Decisiones abiertas

1. ¿Ir a F1 ya (un enlace `?diag` para amigos) y decidir F4 con datos? Es lo que recomiendo.
2. ¿El ajuste "CALIDAD" visible en la interfaz o solo `?tier=`? (Si es visible, copy en español, caps: p. ej. `CALIDAD · AUTO / ALTA / LIGERA`.)
3. ¿Aceptas que el nivel C no tenga todos los efectos (sin `sort`, sin 3D al principio)?
