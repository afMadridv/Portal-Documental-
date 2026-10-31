# Legajo

Portal para llevar expedientes de insolvencia y conciliación por notaría:
carpetas y subcarpetas, documentos con anexos, chat por trámite, soporte
con llamada, campana y avisos en el celular, semáforo de plazos,
calendario de audiencias, consentimiento de datos, actividad y un tablero
de Rendimiento para el administrador. Desarrollado por Andrés Madrid
(andresmadrid.vercel.app).

Esta copia sale **vacía**: sin usuarios, sin notarías, sin carpetas y sin
datos de ninguna entidad.

## Cómo está organizado

```
sitio/                lo único que se publica en internet
├── portal/           el Portal Documental (/portal/): páginas, css/, js/,
│                     sw.js, manifest.json, las páginas legales y
│                     manual/videos/ (videos del Modo de uso)
├── img/              íconos del portal y favicon
├── css/, js/         estilos y movimiento de la página de inicio
├── video/            el video de presentación (16:9) que muestra la página
└── 404.html, robots.txt, index.html (página de inicio de Legajo)
base-de-datos/        estructura de la base: esquema.sql, migraciones y
                      Salva_vidas.sql (todo en uno). Ver LEEME.md
funciones/            Edge Functions de Supabase: crear-usuario,
                      restablecer-clave y avisos-push
video/                video de presentación (Remotion, 16:9 y 9:16).
                      Guion y guía de grabación en video/GUION.md
```

## Ajustar para una entidad

Todo en `sitio/portal/js/config.js`:

- `SUPABASE_URL` y `SUPABASE_KEY`: el proyecto de Supabase. Vacíos, el
  portal corre en **modo práctica** (datos de ejemplo en el navegador).
- `ENTIDAD`: nombre, razón social, NIT, registro, dirección, ciudad,
  correo y teléfono. Salen en el consentimiento, las páginas legales y
  los correos que arma el portal.

La base y las funciones se instalan como dice `base-de-datos/LEEME.md`.

## Publicar en Vercel

`vercel.json` publica solo `sitio/` (sin compilar nada) y pone las
cabeceras de seguridad y de caché. En `/` queda la página de inicio de
Legajo; si una entidad no la quiere, se vuelve a mandar `/` a `/portal/`
con un `redirects` en `vercel.json`. La
Content-Security-Policy nombra el proyecto de Supabase
(`nsjytwlbqnxpkdbsfiva.supabase.co`): si cambia el proyecto, se cambia
ahí y en `config.js`. Si algo deja de cargar, la consola del navegador
(F12) dice qué bloqueó.

Después de publicar, el dominio va en el secreto `ORIGENES_PERMITIDOS`
de la función `avisos-push`.

## Probar en local

```bash
python -m http.server 8731 -d sitio
```

`http://localhost:8731/portal/`. En modo práctica entran
`administrador` / `administrador123`, `operador` / `operador123`,
`monitor` / `monitor123`, `cliente` / `cliente123` y `acreedor` /
`acreedor123`. Traen datos inventados: una notaría y un centro de
conciliación, diez carpetas con documentos, audiencias y chat, y el
semáforo con plazos al día, por vencer, vencidos y en pausa.
