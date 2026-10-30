# Hacking My Camera

Instrumento de precisión, saboteado a propósito.

Hacking My Camera es una cámara-instrumento para Android: la imagen pasa por un motor de efectos propio con el lenguaje visual de Hydra y TouchDesigner. Esta identidad junta dos cosas que normalmente no van juntas: la limpieza de Teenage Engineering y del diseño de Warp Records, y la actitud de un fanzine punk, en la paleta ácida **Citrink** y con tipografías **Rubik Glitch**.

## La idea: un manual de servicio saboteado

La interfaz es un aparato bien hecho: etiquetas pequeñas, códigos de catálogo, una retícula de 4 px, formas de hardware. Eso es lo fino y lo pulcro.

Lo punk no es una textura pegada encima. **Es un comportamiento.** En reposo, todo está alineado y limpio. Cuando pasa algo (disparas, grabas, cambias de efecto), el aparato se ensucia un instante: las capas de color se desregistran, un sello entra torcido, un fotograma sale fotocopiado. Luego vuelve a su sitio.

> La limpieza es la norma. El sabotaje es el evento.

## Principios

1. **La imagen manda.** La interfaz ocupa el mínimo y nunca tapa el centro del visor. Si un control no hace falta ahora, no se ve.
2. **Objeto, no pantalla.** Los controles son piezas de un aparato: etiquetas impresas, teclas, encoders. Nada de cristal translúcido, sombras flotantes ni tarjetas.
3. **Dos formas y ninguna más.** Rectángulo recto para todo lo que es una etiqueta o un panel. Círculo para lo que se gira o se aprieta. Ver *Forma*.
4. **La imagen fluye, la interfaz hace clic.** Los efectos son líquidos; la interfaz se mueve a saltos (`ease-step`), como un mecanismo.
5. **Un solo sabotaje a la vez.** Nunca dos eventos de ruptura simultáneos. Si todo es punk, nada lo es.
6. **La glitch es la voz, no el texto.** Rubik Glitch ya viene averiada: se usa grande y escasa. Todo lo que hay que leer pequeño va en una mono limpia.

## Color: Citrink

Ocho colores de la paleta [Citrink](https://lospec.com/palette-list/citrink) de Inkpendude, y **ninguno más**. No se mezclan, no se aclaran y no se oscurecen: cuando hace falta un tono intermedio, se usa un patrón (puntos, tramado) con dos colores de la paleta.

| Hex | Token | Rol |
|---|---|---|
| `#201533` | `viewfinder` | Suelo y negro del sistema |
| `#252446` | `panel` | Etiquetas, teclas, cajones |
| `#254d70` | `panel-deep` | Tecla pulsada, selección, separación |
| `#166e7a` | `lagoon` | Hairlines de 1 px y miniaturas |
| `#52c33f` | `ink-muted` / `grass` | Texto secundario, LED, segunda capa del desregistro |
| `#b2d942` | `acid` | Selección, parámetro activo, foco |
| `#fcf660` | `flash` | Eventos: grabando, sellos, valores al límite |
| `#ffffff` | `ink` | Texto y trazos principales |

Reglas:
- **Amarillo = algo está pasando.** Grabando, guardado, sabotaje, límite. Si nada pasa, no hay amarillo en pantalla.
- **Lima = esto está activo.** Un efecto elegido, un parámetro que se toca, el foco de teclado. Nunca es de adorno.
- Sobre `acid` y `flash` el texto es siempre `ink-fixed` (`#201533`). Sobre `panel-deep` el texto es `ink`, nunca `ink-muted` (3,9:1, no llega).
- Un solo tema, oscuro, por decisión: es una cámara que se usa a menudo con poca luz y la paleta Citrink vive en oscuros. No hay tema claro.
- Sin degradados en la interfaz. Los degradados son cosa de los efectos.
- La interfaz **no usa transparencias**: ni `rgba`, ni desenfoque. Los fondos de etiqueta son sólidos.

## Tipografía

Cuatro familias, cada una con un trabajo:

- **Rubik Glitch** (`display`, Google Fonts): el nombre del producto, el nombre de cada efecto al cambiarlo y los sellos de evento. Una sola grosor, ancha y negra. Es la voz de cartel. Se usa a 30 px o más.
- **Rubik Glitch Pop** (`pop`, Google Fonts): reservada. Pantalla de arranque, icono y errores graves como `SIN SEÑAL`. Es el grito; si aparece todo el rato, deja de serlo.
- **Martian Mono** (`mono`): todas las etiquetas, códigos y textos de interfaz. Etiquetas en mayúsculas a 10 px con `0.08em` de interletra. Las glitch no se leen pequeñas; por eso hay una mono limpia al lado.
- **Doto** (`dot`): lecturas numéricas en matriz de puntos: contador de grabación y valores de las macros. Los fps no aparecen en la interfaz; viven en el HUD de depuración (triple toque en una esquina).

Reglas:
- Rubik Glitch **nunca** baja de 30 px y nunca se usa para un texto que haya que leer con prisa.
- Una etiqueta nunca pasa de 3 palabras.
- Los números siempre van en Doto o con `tabular-nums`; nunca bailan al cambiar.
- Los textos de Rubik Glitch van en mayúsculas. Antes de usar un carácter con tilde o eñe, se comprueba que el glifo existe en la fuente (la Ñ existe: `SEÑAL`).
- El nombre de un efecto aparece grande en Rubik Glitch solo al seleccionarlo (`hold`, 600 ms) y desaparece. El resto del tiempo es un código en Martian Mono.
- **Ese nombre va sin fondo**, directamente sobre la imagen, en blanco con fusión *diferencia* (`mix-blend-mode: difference`), así se lee sobre cualquier color. Es la única excepción a "solo Citrink": al invertir lo que tiene debajo, el texto puede tomar colores fuera de la paleta durante esos 600 ms.

## Forma y retícula

- Retícula de 4 px (`space-1`). Todo mide múltiplos de 4.
- `radius-0` para paneles, etiquetas, miniaturas y cajones.
- `radius-key` (2 px) solo para teclas físicas.
- `radius-knob` para el obturador, los encoders y los LED.
- **Sin sombras.** La separación se hace con `panel-deep` o con un trazo de 1 px en `lagoon`.
- Los controles viven en el tercio inferior, al alcance del pulgar, alineados a la retícula. El centro del visor está prohibido para la interfaz.

## Icono de la app

Dos planchas desregistradas (`acid` sobre `flash`) con un objetivo recortado en `viewfinder` y el centro en `grass`, sobre fondo `viewfinder`. Es la firma de la portada reducida a icono, y cabe en la zona segura de los iconos adaptables de Android. Fuente: `public/icon.svg`; los PNG se generan con `node scripts/icons.mjs`.

## Iconografía

No hay librería de iconos. Cada control es una palabra en `label` o un pictograma dibujado con tres primitivas (círculo, cuadrado, línea) en una caja de 16 px, trazo de 2 px, extremos rectos. Si un pictograma necesita más de cuatro primitivas, se usa una palabra.

## Movimiento

- Toda la interfaz usa `ease-step` (`steps(4, end)`): avanza a saltos, nunca con rebote ni muelle.
- `tick` (80 ms) para respuestas de tecla, `clack` (160 ms) para cajones y cambios de efecto.
- Nada se mueve en reposo. Ni pulsos, ni respiraciones, ni brillos.
- Con `prefers-reduced-motion`, el sabotaje se reduce a un cambio de color sin desplazamiento.

## Gestos

La imagen es la superficie de control. Ningún gesto abre menús.

| Gesto | Hace | Lectura en pantalla |
|---|---|---|
| Arrastrar con un dedo | Macro A (horizontal) y macro B (vertical), posición absoluta | `A / ETIQUETA` y `B / ETIQUETA` en Doto mientras dura |
| Pellizcar | Zoom de 1× a 8×: óptico mientras el móvil lo permita, digital a partir de ahí | `ZOOM 2.4×` |
| Girar con dos dedos | Macro C, relativa al valor de partida | `C / ETIQUETA` junto al zoom |
| Doble toque | Restablece macros y zoom | — |
| Deslizar la tira de efectos | Recorre la galería | — |
| Tocar / mantener el obturador | Foto / grabar mientras se mantiene | Sello `GUARDADO` / `REC` |
| Toque en la etiqueta central | Cambia el revelado: ÁCIDO ↔ MORADO | el nombre del modo |
| Triple toque en la etiqueta de cámara | HUD de depuración | fps, ms de GPU, resolución, pases |

Reglas:
- El navegador nunca hace zoom ni scroll sobre la app; todos los gestos son nuestros (`touch-action: none`).
- Levantar un dedo de un pellizco no salta a arrastre: hay que soltar y volver a tocar.
- Las lecturas aparecen solo mientras dura el gesto y se van al soltar.
- Cada efecto declara como mucho tres macros (A, B, C) con nombre propio en mayúsculas.

## Protocolo de sabotaje

Las únicas rupturas permitidas, cada una ligada a un evento:

| Evento | Sabotaje | Duración |
|---|---|---|
| Foto | Las capas `flash` y `grass` de las etiquetas se desplazan `misreg` (3 px) en direcciones opuestas y vuelven; entra el sello `GUARDADO` | `hold` |
| Empezar a grabar | Sello `REC` en `flash`, que se queda fijo arriba mientras graba | mientras dure |
| Cambio de efecto | Un fotograma de fotocopia (la imagen a 1 bit, umbral duro) y el nombre del efecto en Rubik Glitch | `xerox-frame` + `hold` |
| Foto o empezar a grabar, en efectos que lo usan | La propia imagen se sabotea: en TRAMA las planchas saltan de registro (señal `event: shot`) | 0,6 s |
| Error o señal perdida | Pantalla de error en Rubik Glitch Pop sobre `flash`, torcida `stamp-angle` | hasta resolverse |

El sello es el único elemento que puede girar fuera del ángulo recto, y solo `stamp-angle`. Lo dibuja el mismo motor que los efectos, así que hereda el efecto activo.

## La galería: once preguntas visuales

Cada efecto trata una sola cuestión de lo visual. Si dos efectos responden a la misma pregunta, sobra uno.

| Código | Nombre | Pregunta | Herramienta |
|---|---|---|---|
| FX-07 | TRAMA | Imprenta de cómic | sombras en tinta sólida, trama fina y suave en los medios, contornos entintados, papel con manchas, fibras y grano; plancha de color desregistrada que salta al disparar |
| FX-12 | ESPEJO | Simetría | espejo en abismo: reflejos anidados y espejados, sin marco; cada rebote los degrada con bitcrush (bloques y menos color) |
| FX-14 | HALO | Luz | pintar con luz: solo lo brillante deja estela, como una exposición larga; la estela fresca es verde y la vieja pasa a morado y se deshace en humo; al hacer foto o grabar, un fogonazo la borra y empieza una exposición nueva |
| FX-19 | MUDA | Memoria | solo lo que se mueve deja fantasmas de color, que fluyen sobre un relieve de ruido y se arrastran en bloques siguiendo el movimiento real (datamosh); lo quieto queda nítido |
| FX-22 | BARRIDO | Tiempo | máquina del tiempo: cada zona de la imagen va con su propio retraso, hasta 2 s, según un mapa (degradado, anillos, ruido o el brillo de la imagen) repetible en bandas; los cuerpos se estiran y se derriten |
| FX-31 | LETRA | Tipografía | la imagen escrita con caracteres reales de Martian Mono, ordenados por densidad |
| FX-44 | SEÑAL | Vídeo analógico | tracking, nieve, sangrado; tocar la imagen hace perder la sincronía (la imagen rueda) |
| FX-50 | ORDEN | Glitch digital | pixel sorting real, calculado en la GPU con un compute shader |
| FX-60 | RELIEVE | Relieve | terreno de líneas de cresta, encuadre frontal y bajo; número de líneas como gesto |
| FX-66 | CIUDAD | Masa | bloques en vista isométrica, tan altos como brillante es la imagen |
| FX-69 | TALLA | Talla | la imagen como relieve texturizado, casi de frente: lo brillante avanza, los contrastes se vuelven paredes y púas; halo en las luces |

Las escenas 3D (60–69) tienen un encuadre fijo y compuesto, con un balanceo lento para que se lea el volumen. Ya no usan el giroscopio.

Cada efecto expone hasta tres macros con nombre propio (A, B, C; ver *Gestos*).

## Revelado: el sello de la casa

Todo lo que sale de la app (visor, fotos, vídeos y miniaturas) pasa por el mismo revelado final. Es lo que hace que una imagen sea reconocible sin ver la interfaz, igual que un aparato de Teenage Engineering suena a sí mismo en cualquier preset.

1. **Curva de tono:** una S suave, siempre la misma.
2. **Mapa de degradado, en uno de dos modos** (etiqueta central de la pantalla; la app recuerda el último):
   - **ÁCIDO:** la rampa Citrink: `viewfinder` → `panel` → `panel-deep` → `lagoon` → `grass` → `acid` → `flash` → blanco.
   - **MORADO:** los mismos escalones de luminosidad, en violeta: `#201533` → `#2f1d4e` → `#47257a` → `#66309f` → `#8c3fbf` → `#b763d6` → `#e8b4f0` → `#fff4ff`. Es la única excepción a "solo Citrink", y solo en la imagen; la interfaz sigue en Citrink (salvo el cuadradito de muestra de la etiqueta).

   En los dos, el color de la cámara solo asoma al 30 %. No hay más modos.
3. **Tramado ordenado:** 12 niveles con una matriz Bayer de 4×4 a 2 píxeles (1 píxel en las miniaturas). Es la textura de la cultura Lospec y de las pantallas de aparato.
4. **Sello de fecha:** en las fotos y en los vídeos, abajo a la derecha, como el dorso de fecha de las cámaras de carrete: `FX07 TRAMA 26.10.30`, en Doto, en el tono claro del modo (amarillo `flash` en ÁCIDO, lila `#e8b4f0` en MORADO) con contorno `viewfinder`. No aparece en el visor, donde ya está la etiqueta.

Los valores viven en `HOUSE` (`src/gpu/engine.ts`). Un efecto nuevo no se diseña "a color": se diseña para que funcione a través del revelado.

## Los efectos y la paleta

Los efectos de la galería también usan Citrink: sus rampas de color, dither y capas de impresión salen de estos ocho colores. Así, la imagen y la interfaz parecen del mismo aparato. Las miniaturas de efecto usan la rampa del efecto, nunca colores fuera de la paleta.

## Voz y nombres

Seca, técnica y un poco absurda, como un manual de servicio escrito por alguien que se ríe por dentro.

- Los efectos tienen un **código de catálogo** y **una palabra**: `FX-07 TRAMA`, `FX-12 ESPEJO`, `FX-19 MUDA`. Palabras concretas en español, nunca adjetivos de marketing.
- Las capturas se numeran como un catálogo de discos: `HMC-0423.jpg`, `HMC-0424.mp4`.
- Los mensajes dicen qué pasa y qué hacer, sin disculpas ni exclamaciones: `SEÑAL PERDIDA. TOCA PARA REINTENTAR.`

| Sí | No |
|---|---|
| `GUARDADO` | ¡Foto guardada con éxito! 🎉 |
| `FX-07 TRAMA` | Efecto Mágico Retro |
| `SIN MICRO` | Ups, parece que algo salió mal |

## Sonido y háptica

- Háptica con `navigator.vibrate`: tecla 8 ms; obturador `[12, 40, 12]`; empezar a grabar 30 ms.
- Sonido opcional, apagado por defecto: clics cortos de onda cuadrada generados con Web Audio, sin muestras grabadas. Cada tecla suena distinta según su posición.

## Lista negra

Esto no aparece nunca en la interfaz:

- Inter, Roboto, Poppins, Space Grotesk.
- Cualquier color fuera de Citrink. Degradados, brillos neón, transparencias.
- Cristal translúcido, desenfoque de fondo, sombras suaves, tarjetas flotantes.
- Esquinas redondeadas genéricas (todo lo que no es `radius-0`, `radius-key` o `radius-knob`).
- Iconos de librería (Material, Lucide) y emojis.
- Animaciones con rebote o elementos que se mueven en reposo.
- Rubik Glitch por debajo de 30 px, o Rubik Glitch Pop fuera de sus tres usos.
- Sabotaje permanente: grano, ruido o glitch decorativo sin evento que lo cause.
