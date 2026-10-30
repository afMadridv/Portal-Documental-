# Base de datos del Portal Documental

`Salva_vidas.sql` trae toda la estructura de la base (tablas, funciones,
permisos RLS, disparadores, el bucket de documentos, la tarea diaria de
los plazos y los festivos hasta 2030) en un solo archivo. **No trae
datos**: ni usuarios, ni notarías, ni carpetas.

## Instalar en un Supabase nuevo

1. Correr `Salva_vidas.sql` entero sobre la base vacía (SQL Editor de
   Supabase o `psql -v ON_ERROR_STOP=1 -f Salva_vidas.sql`). Necesita las
   extensiones `pg_cron` y `pg_net` activas.
2. En Authentication: desactivar el registro público (signups) y el
   ingreso por teléfono. Las cuentas solo las crea el administrador.
3. Crear el primer administrador a mano: Authentication → Add user, con
   correo `<usuario>@portal.documental.com`, una contraseña y *Auto Confirm*.
   La primera cuenta de una base vacía nace administradora y activa
   (`crear_perfil_nuevo`). Después, en `public.perfiles`, ponerle
   `nombre` y `correo`. Desde ahí se crean las notarías y los demás
   usuarios en el portal.
4. Publicar las funciones de `funciones/`: `crear-usuario` y
   `restablecer-clave` con verificación de JWT, `avisos-push` sin ella
   (`--no-verify-jwt`).
5. Si se usan los avisos en el celular: secretos `VAPID_PUBLICA`,
   `VAPID_PRIVADA`, `VAPID_CONTACTO`, `AVISOS_CLAVE` (texto al azar) y
   `ORIGENES_PERMITIDOS` (el dominio del portal) en la función, y en la base:

   ```sql
   insert into public.push_ajustes (id, url, clave)
   values (1, 'https://<proyecto>.supabase.co/functions/v1/avisos-push', '<AVISOS_CLAVE>')
   on conflict (id) do update set url = excluded.url, clave = excluded.clave;
   ```
6. En `sitio/portal/js/config.js`: `SUPABASE_URL`, `SUPABASE_KEY` y los
   datos de `ENTIDAD`.

`DOMINIO_USUARIOS` (`portal.documental.com`) tiene que ser el mismo en
`config.js`, en la función `crear-usuario` y en
`migracion_registro_cerrado.sql`.

## Cambiar la base

1. El cambio va en una migración nueva: `migracion_<qué>.sql`,
   idempotente y dentro de una transacción, como las demás.
2. Su fila se agrega al final de la tabla de abajo.
3. Se rearma: `node base-de-datos/armar_salva_vidas.mjs`
4. `node base-de-datos/armar_salva_vidas.mjs --revisar` tiene que pasar.

`Salva_vidas.sql` no se edita a mano.

## Orden de los archivos SQL

El orden importa: cada uno asume el anterior.

| # | Archivo | Qué trae |
|---|---------|----------|
| 1 | `esquema.sql` | Las tablas, funciones, políticas, el bucket y la publicación de Realtime |
| 2 | `migracion_cierre_y_descargas.sql` | Cierre de trámite y control de descargas |
| 3 | `migracion_subcarpetas.sql` | Subcarpetas |
| 4 | `migracion_seguridad_2026_08.sql` | Endurecimiento de permisos |
| 5 | `migracion_festivos_y_cron.sql` | Festivos hasta 2030 y la tarea diaria |
| 6 | `migracion_notarias.sql` | Multi-notaría: reescribe `puede_ver_carpeta` |
| 7 | `migracion_avisos_plazo.sql` | Avisos del plazo a 4, 3, 2, 1 semanas, 1 día y el mismo día |
| 8 | `migracion_notificaciones_por_notaria.sql` | Los avisos no se mezclan entre oficinas, y el correo obligatorio por rol |
| 9 | `migracion_credenciales.sql` | Las contraseñas asignadas, para el Excel |
| 10 | `migracion_tipo_proceso.sql` | El régimen de la carpeta |
| 11 | `migracion_almacenamiento.sql` | La barra de espacio lee el disco de verdad |
| 12 | `migracion_tope_archivo.sql` | 500 MB por archivo, para las grabaciones de audiencias |
| 13 | `migracion_peso_incremental.sql` | El peso de la carpeta se suma en vez de recontarse en cada archivo |
| 14 | `migracion_almacenamiento_ver.sql` | El portal consulta el disco por una función, no leyendo la tabla |
| 15 | `migracion_rls_initplan.sql` | `auth.uid()` se evalúa una vez por consulta y no una por fila |
| 16 | `migracion_sesion_unica.sql` | Una sola sesión abierta por cuenta: el último ingreso desplaza al anterior |
| 17 | `migracion_monitor_sin_chat.sql` | El monitor deja de leer las conversaciones y sus adjuntos |
| 18 | `migracion_endurecimiento_2026_09.sql` | Cierra el acceso anónimo |
| 19 | `migracion_campana_por_persona.sql` | Cada campana decide sola: el aviso ya no se salta porque otro lo tenga |
| 20 | `migracion_tablero_notarias.sql` | La pantalla de notarías muestra lo que vence y, al administrador, lo que ocupa cada oficina |
| 21 | `migracion_registro_cerrado.sql` | Una cuenta que no creó un administrador nace inactiva |
| 22 | `migracion_metricas_web.sql` | El tablero «Rendimiento» del administrador: visitas al ingreso, ingresos al portal y metas del mes |
| 23 | `migracion_permisos_internos.sql` | Vuelve a cerrar `_notificar` y las demás funciones internas, le quita a `anon` los permisos sobre tablas y le da a cada llamada de soporte un canal secreto |
| 24 | `migracion_presencia_privada.sql` | «En línea» por latido en la base: solo lo ve el administrador |
| 25 | `migracion_anexos.sql` | Anexos de un documento (1, 1.1, 1.2…) y «mover a otra subcarpeta» |
| 26 | `migracion_intentos_fallidos.sql` | Intentos fallidos de ingreso por cuenta, para el tablero de Rendimiento |
| 27 | `migracion_avisos_push.sql` | Avisos en el celular del administrador y chat de soporte también para el monitor |
| 28 | `migracion_aviso_solicitud_clave.sql` | El aviso de solicitud de clave dice nombre y rol, y se repite si la persona insiste |
| 29 | `migracion_renombrar_y_tope_300.sql` | El administrador y el operador renombran documentos y videos, y el tope por archivo baja a 300 MB |
| 30 | `migracion_ajustes_cloud.sql` | search_path fijo en las funciones de ayuda de los avisos y `rls_auto_enable` cerrada a usuarios con sesión |
| 31 | `migracion_almacenamiento_storage.sql` | Almacenamiento se mide en Storage de Supabase contra el cupo del plan, sin tarea del servidor |

`limpieza_portal.sql` y `mantenimiento_huerfanos.sql` no entran aquí:
son herramientas aparte. La primera vacía un portal que ya está en uso;
la segunda solo LEE, y busca archivos que ocupan disco sin que el portal
pueda nombrarlos.

---
