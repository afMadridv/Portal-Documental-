# Legajo · video de presentación

Video de 75 s en dos formatos con un mismo guion:

- **9:16** (1080×1920): Reels, Shorts, TikTok, LinkedIn en el celular.
- **16:9** (1920×1080): portafolio web y YouTube.

El proyecto de Remotion en esta carpeta arma los dos a partir de
`src/guion.ts`. Las grabaciones de la interfaz van en
`public/grabaciones/`. Mientras falten, el video muestra un hueco con el
nombre del archivo que hay que grabar.

---

## 1. Concepto

### Lo que es Legajo

Según el repositorio, Legajo es un portal documental para **notarías**
(insolvencia de persona natural) y **centros de conciliación**. Junta en
un solo lugar lo que hoy anda disperso:

- **Carpetas:** una por proceso, con subcarpetas.
- **Documentos:** con anexos (1, 1.1, 1.2…), audios y videos.
- **Plazos:** un semáforo que cuenta días hábiles colombianos.
  - Insolvencia: 60 días, 90 con prórroga.
  - Conciliación: 3 meses más 3.
- **Avisos del plazo:** a 4, 3, 2 y 1 semana, un día antes y el mismo día.
- **Audiencias:** se citan por correo y la constancia sale en PDF.
- **Conversación:** chat por trámite y soporte con llamada.
- **Avisos en el celular:** llegan a la campana y al teléfono.
- **Roles:** administrador, operador, monitor, cliente y acreedor; cada uno ve solo lo suyo.

### Propuesta de valor, en una línea

> **Cada proceso, en orden y a tiempo.**

### Idea del video: «Del papel suelto al legajo en orden»

Tres actos:

1. **Tensión.** Un plazo se acaba y los papeles caen sueltos. Los
   expedientes viven en correos, chats y hojas de cálculo.
2. **Orden.** Todo cae dentro de una carpeta kraft y nace la marca. De ahí
   en adelante, la interfaz real resuelve cada problema, uno por escena.
3. **Llamado.** Marca, frase y el botón «Ingresar al portal».

### Estilo

- **Paleta Archivo Kraft:**
  - Pizarra `#454B48` para la estructura.
  - Kraft `#C9A46A` para la marca.
  - Verde lomo `#2E7D4F` para lo resuelto.
  - Rojo `#A2452F` para lo vencido.
- **Letras:**
  - Familjen Grotesk para títulos.
  - Work Sans para textos.
  - IBM Plex Mono para rótulos.
  - Bricolage Grotesque solo para «egajo».
- **Movimiento:**
  - Entradas con resorte (*spring*) y titulares que suben palabra por palabra.
  - Avisos flotantes como los de la campana, y contadores que corren.
  - Dentro de las grabaciones, la cámara empuja hacia la zona de la acción.
- **Ritmo:** un corte o una entrada cada 1,5 a 2,5 s. Las escenas de
  interfaz duran 6 a 7,5 s, lo justo para leer el título y ver una acción completa.
- **Sonido:**
  - Música instrumental de 100 a 110 BPM, mínima: piano y percusión suave.
  - Efectos cortos: papel al caer, «tic» en cada aviso, clic en el botón final.
  - En redes el video arranca sin sonido, así que **todo el mensaje está en
    pantalla**. La locución es opcional.

---

## 2. Estructura y tiempos

Cada transición dura 0,4 s y se solapa con las dos escenas que une.

| # | Escena | Tipo | Desde | Hasta |
|---|--------|------|------:|------:|
| 1 | Gancho: el plazo se acaba | Motion | 0,0 | 4,0 |
| 2 | Problema: expedientes sueltos | Motion | 3,6 | 8,6 |
| 3 | Marca | Motion | 8,2 | 12,7 |
| 4 | Oficinas | Interfaz | 12,3 | 18,8 |
| 5 | Carpetas | Interfaz | 18,4 | 25,4 |
| 6 | Documentos | Interfaz | 25,0 | 32,5 |
| 7 | Días hábiles | Motion | 32,1 | 38,1 |
| 8 | Plazos y semáforo | Interfaz | 37,7 | 43,7 |
| 9 | Audiencias | Interfaz | 43,3 | 50,8 |
| 10 | Conciliación | Interfaz | 50,4 | 57,4 |
| 11 | En equipo | Interfaz + celular | 57,0 | 64,0 |
| 12 | Expediente en PDF | Interfaz | 63,6 | 69,1 |
| 13 | Cierre | Motion | 68,7 | 75,2 |

**Transiciones:**
- Entre dos escenas de interfaz: deslizamiento, desde la derecha en 16:9 y desde abajo en 9:16.
- Hacia y desde las de motion: fundido.

---

## 3. Guion técnico segundo a segundo

**Convenciones:**
- **H** es la disposición en 16:9 y **V** en 9:16.
- Los segundos son del video final.
- «Locución» es opcional. Si se usa, va con subtítulos quemados, porque el texto en pantalla ya los cubre.

### Escena 1 · Gancho (0,0 – 4,0)

| s | Qué pasa | Texto en pantalla | Sonido |
|---|----------|-------------------|--------|
| 0,0 | Fondo pizarra. Empiezan a caer hojas kraft, rotando, con 4 cuadros de diferencia entre una y otra. | — | Papel |
| 0,2 | El titular sube palabra por palabra. | **¿Cuántos plazos vencen esta semana?** | — |
| 1,0 | Aparece el contador «DÍA HÁBIL 48 DE 60». | — | Tic-tac suave |
| 1,0 – 3,2 | El número corre de 48 a 60. | — | — |
| 3,2 | Llega a 60 y se pone rojo. Las hojas quedan amontonadas abajo. | — | Golpe seco |
| 3,6 | Fundido a la escena 2. | — | — |

- **H:** titular de 104 px, centrado, en 1300 px de ancho. Las hojas caen sobre todo el ancho y se apilan al 74 % del alto.
- **V:** titular de 104 px en 936 px de ancho, a 3 o 4 líneas. El contador queda debajo y las hojas se apilan al 78 % del alto, dentro de la zona que tapa la app, porque son decorado.
- **Locución:** «¿Cuántos plazos vencen esta semana?»

### Escena 2 · Problema (3,6 – 8,6)

| s | Qué pasa | Texto | Sonido |
|---|----------|-------|--------|
| 3,6 | Fondo claro. El titular entra. | **Expedientes en correos, chats y hojas sueltas.** | — |
| 4,0 – 5,0 | Seis tarjetas brotan una tras otra (sin logos de marcas reales):<br>· «Correo · RV: acreencias_v3_FINAL.pdf»<br>· «Chat · ¿Ya me citaron a la audiencia?»<br>· «Hoja de cálculo · plazos (2).xlsx»<br>· «Carpeta compartida · Escaneo 0042.pdf»<br>· «Llamada perdida · Acreedor · 3 intentos»<br>· «Nota · ¿Vence el 14 o el 15?» | — | Un «pop» por tarjeta |
| 5,0 – 7,0 | Las tarjetas tiemblan: es el caos. | — | — |
| 7,0 – 8,0 | Las tarjetas se encogen y viajan al centro. La carpeta kraft cae y se las traga. | — | Succión + golpe |
| 8,2 | Fundido a la marca. | — | — |

- **H:** tarjetas repartidas en dos columnas sueltas y el titular arriba, a 110 px del borde.
- **V:** las tarjetas en zigzag entre el 36 % y el 78 % del alto, y el titular arriba, a 250 px (zona segura).
- **Locución:** «Hoy los expedientes viven en correos, chats y hojas sueltas.»

### Escena 3 · Marca (8,2 – 12,7)

| s | Qué pasa | Texto | Sonido |
|---|----------|-------|--------|
| 8,2 | Fondo pizarra con un brillo kraft al centro. El ícono (carpeta kraft) cae con rebote y su clip se dibuja. | — | Golpe suave |
| 8,4 – 9,3 | El clip traza la «L» y luego se descubre «egajo». | **Legajo** | Trazo |
| 9,6 | El titular sube. | **Cada proceso, en orden y a tiempo.** | — |
| 10,2 | Aparece el rótulo mono en kraft. | INSOLVENCIA · CONCILIACIÓN | — |

- **H:** ícono de 200 px y logo de 200 px lado a lado, con el titular debajo.
- **V:** ícono de 240 px arriba, logo de 210 px debajo, titular de 68 px y el rótulo al final. Todo centrado.
- **Locución:** «Legajo. Cada proceso, en orden y a tiempo.»

### Escena 4 · Oficinas (12,3 – 18,8) · interfaz `01-oficinas`

| s | Qué pasa | Texto | Avisos flotantes |
|---|----------|-------|------------------|
| 12,3 | Entra la ventana del navegador, girando desde la derecha (H) o subiendo (V). Rótulo «01 · OFICINAS». | **Notarías y centros de conciliación.** | — |
| 12,8 | Sale el subtítulo. | Cada oficina con sus carpetas. El portal se ajusta al trámite. | — |
| 12,3 – 14,7 | En la grabación, la pantalla «¿En qué oficina vas a trabajar?». La cámara empuja hacia las tarjetas de oficina. | — | — |
| 14,5 | — | — | **Notaría · insolvencia**, 60 días hábiles, 90 con prórroga (verde) |
| 15,7 | — | — | **Centro de conciliación**, 3 meses, prorrogables 3 más (kraft) |
| 17,7 | El encuadre baja hacia el botón «Entrar a…». | — | — |

### Escena 5 · Carpetas (18,4 – 25,4) · `02-carpetas` y celular `02-carpetas`

| s | Qué pasa | Texto |
|---|----------|-------|
| 18,4 | Rótulo «02 · CARPETAS». | **Una carpeta por proceso.** |
| 18,9 | Subtítulo. | Lo activo, lo que vence y lo vencido, de un vistazo. |
| 19,2 – 20,2 | Contadores grandes que corren desde 0. | **6** activas · **2** por vencer · **1** vencida |
| 19,6 | **H:** el celular entra encima de la esquina inferior izquierda de la ventana, con la misma vista en móvil. | — |
| 21,9 | La cámara baja de las cifras a las tarjetas de carpeta. | — |

- **V:** solo va el celular grande (1080 px de alto). Los contadores van bajo el subtítulo.

### Escena 6 · Documentos (25,0 – 32,5) · `03-documentos`

| s | Qué pasa | Texto | Avisos |
|---|----------|-------|--------|
| 25,0 | Rótulo «03 · DOCUMENTOS». | **Arrastra, suelta y queda en el legajo.** | — |
| 25,5 | — | Anexos 1.1 y 1.2, subcarpetas, audios y videos. | — |
| 25,0 – 28,0 | En la grabación se arrastra un PDF a la zona de subida y corre la barra de progreso. | — | — |
| 28,0 | — | — | **Documento nuevo**: Poder especial del apoderado.pdf |
| 29,6 | En la grabación se elige «Anexo de 1». | — | **Anexo 1.1**: Relación de acreencias.xlsx (kraft) |
| 31,5 | El encuadre se abre un poco para mostrar la lista numerada. | — | — |

### Escena 7 · Días hábiles (32,1 – 38,1) · motion

| s | Qué pasa | Texto |
|---|----------|-------|
| 32,1 | Fondo claro. Las 35 celdas del calendario brotan en cascada. | Rótulo «DÍAS HÁBILES COLOMBIANOS» |
| 32,2 | — | **Sábados, domingos y festivos no cuentan.** |
| 33,1 – 33,9 | Los fines de semana y dos festivos se tachan en gris. | — |
| 33,7 – 35,3 | Los días hábiles se llenan de kraft uno por uno y el contador corre de 0 a 60. | **60** días hábiles · insolvencia |
| 34,7 | — | En conciliación: 3 meses, prorrogables 3 más. |
| 35,5 – 36,4 | Se encienden 6 avisos en fila; los dos últimos, en rojo. | 4 semanas · 3 semanas · 2 semanas · 1 semana · 1 día · El día |

- **H:** textos a la izquierda (640 px), calendario a la derecha y la fila de avisos de lado a lado abajo.
- **V:** textos arriba, el calendario a todo el ancho (celdas de 118 px) y los avisos en 2 filas de 3.

### Escena 8 · Plazos y semáforo (37,7 – 43,7) · `04-estados`

| s | Qué pasa | Texto | Avisos |
|---|----------|-------|--------|
| 37,7 | Rótulo «04 · PLAZOS». | **El semáforo avisa antes de que venza.** | — |
| 38,2 | — | Verde al día, naranja por vencer, rojo vencido. | — |
| 37,7 – 40,7 | En la grabación, el tablero Estados con sus columnas Vencidos, Por vencer, En curso y Completados. Zoom a la columna roja. | — | — |
| 39,7 | — | — | **Vence mañana**: Martha L. Ríos · 2026-0418 (kraft) |
| 41,3 | — | — | **Venció hace 2 días**: Inversiones Duarte · 2026-0397 (rojo) |

### Escena 9 · Audiencias (43,3 – 50,8) · `05-audiencias`

| s | Qué pasa | Texto | Avisos |
|---|----------|-------|--------|
| 43,3 | Rótulo «05 · AUDIENCIAS». | **Cita la audiencia. Las partes se enteran.** | — |
| 43,8 | — | Correo a cada parte y constancia de notificación en PDF. | — |
| 43,3 – 46,5 | En la grabación se programa la audiencia (fecha, hora y lugar) y se pulsa «Notificar audiencia». | — | — |
| 46,5 | — | — | **Audiencia notificada**: 4 acreedores avisados por correo (verde) |
| 48,1 | En la grabación, «Descargar constancia (PDF)». | — | **Constancia lista**: Constancia de notificación.pdf |

### Escena 10 · Conciliación (50,4 – 57,4) · `06-conciliacion`

| s | Qué pasa | Texto | Avisos |
|---|----------|-------|--------|
| 50,4 | Rótulo «06 · CONCILIACIÓN». | **En el centro, todo habla de conciliación.** | — |
| 50,9 | — | Convocante y convocado, 3 meses y el resultado al cerrar. | — |
| 50,4 – 53,6 | En la grabación se cambia al centro de conciliación: aparecen las leyes de conciliación y la palabra «Convocante». Luego «Fin de trámite» abre la ventana del resultado. | — | — |
| 53,9 | En la grabación se elige «Acuerdo total». | — | **Acuerdo total**: recuerda registrarlo en el SICAAC (verde) |

### Escena 11 · En equipo (57,0 – 64,0) · `07-chat` y celular `07-cliente`

| s | Qué pasa | Texto | Avisos |
|---|----------|-------|--------|
| 57,0 | Rótulo «07 · EN EQUIPO». | **Chat por trámite y avisos en el celular.** | — |
| 57,5 | — | Cliente, acreedores y operador, cada uno en lo suyo. | — |
| 58,2 | **H:** entra el celular con la vista del cliente sobre la ventana del chat. **V:** solo va el celular grande. | — | — |
| 59,4 | — | — | **Mensaje del cliente**: «Ya subí la cédula» |
| 61,0 | — | — | **Vence en 1 semana**: aviso en el celular del administrador (kraft) |

### Escena 12 · Expediente (63,6 – 69,1) · `08-expediente`

| s | Qué pasa | Texto |
|---|----------|-------|
| 63,6 | Rótulo «08 · EXPEDIENTE». | **Todo el expediente en un PDF.** |
| 64,1 | — | En el orden que elijas y numerado. O la carpeta entera en un ZIP. |
| 63,6 – 66,6 | En la grabación se marcan documentos y se ordenan; «Generar expediente» abre el PDF numerado en el visor. | — |

### Escena 13 · Cierre (68,7 – 75,2)

| s | Qué pasa | Texto | Sonido |
|---|----------|-------|--------|
| 68,7 | Fondo pizarra con brillo kraft. El ícono cae y el logo se dibuja. | **Legajo** | Trazo |
| 69,7 | — | **Cada proceso, en orden y a tiempo.** | — |
| 70,3 | Entra el botón kraft y después «late» suave. | **Ingresar al portal →** | Clic |
| 70,9 | La dirección, en mono. | `portal-documental-lac.vercel.app` (constante `SITIO` en `guion.ts`) | — |
| 75,2 | Fin. Los últimos 2 s quedan quietos, así que sirven de portada. | — | La música cierra |

- **Locución:** «Legajo. Entra a tu portal.»

---

## 4. Cómo se adapta cada formato

| | 16:9 (1920×1080) | 9:16 (1080×1920) |
|---|---|---|
| Zona segura | 90 px arriba y abajo, 110 px a los lados | 250 px arriba, 420 px abajo, 72 px a la izquierda y 150 px a la derecha (íconos de Reels y Shorts) |
| Texto de escena | Columna izquierda de 600 px, centrada en vertical | Bloque arriba, desde y = 250 |
| Titular | 66 px | 78 px |
| Subtítulo | 28 px | 34 px |
| Interfaz de escritorio | Ventana de 1050×740 a la derecha, con poco zoom (40 % del indicado en `focos`) | Ventana de 936 px de ancho debajo del texto, con el zoom completo de `focos`; recorta la grabación hacia la acción |
| Interfaz de celular | Celular de 560 px de alto encima de la ventana | Celular de 1080 px de alto, solo |
| Avisos | Alrededor de la ventana: arriba a la derecha y abajo | Sobre la mitad inferior, entre y = 1150 y y = 1550 |
| Transición entre interfaces | Deslizar desde la derecha | Deslizar desde abajo |

**Reglas del encuadre vertical:**
- Una grabación de escritorio no se ve entera en 9:16. Por eso cada escena trae `focos`: dónde mirar y con cuánto zoom, segundo a segundo.
- Donde la versión móvil cuenta mejor la historia (carpetas y cliente), se usa la grabación de celular.

---

## 5. Implementación técnica

### Por qué Remotion

- El guion vive en código: un solo `guion.ts` alimenta las dos composiciones.
- Cambiar un texto, un tiempo o el encuadre de una toma es editar un dato y volver a renderizar.
- Los colores y letras son los mismos del portal.

### Estructura

```
video/
├── GUION.md               este documento
├── package.json           scripts: estudio, horizontal, vertical, todo, cuadro
├── remotion.config.ts     H.264, JPEG, sobrescribir
├── public/grabaciones/    tus grabaciones (no van al repositorio)
│   ├── escritorio/        01-oficinas.mp4 … 08-expediente.mp4
│   └── celular/           02-carpetas.mp4, 07-cliente.mp4
└── src/
    ├── index.ts           registerRoot
    ├── Raiz.tsx           composiciones LegajoHorizontal y LegajoVertical
    ├── Video.tsx          TransitionSeries: escenas y transiciones
    ├── guion.ts           ESCENAS: textos, tiempos, archivos, focos, avisos
    ├── formato.ts         useFormato(): vertical, zona segura, tamaño de letra
    ├── marca.ts           colores, tonos y fuentes (@remotion/google-fonts)
    ├── componentes/
    │   ├── Marca.tsx      Logo (la «L» se dibuja con evolvePath) e Icono
    │   ├── Piezas.tsx     Aviso flotante, Contador, Rótulo, Titular, Subir
    │   ├── Marcos.tsx     Navegador y Celular
    │   └── Grabacion.tsx  OffthreadVideo con encuadre animado, o el hueco si falta
    └── escenas/
        ├── EscenaUI.tsx   plantilla de las escenas de interfaz (H y V)
        └── Movimiento.tsx Gancho, Problema, Marca, Dias y Cierre
```

### Cómo funciona

- **Dos composiciones, un componente.** `LegajoHorizontal` (1920×1080) y
  `LegajoVertical` (1080×1920) usan el mismo `<Video/>`. Cada escena
  pregunta `useFormato()` y elige su disposición.
- **Escenas como datos.** Una escena de interfaz se define así:

  ```ts
  {
      tipo: 'ui', id: 'audiencias', dura: 7.5,
      eti: '05 · Audiencias',
      titulo: 'Cita la audiencia. Las partes se enteran.',
      sub: 'Correo a cada parte y constancia de notificación en PDF.',
      escritorio: 'grabaciones/escritorio/05-audiencias.mp4',
      focos: [{ en: 0, x: 0.55, y: 0.4, zoom: 1.6 }, { en: 3.5, x: 0.6, y: 0.55, zoom: 1.9 }],
      avisos: [{ en: 3.2, titulo: 'Audiencia notificada', detalle: '4 acreedores avisados por correo', tono: 'verde' }],
  }
  ```

- **Encuadre animado.** `Grabacion` interpola `x`, `y` y `zoom` entre los
  focos con *ease in-out*. Centra el punto y lo limita para que nunca se
  vea el borde del video.
- **Fuentes de imagen.** Cada escena prueba primero tu grabación
  (`public/grabaciones/…mp4`) y, si no está, usa la captura del portal en
  modo práctica (`public/capturas/…webp`), con un acercamiento lento. Así el
  video sale completo desde ya; cuando grabes, tus tomas reemplazan las
  capturas solas. Si no hay ninguna de las dos, se pinta un recuadro con el
  nombre del archivo que falta.
- **Capturas.** `npm run capturas` copia el sitio en modo práctica, entra
  con Edge sin ventana y fotografía cada pantalla con los datos inventados
  de `db.js`. Escribe en `public/capturas/` y, las que usa la página de
  inicio, en `sitio/img/inicio/`. Vuelve a correrlo cuando cambie el portal.
- **Transiciones.** `@remotion/transitions` con `slide()` y `fade()`, de
  12 cuadros. La duración total se calcula sola en `guion.ts` (`DURACION`).

### Comandos

```bash
npm install
npm run estudio
npm run horizontal
npm run vertical
npm run cuadro -- LegajoVertical salida/v.png --frame=400
```

- `npm run estudio`: abre el editor en el navegador, con las dos composiciones.
- `npm run horizontal`: genera `salida/legajo-16x9.mp4`.
- `npm run vertical`: genera `salida/legajo-9x16.mp4`.
- `npm run cuadro`: saca un cuadro suelto para revisar.
- `npm run capturas`: rehace las fotos del portal con datos inventados.
- `npm run pagina`: renderiza el 16:9 y su portada en `sitio/video/`, que es
  el video de la página de inicio.

Si Remotion no encuentra Chrome, añade
`--browser-executable="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`.

### Música y subtítulos

- **Música:** pon el archivo en `public/musica.mp3` y añade
  `<Audio src={staticFile('musica.mp3')} volume={0.6} />` dentro de
  `<Video/>`. Si quieres que suba al entrar y baje al final, usa
  `interpolate` en `volume`.
- **Subtítulos de la locución:** se pueden sacar de `guion.ts` a un `.srt`
  para YouTube. En Reels conviene quemarlos con el mismo `Titular`.

### Otras vías

- **After Effects:** el mismo guion sirve. Arma una composición madre de
  1920×1080 y otra de 1080×1920. Los textos van como *Essential Graphics*
  y las grabaciones se encuadran con *Auto Reframe* de Premiere.
- **Screen Studio o Tella:** sirven para grabar con zoom automático al
  cursor. Exporta las tomas sin fondo ni marco: el marco lo pone el video.

### Entrega

| Formato | Archivo | Uso |
|---|---|---|
| 9:16 · 1080×1920 · H.264 · 30 fps | `legajo-9x16.mp4` | Reels, Shorts, TikTok, LinkedIn móvil (menos de 90 s) |
| 16:9 · 1920×1080 · H.264 · 30 fps | `legajo-16x9.mp4` | YouTube, portafolio web |
| Portada 16:9 | cuadro final (`--frame=2200`) | Miniatura de YouTube |
| Portada 9:16 | cuadro de la marca (`--frame=330`) | Portada del Reel |

---

## 6. Guía de grabación

### Antes de grabar

1. **Usa solo datos de práctica.** Corre el portal en modo práctica:
   `SUPABASE_URL` vacío en `config.js`, o la copia local con
   `python -m http.server`. Entra con `administrador` / `administrador123`.
   Nunca grabes expedientes reales: son datos personales y caen bajo la
   Ley 1581 de 2012.
2. **Prepara los datos.** Deja listas una notaría (Santa Marta) y un centro
   de conciliación (Barranquilla). Debe haber unas 6 carpetas con nombres
   de ejemplo: una vencida, dos por vencer, una con acuerdo y una pausada.
   Ten a mano unos PDF, un XLSX y una JPG de prueba para arrastrarlos.
3. **Prepara el navegador.** Un perfil de Chrome limpio, sin barra de
   favoritos ni extensiones visibles. Zoom al 100 %, tema claro (y una
   toma extra en oscuro si quieres B-roll).
4. **Escritorio:** ventana a **1920×1080** exactos, a 60 fps, con OBS o
   Screen Studio. Graba la pestaña, no toda la pantalla.
5. **Celular:** dos opciones.
   - DevTools de Chrome en modo dispositivo **390×844**, a 3x, grabando
     solo el área emulada.
   - Grabar la pantalla de un teléfono real (resultado de unos 1080×2340).

   En los dos casos, el video debe quedar vertical, entre 9:19,5 y 9:16.
6. **Cursor:** grande y con resaltado de clic. Muévelo despacio. Antes de
   cada clic, quédate quieto 0,5 s: así el encuadre vertical alcanza a
   seguirlo.
7. **Cada toma:** deja 1 s de pantalla quieta al empezar y al terminar.
   Haz una sola acción por toma y repítela hasta que salga limpia.
   Exporta a MP4 H.264.

### Tomas

Los nombres deben coincidir con `guion.ts`. Si cambias uno, cámbialo allá.

| Archivo | Duración | Pantalla y acciones | Dónde ocurre (para el 9:16) |
|---|---|---|---|
| `escritorio/01-oficinas.mp4` | 8 s | Ingreso con `administrador`. Aparece «¿En qué oficina vas a trabajar?». Pasa el cursor por la tarjeta del centro de conciliación (insignia kraft) y por la notaría (insignia verde). Elige la notaría y pulsa «Entrar a…». | Tarjetas arriba a la derecha y botón al centro (x 0,7, y 0,3 → 0,55) |
| `escritorio/02-carpetas.mp4` | 9 s | Vista Carpetas de la notaría: cifras arriba. Baja despacio hasta las tarjetas, pasa el cursor por una y abre el menú «⋯» sin elegir nada. | Cifras (y 0,3) y luego tarjetas (y 0,62) |
| `celular/02-carpetas.mp4` | 9 s | La misma vista a 390 px: cifras apiladas. Baja con el dedo hasta dos tarjetas de carpeta. | Toda la pantalla |
| `escritorio/03-documentos.mp4` | 9 s | Abre una carpeta, pestaña de documentos. Arrastra un PDF desde el Explorador a la zona de subida y espera la barra. En el XLSX recién subido elige «Anexo de 1» (queda 1.1). | Zona de subida (y 0,35), luego la lista (y 0,6 a 0,7) |
| `escritorio/04-estados.mp4` | 8 s | Menú «Estados»: columnas Vencidos, Por vencer, En curso y Completados. Pasa el cursor por la tarjeta roja y después por una naranja. | Columna izquierda, la de vencidos (x 0,3) |
| `escritorio/05-audiencias.mp4` | 9 s | En una carpeta, «Programar audiencia»: fecha, hora, lugar y partes. «Notificar audiencia», vista del correo, y luego «Descargar constancia (PDF)». | Ventana al centro (x 0,55 a 0,6, y 0,4 a 0,55) |
| `escritorio/06-conciliacion.mp4` | 9 s | Cambia de oficina al centro de conciliación: se ven las leyes de conciliación y «Convocante». En Estados, «Fin de trámite» abre la ventana del resultado; elige «Acuerdo total» y confirma. | Ventana del resultado al centro (zoom 2) |
| `escritorio/07-chat.mp4` | 8 s | En una carpeta, abre el chat del trámite, canal del cliente. Escribe y envía «Recibido, gracias». Luego abre la campana con su número. | Chat a la derecha (x 0,75) |
| `celular/07-cliente.mp4` | 9 s | Ingreso como `cliente` en el teléfono. Se ve solo su trámite y el semáforo «en qué va su trámite». Sube una foto de la galería. | Toda la pantalla |
| `escritorio/08-expediente.mp4` | 7 s | «Generar expediente»: marca 4 documentos, sube uno con las flechas y genera. El PDF numerado se abre en el visor. | Ventana al centro |

**Opcionales (B-roll):**
- `escritorio/09-oscuro.mp4`: cambiar de tema claro a oscuro.
- `escritorio/10-rendimiento.mp4`: el tablero de Rendimiento del administrador.
- `escritorio/11-calendario.mp4`: calendario de vencimientos.

### Después de grabar

1. Copia las tomas a `public/grabaciones/escritorio/` y `public/grabaciones/celular/`.
2. Abre `npm run estudio` y recorre las dos composiciones. Si una acción
   queda fuera del recuadro vertical, ajusta los `focos` de esa escena:
   `x` y `y` van de 0 a 1 sobre la grabación y `zoom` de 1 a 2.
3. Si una toma quedó corta, aumenta `dura` en esa escena o recorta la
   grabación. El total se recalcula solo.
4. Renderiza con `npm run todo`.
