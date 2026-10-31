/*! Legajo · días hábiles en Colombia
  Lunes a viernes sin festivos (Ley Emiliani). La misma lista está en la
  tabla festivos_colombia: si se agrega un año aquí, también allá.
  Andrés Madrid · andresmadrid.vercel.app */

/* Festivos 2024 a 2030 */
const FESTIVOS_COLOMBIA = [
    // 2024
    '2024-01-01', '2024-01-08', '2024-03-25', '2024-03-28', '2024-03-29',
    '2024-05-01', '2024-05-13', '2024-06-03', '2024-06-10', '2024-07-01',
    '2024-07-20', '2024-08-07', '2024-08-19', '2024-10-14', '2024-11-04',
    '2024-11-11', '2024-12-08', '2024-12-25',
    // 2025
    '2025-01-01', '2025-01-06', '2025-03-24', '2025-04-17', '2025-04-18',
    '2025-05-01', '2025-06-02', '2025-06-23', '2025-06-30', '2025-07-20',
    '2025-08-07', '2025-08-18', '2025-10-13', '2025-11-03', '2025-11-17',
    '2025-12-08', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03',
    '2026-05-01', '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29',
    '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02',
    '2026-11-16', '2026-12-08', '2026-12-25',
    // 2027
    '2027-01-01', '2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26',
    '2027-05-01', '2027-05-10', '2027-05-31', '2027-06-07', '2027-07-05',
    '2027-07-20', '2027-08-07', '2027-08-16', '2027-10-18', '2027-11-01',
    '2027-11-15', '2027-12-08', '2027-12-25',
    // 2028
    '2028-01-01', '2028-01-10', '2028-03-20', '2028-04-13', '2028-04-14',
    '2028-05-01', '2028-05-29', '2028-06-19', '2028-06-26', '2028-07-03',
    '2028-07-20', '2028-08-07', '2028-08-21', '2028-10-16', '2028-11-06',
    '2028-11-13', '2028-12-08', '2028-12-25',
    // 2029
    '2029-01-01', '2029-01-08', '2029-03-19', '2029-03-29', '2029-03-30',
    '2029-05-01', '2029-05-14', '2029-06-04', '2029-06-11', '2029-07-02',
    '2029-07-20', '2029-08-07', '2029-08-20', '2029-10-15', '2029-11-05',
    '2029-11-12', '2029-12-08', '2029-12-25',
    // 2030
    '2030-01-01', '2030-01-07', '2030-03-25', '2030-04-18', '2030-04-19',
    '2030-05-01', '2030-06-03', '2030-06-24', '2030-07-01', '2030-07-20',
    '2030-08-07', '2030-08-19', '2030-10-14', '2030-11-04', '2030-11-11',
    '2030-12-08', '2030-12-25'
];
const _FESTIVOS_SET = new Set(FESTIVOS_COLOMBIA);

/* 'AAAA-MM-DD' o Date → Date a medianoche local */
function _aFecha(f) {
    if (f instanceof Date) return new Date(f.getFullYear(), f.getMonth(), f.getDate());
    const [a, m, d] = String(f).split('-').map(Number);
    return new Date(a, m - 1, d);
}

/* Date → 'AAAA-MM-DD' en hora local */
function _aISO(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

/* Lunes a viernes y no festivo */
function esDiaHabil(fecha) {
    const d = _aFecha(fecha);
    const dia = d.getDay(); // 0 = domingo, 6 = sábado
    if (dia === 0 || dia === 6) return false;
    return !_FESTIVOS_SET.has(_aISO(d));
}

/* Suma n días hábiles, sin contar el día dado: viernes + 3 = miércoles. */
function sumarDiasHabiles(fecha, diasHabiles) {
    const d = _aFecha(fecha);
    let n = Math.max(0, Math.floor(Number(diasHabiles) || 0));
    while (n > 0) {
        d.setDate(d.getDate() + 1);
        if (esDiaHabil(d)) n--;
    }
    return _aISO(d);
}

/* Resta n días hábiles. */
function restarDiasHabiles(fecha, diasHabiles) {
    const d = _aFecha(fecha);
    let n = Math.max(0, Math.floor(Number(diasHabiles) || 0));
    while (n > 0) {
        d.setDate(d.getDate() - 1);
        if (esDiaHabil(d)) n--;
    }
    return _aISO(d);
}

/* Días hábiles entre dos fechas (sin la inicial, con la final). Negativo = atraso.
   lunes a viernes de la misma semana = 4. */
function contarDiasHabiles(fechaInicio, fechaFin) {
    const ini = _aFecha(fechaInicio);
    const fin = _aFecha(fechaFin);
    if (fin < ini) return -contarDiasHabiles(fin, ini);
    let cuenta = 0;
    const d = new Date(ini);
    while (d < fin) {
        d.setDate(d.getDate() + 1);
        if (esDiaHabil(d)) cuenta++;
    }
    return cuenta;
}

/* Vencimiento: n días hábiles desde el inicio. Si el inicio no es hábil,
   cuenta desde el siguiente hábil. */
function calcularVencimientoHabil(fechaInicio, diasLimite) {
    let d = _aFecha(fechaInicio);
    // inicio no hábil: el día 1 es el siguiente hábil
    if (!esDiaHabil(d)) {
        while (!esDiaHabil(d)) d.setDate(d.getDate() + 1);
        return sumarDiasHabiles(d, Math.max(1, diasLimite) - 1);
    }
    return sumarDiasHabiles(d, Math.max(1, diasLimite));
}

/* Primer día hábil desde la fecha dada. */
function primerDiaHabil(fecha) {
    const d = _aFecha(fecha);
    while (!esDiaHabil(d)) d.setDate(d.getDate() + 1);
    return _aISO(d);
}

/* El color del semáforo lo calcula la base (calcular_semaforo). Aquí solo
   aritmética de fechas; en modo práctica, db.js. */

function fechaISOLocalHabil() {
    const d = new Date();
    return _aISO(d);
}
