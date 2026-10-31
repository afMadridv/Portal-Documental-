# Reglas del repositorio

## Salva_vidas: la base completa en un archivo

`base-de-datos/Salva_vidas.sql` tiene toda la estructura de la base
(tablas, funciones, permisos, bucket, tarea diaria) en un solo archivo.
Se mantiene al día SIEMPRE, sin excepción, cada vez que cambia la base:

1. El cambio va en una migración nueva: `base-de-datos/migracion_<qué>.sql`,
   idempotente y dentro de una transacción, como las demás.
2. Su fila se agrega al final de la tabla «Orden de los archivos SQL» de
   `base-de-datos/LEEME.md`.
3. Se rearma: `node base-de-datos/armar_salva_vidas.mjs`
4. `Salva_vidas.sql` va en el mismo commit que la migración.
   `node base-de-datos/armar_salva_vidas.mjs --revisar` tiene que pasar.

`Salva_vidas.sql` no se edita a mano. Nunca lleva datos (usuarios,
expedientes, credenciales).

## Producto genérico

Este portal se vende a distintas entidades. Nada de una entidad concreta
va en el código: nombre, NIT, correo, dirección y demás salen de
`PORTAL_CONFIG.ENTIDAD` en `sitio/portal/js/config.js` (en HTML con
`data-entidad="..."`, en JS con `NOMBRE_ENTIDAD` / `DATOS_ENTIDAD`).

## Comentarios y firma

Los comentarios de lo que llega al navegador (HTML, JS, CSS) son cortos y
directos, como notas de quien programa: una o dos líneas, sin explicar lo
que el código ya dice, sin « » ni guiones largos. Se ven con «Inspeccionar».

Cada archivo nuevo de sitio/ y de funciones/ empieza con la firma:

    /*! Legajo · <qué es>
        Andrés Madrid · andresmadrid.vercel.app */

y cada página HTML nueva lleva el monograma AM después del <!DOCTYPE>,
<meta name="author" content="Andrés Madrid"> y js/firma.js (firma en la consola).
