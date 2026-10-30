// ============================================================
// Arma Salva_vidas.sql: toda la estructura de la base en un archivo.
// ------------------------------------------------------------
// Junta esquema.sql y las migraciones, en el orden de la tabla
// «Orden de los archivos SQL» de base-de-datos/LEEME.md. Esa tabla
// es la única lista: para sumar una migración nueva se agrega su fila
// allí y se vuelve a correr esto.
//
//   node base-de-datos/armar_salva_vidas.mjs            rehace el archivo
//   node base-de-datos/armar_salva_vidas.mjs --revisar  solo avisa si está
//                                                          viejo (sale con 1)
//
// Se niega a armarlo si hay un migracion_*.sql que no está en la
// tabla: así ninguna se queda por fuera sin que nadie lo note.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DESTINO = path.join(DIR, 'Salva_vidas.sql');
// Herramientas aparte, no estructura: la primera VACÍA un portal en uso
const FUERA = ['limpieza_portal.sql', 'mantenimiento_huerfanos.sql', 'Salva_vidas.sql'];

function fallar(texto) {
    console.error('Salva_vidas: ' + texto);
    process.exit(1);
}

// ---- El orden, del LEEME de esta carpeta ----
const guia = fs.readFileSync(path.join(DIR, 'LEEME.md'), 'utf8').replace(/\r/g, '');
const inicio = guia.indexOf('## Orden de los archivos SQL');
if (inicio < 0) fallar('no encontré «## Orden de los archivos SQL» en LEEME.md.');
const seccion = guia.slice(inicio, guia.indexOf('\n---', inicio));
const partes = [...seccion.matchAll(/^\|\s*(\d+)\s*\|\s*`([^`]+\.sql)`\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map((m) => ({ n: Number(m[1]), archivo: m[2], que: m[3].replace(/`/g, '') }));
if (!partes.length) fallar('la tabla del orden está vacía.');
partes.forEach((p, i) => {
    if (p.n !== i + 1) fallar('la tabla salta del ' + i + ' al ' + p.n + ': revisa la numeración.');
    if (!fs.existsSync(path.join(DIR, p.archivo))) fallar('la tabla nombra ' + p.archivo + ', que no existe.');
});
const enTabla = new Set(partes.map((p) => p.archivo));
const sueltos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && !FUERA.includes(f) && !enTabla.has(f));
if (sueltos.length) {
    fallar('estos archivos no están en la tabla del orden de LEEME.md: ' + sueltos.join(', ') +
        '. Agrégalos en su lugar y vuelve a correr esto.');
}

// ---- El archivo ----
const cuerpo = partes.map((p) => {
    const sql = fs.readFileSync(path.join(DIR, p.archivo), 'utf8').replace(/\r/g, '').replace(/\s+$/, '');
    return '\n\n-- ############################################################\n' +
        '-- PARTE ' + p.n + ' DE ' + partes.length + ': ' + p.archivo + '\n' +
        '-- ' + p.que + '\n' +
        '-- ############################################################\n\n' + sql + '\n';
}).join('');
const huella = crypto.createHash('sha256').update(cuerpo).digest('hex').slice(0, 16);

const cabecera = `-- ============================================================
-- SALVA_VIDAS.sql
-- La estructura completa de la base del Portal Documental, en un solo
-- archivo.
-- ============================================================
-- NO SE EDITA A MANO. Lo arma armar_salva_vidas.mjs con los archivos de
-- esta carpeta. Para cambiar la base se escribe una migración nueva, se
-- agrega a la tabla de base-de-datos/LEEME.md y se vuelve a armar:
--     node base-de-datos/armar_salva_vidas.mjs
--
-- QUÉ TRAE
--   Todo lo que hace falta para que el portal funcione en un Supabase
--   nuevo: las tablas y sus columnas, los índices, las funciones, los
--   permisos de cada rol (RLS), los disparadores, el bucket de los
--   documentos, la tarea diaria de los plazos y los festivos hasta 2030.
--   Son las ${partes.length} partes de abajo, en orden.
--
-- QUÉ NO TRAE: LOS DATOS
--   Usuarios, notarías, carpetas, documentos, mensajes y cifras no van
--   aquí, ni en git: son datos personales de expedientes judiciales,
--   y la tabla de credenciales guarda contraseñas. De esos se encargan
--   los respaldos de la base.
--
-- CUÁNDO SE USA
--   Sobre un Supabase recién creado y vacío. Deja el portal listo para
--   crear el primer administrador (base-de-datos/LEEME.md).
--
-- CÓMO
--   psql "<cadena de conexión>" -v ON_ERROR_STOP=1 -f Salva_vidas.sql
--
--   ON_ERROR_STOP=1 corta en el primer error: si algo falla, se lee la
--   PARTE donde se detuvo y se resuelve antes de seguir. Cada parte va
--   en su propia transacción, así que lo que ya pasó queda bien hecho.
--
-- Partes: ${partes.length}    Huella: ${huella}
-- ============================================================
`;
const nuevo = cabecera + cuerpo;

if (process.argv.includes('--revisar')) {
    // Git en Windows puede haberlo sacado con CRLF: se compara sin eso
    const actual = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8').replace(/\r\n/g, '\n') : '';
    if (actual !== nuevo) fallar('está viejo. Córrelo sin --revisar para ponerlo al día.');
    console.log('Salva_vidas está al día (' + partes.length + ' partes, huella ' + huella + ').');
} else {
    fs.writeFileSync(DESTINO, nuevo);
    console.log('Salva_vidas.sql listo: ' + partes.length + ' partes, ' + nuevo.split('\n').length + ' líneas, huella ' + huella + '.');
}
