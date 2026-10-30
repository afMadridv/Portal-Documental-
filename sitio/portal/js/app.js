/*! Portal Documental · lógica principal
  Roles: administrador (todo), monitor (ve todo, no cambia nada),
  operador (sus carpetas activas), cliente y acreedor (sus carpetas
  activas, ver y descargar). Los permisos reales los aplica la base.
  Andrés Madrid · andresmadrid.vercel.app */

// ---- Protección de la página: sin sesión válida no se entra ----
const ROLES_VALIDOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];
const sesion = sesionActual();
if (!sesion) {
    location.replace('./');
} else if (!ROLES_VALIDOS.includes(sesion.rol)) {
    cerrarSesion(); // sesión de una versión vieja
}

// Nombre de la entidad en avisos y correos (config.js → entidad.js)
const DATOS_ENTIDAD = window.ENTIDAD || {};
const NOMBRE_ENTIDAD = DATOS_ENTIDAD.NOMBRE || 'la entidad';

// En la barra queda /portal/ (solo cambia lo que se ve).
if (sesion && /\/app\.html$/.test(location.pathname)) {
    history.replaceState(history.state, '', './' + location.search + location.hash);
}

// Qué se puede subir depende de dónde (destinoAdmiteExtension).
// Listas amplias: las grabaciones llegan en cualquier formato.
const EXTENSIONES_MEDIA = [
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp',
    'mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'flac', 'wma', 'opus', 'amr'
];
const EXTENSIONES_DOCUMENTO = [
    'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt',
    'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'odp',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'
];
const EXTENSIONES_PERMITIDAS = EXTENSIONES_DOCUMENTO.concat(EXTENSIONES_MEDIA);
// Vista: PDF, imágenes, audio y video con el navegador; Word y Excel en visor.html.
const EXTENSIONES_VISTA = EXTENSIONES_PERMITIDAS.slice();
// Igual al file_size_limit del bucket (migracion_renombrar_y_tope_300.sql) y al
// FILE_SIZE_LIMIT de Storage. Si no coinciden, se rechaza al final de la subida.
const TAMANO_MAXIMO = 300 * 1024 * 1024;
const TAMANO_MAXIMO_TXT = (TAMANO_MAXIMO / 1048576) + ' MB';

// Desde aquí se recomienda comprimir (no se impide): la subida no se reanuda.
const AVISO_VIDEO_MB = 100;

// Solo video; el audio pesa poco
const EXTENSIONES_VIDEO = [
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp'
];
function esVideo(nombre) {
    return EXTENSIONES_VIDEO.includes(extensionDe(nombre));
}

/* Subidas en paralelo. Más de cuatro no acelera y hace que las últimas
   se agoten esperando. */
const SUBIDAS_A_LA_VEZ = 4;

/* N tareas a la vez; cada una toma el siguiente al terminar. */
async function enTandas(lista, n, tarea, seguir) {
    let siguiente = 0;
    const obreros = Array.from(
        { length: Math.min(n, lista.length) },
        async () => {
            while (siguiente < lista.length) {
                // `seguir` para entre archivos. Lo que ya va subiendo termina (cortarlo
                // deja binarios sin fila).
                if (seguir && !seguir()) return;
                await tarea(lista[siguiente++]);
            }
        }
    );
    await Promise.all(obreros);
}

/* Tiempo máximo por archivo según tamaño (100 KB/s), mínimo 2 minutos.
   Sin esto una petición colgada congelaba el lote. */
function esperaPorArchivo(bytes) {
    return Math.max(120000, Math.round((bytes / (100 * 1024)) * 1000));
}

/* Promesa con tiempo límite. */
function conLimite(promesa, ms) {
    let reloj;
    const tope = new Promise((_, rechazar) => {
        reloj = setTimeout(
            () => rechazar(new Error('la subida se quedó colgada y se dio por perdida')),
            ms);
    });
    return Promise.race([promesa, tope]).finally(() => clearTimeout(reloj));
}

/* ============ PROGRESO DE SUBIDA ============
   Cuenta archivos terminados y nombra el que va subiendo. */
let _progresoCerrarTemporizador = null;
let _progresoFaena = 'subir';   // 'subir' | 'borrar'
let _subidaCancelada = false;

function _progresoElementos() {
    return {
        caja:    document.getElementById('subida-progreso'),
        eti:     document.getElementById('subida-progreso-eti'),
        num:     document.getElementById('subida-progreso-num'),
        barra:   document.getElementById('subida-progreso-barra'),
        archivo: document.getElementById('subida-progreso-archivo')
    };
}

/* Al empezar. `consejo`: aviso de videos pesados. `faena`: subir o borrar. */
function progresoSubidaAbrir(total, faena) {
    const e = _progresoElementos();
    if (!e.caja) return;
    _progresoFaena = faena || 'subir';
    _subidaCancelada = false;

    // Parar solo al subir (borrar termina en segundos)
    const parar = document.getElementById('subida-cancelar');
    if (parar) {
        parar.hidden = _progresoFaena !== 'subir';
        parar.disabled = false;
        parar.textContent = 'Cancelar';
    }

    clearTimeout(_progresoCerrarTemporizador);
    e.caja.classList.remove('pt-progreso--listo', 'pt-progreso--fallo');
    e.eti.textContent = _progresoFaena === 'borrar'
        ? (total === 1 ? 'Eliminando el documento…' : 'Eliminando los documentos…')
        : (total === 1 ? 'Subiendo el documento…' : 'Subiendo los documentos…');
    e.num.textContent = '0 de ' + total;
    e.barra.style.width = '0%';
    e.archivo.textContent = '';
    e.caja.hidden = false;
}

/* ============ CONSEJO DE LOS VIDEOS ============
   Fuera del panel de progreso: se queda hasta que lo cierren. */
function mostrarConsejo(texto) {
    const caja = document.getElementById('subida-consejo');
    const txt = document.getElementById('subida-consejo-texto');
    if (!caja || !txt || !texto) return;
    txt.textContent = texto;
    caja.hidden = false;
}

function cerrarConsejo() {
    const caja = document.getElementById('subida-consejo');
    if (caja) caja.hidden = true;
}

/* Parar la subida: lo que va en vuelo termina, lo que no empezó no empieza. */
function cancelarSubida() {
    _subidaCancelada = true;
    const parar = document.getElementById('subida-cancelar');
    if (parar) { parar.disabled = true; parar.textContent = 'Cancelando…'; }
}

/* Un archivo más terminado (bien o mal; los fallos se cuentan al final). */
function progresoSubidaAvance(hechos, total, nombre) {
    const e = _progresoElementos();
    if (!e.caja || e.caja.hidden) return;
    e.num.textContent = hechos + ' de ' + total;
    e.barra.style.width = (total ? Math.round((hechos / total) * 100) : 0) + '%';
    e.archivo.textContent = nombre || '';
}

/* Cierra el progreso dejando el resultado unos segundos. */
function progresoSubidaCerrar(subidos, fallidos) {
    const e = _progresoElementos();
    if (!e.caja) return;
    const hubo = subidos + fallidos;
    e.barra.style.width = '100%';
    e.archivo.textContent = '';
    e.caja.classList.toggle('pt-progreso--fallo', fallidos > 0);
    e.caja.classList.toggle('pt-progreso--listo', fallidos === 0);
    e.eti.textContent = fallidos === 0
        ? (_progresoFaena === 'borrar'
            ? (subidos === 1 ? 'Documento eliminado' : 'Documentos eliminados')
            : (subidos === 1 ? 'Documento subido' : 'Documentos subidos'))
        : (_progresoFaena === 'borrar'
            ? 'Borrado terminado con fallos'
            : 'Subida terminada con fallos');
    e.num.textContent = fallidos === 0
        ? subidos + ' de ' + hubo
        : subidos + ' de ' + hubo + ' · ' + fallidos +
          (_progresoFaena === 'borrar' ? ' sin borrar' : ' sin subir');
    const parar = document.getElementById('subida-cancelar');
    if (parar) parar.hidden = true;

    /* Sonido al terminar; con fallos, el de mensaje. typeof por si sonar()
       no está cargado. */
    if (typeof sonar === 'function') sonar(fallidos === 0 ? 'subida' : 'mensaje');

    clearTimeout(_progresoCerrarTemporizador);
    _progresoCerrarTemporizador = setTimeout(() => {
        e.caja.hidden = true;
        e.caja.classList.remove('pt-progreso--listo', 'pt-progreso--fallo');
    }, fallidos > 0 ? 9000 : 4000);
}

const SESION_VALIDA = !!(sesion && ROLES_VALIDOS.includes(sesion.rol));
const ES_ADMIN = SESION_VALIDA && sesion.rol === 'administrador';
// Monitor: ve todo como el admin (menos usuarios) y no cambia nada.
const ES_MONITOR = SESION_VALIDA && sesion.rol === 'monitor';
const ES_SUPERVISION = ES_ADMIN || ES_MONITOR; // Estados, Calendario, Notificaciones
const ES_OPERADOR = SESION_VALIDA && sesion.rol === 'operador';
const ES_PERSONAL = ES_ADMIN || ES_OPERADOR; // ven estados y suben archivos
const ES_CLIENTE = SESION_VALIDA && sesion.rol === 'cliente';
const ES_ACREEDOR = SESION_VALIDA && sesion.rol === 'acreedor';

/* ¿Puede ver esta carpeta? Admin y monitor todas; operador las suyas
   activas; cliente y acreedor sus activas asignadas. */
function puedeVerCarpeta(c) {
    if (ES_ADMIN || ES_MONITOR) return true; // monitor: todas, solo lectura
    if (ES_OPERADOR) return c.activa && (c.operadores || []).includes(sesion.usuario);
    return c.activa && (c.asignados || []).includes(sesion.usuario);
}

let carpetaAbierta = null;   // carpeta abierta en el detalle
let carpetaEditando = null;  // carpeta del modal (null = nueva)
let nombrePorUsuario = {};   // usuario → nombre visible
let _carpetasVisibles = [];  // carpetas visibles (ya filtradas por rol)
let _conteoArchivos = {};    // carpetaId → nº de archivos
let _procesosPorCarpeta = {}; // carpetaId → procesos del trámite (semáforos)
let _filtroCarpetas = 'activas'; // admin: 'activas' | 'desactivadas'
let _busquedaCarpetas = '';      // buscador de carpetas
let _busquedaEstados = '';       // buscador de Estados

/* Filtro por nombre de carpeta u operador */
function filtrarPorBusqueda(carpetas, texto) {
    const q = String(texto || '').trim().toLowerCase();
    if (!q) return carpetas;
    return carpetas.filter(c =>
        (c.nombre || '').toLowerCase().includes(q) ||
        (c.operadores || []).some(o => (nombreDe(o) || '').toLowerCase().includes(q) || String(o).toLowerCase().includes(q)));
}

/* Nombre visible de un usuario (o el usuario en crudo). */
function nombreDe(usuario) {
    if (usuario === sesion.usuario) return sesion.nombre;
    return nombrePorUsuario[usuario] || usuario;
}

/* ¿Puede gestionar la carpeta? Admin en cualquiera, operador en las
   suyas activas, cliente y acreedor nunca. */
function puedeGestionarCarpeta(c) {
    if (ES_ADMIN) return true;
    return ES_OPERADOR && c.activa && (c.operadores || []).includes(sesion.usuario);
}

document.addEventListener('DOMContentLoaded', iniciar);

// Cualquier error de datos no atrapado sale como aviso
window.addEventListener('unhandledrejection', (evento) => {
    avisar((evento.reason && evento.reason.message) || 'Error de conexión con la base de datos.', 'error');
});

/* Arranque: encabezado, eventos y vista de carpetas. */
let _arranqueHecho = false;

async function iniciar() {
    if (!SESION_VALIDA) return;
    pintarEncabezado();
    conectarEventos();
    pintarLeyes();
    vigilarTablas();

    // Con dos o más notarías se pregunta antes de cargar. El soporte va
    // antes: no depende de ninguna oficina.
    iniciarSoporte();
    // La vigilancia de sesión también va antes del filtro de notaría.
    vigilarSesion();

    const listo = await prepararNotarias();
    if (!listo) return;

    _arranqueHecho = true;
    await mostrarVistaCarpetas();
    // Recordatorios vigentes
    mostrarRecordatoriosVigentes();
    // Soporte, tiempo real y llamadas
    iniciarSoporte();
    // Campana
    iniciarCampana();
    // Consentimiento de datos (primer ingreso de cliente/acreedor)
    verificarConsentimiento();
    // Trámites cerrados: plazo para descargar
    avisarCierresPendientes();
    // Última conexión y presencia
    registrarConexion();
    presenciaIniciar((enLinea) => {
        _usuariosEnLinea = enLinea || new Set();
        pintarEstadoConexion();
    });
    // "Atrás" del navegador no saca del portal
    instalarAtrasSeguro();
    // Aviso al cerrar la pestaña (Decreto 0042 de 2026)
    instalarAvisoCierre();
    // Aviso de ingreso en la campana
    avisarIngresoEnCampana();
    // Avisos en el celular (solo admin) y lo que llega de un aviso tocado
    iniciarAvisosPush();
}

/* ============ CERRAR SESIÓN CON CONFIRMACIÓN (Decreto 0042 de 2026) ============ */
let _cerrandoSesion = false;   // salida confirmada: sin aviso de beforeunload

/* Cierra sesión previa confirmación. `destino` permite ir al sitio principal. */
async function confirmarSalida(destino) {
    if (!await confirmarPortal(
        'Estás a punto de finalizar tu sesión segura bajo los lineamientos del ' +
        'Decreto 0042 de 2026. ¿Deseas confirmar y salir del portal?',
        'Cerrar sesión')) return;
    _cerrandoSesion = true;   // salida intencional
    cerrarSesion(destino);    // limpia los tokens y va al ingreso
}

/* ============ VIGILANCIA DE LA SESIÓN ============
   Cada 2 min y al volver a la pestaña se pregunta al servidor si la cuenta
   sigue activa. Solo se saca a alguien si el servidor dice que no; sin
   red no se hace nada. */
const VIGILANCIA_SESION = 2 * 60 * 1000;
let _vigilanciaReloj = null;
let _vigilanciaEnCurso = false;

async function comprobarSesionViva() {
    if (_vigilanciaEnCurso || _cerrandoSesion) return;
    if (typeof sesionSigueViva !== 'function') return;
    _vigilanciaEnCurso = true;
    let estado = 'nose';
    try { estado = await sesionSigueViva(); } catch (e) { estado = 'nose'; }
    _vigilanciaEnCurso = false;
    // Varios dispositivos a la vez: 'desplazada' ya no saca a nadie, solo 'fuera'
    if (estado !== 'fuera') return;

    clearInterval(_vigilanciaReloj);
    _cerrandoSesion = true;   // salida forzada
    try {
        sessionStorage.setItem('portal_motivo_salida',
            'Tu cuenta fue desactivada o eliminada. Comunícate con la administración.');
    } catch (e) { /* sin sessionStorage sale igual, sin motivo */ }
    cerrarSesion();
}

function vigilarSesion() {
    comprobarSesionViva();
    _vigilanciaReloj = setInterval(comprobarSesionViva, VIGILANCIA_SESION);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) comprobarSesionViva();
    });
}

/* Aviso al cerrar la pestaña con sesión abierta (no en salida intencional). */
function instalarAvisoCierre() {
    window.addEventListener('beforeunload', (e) => {
        if (_cerrandoSesion) return;               // ya confirmó la salida
        if (!sesionActual()) return;               // sin sesión
        e.preventDefault();
        e.returnValue = '';                        // diálogo estándar del navegador
        return '';
    });
}

/* ============ BOTÓN ATRÁS ============
   Cierra lo que esté abierto o vuelve al listado; en el listado ofrece
   salir. Se deja una entrada "trampa" en el historial. */
function instalarAtrasSeguro() {
    history.pushState({ portal: true }, '');
    window.addEventListener('popstate', async () => {
        history.pushState({ portal: true }, ''); // rearmar para el próximo atrás

        // 1) cerrar modal o panel abierto
        const modal = [...document.querySelectorAll('.pt-modal')].find(m => !m.hidden);
        if (modal) { modal.hidden = true; return; }
        const campana = document.getElementById('campana-dropdown');
        if (campana && !campana.hidden) { campana.hidden = true; return; }
        const soporte = document.getElementById('soporte-panel');
        if (soporte && !soporte.hidden) { minimizarSoporte(); return; }

        // 2) fuera del listado de carpetas: volver a él
        if (document.getElementById('vista-carpetas').hidden) { mostrarVistaCarpetas(); return; }

        // 3) en el listado: confirmar salida
        if (await confirmarPortal('¿Quieres cerrar sesión y salir del portal?', 'Salir del portal')) {
            cerrarSesion();
        }
    });
}

/* ============ PRESENCIA: EN LÍNEA / DESCONECTADO ============ */
let _usuariosEnLinea = new Set();

/* Punto de conexión; data-usuario-conexion permite refrescarlo solo. */
function puntoConexion(usuario) {
    const en = _usuariosEnLinea.has(usuario);
    return '<span class="pt-conexion' + (en ? ' pt-conexion--en-linea' : '') + '" data-usuario-conexion="' + escaparHtml(usuario) + '"' +
        ' title="' + (en ? 'En línea' : 'Desconectado') + '"></span> ' + (en ? 'En línea' : 'Desconectado');
}

/* Refresca los puntos sin repintar la tabla */
function pintarEstadoConexion() {
    document.querySelectorAll('[data-usuario-conexion]').forEach(el => {
        const en = _usuariosEnLinea.has(el.dataset.usuarioConexion);
        el.classList.toggle('pt-conexion--en-linea', en);
        el.title = en ? 'En línea' : 'Desconectado';
        if (el.nextSibling && el.nextSibling.nodeType === 3) el.nextSibling.textContent = ' ' + (en ? 'En línea' : 'Desconectado');
    });
}

/* ============ GENERADOR DE CREDENCIALES ============
   12 caracteres con mayúscula, minúscula, número y símbolo
   (crypto.getRandomValues). Visible para copiarla antes de guardar. */
function generarClaveSegura() {
    const azar = (letras, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)))
        .map(x => letras[x % letras.length]).join('');
    return azar('abcdefghjkmnpqrstuvwxyz', 5) + azar('ABCDEFGHJKMNPQRSTUVWXYZ', 3) +
        azar('23456789', 3) + azar('!#$%*+', 1);
}

/* Usuario y clave al azar con crypto.getRandomValues (no Math.random). */
function generarCredenciales() {
    const azar = (letras, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)))
        .map(x => letras[x % letras.length]).join('');
    const usuario = 'usuario' + azar('0123456789', 4);
    const clave = generarClaveSegura();
    document.getElementById('nuevo-usuario').value = usuario;
    document.getElementById('nueva-clave').value = clave;
    avisar('Credenciales generadas: ' + usuario + ' / ' + clave + '. Cópialas antes de guardar.');
}

/* "Generar contraseña segura" en Editar usuario */
function generarClaveEditar() {
    const clave = generarClaveSegura();
    document.getElementById('editar-clave').value = clave; // visible
    avisar('Contraseña generada: ' + clave + '. Cópiala antes de guardar.');
}

/* ============ LEYES DE INSOLVENCIA ============
   Las que se usan en insolvencia de persona natural y conciliación,
   con enlace al texto oficial. */
const LEYES_INSOLVENCIA = [
    { n: 'Ley 1564 de 2012', d: 'Código General del Proceso: insolvencia de la persona natural no comerciante', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1564_2012.html' },
    { n: 'Ley 2445 de 2025', d: 'Reforma de la insolvencia de persona natural, que incluye al pequeño comerciante', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_2445_2025.html' },
    { n: 'Ley 2220 de 2022', d: 'Estatuto de Conciliación', url: 'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=188766' },
    { n: 'Decreto 1069 de 2015', d: 'Reglamento del sector justicia: conciliación e insolvencia', url: 'https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=74174' },
    { n: 'Decreto 0042 de 2026', d: 'Modifica el Decreto 1069 en lo que toca a la conciliación', url: 'https://dapre.presidencia.gov.co/normativa/normativa/DECRETO%20No.%200042%20DEL%2021%20DE%20ENERO%20DE%202026.pdf' },
    { n: 'Ley 1116 de 2006', d: 'Insolvencia de empresas y comerciantes que no son pequeños', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1116_2006.html' },
    { n: 'Ley 1676 de 2013', d: 'Garantías mobiliarias', url: 'http://www.secretariasenado.gov.co/senado/basedoc/ley_1676_2013.html' }
];

/* Enlaces en pestaña nueva con noopener. */
function pintarLeyes() {
    const cont = document.getElementById('lista-leyes');
    if (!cont) return;
    cont.innerHTML = LEYES_INSOLVENCIA.map(l =>
        '<a class="pt-ley" href="' + l.url + '" target="_blank" rel="noopener noreferrer" title="Abrir el texto oficial en una pestaña nueva">' +
            '<span class="pt-ley__ic">' + icono('documento', 18) + '</span>' +
            '<span class="pt-ley__txt"><strong>' + escaparHtml(l.n) + '</strong>' +
            '<span>' + escaparHtml(l.d) + '</span></span>' +
        '</a>').join('');
}

/* Iniciales: "Oscar Prieto" → OP */
function inicialesDe(nombre) {
    const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '—';
    return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
}

/* Nombre, rol, avatar y pestañas según el rol (el permiso real es del servidor). */
function pintarEncabezado() {
    const chip = document.getElementById('chip-usuario');
    if (chip) {
        chip.innerHTML = escaparHtml(sesion.nombre) +
            ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[sesion.rol] || sesion.rol) + '</span>';
    }
    // Persona conectada, al pie de la barra
    const avatar = document.getElementById('mi-avatar');
    const nombre = document.getElementById('mi-nombre');
    const rol = document.getElementById('mi-rol');
    if (avatar) avatar.textContent = inicialesDe(sesion.nombre || sesion.usuario);
    if (nombre) nombre.textContent = sesion.nombre || sesion.usuario;
    if (rol) rol.textContent = ETIQUETAS_ROL[sesion.rol] || sesion.rol;
    // Estados: operador los suyos, admin y monitor todo
    document.getElementById('pestana-estados').hidden = !(ES_PERSONAL || ES_MONITOR);
    // Calendario: todo para supervisión, lo suyo para el operador
    document.getElementById('pestana-calendario').hidden = !(ES_SUPERVISION || ES_OPERADOR);
    document.getElementById('pestana-usuarios').hidden = !ES_ADMIN; // el monitor nunca
    document.getElementById('pestana-notificaciones').hidden = !ES_SUPERVISION;
    // Almacenamiento: solo admin
    document.getElementById('pestana-almacenamiento').hidden = !ES_ADMIN;
    // Rendimiento: solo admin (el servidor lo vuelve a revisar)
    const rendimiento = document.getElementById('pestana-rendimiento');
    if (rendimiento) rendimiento.hidden = !ES_ADMIN;
    document.getElementById('boton-nueva-carpeta').hidden = !ES_ADMIN;

    // SICAAC: solo personal (deudor y acreedor no tienen cuenta ahí).
    const externos = document.getElementById('lateral-externos');
    if (externos) externos.hidden = !(ES_PERSONAL || ES_MONITOR);
}

/* ============ BARRA LATERAL ============
   Bajo 900 px es cajón con tapa. En escritorio se pliega y se recuerda. */
function alternarLateral(abrir) {
    const lateral = document.getElementById('lateral');
    const tapa = document.getElementById('lateral-tapa');
    if (!lateral || !tapa) return;
    const visible = abrir === undefined ? !lateral.classList.contains('abierta') : abrir;
    lateral.classList.toggle('abierta', visible);
    tapa.hidden = !visible;
}

const LATERAL_PLEGADO = 'portal_lateral_plegado';

/* Plegar o desplegar (se recuerda). */
function plegarLateral(plegar) {
    const marco = document.querySelector('.pt-marco');
    if (!marco) return;
    const oculto = plegar === undefined
        ? !marco.classList.contains('pt-marco--plegado')
        : plegar;
    marco.classList.toggle('pt-marco--plegado', oculto);
    // Al desplegar se cierra el cajón de móvil
    if (!oculto) alternarLateral(false);
    try { localStorage.setItem(LATERAL_PLEGADO, oculto ? '1' : '0'); } catch (e) {}
}

/* ☰: cajón en móvil, despliegue en escritorio. */
function mostrarLateral() {
    if (window.matchMedia('(max-width: 900px)').matches) alternarLateral(true);
    else plegarLateral(false);
}

// Estado guardado antes de pintar
try {
    if (localStorage.getItem(LATERAL_PLEGADO) === '1') {
        document.addEventListener('DOMContentLoaded', () => plegarLateral(true));
    }
} catch (e) {}

/* Tarjetas de carpeta con Enter y espacio (teclado). */
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tarjeta = e.target.closest('.pt-tarjeta-carpeta');
    if (!tarjeta || e.target.closest('button')) return;
    e.preventDefault();
    abrirCarpeta(Number(tarjeta.dataset.id));
});

/* Menú ⋯: uno a la vez, se cierra con clic fuera. */
function alternarMenuFila(idLista) {
    const lista = document.getElementById(idLista);
    if (!lista) return;
    const abrir = lista.hidden;
    document.querySelectorAll('.pt-menu__lista').forEach(m => {
        m.hidden = true;
        m.classList.remove('pt-menu__lista--arriba');
    });
    lista.hidden = !abrir;
    if (!abrir) return;
    // Si no cabe abajo, hacia arriba
    const caja = lista.getBoundingClientRect();
    if (caja.bottom > window.innerHeight - 8) {
        lista.classList.add('pt-menu__lista--arriba');
    }
}

/* Cierra los menús ⋯ abiertos. */
function cerrarMenusFila() {
    document.querySelectorAll('.pt-menu__lista').forEach(m => { m.hidden = true; });
}

/* Panel de nuevo usuario */
function alternarCajonUsuario(abrir) {
    const cajon = document.getElementById('cajon-usuario');
    const tapa = document.getElementById('cajon-usuario-tapa');
    if (!cajon || !tapa) return;
    const visible = abrir === undefined ? !cajon.classList.contains('abierto') : abrir;
    cajon.classList.toggle('abierto', visible);
    tapa.hidden = !visible;
    if (visible) {
        const primero = document.getElementById('nuevo-usuario');
        if (primero) primero.focus();
        // Casillas de notaría según el rol (se repintan al cambiarlo)
        cargarCatalogoNotarias().then(() => pintarNotariasDeFormulario([]));
    }
}

/* ============ CACHÉ DE NAVEGACIÓN ============
   Pinta al instante con lo último y revalida por detrás; si el servidor
   trae algo distinto, repinta. */
const _cacheDatos = new Map();

/* Copia guardada o undefined. */
function cacheLeer(clave) {
    const e = _cacheDatos.get(clave);
    return e ? e.valor : undefined;
}

/* Pide, guarda y dice si cambió (compara por JSON). */
async function cacheRefrescar(clave, traer) {
    const valor = await traer();
    const texto = JSON.stringify(valor);
    const antes = _cacheDatos.get(clave);
    const cambio = !antes || antes.texto !== texto;
    _cacheDatos.set(clave, { valor, texto });
    return { valor, cambio };
}

/* Borra la caché. */
function cacheOlvidar() { _cacheDatos.clear(); }

/* Toda escritura tira la caché: se engancha a registrarActividad. */
const ACCIONES_DE_LECTURA = new Set([
    'ingreso', 'abrir-carpeta', 'ver-archivo', 'descargar-archivo',
    'descargar-zip', 'exportar-estados', 'exportar-usuarios',
    'generar-expediente', 'constancia-acreedores', 'llamada-soporte',
    'formato-correo'
]);
if (typeof window.registrarActividad === 'function') {
    const _registrarOriginal = window.registrarActividad;
    window.registrarActividad = function (accion, objetivo, carpetaId) {
        if (!ACCIONES_DE_LECTURA.has(accion)) cacheOlvidar();
        return _registrarOriginal(accion, objetivo, carpetaId);
    };
}

/* ============ NOTARÍAS ============
   Con dos o más se elige al entrar; con una se entra directo.
   Permitidas: seguridad, las decide la base (notarias_del_usuario).
   Activa: preferencia en localStorage, solo filtra la vista. */

const NOTARIA_ACTIVA = 'portal_notaria';
let _notariasDisponibles = [];   // donde puede entrar la sesión
let _notariaActiva = null;       // id abierta; null = todas

/* Notaría abierta o null */
function notariaActual() {
    if (_notariaActiva === null) return null;
    return _notariasDisponibles.find(n => String(n.id) === String(_notariaActiva)) || null;
}

/* ¿La carpeta es de la notaría abierta? (con "todas", sí) */
function esDeNotariaActiva(carpeta) {
    if (_notariaActiva === null) return true;
    return String(carpeta.notariaId) === String(_notariaActiva);
}

/* Filtro de vista; la base ya filtró por permisos. */
function filtrarPorNotaria(carpetas) {
    return (carpetas || []).filter(esDeNotariaActiva);
}

/* ¿El usuario trabaja en esa notaría? Operador con varias y admin en
   todas. null = todas las notarías. */
function usuarioEnNotaria(u, notaria) {
    if (notaria === null || notaria === undefined) return true;
    if (!u) return false;
    if (u.rol === 'administrador') return true;
    const suyas = (u.notarias && u.notarias.length)
        ? u.notarias
        : (u.notariaId ? [u.notariaId] : []);
    // Sin notarías configuradas no se filtra
    if (!suyas.length) return !_notariasDisponibles.length;
    return suyas.some(n => String(n) === String(notaria));
}

/* Carga las notarías y decide si preguntar. false = se quedó en la selección. */
async function prepararNotarias() {
    try {
        _notariasDisponibles = await misNotarias();
    } catch (e) {
        _notariasDisponibles = [];
    }

    if (!_notariasDisponibles.length) {
        /* Sin oficinas: el admin tiene que poder crear la primera desde esta
           pantalla (no está en el menú). */
        if (ES_ADMIN) {
            _notariaActiva = null;
            mostrarPantallaNotarias();
            return false;
        }
        // Los demás no pueden crear oficinas: el portal sigue como una sola.
        _notariaActiva = null;
        pintarNotariaActiva();
        return true;
    }

    // Una sola: directo
    if (_notariasDisponibles.length === 1 && !ES_ADMIN) {
        _notariaActiva = _notariasDisponibles[0].id;
        guardarNotariaActiva();
        pintarNotariaActiva();
        return true;
    }

    // Respeta la elección anterior si sigue valiendo
    let guardada = null;
    try { guardada = localStorage.getItem(NOTARIA_ACTIVA); } catch (e) {}
    if (guardada === 'todas' && ES_ADMIN) {
        _notariaActiva = null;
        pintarNotariaActiva();
        return true;
    }
    if (guardada && _notariasDisponibles.some(n => String(n.id) === String(guardada))) {
        _notariaActiva = Number(guardada);
        pintarNotariaActiva();
        return true;
    }

    mostrarPantallaNotarias();
    return false;
}

/* Marcada en pantalla, sin confirmar (puede mirar varias antes). */
let _notariaMarcada = null;

/* Selección de oficina: con dos o más, y siempre para el admin. */
function mostrarPantallaNotarias() {
    const pantalla = document.getElementById('pt-elegir');
    const lista = document.getElementById('pt-elegir-lista');
    if (!pantalla || !lista) return;

    // Arranca en la abierta o en la primera
    _notariaMarcada = (_notariaActiva !== null)
        ? String(_notariaActiva)
        : (ES_ADMIN && _notariasDisponibles.length > 1 ? 'todas'
           : (_notariasDisponibles[0] ? String(_notariasDisponibles[0].id) : null));

    const vacio = !_notariasDisponibles.length;

    lista.innerHTML = vacio
        ? '<p class="pt-elegir__vacio">Aún no hay ninguna oficina. ' +
          'Crea la primera abajo, en «Administrar oficinas».</p>'
        : _notariasDisponibles.map(n => tarjetaNotaria(n)).join('') +
          // El admin puede ver todo junto
          (ES_ADMIN && _notariasDisponibles.length > 1 ? tarjetaTodasLasNotarias() : '');

    /* Sin oficinas cambia el texto (no tiene sentido "elige una"). */
    const titulo = document.getElementById('elegir-titulo');
    const texto = document.getElementById('elegir-texto');
    const eti = document.getElementById('elegir-eti');
    if (titulo) titulo.textContent = vacio
        ? 'Todavía no hay ninguna notaría'
        : '¿En qué notaría vas a trabajar?';
    if (texto) texto.textContent = vacio
        ? 'El portal necesita al menos una oficina antes de poder crear carpetas. ' +
          'Créala aquí y entra a ella.'
        : 'Cada notaría tiene sus propias carpetas y trámites. Puedes cambiar de una ' +
          'a otra en cualquier momento, sin cerrar sesión.';
    if (eti) eti.textContent = vacio ? 'Sin oficinas' : 'Elige una oficina';

    // Sin oficinas no hay botón de entrar
    const entrar = document.getElementById('boton-entrar-notaria');
    if (entrar) entrar.hidden = vacio;

    // Quién está conectado
    const avatar = document.getElementById('elegir-avatar');
    if (avatar) avatar.textContent = inicialesDe(sesion.nombre || sesion.usuario);
    const nom = document.getElementById('elegir-nombre');
    if (nom) nom.textContent = sesion.nombre || sesion.usuario;
    const rol = document.getElementById('elegir-rol');
    if (rol) rol.textContent = (ETIQUETAS_ROL[sesion.rol] || sesion.rol).toUpperCase();

    const estado = document.getElementById('elegir-estado');
    if (estado) {
        const activas = _notariasDisponibles.length;
        estado.innerHTML = '<i></i>' + activas +
            (activas === 1 ? ' oficina activa' : ' oficinas activas');
    }

    pantalla.hidden = false;
    document.querySelector('.pt-marco').hidden = true;

    // "Volver al portal" solo si ya había una abierta
    const volver = document.getElementById('boton-volver-portal');
    if (volver) volver.hidden = !_arranqueHecho;

    // Doble clic entra directo
    lista.ondblclick = (e) => {
        const b = e.target.closest('.pt-oficina');
        if (b && b.dataset.notaria) elegirNotaria(b.dataset.notaria);
    };

    pintarSeleccionNotaria();
    pintarGestionNotarias();
    cargarTableroNotarias();
}

/* ---- Cifras de cada oficina ----
   tablero_notarias(): lo que vence y, para el admin, el espacio. Llegan
   después de pintar; sin la función, la pantalla sigue igual. */
let _tableroNotarias = null;    // { [notariaId|'sin']: cifras } o null
let _discoNotarias = null;      // disco, solo admin

const claveTablero = (id) => (id === null || id === undefined) ? 'sin' : String(id);

async function cargarTableroNotarias() {
    const pedirTablero = (typeof tableroNotarias === 'function')
        ? tableroNotarias().catch(() => null) : Promise.resolve(null);
    const pedirDisco = (ES_ADMIN && typeof almacenamientoLeer === 'function')
        ? almacenamientoLeer().catch(() => null) : Promise.resolve(null);
    const [filas, disco] = await Promise.all([pedirTablero, pedirDisco]);

    _tableroNotarias = null;
    if (Array.isArray(filas)) {
        _tableroNotarias = {};
        for (const f of filas) _tableroNotarias[claveTablero(f.notariaId)] = f;
    }
    _discoNotarias = disco;

    // Repinta solo si la pantalla sigue abierta
    const pantalla = document.getElementById('pt-elegir');
    if (!pantalla || pantalla.hidden) return;
    const lista = document.getElementById('pt-elegir-lista');
    if (lista && _notariasDisponibles.length) {
        lista.innerHTML = _notariasDisponibles.map(n => tarjetaNotaria(n)).join('') +
            (ES_ADMIN && _notariasDisponibles.length > 1 ? tarjetaTodasLasNotarias() : '');
        pintarSeleccionNotaria();
    }
    pintarEspacioNotarias();
    pintarFilasGestion();
}

/* Cifras de una oficina. null se pinta "—" (aún no se sabe). */
function cifrasDeNotaria(id) {
    const t = _tableroNotarias && _tableroNotarias[claveTablero(id)];
    if (t) return t;
    const n = _notariasDisponibles.find(x => String(x.id) === String(id));
    return {
        carpetas: n ? n.carpetas : 0, porVencer: null, vencidos: null,
        carpetasTotal: null, documentos: null, pesoBytes: null
    };
}

/* Bytes de documentos de todas las oficinas */
function pesoTotalNotarias() {
    if (!_tableroNotarias) return 0;
    return Object.values(_tableroNotarias).reduce((s, t) => s + (t.pesoBytes || 0), 0);
}

function plural(n, uno, varios) { return n === 1 ? uno : varios; }
/* "1 día hábil", "3 días hábiles" */
function cuantos(n, uno, varios) { return n + ' ' + plural(n, uno, varios); }

/* Espacio de una oficina: peso, documentos y % del total. */
function lineaEspacioNotaria(t) {
    if (!ES_ADMIN || t.pesoBytes === null || t.pesoBytes === undefined) return '';
    const total = pesoTotalNotarias();
    const pct = total ? (t.pesoBytes / total) * 100 : 0;
    return '<span class="pt-oficina__espacio">' +
        '<span class="pt-oficina__espacio-txt"><b>' + formatoEspacio(t.pesoBytes) + '</b> en ' +
            t.documentos + ' ' + plural(t.documentos, 'documento', 'documentos') + '</span>' +
        '<span class="pt-oficina__barra" title="' + pct.toFixed(1) + ' % de los documentos del portal">' +
            '<i style="width:' + Math.max(pct ? 2 : 0, Math.round(pct)) + '%"></i></span>' +
    '</span>';
}

/* Tarjeta de oficina */
function tarjetaNotaria(n) {
    const t = cifrasDeNotaria(n.id);
    const cifra = (valor, eti, clase) =>
        '<span class="pt-oficina__cifra' + (clase && valor ? ' ' + clase : '') + '">' +
            '<b>' + (valor === null || valor === undefined ? '—' : valor) + '</b><small>' + eti + '</small></span>';
    return '<button class="pt-oficina" data-accion="marcar-notaria" data-notaria="' + n.id + '">' +
        '<span class="pt-oficina__cab">' +
            '<span class="pt-oficina__ciudad">' + escaparHtml(n.ciudad) + '</span>' +
            '<span class="pt-oficina__tic" aria-hidden="true"></span>' +
        '</span>' +
        '<span class="pt-oficina__nombre">' + escaparHtml(n.nombre) + '</span>' +
        '<span class="pt-oficina__cifras">' +
            cifra(t.carpetas, plural(t.carpetas, 'carpeta activa', 'carpetas activas')) +
            cifra(t.porVencer, 'por vencer', 'pt-oficina__cifra--alerta') +
            cifra(t.vencidos, plural(t.vencidos, 'vencido', 'vencidos'), 'pt-oficina__cifra--rojo') +
        '</span>' +
        lineaEspacioNotaria(t) +
    '</button>';
}

function tarjetaTodasLasNotarias() {
    const carpetas = _notariasDisponibles.reduce((t, n) => t + cifrasDeNotaria(n.id).carpetas, 0);
    const suma = (k) => _notariasDisponibles.reduce((s, n) => s + (cifrasDeNotaria(n.id)[k] || 0), 0);
    const apremia = _tableroNotarias
        ? '<br>' + suma('porVencer') + ' por vencer · ' + suma('vencidos') + ' ' +
          plural(suma('vencidos'), 'vencido', 'vencidos')
        : '';
    return '<button class="pt-oficina pt-oficina--todas" data-accion="marcar-notaria" data-notaria="todas">' +
        '<span class="pt-oficina__cab">' +
            '<span class="pt-oficina__ciudad">Todas las notarías</span>' +
            '<span class="pt-oficina__tic" aria-hidden="true"></span>' +
        '</span>' +
        '<span class="pt-oficina__nombre">Panorama general, solo lectura</span>' +
        '<span class="pt-oficina__cifras pt-oficina__cifras--texto">' +
            carpetas + ' ' + plural(carpetas, 'carpeta activa', 'carpetas activas') + ' en ' +
            _notariasDisponibles.length + ' oficinas' + apremia +
        '</span>' +
    '</button>';
}

/* Espacio de almacenamiento en corto (lo mismo que Almacenamiento). */
function pintarEspacioNotarias() {
    const caja = document.getElementById('pt-elegir-espacio');
    if (!caja) return;
    // Sin oficinas no hay reparto
    if (!ES_ADMIN || !_notariasFormulario.length || (!_discoNotarias && !_tableroNotarias)) {
        caja.hidden = true;
        return;
    }

    const docs = _tableroNotarias ? pesoTotalNotarias() : (_discoNotarias ? _discoNotarias.docsBytes : 0);
    const d = _discoNotarias;
    let cuerpo;
    if (d && d.totalBytes) {
        const pct = (b) => Math.max(0, Math.min(100, (b / d.totalBytes) * 100));
        const otros = Math.max(0, d.usadoBytes - docs);
        const usado = Math.round((d.usadoBytes / d.totalBytes) * 100);
        const estado = usado >= 92 ? ' pt-disco--alerta' : (usado >= 80 ? ' pt-disco--aviso' : '');
        cuerpo =
            '<div class="pt-elegir__disco' + estado + '">' +
                '<div class="pt-disco__barra">' +
                    '<i class="pt-disco__docs" style="width:' + pct(docs) + '%" title="Documentos de las notarías"></i>' +
                    '<i class="pt-disco__otros" style="width:' + pct(otros) + '%" title="Adjuntos de chat y soporte"></i>' +
                '</div>' +
                '<div class="pt-elegir__disco-datos">' +
                    '<span><i class="pt-elegir__punto pt-elegir__punto--docs"></i>Documentos <b>' + formatoEspacio(docs) + '</b></span>' +
                    '<span><i class="pt-elegir__punto pt-elegir__punto--otros"></i>Adjuntos <b>' + formatoEspacio(otros) + '</b></span>' +
                    '<span><i class="pt-elegir__punto"></i>Libre <b>' + formatoEspacio(d.libreBytes) + '</b></span>' +
                '</div>' +
            '</div>';
    } else {
        // Sin medición del disco: al menos lo de los documentos
        cuerpo = '<p class="pt-elegir__disco-nota">Los documentos de todas las oficinas ocupan <b>' +
            formatoEspacio(docs) + '</b>. Todavía no hay medición del espacio.</p>';
    }

    caja.innerHTML =
        '<div class="pt-elegir__admin-cab">' +
            '<span class="pt-elegir__eti">Espacio de almacenamiento</span>' +
            (d ? '<span class="pt-elegir__edad" title="Medido el ' + escaparHtml(formatoFecha(d.medido)) + '">' +
                (d.totalBytes ? Math.round((d.usadoBytes / d.totalBytes) * 100) + ' % ocupado · ' : '') +
                escaparHtml(hace(d.medido)) + '</span>' : '') +
        '</div>' + cuerpo;
    caja.hidden = false;
}

/* Marca una oficina sin entrar todavía */
function marcarNotaria(valor) {
    _notariaMarcada = String(valor);
    pintarSeleccionNotaria();
}

/* Refleja la marca en las tarjetas y en el botón de entrar */
function pintarSeleccionNotaria() {
    document.querySelectorAll('#pt-elegir-lista .pt-oficina').forEach(b =>
        b.classList.toggle('activa', b.dataset.notaria === _notariaMarcada));

    const boton = document.getElementById('boton-entrar-notaria');
    if (!boton) return;
    if (!_notariaMarcada) {
        boton.disabled = true;
        boton.textContent = 'Entrar';
        return;
    }
    boton.disabled = false;
    const n = _notariasDisponibles.find(x => String(x.id) === _notariaMarcada);
    boton.textContent = n ? 'Entrar a ' + n.ciudad : 'Ver todas las notarías';
}

/* Confirma la oficina marcada */
async function entrarNotariaMarcada() {
    if (!_notariaMarcada) return;
    await elegirNotaria(_notariaMarcada);
}

function guardarNotariaActiva() {
    try {
        localStorage.setItem(NOTARIA_ACTIVA,
            _notariaActiva === null ? 'todas' : String(_notariaActiva));
    } catch (e) {}
}

/* Arranca lo pendiente después de elegir oficina */
async function completarArranque() {
    if (_arranqueHecho) return;
    _arranqueHecho = true;
    await mostrarVistaCarpetas();
    mostrarRecordatoriosVigentes();
    iniciarSoporte();
    iniciarCampana();
    verificarConsentimiento();
    avisarCierresPendientes();
    registrarConexion();
    presenciaIniciar((enLinea) => {
        _usuariosEnLinea = enLinea || new Set();
        pintarEstadoConexion();
    });
    iniciarAvisosPush();
}

/* Elegir notaría (selección o selector) */
async function elegirNotaria(valor) {
    _notariaActiva = (valor === 'todas') ? null : Number(valor);
    guardarNotariaActiva();

    const pantalla = document.getElementById('pt-elegir');
    if (pantalla) pantalla.hidden = true;
    const marco = document.querySelector('.pt-marco');
    if (marco) marco.hidden = false;

    pintarNotariaActiva();
    // Cambia todo: la caché anterior no sirve
    cacheOlvidar();
    if (!_arranqueHecho) { await completarArranque(); return; }
    // La campana también cambia de oficina
    refrescarCampana().catch(() => {});
    await mostrarVistaCarpetas();
}

/* Cuentas de la oficina abierta (sobre lo que se ve). */
function resumenUsuariosDeNotaria() {
    const enOficina = _usuariosCache.filter(u => usuarioEnNotaria(u, _notariaActiva));
    const activas = enOficina.filter(u => u.activo !== false).length;
    const n = notariaActual();
    return activas + (activas === 1 ? ' cuenta activa' : ' cuentas activas') +
           ' de ' + enOficina.length + (n ? ' en ' + n.ciudad : '');
}

/* Volver a la selección sin cerrar sesión */
function cambiarNotaria() {
    // El admin entra siempre (ahí crea las demás)
    if (!ES_ADMIN && _notariasDisponibles.length < 2) return;
    mostrarPantallaNotarias();
}

/* Ciudad junto al nombre del portal y en el título. Botón con varias, etiqueta con una. */
function pintarNotariaActiva() {
    const caja = document.getElementById('pt-notaria');
    if (!caja) return;

    if (!_notariasDisponibles.length) { caja.hidden = true; return; }

    const n = notariaActual();
    const ciudad = n ? n.ciudad : 'Todas las notarías';
    const detalle = n ? n.nombre : 'Panorama general';
    // El admin siempre puede volver a la pantalla de oficinas
    const puedeCambiar = ES_ADMIN || _notariasDisponibles.length > 1;

    caja.innerHTML = puedeCambiar
        ? '<button class="pt-notaria__boton" data-accion="cambiar-notaria" ' +
              'title="Cambiar de notaría">' +
              '<span class="pt-notaria__ciudad">' + escaparHtml(ciudad) + '</span>' +
              '<span class="pt-notaria__nombre">' + escaparHtml(detalle) + '</span>' +
          '</button>'
        : '<div class="pt-notaria__fijo">' +
              '<span class="pt-notaria__ciudad">' + escaparHtml(ciudad) + '</span>' +
              '<span class="pt-notaria__nombre">' + escaparHtml(detalle) + '</span>' +
          '</div>';
    caja.hidden = false;

    document.title = 'Portal Documental' + (n ? ' ' + n.ciudad : '') + ' | Carpetas';
}

/* ---- Casillas de notaría en el formulario ----
   Operador varias; los demás una (como opción). El admin ninguna. */
let _notariasFormulario = [];   // catálogo completo (admin)

async function cargarCatalogoNotarias() {
    try { _notariasFormulario = await notariasListar(); }
    catch (e) { _notariasFormulario = []; }
}

function notariasMarcadasEnFormulario() {
    return [...document.querySelectorAll('#nuevas-notarias input:checked')]
        .map(x => Number(x.value));
}

/* Casillas según el rol, con las ya marcadas */
function pintarNotariasDeFormulario(marcadas) {
    const caja = document.getElementById('nuevas-notarias');
    const campo = document.getElementById('campo-nuevas-notarias');
    const etiqueta = document.getElementById('etiqueta-nuevas-notarias');
    if (!caja || !campo) return;

    const rol = (document.getElementById('nuevo-rol') || {}).value || 'cliente';
    const activas = _notariasFormulario.filter(n => n.activa);

    // Sin notarías o siendo admin, nada que elegir
    if (!activas.length || rol === 'administrador') {
        campo.hidden = true;
        caja.innerHTML = '';
        return;
    }
    campo.hidden = false;

    const varias = rol === 'operador';
    etiqueta.textContent = varias
        ? 'Notarías donde puede trabajar (puede marcar varias)'
        : 'Notaría';

    const yaMarcadas = (marcadas || []).map(String);
    caja.innerHTML = activas.map(n =>
        '<label class="pt-notaria-casilla">' +
            '<input type="' + (varias ? 'checkbox' : 'radio') + '" ' +
                   'name="notaria-usuario" value="' + n.id + '"' +
                   (yaMarcadas.includes(String(n.id)) ? ' checked' : '') + '>' +
            '<span><b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) + '</span>' +
        '</label>').join('');
}

/* ---- Gestión de oficinas (en la pantalla de selección) ---- */
async function pintarGestionNotarias() {
    const caja = document.getElementById('pt-elegir-admin');
    const lista = document.getElementById('pt-elegir-admin-lista');
    if (!caja || !lista) return;
    if (!ES_ADMIN) { caja.hidden = true; return; }

    await cargarCatalogoNotarias();
    caja.hidden = false;
    pintarFilasGestion();
    // Tablero y catálogo llegan por separado: el último pinta
    pintarEspacioNotarias();
}

/* Filas por oficina con su espacio (se repintan cuando llega el tablero). */
function pintarFilasGestion() {
    const lista = document.getElementById('pt-elegir-admin-lista');
    if (!lista || !ES_ADMIN) return;

    if (!_notariasFormulario.length) {
        lista.innerHTML = '<p class="pt-elegir__admin-vacio">Todavía no hay oficinas. ' +
            'Crea la primera para empezar a repartir las carpetas.</p>';
        return;
    }

    const total = pesoTotalNotarias();
    const uso = (id) => {
        const t = _tableroNotarias && _tableroNotarias[claveTablero(id)];
        if (!t || t.pesoBytes === null || t.pesoBytes === undefined) return '';
        const pct = total ? (t.pesoBytes / total) * 100 : 0;
        return '<span class="pt-elegir__admin-uso">' +
            '<span class="pt-elegir__admin-cifras">' + t.carpetasTotal + ' ' +
                plural(t.carpetasTotal, 'carpeta', 'carpetas') + ' · ' + t.documentos + ' ' +
                plural(t.documentos, 'documento', 'documentos') + '</span>' +
            '<span class="pt-elegir__admin-peso"><b>' + formatoEspacio(t.pesoBytes) + '</b>' +
                '<span class="pt-reparto" title="' + pct.toFixed(1) + ' % de los documentos del portal">' +
                    '<i style="width:' + Math.round(pct) + '%"></i></span></span>' +
        '</span>';
    };

    // Carpetas sin oficina (anteriores a notarías): ocupan espacio igual.
    const sinOficina = _tableroNotarias && _tableroNotarias.sin && _tableroNotarias.sin.carpetasTotal
        ? '<div class="pt-elegir__admin-fila">' +
              '<span class="pt-elegir__admin-txt"><b>Sin oficina</b> · carpetas de antes de las notarías</span>' +
              uso(null) +
          '</div>'
        : '';

    lista.innerHTML = _notariasFormulario.map(n =>
        '<div class="pt-elegir__admin-fila' + (n.activa ? '' : ' apagada') + '">' +
            '<span class="pt-elegir__admin-txt">' +
                '<b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) +
                (n.activa ? '' : ' <em>desactivada</em>') +
            '</span>' +
            uso(n.id) +
            '<span class="pt-elegir__admin-acc">' +
                '<button data-accion="editar-notaria" data-id="' + n.id + '">Editar</button>' +
                '<button data-accion="alternar-notaria" data-id="' + n.id + '" ' +
                        'title="' + (n.activa ? 'Desactivar' : 'Activar') + '">' +
                    (n.activa ? 'Desactivar' : 'Activar') + '</button>' +
            '</span>' +
        '</div>').join('') + sinOficina;
}

/* Volver al portal sin cambiar de oficina (solo si ya había una). */
function volverAlPortal() {
    if (_notariaActiva === null && !ES_ADMIN) return;
    const pantalla = document.getElementById('pt-elegir');
    const marco = document.querySelector('.pt-marco');
    if (pantalla) pantalla.hidden = true;
    if (marco) marco.hidden = false;
}

/* ---- Alta y edición de notarías ----
   Un formulario: ciudad, nombre y activa. */
let _notariaEditando = null;

function abrirModalNotaria(notaria) {
    if (!ES_ADMIN) return;
    _notariaEditando = notaria || null;
    document.getElementById('modal-notaria-titulo').textContent =
        notaria ? 'Editar notaría' : 'Nueva notaría';
    document.getElementById('notaria-ciudad').value = notaria ? notaria.ciudad : '';
    document.getElementById('notaria-nombre').value = notaria ? notaria.nombre : '';
    document.getElementById('notaria-activa').checked = notaria ? notaria.activa !== false : true;

    // Avisar qué implica desactivar una oficina con carpetas
    const aviso = document.getElementById('notaria-aviso');
    if (aviso) {
        const abierta = notaria && String(_notariaActiva) === String(notaria.id);
        aviso.hidden = !abierta;
        aviso.textContent = abierta
            ? 'Esta es la oficina que tienes abierta. Si la desactivas tendrás que elegir otra.'
            : '';
    }
    document.getElementById('modal-notaria').hidden = false;
    document.getElementById('notaria-ciudad').focus();
}

function cerrarModalNotaria() {
    document.getElementById('modal-notaria').hidden = true;
    _notariaEditando = null;
}

async function guardarNotaria(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;
    const ciudad = document.getElementById('notaria-ciudad').value.trim();
    const nombre = document.getElementById('notaria-nombre').value.trim();
    const activa = document.getElementById('notaria-activa').checked;
    if (!ciudad || !nombre) {
        avisar('La notaría necesita ciudad y nombre.', 'error');
        return;
    }
    try {
        if (_notariaEditando) {
            await notariaEditar(_notariaEditando.id, nombre, ciudad, activa);
            registrarActividad('editar-notaria', ciudad + ' · ' + nombre);
        } else {
            const id = await notariaCrear(nombre, ciudad);
            registrarActividad('crear-notaria', ciudad + ' · ' + nombre);
            if (!activa) await notariaEditar(id, null, null, false);
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la notaría.', 'error');
        return;
    }
    cerrarModalNotaria();

    // Si se desactivó la abierta, se suelta
    const era = _notariaEditando;
    _notariasDisponibles = await misNotarias();
    if (era && !activa && String(_notariaActiva) === String(era.id)) {
        _notariaActiva = null;
        guardarNotariaActiva();
    }
    pintarNotariaActiva();
    mostrarPantallaNotarias();
    avisar('Notaría «' + ciudad + ' · ' + nombre + '» guardada.');
}

function nuevaNotariaAccion() { abrirModalNotaria(null); }

function editarNotariaAccion(id) {
    const n = _notariasFormulario.find(x => String(x.id) === String(id));
    if (n) abrirModalNotaria(n);
}

/* Desactivar en vez de borrar: con expedientes no se elimina. */
async function alternarNotariaAccion(id) {
    if (!ES_ADMIN) return;
    const n = _notariasFormulario.find(x => String(x.id) === String(id));
    if (!n) return;
    if (n.activa && !await confirmarPortal(
        'Al desactivar «' + n.ciudad + ' · ' + n.nombre + '» deja de aparecer al entrar. ' +
        'Sus carpetas no se borran, pero nadie podrá abrirlas hasta reactivarla. ¿Continuar?',
        'Desactivar notaría')) return;
    try {
        await notariaEditar(n.id, null, null, !n.activa);
        _notariasDisponibles = await misNotarias();
        // Si se apagó la abierta, se suelta
        if (n.activa && String(_notariaActiva) === String(n.id)) {
            _notariaActiva = null;
            guardarNotariaActiva();
        }
        pintarNotariaActiva();
        mostrarPantallaNotarias();
        avisar(n.activa ? 'Notaría desactivada.' : 'Notaría activada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo cambiar la notaría.', 'error');
    }
}

/* ============ NAVEGACIÓN ENTRE VISTAS ============ */
function mostrarVista(idVista) {
    // En móvil la barra se cierra al cambiar de sección
    alternarLateral(false);
    alternarCajonUsuario(false);
    for (const id of ['vista-carpetas', 'vista-carpeta', 'vista-estados', 'vista-calendario', 'vista-usuarios', 'vista-notificaciones', 'vista-almacenamiento', 'vista-rendimiento']) {
        const el = document.getElementById(id);
        if (el) el.hidden = (id !== idVista);
    }
    // Detalle de carpeta: contenedor más ancho
    const contenido = document.querySelector('.pt-contenido');
    if (contenido) contenido.classList.toggle('pt-contenido--ancha', idVista === 'vista-carpeta');
    document.getElementById('pestana-carpetas').classList.toggle('activa', idVista === 'vista-carpetas' || idVista === 'vista-carpeta');
    document.getElementById('pestana-estados').classList.toggle('activa', idVista === 'vista-estados');
    document.getElementById('pestana-calendario').classList.toggle('activa', idVista === 'vista-calendario');
    document.getElementById('pestana-usuarios').classList.toggle('activa', idVista === 'vista-usuarios');
    document.getElementById('pestana-notificaciones').classList.toggle('activa', idVista === 'vista-notificaciones');
    document.getElementById('pestana-almacenamiento').classList.toggle('activa', idVista === 'vista-almacenamiento');
    const pestanaRendimiento = document.getElementById('pestana-rendimiento');
    if (pestanaRendimiento) pestanaRendimiento.classList.toggle('activa', idVista === 'vista-rendimiento');
    // Refresco del disco solo con la sección abierta
    if (idVista !== 'vista-almacenamiento') detenerRefrescoAlmacenamiento();
    // Refresco de Estados solo con la vista abierta
    if (idVista !== 'vista-estados') detenerAutoRefrescoEstados();
    // El chat flotante de la carpeta solo existe dentro de la carpeta
    if (idVista !== 'vista-carpeta') {
        const seccionChat = document.getElementById('pt-chats');
        const burbujaChat = document.getElementById('chat-carpeta-burbuja');
        if (seccionChat) seccionChat.hidden = true;
        if (burbujaChat) burbujaChat.hidden = true;
    }
}

/* ============ VISTA: LISTA DE CARPETAS ============ */
async function mostrarVistaCarpetas() {
    mostrarVista('vista-carpetas');
    carpetaAbierta = null;

    // Primero con lo guardado
    const cTodas = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cTodas && cProc);
    if (hayCopia) aplicarCarpetas(cTodas, cProc, cacheLeer('usuarios'));
    else {
        const pan = document.getElementById('panorama-carpetas');
        pan.innerHTML = esqueletoPanorama(4);
        pan.hidden = false;
        document.getElementById('lista-carpetas').innerHTML = esqueletoCarpetas(6);
    }

    // Número de documentos y peso vienen en cada carpeta (los mantiene un trigger).
    const [rTodas, rProc, rUsu] = await Promise.all([
        cacheRefrescar('carpetas', () => dbTodos('carpetas')),
        cacheRefrescar('procesos', () => procesosTodos().catch(() => [])),
        ES_SUPERVISION
            ? cacheRefrescar('usuarios', () => dbTodos('usuarios'))
            : Promise.resolve({ valor: null, cambio: false })
    ]);
    if (!hayCopia || rTodas.cambio || rProc.cambio || rUsu.cambio) {
        aplicarCarpetas(rTodas.valor, rProc.valor, rUsu.valor);
    }
}

/* Pinta carpetas: una vez con la caché y otra con el servidor. */
function aplicarCarpetas(todas, procesos, usuarios) {
    if (usuarios) {
        nombrePorUsuario = {};
        for (const u of usuarios) nombrePorUsuario[u.usuario] = u.nombre;
    }
    // Permiso (de la base) y notaría abierta (vista)
    const visibles = filtrarPorNotaria(todas.filter(puedeVerCarpeta));
    visibles.sort((a, b) => b.fecha - a.fecha);

    _conteoArchivos = {};
    for (const c of visibles) _conteoArchivos[c.id] = c.totalArchivos || 0;
    _procesosPorCarpeta = {};
    for (const p of procesos) (_procesosPorCarpeta[p.carpetaId] = _procesosPorCarpeta[p.carpetaId] || []).push(p);
    _carpetasVisibles = visibles;

    pintarLateral(visibles, procesos);
    pintarCarpetasSegunFiltro();
}

/* Esqueletos con la forma de lo que viene: mismas clases, mismo tamaño. */
const _esq = (ancho, extra) => '<span class="pt-esq pt-esq--linea' + (extra ? ' ' + extra : '') + '" style="width:' + ancho + '"></span>';
const _anchos = ['72%', '55%', '84%', '63%', '48%', '77%'];

function esqueletoCarpetas(n) {
    let s = '<div class="pt-rejilla-carpetas" aria-busy="true" aria-label="Cargando carpetas">';
    for (let i = 0; i < n; i++) {
        s += '<article class="pt-tarjeta-carpeta pt-tarjeta-carpeta--esq" aria-hidden="true">' +
            '<div class="pt-tarjeta-carpeta__cab"><span class="pt-esq" style="width:32px;height:32px;border-radius:12px"></span></div>' +
            '<h3 class="pt-tarjeta-carpeta__nombre">' + _esq(_anchos[i % 6], 'pt-esq--titulo') + '</h3>' +
            '<div class="pt-tarjeta-carpeta__proceso">' + _esq('60%') + '</div>' +
            '<div class="pt-tarjeta-carpeta__plazo">' + _esq('45%') + '</div>' +
            '<div class="pt-tarjeta-carpeta__pie">' + _esq('5rem') +
                '<span class="pt-esq" style="width:6.4rem;height:2.8rem;border-radius:999px"></span></div>' +
        '</article>';
    }
    return s + '</div>';
}

// Cajas de cifras (.pt-panorama)
function esqueletoPanorama(n) {
    let s = '';
    for (let i = 0; i < n; i++) {
        s += '<div class="pt-panorama__caja" aria-hidden="true">' +
            '<div class="pt-panorama__tit">' + _esq('55%') + '</div>' +
            '<div class="pt-panorama__num"><span class="pt-esq pt-esq--cifra"></span></div>' +
            '<div class="pt-panorama__pie">' + _esq(_anchos[i % 6]) + '</div></div>';
    }
    return s;
}

// Filas de tabla para un <tbody>
function esqueletoFilasTabla(columnas, n) {
    let s = '';
    for (let i = 0; i < n; i++) {
        s += '<tr class="pt-fila-esq" aria-hidden="true">';
        for (let c = 0; c < columnas; c++) s += '<td>' + _esq(_anchos[(i + c) % 6]) + '</td>';
        s += '</tr>';
    }
    return s;
}

// Tabla completa, para contenedores que no son <tbody>
function esqueletoTabla(titulos, n) {
    return '<div class="pt-tabla-envoltura" aria-busy="true"><table class="pt-tabla"><thead><tr>' +
        titulos.map(t => '<th>' + escaparHtml(t) + '</th>').join('') +
        '</tr></thead><tbody>' + esqueletoFilasTabla(titulos.length, n) + '</tbody></table></div>';
}

// Lista de renglones (audiencias, actividad, personas...)
function esqueletoLista(n, conIcono) {
    let s = '<ul class="pt-lista-esq" aria-busy="true">';
    for (let i = 0; i < n; i++) {
        s += '<li aria-hidden="true">' + (conIcono === false ? '' : '<span class="pt-esq pt-esq--punto pt-esq--ic"></span>') +
            '<span class="pt-lista-esq__txt">' + _esq(_anchos[i % 6]) + _esq(_anchos[(i + 3) % 6], 'pt-esq--chica') + '</span></li>';
    }
    return s + '</ul>';
}

// Mes del calendario: 7 columnas, 5 semanas
function esqueletoCalendario() {
    let dias = '';
    for (let i = 0; i < 35; i++) dias += '<span class="pt-calv__dia pt-esq"></span>';
    return '<div class="pt-calv-tarjeta" aria-busy="true" aria-label="Cargando calendario">' +
        '<div class="pt-calv-tarjeta__cab">' + _esq('14rem', 'pt-esq--titulo') + _esq('9rem') + '</div>' +
        '<div class="pt-calv__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
        '<div class="pt-calv__rejilla" aria-hidden="true">' + dias + '</div></div>';
}

/* Giro en el botón mientras dura una acción corta (descargas, PDF, Excel). */
function conGiro(boton, promesa) {
    if (!boton) return promesa;
    boton.setAttribute('aria-busy', 'true');
    return Promise.resolve(promesa).finally(() => boton.removeAttribute('aria-busy'));
}

/* Contadores de la barra, con datos ya descargados. */
/* ============ ESPACIO DE ALMACENAMIENTO ============
   Tres estados: medición, sin medir, o no se pudo leer.
   almacenamiento_ver() suma Storage en el momento contra el cupo del plan. */
let _almacen = null;        // última lectura o null
let _almacenError = null;   // motivo del fallo

/* Desde el menú. La función del servidor no devuelve nada a quien no es admin. */
let _almacenTemporizador = null;

async function mostrarVistaAlmacenamiento() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-almacenamiento');
    await refrescarAlmacenamiento();
    // Cada minuto con la sección abierta (para que la antigüedad no envejezca)
    clearInterval(_almacenTemporizador);
    _almacenTemporizador = setInterval(refrescarAlmacenamiento, 60000);
}

/* Se para al salir de la sección. */
function detenerRefrescoAlmacenamiento() {
    clearInterval(_almacenTemporizador);
    _almacenTemporizador = null;
}

/* Pide la medición y repinta (Actualizar y temporizador). */
async function refrescarAlmacenamiento() {
    if (!ES_ADMIN || typeof almacenamientoLeer !== 'function') return;
    try {
        _almacen = await almacenamientoLeer();
        _almacenError = null;
    } catch (e) {
        _almacen = null;
        _almacenError = (e && e.message) || 'no se pudo leer';
    }
    pintarVistaAlmacenamiento();
}

/* bytes → "240 GB" */
function formatoEspacio(bytes) {
    const n = Number(bytes) || 0;
    const GB = 1073741824, MB = 1048576;
    if (n >= GB) return (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB';
    if (n >= MB) return (n / MB).toFixed(1) + ' MB';
    return Math.round(n / 1024) + ' KB';
}

/* "hace 2 min": si envejece, la tarea del servidor se paró. */
function hace(marca) {
    if (!marca) return '';
    const seg = Math.max(0, Math.round((Date.now() - marca) / 1000));
    if (seg < 90) return 'hace ' + seg + ' s';
    const min = Math.round(seg / 60);
    if (min < 90) return 'hace ' + min + ' min';
    const hor = Math.round(min / 60);
    if (hor < 36) return 'hace ' + hor + ' h';
    return 'hace ' + Math.round(hor / 24) + ' días';
}

/* Tarjeta del disco. */
function _tarjetaDisco() {
    const tit = '<div class="pt-disco__tit">Espacio de almacenamiento</div>';
    if (_almacenError) {
        return '<div class="pt-disco pt-disco--sin-dato">' + tit +
            '<p class="pt-disco__aviso">No se pudo leer la medición.</p>' +
            '<p class="pt-nota">' + escaparHtml(_almacenError) + '</p></div>';
    }
    if (!_almacen) {
        return '<div class="pt-disco pt-disco--sin-dato">' + tit +
            '<p class="pt-disco__aviso">Todavía no hay medición del espacio.</p>' +
            '<p class="pt-nota">La calcula la base con <code>almacenamiento_ver()</code>. ' +
            'Si esto no cambia, falta <code>migracion_almacenamiento_storage.sql</code>.</p></div>';
    }

    const d = _almacen;
    const pct = d.totalBytes > 0
        ? Math.min(100, Math.round((d.usadoBytes / d.totalBytes) * 100)) : 0;
    // Aviso al 80 % y alarma al 92 %: un disco lleno tumba Postgres
    const estado = pct >= 92 ? ' pt-disco--alerta' : (pct >= 80 ? ' pt-disco--aviso' : '');
    // Lo demás de Storage: adjuntos de chat y soporte
    const otros = Math.max(0, d.usadoBytes - d.docsBytes);
    const ancho = (b) => (d.totalBytes ? (b / d.totalBytes) * 100 : 0) + '%';

    const dato = (eti, val, pie) =>
        '<div class="pt-disco__dato"><span>' + eti + '</span><b>' + val + '</b>' +
        '<small>' + pie + '</small></div>';

    return '<div class="pt-disco' + estado + '">' +
        '<div class="pt-disco__cab">' + tit +
            '<span class="pt-disco__edad" title="Medido en Storage el ' +
                escaparHtml(formatoFecha(d.medido)) + '">' + escaparHtml(hace(d.medido)) + '</span>' +
        '</div>' +
        // Dos tramos: documentos y lo demás
        '<div class="pt-disco__barra">' +
            '<i class="pt-disco__docs"  style="width:' + ancho(d.docsBytes) + '" title="Documentos del portal"></i>' +
            '<i class="pt-disco__otros" style="width:' + ancho(otros) + '" title="Adjuntos de chat y soporte"></i>' +
        '</div>' +
        '<div class="pt-disco__datos">' +
            dato('Ocupado', formatoEspacio(d.usadoBytes), pct + '% de ' + formatoEspacio(d.totalBytes)) +
            dato('Documentos del portal', formatoEspacio(d.docsBytes), 'lo que suman los expedientes') +
            dato('Adjuntos', formatoEspacio(otros), 'archivos de chat y soporte') +
            dato('Libre', formatoEspacio(d.libreBytes), 'queda en el cupo del plan') +
        '</div>' +
    '</div>';
}

/* Sección completa: disco, resumen de la oficina y reparto por expediente. */
function pintarVistaAlmacenamiento() {
    const zonaDisco = document.getElementById('almacen-disco');
    if (!zonaDisco || !ES_ADMIN) return;
    zonaDisco.innerHTML = _tarjetaDisco();

    // _carpetasVisibles: lo mismo que se ve en Carpetas
    const carpetas = _carpetasVisibles || [];
    const oficina = notariaActual();
    const donde = oficina
        ? escaparHtml((oficina.ciudad ? oficina.ciudad + ' · ' : '') + oficina.nombre)
        : 'todas las notarías';

    const bytesDe = (c) => Math.round((Number(c.pesoTotalMb) || 0) * 1048576);
    const total = carpetas.reduce((n, c) => n + bytesDe(c), 0);
    const docs = carpetas.reduce((n, c) => n + (Number(c.totalArchivos) || 0), 0);

    const caja1 = (t, n, pie) =>
        '<div class="pt-panorama__caja">' +
            '<div class="pt-panorama__tit">' + t + '</div>' +
            '<div class="pt-panorama__num">' + n + '</div>' +
            '<div class="pt-panorama__pie">' + pie + '</div>' +
        '</div>';

    const pano = document.getElementById('almacen-panorama');
    pano.hidden = false;
    pano.innerHTML =
        caja1('Ocupa esta oficina', formatoEspacio(total), donde) +
        caja1('Documentos', docs, 'en ' + carpetas.length +
              (carpetas.length === 1 ? ' expediente' : ' expedientes')) +
        caja1('Promedio por documento', docs ? formatoEspacio(total / docs) : '—',
              docs ? 'peso medio de un archivo' : 'todavía no hay documentos') +
        caja1('Del espacio contratado',
              (_almacen && _almacen.totalBytes)
                  ? ((total / _almacen.totalBytes) * 100).toFixed(1) + '%' : '—',
              _almacen ? 'de ' + formatoEspacio(_almacen.totalBytes) : 'sin medición');

    // Reparto de mayor a menor
    const zona = document.getElementById('almacen-carpetas');
    const ordenadas = carpetas.slice().sort((a, b) => bytesDe(b) - bytesDe(a));
    if (!ordenadas.length) {
        zona.innerHTML = '<div class="pt-vacio">No hay expedientes en esta oficina.</div>';
        return;
    }
    const mayor = bytesDe(ordenadas[0]) || 1;

    zona.innerHTML =
        '<div class="pt-tabla-envoltura"><table class="pt-tabla"><thead><tr>' +
            '<th>Expediente</th><th>Documentos</th><th>Tamaño</th><th>Reparto</th>' +
        '</tr></thead><tbody>' +
        ordenadas.map(c => {
            const b = bytesDe(c);
            return '<tr>' +
                '<td class="pt-col-archivo"><span class="pt-nombre-archivo" title="' +
                    escaparHtml(c.nombre) + '">' + escaparHtml(c.nombre) + '</span></td>' +
                '<td class="pt-col-tamano">' + (Number(c.totalArchivos) || 0) + '</td>' +
                '<td class="pt-col-tamano">' + formatoEspacio(b) + '</td>' +
                // Barra contra el expediente más grande, no contra el total
                '<td class="pt-col-reparto">' +
                    '<div class="pt-reparto"><i style="width:' +
                        Math.round((b / mayor) * 100) + '%"></i></div>' +
                    '<span class="pt-reparto__pct">' +
                        (total ? ((b / total) * 100).toFixed(1) : '0.0') + '%</span>' +
                '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>';
}

/* Contadores de la barra lateral. */
function pintarLateral(carpetas, procesos) {
    const activas = carpetas.filter(c => c.activa);
    const num = (id, valor) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = valor;
        el.hidden = !valor;
    };
    num('nav-num-carpetas', activas.length);

    // Estados: vencidos o que vencen hoy/mañana
    const porAtender = (procesos || []).filter(p =>
        !p.completado && !p.pausado && (p.semaforo === 'rojo' || p.semaforo === 'naranja')).length;
    num('nav-num-estados', porAtender);
}

/* Lista de carpetas. Solo el admin ve Activas / Desactivadas. */
function pintarCarpetasSegunFiltro() {
    const barra = document.getElementById('sub-pestanas-carpetas');
    const lista = document.getElementById('lista-carpetas');
    const vacio = document.getElementById('carpetas-vacio');

    const activas = _carpetasVisibles.filter(c => c.activa);
    const desactivadas = _carpetasVisibles.filter(c => !c.activa);

    if (ES_SUPERVISION) {
        barra.hidden = false;
        barra.innerHTML =
            '<button class="' + (_filtroCarpetas === 'activas' ? 'activa' : '') + '" data-accion="filtro-carpetas" data-filtro="activas">' +
                icono('carpeta', 17) + ' Activas (' + activas.length + ')</button>' +
            '<button class="' + (_filtroCarpetas === 'desactivadas' ? 'activa' : '') + '" data-accion="filtro-carpetas" data-filtro="desactivadas">' +
                icono('desactivar', 17) + ' Desactivadas (' + desactivadas.length + ')</button>';
    } else {
        barra.hidden = true;
    }

    let mostradas = ES_SUPERVISION
        ? (_filtroCarpetas === 'desactivadas' ? desactivadas : activas)
        : _carpetasVisibles;
    mostradas = filtrarPorBusqueda(mostradas, _busquedaCarpetas);

    pintarPanoramaCarpetas(mostradas);
    // Rejilla de tarjetas
    lista.innerHTML = mostradas.length
        ? '<div class="pt-rejilla-carpetas">' +
              mostradas.map(c => filaCarpeta(c, _conteoArchivos[c.id] || 0)).join('') +
          '</div>'
        : '';
    vacio.hidden = mostradas.length > 0;
    vacio.textContent = ES_SUPERVISION
        ? (_filtroCarpetas === 'desactivadas'
            ? 'No hay carpetas desactivadas.'
            : 'No hay carpetas activas. Crea una con el botón "+ Nueva carpeta".')
        : (ES_OPERADOR
            ? 'No tienes carpetas asignadas como operador. El administrador debe asignarte a un proceso.'
            : 'Todavía no tienes carpetas asignadas. Comunícate con ' + NOMBRE_ENTIDAD + '.');
}

/* Activas / desactivadas (admin). */
function cambiarFiltroCarpetas(filtro) {
    if (filtro !== 'activas' && filtro !== 'desactivadas') return;
    _filtroCarpetas = filtro;
    pintarCarpetasSegunFiltro();
}

/* Panorama: cuatro cifras con datos ya cargados. */
function pintarPanoramaCarpetas(mostradas) {
    const caja = document.getElementById('panorama-carpetas');
    if (!caja) return;
    if (!mostradas.length) { caja.hidden = true; return; }

    const sinProcesos = mostradas.filter(c => !(_procesosPorCarpeta[c.id] || []).length).length;
    const docs = mostradas.reduce((n, c) => n + (_conteoArchivos[c.id] || 0), 0);
    const mb = mostradas.reduce((n, c) => n + (Number(c.pesoTotalMb) || 0), 0);
    const personas = mostradas.reduce((n, c) => n + (c.asignados || []).length, 0);

    // Por vencer o vencidos
    let porVencer = 0, vencidos = 0, proxima = null;
    for (const c of mostradas) {
        for (const p of (_procesosPorCarpeta[c.id] || [])) {
            if (p.completado || p.pausado || c.pausado) continue;
            if (p.semaforo === 'rojo') { vencidos++; continue; }
            if (p.semaforo === 'naranja') porVencer++;
            // La fecha es fechaVencimiento en las dos capas (no fechaVencimientoHabil).
            // Los vencidos no cuentan como próximos.
            if (p.fechaVencimiento && (!proxima || p.fechaVencimiento < proxima)) {
                proxima = p.fechaVencimiento;
            }
        }
    }

    const caja1 = (tit, num, pie, clase) =>
        '<div class="pt-panorama__caja">' +
            '<div class="pt-panorama__tit">' + tit + '</div>' +
            '<div class="pt-panorama__num' + (clase ? ' ' + clase : '') + '">' + num + '</div>' +
            '<div class="pt-panorama__pie">' + pie + '</div>' +
        '</div>';

    caja.hidden = false;
    caja.innerHTML =
        caja1('Carpetas', mostradas.length,
              sinProcesos ? sinProcesos + ' sin procesos definidos' : 'todas con trámite definido') +
        caja1('Por vencer', porVencer + vencidos,
              (vencidos ? cuantos(vencidos, 'vencido', 'vencidos') + (proxima ? ' · ' : '') : '') +
              (proxima ? 'próximo: ' + escaparHtml(formatoFechaDia(proxima))
                       : (vencidos ? '' : 'sin vencimientos cercanos')),
              vencidos ? 'pt-panorama__num--alerta' : (porVencer ? 'pt-panorama__num--aviso' : '')) +
        caja1('Documentos', docs,
              ES_SUPERVISION ? mb.toFixed(1) + ' MB en total' : 'en tus carpetas') +
        caja1('Personas asignadas', personas, 'clientes y acreedores');
}

/* Una carpeta por fila. "Abrir" visible; el resto en el menú ⋯. */
/* Tarjeta de carpeta: toda abre el expediente. El menú ⋯ no pasa el clic. */
function filaCarpeta(c, totalArchivos) {
    const operadores = c.operadores || [];
    const asignados = c.asignados || [];

    let menu = '';
    if (ES_ADMIN) {
        menu =
            '<div class="pt-menu">' +
                '<button class="pt-menu__boton" data-accion="menu-carpeta" data-id="' + c.id + '" ' +
                        'aria-label="Más acciones" title="Más acciones">⋯</button>' +
                '<div class="pt-menu__lista" id="menu-carpeta-' + c.id + '" hidden>' +
                    '<button data-accion="editar-carpeta" data-id="' + c.id + '">Editar carpeta</button>' +
                    '<button data-accion="alternar-carpeta" data-id="' + c.id + '">' +
                        (c.activa ? 'Desactivar' : 'Activar') + '</button>' +
                    '<button class="pt-menu__peligro" data-accion="eliminar-carpeta" data-id="' + c.id + '">Eliminar</button>' +
                '</div>' +
            '</div>';
    }

    // Quiénes están, con nombre
    const personas = (ES_PERSONAL || ES_MONITOR) ? gentesDeCarpeta(c) : '';

    return '<article class="pt-tarjeta-carpeta' + (c.activa ? '' : ' pt-tarjeta-carpeta--inactiva') + '" ' +
                   'data-accion="abrir-carpeta" data-id="' + c.id + '" ' +
                   'tabindex="0" role="button">' +
        '<div class="pt-tarjeta-carpeta__cab">' +
            '<span class="pt-tarjeta-carpeta__ic">' + icono('carpeta', 18) + '</span>' +
            (c.activa ? '' : '<span class="pt-insignia pt-insignia--inactiva">Desactivada</span>') +
            menu +
        '</div>' +

        '<h3 class="pt-tarjeta-carpeta__nombre">' + escaparHtml(c.nombre) + '</h3>' +
        (tipoProcesoEtiqueta(c) || '') +

        '<div class="pt-tarjeta-carpeta__proceso">' +
            resumenSemaforoCarpeta(c, _procesosPorCarpeta[c.id] || []) +
        '</div>' +

        // Plazo: la fecha, no el conteo
        (plazoDeCarpeta(c) || '') +

        personas +

        '<div class="pt-tarjeta-carpeta__pie">' +
            '<span class="pt-tarjeta-carpeta__docs">' +
                '<b>' + totalArchivos + '</b> doc' + (totalArchivos === 1 ? '' : 's') +
                (ES_SUPERVISION ? ' · ' + (c.pesoTotalMb || 0).toFixed(2) + ' MB' : '') +
            '</span>' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" ' +
                    'data-accion="abrir-carpeta" data-id="' + c.id + '">Abrir</button>' +
        '</div>' +
    '</article>';
}

/* Régimen del trámite, si está */
const TIPOS_PROCESO = {
    natural_no_comerciante: 'Persona natural no comerciante',
    pequeno_comerciante:    'Pequeño comerciante'
};
function tipoProcesoEtiqueta(c) {
    if (!c.tipoProceso || !TIPOS_PROCESO[c.tipoProceso]) return '';
    return '<span class="pt-tarjeta-carpeta__tipo">' +
        escaparHtml(TIPOS_PROCESO[c.tipoProceso]) + '</span>';
}

/* Fecha en que se cumple el plazo. */
function plazoDeCarpeta(c) {
    if (c.finalizado) {
        return '<div class="pt-tarjeta-carpeta__plazo">' +
            puntoSemaforo('verde', 8) + ' Finalizado' +
            (c.fechaFinTramite ? ' el ' + escaparHtml(formatoFechaDia(c.fechaFinTramite)) : '') +
        '</div>';
    }
    if (!c.fechaInicioTramite || !c.fechaVencimientoTramite) {
        return '<div class="pt-tarjeta-carpeta__plazo pt-tarjeta-carpeta__plazo--sin">' +
            'Sin plazo iniciado' + '</div>';
    }
    if (c.pausado) {
        return '<div class="pt-tarjeta-carpeta__plazo">' +
            puntoSemaforo('pausado', 8) + ' En pausa · el reloj está detenido</div>';
    }
    const hoy = fechaISOLocalHabil();
    const vencido = c.fechaVencimientoTramite < hoy;
    const restantes = contarDiasHabiles(hoy, c.fechaVencimientoTramite);
    const color = vencido ? 'rojo' : (restantes !== null && restantes <= 5 ? 'naranja' : 'verde');
    return '<div class="pt-tarjeta-carpeta__plazo">' +
        puntoSemaforo(color, 8) +
        (vencido ? ' Venció el ' : ' Vence el ') +
        '<strong>' + escaparHtml(formatoFechaDia(c.fechaVencimientoTramite)) + '</strong>' +
        (c.tieneProrroga ? ' <span class="pt-tarjeta-carpeta__prorroga">con prórroga</span>' : '') +
    '</div>';
}

/* Quiénes trabajan el expediente y quiénes son parte, por nombre. */
function gentesDeCarpeta(c) {
    const ops = (c.operadores || []).map(o => nombreDe(o));
    const partes = (c.asignados || []).map(a => nombreDe(a));
    if (!ops.length && !partes.length) return '';

    const grupo = (etiqueta, gente) => {
        if (!gente.length) return '';
        return '<div class="pt-gente__grupo">' +
            '<span class="pt-gente__eti">' + etiqueta + '</span>' +
            '<span class="pt-gente__nombres">' +
                gente.map(n => '<span class="pt-gente__chip" title="' + escaparHtml(n) + '">' +
                    escaparHtml(n) + '</span>').join('') +
            '</span>' +
        '</div>';
    };

    return '<div class="pt-gente">' +
        grupo('Operador', ops) +
        grupo(partes.length === 1 ? 'Parte' : 'Partes', partes) +
    '</div>';
}

/* ============ SEMÁFORO ============ */
const NOMBRE_SEMAFORO = { verde: 'Al día', naranja: 'Por vencer', rojo: 'Vencido', pausado: 'Pausado' };

/* Punto de color del semáforo. */
function puntoSemaforo(color, tam) {
    return '<span class="pt-semaforo pt-semaforo--' + color + '" style="width:' + (tam || 12) + 'px;height:' + (tam || 12) + 'px;"></span>';
}

/* Proceso actual: el primero sin completar */
function procesoActualDe(procesos) {
    return (procesos || []).find(p => !p.completado) || null;
}

/* Color del servidor (listar_procesos). Carpeta pausada = pausado. */
function semaforoEfectivo(p, pausadoCarpeta) {
    if (pausadoCarpeta || p.pausado) return { color: 'pausado', diasRestantes: null };
    return { color: p.semaforo || 'verde', diasRestantes: (p.diasRestantes === undefined ? null : p.diasRestantes) };
}

/* Conteo del trámite (60/90 días hábiles). */
function resumenTramite(c) {
    if (c.finalizado) {
        return puntoSemaforo('verde', 10) + ' <strong>Trámite finalizado</strong>' +
            (c.fechaFinTramite ? ' el ' + escaparHtml(formatoFechaDia(c.fechaFinTramite)) : '') +
            resumenCierre(c);
    }
    if (!c.fechaInicioTramite) return null;
    const total = c.diasHabilesTramite || 60;
    if (c.pausado) {
        return puntoSemaforo('pausado', 10) + ' Trámite: en pausa · plazo de ' + total +
            ' días hábiles' + (c.tieneProrroga ? ' (con prórroga)' : '');
    }
    const restantes = c.fechaVencimientoTramite
        ? contarDiasHabiles(fechaISOLocalHabil(), c.fechaVencimientoTramite) : null;
    const vencido = c.fechaVencimientoTramite && c.fechaVencimientoTramite < fechaISOLocalHabil();
    return puntoSemaforo(vencido ? 'rojo' : (restantes !== null && restantes <= 5 ? 'naranja' : 'verde'), 10) +
        ' Trámite: ' + (vencido
            ? '<strong>plazo vencido</strong> el ' + escaparHtml(formatoVencimiento(c.fechaVencimientoTramite))
            : '<strong>' + restantes + '</strong> de ' + total + ' días hábiles restantes · vence el ' +
              escaparHtml(formatoVencimiento(c.fechaVencimientoTramite))) +
        (c.tieneProrroga ? ' · con prórroga' : '');
}

/* En cada ingreso: días que quedan para descargar trámites cerrados. */
async function avisarCierresPendientes() {
    if (typeof avisosFinTramite !== 'function') return;
    let avisos = [];
    try { avisos = await avisosFinTramite(); } catch (e) { return; }
    avisos.filter(a => a.activa).forEach((a, i) => {
        setTimeout(() => avisar(textoAvisoCierre(a.nombre, a.diasRestantes, a.fechaDesactivacion), 'aviso'),
                   1200 + i * 600);
    });
}

/* Aviso al abrir una carpeta con el trámite cerrado */
function mostrarModalCierre(c) {
    if (!c || !c.finalizado || !c.fechaDesactivacion) return;
    if (document.getElementById('modal-cierre-tramite')) return;
    const dias = diasParaCierre(c);
    const caja = document.createElement('div');
    caja.className = 'pt-modal';
    caja.id = 'modal-cierre-tramite';
    caja.innerHTML =
        '<div class="pt-modal__caja">' +
            '<h3>Trámite finalizado</h3>' +
            '<p>' + escaparHtml(textoAvisoCierre(c.nombre, dias, c.fechaDesactivacion)) + '</p>' +
            (c.activa
                ? '<p>La carpeta se desactivará el <strong>' +
                  escaparHtml(formatoFechaDia(c.fechaDesactivacion)) + '</strong>.</p>'
                : '<p>La carpeta ya fue <strong>desactivada</strong>.</p>') +
            '<div class="pt-modal__acciones">' +
                '<button class="pt-boton pt-boton--primario" data-accion="cerrar-modal-cierre">Entendido</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(caja);
    caja.querySelector('[data-accion="cerrar-modal-cierre"]')
        .addEventListener('click', () => caja.remove());
}

/* Días hábiles para descargar antes de que se desactive (o null). */
function diasParaCierre(c) {
    if (!c || !c.finalizado || !c.fechaDesactivacion) return null;
    return Math.max(contarDiasHabiles(fechaISOLocalHabil(), c.fechaDesactivacion), 0);
}

/* Cuenta regresiva y fecha en que deja de estar disponible. */
function resumenCierre(c) {
    const dias = diasParaCierre(c);
    if (dias === null) return '';
    const fecha = escaparHtml(formatoFechaDia(c.fechaDesactivacion));
    if (!c.activa) return ' · <strong>carpeta desactivada</strong> el ' + fecha;
    if (dias === 0) return ' · <strong>se desactiva hoy</strong> (' + fecha + ')';
    return ' · quedan <strong>' + dias + '</strong> día' + (dias === 1 ? '' : 's') +
           ' hábil' + (dias === 1 ? '' : 'es') + ' para descargar · se desactiva el ' + fecha;
}

/* Texto del aviso de cierre (notificación y modal) */
function textoAvisoCierre(nombre, dias, fechaISO) {
    const fecha = formatoFechaDia(fechaISO);
    return 'El trámite «' + nombre + '» finalizó. Tienes ' + dias + ' día' + (dias === 1 ? '' : 's') +
        ' hábil' + (dias === 1 ? '' : 'es') + ' (hasta el ' + fecha + ') para descargar los documentos ' +
        'de la carpeta. Después de esa fecha deberás solicitarlos escribiendo a ' + (DATOS_ENTIDAD.CORREO || 'la entidad') + '.';
}

/* Línea de resumen de la tarjeta */
function resumenSemaforoCarpeta(c, procesos) {
    if (c.pausado) return puntoSemaforo('pausado', 11) + ' <span><strong>Trámite en pausa</strong></span>';
    const actual = procesoActualDe(procesos);
    if (!actual) {
        if ((procesos || []).length > 0) return puntoSemaforo('verde', 11) + ' <span><strong>Todos los procesos completados</strong></span>';
        return icono('estado', 15) + ' <span>Sin procesos definidos todavía</span>';
    }
    const s = semaforoEfectivo(actual, c.pausado);
    const restantes = (s.diasRestantes === null) ? '' :
        s.diasRestantes < 0 ? ' · ' + cuantos(Math.abs(s.diasRestantes), 'día hábil', 'días hábiles') + ' de atraso' :
        ' · ' + (s.diasRestantes === 0 ? 'vence hoy' : plural(s.diasRestantes, 'queda ', 'quedan ') +
                 cuantos(s.diasRestantes, 'día hábil', 'días hábiles'));
    return puntoSemaforo(s.color, 11) + ' <span><strong>' + escaparHtml(actual.nombre) + '</strong>' +
        ' · ' + NOMBRE_SEMAFORO[s.color] + escaparHtml(restantes) + '</span>';
}

/* "19 de enero (martes)" */
function formatoVencimiento(iso) {
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const f = new Date(a, m - 1, d);
    const dia = f.toLocaleDateString('es-CO', { weekday: 'long' });
    const texto = f.toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }) +
        (a !== new Date().getFullYear() ? ' de ' + a : '');
    return texto + ' (' + dia + ')';
}

/* ============ VISTA: DETALLE DE CARPETA ============ */
async function abrirCarpeta(id) {
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    // Nadie abre carpetas ajenas
    if (!puedeVerCarpeta(carpeta)) {
        avisar('No tienes acceso a esta carpeta.', 'error');
        return;
    }
    carpetaAbierta = carpeta;
    // Cada carpeta se abre por su raíz
    _subcarpetaAbierta = null;
    _subcarpetas = [];
    mostrarVista('vista-carpeta');
    registrarActividad('abrir-carpeta', carpeta.nombre, carpeta.id);

    document.getElementById('detalle-nombre').textContent = carpeta.nombre;
    document.getElementById('detalle-estado').innerHTML = carpeta.activa
        ? '<span class="pt-insignia pt-insignia--activa">Activa</span>'
        : '<span class="pt-insignia pt-insignia--inactiva">Desactivada</span>';

    // Resumen del semáforo (se gestiona en Estados)
    pintarSemaforoDetalle(carpeta);

    // Trámite cerrado: plazo para descargar
    mostrarModalCierre(carpeta);

    // Notas internas: personal (y monitor, lectura)
    document.getElementById('zona-notas').hidden = !(ES_PERSONAL || ES_MONITOR);
    document.getElementById('detalle-descripcion').textContent = carpeta.descripcion || 'Sin notas internas todavía.';
    // Zona de carga cerrada por defecto; el botón solo para quien puede subir.
    const puedeSubir = puedeGestionarCarpeta(carpeta);
    document.getElementById('zona-subida').hidden = true;
    const botonSubir = document.getElementById('boton-subir');
    if (botonSubir) {
        botonSubir.hidden = !puedeSubir;
        botonSubir.textContent = '+ Subir archivos';
    }
    document.getElementById('migas-carpeta').textContent = carpeta.nombre;
    document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpeta);
    document.getElementById('form-descripcion').hidden = true;
    // Expediente: solo admin y operador responsable
    document.getElementById('boton-generar-expediente').hidden = !puedeGestionarCarpeta(carpeta);

    // Siempre se entra por "Archivos".
    _subPanelCarpeta = 'archivos';
    _editandoOrden = false;     // el modo reordenar no pasa de carpeta
    montarSubPestanasCarpeta(carpeta);
    prepararCalendarioLateral(carpeta); // datos del calendario
    quitarAdjuntoChat(); // el adjunto pendiente no pasa de carpeta
    _chatCarpetaMin = true;   // chat minimizado al entrar
    _acreedorDestino = '';

    // Filas grises mientras llegan los documentos de esta carpeta
    const tbArchivos = document.getElementById('lista-archivos');
    tbArchivos.innerHTML = esqueletoFilasTabla(tbArchivos.closest('table').querySelectorAll('thead th:not([hidden])').length, 4);
    document.getElementById('archivos-vacio').hidden = true;
    document.getElementById('archivos-resumen').innerHTML = _esq('16rem');

    await pintarArchivos();
    await pintarChats();
}

/* Cuatro cifras bajo el título, después de cargar los archivos. */
function pintarCifrasDetalle(carpeta, archivos) {
    const caja = document.getElementById('detalle-cifras');
    if (!caja || !carpeta) return;

    const docs = (archivos || []).length;
    const mb = (archivos || []).reduce(function (n, a) { return n + (Number(a.tamano) || 0); }, 0) / 1048576;
    const personas = (carpeta.asignados || []).length + (carpeta.operadores || []).length;

    // Días hábiles del proceso actual
    const procesos = _procesosPorCarpeta[carpeta.id] || [];
    const actual = procesoActualDe(procesos);
    let plazoNum = '—', plazoTit = 'Sin plazo activo', clase = '';
    if (actual && !carpeta.pausado) {
        const s = semaforoEfectivo(actual, carpeta.pausado);
        if (s.diasRestantes !== null) {
            if (s.diasRestantes < 0) {
                plazoNum = Math.abs(s.diasRestantes);
                plazoTit = 'Dias habiles de atraso';
                clase = 'pt-cifra__num--alerta';
            } else {
                plazoNum = s.diasRestantes;
                plazoTit = s.diasRestantes === 1 ? 'Dia habil restante' : 'Dias habiles restantes';
                clase = s.diasRestantes <= 1 ? 'pt-cifra__num--aviso' : '';
            }
        }
    } else if (carpeta.pausado) {
        plazoTit = 'Tramite en pausa';
    } else if (carpeta.finalizado) {
        plazoTit = 'Tramite finalizado';
    }

    const cifra = function (num, tit, cl) {
        return '<div>' +
            '<div class="pt-cifra__num' + (cl ? ' ' + cl : '') + '">' + num + '</div>' +
            '<div class="pt-cifra__tit">' + tit + '</div>' +
        '</div>';
    };

    caja.hidden = false;
    caja.innerHTML =
        cifra(docs, docs === 1 ? 'Documento' : 'Documentos') +
        cifra(mb.toFixed(2), 'MB') +
        cifra(personas, personas === 1 ? 'Persona' : 'Personas') +
        cifra(plazoNum, plazoTit, clase);

    pintarGenteDetalle(carpeta);
}

/* Quiénes están, con nombre y rol. Lo ven admin, monitor y operador
   responsable; las partes no ven a las otras. */
function pintarGenteDetalle(carpeta) {
    const caja = document.getElementById('detalle-gente');
    if (!caja) return;
    if (!(ES_PERSONAL || ES_MONITOR)) { caja.hidden = true; return; }

    const fila = (etiqueta, usuarios) => {
        if (!usuarios.length) return '';
        return '<div class="pt-gente__grupo">' +
            '<span class="pt-gente__eti">' + etiqueta + '</span>' +
            '<span class="pt-gente__nombres">' +
                usuarios.map(u => {
                    const perfil = (_usuariosCache || []).find(x => x.usuario === u);
                    const rol = perfil ? (ETIQUETAS_ROL[perfil.rol] || perfil.rol) : '';
                    return '<span class="pt-gente__chip" title="' +
                        escaparHtml(u + (rol ? ' · ' + rol : '')) + '">' +
                        escaparHtml(nombreDe(u)) +
                        (rol ? ' <em>' + escaparHtml(rol) + '</em>' : '') +
                    '</span>';
                }).join('') +
            '</span>' +
        '</div>';
    };

    const ops = carpeta.operadores || [];
    const partes = carpeta.asignados || [];
    if (!ops.length && !partes.length) {
        caja.hidden = false;
        caja.innerHTML = '<p class="pt-nota">Todavía no hay nadie asignado a este expediente.</p>';
        return;
    }
    caja.hidden = false;
    caja.innerHTML = '<div class="pt-gente">' +
        fila(ops.length === 1 ? 'Operador' : 'Operadores', ops) +
        fila(partes.length === 1 ? 'Parte' : 'Partes', partes) +
    '</div>';
}

/* Abre o cierra la zona de carga */
function alternarZonaSubida() {
    const zona = document.getElementById('zona-subida');
    const boton = document.getElementById('boton-subir');
    if (!zona) return;
    zona.hidden = !zona.hidden;
    if (boton) boton.textContent = zona.hidden ? '+ Subir archivos' : 'Cerrar zona de carga';
    if (!zona.hidden) zona.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============ SEMÁFORO EN EL DETALLE ============
   Solo lectura. La gestión está en Estados. */
async function pintarSemaforoDetalle(carpeta) {
    const zona = document.getElementById('detalle-semaforo');
    if (!zona) return;
    let procesos = [];
    try { procesos = await procesosListar(carpeta.id); } catch (e) { zona.innerHTML = ''; return; }

    if (carpeta.pausado) {
        zona.innerHTML = '<div class="pt-semaforo-resumen">' + puntoSemaforo('pausado', 14) +
            ' <strong>Trámite en pausa</strong>' +
            (carpeta.fechaPausa ? ' <span class="pt-nota">desde el ' + formatoFechaDia(carpeta.fechaPausa) + '</span>' : '') +
            '</div>';
        return;
    }
    if (procesos.length === 0) { zona.innerHTML = ''; return; }

    const actual = procesoActualDe(procesos);
    let cabeza;
    if (!actual) {
        cabeza = '<div class="pt-semaforo-resumen">' + puntoSemaforo('verde', 14) +
            ' <strong>Todos los procesos completados</strong> <span class="pt-nota">(' + procesos.length + ' en total)</span></div>';
    } else {
        const s = semaforoEfectivo(actual, carpeta.pausado);
        cabeza = '<div class="pt-semaforo-resumen">' + puntoSemaforo(s.color, 14) +
            ' <strong>' + escaparHtml(actual.nombre) + '</strong>' +
            ' <span class="pt-nota">· Vencimiento: ' + escaparHtml(formatoVencimiento(actual.fechaVencimiento)) +
            (s.diasRestantes === null ? '' :
                s.diasRestantes < 0 ? ' · ' + cuantos(Math.abs(s.diasRestantes), 'día hábil', 'días hábiles') + ' de atraso'
                : ' · ' + (s.diasRestantes === 0 ? 'hoy es el último día hábil'
                           : plural(s.diasRestantes, 'queda ', 'quedan ') + cuantos(s.diasRestantes, 'día hábil', 'días hábiles'))) +
            '</span></div>';
    }
    // Cronología de procesos
    const linea = procesos.map(p => {
        const s = semaforoEfectivo(p, carpeta.pausado);
        return '<span class="pt-semaforo-cadena__paso' + (p.completado ? ' hecho' : '') + '" title="' +
            escaparHtml(p.nombre + ' · ' + NOMBRE_SEMAFORO[s.color]) + '">' +
            puntoSemaforo(p.completado ? 'verde' : s.color, 10) + ' ' + escaparHtml(p.nombre) + '</span>';
    }).join('<span class="pt-semaforo-cadena__flecha">→</span>');
    zona.innerHTML = cabeza + '<div class="pt-semaforo-cadena">' + linea + '</div>';
}

/* ============ VISTA: ESTADOS ============
   Operador: sus trámites. Admin: todos + corrección. Monitor: lectura.
   Se refresca cada 5 min mientras está abierta. */
let _estadosCarpetas = [];        // carpetas de la vista
let _estadosProcesos = {};        // carpetaId → procesos
let _autoRefrescoEstados = null;  // recarga (5 min)
let _vistaEstados = 'tablero';    // 'tablero' | 'tabla'

/* Para el refresco al salir de la vista. */
function detenerAutoRefrescoEstados() {
    if (_autoRefrescoEstados) { clearInterval(_autoRefrescoEstados); _autoRefrescoEstados = null; }
}

/* Abre Estados y programa el refresco. */
async function mostrarVistaEstados() {
    if (!ES_PERSONAL && !ES_MONITOR) return;
    mostrarVista('vista-estados');
    document.getElementById('estados-nota').textContent = ES_SUPERVISION
        ? 'Semáforos de todos los trámites por días hábiles colombianos (lun–vie, sin festivos). ' +
          (ES_ADMIN ? 'Puedes corregir tiempos y estados: la corrección queda registrada.' : 'Vista de solo lectura.')
        : 'Aquí controlas la etapa de los trámites que tienes a cargo. Los plazos corren en días hábiles colombianos (lun–vie, sin festivos).';
    if (!cacheLeer('carpetas')) {
        document.getElementById('contenido-estados').innerHTML = esqueletoTabla(['Operador', 'Trámite', 'Proceso actual', 'Semáforo', 'Vencimiento', 'Días hábiles restantes', 'Trámite (60/90)', 'Acciones'], 6);
    }
    await cargarYPintarEstados();
    detenerAutoRefrescoEstados();
    _autoRefrescoEstados = setInterval(() => {
        if (!document.getElementById('vista-estados').hidden) cargarYPintarEstados();
    }, 5 * 60 * 1000);
}

/* Guarda carpetas y procesos de la vista */
function aplicarEstados(carpetas, procesos) {
    _estadosCarpetas = filtrarPorNotaria(carpetas.filter(puedeVerCarpeta))
        .sort((a, b) => b.fecha - a.fecha);
    _estadosProcesos = {};
    for (const p of procesos) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
}

/* Carga y pinta: primero la caché, luego el servidor. */
async function cargarYPintarEstados() {
    // Caché primero
    const cCarp = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cCarp && cProc);
    if (hayCopia) { aplicarEstados(cCarp, cProc); pintarEstados(); }

    try {
        const [rCarp, rProc] = await Promise.all([
            cacheRefrescar('carpetas', () => dbTodos('carpetas')),
            cacheRefrescar('procesos', () => procesosTodos())
        ]);
        // Si no cambió, no repinta (se perdería el menú abierto y el scroll)
        if (hayCopia && !rCarp.cambio && !rProc.cambio) return;
        aplicarEstados(rCarp.valor, rProc.valor);
    } catch (e) {
        // Con algo ya pintado no se borra: se avisa y se deja lo último
        if (hayCopia) { avisar('No se pudo actualizar: se muestra lo último que se cargó.', 'error'); return; }
        document.getElementById('contenido-estados').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar los estados.') + '</div>';
        return;
    }
    pintarEstados();
}

let _filtroEstados = 'activos'; // admin/monitor: 'activos' | 'desactivados'

/* Activos / desactivados. */
function cambiarFiltroEstados(filtro) {
    if (filtro !== 'activos' && filtro !== 'desactivados') return;
    _filtroEstados = filtro;
    pintarEstados();
}

/* Según el rol: operador tarjetas; admin y monitor tablero o tabla. */
function pintarEstados() {
    const cont = document.getElementById('contenido-estados');
    if (!cont) return;
    if (_estadosCarpetas.length === 0) {
        cont.innerHTML = '<div class="pt-vacio">' + (ES_OPERADOR
            ? 'No tienes trámites asignados como operador.'
            : 'No hay trámites todavía.') + '</div>';
        return;
    }
    if (!ES_SUPERVISION) {
        // Operador: sus carpetas activas (RLS)
        cont.innerHTML = filtrarPorBusqueda(_estadosCarpetas, _busquedaEstados).map(tarjetaEstadoTramite).join('') ||
            '<div class="pt-vacio">Sin resultados para la búsqueda.</div>';
        return;
    }
    // Admin y monitor: activos y desactivados por separado
    const activos = _estadosCarpetas.filter(c => c.activa);
    const desactivados = _estadosCarpetas.filter(c => !c.activa);
    const lista = filtrarPorBusqueda(_filtroEstados === 'desactivados' ? desactivados : activos, _busquedaEstados);
    const subTabs =
        '<div class="pt-sub-pestanas" style="margin-bottom:1.2rem;">' +
            '<button class="' + (_filtroEstados === 'activos' ? 'activa' : '') + '" data-accion="filtro-estados" data-filtro="activos">' +
                icono('carpeta', 17) + ' Activos (' + activos.length + ')</button>' +
            '<button class="' + (_filtroEstados === 'desactivados' ? 'activa' : '') + '" data-accion="filtro-estados" data-filtro="desactivados">' +
                icono('desactivar', 17) + ' Desactivados (' + desactivados.length + ')</button>' +
        '</div>';
    cont.innerHTML = subTabs + (lista.length
        ? (_vistaEstados === 'tabla'
            ? tablaEstadosGlobal(lista) + pieTablero(activos, desactivados)
            : tableroEstados(lista) + pieTablero(activos, desactivados))
        : '<div class="pt-vacio">' + (_busquedaEstados
            ? 'Sin resultados para la búsqueda.'
            : (_filtroEstados === 'desactivados'
                ? 'No hay trámites desactivados.' : 'No hay trámites activos.')) + '</div>');
}

/* ---- Tablero por urgencia (admin y monitor) ----
   Agrupa según el semáforo del servidor; aquí no se recalcula nada. */

/* Grupo de un trámite */
function grupoDeTramite(c) {
    const procesos = _estadosProcesos[c.id] || [];
    if (c.finalizado) return 'completados';
    if (c.pausado) return 'pausados';
    const actual = procesoActualDe(procesos);
    if (!actual) return procesos.length ? 'completados' : 'encurso';
    const s = semaforoEfectivo(actual, c.pausado);
    if (s.color === 'rojo') return 'vencidos';
    if (s.color === 'naranja') return 'porvencer';
    return 'encurso';
}

/* Plazo del trámite en su propia fila (al lado del nombre lo aplastaba).
   Fecha calculada por el servidor saltando festivos. */
function plazoTramite(c) {
    const hoy = fechaISOLocalHabil();

    const caja = (color, eti, valor, resto) =>
        '<div class="pt-plazo pt-plazo--' + color + '">' +
            '<span class="pt-plazo__eti">' + eti + '</span>' +
            '<span class="pt-plazo__fecha">' + valor + '</span>' +
            (resto ? '<span class="pt-plazo__resto">' + resto + '</span>' : '') +
        '</div>';

    if (!c.fechaInicioTramite || !c.fechaVencimientoTramite) {
        return caja('sin', 'Plazo', 'Sin iniciar', '');
    }
    if (c.finalizado) {
        return caja('verde', 'Finalizado',
            escaparHtml(c.fechaFinTramite ? formatoFechaCorta(c.fechaFinTramite) : '—'), '');
    }
    if (c.pausado) {
        return caja('gris', 'En pausa', 'Reloj detenido', '');
    }

    const vencido = c.fechaVencimientoTramite < hoy;
    let restantes = null;
    try { restantes = contarDiasHabiles(hoy, c.fechaVencimientoTramite); } catch (e) {}
    const color = vencido ? 'rojo' : (restantes !== null && restantes <= 5 ? 'naranja' : 'verde');
    const resto = restantes === null ? ''
        : (vencido ? Math.abs(restantes) + ' días hábiles de atraso'
                   : restantes + ' días hábiles') +
          (c.tieneProrroga ? ' · prórroga' : '');

    return caja(color, vencido ? 'Venció' : 'Vence',
                escaparHtml(formatoFechaCorta(c.fechaVencimientoTramite)), resto);
}

/* Tarjeta del tablero: nombre, plazo de 60 días, etapa en curso y acciones.
   Fechas cortas aquí; la larga está en el detalle. */
function tarjetaTramiteTablero(c) {
    const procesos = _estadosProcesos[c.id] || [];
    const actual = procesoActualDe(procesos);
    const operadores = (c.operadores || []).map(o => nombreDe(o)).join(', ');

    const lineas = [];
    if (c.finalizado) {
        lineas.push('Todos los procesos completados');
        lineas.push('Finalizado' +
            (c.fechaFinTramite ? ' el ' + escaparHtml(formatoFechaCorta(c.fechaFinTramite)) : ''));
    } else if (c.pausado) {
        lineas.push('Tramite en pausa: el reloj esta detenido');
    } else if (!actual) {
        lineas.push(procesos.length ? 'Todos los procesos completados' : 'En espera');
        lineas.push('Sin procesos definidos todavia');
    } else {
        // Este es el vencimiento de la etapa, no el de los 60 días
        const st = semaforoEfectivo(actual, c.pausado);
        const d = st.diasRestantes;
        lineas.push('Etapa: <strong>' + escaparHtml(actual.nombre) + '</strong>');
        lineas.push('Termina el ' + escaparHtml(formatoFechaCorta(actual.fechaVencimiento)) +
            (d === null ? '' : ' · ' + (d < 0
                ? Math.abs(d) + ' días hábiles de atraso'
                : d + ' días hábiles')));
    }

    // Menú solo si hay algo que gestionar
    const conMenu = !c.finalizado && puedeGestionarCarpeta(c);
    const etiqueta = c.finalizado ? 'Ver expediente' : 'Ver detalle';

    return '<article class="pt-tramite">' +
        '<div class="pt-tramite__cab">' +
            '<div class="pt-tramite__titulo">' +
                '<div class="pt-tramite__nombre">' + escaparHtml(c.nombre) + '</div>' +
                (operadores ? '<div class="pt-tramite__op">' + escaparHtml(operadores) + '</div>' : '') +
            '</div>' +
        '</div>' +
        plazoTramite(c) +
        '<div class="pt-tramite__cuerpo">' +
            lineas.map(l => '<div class="pt-tramite__linea">' + l + '</div>').join('') +
        '</div>' +
        '<div class="pt-tramite__acciones">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini pt-tramite__ver" ' +
                'data-accion="abrir-carpeta" data-id="' + c.id + '">' + etiqueta + '</button>' +
            (conMenu
                ? '<div class="pt-menu">' +
                    '<button class="pt-menu__boton" data-accion="menu-tramite" data-id="' + c.id + '" ' +
                            'aria-label="Más acciones" title="Más acciones">⋯</button>' +
                    '<div class="pt-menu__lista" id="menu-tramite-' + c.id + '" hidden>' +
                        '<button data-accion="abrir-carpeta" data-id="' + c.id + '">Abrir la carpeta</button>' +
                        (c.pausado
                            ? '<button data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar el tramite</button>'
                            : '<button data-accion="pausar-tramite" data-id="' + c.id + '">Pausar el tramite</button>') +
                    '</div>' +
                  '</div>'
                : '') +
        '</div>' +
    '</article>';
}

/* Una columna por grupo, siempre visibles (también vacías). */
function tableroEstados(carpetas) {
    const grupos = { vencidos: [], porvencer: [], encurso: [], pausados: [], completados: [] };
    for (const c of carpetas) grupos[grupoDeTramite(c)].push(c);

    const def = [
        ['vencidos',    'Vencidos',    'rojo',    'Ningun tramite vencido sin completar'],
        ['porvencer',   'Por vencer',  'naranja', 'Nada por vencer en los proximos dias habiles'],
        ['encurso',     'En curso',    'cian',    'Sin tramites en curso'],
        ['pausados',    'Pausados',    'gris',    'Ningun tramite en pausa'],
        ['completados', 'Completados', 'verde',   'Todavia no hay tramites completados']
    ];

    // Pausados solo si hay
    const visibles = def.filter(d => d[0] !== 'pausados' || grupos.pausados.length);

    const columnas = visibles.map(function (d) {
        const clave = d[0], titulo = d[1], color = d[2], vacio = d[3];
        const lista = grupos[clave];
        const puedeCrear = clave === 'encurso' && lista.some(c => !(_estadosProcesos[c.id] || []).length);

        return '<section class="pt-columna pt-columna--' + color + '">' +
            '<div class="pt-columna__cab">' +
                '<span class="pt-grupo__punto pt-grupo__punto--' + color + '"></span>' +
                '<span class="pt-columna__tit">' + titulo + '</span>' +
                '<span class="pt-columna__num">' + lista.length + '</span>' +
            '</div>' +
            '<div class="pt-columna__lista">' +
                (lista.length
                    ? lista.map(tarjetaTramiteTablero).join('')
                    : '<div class="pt-columna__vacio">' + vacio + '</div>') +
                (puedeCrear
                    ? '<button class="pt-columna__crear" data-accion="ver-carpetas">' +
                      '+ Anadir proceso a una carpeta sin tramites definidos</button>'
                    : '') +
            '</div>' +
        '</section>';
    }).join('');

    return '<div class="pt-tablero" style="--pt-columnas:' + visibles.length + ';">' + columnas + '</div>';
}

/* Tablero a Excel: grupo, proceso en curso y días que quedan. */
async function exportarEstadosExcel() {
    try {
        const XLSX = await cargarSheetJS();
        const ETIQ = {
            vencidos: 'Vencido', porvencer: 'Por vencer', encurso: 'En curso',
            pausados: 'Pausado', completados: 'Completado'
        };
        const filas = _estadosCarpetas.map(function (c) {
            const actual = procesoActualDe(_estadosProcesos[c.id] || []);
            const st = actual ? semaforoEfectivo(actual, c.pausado) : null;
            const d = st ? st.diasRestantes : null;
            return {
                'Carpeta': c.nombre,
                'Estado': ETIQ[grupoDeTramite(c)] || '',
                'Operadores': (c.operadores || []).map(o => nombreDe(o)).join(', '),
                'Proceso en curso': actual ? actual.nombre : '',
                'Vence': actual && actual.fechaVencimiento ? formatoFechaDia(actual.fechaVencimiento) : '',
                'Dias habiles': d === null ? '' : d,
                'Activa': c.activa ? 'Si' : 'No'
            };
        });
        const hoja = XLSX.utils.json_to_sheet(filas.length ? filas : [{
            'Carpeta': '', 'Estado': '', 'Operadores': '', 'Proceso en curso': '',
            'Vence': '', 'Dias habiles': '', 'Activa': ''
        }]);
        const libro = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(libro, hoja, 'Estados');
        XLSX.writeFile(libro, 'estados_tramites.xlsx');
        registrarActividad('exportar-estados', 'Excel del tablero de estados');
        avisar('Excel descargado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el Excel.', 'error');
    }
}

/* Pie: resumen y tablero/tabla */
function pieTablero(activos, desactivados) {
    return '<div class="pt-tablero__pie">' +
        '<span>' + cuantos(activos.length, 'trámite activo', 'trámites activos') + ' · ' +
            cuantos(desactivados.length, 'desactivado', 'desactivados') + '</span>' +
        '<span class="pt-acciones">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-vista-estados">' +
                (_vistaEstados === 'tabla' ? 'Ver como tablero' : 'Ver como tabla') +
            '</button>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="exportar-estados">' +
                'Exportar Excel</button>' +
        '</span>' +
    '</div>';
}

/* ---- Tabla global (admin y monitor) ---- */
function tablaEstadosGlobal(carpetas) {
    const filas = (carpetas || _estadosCarpetas).map(c => {
        const procesos = _estadosProcesos[c.id] || [];
        const actual = procesoActualDe(procesos);
        const operadores = (c.operadores || []).map(o => escaparHtml(nombreDe(o))).join(', ') || '<span class="pt-nota">sin asignar</span>';
        let semaforo, venc = '—', restantes = '—', procesoNombre = '<span class="pt-nota">sin procesos</span>';
        if (c.pausado) {
            semaforo = puntoSemaforo('pausado', 14) + ' Pausado';
            if (actual) { procesoNombre = escaparHtml(actual.nombre); venc = '<span class="pt-nota">en pausa</span>'; }
        } else if (!actual) {
            semaforo = procesos.length ? puntoSemaforo('verde', 14) + ' Completado' : '<span class="pt-nota">—</span>';
            if (procesos.length) procesoNombre = '<span class="pt-nota">todos completados</span>';
        } else {
            const s = semaforoEfectivo(actual, c.pausado);
            semaforo = puntoSemaforo(s.color, 14) + ' ' + NOMBRE_SEMAFORO[s.color] +
                (actual.semaforoManual && !actual.completado ? ' <span class="pt-nota" title="Fijado a mano por el administrador">(manual)</span>' : '');
            procesoNombre = escaparHtml(actual.nombre);
            venc = escaparHtml(formatoVencimiento(actual.fechaVencimiento));
            restantes = s.diasRestantes === null ? '—'
                : s.diasRestantes < 0 ? '<strong style="color:var(--pt-peligro,#ef4444);">' + s.diasRestantes + '</strong>'
                : String(s.diasRestantes);
        }
        // Conteo del trámite (60 o 90 con prórroga)
        let conteo;
        if (c.finalizado) {
            conteo = puntoSemaforo('verde', 10) + ' <strong>finalizado</strong>' +
                (c.fechaFinTramite ? ' (' + escaparHtml(c.fechaFinTramite) + ')' : '');
        } else if (!c.fechaInicioTramite) {
            conteo = '<span class="pt-nota">sin iniciar</span>';
        } else if (c.pausado) {
            conteo = puntoSemaforo('pausado', 10) + ' en pausa · ' + (c.diasHabilesTramite || 60) + ' días' +
                (c.tieneProrroga ? ' (prórroga)' : '');
        } else {
            const rt = c.fechaVencimientoTramite ? contarDiasHabiles(fechaISOLocalHabil(), c.fechaVencimientoTramite) : null;
            const vencidoT = c.fechaVencimientoTramite && c.fechaVencimientoTramite < fechaISOLocalHabil();
            conteo = vencidoT
                ? '<strong style="color:var(--pt-peligro,#ef4444);">vencido</strong> (' + (c.diasHabilesTramite || 60) + ' días)'
                : '<strong>' + rt + '</strong> de ' + (c.diasHabilesTramite || 60) +
                  (c.tieneProrroga ? ' <span class="pt-nota">(prórroga)</span>' : '');
        }

        let acciones = '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="detalle-tramite" data-id="' + c.id + '">Ver detalle</button>';
        if (ES_ADMIN && c.finalizado) {
            // cerrado: sin acciones
        } else if (ES_ADMIN) {
            acciones += ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Proceso</button>' +
                (actual && !c.pausado ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + actual.id + '">Editar</button>' : '') +
                (!c.fechaInicioTramite && !c.pausado
                    ? ' <button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar plazo</button>' : '') +
                (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado
                    ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">+30 días</button>' : '') +
                (c.pausado
                    ? ' <button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar</button>'
                    : ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar</button>') +
                ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="finalizar-tramite" data-id="' + c.id + '">Fin de trámite</button>';
        }
        return '<tr class="pt-fila-estado" data-accion="detalle-tramite" data-id="' + c.id + '" style="cursor:pointer;">' +
            '<td>' + operadores + '</td>' +
            '<td>' + escaparHtml(c.nombre) + (c.activa ? '' : ' <span class="pt-nota">(desactivada)</span>') + '</td>' +
            '<td>' + procesoNombre + '</td>' +
            '<td>' + semaforo + '</td>' +
            '<td>' + venc + '</td>' +
            '<td>' + restantes + '</td>' +
            '<td>' + conteo + '</td>' +
            '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
            '</tr>';
    }).join('');
    return '<div class="pt-tabla-envoltura"><table class="pt-tabla">' +
        '<thead><tr><th>Operador</th><th>Trámite</th><th>Proceso actual</th><th>Semáforo</th><th>Vencimiento</th><th>Días hábiles restantes</th><th>Trámite (60/90)</th><th>Acciones</th></tr></thead>' +
        '<tbody>' + filas + '</tbody></table></div>';
}

/* ---- Tarjeta de gestión (operador) ---- */
function tarjetaEstadoTramite(c) {
    const procesos = _estadosProcesos[c.id] || [];
    const actual = procesoActualDe(procesos);
    const gestiona = puedeGestionarCarpeta(c) || (ES_OPERADOR && (c.operadores || []).includes(sesion.usuario));

    let cabeceraEstado;
    if (c.pausado) {
        cabeceraEstado = puntoSemaforo('pausado', 14) + ' <strong>Trámite en pausa</strong>' +
            (c.fechaPausa ? ' <span class="pt-nota">desde el ' + formatoFechaDia(c.fechaPausa) + '</span>' : '');
    } else if (!actual) {
        cabeceraEstado = procesos.length
            ? puntoSemaforo('verde', 14) + ' <strong>Todos los procesos completados</strong>'
            : '<span class="pt-nota">Este trámite aún no tiene procesos. Crea el primero.</span>';
    } else {
        const s = semaforoEfectivo(actual, c.pausado);
        cabeceraEstado = puntoSemaforo(s.color, 14) + ' <strong>' + escaparHtml(actual.nombre) + '</strong>' +
            '<span class="pt-nota"> · Vencimiento: ' + escaparHtml(formatoVencimiento(actual.fechaVencimiento)) +
            (s.diasRestantes === null ? '' :
                s.diasRestantes < 0 ? ' · <strong>' + cuantos(Math.abs(s.diasRestantes), 'día hábil', 'días hábiles') + ' de atraso</strong>'
                : ' · ' + (s.diasRestantes === 0 ? '<strong>hoy es el último día hábil</strong>'
                           : plural(s.diasRestantes, 'queda ', 'quedan ') + cuantos(s.diasRestantes, 'día hábil', 'días hábiles'))) +
            '</span>';
    }

    let botones = '';
    if (gestiona && !c.finalizado) {
        if (actual && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="completar-proceso" data-id="' + actual.id + '">' +
                icono('activar', 15) + ' Marcar como completado</button> ';
        }
        botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Nuevo proceso</button> ';
        if (!c.fechaInicioTramite && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar plazo (60 días hábiles)</button> ';
        }
        // El operador responsable también aplica la prórroga
        if (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado) {
            botones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">Prórroga: +30 días hábiles</button> ';
        }
        botones += c.pausado
            ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar trámite</button>'
            : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar trámite</button>';
    }

    const lineaTramite = resumenTramite(c);
    return '<article class="pt-estado-tramite-card' + (c.pausado ? ' pt-estado-tramite-card--pausada' : '') + '">' +
        '<div class="pt-estado-tramite-card__cab"><h3>' + escaparHtml(c.nombre) + '</h3>' +
        '<div class="pt-celda-acciones">' + botones + '</div></div>' +
        '<p class="pt-estado-tramite-card__actual">' + cabeceraEstado + '</p>' +
        (lineaTramite ? '<p class="pt-estado-tramite-card__actual pt-nota">' + lineaTramite + '</p>' : '') +
        cronologiaProcesos(c, procesos, gestiona) +
        '</article>';
}

/* Cronología (tarjeta y modal) */
function cronologiaProcesos(c, procesos, gestiona) {
    if (!procesos.length) return '';
    const filas = procesos.map(p => {
        const s = semaforoEfectivo(p, c.pausado);
        const detalle = p.completado
            ? 'Completado' + (p.fechaCompletado ? ' el ' + formatoFechaDia(p.fechaCompletado) : '')
            : (c.pausado || p.pausado)
                ? 'En pausa · ' + (p.diasRestantesAlPausar == null ? 'sin días guardados'
                    : p.diasRestantesAlPausar + plural(p.diasRestantesAlPausar, ' día hábil guardado', ' días hábiles guardados'))
                : 'Vence: ' + formatoVencimiento(p.fechaVencimiento) +
                  (s.diasRestantes === null ? '' :
                   s.diasRestantes < 0 ? ' · ' + Math.abs(s.diasRestantes) + plural(Math.abs(s.diasRestantes), ' día de atraso', ' días de atraso')
                   : s.diasRestantes === 1 ? ' · falta 1 día hábil'
                   : ' · faltan ' + s.diasRestantes + ' días hábiles');
        let acciones = '';
        if (gestiona && !p.completado && !c.pausado) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="completar-proceso" data-id="' + p.id + '">Completar</button> ';
        }
        if (ES_ADMIN) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + p.id + '">Editar</button> ';
        }
        if (gestiona) {
            acciones += '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-proceso" data-id="' + p.id + '">Eliminar</button>';
        }
        return '<div class="pt-proceso-fila">' +
            puntoSemaforo(p.completado ? 'verde' : s.color, 12) +
            '<div class="pt-proceso-fila__txt"><strong>' + p.orden + '. ' + escaparHtml(p.nombre) + '</strong>' +
            '<span class="pt-nota">Plazo: ' + cuantos(p.dias, 'día hábil', 'días hábiles') + ' · ' + escaparHtml(detalle) +
            (p.semaforoManual && !p.completado ? ' · semáforo manual' : '') + '</span></div>' +
            '<div class="pt-celda-acciones">' + acciones + '</div>' +
            '</div>';
    }).join('');
    return '<div class="pt-proceso-lista">' + filas + '</div>';
}

/* ---- Acciones sobre procesos ---- */
let _carpetaProcesoNuevo = null;

/* Formulario de nuevo proceso. */
function abrirModalProceso(carpetaId) {
    if (!ES_PERSONAL) return;
    cerrarDetalleTramite();   // cierra el detalle para no quedar detrás
    _carpetaProcesoNuevo = carpetaId;
    document.getElementById('proceso-nombre').value = '';
    document.getElementById('proceso-dias').value = '';
    document.getElementById('proceso-venc-previo').textContent = '';
    document.getElementById('modal-proceso').hidden = false;
    document.getElementById('proceso-nombre').focus();
}

/* Cierra el formulario. */
function cerrarModalProceso() {
    document.getElementById('modal-proceso').hidden = true;
    _carpetaProcesoNuevo = null;
}

/* Crea el proceso. El vencimiento lo calcula el servidor. */
async function crearProcesoDesdeModal(evento) {
    evento.preventDefault();
    if (!ES_PERSONAL || !_carpetaProcesoNuevo) return;
    const nombre = document.getElementById('proceso-nombre').value.trim();
    const dias = Math.floor(Number(document.getElementById('proceso-dias').value));
    if (!nombre) { avisar('El proceso necesita un nombre.', 'error'); return; }
    if (!dias || dias <= 0) { avisar('El plazo en días hábiles debe ser mayor que cero.', 'error'); return; }
    try {
        await procesoCrear(_carpetaProcesoNuevo, { nombre, dias });
        registrarActividad('crear-proceso', nombre + ' (' + dias + ' días hábiles)', _carpetaProcesoNuevo);
        avisar('Proceso creado. Vence el ' + formatoVencimiento(calcularVencimientoHabil(new Date(), dias)) + '.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear el proceso.', 'error');
        return;
    }
    cerrarModalProceso();
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* Completa un proceso (el servidor pone la fecha y recalcula). */
async function completarProcesoAccion(procesoId) {
    if (!ES_PERSONAL) return;
    if (!await confirmarPortal('¿Marcar este proceso como completado? Esta acción queda registrada.')) return;
    try {
        await procesoCompletar(procesoId);
        registrarActividad('completar-proceso', nombreProceso(procesoId));
        avisar('Proceso marcado como completado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo completar el proceso.', 'error');
    }
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* Borra un proceso (con confirmación). */
async function eliminarProcesoAccion(procesoId) {
    if (!ES_PERSONAL) return;
    if (!await confirmarPortal('¿Eliminar este proceso del trámite? Esta acción no se puede deshacer.')) return;
    try {
        await procesoEliminar(procesoId);
        registrarActividad('eliminar-proceso', nombreProceso(procesoId));
        avisar('Proceso eliminado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar el proceso.', 'error');
    }
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* Pausa: el reloj se detiene hasta reactivar. */
async function pausarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('¿Pausar el trámite' + (c ? ' "' + c.nombre + '"' : '') + '?\n\n' +
        'El reloj de los plazos se detiene: se guardan los días hábiles que le quedan a cada proceso pendiente y se reanudan al reactivar.')) return;
    try {
        await tramitePausar(carpetaId);
        registrarActividad('pausar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite pausado: los plazos quedan congelados.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo pausar el trámite.', 'error');
    }
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* Reactiva y el reloj sigue. */
async function reactivarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('¿Reactivar el trámite' + (c ? ' "' + c.nombre + '"' : '') + '?\n\n' +
        'Los vencimientos se recalculan desde hoy con los días hábiles que quedaban al pausar.')) return;
    try {
        await tramiteReactivar(carpetaId);
        registrarActividad('reactivar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite reactivado: los plazos vuelven a correr.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo reactivar el trámite.', 'error');
    }
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* ---- Conteo del trámite: iniciar (60) y prórroga (90) ---- */
async function iniciarTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme el inicio del plazo del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'Corren 60 días hábiles colombianos desde hoy, saltando fines de semana y festivos. ' +
        'Al confirmar se calcula el día exacto en que se cumple.', 'Iniciar plazo')) return;
    try {
        await tramiteIniciar(carpetaId);
        registrarActividad('iniciar-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        // Se muestra la fecha que calculó el servidor
        let vence = null;
        try { vence = (await dbObtener('carpetas', carpetaId) || {}).fechaVencimientoTramite; }
        catch (e) { /* sin fecha si no se puede leer */ }
        avisar(vence
            ? 'Plazo iniciado. El trámite vence el ' + formatoFechaDia(vence) + '.'
            : 'Plazo iniciado: 60 días hábiles.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo iniciar el plazo.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

/* Fin de trámite: solo admin (lo exige el servidor) */
async function finalizarTramiteAccion(carpetaId) {
    if (!ES_ADMIN) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme el FIN del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'El trámite queda cerrado: se detiene el conteo de días hábiles y ya no se podrán iniciar conteos ni aplicar prórrogas. Esta acción queda registrada.', 'Fin de trámite')) return;
    try {
        await tramiteFinalizar(carpetaId);
        registrarActividad('fin-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        avisar('Trámite finalizado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo finalizar el trámite.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

/* Prórroga: una por trámite (el servidor la rechaza si ya se usó). */
async function prorrogaTramiteAccion(carpetaId) {
    if (!ES_PERSONAL) return; // admin u operador responsable
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!await confirmarPortal('Confirme la PRÓRROGA del trámite' + (c ? ' "' + c.nombre + '"' : '') + '.\n\n' +
        'Se añaden 30 días hábiles: el plazo pasa de 60 a 90, contados desde la misma fecha ' +
        'de inicio. Solo se puede aplicar una vez.', 'Añadir prórroga')) return;
    try {
        await tramiteProrroga(carpetaId);
        registrarActividad('prorroga-tramite', (c && c.nombre) || String(carpetaId), carpetaId);
        let nueva = null;
        try { nueva = (await dbObtener('carpetas', carpetaId) || {}).fechaVencimientoTramite; }
        catch (e) { /* sin fecha si no se puede leer */ }
        avisar(nueva
            ? 'Prórroga aplicada. El trámite ahora vence el ' + formatoFechaDia(nueva) + '.'
            : 'Prórroga aplicada: el trámite ahora tiene 90 días hábiles.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo aplicar la prórroga.', 'error');
    }
    cerrarDetalleTramite();
    await cargarYPintarEstados();
}

/* Nombre de un proceso por id (caché de Estados). */
function nombreProceso(procesoId) {
    for (const lista of Object.values(_estadosProcesos)) {
        const p = lista.find(x => x.id === procesoId);
        if (p) return p.nombre;
    }
    return String(procesoId);
}

/* ---- Corrección del admin ---- */
let _procesoEditandoId = null;

/* Corrección de un proceso (solo admin, queda en la actividad). */
function abrirModalEditarProceso(procesoId) {
    if (!ES_ADMIN) return;
    cerrarDetalleTramite();   // cierra el detalle
    let proceso = null;
    for (const lista of Object.values(_estadosProcesos)) {
        proceso = lista.find(x => x.id === procesoId) || proceso;
    }
    if (!proceso) return;
    _procesoEditandoId = procesoId;
    document.getElementById('edproc-nombre').value = proceso.nombre;
    document.getElementById('edproc-dias').value = proceso.dias;
    document.getElementById('edproc-vencimiento').value = proceso.fechaVencimiento || '';
    document.getElementById('edproc-completado').value = '';
    document.getElementById('edproc-semaforo').value = proceso.semaforoManual || '';
    document.getElementById('modal-editar-proceso').hidden = false;
}

/* Cierra la corrección. */
function cerrarModalEditarProceso() {
    document.getElementById('modal-editar-proceso').hidden = true;
    _procesoEditandoId = null;
}

/* Guarda nombre, plazo y estado. */
async function guardarEdicionProceso(evento) {
    evento.preventDefault();
    if (!ES_ADMIN || !_procesoEditandoId) return;
    const cambios = {
        nombre: document.getElementById('edproc-nombre').value.trim() || null,
        dias: Math.floor(Number(document.getElementById('edproc-dias').value)) || null,
        vencimiento: document.getElementById('edproc-vencimiento').value || null,
        semaforo: document.getElementById('edproc-semaforo').value  // '' = automático
    };
    const comp = document.getElementById('edproc-completado').value;
    if (comp === 'true') cambios.completado = true;
    if (comp === 'false') cambios.completado = false;
    try {
        await procesoEditarAdmin(_procesoEditandoId, cambios);
        registrarActividad('corregir-proceso', nombreProceso(_procesoEditandoId));
        avisar('Corrección guardada (quedó registrada con tu usuario).');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la corrección.', 'error');
        return;
    }
    cerrarModalEditarProceso();
    cerrarDetalleTramite(); // cierra el detalle si venía de ahí
    await cargarYPintarEstados();
}

/* ---- Detalle del trámite (admin/monitor) ---- */
function abrirDetalleTramite(carpetaId) {
    if (!ES_SUPERVISION) return;
    const c = _estadosCarpetas.find(x => x.id === carpetaId);
    if (!c) return;
    const procesos = _estadosProcesos[carpetaId] || [];
    const totales = procesos.reduce((s, p) => s + (p.dias || 0), 0);
    const completados = procesos.filter(p => p.completado);
    const hoy = fechaISOLocalHabil();
    const pendiente = procesoActualDe(procesos);
    const restantes = (c.pausado || !pendiente) ? null : contarDiasHabiles(hoy, pendiente.fechaVencimiento);

    let acciones = '';
    if (ES_ADMIN && !c.finalizado) {
        acciones = '<div class="pt-celda-acciones" style="margin:.8rem 0;">' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="nuevo-proceso" data-id="' + c.id + '">+ Nuevo proceso</button> ' +
            (!c.fechaInicioTramite && !c.pausado
                ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="iniciar-tramite" data-id="' + c.id + '">Iniciar plazo (60 días hábiles)</button> ' : '') +
            (c.fechaInicioTramite && !c.tieneProrroga && !c.pausado
                ? '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="prorroga-tramite" data-id="' + c.id + '">Prórroga: +30 días hábiles</button> ' : '') +
            (c.pausado
                ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="reactivar-tramite" data-id="' + c.id + '">Reactivar trámite</button>'
                : '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="pausar-tramite" data-id="' + c.id + '">Pausar trámite</button>') +
            ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="finalizar-tramite" data-id="' + c.id + '">Fin de trámite</button>' +
            '</div>';
    }

    const lineaTramite = resumenTramite(c);
    document.getElementById('detalle-tramite-cuerpo').innerHTML =
        '<h3>' + escaparHtml(c.nombre) + '</h3>' +
        '<p class="pt-nota">' + plural((c.operadores || []).length, 'Operador', 'Operadores') + ': ' +
            ((c.operadores || []).map(o => escaparHtml(nombreDe(o))).join(', ') || 'sin asignar') +
            ' · Estado: ' + (c.activa ? 'activa' : 'desactivada') +
            ' · Pausado: ' + (c.pausado ? 'sí' + (c.fechaPausa ? ' (desde ' + escaparHtml(c.fechaPausa) + ')' : '') : 'no') + '</p>' +
        (lineaTramite
            ? '<p class="pt-nota">' + lineaTramite +
              (c.fechaInicioTramite ? ' · inició el ' + escaparHtml(formatoFechaDia(c.fechaInicioTramite)) : '') + '</p>'
            : '<p class="pt-nota">Conteo del trámite (60/90 días hábiles): sin iniciar.</p>') +
        '<p class="pt-nota">Días hábiles totales de los plazos: <strong>' + totales + '</strong>' +
            ' · Procesos completados: <strong>' + completados.length + ' de ' + procesos.length + '</strong>' +
            (restantes === null ? '' : ' · Días hábiles restantes del proceso actual: <strong>' + restantes + '</strong>') + '</p>' +
        acciones +
        (procesos.length ? cronologiaProcesos(c, procesos, ES_ADMIN) : '<p class="pt-nota">Sin procesos definidos.</p>') +
        '<div class="pt-modal__acciones">' +
            '<button class="pt-boton pt-boton--fantasma" data-accion="cerrar-modal-detalle-tramite">Cerrar</button>' +
        '</div>';
    document.getElementById('modal-detalle-tramite').hidden = false;
}

/* Cierra el detalle. */
function cerrarDetalleTramite() {
    document.getElementById('modal-detalle-tramite').hidden = true;
}

/* ============ VISTA: CALENDARIO DE VENCIMIENTOS ============
   Admin/monitor: todos, con el operador responsable.
   Operador: sus carpetas, el trámite (60/90) y sus recordatorios. */
let _mesCalVenc = null;
let _diaCalVencSel = null;
let _recordatoriosCalCache = [];
let _filtroCalOperador = '';   // '' = todos los operadores
let _filtroCalTramite = '';    // '' = todos los trámites

/* Calendario: caché primero, luego el servidor. */
async function mostrarVistaCalendarioVenc() {
    if (!ES_SUPERVISION && !ES_OPERADOR) return;
    mostrarVista('vista-calendario');
    // Con lo guardado; se corrige al llegar el servidor
    const cCarp = cacheLeer('carpetas'), cProc = cacheLeer('procesos');
    const hayCopia = !!(cCarp && cProc);
    if (hayCopia) {
        _estadosCarpetas = filtrarPorNotaria(cCarp.filter(puedeVerCarpeta));
        _estadosProcesos = {};
        for (const p of cProc) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
        _recordatoriosCalCache = cacheLeer('recordatorios') || [];
        if (!_mesCalVenc) { const h = new Date(); _mesCalVenc = new Date(h.getFullYear(), h.getMonth(), 1); }
        pintarCalendarioVenc();
    } else {
        document.getElementById('contenido-calendario-venc').innerHTML = esqueletoCalendario();
    }

    try {
        const [rCarp, rProc, rRec] = await Promise.all([
            cacheRefrescar('carpetas', () => dbTodos('carpetas')),
            cacheRefrescar('procesos', () => procesosTodos()),
            ES_OPERADOR
                ? cacheRefrescar('recordatorios', () => recordatoriosMios().catch(() => []))
                : Promise.resolve({ valor: [], cambio: false })
        ]);
        if (hayCopia && !rCarp.cambio && !rProc.cambio && !rRec.cambio) return;
        _estadosCarpetas = filtrarPorNotaria(rCarp.valor.filter(puedeVerCarpeta));
        _estadosProcesos = {};
        for (const p of rProc.valor) (_estadosProcesos[p.carpetaId] = _estadosProcesos[p.carpetaId] || []).push(p);
        _recordatoriosCalCache = rRec.valor || [];
    } catch (e) {
        if (hayCopia) { avisar('No se pudo actualizar: se muestra lo último que se cargó.', 'error'); return; }
        document.getElementById('contenido-calendario-venc').innerHTML =
            '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo cargar el calendario.') + '</div>';
        return;
    }
    if (!_mesCalVenc) { const hoy = new Date(); _mesCalVenc = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }
    _diaCalVencSel = null;
    pintarCalendarioVenc();
}

/* Color del vencimiento según el estado del proceso */
function colorVencimiento(c, p) {
    if (p.completado) {
        // verde a tiempo, rojo apagado si fue tarde
        return (p.fechaCompletado && p.fechaCompletado <= p.fechaVencimiento) ? 'verde' : 'rojo';
    }
    return semaforoEfectivo(p, c.pausado).color;
}

/* Columna derecha: cómo va el mes, qué sigue y qué hacer (datos ya cargados). */
function agendaProximos(carpetas, resumen) {
    const hoy = fechaISOLocalHabil();
    const items = [];

    for (const c of (carpetas || [])) {
        if (c.pausado || c.finalizado) continue;
        for (const p of (_estadosProcesos[c.id] || [])) {
            if (p.completado || p.pausado || !p.fechaVencimiento) continue;
            const st = semaforoEfectivo(p, c.pausado);
            items.push({
                fecha: p.fechaVencimiento,
                que: p.nombre,
                carpeta: c.nombre,
                carpetaId: c.id,
                operadores: (c.operadores || []).map(function (o) { return nombreDe(o); }).join(', '),
                color: st.color,
                dias: st.diasRestantes
            });
        }
    }
    items.sort(function (a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });

    // ---- 1: resumen del mes ----
    const filaResumen = (color, texto, n) =>
        '<div class="pt-agenda__cifra">' + puntoSemaforo(color, 9) +
            '<span>' + texto + '</span><strong>' + n + '</strong></div>';
    const cajaResumen =
        '<div class="pt-agenda__caja">' +
            '<div class="pt-agenda__tit">Resumen del mes</div>' +
            filaResumen('rojo',    'Vencidos sin completar', resumen.rojos) +
            filaResumen('naranja', 'Por vencer (0–1 día hábil)', resumen.naranjas) +
            filaResumen('verde',   'Completados a tiempo', resumen.verdes) +
        '</div>';

    // ---- 2: próximos diez días ----
    const limite = new Date(hoy + 'T12:00:00');
    limite.setDate(limite.getDate() + 10);
    const limiteISO = fechaISOLocal(limite);
    const proximos = items.filter(it => it.fecha <= limiteISO).slice(0, 6);

    const MES_CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    const filas = proximos.map(function (it) {
        const partes = String(it.fecha).split('-');
        const dia = partes[2] || '--';
        const mes = MES_CORTO[Number(partes[1]) - 1] || '';
        let plazo = '', clase = '';
        if (it.dias !== null && it.dias !== undefined) {
            if (it.dias < 0) { plazo = Math.abs(it.dias) + ' d. de atraso'; clase = ' pt-agenda__plazo--rojo'; }
            else if (it.dias <= 1) { plazo = it.dias + ' día hábil'; clase = ' pt-agenda__plazo--naranja'; }
            else { plazo = it.dias + ' días hábiles'; }
        }
        return '<div class="pt-agenda__item">' +
            '<div class="pt-agenda__fecha">' +
                '<div class="pt-agenda__dia">' + dia + '</div>' +
                '<div class="pt-agenda__mes">' + mes + '</div>' +
            '</div>' +
            '<div>' +
                '<div class="pt-agenda__que">' + escaparHtml(it.que) + '</div>' +
                '<div class="pt-agenda__det">' + escaparHtml(it.carpeta) +
                    (it.operadores ? ' · ' + escaparHtml(it.operadores) : '') + '</div>' +
                (plazo ? '<span class="pt-agenda__plazo' + clase + '">' + plazo + '</span>' : '') +
            '</div>' +
        '</div>';
    }).join('');
    const cajaAgenda =
        '<div class="pt-agenda__caja">' +
            '<div class="pt-agenda__tit">Agenda · próximos 10 días</div>' +
            (filas || '<div class="pt-agenda__vacio">Nada vence en los próximos diez días.</div>') +
        '</div>';

    // ---- 3: acción sugerida ----
    // Solo si hay algo vencido o a un día hábil.
    const urgente = items.find(it => it.dias !== null && it.dias !== undefined && it.dias <= 1);
    let cajaAccion = '';
    if (urgente) {
        cajaAccion =
            '<div class="pt-agenda__caja pt-agenda__caja--accion">' +
                '<div class="pt-agenda__tit">Acción sugerida</div>' +
                '<div class="pt-agenda__accion-que">' + escaparHtml(urgente.que) + '</div>' +
                '<div class="pt-agenda__accion-det">' + escaparHtml(urgente.carpeta) + ' · ' +
                    (urgente.dias < 0
                        ? cuantos(Math.abs(urgente.dias), 'día hábil', 'días hábiles') + ' de atraso'
                        : urgente.dias === 0 ? 'vence hoy'
                        : 'vence en ' + cuantos(urgente.dias, 'día hábil', 'días hábiles')) + '</div>' +
                '<div class="pt-agenda__accion-btns">' +
                    '<button class="pt-boton pt-boton--mini" data-accion="abrir-carpeta" data-id="' +
                        urgente.carpetaId + '">Abrir la carpeta</button>' +
                    '<button class="pt-boton pt-boton--mini pt-boton--fantasma" data-accion="pausar-tramite" data-id="' +
                        urgente.carpetaId + '">Pausar el trámite</button>' +
                '</div>' +
            '</div>';
    }

    return '<aside class="pt-agenda">' + cajaResumen + cajaAgenda + cajaAccion + '</aside>';
}

/* El mes: marcas por día, color de la más urgente y panel derecho. */
function pintarCalendarioVenc() {
    const cont = document.getElementById('contenido-calendario-venc');
    if (!cont || !_mesCalVenc) return;
    const anio = _mesCalVenc.getFullYear();
    const mes = _mesCalVenc.getMonth();
    const hoyISO = fechaISOLocalHabil();

    // Filtros de admin/monitor: todo, o por operador y trámite.
    let carpetasCal = _estadosCarpetas;
    if (_filtroCalOperador) carpetasCal = carpetasCal.filter(c => (c.operadores || []).includes(_filtroCalOperador));
    if (_filtroCalTramite) carpetasCal = carpetasCal.filter(c => String(c.id) === String(_filtroCalTramite));

    // Marcas: procesos, trámite (60/90) y recordatorios del operador
    const porDia = {};
    const marcar = (iso, m) => { if (iso) (porDia[iso] = porDia[iso] || []).push(m); };
    for (const c of carpetasCal) {
        for (const p of (_estadosProcesos[c.id] || [])) {
            marcar(p.fechaVencimiento, { tipo: 'proceso', c, p });
        }
        if (c.fechaVencimientoTramite) marcar(c.fechaVencimientoTramite, { tipo: 'tramite', c });
    }
    for (const r of _recordatoriosCalCache) {
        marcar(r.fechaInicio, { tipo: 'recordatorio', r });
        if (r.fechaFin && r.fechaFin !== r.fechaInicio) marcar(r.fechaFin, { tipo: 'recordatorio', r, fin: true });
    }
    const colorMarca = (m) => m.tipo === 'proceso' ? colorVencimiento(m.c, m.p)
        : m.tipo === 'tramite' ? (m.c.fechaVencimientoTramite < hoyISO ? 'rojo' : 'naranja')
        : 'pausado'; // recordatorios en gris

    // Resumen: rojos vencidos, naranjas 0-1 día, verdes a tiempo. Respeta filtros.
    let rojos = 0, naranjas = 0, verdes = 0;
    for (const c of carpetasCal) {
        for (const p of (_estadosProcesos[c.id] || [])) {
            const col = colorVencimiento(c, p);
            if (p.completado) { if (col === 'verde') verdes++; }
            else if (col === 'rojo') rojos++;
            else if (col === 'naranja') naranjas++;
        }
    }

    const primerDia = (new Date(anio, mes, 1).getDay() + 6) % 7; // lunes = 0
    const diasMes = new Date(anio, mes + 1, 0).getDate();
    let celdas = '';
    for (let i = 0; i < primerDia; i++) celdas += '<span class="pt-calv__dia pt-calv__dia--vacio"></span>';
    for (let d = 1; d <= diasMes; d++) {
        const iso = anio + '-' + String(mes + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const noHabil = !esDiaHabil(iso);
        const marcas = porDia[iso] || [];
        // Dos etiquetas por día; el resto se cuenta
        const etiquetaMarca = (m) => m.tipo === 'proceso' ? m.p.nombre
            : m.tipo === 'tramite' ? 'Vence ' + m.c.nombre
            : m.r.mensaje;
        const chips = marcas.slice(0, 2).map(m =>
            '<span class="pt-calv__chip pt-calv__chip--' + colorMarca(m) + '">' +
                escaparHtml(etiquetaMarca(m)) + '</span>').join('') +
            (marcas.length > 2 ? '<span class="pt-calv__mas">+' + (marcas.length - 2) + ' más</span>' : '');
        // Color de la marca más urgente
        const ORDEN = ['rojo', 'naranja', 'verde', 'pausado'];
        let tinte = '';
        for (const col of ORDEN) { if (marcas.some(m => colorMarca(m) === col)) { tinte = col; break; } }
        celdas += '<button type="button" class="pt-calv__dia' +
            (noHabil ? ' pt-calv__dia--nohabil' : '') +
            (tinte ? ' pt-calv__dia--marca-' + tinte : '') +
            (iso === hoyISO ? ' pt-calv__dia--hoy' : '') +
            (iso === _diaCalVencSel ? ' pt-calv__dia--sel' : '') + '"' +
            ' data-accion="cal-venc-dia" data-fecha="' + iso + '"' +
            (marcas.length ? ' title="' + cuantos(marcas.length, 'vencimiento', 'vencimientos') + '"' : (noHabil ? ' title="Día no hábil"' : '')) +
            '><span class="pt-calv__num">' + d + '</span>' +
            '<span class="pt-calv__chips">' + chips + '</span></button>';
    }

    // lista del día elegido
    let listaDia = '';
    if (_diaCalVencSel) {
        const marcas = porDia[_diaCalVencSel] || [];
        const filaDia = (m) => {
            if (m.tipo === 'proceso') {
                // admin/monitor: con operador
                const responsables = ES_SUPERVISION
                    ? ' · Operador responsable: ' + ((m.c.operadores || []).map(o => nombreDe(o)).join(', ') || 'sin asignar')
                    : '';
                const vencido = colorVencimiento(m.c, m.p) === 'rojo' && !m.p.completado;
                // Vencido: la fila lleva a la carpeta
                const abre = vencido ? ' data-accion="abrir-carpeta" data-id="' + m.c.id + '" style="cursor:pointer;" title="Abrir la carpeta del trámite"' : '';
                return '<div class="pt-proceso-fila"' + abre + '>' + puntoSemaforo(colorVencimiento(m.c, m.p), 12) +
                    '<div class="pt-proceso-fila__txt"><strong>' + escaparHtml(m.p.nombre) + '</strong>' +
                    '<span class="pt-nota">' + escaparHtml(m.c.nombre) +
                    ' · plazo de ' + cuantos(m.p.dias, 'día hábil', 'días hábiles') + ' · vence el ' + escaparHtml(formatoFechaDia(m.p.fechaVencimiento)) +
                    (m.p.completado ? ' · completado' + (m.p.fechaCompletado ? ' el ' + escaparHtml(m.p.fechaCompletado) : '') : '') +
                    escaparHtml(responsables) + '</span></div>' +
                    '<div class="pt-celda-acciones">' +
                        (vencido ? '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="abrir-carpeta" data-id="' + m.c.id + '">Abrir carpeta</button> ' : '') +
                        (ES_ADMIN ? '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-proceso" data-id="' + m.p.id + '">Editar</button>' : '') +
                    '</div>' +
                    '</div>';
            }
            if (m.tipo === 'tramite') {
                const responsables = ES_SUPERVISION
                    ? ' · Operador responsable: ' + ((m.c.operadores || []).map(o => nombreDe(o)).join(', ') || 'sin asignar')
                    : '';
                return '<div class="pt-proceso-fila">' + puntoSemaforo(colorMarca(m), 12) +
                    '<div class="pt-proceso-fila__txt"><strong>Vencimiento del trámite completo (' + (m.c.diasHabilesTramite || 60) + ' días hábiles)</strong>' +
                    '<span class="pt-nota">' + escaparHtml(m.c.nombre) + escaparHtml(responsables) + '</span></div></div>';
            }
            // recordatorio privado
            return '<div class="pt-proceso-fila">' + puntoSemaforo('pausado', 12) +
                '<div class="pt-proceso-fila__txt"><strong>Recordatorio' + (m.fin ? ' (termina)' : '') + '</strong>' +
                '<span class="pt-nota">' + escaparHtml(m.r.mensaje) +
                (m.r.carpetaNombre ? ' · ' + escaparHtml(m.r.carpetaNombre) : '') + '</span></div></div>';
        };
        listaDia = '<div class="pt-calv-dia-detalle"><h3>' + escaparHtml(formatoFechaDia(_diaCalVencSel)) + '</h3>' +
            (marcas.length === 0
                ? '<p class="pt-nota">No hay vencimientos este día.</p>'
                : marcas.map(filaDia).join('')) +
            '</div>';
    }

    // Filtros (admin/monitor)
    let filtros = '';
    if (ES_SUPERVISION) {
        const operadoresUnicos = [...new Set(_estadosCarpetas.flatMap(c => c.operadores || []))];
        filtros =
            '<label class="pt-nota">Operador: <select id="filtro-cal-operador">' +
                '<option value="">Todos (panorama general)</option>' +
                operadoresUnicos.map(o => '<option value="' + escaparHtml(o) + '"' +
                    (_filtroCalOperador === o ? ' selected' : '') + '>' + escaparHtml(nombreDe(o)) + '</option>').join('') +
            '</select></label>' +
            '<label class="pt-nota">Trámite: <select id="filtro-cal-tramite">' +
                '<option value="">Todos</option>' +
                _estadosCarpetas
                    .filter(c => !_filtroCalOperador || (c.operadores || []).includes(_filtroCalOperador))
                    .map(c => '<option value="' + c.id + '"' +
                        (String(_filtroCalTramite) === String(c.id) ? ' selected' : '') + '>' + escaparHtml(c.nombre) + '</option>').join('') +
            '</select></label>' +
            ((_filtroCalOperador || _filtroCalTramite)
                ? ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-limpiar">Quitar filtros</button>' : '');
    }
    // Filtros en la cabecera, junto a Actualizar
    const cajaFiltros = document.getElementById('cal-venc-filtros');
    if (cajaFiltros) cajaFiltros.innerHTML = filtros;

    const leyenda =
        '<div class="pt-calv-leyenda">' +
            '<span>' + puntoSemaforo('rojo', 8) + ' Vencido</span>' +
            '<span>' + puntoSemaforo('naranja', 8) + ' Por vencer</span>' +
            '<span>' + puntoSemaforo('verde', 8) + ' Completado</span>' +
            '<span>' + puntoSemaforo('pausado', 8) + ' Recordatorio</span>' +
        '</div>';

    cont.innerHTML =
        '<div class="pt-cal-marco">' +
            '<div class="pt-calv-tarjeta">' +
                '<div class="pt-calv-tarjeta__cab">' +
                    '<div class="pt-cal__barra">' +
                        '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="-1" aria-label="Mes anterior">‹</button>' +
                        '<strong>' + MESES[mes].charAt(0).toUpperCase() + MESES[mes].slice(1) + ' ' + anio + '</strong>' +
                        '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-venc-mes" data-delta="1" aria-label="Mes siguiente">›</button>' +
                    '</div>' +
                    leyenda +
                '</div>' +
                '<div class="pt-calv__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
                '<div class="pt-calv__rejilla">' + celdas + '</div>' +
                '<p class="pt-nota" style="margin-top:1rem;">Los días grises son fines de semana o festivos colombianos. Haz clic en un día para ver sus vencimientos.</p>' +
                listaDia +
            '</div>' +
            agendaProximos(carpetasCal, { rojos: rojos, naranjas: naranjas, verdes: verdes }) +
        '</div>';

    // listeners de los filtros (se recrean en cada render)
    const selOp = document.getElementById('filtro-cal-operador');
    if (selOp) selOp.addEventListener('change', () => {
        _filtroCalOperador = selOp.value;
        _filtroCalTramite = '';   // al cambiar de operador se reinicia el trámite
        _diaCalVencSel = null;
        pintarCalendarioVenc();
    });
    const selTr = document.getElementById('filtro-cal-tramite');
    if (selTr) selTr.addEventListener('change', () => {
        _filtroCalTramite = selTr.value;
        _diaCalVencSel = null;
        pintarCalendarioVenc();
    });
}

/* Mes siguiente o anterior. */
function cambiarMesCalVenc(delta) {
    if (!_mesCalVenc) return;
    _mesCalVenc = new Date(_mesCalVenc.getFullYear(), _mesCalVenc.getMonth() + Number(delta || 0), 1);
    _diaCalVencSel = null;
    pintarCalendarioVenc();
}

/* ============ CHATS DEL TRÁMITE ============
   Cliente: el suyo. Acreedor: el suyo. Operador y admin: ambos. Lo valida RLS. */
const CANALES_CHAT = { cliente: 'Cliente ↔ operador', acreedor: 'Acreedor ↔ operador' };
let _canalChat = null;

/* Canales según el rol. El monitor no entra a ninguno (también cerrado
   en la base: migracion_monitor_sin_chat). */
function canalesAccesibles() {
    if (ES_MONITOR) return [];
    if (ES_PERSONAL) return ['cliente', 'acreedor'];
    if (sesion.rol === 'cliente') return ['cliente'];
    if (sesion.rol === 'acreedor') return ['acreedor'];
    return [];
}

/* Chat anclado en la esquina; minimizado es burbuja con contador. */
let _chatCarpetaMin = true;      // minimizado
let _acreedorDestino = '';       // '' = todos; uuid = un acreedor

/* Panel, burbuja o nada (solo dentro de una carpeta). */
function pintarVisibilidadChatCarpeta(hayCanales) {
    const seccion = document.getElementById('pt-chats');
    const burbuja = document.getElementById('chat-carpeta-burbuja');
    const boton = document.getElementById('boton-chat-carpeta');
    const enCarpeta = carpetaAbierta && !document.getElementById('vista-carpeta').hidden;
    if (!hayCanales || !enCarpeta) { seccion.hidden = true; burbuja.hidden = true; boton.hidden = true; return; }
    seccion.hidden = _chatCarpetaMin;
    burbuja.hidden = !_chatCarpetaMin;
    // En el computador es un botón de la carpeta
    boton.hidden = false;
    boton.classList.toggle('pt-boton--primario', !_chatCarpetaMin);
}

/* Abre el chat. */
function abrirChatCarpeta() {
    // Un panel a la vez
    if (!document.getElementById('soporte-panel').hidden) minimizarSoporte();
    _chatCarpetaMin = false;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
    pintarMensajes();
}

/* Minimiza el chat. */
function minimizarChatCarpeta() {
    _chatCarpetaMin = true;
    pintarVisibilidadChatCarpeta(canalesAccesibles().length > 0);
}

/* Pestañas de canales y el activo. */
async function pintarChats() {
    const seccion = document.getElementById('pt-chats');
    if (!seccion || !carpetaAbierta) return;
    const canales = canalesAccesibles();
    pintarVisibilidadChatCarpeta(canales.length > 0);
    if (canales.length === 0) return;
    if (!canales.includes(_canalChat)) _canalChat = canales[0];
    await pintarSelectorAcreedor();

    const tabs = document.getElementById('chat-tabs');
    tabs.hidden = canales.length < 2;   // con un canal no hace falta barra
    tabs.innerHTML = canales.map(c =>
        '<button class="' + (c === _canalChat ? 'activa' : '') + '" data-accion="chat-canal" data-canal="' + c + '">' +
        escaparHtml(CANALES_CHAT[c]) + '</button>').join('');
    pintarBadgesChats();   // no leídos por canal

    await pintarMensajes();
}

/* Cambia de canal y descarta el adjunto pendiente. */
function cambiarCanal(canal) {
    if (!canalesAccesibles().includes(canal)) return;
    quitarAdjuntoChat(); // el adjunto no salta de canal
    _canalChat = canal;
    _acreedorDestino = '';
    document.querySelectorAll('#chat-tabs button').forEach(b =>
        b.classList.toggle('activa', b.dataset.canal === canal));
    pintarSelectorAcreedor().then(() => pintarMensajes());
}

/* Selector de acreedor (personal, canal acreedor). */
async function pintarSelectorAcreedor() {
    const cont = document.getElementById('chat-destinatario');
    if (!cont) return;
    const gestiona = carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta);
    if (!gestiona || _canalChat !== 'acreedor') { cont.hidden = true; cont.innerHTML = ''; return; }
    try {
        if (!_asignadosCache.length || _asignadosCache._carpeta !== carpetaAbierta.id) {
            _asignadosCache = await asignadosDeCarpeta(carpetaAbierta.id);
            _asignadosCache._carpeta = carpetaAbierta.id;
        }
    } catch (e) { cont.hidden = true; return; }
    const acreedores = _asignadosCache.filter(p => p.rol === 'acreedor');
    if (acreedores.length === 0) { cont.hidden = true; cont.innerHTML = ''; return; }
    cont.hidden = false;
    cont.innerHTML = '<label class="pt-nota">Conversar con: ' +
        '<select id="select-acreedor-destino">' +
        '<option value="">Todos los acreedores</option>' +
        acreedores.map(a => '<option value="' + escaparHtml(a.id) + '"' +
            (_acreedorDestino === a.id ? ' selected' : '') + '>' + escaparHtml(a.nombre) + '</option>').join('') +
        '</select></label>';
    document.getElementById('select-acreedor-destino').addEventListener('change', (e) => {
        _acreedorDestino = e.target.value;
        pintarMensajes();
    });
}

/* Mensajes del canal activo; quedan leídos. */
async function pintarMensajes() {
    if (!carpetaAbierta || !_canalChat) return;
    const cont = document.getElementById('chat-mensajes');
    let mensajes = await mensajesListar(carpetaAbierta.id, _canalChat);
    // Hilo con un acreedor: lo suyo, lo que va para él y lo "para todos"
    if (_canalChat === 'acreedor' && _acreedorDestino) {
        mensajes = mensajes.filter(m =>
            m.perfilId === _acreedorDestino ||
            m.destinatarioId === _acreedorDestino ||
            (!m.destinatarioId && ['operador', 'administrador'].includes(m.rol)));
    }
    cont.innerHTML = mensajes.length
        ? htmlChat(mensajes.map(m => ({
            autor: m.autorUsuario || m.autorNombre,
            mio: !!(m.autorUsuario && m.autorUsuario === sesion.usuario),
            nombre: m.autorNombre || m.autorUsuario || '—',
            rol: ETIQUETAS_ROL[m.rol] || m.rol || '',
            fecha: m.fecha,
            cuerpo: cuerpoMensaje(m, 'descargar-adjunto')
        })))
        : '<p class="pt-chat-vacio">Aún no hay mensajes en este chat.</p>';
    cont.scrollTop = cont.scrollHeight;
    // Quedan leídos (lo valida el servidor)
    if (typeof marcarLeidosCanal === 'function') {
        marcarLeidosCanal(carpetaAbierta.id, _canalChat)
            .then(() => refrescarNoLeidos())
            .catch(() => {});
    }
}

/* ============ MENSAJES DE LOS CHATS ============
   Separador por día y hora corta; el nombre solo cuando cambia quien escribe. */
function horaChat(marca) {
    return new Date(marca).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
}
function diaChat(marca) {
    const f = new Date(marca), hoy = new Date(), ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);
    if (f.toDateString() === hoy.toDateString()) return 'Hoy';
    if (f.toDateString() === ayer.toDateString()) return 'Ayer';
    const t = f.toLocaleDateString('es-CO', f.getFullYear() === hoy.getFullYear()
        ? { weekday: 'long', day: 'numeric', month: 'long' }
        : { day: 'numeric', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/* Texto y adjunto de un mensaje. */
function cuerpoMensaje(m, accionDescarga) {
    let adjunto = '';
    if (m.archivoNombre) {
        adjunto = '<div class="pt-chat-msg__adjunto">' +
            '<span class="pt-icono-archivo">' + iconoArchivo(extensionDe(m.archivoNombre)) + '</span>' +
            '<span class="pt-chat-msg__adjunto-info">' + escaparHtml(m.archivoNombre) +
                '<small>' + formatoTamano(m.archivoTamano) + '</small></span>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="' + accionDescarga + '" data-id="' + m.id + '">Descargar</button>' +
            '</div>';
    }
    return (m.texto ? '<div class="pt-chat-msg__texto">' + escaparHtml(m.texto) + '</div>' : '') + adjunto;
}

/* mensajes: [{ autor, mio, nombre, rol, fecha, cuerpo }] */
function htmlChat(mensajes) {
    let html = '', diaPrevio = '', autorPrevio = null;
    for (const m of mensajes) {
        const dia = diaChat(m.fecha);
        if (dia !== diaPrevio) {
            html += '<div class="pt-chat-dia"><span>' + escaparHtml(dia) + '</span></div>';
            diaPrevio = dia;
            autorPrevio = null;
        }
        const seguido = autorPrevio === m.autor;
        autorPrevio = m.autor;
        html += '<div class="pt-chat-msg' + (m.mio ? ' pt-chat-msg--mio' : '') + (seguido ? ' pt-chat-msg--seguido' : '') + '">' +
            '<div class="pt-chat-msg__meta">' +
                (!m.mio && !seguido
                    ? '<strong>' + escaparHtml(m.nombre) + '</strong>' + (m.rol ? '<span>' + escaparHtml(m.rol) + '</span>' : '')
                    : '') +
                '<span class="pt-chat-msg__hora" title="' + escaparHtml(formatoFecha(m.fecha)) + '">' + horaChat(m.fecha) + '</span>' +
            '</div>' + m.cuerpo + '</div>';
    }
    return html;
}

/* ---- Adjunto pendiente ---- */
let _adjuntoChat = null;

/* Adjunto pendiente, revisando tipo y tamaño. */
function ponerAdjuntoChat(archivo) {
    if (!archivo) return;
    const ext = extensionDe(archivo.name);
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
        avisar('Tipo de archivo no permitido: ' + archivo.name, 'error');
        return;
    }
    if (archivo.size > TAMANO_MAXIMO) {
        avisar('El archivo supera ' + TAMANO_MAXIMO_TXT + ': ' + archivo.name, 'error');
        return;
    }
    _adjuntoChat = archivo;
    const chip = document.getElementById('chat-adjunto-chip');
    document.getElementById('chat-adjunto-nombre').textContent =
        archivo.name + ' (' + formatoTamano(archivo.size) + ')';
    chip.hidden = false;
}

/* Quita el adjunto pendiente. */
function quitarAdjuntoChat() {
    _adjuntoChat = null;
    const entrada = document.getElementById('chat-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('chat-adjunto-chip');
    if (chip) chip.hidden = true;
}

/* Envía el mensaje con su adjunto. El monitor no escribe. */
async function enviarMensaje(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !_canalChat || ES_MONITOR) return; // el monitor no escribe
    const campo = document.getElementById('mensaje-input');
    const texto = campo.value.trim();
    const archivo = _adjuntoChat;
    if (!texto && !archivo) return; // vacío y sin adjunto
    const botonEnviar = document.querySelector('#form-mensaje button[type="submit"]');
    if (botonEnviar) botonEnviar.disabled = true;
    // Personal en canal acreedor: va al acreedor elegido ('' = todos).
    const destinatario = (_canalChat === 'acreedor' && puedeGestionarCarpeta(carpetaAbierta))
        ? (_acreedorDestino || null) : null;
    try {
        await mensajesGuardar(carpetaAbierta.id, _canalChat, texto, archivo || null, destinatario);
        campo.value = '';
        quitarAdjuntoChat();
        registrarActividad('mensaje-chat', CANALES_CHAT[_canalChat] + ' · ' + carpetaAbierta.nombre +
            (archivo ? ' · adjunto: ' + archivo.name : ''), carpetaAbierta.id);
        await pintarMensajes();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo enviar el mensaje.', 'error');
    } finally {
        if (botonEnviar) botonEnviar.disabled = false;
    }
}

/* Descarga el adjunto (local: blob; nube: Storage con RLS). */
async function descargarAdjuntoDeChat(mensajeId) {
    try {
        const adj = await descargarAdjuntoChat(mensajeId);
        if (!adj || !adj.blob) return;
        const url = URL.createObjectURL(adj.blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = adj.nombre || 'adjunto';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('descargar-archivo', (adj.nombre || 'adjunto') + ' (chat)' +
            (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), carpetaAbierta && carpetaAbierta.id);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo descargar el adjunto.', 'error');
    }
}

/* ============ CELULAR: BURBUJAS QUE SE MUEVEN Y TABLAS COMO TARJETAS ============ */
/* Bajo 900 px el menú es cajón y los chats son burbujas (adaptable.css). */
const esCelular = () => window.matchMedia('(max-width: 900px)').matches;

/* Tras soltar una burbuja, el clic que manda el navegador no cuenta:
   caería sobre el chat recién abierto (clic fantasma). */
let _ignorarClicHasta = 0;
document.addEventListener('click', (e) => {
    if (e.isTrusted && Date.now() < _ignorarClicHasta) { e.stopPropagation(); e.preventDefault(); }
}, true);

/* Burbuja que se arrastra con el dedo, se pega al borde más cercano y
   recuerda dónde quedó. Un toque sin arrastrar abre como siempre. */
function hacerArrastrable(el, clave) {
    if (!el || el._arrastrable) return;
    el._arrastrable = true;
    const MARGEN = 12;
    let inicio = null, movido = false;
    const limites = () => {
        const cab = document.querySelector('.pt-cabecera');
        return {
            arriba: Math.max(MARGEN, cab ? cab.getBoundingClientRect().bottom + 8 : MARGEN),
            abajo: window.innerHeight - el.offsetHeight - MARGEN,
            derecha: window.innerWidth - el.offsetWidth - MARGEN
        };
    };
    const colocar = (lado, y) => {
        const l = limites();
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = (lado === 'izq' ? MARGEN : l.derecha) + 'px';
        el.style.top = Math.max(l.arriba, Math.min(y, l.abajo)) + 'px';
    };
    const aplicar = () => {
        if (!esCelular()) { el.style.left = el.style.top = el.style.right = el.style.bottom = ''; return; }
        if (el.hidden) return;
        let guardada = null;
        try { guardada = JSON.parse(localStorage.getItem(clave) || 'null'); } catch (e) { /* nada */ }
        if (guardada) colocar(guardada.lado, guardada.y * window.innerHeight);
    };
    el.addEventListener('pointerdown', (e) => {
        if (!esCelular() || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const r = el.getBoundingClientRect();
        inicio = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
        movido = false;
    });
    el.addEventListener('pointermove', (e) => {
        if (!inicio || e.pointerId !== inicio.id) return;
        if (!movido && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) < 8) return;
        if (!movido) {
            movido = true;
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* nada */ }
            el.classList.add('pt-burbuja--arrastrando');
        }
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = (e.clientX - inicio.dx) + 'px';
        el.style.top = (e.clientY - inicio.dy) + 'px';
        e.preventDefault();
    });
    const soltar = (e) => {
        if (!inicio || e.pointerId !== inicio.id) return;
        inicio = null;
        if (!movido) {
            // Toque sin mover: abre aquí mismo; el clic que el navegador
            // manda después (si lo manda) se ignora
            if (e.type === 'pointerup') {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                _ignorarClicHasta = Date.now() + 450;
            }
            return;
        }
        el.classList.remove('pt-burbuja--arrastrando');
        const r = el.getBoundingClientRect();
        const lado = r.left + r.width / 2 < window.innerWidth / 2 ? 'izq' : 'der';
        el.classList.add('pt-burbuja--soltando');
        colocar(lado, r.top);
        setTimeout(() => el.classList.remove('pt-burbuja--soltando'), 260);
        try { localStorage.setItem(clave, JSON.stringify({ lado, y: parseFloat(el.style.top) / window.innerHeight })); } catch (err) { /* nada */ }
        // El clic que llega al soltar no abre el chat
        _ignorarClicHasta = Date.now() + 450;
    };
    el.addEventListener('pointerup', soltar);
    el.addEventListener('pointercancel', soltar);
    window.addEventListener('resize', aplicar);
    // Al volver a verse, en su sitio
    new MutationObserver(aplicar).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    aplicar();
}

/* Cada celda recibe el título de su columna (data-etiqueta) para verse
   como tarjeta en pantallas angostas. Si la fila trae menos celdas, las
   columnas ocultas no cuentan. */
function etiquetarTabla(tabla) {
    const todas = [...tabla.querySelectorAll('thead th')];
    if (!todas.length) return;
    const visibles = todas.filter(th => !th.hidden);
    tabla.querySelectorAll('tbody tr').forEach(tr => {
        const celdas = [...tr.children];
        const ancho = celdas.reduce((s, td) => s + Number(td.getAttribute('colspan') || 1), 0);
        const titulos = (ancho === visibles.length ? visibles : todas).map(th => th.textContent.trim());
        let i = 0;
        for (const td of celdas) {
            const span = Number(td.getAttribute('colspan') || 1);
            if (span === 1 && titulos[i]) td.setAttribute('data-etiqueta', titulos[i]);
            i += span;
        }
    });
}
function vigilarTablas() {
    document.querySelectorAll('table.pt-tabla').forEach(etiquetarTabla);
    new MutationObserver((cambios) => {
        const tablas = new Set();
        for (const c of cambios) {
            const t = c.target.closest ? c.target.closest('table.pt-tabla') : null;
            if (t) tablas.add(t);
        }
        tablas.forEach(etiquetarTabla);
    }).observe(document.querySelector('.pt-contenido') || document.body, { childList: true, subtree: true });
}

/* ============ CHAT DE SOPORTE (admin, operadores y monitores) ============
   Burbuja global. El admin ve a operadores y monitores activos; cada uno
   de ellos, su hilo con la administración. Permisos: puede_soporte. */
let _soporteOperador = null;          // hilo abierto: { id, nombre }
let _soporteNoLeidosPorOperador = {}; // operadorId → no leídos
let _chatsNoLeidosCache = [];         // no leídos de los chats de carpeta

/* Soporte: admin, operadores y monitores. */
function soporteDisponible() { return ES_ADMIN || ES_OPERADOR || ES_MONITOR; }

/* Burbuja de soporte y conteo de no leídos. Se llama antes de elegir
   notaría y otra vez al arrancar; el guardia evita suscribirse dos veces. */
let _soporteIniciado = false;

async function iniciarSoporte() {
    if (_soporteIniciado) return;
    _soporteIniciado = true;
    if (soporteDisponible()) {
        document.getElementById('soporte-burbuja').hidden = false;
        document.getElementById('cab-soporte').hidden = false;
        document.body.classList.add('pt-con-soporte');
    }
    hacerArrastrable(document.getElementById('soporte-burbuja'), 'portal_burbuja_soporte');
    hacerArrastrable(document.getElementById('chat-carpeta-burbuja'), 'portal_burbuja_tramite');
    await refrescarNoLeidos();
    // Mensaje nuevo: sonido, parpadeo y contadores; si el chat está abierto, repinta.
    suscribirMensajesNuevos(async (tipo, fila) => {
        const autor = tipo === 'soporte' ? fila.autor_id : fila.perfil_id;
        if (autor === sesion._id) return;   // mis mensajes no avisan
        // El monitor también recibe los hilos ajenos (RLS): solo suena el suyo
        if (tipo === 'soporte' && !ES_ADMIN && fila.operador_id !== sesion._id) return;
        sonarAviso();
        parpadearBurbuja();
        if (tipo === 'soporte' && _soporteOperador && !document.getElementById('soporte-panel').hidden &&
            fila.operador_id === _soporteOperador.id) {
            await pintarSoporteMensajes();
            await marcarLeidosSoporte(_soporteOperador.id).catch(() => {});
        }
        if (tipo === 'carpeta' && carpetaAbierta && fila.carpeta_id === carpetaAbierta.id &&
            fila.canal === _canalChat && !document.getElementById('vista-carpeta').hidden) {
            await pintarMensajes();
        }
        await refrescarNoLeidos();
    });
    // Llamadas entrantes (solo las inicia el admin)
    suscribirLlamadasEntrantes((fila) => recibirLlamada(fila), (fila) => cambioDeLlamada(fila));
}

/* ============ SONIDOS ============
   Cuatro avisos con WebAudio, distintos para saber qué pasó sin mirar:
   mensaje       una nota
   notificacion  dos notas cortas subiendo
   subida        acorde de tres notas
   llamada       timbre de dos notas repetidas
   Volumen bajo (0.05 a 0.15): es una oficina. */
const TONOS = {
    mensaje:      { notas: [[880, 0, 0.35]],                                 vol: 0.14 },
    notificacion: { notas: [[660, 0, 0.12], [990, 0.11, 0.22]],              vol: 0.11 },
    subida:       { notas: [[523, 0, 0.14], [659, 0.1, 0.14], [784, 0.2, 0.3]], vol: 0.10 },
    llamada:      { notas: [[740, 0, 0.3], [590, 0.32, 0.3],
                            [740, 0.8, 0.3], [590, 1.12, 0.3]],              vol: 0.15 }
};

let _ctxAudio = null;

/* Un AudioContext para todo (el navegador permite unos seis). */
function contextoAudio() {
    try {
        if (!_ctxAudio) _ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
        // El navegador lo suspende hasta que se toca algo; ya hubo sesión, se reanuda.
        if (_ctxAudio.state === 'suspended') _ctxAudio.resume().catch(() => {});
        return _ctxAudio;
    } catch (e) { return null; }
}

function sonar(tipo) {
    const t = TONOS[tipo] || TONOS.mensaje;
    const ctx = contextoAudio();
    if (!ctx) return;   // sin audio funciona igual
    try {
        for (const [hz, desde, dura] of t.notas) {
            const osc = ctx.createOscillator();
            const gan = ctx.createGain();
            osc.type = 'sine';
            osc.connect(gan); gan.connect(ctx.destination);
            osc.frequency.value = hz;
            const t0 = ctx.currentTime + desde;
            // Entrada suave, sin chasquido
            gan.gain.setValueAtTime(0.0001, t0);
            gan.gain.exponentialRampToValueAtTime(t.vol, t0 + 0.012);
            gan.gain.exponentialRampToValueAtTime(0.0001, t0 + dura);
            osc.start(t0); osc.stop(t0 + dura + 0.02);
        }
    } catch (e) { /* sin audio no pasa nada */ }
}

/* Aviso de mensaje nuevo. */
function sonarAviso() { sonar('mensaje'); }

/* Parpadeo de la burbuja (celular) o del botón de la cabecera (computador) con algo sin leer. */
function parpadearBurbuja() {
    const b = document.getElementById('soporte-burbuja');
    if (b && !b.hidden) {
        b.classList.add('pt-soporte-burbuja--alerta');
        setTimeout(() => b.classList.remove('pt-soporte-burbuja--alerta'), 6000);
    }
    const c = document.getElementById('cab-soporte');
    if (c && !c.hidden) {
        c.classList.add('pt-cab-soporte--alerta');
        setTimeout(() => c.classList.remove('pt-cab-soporte--alerta'), 6000);
    }
}

/* Contadores de no leídos (chat y soporte). */
async function refrescarNoLeidos() {
    try {
        const [sop, chats] = await Promise.all([
            soporteDisponible() ? soporteNoLeidos() : Promise.resolve([]),
            chatsNoLeidos()
        ]);
        _chatsNoLeidosCache = chats || [];
        _soporteNoLeidosPorOperador = {};
        let total = 0;
        for (const f of (sop || [])) { _soporteNoLeidosPorOperador[f.operadorId] = f.noLeidos; total += f.noLeidos; }
        for (const id of ['soporte-burbuja-contador', 'cab-soporte-contador']) {
            const cont = document.getElementById(id);
            if (cont) { cont.hidden = total === 0; cont.textContent = total > 99 ? '99+' : String(total); }
        }
        pintarBadgesChats();
        if (_soporteOperador === null && ES_ADMIN && !document.getElementById('soporte-lista').hidden) {
            await pintarSoporteLista();   // refresca los badges
        }
    } catch (e) { /* los contadores no rompen nada */ }
}

/* No leídos de un hilo. */
function noLeidosDe(carpetaId, canal) {
    const f = _chatsNoLeidosCache.find(x => x.carpetaId === carpetaId && x.canal === canal);
    return f ? f.noLeidos : 0;
}

/* No leídos por pestaña del chat de la carpeta */
function pintarBadgesChats() {
    document.querySelectorAll('#chat-tabs button').forEach(b => {
        const n = carpetaAbierta ? noLeidosDe(carpetaAbierta.id, b.dataset.canal) : 0;
        let badge = b.querySelector('.pt-badge-noleidos');
        if (n > 0) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'pt-badge-noleidos'; b.appendChild(badge); }
            badge.textContent = n > 99 ? '99+' : String(n);
        } else if (badge) badge.remove();
    });
    // Contador de la burbuja (suma de canales)
    if (carpetaAbierta) {
        const total = canalesAccesibles().reduce((s, c) => s + noLeidosDe(carpetaAbierta.id, c), 0);
        for (const id of ['chat-carpeta-contador', 'boton-chat-carpeta-contador']) {
            const cont = document.getElementById(id);
            if (cont) { cont.hidden = total === 0; cont.textContent = total > 99 ? '99+' : String(total); }
        }
    }
}

/* Abre el soporte con la lista de hilos. */
async function abrirSoporte() {
    if (!soporteDisponible()) return;
    // En llamada se abre el chat igual; la llamada sigue en la barra de arriba
    // Un panel a la vez
    if (!document.getElementById('pt-chats').hidden) minimizarChatCarpeta();
    document.getElementById('soporte-panel').hidden = false;
    document.getElementById('soporte-burbuja').hidden = true;
    if (!ES_ADMIN) {
        // Operador y monitor van directo a su hilo
        _soporteOperador = { id: sesion._id, nombre: 'Administración' };
        await abrirHiloSoporte(_soporteOperador);
    } else if (_soporteOperador) {
        await abrirHiloSoporte(_soporteOperador);
    } else {
        await pintarSoporteLista();
    }
}

/* Minimiza el soporte. */
function minimizarSoporte() {
    document.getElementById('soporte-panel').hidden = true;
    if (soporteDisponible()) document.getElementById('soporte-burbuja').hidden = false;
}

/* Quién es en la cabecera del chat de soporte. */
function pintarCabeceraSoporte(titulo, sub, conAvatar, conVolver) {
    document.getElementById('soporte-titulo').textContent = titulo;
    document.getElementById('soporte-sub').textContent = sub || '';
    const avatar = document.getElementById('soporte-avatar');
    avatar.hidden = !conAvatar;
    avatar.textContent = conAvatar ? inicialesDe(titulo) : '';
    document.getElementById('soporte-boton-volver').hidden = !conVolver;
}

/* Abre o cierra el soporte (botón de la cabecera). */
function alternarSoporte() {
    if (document.getElementById('soporte-panel').hidden) abrirSoporte();
    else minimizarSoporte();
}

/* Operadores y monitores activos (admin) */
async function pintarSoporteLista() {
    _soporteOperador = null;
    pintarCabeceraSoporte('Soporte', 'Operadores y monitores', false, false);
    document.getElementById('soporte-boton-llamar').hidden = true;
    document.getElementById('soporte-mensajes').hidden = true;
    document.getElementById('form-soporte').hidden = true;
    const lista = document.getElementById('soporte-lista');
    lista.hidden = false;
    lista.innerHTML = esqueletoLista(3);
    let operadores = [];
    try { operadores = await soporteOperadores(); } catch (e) {
        lista.innerHTML = '<p class="pt-nota">' + escaparHtml(e.message || 'No se pudo cargar la lista.') + '</p>';
        return;
    }
    lista.innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores ni monitores activos todavía.</p>'
        : operadores.map(o => {
            const n = _soporteNoLeidosPorOperador[o._id] || 0;
            return '<button type="button" class="pt-soporte-lista__item" data-accion="soporte-elegir" ' +
                'data-uuid="' + escaparHtml(o._id) + '" data-nombre="' + escaparHtml(o.nombre) + '" ' +
                'data-rol="' + escaparHtml(o.rol) + '" data-usuario="' + escaparHtml(o.usuario) + '">' +
                '<span class="pt-avatar pt-chat-avatar">' + escaparHtml(inicialesDe(o.nombre)) + '</span>' +
                '<span class="pt-soporte-lista__txt"><strong>' + escaparHtml(o.nombre) + '</strong>' +
                '<small>' + escaparHtml(ETIQUETAS_ROL[o.rol] || o.rol) + ' · ' + escaparHtml(o.usuario) + '</small></span>' +
                (n > 0 ? '<span class="pt-badge-noleidos">' + n + '</span>' : '') +
                '</button>';
        }).join('');
}

/* Abre un hilo y lo marca leído. */
async function abrirHiloSoporte(operador) {
    _soporteOperador = operador;
    if (ES_ADMIN) {
        pintarCabeceraSoporte(operador.nombre,
            [ETIQUETAS_ROL[operador.rol] || operador.rol, operador.usuario].filter(Boolean).join(' · '), true, true);
    } else {
        pintarCabeceraSoporte('Administración', 'Soporte del portal', true, false);
    }
    document.getElementById('soporte-lista').hidden = true;
    document.getElementById('soporte-mensajes').hidden = false;
    document.getElementById('form-soporte').hidden = false;
    // Solo el admin llama; operadores y monitores escriben
    const llamar = document.getElementById('soporte-boton-llamar');
    llamar.hidden = !ES_ADMIN;
    llamar.title = 'Llamar a ' + operador.nombre;
    await pintarSoporteMensajes();
    await marcarLeidosSoporte(operador.id).catch(() => {});
    await refrescarNoLeidos();
}

/* Mensajes del hilo abierto. */
async function pintarSoporteMensajes() {
    if (!_soporteOperador) return;
    const cont = document.getElementById('soporte-mensajes');
    let mensajes = [];
    try { mensajes = await soporteMensajes(_soporteOperador.id); } catch (e) {
        cont.innerHTML = '<p class="pt-chat-vacio">' + escaparHtml(e.message || 'No se pudo cargar el chat.') + '</p>';
        return;
    }
    // En el hilo el rol ya está arriba: solo el nombre
    cont.innerHTML = mensajes.length
        ? htmlChat(mensajes.map(m => ({
            autor: m.autorId,
            mio: m.autorId === sesion._id,
            nombre: m.autorNombre || '—',
            rol: '',
            fecha: m.fecha,
            cuerpo: cuerpoMensaje(m, 'descargar-adjunto-soporte')
        })))
        : '<p class="pt-chat-vacio">Aún no hay mensajes con ' + escaparHtml(_soporteOperador.nombre) + '.</p>';
    cont.scrollTop = cont.scrollHeight;
}

/* ---- Adjunto del soporte ---- */
let _adjuntoSoporte = null;

/* Adjunto pendiente del soporte. */
function ponerAdjuntoSoporte(archivo) {
    if (!archivo) return;
    const ext = extensionDe(archivo.name);
    if (!EXTENSIONES_PERMITIDAS.includes(ext)) { avisar('Tipo de archivo no permitido: ' + archivo.name, 'error'); return; }
    // El tope sale de TAMANO_MAXIMO para que el mensaje no se separe del límite real.
    if (archivo.size > TAMANO_MAXIMO) {
        avisar('El archivo supera ' + TAMANO_MAXIMO_TXT + ': ' + archivo.name, 'error');
        return;
    }
    _adjuntoSoporte = archivo;
    document.getElementById('soporte-adjunto-nombre').textContent = archivo.name + ' (' + formatoTamano(archivo.size) + ')';
    document.getElementById('soporte-adjunto-chip').hidden = false;
}

/* Quita el adjunto pendiente. */
function quitarAdjuntoSoporte() {
    _adjuntoSoporte = null;
    const entrada = document.getElementById('soporte-adjunto');
    if (entrada) entrada.value = '';
    const chip = document.getElementById('soporte-adjunto-chip');
    if (chip) chip.hidden = true;
}

/* Descarga un adjunto de soporte. */
async function descargarAdjuntoDeSoporte(mensajeId) {
    try {
        const adj = await descargarAdjuntoSoporte(mensajeId);
        if (!adj || !adj.blob) return;
        const url = URL.createObjectURL(adj.blob);
        const enlace = document.createElement('a');
        enlace.href = url; enlace.download = adj.nombre || 'adjunto';
        document.body.appendChild(enlace); enlace.click(); enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo descargar el adjunto.', 'error');
    }
}

/* Envía el mensaje de soporte. */
async function enviarSoporte(evento) {
    evento.preventDefault();
    if (!_soporteOperador) return;
    const campo = document.getElementById('soporte-input');
    const texto = campo.value.trim();
    const archivo = _adjuntoSoporte;
    if (!texto && !archivo) return; // nada que enviar
    const boton = document.querySelector('#form-soporte button[type="submit"]');
    if (boton) boton.disabled = true;
    try {
        await soporteEnviar(_soporteOperador.id, texto, archivo || null);
        campo.value = '';
        quitarAdjuntoSoporte();
        await pintarSoporteMensajes();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo enviar el mensaje.', 'error');
    } finally {
        if (boton) boton.disabled = false;
    }
}

/* ============ LLAMADAS DE SOPORTE (WebRTC, las inicia el admin) ============
   El admin crea la llamada (el servidor valida), el otro la recibe por
   Realtime y acepta, y negocian por un canal de señalización.
   Silenciar: track.enabled (mic) y audio.muted (altavoz). */
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let _llamada = null; // { id, pc, stream, canal, soyIniciador, entrante }

/* Pide el micrófono; si lo niegan, no hay llamada. */
async function obtenerMicrofono() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        avisar('Este navegador no permite llamadas (sin acceso al micrófono).', 'error');
        throw new Error('sin getUserMedia');
    }
    try {
        // Cancelación de eco, ruido y ganancia del navegador activados.
        return await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
    } catch (e) {
        avisar('El portal necesita permiso del MICRÓFONO para la llamada. ' +
            'Haz clic en el candado de la barra del navegador, permite el micrófono y vuelve a intentar.', 'error');
        throw e;
    }
}

/* Conexión de voz y audio remoto. */
function _prepararConexion(llamadaId, stream, soyIniciador) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    const audio = document.getElementById('llamada-audio-remoto');
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; ponerEstadoLlamada('En llamada.'); };
    const canal = canalSenalizacion(llamadaId, async (m) => {
        if (!_llamada || _llamada.id !== llamadaId) return;
        try {
            if (m.t === 'listo' && soyIniciador) {
                const oferta = await pc.createOffer();
                await pc.setLocalDescription(oferta);
                canal.enviar({ t: 'oferta', sdp: oferta });
            } else if (m.t === 'oferta' && !soyIniciador) {
                await pc.setRemoteDescription(m.sdp);
                const respuesta = await pc.createAnswer();
                await pc.setLocalDescription(respuesta);
                canal.enviar({ t: 'respuesta', sdp: respuesta });
            } else if (m.t === 'respuesta' && soyIniciador) {
                if (!pc.currentRemoteDescription) await pc.setRemoteDescription(m.sdp);
            } else if (m.t === 'ice' && m.c) {
                await pc.addIceCandidate(m.c).catch(() => {});
            } else if (m.t === 'colgar') {
                terminarLlamada(false);
                avisar('La otra persona colgó la llamada.');
            }
        } catch (e) { /* fallos sueltos de señalización no tumban la llamada */ }
    });
    pc.onicecandidate = (e) => { if (e.candidate) canal.enviar({ t: 'ice', c: e.candidate }); };
    return { pc, canal };
}

/* Texto de estado de la llamada. */
function ponerEstadoLlamada(texto) {
    const el = document.getElementById('llamada-estado');
    if (el) el.textContent = texto;
}

/* Ventana de llamada en su modo. */
function _mostrarModalLlamada(titulo, esEntrante) {
    pintarBotonesLlamada();   // botones sin silenciar al iniciar
    document.getElementById('llamada-titulo').textContent = titulo;
    document.getElementById('llamada-aceptar').hidden = !esEntrante;
    document.getElementById('llamada-mic').hidden = esEntrante;
    document.getElementById('llamada-altavoz').hidden = esEntrante;
    document.getElementById('llamada-minimizar').hidden = esEntrante;
    document.getElementById('modal-llamada').hidden = false;
}

/* El admin llama al operador del hilo abierto (o a quien se indique) */
async function iniciarLlamadaSoporte() {
    if (!ES_ADMIN || !_soporteOperador) return; // el servidor vuelve a validar
    // Una llamada a la vez: el botón lleva a la que está en curso
    if (_llamada) { restaurarLlamada(); return; }
    try {
        const id = await llamadaCrear(_soporteOperador.id);
        const stream = await obtenerMicrofono();
        const { pc, canal } = _prepararConexion(id, stream, true);
        _llamada = { id, pc, stream, canal, soyIniciador: true };
        marcarLlamada();
        sonar('llamada');
        _mostrarModalLlamada('Llamando a ' + _soporteOperador.nombre + '…', false);
        ponerEstadoLlamada('Esperando a que conteste…');
        registrarActividad('llamada-soporte', _soporteOperador.nombre);
    } catch (e) {
        if (_llamada) terminarLlamada(true);
        else avisar((e && e.message) || 'No se pudo iniciar la llamada.', 'error');
    }
}

/* Llamada entrante */
let _llamadaEntrante = null;

/* Segundo timbre; se cancela al contestar o colgar. */
let _timbre = null;
function callarTimbre() { clearTimeout(_timbre); _timbre = null; vibrarTimbre(false); }

/* El celular vibra mientras suena (Android; iPhone no lo deja a las páginas). */
let _vibracion = null;
function vibrarTimbre(si) {
    clearInterval(_vibracion); _vibracion = null;
    if (!navigator.vibrate) return;
    try {
        if (!si) { navigator.vibrate(0); return; }
        navigator.vibrate([500, 300, 500]);
        _vibracion = setInterval(() => { try { navigator.vibrate([500, 300, 500]); } catch (e) {} }, 2200);
    } catch (e) { /* sin permiso para vibrar */ }
}

/* Burbuja y botón de soporte en verde y vibrando: en llamada o sonando. */
function marcarLlamada() {
    document.body.classList.toggle('pt-en-llamada', !!_llamada);
    document.body.classList.toggle('pt-sonando', !_llamada && !!_llamadaEntrante);
}
/* Aviso de llamada entrante. */
function recibirLlamada(fila) {
    if (_llamada || !fila || fila.estado !== 'sonando') return; // ya en llamada: se ignora
    _llamadaEntrante = fila;
    marcarLlamada();
    // Dos timbres para dar tiempo a mirar la pantalla.
    sonar('llamada'); _timbre = setTimeout(() => sonar('llamada'), 1800);
    vibrarTimbre(true);
    _mostrarModalLlamada('Llamada de la administración', true);
    ponerEstadoLlamada('La administración te está llamando.');
}

/* El admin colgó antes de que contestaran: se apaga el timbre */
function cambioDeLlamada(fila) {
    if (!_llamadaEntrante || _llamadaEntrante.id !== fila.id || fila.estado === 'sonando') return;
    _llamadaEntrante = null;
    callarTimbre();
    marcarLlamada();
    document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
    avisar('Llamada perdida de la administración.');
}

/* Acepta y abre el audio. */
async function aceptarLlamada() {
    if (!_llamadaEntrante) return;
    const fila = _llamadaEntrante;
    _llamadaEntrante = null;
    callarTimbre();
    try {
        const stream = await obtenerMicrofono();
        const { pc, canal } = _prepararConexion(fila.id, stream, false);
        _llamada = { id: fila.id, pc, stream, canal, soyIniciador: false };
        marcarLlamada();
        document.getElementById('llamada-aceptar').hidden = true;
        document.getElementById('llamada-mic').hidden = false;
        document.getElementById('llamada-minimizar').hidden = false;
        document.getElementById('llamada-altavoz').hidden = false;
        ponerEstadoLlamada('Conectando…');
        await llamadaActualizar(fila.id, 'aceptada').catch(() => {});
        // avisa al iniciador para que mande la oferta
        canal.enviar({ t: 'listo' });
        // el iniciador también muestra sus controles
        document.getElementById('llamada-mic').hidden = false;
        document.getElementById('llamada-minimizar').hidden = false;
        document.getElementById('llamada-altavoz').hidden = false;
    } catch (e) {
        await llamadaActualizar(fila.id, 'rechazada').catch(() => {});
        marcarLlamada();
        document.getElementById('modal-llamada').hidden = true;
        document.getElementById('llamada-mini').hidden = true;
    }
}

/* Minimizar: queda la barra de arriba (colgar, silenciar) y se sigue usando el portal y el chat. */
function minimizarLlamada() {
    if (!_llamada) return;
    document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = false;
    document.getElementById('llamada-mini-texto').textContent =
        document.getElementById('llamada-estado').textContent || 'En llamada';
}

/* Restaura la ventana de llamada. */
function restaurarLlamada() {
    document.getElementById('llamada-mini').hidden = true;
    if (_llamada) document.getElementById('modal-llamada').hidden = false;
}

/* Botones silenciados: icono con raya y en rojo (modal y barra). */
function pintarBotonesLlamada() {
    const pista = _llamada && _llamada.stream ? _llamada.stream.getAudioTracks()[0] : null;
    const micMudo = pista ? !pista.enabled : false;
    const audio = document.getElementById('llamada-audio-remoto');
    const altavozMudo = !!audio.muted;

    const mic = document.getElementById('llamada-mic');
    const micMini = document.getElementById('llamada-mic-mini');
    const alt = document.getElementById('llamada-altavoz');
    const altMini = document.getElementById('llamada-altavoz-mini');

    if (mic) {
        mic.innerHTML = icono(micMudo ? 'microfono-mudo' : 'microfono', 17) +
            (micMudo ? ' Activar micrófono' : ' Silenciar micrófono');
        mic.classList.toggle('pt-boton-llamada--activo', micMudo);
    }
    if (micMini) {
        micMini.innerHTML = icono(micMudo ? 'microfono-mudo' : 'microfono', 16);
        micMini.classList.toggle('pt-boton-llamada--activo', micMudo);
        micMini.title = micMudo ? 'Activar micrófono' : 'Silenciar micrófono';
    }
    if (alt) {
        alt.innerHTML = icono(altavozMudo ? 'altavoz-mudo' : 'altavoz', 17) +
            (altavozMudo ? ' Activar altavoz' : ' Silenciar altavoz');
        alt.classList.toggle('pt-boton-llamada--activo', altavozMudo);
    }
    if (altMini) {
        altMini.innerHTML = icono(altavozMudo ? 'altavoz-mudo' : 'altavoz', 16);
        altMini.classList.toggle('pt-boton-llamada--activo', altavozMudo);
        altMini.title = altavozMudo ? 'Activar altavoz' : 'Silenciar altavoz';
    }
}

/* Mic on/off. */
function alternarMicrofono() {
    if (!_llamada || !_llamada.stream) return;
    const pista = _llamada.stream.getAudioTracks()[0];
    if (!pista) return;
    pista.enabled = !pista.enabled;
    pintarBotonesLlamada();
}

/* Altavoz on/off. */
function alternarAltavoz() {
    const audio = document.getElementById('llamada-audio-remoto');
    audio.muted = !audio.muted;
    pintarBotonesLlamada();
}

/* Cuelga, suelta el mic y cierra la conexión. */
async function terminarLlamada(avisarAlOtro) {
    callarTimbre();
    // Rechazo de una llamada no aceptada
    if (_llamadaEntrante) {
        const fila = _llamadaEntrante; _llamadaEntrante = null;
        marcarLlamada();
        await llamadaActualizar(fila.id, 'rechazada').catch(() => {});
        const canal = canalSenalizacion(fila.id, () => {});
        canal.enviar({ t: 'colgar' }); setTimeout(() => canal.cerrar(), 500);
        document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
        return;
    }
    if (!_llamada) { document.getElementById('modal-llamada').hidden = true; marcarLlamada(); return; }
    const ll = _llamada; _llamada = null;
    marcarLlamada();
    try { if (avisarAlOtro !== false) ll.canal.enviar({ t: 'colgar' }); } catch (e) {}
    try { ll.pc.close(); } catch (e) {}
    try { ll.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    setTimeout(() => ll.canal.cerrar(), 500);
    await llamadaActualizar(ll.id, 'terminada').catch(() => {});
    const audio = document.getElementById('llamada-audio-remoto');
    audio.srcObject = null; audio.muted = false;
    document.getElementById('modal-llamada').hidden = true;
    document.getElementById('llamada-mini').hidden = true;
}

/* ============ CAMPANA (todos los roles) ============
   Cada quien solo las suyas (RLS). Al refrescar, el admin genera los
   avisos de vencidos (una vez por proceso). */
let _notifCache = [];

const ICONO_NOTIF = {
    'mensaje-nuevo': 'chat', 'archivo-nuevo': 'subir', 'soporte': 'campana',
    'proceso-estado': 'estado', 'proceso-semaforo': 'estado', 'proceso-vencido': 'alerta',
    'tramite-pausado': 'desactivar', 'tramite-reactivado': 'activar',
    'tramite-finalizado': 'activar', 'tramite-prorroga': 'estado',
    'tramite-fin': 'activar', 'ingreso-propio': 'ingreso', 'solicitud-clave': 'usuario',
    'archivo-admin': 'subir', 'audiencia-nueva': 'calendario', 'proceso-nuevo': 'estado',
    'ingreso-cuenta': 'ingreso', 'audiencia-hoy': 'calendario', 'audiencia-manana': 'calendario',
    'recordatorio': 'campana', 'push-prueba': 'campana',
    // Cuenta atrás del plazo: la genera la tarea diaria (avisar_plazos_tramite)
    // para todos los de la carpeta. El número son días de calendario.
    'plazo-28': 'calendario', 'plazo-21': 'calendario',
    'plazo-14': 'calendario', 'plazo-7': 'calendario',
    'plazo-1': 'alerta', 'plazo-0': 'alerta'
};

/* Ingreso del admin en su campana, como aviso de nuevo inicio de sesión. */
async function avisarIngresoEnCampana() {
    if (!ES_ADMIN) return;
    // Una vez por pestaña (sessionStorage): recargar no cuenta.
    try {
        if (sessionStorage.getItem('sesion_notificada')) { await refrescarCampana(); return; }
        await notificarMiIngreso();
        sessionStorage.setItem('sesion_notificada', 'true');
        await refrescarCampana();
    } catch (e) { /* silencioso */ }
}

/* Arranca la campana y su consulta periódica. */
async function iniciarCampana() {
    await refrescarCampana();
    suscribirNotificaciones(async () => {
        sonar('notificacion');
        await refrescarCampana();
        // Una sacudida fuerte al llegar; luego sigue naranja hasta abrirla
        const b = document.querySelector('.pt-campana');
        if (b) {
            b.classList.remove('pt-campana--sacudir');
            void b.offsetWidth;
            b.classList.add('pt-campana--sacudir');
            setTimeout(() => b.classList.remove('pt-campana--sacudir'), 2800);
        }
    });
}

/* Campana naranja y moviéndose mientras haya avisos sin ver. */
function marcarCampana(noLeidas) {
    const b = document.querySelector('.pt-campana');
    if (!b) return;
    b.classList.toggle('pt-campana--nueva', noLeidas > 0);
    b.setAttribute('aria-label', noLeidas > 0 ? 'Notificaciones: ' + noLeidas + ' sin leer' : 'Notificaciones');
}

/* Cuenta no leídas y actualiza la insignia. */
async function refrescarCampana() {
    try {
        if (ES_ADMIN) await notificacionesGenerarVencidos().catch(() => {});
        // Solo los de la notaría abierta
        _notifCache = await notificacionesListar(_notariaActiva);
    } catch (e) { return; }
    const noLeidas = _notifCache.filter(n => !n.leido).length;
    const cont = document.getElementById('campana-contador');
    if (cont) { cont.hidden = noLeidas === 0; cont.textContent = noLeidas > 99 ? '99+' : String(noLeidas); }
    marcarCampana(noLeidas);
    if (!document.getElementById('campana-dropdown').hidden) pintarCampanaLista();
}

/* Desplegable con las últimas. */
function pintarCampanaLista() {
    const lista = document.getElementById('campana-lista');
    if (!lista) return;
    // Cada una lleva a su origen
    lista.innerHTML = _notifCache.length === 0
        ? '<p class="pt-nota" style="padding:1.2rem;">No tienes notificaciones.</p>'
        : _notifCache.map(n =>
            '<div class="pt-campana-item' + (n.leido ? '' : ' pt-campana-item--nueva') + '"' +
                ' data-accion="notif-abrir" data-tipo="' + escaparHtml(n.tipo) + '"' +
                ' data-mensaje="' + escaparHtml(n.mensaje || '') + '"' +
                (n.carpetaId ? ' data-id="' + n.carpetaId + '"' : '') + ' style="cursor:pointer;">' +
                icono(ICONO_NOTIF[n.tipo] || 'campana', 16) +
                '<div>' + escaparHtml(n.mensaje) +
                '<span class="pt-nota">' + formatoFecha(n.fecha) + '</span></div>' +
                '<button class="pt-campana-x" data-accion="notif-eliminar" data-notif="' + n.id + '"' +
                    ' title="Eliminar notificación" aria-label="Eliminar notificación">' +
                    icono('cerrar', 13) + '</button>' +
            '</div>').join('');
}

/* Abre o cierra la campana. */
async function alternarCampana() {
    const dd = document.getElementById('campana-dropdown');
    if (!dd.hidden) { dd.hidden = true; return; }
    dd.hidden = false;
    await refrescarCampana();
    pintarCampanaLista();   // las nuevas resaltadas…
    // …y al abrir quedan leídas
    if (_notifCache.some(n => !n.leido)) {
        // Ids y no null: con null se marcarían también las de otras notarías
        const visibles = _notifCache.filter(n => !n.leido).map(n => n.id);
        notificacionesMarcarLeidas(visibles).then(() => {
            for (const n of _notifCache) n.leido = true;
            const cont = document.getElementById('campana-contador');
            if (cont) cont.hidden = true;
            marcarCampana(0);
        }).catch(() => {});
    }
}

/* Lleva al origen de la notificación */
async function abrirDesdeNotificacion(tipo, carpetaId, mensaje) {
    document.getElementById('campana-dropdown').hidden = true;
    if (tipo === 'soporte') { abrirSoporte(); return; }
    // Solicitud de clave → ficha del usuario
    if (tipo === 'solicitud-clave' && ES_ADMIN) {
        const m = /«([^»]+)»/.exec(mensaje || '');
        if (m) {
            const objetivo = await dbObtener('usuarios', m[1]);
            if (objetivo) {
                await mostrarVistaUsuarios();
                abrirModalUsuario(objetivo);
                return;
            }
        }
        await mostrarVistaUsuarios();
        return;
    }
    // Varios avisos juntos en el celular: a la campana
    if (tipo === 'resumen') { await alternarCampana(); return; }
    const esDeEstados = ['proceso-nuevo', 'proceso-estado', 'proceso-semaforo', 'proceso-vencido',
        'tramite-pausado', 'tramite-reactivado', 'tramite-finalizado', 'tramite-prorroga', 'tramite-fin'].includes(tipo);
    if (esDeEstados && (ES_PERSONAL || ES_MONITOR)) {
        await mostrarVistaEstados();
        if (carpetaId && ES_SUPERVISION) abrirDetalleTramite(carpetaId);
        return;
    }
    if (carpetaId) { abrirCarpeta(carpetaId); return; }
    // sin origen: no navega
}

/* Borra una notificación (con confirmación) sin recargar */
async function eliminarNotificacion(id, elemento) {
    if (!await confirmarPortal('¿Estás seguro de que deseas eliminar esta notificación de manera permanente?', 'Eliminar notificación')) return;
    try {
        await notificacionEliminar(Number(id));
        _notifCache = _notifCache.filter(n => String(n.id) !== String(id));
        if (elemento) elemento.remove();
        // actualiza no leídas
        const noLeidas = _notifCache.filter(n => !n.leido).length;
        const cont = document.getElementById('campana-contador');
        if (cont) { cont.hidden = noLeidas === 0; cont.textContent = noLeidas > 99 ? '99+' : String(noLeidas); }
        marcarCampana(noLeidas);
        if (_notifCache.length === 0) pintarCampanaLista();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la notificación.', 'error');
    }
}

/* Vacía la campana (solo la notaría abierta, como se listan). */
async function limpiarCampana() {
    const cuantas = (_notifCache || []).length;
    if (!cuantas) { avisar('No hay notificaciones que limpiar.'); return; }

    const oficina = notariaActual();
    const ok = await confirmarPortal(
        'Se van a eliminar ' + cuantas +
        (cuantas === 1 ? ' notificación' : ' notificaciones') +
        (oficina ? ' de «' + oficina.nombre + '»' : '') +
        '. No se puede deshacer, pero los trámites y los documentos no se tocan.',
        'Limpiar notificaciones');
    if (!ok) return;

    const boton = document.getElementById('campana-limpiar');
    if (boton) { boton.disabled = true; boton.textContent = 'Limpiando…'; }
    try {
        await notificacionesLimpiar(_notariaActiva);
        _notifCache = [];
        await refrescarCampana();
        pintarCampanaLista();
        avisar('Notificaciones eliminadas.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudieron eliminar las notificaciones.', 'error');
    }
    if (boton) { boton.disabled = false; boton.textContent = 'Limpiar'; }
}

/* Todas leídas. */
async function marcarCampanaLeidas() {
    try {
        await notificacionesMarcarLeidas(null);
        await refrescarCampana();
        pintarCampanaLista();
    } catch (e) {
        avisar((e && e.message) || 'No se pudieron marcar las notificaciones.', 'error');
    }
}

/* ============ AVISOS EN EL CELULAR (solo administrador) ============
   Web Push: sw.js muestra el aviso aunque el portal esté cerrado. Cada
   equipo se activa aparte y elige qué recibe. */
let _registroAvisos = null;
let _avisosIniciados = false;
let _avisosClave = null;     // llave pública VAPID, pedida al abrir el panel
let _avisosActivos = false;  // lo que muestra el panel ahora

function avisosPushPosible() {
    return ES_ADMIN && 'serviceWorker' in navigator && 'PushManager' in window &&
        'Notification' in window && typeof avisosPushSuscribir === 'function';
}

// En iPhone y iPad, Safari solo los deja con el portal en la pantalla de inicio
function esIosSinInstalar() {
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const instalado = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    return ios && !instalado;
}

function b64uDeBytes(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesDeB64u(s) {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b + '='.repeat((4 - b.length % 4) % 4)), c => c.charCodeAt(0));
}

async function registroAvisos() {
    if (!_registroAvisos) {
        await navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal/' });
        _registroAvisos = await navigator.serviceWorker.ready;
    }
    return _registroAvisos;
}

/* Al arrancar: el aviso que se tocó y, si ya estaban activos, las llaves al día. */
async function iniciarAvisosPush() {
    if (_avisosIniciados) return;
    _avisosIniciados = true;
    const m = /#aviso=([^&]*)(?:&carpeta=(\d+))?/.exec(location.hash);
    if (m) {
        history.replaceState(history.state, '', location.pathname + location.search);
        abrirDesdeNotificacion(decodeURIComponent(m[1]), m[2] ? Number(m[2]) : null, '');
    }
    // Solo admin, y solo con servidor (en modo práctica no hay a dónde suscribirse)
    if (!ES_ADMIN || typeof avisosPushSuscribir !== 'function') return;
    document.getElementById('campana-pie-avisos').hidden = false;
    document.getElementById('avisos-categorias').addEventListener('change', guardarCategoriasAvisos);
    if (!avisosPushPosible()) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
        const d = e.data || {};
        if (typeof d.aviso === 'string') abrirDesdeNotificacion(d.aviso, d.carpeta || null, '');
    });
    try {
        const sub = await (await registroAvisos()).pushManager.getSubscription();
        if (sub && Notification.permission === 'granted') await avisosPushSuscribir(sub, null);
    } catch (e) { /* sin avisos el portal sigue igual */ }
}

async function abrirAvisosPush() {
    document.getElementById('campana-dropdown').hidden = true;
    document.getElementById('avisos-resultado').textContent = '';
    document.getElementById('modal-avisos').hidden = false;
    await pintarAvisosPush();
}

async function pintarAvisosPush() {
    const estado = document.getElementById('avisos-estado');
    const cats = document.getElementById('avisos-categorias');
    const activar = document.getElementById('avisos-activar');
    const probar = document.getElementById('avisos-probar');
    cats.hidden = true; probar.hidden = true; activar.hidden = true;
    _avisosActivos = false;

    if (esIosSinInstalar()) {
        estado.innerHTML = 'En iPhone los avisos solo llegan con el portal en la pantalla de inicio: en Safari toca ' +
            '<strong>Compartir</strong>, luego <strong>Agregar a inicio</strong>, y abre el portal desde ese ícono.';
        return;
    }
    if (!avisosPushPosible()) {
        estado.textContent = 'Este navegador no puede recibir avisos. Prueba con Chrome, Edge o Safari actualizados.';
        return;
    }
    if (Notification.permission === 'denied') {
        estado.innerHTML = 'Los avisos están bloqueados para este sitio. Permítelos en los ajustes del navegador ' +
            '(el candado junto a la dirección, <strong>Notificaciones</strong>) y vuelve aquí.';
        return;
    }
    estado.textContent = 'Revisando este equipo…';
    let sub = null, mio = null;
    try {
        sub = await (await registroAvisos()).pushManager.getSubscription();
        if (sub) mio = await avisosPushMio(sub.endpoint);
    } catch (e) { /* se ofrece activarlos */ }

    if (sub && mio) {
        _avisosActivos = true;
        estado.textContent = 'Activados en este equipo' + (mio.dispositivo ? ' (' + mio.dispositivo + ')' : '') +
            '. Elige qué quieres recibir:';
        cats.querySelectorAll('input').forEach(i => { i.checked = mio.categorias.includes(i.value); });
        cats.hidden = false; probar.hidden = false;
        activar.textContent = 'Desactivar'; activar.hidden = false;
        // Activos: lo principal es probar; desactivar queda discreto
        probar.className = 'pt-boton pt-boton--primario';
        activar.className = 'pt-boton pt-boton--fantasma';
        return;
    }
    // La llave se pide ya: al tocar Activar no puede haber esperas (Safari)
    try { _avisosClave = await avisosPushClave(); } catch (e) {
        estado.textContent = (e && e.message) || 'El servidor todavía no tiene configurados los avisos.';
        return;
    }
    estado.textContent = 'Desactivados en este equipo. Al activarlos, el navegador te pedirá permiso.';
    activar.textContent = 'Activar avisos'; activar.hidden = false;
    activar.className = 'pt-boton pt-boton--primario';
}

async function alternarAvisosPush() {
    const boton = document.getElementById('avisos-activar');
    const res = document.getElementById('avisos-resultado');
    boton.disabled = true; res.textContent = '';
    try {
        const reg = _registroAvisos || await registroAvisos();
        if (_avisosActivos) {
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
                await avisosPushQuitar(sub.endpoint);
                await sub.unsubscribe().catch(() => {});
            }
            avisar('Avisos desactivados en este equipo.');
        } else {
            // subscribe() pide el permiso; va primero, pegado al toque
            let sub = await reg.pushManager.getSubscription();
            if (sub && sub.options && sub.options.applicationServerKey &&
                b64uDeBytes(sub.options.applicationServerKey) !== _avisosClave) {
                await sub.unsubscribe().catch(() => {});   // llave vieja del servidor
                sub = null;
            }
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDeB64u(_avisosClave) });
            await avisosPushSuscribir(sub, null);
            avisar('Avisos activados en este equipo.');
        }
    } catch (e) {
        res.textContent = (e && e.name === 'NotAllowedError')
            ? 'El navegador no dio permiso para mostrar avisos.'
            : ((e && e.message) || 'No se pudieron cambiar los avisos.');
    }
    boton.disabled = false;
    await pintarAvisosPush();
}

async function guardarCategoriasAvisos() {
    const res = document.getElementById('avisos-resultado');
    const elegidas = [...document.querySelectorAll('#avisos-categorias input:checked')].map(i => i.value);
    try {
        const sub = await (await registroAvisos()).pushManager.getSubscription();
        if (sub) await avisosPushCategorias(sub.endpoint, elegidas);
        res.textContent = elegidas.length ? 'Guardado.' : 'Guardado. Sin categorías no te llegará nada a este equipo.';
    } catch (e) {
        res.textContent = (e && e.message) || 'No se pudo guardar.';
    }
}

/* Prueba: la base la manda por el mismo camino que un aviso real y aquí
   se espera a que la función anote cómo le fue a este equipo. */
async function probarAvisosPush() {
    const res = document.getElementById('avisos-resultado');
    const boton = document.getElementById('avisos-probar');
    boton.disabled = true;
    res.textContent = 'Enviando la prueba…';
    try {
        const sub = await (await registroAvisos()).pushManager.getSubscription();
        if (!sub) throw new Error('Este equipo no tiene los avisos activos.');
        const antes = ((await avisosPushMio(sub.endpoint)) || {}).ultimoEnvio || 0;
        await avisosPushProbar();
        let mio = null;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1500));
            mio = await avisosPushMio(sub.endpoint);
            if (!mio || (mio.ultimoEnvio || 0) > antes) break;
        }
        if (!mio) res.textContent = 'El servicio de avisos ya no reconoce este equipo. Vuelve a activarlos.';
        else if ((mio.ultimoEnvio || 0) <= antes) res.textContent = 'El servidor no la envió. Falta configurar la función avisos-push o pg_net (lo explica la guía de instalación).';
        else if (mio.ultimoEstado >= 200 && mio.ultimoEstado < 300) res.textContent = 'Enviada. Debe llegar en unos segundos a tus equipos con avisos activos.';
        else res.textContent = 'El servicio de avisos respondió ' + (mio.ultimoEstado || 'sin respuesta') + '. Desactiva y vuelve a activar los avisos.';
    } catch (e) {
        res.textContent = (e && e.message) || 'No se pudo enviar la prueba.';
    }
    boton.disabled = false;
    if (!document.getElementById('modal-avisos').hidden) {
        const texto = res.textContent;
        await pintarAvisosPush();
        res.textContent = texto;
    }
}

/* ============ CONFIRMACIONES PROPIAS (en vez de confirm/prompt) ============ */
let _confirmarResolver = null;

/* Confirmación con el diseño del portal. Promesa true/false. */
function confirmarPortal(mensaje, titulo) {
    return new Promise((resolver) => {
        _confirmarResolver = resolver;
        document.getElementById('confirmar-titulo').textContent = titulo || 'Confirmar';
        document.getElementById('confirmar-mensaje').textContent = mensaje || '¿Continuar?';
        document.getElementById('modal-confirmar').hidden = false;
        document.getElementById('confirmar-si').focus();
    });
}

/* Texto corto con el modal del portal (no prompt()). */
let _textoResolver = null;

/* Pide un texto (o null si cancela). `etiqueta` y `boton` opcionales
   (el modal venía con "Nombre" y "Guardar" fijos). */
function pedirTextoPortal(titulo, ayuda, valorInicial, etiqueta, boton, maximo) {
    return new Promise((resolver) => {
        _textoResolver = resolver;
        document.getElementById('texto-titulo').textContent = titulo || 'Escribe un nombre';
        const cajaAyuda = document.getElementById('texto-ayuda');
        cajaAyuda.textContent = ayuda || '';
        cajaAyuda.hidden = !ayuda;
        document.getElementById('texto-etiqueta').textContent = etiqueta || 'Nombre';
        document.getElementById('texto-aceptar').textContent = boton || 'Guardar';
        const campo = document.getElementById('texto-valor');
        campo.maxLength = maximo || 60;
        campo.value = valorInicial || '';
        document.getElementById('modal-texto').hidden = false;
        campo.focus();
        campo.select();
    });
}

/* Cierra el diálogo de texto. */
function _responderTexto(valor) {
    document.getElementById('modal-texto').hidden = true;
    if (_textoResolver) { _textoResolver(valor); _textoResolver = null; }
}

/* Cierra la confirmación. */
function _responderConfirmacion(valor) {
    document.getElementById('modal-confirmar').hidden = true;
    if (_confirmarResolver) { _confirmarResolver(valor); _confirmarResolver = null; }
}

/* ============ CONSENTIMIENTO DE DATOS (primer ingreso cliente/acreedor) ============
   No se puede usar el portal sin aceptar. */
async function verificarConsentimiento() {
    if (!ES_CLIENTE && !ES_ACREEDOR) return;
    let perfil = null;
    try { perfil = await perfilPropio(); } catch (e) { return; }
    if (perfil && perfil.primerLogin) {
        document.getElementById('consentimiento-acepto').checked = false;
        document.getElementById('modal-consentimiento').hidden = false;
    }
}

/* Guarda la aceptación con fecha y hora. */
async function aceptarConsentimientoAccion() {
    if (!document.getElementById('consentimiento-acepto').checked) {
        avisar('Debes marcar la casilla de autorización para continuar.', 'error');
        return;
    }
    try {
        await consentimientoAceptar('1.0');
        registrarActividad('consentimiento', 'Aceptó la política de datos v1.4');
        document.getElementById('modal-consentimiento').hidden = true;
        avisar('Gracias. Autorización registrada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo registrar la autorización.', 'error');
    }
}

/* ---- Consentimientos (Usuarios, solo admin) ---- */
async function cambiarPanelUsuarios(panel) {
    const gestion = document.getElementById('panel-usuarios-gestion');
    const consent = document.getElementById('panel-consentimientos');
    document.querySelectorAll('#sub-pestanas-usuarios button').forEach(b =>
        b.classList.toggle('activa', b.dataset.panel === panel));
    gestion.hidden = (panel !== 'gestion');
    consent.hidden = (panel !== 'consentimientos');
    if (panel === 'consentimientos') {
        let lista = [];
        try { lista = await consentimientosListar(); } catch (e) {
            avisar((e && e.message) || 'No se pudieron cargar los consentimientos.', 'error');
            return;
        }
        _consentimientosCache = lista;
        document.getElementById('lista-consentimientos').innerHTML = lista.map((c, i) =>
            '<tr><td><code>' + escaparHtml(c.usuario) + '</code></td>' +
            '<td>' + escaparHtml(c.nombre) + '</td>' +
            '<td><span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[c.rol] || c.rol) + '</span></td>' +
            '<td>' + formatoFecha(c.fecha) + '</td>' +
            '<td>' + escaparHtml(c.version) + '</td>' +
            '<td><div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="consentimiento-ver" data-id="' + i + '">Ver</button> ' +
                '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="consentimiento-descargar" data-id="' + i + '">' +
                    icono('descargar', 14) + ' Descargar (PDF)</button>' +
            '</div></td></tr>').join('');
        document.getElementById('consentimientos-vacio').hidden = lista.length > 0;
    }
}
let _consentimientosCache = [];

/* Texto de la autorización (el mismo del modal) */
const TEXTO_POLITICA_DATOS =
    'AUTORIZACIÓN DE MANEJO DE DATOS PERSONALES\n\n' +
    'De conformidad con la Ley 1581 de 2012 (protección de datos personales en Colombia), ' +
    'el titular AUTORIZA a ' + NOMBRE_ENTIDAD + ' el tratamiento de sus ' +
    'datos personales y de los documentos de su trámite. Los datos se usan únicamente para la ' +
    'gestión de su proceso de insolvencia/conciliación, se comparten solo con las partes ' +
    'autorizadas del trámite y el titular puede ejercer sus derechos de consulta y reclamo ' +
    'escribiendo a ' + (DATOS_ENTIDAD.CORREO || NOMBRE_ENTIDAD) + '.';

/* Documento de aceptación (texto y titular) */
function verConsentimiento(indice) {
    const c = _consentimientosCache[indice];
    if (!c) return;
    confirmarPortal(
        TEXTO_POLITICA_DATOS + '\n\n' +
        'Titular: ' + c.nombre + ' (' + c.usuario + ') · Rol: ' + (ETIQUETAS_ROL[c.rol] || c.rol) + '\n' +
        'Fecha de aceptación: ' + formatoFecha(c.fecha) + '\n' +
        'Versión de la política: ' + c.version,
        'Constancia de autorización de datos');
}

/* Constancia en PDF (pdf-lib) */
async function descargarConstanciaConsentimiento(indice) {
    const c = _consentimientosCache[indice];
    if (!c) return;
    try {
        const PDFLib = await cargarPdfLib();
        const doc = await PDFLib.PDFDocument.create();
        const pagina = doc.addPage([612, 792]); // carta
        const fuente = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const fuenteNegrita = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);

        // texto para la fuente estándar (WinAnsi)
        const lineas = [];
        const envolver = (texto, max) => {
            for (const parrafo of texto.split('\n')) {
                let linea = '';
                for (const palabra of parrafo.split(' ')) {
                    if ((linea + ' ' + palabra).trim().length > max) { lineas.push(linea.trim()); linea = palabra; }
                    else linea += ' ' + palabra;
                }
                lineas.push(linea.trim());
            }
        };
        envolver(TEXTO_POLITICA_DATOS, 90);
        lineas.push('');
        lineas.push('Titular: ' + c.nombre + ' (' + c.usuario + ')');
        lineas.push('Rol en el portal: ' + (ETIQUETAS_ROL[c.rol] || c.rol));
        lineas.push('Fecha y hora de aceptacion: ' + formatoFecha(c.fecha));
        lineas.push('Version de la politica aceptada: ' + c.version);
        lineas.push('');
        lineas.push('La aceptacion quedo registrada electronicamente en el Portal Documental');
        lineas.push('al primer ingreso del titular (tabla consentimientos).');

        pagina.drawText('Portal Documental', { x: 50, y: 742, size: 16, font: fuenteNegrita });
        pagina.drawText('Constancia de autorizacion de manejo de datos', { x: 50, y: 720, size: 12, font: fuenteNegrita });
        let y = 690;
        for (const l of lineas) {
            pagina.drawText(l, { x: 50, y, size: 10, font: fuente });
            y -= 15;
        }

        const bytes = await doc.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = 'consentimiento_' + nombreArchivoSeguro(c.usuario) + '.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar la constancia.', 'error');
    }
}

/* ============ ESTADO DEL TRÁMITE ============ */
function mostrarEditorDescripcion() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    document.getElementById('descripcion-nueva').value = carpetaAbierta.descripcion || '';
    document.getElementById('form-descripcion').hidden = false;
    document.getElementById('boton-editar-descripcion').hidden = true;
    document.getElementById('descripcion-nueva').focus();
}

/* Cierra el editor de notas. */
function ocultarEditorDescripcion() {
    document.getElementById('form-descripcion').hidden = true;
    if (carpetaAbierta) {
        document.getElementById('boton-editar-descripcion').hidden = !puedeGestionarCarpeta(carpetaAbierta);
    }
}

/* Guarda las notas internas. */
async function guardarDescripcion(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const texto = document.getElementById('descripcion-nueva').value.trim();
    await actualizarDescripcionCarpeta(carpetaAbierta.id, texto);
    carpetaAbierta.descripcion = texto;
    document.getElementById('detalle-descripcion').textContent = texto || 'Sin notas internas todavía.';
    registrarActividad('actualizar-notas', carpetaAbierta.nombre, carpetaAbierta.id);
    ocultarEditorDescripcion();
    avisar('Notas internas actualizadas.');
}

/* ============ SUB-PESTAÑAS DE LA CARPETA ============
   La pestaña "Deudor" se quitó; la tabla deudores_info sigue en la base. */
let _subPanelCarpeta = 'archivos';

/* Pestañas según lo que puede ver el usuario (con una no hay barra). */
function montarSubPestanasCarpeta(carpeta) {
    const barra = document.getElementById('sub-pestanas-carpeta');
    if (!barra) return;

    const tab = (panel, ic, etiqueta) =>
        '<button class="' + (_subPanelCarpeta === panel ? 'activa' : '') + '" data-accion="sub-carpeta" data-panel="' + panel + '">' +
            icono(ic, 17) + ' ' + etiqueta + '</button>';

    const pestañas =
        tab('archivos', 'carpeta', 'Archivos') +
        // Herramientas del personal (admin / operador responsable)
        (puedeGestionarCarpeta(carpeta)
            ? tab('audiencias', 'calendario', 'Audiencias') +
              tab('recordatorios', 'campana', 'Recordatorios')
            : '') +
        // Notificaciones: también el monitor (lectura)
        ((puedeGestionarCarpeta(carpeta) || ES_MONITOR)
            ? tab('notificaciones', 'ingreso', 'Notificaciones')
            : '') +
        // Calendario: todos; deudor y acreedores solo leen
        tab('calendario', 'calendario', 'Calendario');

    // Una sola pestaña: sin barra
    const varias = (pestañas.match(/<button/g) || []).length > 1;
    barra.hidden = !varias;
    barra.innerHTML = varias ? pestañas : '';

    pintarPanelDeCarpeta(_subPanelCarpeta, carpeta);
    mostrarSubPanelCarpeta(_subPanelCarpeta);
}

const PANELES_CARPETA = ['archivos', 'audiencias', 'recordatorios', 'notificaciones', 'calendario'];

/* Muestra la pestaña elegida. */
function mostrarSubPanelCarpeta(panel) {
    document.getElementById('panel-archivos').hidden = (panel !== 'archivos');
    for (const p of ['audiencias', 'recordatorios', 'notificaciones', 'calendario']) {
        const el = document.getElementById('panel-' + (p === 'notificaciones' ? 'notif-carpeta' : p));
        if (el) el.hidden = (panel !== p);
    }
}

/* Pinta los paneles dinámicos */
function pintarPanelDeCarpeta(panel, carpeta) {
    if (panel === 'audiencias') pintarAudiencias(carpeta);
    else if (panel === 'recordatorios') pintarRecordatorios(carpeta);
    else if (panel === 'notificaciones') pintarNotifCarpeta(carpeta);
    else if (panel === 'calendario') pintarCalendario();
}

/* Cambia de pestaña si el rol tiene acceso. */
function cambiarSubPestanaCarpeta(panel) {
    if (!PANELES_CARPETA.includes(panel)) return;
    // Paneles del personal
    if (['audiencias', 'recordatorios'].includes(panel) &&
        (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta))) return;
    // Notificaciones: personal o monitor
    if (panel === 'notificaciones' &&
        (!carpetaAbierta || !(puedeGestionarCarpeta(carpetaAbierta) || ES_MONITOR))) return;
    _subPanelCarpeta = panel;
    document.querySelectorAll('#sub-pestanas-carpeta button').forEach(b =>
        b.classList.toggle('activa', b.dataset.panel === panel));
    pintarPanelDeCarpeta(panel, carpetaAbierta);
    mostrarSubPanelCarpeta(panel);
}

/* Orden: primero el manual ('orden'), luego por fecha (reciente primero). */
function ordenarArchivos(archivos) {
    const plano = archivos.sort((a, b) => {
        const oa = (a.orden === null || a.orden === undefined) ? Infinity : a.orden;
        const ob = (b.orden === null || b.orden === undefined) ? Infinity : b.orden;
        if (oa !== ob) return oa - ob;
        return b.fecha - a.fecha;
    });
    return agruparAnexos(plano);
}

/* ============ ANEXOS: 1, 1.1, 1.2 ============
   migracion_anexos.sql. Cada anexo va debajo de su principal; los números
   salen del orden. Un anexo sin principal visible sale como principal.
   conservarOrden: mientras se edita, se respeta lo que hay en pantalla. */
function agruparAnexos(plano, conservarOrden) {
    const porId = new Map(plano.map(a => [a.id, a]));
    const esAnexoValido = (a) => {
        const p = a.anexoDe ? porId.get(a.anexoDe) : null;
        return !!(p && p.id !== a.id && !p.anexoDe &&
                  String(p.subcarpetaId || '') === String(a.subcarpetaId || ''));
    };
    const hijos = new Map();
    plano.forEach(a => {
        if (!esAnexoValido(a)) return;
        if (!hijos.has(a.anexoDe)) hijos.set(a.anexoDe, []);
        hijos.get(a.anexoDe).push(a);
    });
    if (!conservarOrden) {
        hijos.forEach(lista => lista.sort((x, y) => {
            const ox = x.orden == null ? Infinity : x.orden, oy = y.orden == null ? Infinity : y.orden;
            return ox !== oy ? ox - oy : x.fecha - y.fecha;
        }));
    }
    const salida = [];
    plano.forEach(a => {
        if (esAnexoValido(a)) return;
        salida.push(a);
        (hijos.get(a.id) || []).forEach(h => salida.push(h));
    });
    return salida;
}

/* Número de cada documento de la vista:
   id → { etiqueta, anexo, padre, anexos }. Espera la lista agrupada. */
function numerarDocumentos(lista) {
    const mapa = new Map();
    const enLista = new Set(lista.map(a => a.id));
    let n = 0;
    lista.forEach(a => {
        const padre = a.anexoDe && enLista.has(a.anexoDe) ? mapa.get(a.anexoDe) : null;
        if (padre && !padre.anexo) {
            padre.anexos += 1;
            mapa.set(a.id, { etiqueta: padre.etiqueta + '.' + padre.anexos, anexo: true, padre: a.anexoDe, anexos: 0 });
        } else {
            n += 1;
            mapa.set(a.id, { etiqueta: String(n), anexo: false, padre: null, anexos: 0 });
        }
    });
    return mapa;
}

let _numeracion = new Map();        // la vista pintada
const _anexosPlegados = new Set();  // principales con anexos plegados
let _anexosCambiados = new Map();   // Editar documentos: id → nuevo principal (o null)

/* Pone la vista reordenada en la caché, en sus mismas posiciones. */
function reemplazarVistaEnCache(nuevaVista) {
    const ids = new Set(nuevaVista.map(a => a.id));
    const posiciones = [];
    _archivosCache.forEach((a, i) => { if (ids.has(a.id)) posiciones.push(i); });
    posiciones.forEach((pos, k) => { _archivosCache[pos] = nuevaVista[k]; });
}

let _editandoOrden = false;
let _subcarpetas = [];        // subcarpetas de la carpeta abierta
let _subcarpetaAbierta = null; // null = raíz; _editandoOrden = modo Editar documentos
let _archivosCache = [];      // archivos de la carpeta abierta, ordenados

/* Tabla de documentos: subcarpetas, filtro y cifras. */
async function pintarArchivos() {
    if (!carpetaAbierta) return;
    const archivos = await dbArchivosDeCarpeta(carpetaAbierta.id);
    _archivosCache = ordenarArchivos(archivos);

    // Subcarpetas y fichas
    await cargarSubcarpetas();
    // Si la subcarpeta ya no existe, a la raíz
    if (_subcarpetaAbierta !== null &&
        !_subcarpetas.some(x => String(x.id) === String(_subcarpetaAbierta))) {
        _subcarpetaAbierta = null;
    }
    pintarSubcarpetas();
    // Desde aquí, solo lo que se ve
    const visibles = archivosDeVistaActual();

    // Barra: reordenar (personal) y vaciar expediente (solo admin)
    const barraArchivos = document.getElementById('barra-editar-documentos');
    if (barraArchivos) barraArchivos.remove();

    const puedeOrdenar = puedeGestionarCarpeta(carpetaAbierta) && visibles.length > 1;
    // Vaciar borra TODO el expediente: solo se ofrece en la raíz.
    const puedeVaciar = ES_ADMIN && _subcarpetaAbierta === null &&
                        (_archivosCache || []).length > 0 && !_editandoOrden;

    if (puedeOrdenar || puedeVaciar) {
        const envoltura = document.querySelector('#panel-archivos .pt-tabla-envoltura');
        const barra = document.createElement('div');
        barra.id = 'barra-editar-documentos';
        barra.className = 'pt-barra-editar-docs';

        let dentro = '';
        if (_editandoOrden) {
            dentro = '<span class="pt-nota">Arrastra las filas o usa las flechas para reorganizar. El orden se usa en la tabla y en el expediente.</span>' +
                     '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="guardar-orden">Guardar orden</button>' +
                     '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cancelar-orden">Cancelar</button>';
        } else {
            if (puedeOrdenar) {
                dentro += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-documentos">' +
                          icono('editar', 15) + ' Editar documentos</button>';
            }
            if (puedeVaciar) {
                dentro += '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="vaciar-carpeta">' +
                          icono('eliminar', 15) + ' Eliminar todos los documentos</button>';
            }
        }
        barra.innerHTML = dentro;
        envoltura.parentNode.insertBefore(barra, envoltura);
    }

    // Columna "Descarga": solo personal
    const thDescarga = document.getElementById('th-descarga');
    if (thDescarga) thDescarga.hidden = !puedeGestionarCarpeta(carpetaAbierta);

    // "Subido por": no lo ven cliente ni acreedor
    const thSubidoPor = document.getElementById('th-subido-por');
    if (thSubidoPor) thSubidoPor.hidden = (ES_CLIENTE || ES_ACREEDOR);

    const cuerpo = document.getElementById('lista-archivos');
    _numeracion = numerarDocumentos(visibles);
    cuerpo.innerHTML = visibles.map(filaArchivo).join('');
    pintarSelectorAnexoSubida(visibles);
    document.getElementById('archivos-vacio').hidden = visibles.length > 0;
    const vacio = document.getElementById('archivos-vacio');
    if (vacio && !visibles.length) {
        vacio.textContent = _subcarpetaAbierta === null
            ? 'Todavía no hay documentos en esta carpeta.'
            : 'La subcarpeta «' + nombreSubcarpeta(_subcarpetaAbierta) + '» está vacía.';
    }
    if (_editandoOrden) activarArrastreOrden();

    // Las cifras cuentan todos los documentos, no solo los visibles
    pintarCifrasDetalle(carpetaAbierta, _archivosCache);
    const resumen = document.getElementById('archivos-resumen');
    if (resumen) {
        const donde = _subcarpetaAbierta === null
            ? '' : ' en «' + nombreSubcarpeta(_subcarpetaAbierta) + '»';
        resumen.textContent = visibles.length
            ? visibles.length + (visibles.length === 1 ? ' documento' : ' documentos') + donde
            : '';
    }
}

/* ============ SUBCARPETAS ============
   Un nivel, como fichas (Audiencias, Notificaciones…). */

/* Audiencias se reconoce por el nombre, sin mayúsculas ni tildes. */
function esSubcarpetaDeMedios(nombre) {
    return /audiencia/i.test(String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

/* ¿El destino admite esta extensión?
   Documentos (raíz): solo documentos
   Audiencias: solo audio y video
   Subcarpetas creadas a mano: libre
   destino: id de subcarpeta o null (raíz). */
function destinoAdmiteExtension(destino, ext) {
    const esMedia = EXTENSIONES_MEDIA.includes(ext);
    // Audiencias: grabaciones
    if (destinoEsDeMedios(destino)) return esMedia;
    // Raíz: expediente escrito
    if (destino === null || destino === undefined || destino === '') return !esMedia;
    // Creada a mano: libre
    return true;
}

/* ¿Es la subcarpeta de audiencias? */
function destinoEsDeMedios(destino) {
    if (destino === null || destino === undefined || destino === '') return false;
    return esSubcarpetaDeMedios(nombreSubcarpeta(destino));
}

/* Motivo del rechazo */
function motivoRechazo(destino, nombreArchivo) {
    if (destinoEsDeMedios(destino)) {
        return nombreArchivo + ' (en Audiencias solo entran grabaciones de audio o video)';
    }
    return nombreArchivo + ' (las grabaciones van en Audiencias; en Documentos ' +
           'solo el expediente escrito)';
}

/* Nombre de subcarpeta por id. */
function nombreSubcarpeta(id) {
    const s = _subcarpetas.find(x => String(x.id) === String(id));
    return s ? s.nombre : '';
}

/* Documentos visibles (subcarpeta abierta o raíz). */
function archivosDeVistaActual() {
    if (_subcarpetaAbierta === null) {
        return _archivosCache.filter(a => !a.subcarpetaId);
    }
    return _archivosCache.filter(a => String(a.subcarpetaId) === String(_subcarpetaAbierta));
}

/* Fichas de subcarpetas con su conteo. */
function pintarSubcarpetas() {
    const caja = document.getElementById('barra-subcarpetas');
    if (!caja || !carpetaAbierta) return;

    const gestiona = puedeGestionarCarpeta(carpetaAbierta);
    const enRaiz = _archivosCache.filter(a => !a.subcarpetaId).length;

    let html = '<button class="pt-subcarpeta' + (_subcarpetaAbierta === null ? ' activa' : '') + '" ' +
        'data-accion="abrir-subcarpeta" data-sub="">' +
        icono('carpeta', 15) + ' Documentos' +
        '<span class="pt-subcarpeta__num">' + enRaiz + '</span></button>';

    for (const sub of _subcarpetas) {
        const n = _archivosCache.filter(a => String(a.subcarpetaId) === String(sub.id)).length;
        html += '<button class="pt-subcarpeta' + (String(_subcarpetaAbierta) === String(sub.id) ? ' activa' : '') + '" ' +
            'data-accion="abrir-subcarpeta" data-sub="' + sub.id + '">' +
            icono('carpeta', 15) + ' ' + escaparHtml(sub.nombre) +
            '<span class="pt-subcarpeta__num">' + n + '</span></button>';
    }

    if (gestiona) {
        html += '<button class="pt-subcarpeta pt-subcarpeta--nueva" data-accion="nueva-subcarpeta">' +
            '+ Nueva subcarpeta</button>';
        if (_subcarpetaAbierta !== null) {
            html += '<span class="pt-subcarpeta-barra">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="renombrar-subcarpeta">Renombrar</button>' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="eliminar-subcarpeta">Eliminar</button>' +
                '</span>';
        }
    }

    caja.innerHTML = html;
    caja.hidden = false;
    ajustarZonaSubida();
}

/* accept y nota según el destino, para no escoger algo que se va a rechazar. */
function ajustarZonaSubida() {
    const entrada = document.getElementById('entrada-archivos');
    const nota = document.getElementById('subida-nota');
    const medios = destinoEsDeMedios(_subcarpetaAbierta);
    const enRaiz = _subcarpetaAbierta === null;
    // Las creadas a mano no restringen
    const lista = medios ? EXTENSIONES_MEDIA
                : enRaiz ? EXTENSIONES_DOCUMENTO
                : EXTENSIONES_PERMITIDAS;
    if (entrada) entrada.accept = lista.map(e => '.' + e).join(',');
    if (nota) {
        nota.textContent = (medios
            ? 'Solo grabaciones de audio o video, en cualquier formato'
            : enRaiz
                ? 'Solo el expediente escrito: PDF, Word, Excel, imágenes escaneadas. ' +
                  'Las grabaciones van en Audiencias'
                : 'Aquí puedes subir de todo: documentos, imágenes, audio y video') +
            ' · máximo ' + TAMANO_MAXIMO_TXT + ' por archivo';
    }
}

/* Subcarpetas de la carpeta abierta (vacío si falla). */
async function cargarSubcarpetas() {
    if (!carpetaAbierta || typeof subcarpetasListar !== 'function') { _subcarpetas = []; return; }
    try { _subcarpetas = await subcarpetasListar(carpetaAbierta.id); }
    catch (e) { _subcarpetas = []; }
}

/* Abre una subcarpeta o la raíz. */
function abrirSubcarpeta(id) {
    _subcarpetaAbierta = (id === '' || id === undefined || id === null) ? null : Number(id);
    _editandoOrden = false;
    pintarArchivos();
}

/* Crea una subcarpeta y la abre. */
async function nuevaSubcarpetaAccion() {
    if (!carpetaAbierta) return;
    const nombre = await pedirTextoPortal('Nombre de la subcarpeta',
        'Por ejemplo: Audiencias, Notificaciones, Soportes.', '');
    if (!nombre) return;
    try {
        const id = await subcarpetaCrear(carpetaAbierta.id, nombre);
        registrarActividad('crear-subcarpeta', nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
        await cargarSubcarpetas();
        _subcarpetaAbierta = Number(id);
        await pintarArchivos();
        avisar('Subcarpeta «' + nombre + '» creada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear la subcarpeta.', 'error');
    }
}

/* Renombra la abierta. */
async function renombrarSubcarpetaAccion() {
    if (_subcarpetaAbierta === null) return;
    const actual = nombreSubcarpeta(_subcarpetaAbierta);
    const nombre = await pedirTextoPortal('Renombrar subcarpeta', '', actual);
    if (!nombre || nombre === actual) return;
    try {
        await subcarpetaRenombrar(_subcarpetaAbierta, nombre);
        registrarActividad('renombrar-subcarpeta', actual + ' → ' + nombre, carpetaAbierta.id);
        await cargarSubcarpetas();
        await pintarArchivos();
        avisar('Subcarpeta renombrada.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo renombrar.', 'error');
    }
}

/* Borra la abierta. Los documentos vuelven a la raíz. */
async function eliminarSubcarpetaAccion() {
    if (_subcarpetaAbierta === null) return;
    const nombre = nombreSubcarpeta(_subcarpetaAbierta);
    const dentro = _archivosCache.filter(a => String(a.subcarpetaId) === String(_subcarpetaAbierta)).length;
    const aviso = dentro
        ? 'La subcarpeta «' + nombre + '» tiene ' + cuantos(dentro, 'documento', 'documentos') + '.\n\n' +
          'Los documentos no se borran: vuelven a la raíz de la carpeta.\n\n¿Eliminar la subcarpeta?'
        : '¿Eliminar la subcarpeta «' + nombre + '»?';
    if (!await confirmarPortal(aviso)) return;
    try {
        await subcarpetaEliminar(_subcarpetaAbierta);
        registrarActividad('eliminar-subcarpeta', nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
        _subcarpetaAbierta = null;
        await cargarSubcarpetas();
        await pintarArchivos();
        avisar('Subcarpeta eliminada. Sus documentos quedaron en la carpeta.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la subcarpeta.', 'error');
    }
}

/* Solo admin u operador responsable. Se edita el nombre sin la extensión. */
async function renombrarArchivoAccion(archivoId) {
    const a = _archivosCache.find(x => String(x.id) === String(archivoId));
    if (!a || !carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const ext = extensionDe(a.nombre);
    const base = ext ? a.nombre.slice(0, -(ext.length + 1)) : a.nombre;
    const nombre = await pedirTextoPortal('Renombrar documento',
        ext ? 'La extensión .' + ext + ' se conserva.' : '', base, 'Nombre', 'Guardar', 195);
    if (!nombre || nombre.trim() === base) return;
    try {
        const limpio = nombre.trim();
        const conExt = !ext || extensionDe(limpio) === ext ? limpio : limpio + '.' + ext;
        const nuevo = await archivoRenombrar(a.id, conExt);
        registrarActividad('renombrar-archivo', a.nombre + ' → ' + (nuevo || nombre), carpetaAbierta.id);
        await pintarArchivos();
        avisar('Documento renombrado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo renombrar.', 'error');
    }
}

/* Mueve un documento si el destino admite el tipo. */
async function moverArchivoAccion(archivoId, destino) {
    // Mover respeta la regla de la subida
    const arch = _archivosCache.find(x => String(x.id) === String(archivoId));
    const dest = destino === '' ? null : Number(destino);
    if (arch && !destinoAdmiteExtension(dest, extensionDe(arch.nombre))) {
        avisar('No se movió: ' + motivoRechazo(dest, arch.nombre), 'error');
        pintarArchivos();   // vuelve el selector a su valor
        return;
    }
    // Con sus anexos: todos tienen que caber en el destino
    const num = _numeracion.get(Number(archivoId));
    const anexos = num && !num.anexo ? _archivosCache.filter(x => x.anexoDe === Number(archivoId)) : [];
    const noCaben = anexos.filter(x => !destinoAdmiteExtension(dest, extensionDe(x.nombre)));
    if (noCaben.length) {
        avisar('No se movió: ' + motivoRechazo(dest, noCaben[0].nombre) + ' (es anexo de este documento).', 'error');
        pintarArchivos();
        return;
    }
    try {
        await archivoMover(archivoId, destino === '' ? null : Number(destino));
        const a = _archivosCache.find(x => String(x.id) === String(archivoId));
        registrarActividad('mover-archivo',
            (a ? a.nombre : '') + ' → ' + (destino === '' ? 'raíz' : nombreSubcarpeta(destino)),
            carpetaAbierta.id);
        await pintarArchivos();
        avisar(anexos.length
            ? 'Documento movido con ' + (anexos.length === 1 ? 'su anexo' : 'sus ' + anexos.length + ' anexos') + '.'
            : (num && num.anexo ? 'Documento movido. Ya no es anexo: quedó como documento principal.' : 'Documento movido.'));
    } catch (e) {
        avisar((e && e.message) || 'No se pudo mover el documento.', 'error');
    }
}

/* Editar documentos: de quién es anexo. Un documento con anexos no puede
   ser anexo (máximo dos niveles). */
function selectorAnexo(a, num) {
    if (num && num.anexos > 0) {
        return '<span class="pt-nota pt-anexo-nota" title="Tiene anexos: no puede ser anexo de otro">Principal</span>';
    }
    const opciones = archivosDeVistaActual()
        .filter(x => x.id !== a.id && _numeracion.get(x.id) && !_numeracion.get(x.id).anexo)
        .map(x => {
            const n = _numeracion.get(x.id).etiqueta;
            const nombre = x.nombre.length > 36 ? x.nombre.slice(0, 35) + '…' : x.nombre;
            return '<option value="' + x.id + '"' + (String(a.anexoDe) === String(x.id) ? ' selected' : '') + '>' +
                'Anexo de ' + escaparHtml(n + '. ' + nombre) + '</option>';
        }).join('');
    if (!opciones) return '';
    return '<select class="pt-mover pt-select-anexo" data-accion-cambio="fijar-anexo" data-id="' + a.id + '"' +
        ' title="Hacerlo anexo de otro documento">' +
        '<option value="">Documento principal</option>' + opciones + '</select>';
}

/* Fila de documento con acciones según el rol. Número de _numeracion. */
function filaArchivo(a, i) {
    const ext = extensionDe(a.nombre);
    const gestiona = !!(carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta));
    const descargable = a.descargablePartes !== false;
    const num = _numeracion.get(a.id);
    let acciones = '';
    if (_editandoOrden) {
        acciones =
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="orden-subir" data-id="' + a.id + '" title="Subir">' + icono('flecha-arriba', 14) + '</button> ' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="orden-bajar" data-id="' + a.id + '" title="Bajar">' + icono('flecha-abajo', 14) + '</button> ' +
            selectorAnexo(a, num);
    } else {
        // Ver siempre; la descarga se restringe
        if (EXTENSIONES_VISTA.includes(ext)) {
            acciones += '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="ver-archivo" data-id="' + a.id + '">Ver</button> ';
        }
        if ((ES_CLIENTE || ES_ACREEDOR) && !descargable) {
            acciones += '<span class="pt-nota" title="El operador no habilitó la descarga de este documento">Solo lectura</span>';
        } else {
            acciones += '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="descargar-archivo" data-id="' + a.id + '">Descargar</button>';
        }
        if (gestiona) {
            // Mover: solo si hay subcarpetas
            if (_subcarpetas.length) {
                // Solo destinos que admiten el tipo
                const destinos = (destinoAdmiteExtension(null, ext)
                        ? [['', 'Documentos']]
                        : [])
                    .concat(_subcarpetas
                        .filter(sub => destinoAdmiteExtension(sub.id, ext))
                        .map(sub => [String(sub.id), sub.nombre]));
                // Con un solo destino no hay selector
                if (destinos.length > 1) {
                    const actual = a.subcarpetaId ? String(a.subcarpetaId) : '';
                    acciones += ' <select class="pt-mover" data-accion-cambio="mover-archivo" data-id="' + a.id + '"' +
                        ' title="Mover a otra subcarpeta">' +
                        destinos.map(d => '<option value="' + d[0] + '"' +
                            (d[0] === actual ? ' selected' : '') + '>' +
                            escaparHtml(d[1]) + '</option>').join('') +
                        '</select>';
                }
            }
            acciones += ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="renombrar-archivo" data-id="' + a.id + '" title="Renombrar" aria-label="Renombrar">' +
                icono('editar', 14) + '<span class="pt-txt-celular"> Renombrar</span></button>';
            acciones += ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-archivo" data-id="' + a.id + '">Eliminar</button>';
        }
    }

    // "Descarga": si las partes pueden bajarlo
    const celdaDescarga = gestiona
        ? '<td><button type="button" class="pt-switch' + (descargable ? ' pt-switch--si' : '') + '"' +
              ' role="switch" aria-checked="' + (descargable ? 'true' : 'false') + '"' +
              ' data-accion="alternar-descarga-partes" data-id="' + a.id + '"' +
              ' title="' + (descargable ? 'Las partes pueden descargar este archivo' : 'Las partes no pueden descargar este archivo') + '">' +
              '<span class="pt-switch__bola"></span></button></td>'
        : '';

    // Cada columna con su clase: el nombre toma lo que sobra, el resto se ajusta.
    const nombreSeguro = escaparHtml(a.nombre);
    const etiqueta = num ? num.etiqueta : (Number.isInteger(i) ? String(i + 1) : '');
    const esAnexo = !!(num && num.anexo);
    // Anexo de un principal plegado: oculto (salvo editando)
    const oculto = esAnexo && !_editandoOrden && _anexosPlegados.has(num.padre);
    const clases = [_editandoOrden ? 'pt-fila-arrastrable' : '', esAnexo ? 'pt-fila-anexo' : ''].filter(Boolean).join(' ');
    // Plegar/desplegar anexos, junto al nombre
    const plegar = (num && num.anexos > 0 && !_editandoOrden)
        ? '<button type="button" class="pt-anexos-plegar" data-accion="plegar-anexos" data-id="' + a.id + '"' +
          ' aria-expanded="' + !_anexosPlegados.has(a.id) + '" title="' +
          (_anexosPlegados.has(a.id) ? 'Mostrar' : 'Ocultar') + ' sus anexos">' +
          (_anexosPlegados.has(a.id) ? '▸ ' : '▾ ') + num.anexos + (num.anexos === 1 ? ' anexo' : ' anexos') + '</button>'
        : '';
    return '<tr data-archivo-id="' + a.id + '"' + (_editandoOrden ? ' draggable="true"' : '') +
        (clases ? ' class="' + clases + '"' : '') + (oculto ? ' hidden' : '') + '>' +
        '<td class="pt-col-archivo">' +
            (_editandoOrden ? '<span class="pt-asa-arrastre" title="Arrastrar">' + icono('arrastre', 14) + '</span>' : '') +
            (etiqueta ? '<span class="pt-num-archivo">' + etiqueta + '</span>' : '') +
            '<span class="pt-icono-archivo">' + iconoArchivo(ext) + '</span>' +
            // title con el nombre completo
            '<span class="pt-nombre-archivo" title="' + nombreSeguro + '">' + nombreSeguro + '</span>' + plegar + '</td>' +
        '<td class="pt-col-tamano">' + formatoTamano(a.tamano) + '</td>' +
        ((ES_CLIENTE || ES_ACREEDOR) ? ''
            : '<td class="pt-col-autor" title="' + escaparHtml(a.subidoPor) + '">' + escaparHtml(a.subidoPor) + '</td>') +
        '<td class="pt-col-fecha">' + formatoFechaTabla(a.fecha) + '</td>' +
        celdaDescarga +
        '<td class="pt-col-acciones"><div class="pt-celda-acciones">' + acciones + '</div></td>' +
        '</tr>';
}

/* ---- Editar documentos: arrastrar o flechas ---- */
function empezarEdicionOrden() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _editandoOrden = true;
    _anexosCambiados = new Map();
    pintarArchivos();
}

/* Sale sin guardar. */
async function cancelarEdicionOrden() {
    _editandoOrden = false;
    _anexosCambiados = new Map();
    await pintarArchivos();
}

/* Sube o baja una posición. Un principal se mueve con sus anexos; un anexo,
   entre sus hermanos. */
function moverArchivoEnOrden(id, delta) {
    const vista = archivosDeVistaActual();
    const num = numerarDocumentos(vista);
    const info = num.get(id);
    if (!info) return;
    if (info.anexo) {
        const posiciones = [], hermanos = [];
        vista.forEach((x, k) => { if (num.get(x.id).padre === info.padre) { posiciones.push(k); hermanos.push(x); } });
        const i = hermanos.findIndex(x => x.id === id), j = i + delta;
        if (j < 0 || j >= hermanos.length) return;
        [hermanos[i], hermanos[j]] = [hermanos[j], hermanos[i]];
        posiciones.forEach((k, m) => { vista[k] = hermanos[m]; });
        reemplazarVistaEnCache(vista);
    } else {
        const bloques = vista.filter(x => !num.get(x.id).anexo)
            .map(p => [p, ...vista.filter(h => num.get(h.id).padre === p.id)]);
        const i = bloques.findIndex(b => b[0].id === id), j = i + delta;
        if (j < 0 || j >= bloques.length) return;
        [bloques[i], bloques[j]] = [bloques[j], bloques[i]];
        reemplazarVistaEnCache(bloques.flat());
    }
    repintarFilasOrden();
}

/* Cambia de quién es anexo (se guarda con "Guardar orden"). */
function cambiarAnexoEnEdicion(id, valor) {
    const a = _archivosCache.find(x => String(x.id) === String(id));
    if (!a) return;
    const padre = valor ? Number(valor) : null;
    a.anexoDe = padre;
    _anexosCambiados.set(a.id, padre);
    // Al volverse anexo va debajo de su principal
    reemplazarVistaEnCache(agruparAnexos(archivosDeVistaActual(), true));
    repintarFilasOrden();
}

/* Repinta la vista abierta con los números nuevos. */
function repintarFilasOrden() {
    const visibles = archivosDeVistaActual();
    _numeracion = numerarDocumentos(visibles);
    document.getElementById('lista-archivos').innerHTML = visibles.map(filaArchivo).join('');
    activarArrastreOrden();
}

/* Guarda anexos y orden. Primero se sueltan los anexos que dejan de serlo. */
async function guardarOrdenDocumentos() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    try {
        const cambios = [..._anexosCambiados.entries()].sort((x, y) => (x[1] === null ? 0 : 1) - (y[1] === null ? 0 : 1));
        for (const [id, padre] of cambios) await archivoFijarAnexo(id, padre);
        await actualizarOrdenArchivos(carpetaAbierta.id, _archivosCache.map(a => a.id));
        registrarActividad('ordenar-documentos', carpetaAbierta.nombre, carpetaAbierta.id);
        avisar('Orden de los documentos guardado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar el orden.', 'error');
    }
    _editandoOrden = false;
    _anexosCambiados = new Map();
    await pintarArchivos();
}

/* Pliega o despliega anexos (solo en esta pantalla). */
function plegarAnexos(id) {
    const clave = Number(id);
    if (_anexosPlegados.has(clave)) _anexosPlegados.delete(clave);
    else _anexosPlegados.add(clave);
    const visibles = archivosDeVistaActual();
    document.getElementById('lista-archivos').innerHTML = visibles.map(filaArchivo).join('');
}

/* Opciones de "Subir como": principal o anexo de uno de la vista. */
function pintarSelectorAnexoSubida(visibles) {
    const caja = document.getElementById('subida-anexo-caja');
    const selector = document.getElementById('subida-anexo-de');
    if (!caja || !selector) return;
    const principales = visibles.filter(x => _numeracion.get(x.id) && !_numeracion.get(x.id).anexo);
    const antes = selector.value;
    selector.innerHTML = '<option value="">Documentos principales</option>' + principales.map(x => {
        const n = _numeracion.get(x.id).etiqueta;
        const nombre = x.nombre.length > 48 ? x.nombre.slice(0, 47) + '…' : x.nombre;
        return '<option value="' + x.id + '">' + escaparHtml('Anexos de ' + n + '. ' + nombre) + '</option>';
    }).join('');
    // Mantiene la elección si el principal sigue
    if (principales.some(x => String(x.id) === antes)) selector.value = antes;
    caja.hidden = principales.length === 0;
}

/* Arrastrar filas en modo edición */
let _filaArrastrada = null;
/* Arrastrar y soltar para reordenar. */
function activarArrastreOrden() {
    const cuerpo = document.getElementById('lista-archivos');
    cuerpo.querySelectorAll('tr[draggable="true"]').forEach(tr => {
        tr.addEventListener('dragstart', () => { _filaArrastrada = tr; tr.classList.add('arrastrando'); });
        tr.addEventListener('dragend', () => { tr.classList.remove('arrastrando'); _filaArrastrada = null; });
        tr.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!_filaArrastrada || _filaArrastrada === tr) return;
            const caja = tr.getBoundingClientRect();
            const despues = e.clientY > caja.top + caja.height / 2;
            tr.parentNode.insertBefore(_filaArrastrada, despues ? tr.nextSibling : tr);
        });
        tr.addEventListener('drop', (e) => {
            e.preventDefault();
            // Sincroniza la caché con el orden en pantalla y junta cada anexo con su
            // principal (si se arrastra lejos, vuelve a su grupo).
            const ids = [...cuerpo.querySelectorAll('tr[data-archivo-id]')].map(f => Number(f.dataset.archivoId));
            const porId = new Map(_archivosCache.map(a => [a.id, a]));
            const vista = ids.map(id => porId.get(id)).filter(Boolean);
            reemplazarVistaEnCache(agruparAnexos(vista, true));
            repintarFilasOrden();
        });
    });
}

/* ============ AUDIENCIAS: CALENDARIO Y AVISO (admin/operador) ============
   Se marcan fechas en la carpeta y se avisa por correo (mailto: abre su
   correo con el mensaje listo). */
let _mesCalendario = null;      // primer día del mes mostrado
let _audienciasCache = [];      // audiencias de la carpeta
let _asignadosCache = [];       // asignados con correo

/* Audiencias marcadas de la carpeta. */
async function pintarAudiencias(carpeta) {
    const panel = document.getElementById('panel-audiencias');
    if (!panel || !carpeta || !puedeGestionarCarpeta(carpeta)) return;
    panel.innerHTML = esqueletoLista(3);
    try {
        _audienciasCache = await audienciasListar(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar las audiencias.') + '</div>';
        return;
    }
    if (!_mesCalendario) { const hoy = new Date(); _mesCalendario = new Date(hoy.getFullYear(), hoy.getMonth(), 1); }

    const lista = _audienciasCache.map(a =>
        '<div class="pt-audiencia">' +
            '<span class="pt-audiencia__ic">' + icono('calendario', 17) + '</span>' +
            '<div class="pt-audiencia__txt"><strong>' + escaparHtml(a.titulo || 'Audiencia') + '</strong>' +
                '<span>' + formatoFechaDia(a.fecha) + (a.hora ? ' · ' + escaparHtml(a.hora) : '') + '</span>' +
                (a.enlace ? '<a href="' + escaparHtml(a.enlace) + '" target="_blank" rel="noopener noreferrer">Abrir enlace de la reunión</a>' : '') +
                (a.descripcion ? '<span class="pt-nota">' + escaparHtml(a.descripcion) + '</span>' : '') +
            '</div>' +
            '<div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="notificar-audiencia-existente" data-id="' + a.id + '">' + icono('correo', 14) + ' Notificar</button>' +
                '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-audiencia" data-id="' + a.id + '">Eliminar</button>' +
            '</div>' +
        '</div>').join('');

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('calendario', 18) + ' Audiencias del proceso</h3>' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="notificar-audiencia">' +
                icono('campana', 15) + ' Notificar audiencia</button>' +
        '</div>' +
        '<p class="pt-nota">Las fechas quedan marcadas en el calendario de la derecha. ' +
            'Con «Notificar audiencia» se envía el aviso por correo a las partes.</p>' +
        '<div class="pt-audiencias-lista">' +
            (lista || '<p class="pt-nota">Todavía no hay audiencias marcadas.</p>') +
        '</div>';
    pintarCalendario(); // el mes se actualiza aunque se vea otra pestaña
}

/* Datos del calendario al abrir la carpeta. Todos lo ven; solo el personal
   marca o avisa. */
async function prepararCalendarioLateral(carpeta) {
    const cont = document.getElementById('calendario-audiencias');
    if (!cont) return;
    cont.innerHTML = '';
    const hoy = new Date();
    _mesCalendario = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    try {
        _audienciasCache = await audienciasListar(carpeta.id);
    } catch (e) {
        _audienciasCache = [];
    }
    // Rangos de estados: solo personal y monitor. Partes: solo audiencias.
    _procesosCalLateral = [];
    if (ES_PERSONAL || ES_MONITOR) {
        try { _procesosCalLateral = await procesosListar(carpeta.id); } catch (e) { _procesosCalLateral = []; }
    }
    pintarCalendario();
}
let _procesosCalLateral = [];   // procesos de la carpeta (rangos)

const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

/* Mes de audiencias, con rangos para personal y monitor. */
function pintarCalendario() {
    const cont = document.getElementById('calendario-audiencias');
    if (!cont || !_mesCalendario) return;
    // El personal marca; deudor y acreedores consultan
    const editable = carpetaAbierta && puedeGestionarCarpeta(carpetaAbierta);
    const anio = _mesCalendario.getFullYear();
    const mes = _mesCalendario.getMonth();
    const hoyISO = fechaISOLocal(new Date());
    const conAudiencia = {};
    for (const a of _audienciasCache) {
        (conAudiencia[a.fecha] = conAudiencia[a.fecha] || []).push(a.titulo || 'Audiencia');
    }

    // Rango de cada estado (inicio → vencimiento), solo personal/monitor.
    const enRango = {};   // iso → [procesos]
    for (const p of (_procesosCalLateral || [])) {
        if (p.completado || !p.fechaInicio || !p.fechaVencimiento) continue;
        const d = _aFecha(p.fechaInicio);
        const fin = _aFecha(p.fechaVencimiento);
        while (d <= fin) {
            const iso = _aISO(d);
            (enRango[iso] = enRango[iso] || []).push(p.nombre);
            d.setDate(d.getDate() + 1);
        }
    }

    // lunes = 0 … domingo = 6
    const primerDia = (new Date(anio, mes, 1).getDay() + 6) % 7;
    const diasMes = new Date(anio, mes + 1, 0).getDate();

    let celdas = '';
    for (let i = 0; i < primerDia; i++) celdas += '<span class="pt-cal__dia pt-cal__dia--vacio"></span>';
    for (let d = 1; d <= diasMes; d++) {
        const iso = anio + '-' + String(mes + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        const marcas = conAudiencia[iso];
        const rangos = enRango[iso];
        const titulo = []
            .concat(marcas || [])
            .concat((rangos || []).map(n => 'Plazo: ' + n))
            .join(' · ');
        const clases = 'pt-cal__dia' +
            (rangos ? ' pt-cal__dia--rango' : '') +
            (marcas ? ' pt-cal__dia--audiencia' : '') +
            (iso === hoyISO ? ' pt-cal__dia--hoy' : '');
        if (editable) {
            celdas += '<button type="button" class="' + clases + '"' +
                ' data-accion="dia-calendario" data-fecha="' + iso + '"' +
                ' title="' + (titulo ? escaparHtml(titulo) : 'Marcar audiencia este día') + '"' +
                '>' + d + '</button>';
        } else {
            celdas += '<span class="' + clases + ' pt-cal__dia--solo"' +
                (titulo ? ' title="' + escaparHtml(titulo) + '"' : '') +
                '>' + d + '</span>';
        }
    }

    // Próximas audiencias (máx. 3)
    const proximas = _audienciasCache
        .filter(a => a.fecha >= hoyISO)
        .slice(0, 3)
        .map(a =>
            '<div class="pt-cal-prox__item">' +
                '<strong>' + escaparHtml(a.titulo || 'Audiencia') + '</strong>' +
                '<span>' + formatoFechaDia(a.fecha) + (a.hora ? ' · ' + escaparHtml(a.hora) : '') + '</span>' +
                (a.enlace ? '<a href="' + escaparHtml(a.enlace) + '" target="_blank" rel="noopener noreferrer">Enlace de la reunión</a>' : '') +
                (a.descripcion ? '<span class="pt-nota">' + escaparHtml(a.descripcion) + '</span>' : '') +
            '</div>').join('');

    cont.innerHTML =
        '<div class="pt-cal__barra">' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-mes" data-delta="-1" aria-label="Mes anterior">‹</button>' +
            '<strong>' + MESES[mes].charAt(0).toUpperCase() + MESES[mes].slice(1) + ' ' + anio + '</strong>' +
            '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="cal-mes" data-delta="1" aria-label="Mes siguiente">›</button>' +
        '</div>' +
        '<div class="pt-cal__semana"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>' +
        '<div class="pt-cal__rejilla">' + celdas + '</div>' +
        // Leyenda: azul audiencias, naranja estados
        '<p class="pt-nota pt-cal__pie"><span class="pt-cal__punto"></span> Audiencias' +
            ((ES_PERSONAL || ES_MONITOR) ? ' · <span class="pt-cal__cuadro-rango"></span> Estados' : '') + '</p>' +
        (proximas
            ? '<div class="pt-cal-prox"><h4>Próximas audiencias</h4>' + proximas + '</div>'
            : '');
}

/* Mes siguiente o anterior. */
function cambiarMesCalendario(delta) {
    if (!_mesCalendario) return;
    _mesCalendario = new Date(_mesCalendario.getFullYear(), _mesCalendario.getMonth() + Number(delta || 0), 1);
    pintarCalendario();
}

/* Fecha larga en español desde ISO. */
/* 'AAAA-MM-DD' → '24 nov 2026' (para columnas angostas). */
function formatoFechaCorta(iso) {
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
                 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return d + ' ' + (MES[m - 1] || '') + ' ' + a;
}

function formatoFechaDia(iso) {
    // 'AAAA-MM-DD' → 'lunes, 20 de agosto de 2026' (sin correr el día)
    const [a, m, d] = String(iso).split('-').map(Number);
    if (!a || !m || !d) return String(iso);
    const t = new Date(a, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/* Quita una audiencia. */
async function eliminarAudiencia(id) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    if (!await confirmarPortal('¿Quitar esta audiencia del calendario?')) return;
    try {
        await audienciaEliminar(id);
        avisar('Audiencia eliminada del calendario.');
        await pintarAudiencias(carpetaAbierta);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar la audiencia.', 'error');
    }
}

/* ---- Notificar audiencia ---- */
let _audienciaExistenteId = null;   // si ya estaba marcada, no se duplica

/* Formulario para avisar una audiencia. */
async function abrirModalAudiencia(prefijado) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _audienciaExistenteId = (prefijado && prefijado.id) || null;
    const cont = document.getElementById('audiencia-destinatarios');
    cont.innerHTML = esqueletoLista(3);
    document.getElementById('audiencia-titulo').value = (prefijado && prefijado.titulo) || '';
    document.getElementById('audiencia-fecha').value = (prefijado && prefijado.fecha) || '';
    document.getElementById('audiencia-hora').value = (prefijado && prefijado.hora) || '';
    document.getElementById('audiencia-enlace').value = (prefijado && prefijado.enlace) || '';
    document.getElementById('audiencia-descripcion').value = (prefijado && prefijado.descripcion) || '';
    document.getElementById('modal-audiencia').hidden = false;

    try {
        _asignadosCache = await asignadosDeCarpeta(carpetaAbierta.id);
    } catch (e) {
        cont.innerHTML = '<p class="pt-nota">' + escaparHtml((e && e.message) || 'No se pudieron cargar los asignados.') + '</p>';
        return;
    }
    if (_asignadosCache.length === 0) {
        cont.innerHTML = '<p class="pt-nota">Esta carpeta no tiene deudores ni acreedores asignados.</p>';
        return;
    }
    cont.innerHTML = _asignadosCache.map(p =>
        '<label><input type="checkbox" value="' + escaparHtml(p.usuario) + '"' + (p.correo ? '' : ' disabled') + '> ' +
        escaparHtml(p.nombre) + ' <span class="pt-nota">(' + escaparHtml(ETIQUETAS_ROL[p.rol] || p.rol) + ' · ' +
        (p.correo ? escaparHtml(p.correo) : 'sin correo registrado') + ')</span></label>').join('');
}

/* Cierra el formulario. */
function cerrarModalAudiencia() {
    document.getElementById('modal-audiencia').hidden = true;
    _audienciaExistenteId = null;
}

/* Marca la audiencia y avisa a las partes. */
async function enviarNotificacionAudiencia(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const titulo = document.getElementById('audiencia-titulo').value.trim();
    const fecha = document.getElementById('audiencia-fecha').value;
    const hora = document.getElementById('audiencia-hora').value;
    const enlace = document.getElementById('audiencia-enlace').value.trim();
    const descripcionAud = document.getElementById('audiencia-descripcion').value.trim();
    const marcados = [...document.querySelectorAll('#audiencia-destinatarios input:checked')].map(c => c.value);
    const destinatarios = _asignadosCache.filter(p => marcados.includes(p.usuario) && p.correo);

    if (!titulo || !fecha || !hora) { avisar('Completa el nombre, la fecha y la hora de la audiencia.', 'error'); return; }
    if (destinatarios.length === 0) { avisar('Selecciona al menos un destinatario con correo registrado.', 'error'); return; }

    // 1) Al calendario (si no estaba marcada)
    try {
        if (!_audienciaExistenteId) {
            await audienciaGuardar(carpetaAbierta.id, { titulo, fecha, hora, enlace, descripcion: descripcionAud });
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar la audiencia.', 'error');
        return;
    }

    // 2) Abre el correo del operador con el mensaje listo
    const asunto = 'Citación a audiencia: ' + titulo;
    const cuerpo =
        'Cordial saludo,\n\n' +
        NOMBRE_ENTIDAD + ' le informa que se ha programado la siguiente audiencia dentro de su trámite:\n\n' +
        'Reunión: ' + titulo + '\n' +
        'Fecha: ' + formatoFechaDia(fecha) + '\n' +
        'Hora: ' + hora + '\n' +
        (enlace ? 'Enlace de la reunión (Meet): ' + enlace + '\n' : '') +
        (descripcionAud ? 'Detalles: ' + descripcionAud + '\n' : '') +
        '\nProceso: ' + carpetaAbierta.nombre + '\n\n' +
        'Por favor conéctese puntualmente. Si tiene inquietudes, responda este correo.\n\n' +
        'Atentamente,\n' + (sesion.nombre || sesion.usuario) + '\n' + NOMBRE_ENTIDAD + '.';
    const enlaceCorreo = document.createElement('a');
    enlaceCorreo.href = 'mailto:' + destinatarios.map(p => encodeURIComponent(p.correo)).join(',') +
        '?subject=' + encodeURIComponent(asunto) + '&body=' + encodeURIComponent(cuerpo);
    document.body.appendChild(enlaceCorreo);
    enlaceCorreo.click();
    enlaceCorreo.remove();

    registrarActividad('notificar-audiencia', titulo + ' (' + fecha + ' ' + hora + ') · ' +
        carpetaAbierta.nombre + ' · ' + cuantos(destinatarios.length, 'destinatario', 'destinatarios'), carpetaAbierta.id);
    avisar('Se abrió tu correo con la notificación lista para ' + cuantos(destinatarios.length, 'destinatario', 'destinatarios') + '.');
    cerrarModalAudiencia();
    await refrescarAudiencias();
}

/* Recarga audiencias y repinta */
async function refrescarAudiencias() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    if (_subPanelCarpeta === 'audiencias') {
        await pintarAudiencias(carpetaAbierta);   // ya recarga caché y calendario
        return;
    }
    try {
        _audienciasCache = await audienciasListar(carpetaAbierta.id);
        pintarCalendario();
    } catch (e) { /* se actualiza al volver a la pestaña */ }
}

/* ============ RECORDATORIOS PERSONALES ============ */
let _recordatorioEditandoId = null;

/* Recordatorios privados de esta carpeta. */
async function pintarRecordatorios(carpeta) {
    const panel = document.getElementById('panel-recordatorios');
    if (!panel || !carpeta || !puedeGestionarCarpeta(carpeta)) return;
    panel.innerHTML = esqueletoLista(3);
    let lista = [];
    try {
        lista = await recordatoriosListar(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudieron cargar los recordatorios.') + '</div>';
        return;
    }
    const hoy = fechaISOLocal(new Date());
    const filas = lista.map(r => {
        const vigente = r.fechaInicio <= hoy && hoy <= r.fechaFin;
        return '<div class="pt-recordatorio' + (vigente ? ' pt-recordatorio--vigente' : '') + '">' +
            '<span class="pt-recordatorio__ic">' + icono('campana', 17) + '</span>' +
            '<div class="pt-recordatorio__txt">' +
                '<p>' + escaparHtml(r.mensaje) + '</p>' +
                '<span class="pt-nota">Del ' + formatoFechaDia(r.fechaInicio) + ' al ' + formatoFechaDia(r.fechaFin) +
                (vigente ? ' · <strong>vigente</strong>' : '') + '</span>' +
            '</div>' +
            '<div class="pt-celda-acciones">' +
                '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-recordatorio" data-id="' + r.id + '">Editar</button>' +
                '<button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-recordatorio" data-id="' + r.id + '">Eliminar</button>' +
            '</div>' +
        '</div>';
    }).join('');

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('campana', 18) + ' Mis recordatorios de esta carpeta</h3>' +
            '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="nuevo-recordatorio">+ Nuevo recordatorio</button>' +
        '</div>' +
        '<p class="pt-nota">Son privados: solo tú los ves. Mientras estén vigentes, aparecen en una ' +
            'ventana emergente cada vez que ingresas al portal.</p>' +
        (filas || '<p class="pt-nota" style="padding:.6rem 0;">No tienes recordatorios en esta carpeta.</p>');
    _recordatoriosPanelCache = lista;
}
let _recordatoriosPanelCache = [];

/* Abre el formulario. */
function abrirModalRecordatorio(recordatorio) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _recordatorioEditandoId = (recordatorio && recordatorio.id) || null;
    document.getElementById('modal-recordatorio-titulo').innerHTML =
        icono('campana', 18) + (recordatorio ? ' Editar recordatorio' : ' Nuevo recordatorio');
    document.getElementById('recordatorio-mensaje').value = (recordatorio && recordatorio.mensaje) || '';
    document.getElementById('recordatorio-desde').value = (recordatorio && recordatorio.fechaInicio) || '';
    document.getElementById('recordatorio-hasta').value = (recordatorio && recordatorio.fechaFin) || '';
    document.getElementById('modal-recordatorio').hidden = false;
    document.getElementById('recordatorio-mensaje').focus();
}

/* Cierra el formulario. */
function cerrarModalRecordatorio() {
    document.getElementById('modal-recordatorio').hidden = true;
    _recordatorioEditandoId = null;
}

/* Guarda el recordatorio. */
async function guardarRecordatorio(evento) {
    evento.preventDefault();
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const mensaje = document.getElementById('recordatorio-mensaje').value.trim();
    const fechaInicio = document.getElementById('recordatorio-desde').value;
    const fechaFin = document.getElementById('recordatorio-hasta').value;
    if (!mensaje || !fechaInicio || !fechaFin) { avisar('Completa el mensaje y el rango de fechas.', 'error'); return; }
    if (fechaFin < fechaInicio) { avisar('La fecha final no puede ser anterior a la inicial.', 'error'); return; }
    try {
        await recordatorioGuardar({
            id: _recordatorioEditandoId, carpetaId: carpetaAbierta.id,
            mensaje, fechaInicio, fechaFin
        });
        avisar(_recordatorioEditandoId ? 'Recordatorio actualizado.' : 'Recordatorio creado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo guardar el recordatorio.', 'error');
        return;
    }
    cerrarModalRecordatorio();
    await pintarRecordatorios(carpetaAbierta);
}

/* Borra (con confirmación). */
async function eliminarRecordatorio(id) {
    if (!await confirmarPortal('¿Eliminar este recordatorio?')) return;
    try {
        await recordatorioEliminar(id);
        avisar('Recordatorio eliminado.');
        if (carpetaAbierta) await pintarRecordatorios(carpetaAbierta);
    } catch (e) {
        avisar((e && e.message) || 'No se pudo eliminar el recordatorio.', 'error');
    }
}

/* Recordatorios vigentes al entrar, apilados: uno a la vez ("1 de N"). */
let _pilaRecordatorios = [];

/* Muestra los que ya llegaron. */
async function mostrarRecordatoriosVigentes() {
    if (!ES_PERSONAL) return;
    try { _pilaRecordatorios = (await recordatoriosVigentes()) || []; } catch (e) { return; }
    pintarPilaRecordatorios();
}

/* Pila de avisos en la esquina. */
function pintarPilaRecordatorios() {
    const popup = document.getElementById('popup-recordatorios');
    if (!popup) return;
    if (_pilaRecordatorios.length === 0) { popup.hidden = true; return; }
    const r = _pilaRecordatorios[0];
    const detras = Math.min(_pilaRecordatorios.length - 1, 2); // hasta 2 sombras detrás
    let sombras = '';
    for (let i = detras; i >= 1; i--) {
        sombras += '<div class="pt-pila-sombra" style="transform:translate(' + (i * 6) + 'px,' + (i * 6) + 'px);"></div>';
    }
    document.getElementById('popup-recordatorios-lista').innerHTML =
        '<div class="pt-pila">' + sombras +
        '<div class="pt-popup-recordatorios__item pt-pila-frente">' +
            '<p>' + escaparHtml(r.mensaje) + '</p>' +
            '<span class="pt-nota">' + escaparHtml(r.carpetaNombre || '') +
                ' · hasta el ' + formatoFechaDia(r.fechaFin) + '</span>' +
            '<span class="pt-nota"><strong>1 de ' + _pilaRecordatorios.length + '</strong>' +
                (_pilaRecordatorios.length > 1 ? ' · al cerrar verás el siguiente' : '') + '</span>' +
        '</div></div>';
    popup.hidden = false;
}

/* Cierra el visible y muestra el siguiente */
function cerrarRecordatorioVisible() {
    _pilaRecordatorios.shift();
    pintarPilaRecordatorios();
}

/* ============ NOTIFICACIONES DE LA CARPETA ============
   Lo que hicieron las partes en esta carpeta: entradas, vistas y descargas. */
// Acciones de las partes que quedan como constancia
const ACCIONES_NOTIF_CARPETA = ['ingreso', 'abrir-carpeta', 'ver-archivo', 'descargar-archivo', 'descargar-zip'];
let _notifCarpetaCache = [];        // actividad de la carpeta abierta
let _rolNotifCarpeta = 'cliente';   // 'cliente' (deudor) | 'acreedor'
let _acreedorNotifSel = '';         // acreedor elegido ('' = todos)

/* Panel de notificaciones con filtros. */
async function pintarNotifCarpeta(carpeta) {
    const panel = document.getElementById('panel-notif-carpeta');
    if (!panel || !carpeta || !(puedeGestionarCarpeta(carpeta) || ES_MONITOR)) return;
    panel.innerHTML = esqueletoLista(5);
    let eventos = [];
    try {
        eventos = await listarActividadDeCarpeta(carpeta.id);
    } catch (e) {
        panel.innerHTML = '<div class="pt-vacio">' + escaparHtml((e && e.message) || 'No se pudo cargar la actividad.') + '</div>';
        return;
    }
    _notifCarpetaCache = eventos.filter(e =>
        ['cliente', 'acreedor'].includes(e.rol) && ACCIONES_NOTIF_CARPETA.includes(e.accion));

    const deudor = _notifCarpetaCache.filter(e => e.rol === 'cliente').length;
    const acreedores = _notifCarpetaCache.filter(e => e.rol === 'acreedor').length;

    panel.innerHTML =
        '<div class="pt-audiencias-cab">' +
            '<h3>' + icono('ingreso', 18) + ' Notificaciones de esta carpeta</h3>' +
            '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="refrescar-notif-carpeta">' +
                icono('refrescar', 14) + ' Actualizar</button>' +
        '</div>' +
        '<p class="pt-nota">Entradas, vistas y descargas de las partes de este trámite, separadas por tipo:</p>' +
        // Deudor y acreedores por separado
        '<div class="pt-sub-pestanas" id="sub-pestanas-notif-carpeta">' +
            '<button class="' + (_rolNotifCarpeta === 'cliente' ? 'activa' : '') + '" data-accion="notif-carpeta-rol" data-rol="cliente">' +
                icono('usuario', 17) + ' Deudor (' + deudor + ')</button>' +
            '<button class="' + (_rolNotifCarpeta === 'acreedor' ? 'activa' : '') + '" data-accion="notif-carpeta-rol" data-rol="acreedor">' +
                icono('banco', 17) + ' Acreedores (' + acreedores + ')</button>' +
        '</div>' +
        // La barra de acreedores solo en esa pestaña (pintarListaNotifCarpeta)
        '<div id="barra-acreedores-notif"></div>' +
        '<div id="lista-notif-carpeta"></div>';
    pintarListaNotifCarpeta();
}

/* Constancia en PDF de lo que hicieron los acreedores (todos o uno). */
async function descargarConstanciaAcreedores() {
    if (!carpetaAbierta) return;
    const sel = document.getElementById('constancia-acreedor');
    const usuarioElegido = sel ? sel.value : '';
    const eventos = _notifCarpetaCache.filter(e =>
        e.rol === 'acreedor' && (!usuarioElegido || e.usuario === usuarioElegido));
    if (eventos.length === 0) {
        avisar('No hay actividad de ' + (usuarioElegido ? 'ese acreedor' : 'acreedores') + ' para la constancia.', 'error');
        return;
    }
    try {
        const PDFLib = await cargarPdfLib();
        const doc = await PDFLib.PDFDocument.create();
        const fuente = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const fuenteNegrita = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);

        let pagina = doc.addPage([612, 792]);
        let y = 742;
        const nuevaLinea = (texto, negrita, tam) => {
            if (y < 60) { pagina = doc.addPage([612, 792]); y = 742; }
            pagina.drawText(texto, { x: 50, y, size: tam || 10, font: negrita ? fuenteNegrita : fuente });
            y -= (tam ? tam + 6 : 15);
        };

        nuevaLinea('Portal Documental', true, 16);
        nuevaLinea('Constancia de actividad de acreedores en el tramite', true, 12);
        nuevaLinea('');
        nuevaLinea('Tramite: ' + carpetaAbierta.nombre, true);
        nuevaLinea('Alcance: ' + (usuarioElegido ? 'acreedor ' + nombreDe(usuarioElegido) + ' (' + usuarioElegido + ')' : 'todos los acreedores'));
        nuevaLinea('Generada: ' + formatoFecha(Date.now()) + ' por ' + (sesion.nombre || sesion.usuario));
        nuevaLinea('Total de eventos: ' + eventos.length);
        nuevaLinea('');
        for (const e of eventos) {
            const info = VERBOS_ACCION[e.accion] || { verbo: e.accion };
            nuevaLinea('- ' + formatoFecha(e.fecha) + ' | ' + (e.nombre || e.usuario) + ' ' + info.verbo +
                (e.objetivo ? ' "' + e.objetivo + '"' : ''));
        }

        const bytes = await doc.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = 'constancia_acreedores_' + nombreArchivoSeguro(carpetaAbierta.nombre) + '.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('constancia-acreedores', carpetaAbierta.nombre +
            (usuarioElegido ? ' · ' + usuarioElegido : ' · todos'), carpetaAbierta.id);
        avisar('Constancia descargada: ' + cuantos(eventos.length, 'evento', 'eventos') + '.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar la constancia.', 'error');
    }
}

/* Filtro por rol. */
function cambiarRolNotifCarpeta(rol) {
    if (rol !== 'cliente' && rol !== 'acreedor') return;
    _rolNotifCarpeta = rol;
    _acreedorNotifSel = '';   // al cambiar de pestaña, vuelve a "todos"
    document.querySelectorAll('#sub-pestanas-notif-carpeta button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarListaNotifCarpeta();
}

/* Filtro por acreedor. */
function cambiarAcreedorNotif(usuario) {
    _acreedorNotifSel = usuario || '';
    pintarListaNotifCarpeta();
}

/* Lista filtrada. */
function pintarListaNotifCarpeta() {
    const lista = document.getElementById('lista-notif-carpeta');
    if (!lista) return;

    // Selector de acreedor solo en "Acreedores" (el deudor es uno por carpeta).
    const barra = document.getElementById('barra-acreedores-notif');
    if (barra) {
        if (_rolNotifCarpeta === 'acreedor') {
            const acreedores = [...new Set(_notifCarpetaCache.filter(e => e.rol === 'acreedor').map(e => e.usuario))];
            barra.hidden = false;
            barra.innerHTML = '<div class="pt-calv-filtros">' +
                '<label class="pt-nota">Acreedor: <select id="constancia-acreedor">' +
                    '<option value="">Todos los acreedores</option>' +
                    acreedores.map(u => '<option value="' + escaparHtml(u) + '"' +
                        (_acreedorNotifSel === u ? ' selected' : '') + '>' + escaparHtml(nombreDe(u)) + '</option>').join('') +
                '</select></label> ' +
                '<button class="pt-boton pt-boton--primario pt-boton--mini" data-accion="descargar-constancia-acreedores">' +
                    icono('descargar', 14) + ' Descargar constancia (PDF)' +
                    (_acreedorNotifSel ? ' de ' + escaparHtml(nombreDe(_acreedorNotifSel)) : '') + '</button>' +
                '</div>';
            const sel = document.getElementById('constancia-acreedor');
            if (sel) sel.addEventListener('change', (e) => cambiarAcreedorNotif(e.target.value));
        } else {
            barra.hidden = true;
            barra.innerHTML = '';
        }
    }

    let eventos = _notifCarpetaCache.filter(e => e.rol === _rolNotifCarpeta);
    // filtro por acreedor
    if (_rolNotifCarpeta === 'acreedor' && _acreedorNotifSel) {
        eventos = eventos.filter(e => e.usuario === _acreedorNotifSel);
    }
    if (eventos.length === 0) {
        lista.innerHTML = '<p class="pt-nota" style="padding:.8rem 0;">Todavía no hay actividad ' +
            (_rolNotifCarpeta === 'cliente' ? 'del deudor'
                : (_acreedorNotifSel ? 'de ' + escaparHtml(nombreDe(_acreedorNotifSel)) : 'de los acreedores')) +
            ' en esta carpeta.</p>';
        return;
    }
    let html = '';
    let diaActual = '';
    for (const e of eventos) {
        const dia = new Date(e.fecha).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        if (dia !== diaActual) {
            diaActual = dia;
            html += '<p class="pt-notif-dia">' + escaparHtml(dia.charAt(0).toUpperCase() + dia.slice(1)) + '</p>';
        }
        const info = VERBOS_ACCION[e.accion] || { ic: 'adjunto', verbo: e.accion };
        const hora = new Date(e.fecha).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        html += '<div class="pt-notif">' +
            '<span class="pt-notif__icono">' + icono(info.ic) + '</span>' +
            '<div class="pt-notif__texto">' +
                '<p><strong>' + escaparHtml(e.nombre || e.usuario) + '</strong>' +
                ' <span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[e.rol] || e.rol) + '</span> ' +
                escaparHtml(info.verbo) +
                (e.objetivo ? ' <span class="pt-notif__objetivo">«' + escaparHtml(e.objetivo) + '»</span>' : '') + '</p>' +
                '<p class="pt-notif__hora">' + hora + '</p>' +
            '</div>' +
        '</div>';
    }
    lista.innerHTML = html;
}

/* ============ EXPEDIENTE UNIFICADO (PDF, admin/operador) ============
   El orden de selección es el orden del PDF (se puede ajustar). Se unen
   PDF e imágenes; Word, Excel, audio y video no. */
const EXTENSIONES_EXPEDIENTE = ['pdf', 'png', 'jpg', 'jpeg'];
let _seleccionExpediente = [];   // ids en orden de selección

/* Selector del expediente. */
async function abrirModalExpediente() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    _seleccionExpediente = [];
    document.getElementById('modal-expediente').hidden = false;
    const lista = document.getElementById('expediente-lista');
    lista.innerHTML = esqueletoLista(5, false);
    const archivos = ordenarArchivos(await dbArchivosDeCarpeta(carpetaAbierta.id));
    _archivosCache = archivos;
    if (archivos.length === 0) {
        lista.innerHTML = '<p class="pt-nota">Esta carpeta no tiene documentos.</p>';
        document.getElementById('expediente-aviso').textContent = '';
        pintarBotonExpediente();
        return;
    }
    // Número del documento en la tabla (1, 1.1…); el de la izquierda es el orden del PDF
    const etiquetas = new Map();
    const porVista = new Map();
    archivos.forEach(a => {
        const clave = a.subcarpetaId ? String(a.subcarpetaId) : '';
        if (!porVista.has(clave)) porVista.set(clave, []);
        porVista.get(clave).push(a);
    });
    porVista.forEach((grupo, clave) => {
        const nums = numerarDocumentos(grupo);
        grupo.forEach(a => etiquetas.set(a.id, {
            texto: (clave ? nombreSubcarpeta(clave) + ' · ' : '') + nums.get(a.id).etiqueta,
            anexo: nums.get(a.id).anexo
        }));
    });
    lista.innerHTML = archivos.map(a => {
        const ext = extensionDe(a.nombre);
        const fusionable = EXTENSIONES_EXPEDIENTE.includes(ext);
        const etq = etiquetas.get(a.id);
        return '<label class="pt-expediente-item' + (fusionable ? '' : ' pt-expediente-item--no') +
            (etq && etq.anexo ? ' pt-expediente-item--anexo' : '') + '" data-id="' + a.id + '">' +
            '<span class="pt-expediente-item__num" data-num></span>' +
            '<input type="checkbox" data-accion-cambio="chequeo-expediente" value="' + a.id + '"' + (fusionable ? '' : ' disabled') + '>' +
            '<span class="pt-icono-archivo">' + iconoArchivo(ext) + '</span>' +
            '<span class="pt-expediente-item__nombre">' +
                (etq ? '<span class="pt-expediente-item__doc">' + escaparHtml(etq.texto) + '</span> ' : '') +
                escaparHtml(a.nombre) +
                (fusionable ? '' : ' <span class="pt-nota">(no se puede unir al PDF)</span>') + '</span>' +
            '<span class="pt-celda-acciones" data-flechas hidden>' +
                '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="expediente-subir" data-id="' + a.id + '" title="Subir en el orden">' + icono('flecha-arriba', 14) + '</button>' +
                '<button type="button" class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="expediente-bajar" data-id="' + a.id + '" title="Bajar en el orden">' + icono('flecha-abajo', 14) + '</button>' +
            '</span>' +
        '</label>';
    }).join('');
    document.getElementById('expediente-aviso').textContent =
        'Solo se unen PDF e imágenes (PNG/JPG). Word, Excel, audio y video no pueden fusionarse en un PDF.';
    pintarBotonExpediente();
}

/* Cierra y limpia. */
function cerrarModalExpediente() {
    document.getElementById('modal-expediente').hidden = true;
    _seleccionExpediente = [];
}

/* Marca o desmarca (el orden de marcado es el del PDF). */
function alternarSeleccionExpediente(id, marcado) {
    if (marcado) {
        if (!_seleccionExpediente.includes(id)) _seleccionExpediente.push(id);
    } else {
        _seleccionExpediente = _seleccionExpediente.filter(x => x !== id);
    }
    pintarNumerosExpediente();
}

/* Sube o baja en el orden. */
function moverSeleccionExpediente(id, delta) {
    const i = _seleccionExpediente.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= _seleccionExpediente.length) return;
    [_seleccionExpediente[i], _seleccionExpediente[j]] = [_seleccionExpediente[j], _seleccionExpediente[i]];
    pintarNumerosExpediente();
}

/* Renumera después de cada cambio. */
function pintarNumerosExpediente() {
    document.querySelectorAll('#expediente-lista .pt-expediente-item').forEach(item => {
        const id = Number(item.dataset.id);
        const pos = _seleccionExpediente.indexOf(id);
        const num = item.querySelector('[data-num]');
        const flechas = item.querySelector('[data-flechas]');
        num.textContent = pos >= 0 ? String(pos + 1) : '';
        item.classList.toggle('pt-expediente-item--elegido', pos >= 0);
        if (flechas) flechas.hidden = pos < 0;
    });
    pintarBotonExpediente();
}

/* Botón con el número de seleccionados. */
function pintarBotonExpediente() {
    const boton = document.getElementById('boton-crear-expediente');
    boton.disabled = _seleccionExpediente.length === 0;
    boton.textContent = _seleccionExpediente.length > 0
        ? 'Generar PDF (' + _seleccionExpediente.length + ' documento' + (_seleccionExpediente.length === 1 ? '' : 's') + ')'
        : 'Generar PDF';
}

/* ---- Reparación de PDF a nivel de bytes ----
   Dos daños comunes (juzgados, escáneres, reenvíos):
   a) el catálogo apunta a un árbol de páginas que no existe
   b) archivo cortado, sin xref ni trailer
   Se buscan los objetos reales y se reescribe la entrada. Los reemplazos
   NO cambian la longitud (se rellena con espacios): el xref son posiciones en bytes. */

/* Un byte por carácter, sin pérdida ('latin1' de TextDecoder es windows-1252). */
function bytesATexto(bytes) {
    const u = new Uint8Array(bytes);
    let salida = '';
    // Por trozos: fromCharCode con millones de elementos desborda la pila
    for (let i = 0; i < u.length; i += 8192) {
        salida += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    }
    return salida;
}

function textoABytes(texto) {
    const u = new Uint8Array(texto.length);
    for (let i = 0; i < texto.length; i++) u[i] = texto.charCodeAt(i) & 0xff;
    return u;
}

/* Repara el PDF: bytes nuevos o null. */
function repararPdf(bytes) {
    let t = bytesATexto(bytes);
    let tocado = false;

    // Objetos que existen en el archivo
    const objetos = new Map();   // número → posición
    const reObj = /(\d+)\s+0\s+obj\b/g;
    let m;
    while ((m = reObj.exec(t)) !== null) objetos.set(Number(m[1]), m.index);
    if (objetos.size === 0) return null;   // nada que rescatar

    // Cuerpo de un objeto, para ver su tipo
    const cuerpoDe = (num) => {
        const ini = objetos.get(num);
        if (ini === undefined) return '';
        const fin = t.indexOf('endobj', ini);
        return t.slice(ini, fin === -1 ? Math.min(ini + 2048, t.length) : fin);
    };

    // Árbol de páginas real (/Type /Pages con /Kids)
    let raizPaginas = null;
    for (const num of objetos.keys()) {
        const c = cuerpoDe(num);
        if (/\/Type\s*\/Pages\b/.test(c) && /\/Kids/.test(c)) { raizPaginas = num; break; }
    }
    // Catálogo real
    let catalogo = null;
    for (const num of objetos.keys()) {
        if (/\/Type\s*\/Catalog\b/.test(cuerpoDe(num))) { catalogo = num; break; }
    }

    /* Reescribe una referencia sin cambiar el largo (null si no cabe). */
    const reescribir = (texto, desde, largo, clave, numero) => {
        const nuevo = '/' + clave + ' ' + numero + ' 0 R';
        if (nuevo.length > largo) return null;
        return texto.slice(0, desde) + nuevo + ' '.repeat(largo - nuevo.length) +
               texto.slice(desde + largo);
    };

    // a) catálogo → árbol inexistente
    if (catalogo !== null && raizPaginas !== null) {
        const c = cuerpoDe(catalogo);
        const ref = /\/Pages\s+(\d+)\s*0\s*R/.exec(c);
        if (ref && !objetos.has(Number(ref[1])) && Number(ref[1]) !== raizPaginas) {
            const desde = objetos.get(catalogo) + ref.index;
            const arreglado = reescribir(t, desde, ref[0].length, 'Pages', raizPaginas);
            if (arreglado) { t = arreglado; tocado = true; }
        }
    }

    // b) /Root del trailer que no lleva a nada
    if (catalogo !== null) {
        const posTrailer = t.lastIndexOf('trailer');
        if (posTrailer !== -1) {
            const cola = t.slice(posTrailer);
            const ref = /\/Root\s+(\d+)\s*0\s*R/.exec(cola);
            if (ref && !objetos.has(Number(ref[1]))) {
                const desde = posTrailer + ref.index;
                const arreglado = reescribir(t, desde, ref[0].length, 'Root', catalogo);
                if (arreglado) { t = arreglado; tocado = true; }
            }
        } else {
            // Sin trailer (cortado): se le pega uno al final. Aquí el largo da igual.
            const mayor = Math.max(...objetos.keys());
            t += '\ntrailer\n<< /Size ' + (mayor + 1) + ' /Root ' + catalogo +
                 ' 0 R >>\nstartxref\n0\n%%EOF\n';
            tocado = true;
        }
    }

    return tocado ? textoABytes(t).buffer : null;
}

/* ---- Reconstrucción completa del PDF ----
   Para archivos cortados a los que les faltan páginas:
   1. objetos completos (con endobj); el último a medias se descarta
   2. catálogo, árbol de páginas y páginas que quedaron
   3. árbol nuevo solo con esas
   4. archivo nuevo con xref calculado
   Lo perdido no vuelve, pero entran las páginas que quedaron. */
function reconstruirPdf(bytes) {
    const t = bytesATexto(bytes);

    // 1) Objetos completos
    const objetos = new Map();   // número → cuerpo
    const re = /(\d+)\s+0\s+obj\b/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        const fin = t.indexOf('endobj', m.index);
        if (fin === -1) continue;                    // a medias
        const num = Number(m[1]);
        const cuerpo = t.slice(m.index + m[0].length, fin);
        objetos.set(num, cuerpo);                    // gana el último
    }
    if (objetos.size === 0) return null;

    // 2) Catálogo, árbol y páginas
    let catalogo = null, raiz = null;
    const paginas = [];
    for (const [num, cuerpo] of objetos) {
        if (catalogo === null && /\/Type\s*\/Catalog\b/.test(cuerpo)) catalogo = num;
        else if (raiz === null && /\/Type\s*\/Pages\b/.test(cuerpo)) raiz = num;
        else if (/\/Type\s*\/Page\b/.test(cuerpo)) paginas.push(num);
    }
    if (!paginas.length) return null;                // sin páginas no hay nada
    paginas.sort((a, b) => a - b);

    // 3) Árbol y catálogo nuevos
    if (raiz === null) { raiz = Math.max(...objetos.keys()) + 1; }
    objetos.set(raiz, '\n<< /Type /Pages /Kids [' +
        paginas.map(n => ' ' + n + ' 0 R').join('') +
        ' ] /Count ' + paginas.length + ' >>\n');
    if (catalogo === null) { catalogo = raiz + 1; }
    objetos.set(catalogo, '\n<< /Type /Catalog /Pages ' + raiz + ' 0 R >>\n');

    // Cada página cuelga del árbol nuevo
    for (const n of paginas) {
        let c = objetos.get(n);
        c = /\/Parent\s+\d+\s*0\s*R/.test(c)
            ? c.replace(/\/Parent\s+\d+\s*0\s*R/, '/Parent ' + raiz + ' 0 R')
            : c.replace('<<', '<< /Parent ' + raiz + ' 0 R');
        objetos.set(n, c);
    }

    // 4) Archivo nuevo con posiciones
    const numeros = [...objetos.keys()].sort((a, b) => a - b);
    const mayor = numeros[numeros.length - 1];
    let salida = '%PDF-1.7\n';
    const posicion = new Map();
    for (const n of numeros) {
        posicion.set(n, salida.length);
        salida += n + ' 0 obj' + objetos.get(n) + 'endobj\n';
    }

    // Entradas del xref de 20 bytes exactos
    const inicioXref = salida.length;
    salida += 'xref\n0 ' + (mayor + 1) + '\n';
    salida += '0000000000 65535 f \n';
    for (let n = 1; n <= mayor; n++) {
        salida += posicion.has(n)
            ? String(posicion.get(n)).padStart(10, '0') + ' 00000 n \n'
            : '0000000000 65535 f \n';     // hueco: objeto perdido
    }
    salida += 'trailer\n<< /Size ' + (mayor + 1) + ' /Root ' + catalogo + ' 0 R >>\n' +
              'startxref\n' + inicioXref + '\n%%EOF\n';

    return textoABytes(salida).buffer;
}

/* ---- Rescate con pdf.js ----
   Último recurso: cada página se dibuja y entra como imagen a 150 ppp.
   Se pierde el texto, pero el documento queda en el expediente. */
async function rasterizarPdfAlExpediente(expediente, bytes) {
    const pdfjs = await cargarPdfJs();
    // pdf.js se queda con el buffer: se le pasa una copia
    const abrir = () => pdfjs.getDocument({
        // cada intento con su copia
        data: new Uint8Array(bytes.slice(0)),
        stopAtErrors: false,          // sigue aunque falle una página
        isEvalSupported: false,       // sin JavaScript embebido
        disableAutoFetch: true
    }).promise;

    // El worker compartido puede estar cerrándose: se reintenta una vez.
    let doc;
    try {
        doc = await abrir();
    } catch (e) {
        await new Promise(r => setTimeout(r, 120));
        doc = await abrir();
    }
    const total = doc.numPages;
    let puestas = 0;

    const lienzo = document.createElement('canvas');
    const ctx = lienzo.getContext('2d');

    for (let n = 1; n <= total; n++) {
        try {
            const pagina = await doc.getPage(n);
            const base = pagina.getViewport({ scale: 1 });
            // 150 ppp sobre 72, con tope para no reventar la memoria
            const escala = Math.min(150 / 72, 4000 / Math.max(base.width, base.height));
            const vista = pagina.getViewport({ scale: escala });
            lienzo.width = Math.floor(vista.width);
            lienzo.height = Math.floor(vista.height);
            // Fondo blanco (si no, el JPEG queda negro)
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, lienzo.width, lienzo.height);
            // intent 'print': usa microtareas en vez de rAF, que se congela en segundo plano.
            await pagina.render({
                canvasContext: ctx,
                viewport: vista,
                intent: 'print'
            }).promise;

            const dataUrl = lienzo.toDataURL('image/jpeg', 0.75);
            const img = await expediente.embedJpg(dataUrl);
            // Mismo tamaño de página que el original
            const hoja = expediente.addPage([base.width, base.height]);
            hoja.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
            puestas++;
            pagina.cleanup();
        } catch (e) {
            console.warn('Expediente: no se pudo rasterizar la página ' + n, e);
        }
    }
    try { await doc.destroy(); } catch (e) {}
    if (puestas === 0) throw new Error('no se pudo dibujar ninguna página');
    return { total, puestas, rasterizado: true };
}

/* ---- Unir un PDF al expediente ----
   Devuelve { total, puestas, rasterizado }. Cinco caminos, del mejor al
   más tolerante, solo si el anterior no metió todas las páginas:
   1. copia en bloque (pdf-lib)
   2. página por página (pdf-lib)
   3. reparar la entrada y reintentar
   4. reconstruir con lo que sobrevivió
   5. dibujar con pdf.js */
async function unirPdfAlExpediente(expediente, PDFLib, bytes) {
    let total = 0;
    // Páginas que salvó el camino 2, por si los demás fallan
    let salvadasPorPagina = [];

    try {
        const doc = await PDFLib.PDFDocument.load(bytes.slice(0), {
            ignoreEncryption: true,      // PDF de solo lectura
            throwOnInvalidObject: false, // referencias colgantes: se ignoran
            updateMetadata: false        // no reescribir el productor
        });
        const indices = doc.getPageIndices();
        total = indices.length;

        // 1) Todo junto
        try {
            const paginas = await expediente.copyPages(doc, indices);
            for (const pagina of paginas) expediente.addPage(pagina);
            return { total, puestas: paginas.length, rasterizado: false };
        } catch (e) { /* sigue al 2 */ }

        // 2) Una por una
        const copiadas = [];
        for (const i of indices) {
            try {
                const [pagina] = await expediente.copyPages(doc, [i]);
                copiadas.push(pagina);
            } catch (e) { copiadas.push(null); }
        }
        salvadasPorPagina = copiadas.filter(Boolean);
        if (salvadasPorPagina.length === total && total > 0) {
            for (const pagina of salvadasPorPagina) expediente.addPage(pagina);
            return { total, puestas: total, rasterizado: false };
        }
        // Faltan páginas: se intenta reparar; si no, al final van estas.
    } catch (e) { /* ni se pudo leer: al 3 */ }

    // 3) Reparar la estructura y reintentar (conserva el texto)
    let reparados = null;
    try { reparados = repararPdf(bytes); } catch (e) { reparados = null; }
    if (reparados) {
        try {
            const doc = await PDFLib.PDFDocument.load(reparados.slice(0), {
                ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
            });
            const indices = doc.getPageIndices();
            if (indices.length) {
                const paginas = await expediente.copyPages(doc, indices);
                for (const pagina of paginas) expediente.addPage(pagina);
                return { total: indices.length, puestas: paginas.length, rasterizado: false };
            }
        } catch (e) { /* sigue al 4 */ }
    }

    // 4) Reconstruir y reintentar
    let rearmados = null;
    try { rearmados = reconstruirPdf(bytes); } catch (e) { rearmados = null; }
    if (rearmados) {
        try {
            const doc = await PDFLib.PDFDocument.load(rearmados.slice(0), {
                ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
            });
            const indices = doc.getPageIndices();
            if (indices.length) {
                const paginas = await expediente.copyPages(doc, indices);
                for (const pagina of paginas) expediente.addPage(pagina);
                return { total: total || indices.length, puestas: paginas.length, rasterizado: false };
            }
        } catch (e) { /* sigue al 5 */ }
    }

    // 5) pdf.js sobre la mejor versión conseguida
    try {
        const r = await rasterizarPdfAlExpediente(expediente, rearmados || reparados || bytes);
        return { total: r.total || total, puestas: r.puestas, rasterizado: true };
    } catch (e) {
        // Ni pdf.js: entran las páginas del camino 2, si hubo.
        if (salvadasPorPagina.length) {
            for (const pagina of salvadasPorPagina) expediente.addPage(pagina);
            return { total, puestas: salvadasPorPagina.length, rasterizado: false };
        }
        throw e;
    }
}

/* ---- Unir una imagen ----
   Centrada en carta con margen, sin ampliarla más allá de su tamaño. */
async function unirImagenAlExpediente(expediente, bytes, ext) {
    const img = ext === 'png'
        ? await expediente.embedPng(bytes)
        : await expediente.embedJpg(bytes);
    const anchoPag = 612, altoPag = 792;   // carta en puntos
    const margen = 36;                      // media pulgada
    const escala = Math.min(
        (anchoPag - margen * 2) / img.width,
        (altoPag - margen * 2) / img.height,
        1
    );
    const pagina = expediente.addPage([anchoPag, altoPag]);
    pagina.drawImage(img, {
        x: (anchoPag - img.width * escala) / 2,
        y: (altoPag - img.height * escala) / 2,
        width: img.width * escala,
        height: img.height * escala
    });
}

/* Une lo seleccionado en un PDF y lo descarga. */
async function crearExpediente() {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta) || _seleccionExpediente.length === 0) return;
    const boton = document.getElementById('boton-crear-expediente');
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    try {
        boton.textContent = 'Preparando…';
        const PDFLib = await cargarPdfLib();
        const expediente = await PDFLib.PDFDocument.create();
        let hechos = 0;

        // Cada documento en su try: uno ilegible no tumba el lote.
        const fallidos = [];    // ni pdf.js
        const parciales = [];   // entraron incompletos
        const rescatados = [];  // entraron como imagen

        for (const id of _seleccionExpediente) {
            hechos++;
            boton.textContent = 'Uniendo ' + hechos + '/' + _seleccionExpediente.length + '…';
            let nombre = 'documento ' + hechos;
            try {
                const archivo = await dbObtener('archivos', id);   // con contenido (blob)
                // Nombre apenas se conoce, para el aviso si falla
                if (archivo && archivo.nombre) nombre = archivo.nombre;
                if (!archivo || !archivo.blob) { fallidos.push(nombre); continue; }
                const ext = extensionDe(nombre);
                const bytes = await archivo.blob.arrayBuffer();

                if (ext === 'pdf') {
                    boton.textContent = 'Uniendo ' + hechos + '/' + _seleccionExpediente.length + '…';
                    const r = await unirPdfAlExpediente(expediente, PDFLib, bytes);
                    if (r.rasterizado) rescatados.push(nombre);
                    if (r.puestas < r.total) {
                        parciales.push(nombre + ' (' + r.puestas + ' de ' + r.total + ' páginas)');
                    }
                } else if (['png', 'jpg', 'jpeg'].includes(ext)) {
                    await unirImagenAlExpediente(expediente, bytes, ext);
                } else {
                    fallidos.push(nombre);   // no se puede unir
                }
            } catch (e) {
                // Se anota y se sigue
                console.warn('Expediente: no se pudo unir «' + nombre + '»', e);
                fallidos.push(nombre);
            }
        }

        if (expediente.getPageCount() === 0) {
            avisar('Ninguno de los documentos seleccionados se pudo unir. ' +
                   'Revisa que sean PDF o imágenes y que no estén dañados.', 'error');
            return;
        }
        boton.textContent = 'Generando PDF…';
        const bytesPdf = await expediente.save();
        const blob = new Blob([bytesPdf], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombreArchivoSeguro(carpetaAbierta.nombre) + '_expediente.pdf';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);

        const unidos = _seleccionExpediente.length - fallidos.length;
        registrarActividad('generar-expediente',
            carpetaAbierta.nombre + ' (' + unidos + ' de ' + _seleccionExpediente.length + ' documentos)',
            carpetaAbierta.id);

        // El aviso dice qué quedó fuera y por qué
        avisar('Expediente generado: ' + cuantos(expediente.getPageCount(), 'página', 'páginas') + ' en un solo PDF.');
        if (rescatados.length) {
            // No es error: entró, pero como imagen (sin texto buscable).
            avisar(cuantos(rescatados.length, 'documento se unió', 'documentos se unieron') + ' como imagen ' +
                   'porque venían dañados: ' + rescatados.join(', ') +
                   '. Se ven igual, pero no se les puede buscar texto.');
        }
        if (fallidos.length) {
            avisar('No se pudo unir ' + cuantos(fallidos.length, 'documento', 'documentos') + ': ' +
                   fallidos.join(', ') + '. Puede que estén protegidos con ' +
                   'contraseña o que el archivo esté incompleto.', 'error');
        }
        if (parciales.length) {
            avisar('Se unieron parcialmente: ' + parciales.join('; ') + '.', 'error');
        }
        cerrarModalExpediente();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el expediente.', 'error');
    } finally {
        boton.disabled = false;
        boton.textContent = textoOriginal;
    }
}

/* ============ SUBIDA DE ARCHIVOS ============ */
async function subirArchivos(listaArchivos) {
    // Solo admin u operador responsable de esta carpeta
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const rechazados = [];
    const validos = [];

    for (const archivo of listaArchivos) {
        const ext = extensionDe(archivo.name);
        if (!EXTENSIONES_PERMITIDAS.includes(ext)) {
            rechazados.push(archivo.name + ' (tipo no permitido)');
        } else if (!destinoAdmiteExtension(_subcarpetaAbierta, ext)) {
            rechazados.push(motivoRechazo(_subcarpetaAbierta, archivo.name));
        } else if (archivo.size > TAMANO_MAXIMO) {
            // Al video se le dice qué hacer
            rechazados.push(archivo.name + (esVideo(archivo.name)
                ? ' (pesa ' + formatoTamano(archivo.size) + ' y el tope es ' + TAMANO_MAXIMO_TXT +
                  ': comprímalo o recorte la parte que no haga falta)'
                : ' (supera ' + TAMANO_MAXIMO_TXT + ')'));
        } else {
            validos.push(archivo);
        }
    }

    // Consejo para videos pesados que sí caben (en el panel, no flotante).
    const videosPesados = validos.filter(a => esVideo(a.name));
    if (videosPesados.length) {
        const peso = videosPesados.reduce((s, a) => s + a.size, 0);
        const pesado = peso > AVISO_VIDEO_MB * 1024 * 1024;
        mostrarConsejo(
            (videosPesados.length === 1
                ? 'Video de ' + formatoTamano(peso) + '. '
                : videosPesados.length + ' videos, ' + formatoTamano(peso) + ' entre todos. ') +
            'Antes de subir grabaciones conviene comprimirlas o recortar lo que no ' +
            'haga falta: el video es lo que más llena el espacio de almacenamiento' +
            (pesado
                // Desde cierto peso la subida ya no es instantánea
                ? ', y a este tamaño la subida tarda y no se puede reanudar: si se corta, hay que repetirla entera.'
                : '.'));
    }

    // El operador decide si las partes pueden descargar
    const casillaDescarga = document.getElementById('subida-descargable');
    const descargablePartes = casillaDescarga ? casillaDescarga.checked : true;
    // "Subir como": principales o anexos
    const selectorAnexo = document.getElementById('subida-anexo-de');
    const anexoDe = selectorAnexo && selectorAnexo.value ? Number(selectorAnexo.value) : null;

    if (!validos.length) {
        if (rechazados.length) avisarRechazados(rechazados);
        return;
    }

    // La barra sale antes del primer byte
    progresoSubidaAbrir(validos.length, 'subir');

    // En paralelo, de a cuatro (con Promise.all de todos, el servidor
    // cortaba las últimas con statement timeout).
    let subidos = 0;
    let terminados = 0;
    await enTandas(validos, SUBIDAS_A_LA_VEZ, async (archivo) => {
        progresoSubidaAvance(terminados, validos.length, archivo.name);
        try {
            await conLimite(dbAgregar('archivos', {
                carpetaId: carpetaAbierta.id,
                // A la subcarpeta abierta (null = raíz)
                subcarpetaId: _subcarpetaAbierta,
                nombre: archivo.name,
                tipo: archivo.type || 'application/octet-stream',
                tamano: archivo.size,
                blob: archivo,
                descargablePartes: descargablePartes,
                anexoDe: anexoDe,
                subidoPor: sesion.nombre || sesion.usuario,
                fecha: Date.now()
            }), esperaPorArchivo(archivo.size));
            registrarActividad('subir-archivo', archivo.name + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
            subidos++;
        } catch (e) {
            rechazados.push(archivo.name + ' (' + ((e && e.message) || 'error al subir') + ')');
        }
        terminados++;
        progresoSubidaAvance(terminados, validos.length, '');
    }, () => !_subidaCancelada);

    if (_subidaCancelada) {
        const sinEmpezar = validos.length - terminados;
        if (sinEmpezar > 0) rechazados.push(sinEmpezar + ' sin empezar (cancelado)');
    }
    progresoSubidaCerrar(subidos, terminados - subidos);
    // "Subir como" vuelve a principales
    if (selectorAnexo && subidos > 0) selectorAnexo.value = '';

    if (subidos > 0) avisar(subidos === 1 ? 'Se subió 1 archivo.' : 'Se subieron ' + subidos + ' archivos.');
    if (rechazados.length > 0) avisarRechazados(rechazados);
    await pintarArchivos();
}

/* Con muchos fallos se nombran unos pocos y se dice cuántos más. */
function avisarRechazados(rechazados) {
    const A_LA_VISTA = 5;
    const muestra = rechazados.slice(0, A_LA_VISTA).join(', ');
    const resto = rechazados.length - A_LA_VISTA;
    avisar('No se subió: ' + muestra +
           (resto > 0 ? ' y ' + resto + ' más' : ''), 'error');
}

/* Si cliente/acreedor puede descargar (solo personal) */
async function alternarDescargaPartes(id) {
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const archivo = (_archivosCache || []).find(a => String(a.id) === String(id));
    const permitir = !(archivo && archivo.descargablePartes !== false);
    try {
        await fijarDescargaPartes(id, permitir);
        avisar(permitir ? 'Las partes ya pueden descargar este archivo.' : 'Las partes ya no pueden descargar este archivo.');
        await pintarArchivos();
    } catch (e) {
        avisar((e && e.message) || 'No se pudo cambiar la descarga del archivo.', 'error');
    }
}

/* Descarga si el rol lo permite. */
async function descargarArchivo(id) {
    // Cliente y acreedor: solo lo habilitado
    if (ES_CLIENTE || ES_ACREEDOR) {
        const enLista = (_archivosCache || []).find(a => String(a.id) === String(id));
        if (enLista && enLista.descargablePartes === false) {
            avisar('Este documento es de solo lectura: puedes verlo, pero no descargarlo.', 'error');
            return;
        }
    }
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    const url = URL.createObjectURL(archivo.blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = archivo.nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    registrarActividad('descargar-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), archivo.carpetaId);
}

/* Abre en otra pestaña (en la app del celular, a pantalla completa aquí):
   Word y hojas → visor.html
   PDF, imágenes, audio, video y texto → visor del navegador
   lo demás → descarga */
async function verArchivo(id) {
    const previo = (_archivosCache || []).find(x => String(x.id) === String(id));
    const extPrevia = previo ? extensionDe(previo.nombre) : '';
    if (EXTENSIONES_VISOR.includes(extPrevia)) { abrirEnVisor(previo); return; }

    // La pestaña se abre en el mismo clic (después el navegador la bloquea).
    // En la app del celular no hay pestañas: se ve aquí dentro.
    const app = enApp();
    const seVe = !!TIPO_SEGURO_POR_EXTENSION[extPrevia];
    const pestana = seVe && !app ? abrirPestanaEspera() : null;
    if (seVe && app) mostrarEnApp(null, previo.nombre);

    const archivo = await dbObtener('archivos', id);
    if (!archivo) { if (pestana) pestana.close(); if (app) cerrarModalVisor(); return; }
    const ext = extensionDe(archivo.nombre);
    if (EXTENSIONES_VISOR.includes(ext)) { if (pestana) pestana.close(); abrirEnVisor(archivo); return; }
    registrarActividad('ver-archivo', archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : ''), archivo.carpetaId);

    // El tipo lo pone la extensión, no Storage: un "informe.pdf" subido como
    // text/html correría código en el portal. Lo desconocido se descarga.
    const tipo = TIPO_SEGURO_POR_EXTENSION[ext];
    const url = URL.createObjectURL(tipo ? new Blob([archivo.blob], { type: tipo }) : archivo.blob);
    if (tipo && app) { mostrarEnApp(url, archivo.nombre, true); return; }   // se libera al cerrar
    if (app) cerrarModalVisor();
    if (tipo) {
        if (pestana && !pestana.closed) pestana.location.replace(url);
        else window.open(url, '_blank');
    } else {
        if (pestana) pestana.close();
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = archivo.nombre;
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* Pestaña "Abriendo…" (about:blank) mientras llega el archivo. null si la bloquean. */
function abrirPestanaEspera() {
    const p = window.open('', '_blank');
    if (!p) return null;
    try {
        p.document.write('<!DOCTYPE html><meta charset="utf-8"><title>Abriendo…</title>' +
            '<body style="margin:0;display:grid;place-items:center;height:100vh;' +
            'font:15px system-ui,sans-serif;color:#555;background:#fff">Abriendo el documento…</body>');
        p.document.close();
    } catch (e) { /* si no deja escribir, queda en blanco */ }
    return p;
}

/* Tipos que el navegador abre sin ejecutar nada. Texto y CSV como texto plano. */
const TIPO_SEGURO_POR_EXTENSION = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
    txt: 'text/plain;charset=utf-8', csv: 'text/plain;charset=utf-8',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac'
};

/* ============ VISOR DE WORD Y EXCEL (visor.html) ============
   Lo pesado corre en la pestaña del visor (al frente); aquí se frenaba.
   El visor no tiene sesión: pide el archivo por postMessage con una clave
   al azar que solo conoce este portal. Al recargar lo vuelve a pedir. */
const EXTENSIONES_VISOR = ['doc', 'docx', 'xlsx', 'xls', 'ods', 'csv'];
const _visores = new Map();   // clave → { id, nombre, detalle, carpetaId, descargable, promesa }

function abrirEnVisor(archivo) {
    const clave = crypto.randomUUID();
    const detalle = archivo.nombre + (carpetaAbierta ? ' · ' + carpetaAbierta.nombre : '');
    // Cliente y acreedor ven pero no bajan lo no habilitado
    const descargable = !((ES_CLIENTE || ES_ACREEDOR) && archivo.descargablePartes === false);
    _visores.set(clave, { id: archivo.id, nombre: archivo.nombre, detalle, carpetaId: archivo.carpetaId, descargable,
                          // Empieza a bajar ya
                          promesa: dbObtener('archivos', archivo.id).catch(() => null) });
    const url = 'visor.html#' + clave;
    registrarActividad('ver-archivo', detalle, archivo.carpetaId);
    if (enApp()) { mostrarEnApp(url, archivo.nombre); return; }
    const pestana = window.open(url, '_blank');
    if (pestana) return;

    // Pestaña bloqueada: queda un enlace (rel="opener" para que el visor hable con el portal).
    document.getElementById('visor-titulo').textContent = archivo.nombre;
    document.getElementById('visor-cuerpo').innerHTML =
        '<div class="pt-visor-lista">' +
            '<p>El navegador no dejó abrir la pestaña del documento.</p>' +
            '<a class="pt-boton pt-boton--primario" href="' + url + '" target="_blank" rel="opener" data-accion="abrir-visor-bloqueado">' +
                'Abrir el documento</a>' +
        '</div>';
    document.getElementById('modal-visor').hidden = false;
}

/* App de la pantalla de inicio (iPhone, Android): no hay pestañas y otra
   ventana no puede hablar con el portal, así que todo se ve aquí dentro. */
function enApp() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true;
}

/* Documento a pantalla completa dentro del portal. Sin url: "Abriendo…".
   `esBlob`: la url se libera al cerrar. */
let _urlEnApp = null;
function mostrarEnApp(url, nombre, esBlob) {
    if (_urlEnApp) { URL.revokeObjectURL(_urlEnApp); _urlEnApp = null; }
    document.getElementById('visor-titulo').textContent = nombre;
    const cuerpo = document.getElementById('visor-cuerpo');
    cuerpo.innerHTML = '';
    const tipo = TIPO_SEGURO_POR_EXTENSION[extensionDe(nombre)] || '';
    if (url && /^(video|audio)\//.test(tipo)) {
        // Audio y video con reproductor propio: dentro de la página y sin recortar
        const medio = document.createElement(tipo.startsWith('video') ? 'video' : 'audio');
        medio.className = 'pt-visor-medio';
        medio.controls = true;
        medio.preload = 'metadata';
        medio.setAttribute('playsinline', '');
        medio.setAttribute('webkit-playsinline', '');
        medio.src = url;
        cuerpo.appendChild(medio);
        if (esBlob) _urlEnApp = url;
    } else if (url) {
        const marco = document.createElement('iframe');
        marco.className = 'pt-visor-marco';
        marco.title = nombre;
        marco.src = url;
        cuerpo.appendChild(marco);
        if (esBlob) _urlEnApp = url;
    } else {
        cuerpo.innerHTML = '<p class="pt-visor-espera">Abriendo el documento…</p>';
    }
    const modal = document.getElementById('modal-visor');
    modal.classList.add('pt-modal--completo');
    modal.hidden = false;
}

/* Cierra el aviso o el documento. */
function cerrarModalVisor() {
    const modal = document.getElementById('modal-visor');
    modal.hidden = true;
    modal.classList.remove('pt-modal--completo');
    document.getElementById('visor-cuerpo').innerHTML = '';
    if (_urlEnApp) { URL.revokeObjectURL(_urlEnApp); _urlEnApp = null; }
}

/* Peticiones del visor: solo del mismo origen y con clave válida. */
window.addEventListener('message', async (evento) => {
    const d = evento.data;
    if (evento.origin !== location.origin || !evento.source || !d || typeof d.token !== 'string') return;
    if (d.tipo !== 'visor-pide' && d.tipo !== 'visor-descargo') return;
    const responder = (m) => {
        try { evento.source.postMessage(Object.assign({ token: d.token }, m), location.origin); } catch (e) { /* la pestaña ya se cerró */ }
    };
    const v = _visores.get(d.token);
    if (!v) {
        if (d.tipo === 'visor-pide') {
            responder({ tipo: 'visor-error', mensaje: 'El portal se recargó o se cerró después de abrir este documento. Vuelve al portal y pulsa «Ver» otra vez.' });
        }
        return;
    }
    if (d.tipo === 'visor-descargo') {
        if (v.descargable) registrarActividad('descargar-archivo', v.detalle, v.carpetaId);
        return;
    }
    responder({ tipo: 'visor-bajando', nombre: v.nombre });
    try {
        // Primero usa la descarga del clic; al recargar, baja otra vez
        const archivo = await (v.promesa || dbObtener('archivos', v.id));
        v.promesa = null;
        if (!archivo || !archivo.blob) throw new Error('No se pudo bajar el documento. Revisa la conexión y pulsa «Ver» otra vez.');
        responder({ tipo: 'visor-archivo', nombre: archivo.nombre, blob: archivo.blob, descargable: v.descargable });
    } catch (e) {
        v.promesa = null;
        responder({ tipo: 'visor-error', mensaje: (e && e.message) || 'No se pudo bajar el documento.' });
    }
});

/* ============ CARPETA COMPLETA EN ZIP ============ */
const MARCAS_ACENTO_ZIP = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
/* Nombre seguro para cualquier sistema de archivos. */
function nombreArchivoSeguro(texto) {
    return String(texto)
        .normalize('NFD').replace(MARCAS_ACENTO_ZIP, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'carpeta';
}

/* ZIP de la carpeta respetando los permisos de descarga. */
async function descargarCarpetaZip() {
    if (!carpetaAbierta) return;
    const boton = document.getElementById('boton-descargar-zip');
    // Se guarda el HTML del botón (trae un SVG)
    const contenidoOriginal = boton.innerHTML;
    boton.disabled = true;
    try {
        boton.textContent = 'Recopilando archivos…';
        const archivos = await descargarBlobsDeCarpeta(carpetaAbierta.id, (hechos, total) => {
            boton.textContent = 'Descargando ' + hechos + '/' + total + '…';
        });
        // Personal: todo. Partes: lo permitido.
        if (archivos.length === 0) {
            avisar((ES_CLIENTE || ES_ACREEDOR)
                ? 'Ningún documento de esta carpeta está disponible para descarga.'
                : 'Esta carpeta no tiene documentos para descargar.', 'error');
            return;
        }

        boton.textContent = 'Comprimiendo…';
        const JSZip = await cargarJSZip();
        const zip = new JSZip();
        // Mismo número de la tabla; cada subcarpeta en su carpeta del ZIP
        const todos = ordenarArchivos(await dbArchivosDeCarpeta(carpetaAbierta.id));
        const ruta = new Map();
        const grupos = new Map();
        todos.forEach(a => {
            const clave = a.subcarpetaId ? String(a.subcarpetaId) : '';
            if (!grupos.has(clave)) grupos.set(clave, []);
            grupos.get(clave).push(a);
        });
        // Nombres de subcarpetas frescos (puede haber una nueva)
        let subcarpetasZip = _subcarpetas;
        try { subcarpetasZip = await subcarpetasListar(carpetaAbierta.id); } catch (e) { /* si falla, los de memoria */ }
        grupos.forEach((lista, clave) => {
            const nums = numerarDocumentos(lista);
            const sub = subcarpetasZip.find(s => String(s.id) === clave);
            const nombreSub = ((sub && sub.nombre) || 'Subcarpeta ' + clave).replace(/[\\/:*?"<>|]/g, '-').trim();
            const carpetaZip = clave ? nombreSub + '/' : '';
            lista.forEach(a => ruta.set(a.id, carpetaZip + nums.get(a.id).etiqueta + ' - '));
        });
        const repetidos = {};
        for (const archivo of archivos) {
            const prefijo = ruta.get(archivo.id) || '';
            // nombres repetidos: "nombre (2).ext"
            const clave = prefijo + archivo.nombre;
            const vistos = repetidos[clave] || 0;
            repetidos[clave] = vistos + 1;
            let nombre = clave;
            if (vistos > 0) {
                const punto = nombre.lastIndexOf('.');
                nombre = punto > 0
                    ? nombre.slice(0, punto) + ' (' + (vistos + 1) + ')' + nombre.slice(punto)
                    : nombre + ' (' + (vistos + 1) + ')';
            }
            zip.file(nombre, archivo.blob);
        }

        const blobZip = await zip.generateAsync(
            { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
            (avance) => { boton.textContent = 'Comprimiendo… ' + Math.round(avance.percent) + '%'; }
        );

        const url = URL.createObjectURL(blobZip);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = nombreArchivoSeguro(carpetaAbierta.nombre) + '.zip';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        registrarActividad('descargar-zip', carpetaAbierta.nombre + ' (' + archivos.length + ' archivos)', carpetaAbierta.id);
        avisar('Carpeta descargada: ' + cuantos(archivos.length, 'archivo', 'archivos') + ' en un ZIP.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo crear el ZIP.', 'error');
    } finally {
        boton.disabled = false;
        boton.innerHTML = contenidoOriginal;
    }
}

/* Borra un documento (fila y binario), con confirmación. */
/* Vacía el expediente completo (subcarpetas incluidas). Solo admin y en
   dos pasos: hay que escribir una palabra porque no se puede deshacer. */
async function vaciarCarpeta() {
    if (!ES_ADMIN || !carpetaAbierta) return;
    const total = (_archivosCache || []).length;
    if (!total) return;

    const ok = await confirmarPortal(
        'Se van a eliminar los ' + total + ' documentos de «' + carpetaAbierta.nombre +
        '», incluidos los de las subcarpetas. Se borran también del disco del ' +
        'servidor y no se pueden recuperar.',
        'Vaciar el expediente');
    if (!ok) return;

    const escrito = await pedirTextoPortal(
        'Escribe ELIMINAR para confirmar',
        'Se perderán ' + total + ' documentos de «' + carpetaAbierta.nombre + '». No se puede deshacer.',
        '', 'Confirmación', 'Eliminar los documentos');
    if (escrito === null) return;
    if (escrito.trim().toUpperCase() !== 'ELIMINAR') {
        avisar('No se eliminó nada: había que escribir ELIMINAR.', 'error');
        return;
    }

    // Botón oculto mientras corre (evita doble clic)
    const boton = document.querySelector('[data-accion="vaciar-carpeta"]');
    if (boton) { boton.disabled = true; boton.textContent = 'Eliminando…'; }

    // La misma barra de la subida
    progresoSubidaAbrir(total, 'borrar');
    let borrados = 0;
    try {
        borrados = await dbEliminarArchivosDeCarpeta(carpetaAbierta.id,
            (hechos, cuantos) => progresoSubidaAvance(hechos, cuantos, ''));
        progresoSubidaCerrar(borrados || total, 0);
        registrarActividad('vaciar-carpeta',
            (borrados || total) + ' documentos · ' + carpetaAbierta.nombre, carpetaAbierta.id);
        avisar((borrados || total) === 1 ? 'Se eliminó 1 documento.' : 'Se eliminaron ' + (borrados || total) + ' documentos.');
    } catch (e) {
        progresoSubidaCerrar(borrados, Math.max(0, total - borrados));
        avisar((e && e.message) || 'No se pudieron eliminar los documentos.', 'error');
    }
    await pintarArchivos();
}

async function eliminarArchivo(id) {
    // Solo admin u operador responsable
    if (!carpetaAbierta || !puedeGestionarCarpeta(carpetaAbierta)) return;
    const archivo = await dbObtener('archivos', id);
    if (!archivo) return;
    // Sus anexos quedan sueltos
    const anexos = (_archivosCache || []).filter(x => x.anexoDe === Number(id)).length;
    const aviso = '¿Eliminar el archivo "' + archivo.nombre + '"? Esta acción no se puede deshacer.' +
        (anexos ? '\n\n' + (anexos === 1 ? 'Su anexo no se borra: queda' : 'Sus ' + anexos + ' anexos no se borran: quedan') +
                  ' como documento' + (anexos === 1 ? '' : 's') + ' principal' + (anexos === 1 ? '' : 'es') + '.' : '');
    if (!await confirmarPortal(aviso)) return;
    await dbEliminar('archivos', id);
    registrarActividad('eliminar-archivo', archivo.nombre + ' · ' + carpetaAbierta.nombre, carpetaAbierta.id);
    avisar('Archivo eliminado.');
    await pintarArchivos();
}

/* ============ GESTIÓN DE CARPETAS (admin) ============ */
async function abrirModalCarpeta(carpeta) {
    if (!ES_ADMIN) return;
    carpetaEditando = carpeta || null;
    document.getElementById('modal-carpeta-titulo').textContent = carpeta ? 'Editar carpeta' : 'Nueva carpeta';
    document.getElementById('carpeta-nombre').value = carpeta ? carpeta.nombre : '';
    document.getElementById('carpeta-descripcion').value = carpeta ? (carpeta.descripcion || '') : '';
    document.getElementById('carpeta-tipo').value =
        (carpeta && carpeta.tipoProceso) || 'natural_no_comerciante';
    document.getElementById('carpeta-activa').checked = carpeta ? !!carpeta.activa : true;

    // Personas de la notaría de la carpeta (no de la abierta).
    const notariaDeLaCarpeta = carpeta ? (carpeta.notariaId ?? null) : _notariaActiva;
    const usuarios = (await dbTodos('usuarios'))
        .filter(u => usuarioEnNotaria(u, notariaDeLaCarpeta));
    const filaCheque = (u, marcados) =>
        '<label><input type="checkbox" value="' + escaparHtml(u.usuario) + '"' +
        (marcados.includes(u.usuario) ? ' checked' : '') + '> ' +
        escaparHtml(u.nombre) + ' <span class="pt-nota">(' + escaparHtml(ETIQUETAS_ROL[u.rol]) +
        (u.activo === false ? ' · desactivado' : '') + ')</span></label>';

    // Listas por rol
    const operadores = usuarios.filter(u => u.rol === 'operador');
    const operadoresMarcados = carpeta ? (carpeta.operadores || []) : [];
    document.getElementById('carpeta-operadores').innerHTML = operadores.length === 0
        ? '<p class="pt-nota">No hay operadores en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : operadores.map(u => filaCheque(u, operadoresMarcados)).join('');

    const marcados = carpeta ? (carpeta.asignados || []) : [];
    const clientes = usuarios.filter(u => u.rol === 'cliente');
    document.getElementById('carpeta-clientes').innerHTML = clientes.length === 0
        ? '<p class="pt-nota">No hay clientes en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : clientes.map(u => filaCheque(u, marcados)).join('');
    const acreedores = usuarios.filter(u => u.rol === 'acreedor');
    document.getElementById('carpeta-acreedores').innerHTML = acreedores.length === 0
        ? '<p class="pt-nota">No hay acreedores en esta notaría. Créalos desde Usuarios, o dale acceso a esta oficina a alguien que ya exista.</p>'
        : acreedores.map(u => filaCheque(u, marcados)).join('');

    cambiarTabRolCarpeta('operadores');
    document.getElementById('modal-carpeta').hidden = false;
}

/* Pestañas de roles al asignar. */
function cambiarTabRolCarpeta(grupo) {
    if (!['operadores', 'clientes', 'acreedores'].includes(grupo)) return;
    document.querySelectorAll('#carpeta-tabs-roles button').forEach(b =>
        b.classList.toggle('activa', b.dataset.grupo === grupo));
    for (const g of ['operadores', 'clientes', 'acreedores']) {
        document.getElementById('grupo-' + g).hidden = (g !== grupo);
    }
}

/* Cierra el formulario. */
function cerrarModalCarpeta() {
    document.getElementById('modal-carpeta').hidden = true;
    carpetaEditando = null;
}

/* Crea o actualiza la carpeta con sus personas. */
async function guardarCarpeta(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;

    const nombre = document.getElementById('carpeta-nombre').value.trim();
    if (!nombre) return;
    const descripcion = document.getElementById('carpeta-descripcion').value.trim();
    const tipoProceso = document.getElementById('carpeta-tipo').value;
    const activa = document.getElementById('carpeta-activa').checked;
    const operadores = [...document.querySelectorAll('#carpeta-operadores input:checked')].map(c => c.value);
    const asignados = [
        ...document.querySelectorAll('#carpeta-clientes input:checked'),
        ...document.querySelectorAll('#carpeta-acreedores input:checked')
    ].map(c => c.value);

    if (carpetaEditando) {
        await dbGuardar('carpetas', { ...carpetaEditando, nombre, descripcion, tipoProceso, activa, asignados, operadores });
        registrarActividad('editar-carpeta', nombre);
        avisar('Carpeta actualizada.');
    } else {
        // Nace en la notaría abierta. Con "todas" hay que elegir una antes.
        if (_notariasDisponibles.length && _notariaActiva === null) {
            avisar('Abre una notaría concreta para crear la carpeta. ' +
                   'Desde "Todas las notarías" no se sabe a cuál pertenece.', 'error');
            return;
        }
        const nuevaId = await dbAgregar('carpetas', {
            nombre, descripcion, tipoProceso, activa, asignados, operadores,
            notariaId: _notariaActiva,
            creadaPor: sesion.usuario,
            fecha: Date.now()
        });
        // Toda carpeta nace con su subcarpeta de audiencias.
        try { await subcarpetaCrear(nuevaId, 'Audiencias'); }
        catch (e) { /* si falla, se crea a mano después */ }
        registrarActividad('crear-carpeta', nombre);
        avisar('Carpeta creada.');
    }
    cerrarModalCarpeta();
    await mostrarVistaCarpetas();
}

/* Activa o desactiva (desactivar no borra nada). */
async function alternarCarpeta(id) {
    if (!ES_ADMIN) return;
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    carpeta.activa = !carpeta.activa;
    await dbGuardar('carpetas', carpeta);
    registrarActividad(carpeta.activa ? 'activar-carpeta' : 'desactivar-carpeta', carpeta.nombre);
    avisar(carpeta.activa ? 'Carpeta activada: los asignados ya pueden verla.' : 'Carpeta desactivada: queda oculta para los asignados.');
    await mostrarVistaCarpetas();
}

/* Borra la carpeta y sus documentos (con confirmación). */
async function eliminarCarpeta(id) {
    if (!ES_ADMIN) return;
    const carpeta = await dbObtener('carpetas', id);
    if (!carpeta) return;
    if (!await confirmarPortal('¿Eliminar la carpeta "' + carpeta.nombre + '" y TODOS sus archivos? Esta acción no se puede deshacer.')) return;
    await dbEliminarArchivosDeCarpeta(id);
    await dbEliminar('carpetas', id);
    registrarActividad('eliminar-carpeta', carpeta.nombre);
    avisar('Carpeta eliminada.');
    await mostrarVistaCarpetas();
}

/* ============ VISTA: USUARIOS (admin) ============ */
let _usuariosCache = [];        // todos, para filtrar sin recargar
let _filtroRolUsuarios = '';    // '' = todos los roles
let _busquedaUsuarios = '';     // buscador

/* Usuarios (solo admin): caché primero, luego el servidor. */
async function mostrarVistaUsuarios() {
    if (!ES_ADMIN) return;
    mostrarVista('vista-usuarios');

    const guardados = cacheLeer('usuarios');
    if (guardados) aplicarUsuarios(guardados);
    else document.getElementById('lista-usuarios').innerHTML = esqueletoFilasTabla(8, 6);

    const { valor, cambio } = await cacheRefrescar('usuarios', () => dbTodos('usuarios'));
    if (!guardados || cambio) aplicarUsuarios(valor);
}

/* Pinta la lista y el resumen de cuentas activas. */
function aplicarUsuarios(usuarios) {
    // slice(): ordenar en el sitio dañaría la caché
    _usuariosCache = usuarios.slice().sort((a, b) => a.usuario.localeCompare(b.usuario));
    const resumen = document.getElementById('usuarios-resumen');
    if (resumen) resumen.textContent = resumenUsuariosDeNotaria();
    pintarListaUsuarios();
}

const ORDEN_ROLES_USUARIOS = ['administrador', 'monitor', 'operador', 'cliente', 'acreedor'];

/* Tarjetas filtradas por rol y búsqueda. */
function pintarListaUsuarios() {
    const q = _busquedaUsuarios.trim().toLowerCase();
    let usuarios = _usuariosCache.filter(u =>
        // Cada oficina con su gente (operador con varias y admin aparecen en más de una).
        usuarioEnNotaria(u, _notariaActiva) &&
        (!_filtroRolUsuarios || u.rol === _filtroRolUsuarios) &&
        (!q || (u.usuario || '').toLowerCase().includes(q) ||
               (u.nombre || '').toLowerCase().includes(q) ||
               (u.correo || '').toLowerCase().includes(q)));
    // Por rol (jerarquía) y nombre
    usuarios.sort((a, b) =>
        (ORDEN_ROLES_USUARIOS.indexOf(a.rol) - ORDEN_ROLES_USUARIOS.indexOf(b.rol)) ||
        (a.nombre || '').localeCompare(b.nombre || ''));

    const cuerpo = document.getElementById('lista-usuarios');
    const vacio = document.getElementById('usuarios-vacio');
    if (vacio) vacio.hidden = usuarios.length > 0;

    let html = '';
    let rolActual = null;
    for (const u of usuarios) {
        // Encabezado por rol (si no hay filtro de un rol)
        if (!_filtroRolUsuarios && u.rol !== rolActual) {
            rolActual = u.rol;
            // Plural a mano: con "+ s" salía "Administradors"
            const enRol = usuarios.filter(x => x.rol === rolActual).length;
            const GRUPO_ROL = { administrador: 'Administradores', monitor: 'Monitores', operador: 'Operadores',
                                cliente: 'Clientes', acreedor: 'Acreedores' };
            html += '<tr class="pt-fila-grupo-rol"><td colspan="8">' +
                escaparHtml(GRUPO_ROL[rolActual] || ETIQUETAS_ROL[rolActual] || rolActual) + ' · ' + enRol + '</td></tr>';
        }
        const activo = u.activo !== false;
        const estado = activo
            ? '<span class="pt-insignia pt-insignia--activa">Activo</span>'
            : '<span class="pt-insignia pt-insignia--inactiva">Desactivado</span>';
        const uEsc = escaparHtml(u.usuario);
        let acciones = '<button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="editar-usuario" data-usuario="' + uEsc + '">Editar</button>' +
            ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="correo-usuario" data-usuario="' + uEsc + '">Correo</button>';
        if (u.usuario === sesion.usuario) {
            acciones += ' <span class="pt-nota">(tú)</span>';
        } else {
            acciones += ' <button class="pt-boton pt-boton--fantasma pt-boton--mini" data-accion="alternar-usuario" data-usuario="' + uEsc + '">' + (activo ? 'Desactivar' : 'Activar') + '</button>' +
                ' <button class="pt-boton pt-boton--peligro pt-boton--mini" data-accion="eliminar-usuario" data-usuario="' + uEsc + '">Eliminar</button>';
        }
        html += '<tr>' +
            '<td><code>' + escaparHtml(u.usuario) + '</code></td>' +
            '<td>' + escaparHtml(u.nombre) + '</td>' +
            '<td><span class="pt-insignia pt-insignia--rol">' + escaparHtml(ETIQUETAS_ROL[u.rol] || u.rol) + '</span></td>' +
            '<td>' + estado + '</td>' +
            '<td>' + puntoConexion(u.usuario) + '</td>' +
            '<td>' + (u.ultimaConexion ? formatoFecha(u.ultimaConexion) : '<span class="pt-nota">nunca</span>') + '</td>' +
            '<td>' + formatoFecha(u.creado) + '</td>' +
            '<td><div class="pt-celda-acciones">' + acciones + '</div></td>' +
            '</tr>';
    }
    cuerpo.innerHTML = html;
}

/* Filtro por rol. */
function cambiarFiltroRolUsuario(rol) {
    _filtroRolUsuarios = rol || '';
    document.querySelectorAll('#filtro-rol-usuarios button').forEach(b =>
        b.classList.toggle('activa', (b.dataset.rol || '') === _filtroRolUsuarios));
    pintarListaUsuarios();
}

/* ============ EXCEL DE CREDENCIALES ============
   Con la cara de las hojas de trabajo de la notaría: bandas de título,
   bordes finos y encabezado fijo con filtro. ExcelJS porque SheetJS
   gratis no escribe estilos. */
const XL = {
    navy:       'FF13232E',
    navy700:    'FF264150',
    cian:       'FF00A1B8',
    cianSuave:  'FFD9F1F5',
    naranja:    'FFFA9B02',
    banda:      'FFF2F8F9',   // filas pares sombreadas
    borde:      'FFDCE6E9',
    rojo:       'FFB3261E',
    rojoSuave:  'FFFBE3E1',
    verde:      'FF157039',
    verdeSuave: 'FFDDF3E4',
    ambar:      'FF8A4B08',
    ambarSuave: 'FFFCEFD3',
    gris:       'FF536068',
    blanco:     'FFFFFFFF'
};

/* Misma fuente de las hojas de trabajo (si falta, Excel pone otra). */
const XL_FUENTE = 'Arial Nova Cond Light';

const XL_COLUMNAS = [
    { t: 'Usuario',          w: 16 },
    { t: 'Contraseña',       w: 18 },
    { t: 'Nombre completo',  w: 30 },
    { t: 'Rol',              w: 15 },
    { t: 'Carpetas',         w: 38 },
    { t: 'Correo',           w: 28 },
    { t: 'Notaría',          w: 30 },
    { t: 'Estado',           w: 13 },
    { t: 'Última conexión',  w: 19 },
    { t: 'Clave anotada el', w: 19 },
    { t: 'Creado',           w: 19 }
];

/* Dirección del portal desde la página (sirve con cualquier dominio). */
function enlacePortal() {
    try { return new URL('.', location.href).href; } catch (e) { return ''; }
}

/* ---- Estilos ---- */
function xlBorde(color) {
    const l = { style: 'thin', color: { argb: color || XL.borde } };
    return { top: l, left: l, bottom: l, right: l };
}

/* Banda de título: una celda combinada de lado a lado. */
function xlBanda(hoja, fila, ancho, texto, fondo, tam) {
    hoja.mergeCells(fila, 1, fila, ancho);
    const c = hoja.getCell(fila, 1);
    c.value = texto;
    c.font = { name: XL_FUENTE, size: tam || 14, bold: true, color: { argb: XL.blanco } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fondo || XL.navy } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
    hoja.getRow(fila).height = (tam || 14) + 12;
    return c;
}

/* Encabezado de tabla. */
function xlEncabezado(hoja, fila, columnas) {
    const r = hoja.getRow(fila);
    columnas.forEach((col, i) => {
        const c = r.getCell(i + 1);
        c.value = col.t;
        c.font = { name: XL_FUENTE, size: 10, bold: true, color: { argb: XL.blanco } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.navy700 } };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        c.border = xlBorde(XL.navy700);
    });
    r.height = 26;
    return r;
}

/* ---- Hoja de personas (todos y por rol) ---- */
function xlHojaGente(libro, titulo, gente, ctx, colorPestana) {
    const hoja = libro.addWorksheet(titulo, {
        properties: { tabColor: { argb: colorPestana || XL.cian } },
        pageSetup: {
            orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
            margins: { left: .3, right: .3, top: .5, bottom: .5, header: .2, footer: .2 }
        },
        headerFooter: {
            oddFooter: '&LPortal Documental · ' + ctx.notaria +
                       '&CCONTIENE CONTRASEÑAS&R Página &P de &N'
        }
    });
    hoja.columns = XL_COLUMNAS.map(c => ({ width: c.w }));
    const ancho = XL_COLUMNAS.length;

    xlBanda(hoja, 1, ancho, 'CREDENCIALES DEL PORTAL · ' + titulo.toUpperCase(), XL.navy, 15);
    const sub = xlBanda(hoja, 2, ancho, ctx.notaria + '   ·   ' +
        cuantos(gente.length, 'cuenta', 'cuentas') + '   ·   generado el ' + ctx.generado, XL.cian, 10);
    sub.font = { name: XL_FUENTE, size: 10, bold: false, color: { argb: XL.blanco } };

    xlEncabezado(hoja, 3, XL_COLUMNAS);

    let fila = 4;
    for (const u of gente) {
        ctx.pintarPersona(hoja, fila, u, (fila % 2 === 0));
        fila++;
    }
    if (!gente.length) {
        hoja.mergeCells(fila, 1, fila, ancho);
        const c = hoja.getCell(fila, 1);
        c.value = 'No hay cuentas de este tipo en ' + ctx.notaria + '.';
        c.font = { name: XL_FUENTE, size: 10, italic: true, color: { argb: XL.gris } };
        c.alignment = { horizontal: 'center' };
        c.border = xlBorde();
        fila++;
    }

    // Encabezado fijo y filtro en cada columna
    hoja.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }];
    hoja.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(fila - 1, 4), column: ancho } };
    hoja.pageSetup.printTitlesRow = '3:3';
    return hoja;
}

/* ---- Hoja por carpeta ---- */
function xlHojaPorCarpeta(libro, ctx) {
    const CAB = [
        { t: 'Usuario',         w: 16 },
        { t: 'Contraseña',      w: 18 },
        { t: 'Nombre completo', w: 32 },
        { t: 'Rol',             w: 15 },
        { t: 'En la carpeta',   w: 16 },
        { t: 'Correo',          w: 28 },
        { t: 'Estado',          w: 13 }
    ];
    const ancho = CAB.length;
    const hoja = libro.addWorksheet('Por carpeta', {
        properties: { tabColor: { argb: XL.naranja }, outlineProperties: { summaryBelow: false } },
        pageSetup: {
            orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
            margins: { left: .3, right: .3, top: .5, bottom: .5, header: .2, footer: .2 }
        },
        headerFooter: {
            oddFooter: '&LPortal Documental · ' + ctx.notaria +
                       '&CCONTIENE CONTRASEÑAS&R Página &P de &N'
        }
    });
    hoja.columns = CAB.map(c => ({ width: c.w }));

    xlBanda(hoja, 1, ancho, 'QUIÉN ESTÁ EN CADA CARPETA', XL.navy, 15);
    const sub = xlBanda(hoja, 2, ancho, ctx.notaria +
        '   ·   las carpetas se pueden plegar con el [-] del margen izquierdo', XL.cian, 10);
    sub.font = { name: XL_FUENTE, size: 10, color: { argb: XL.blanco } };

    let fila = 3;
    const ORDEN_VINCULO = { 'Operador': 0, 'Deudor': 1, 'Acreedor': 2 };

    // Título de grupo: cian claro con texto oscuro
    const grupo = (texto, fondo) => {
        hoja.mergeCells(fila, 1, fila, ancho);
        const c = hoja.getCell(fila, 1);
        c.value = texto;
        c.font = { name: XL_FUENTE, size: 11, bold: true, color: { argb: XL.navy } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fondo || XL.cianSuave } };
        c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        c.border = xlBorde(XL.cian);
        hoja.getRow(fila).height = 22;
        fila++;
        xlEncabezado(hoja, fila, CAB);
        fila++;
    };

    // Filas un nivel adentro: Excel permite plegar cada carpeta
    const persona = (usuario, vinculo, par) => {
        const u = ctx.porUsuario[usuario];
        const v = u
            ? [u.usuario, u.clave || '(sin anotar)', u.nombre, ETIQUETAS_ROL[u.rol] || u.rol,
               vinculo, u.correo || '', u.activo === false ? 'Desactivado' : 'Activo']
            : [usuario, '', '(la cuenta ya no existe)', '', vinculo, '', ''];
        const r = hoja.getRow(fila);
        v.forEach((valor, i) => {
            const c = r.getCell(i + 1);
            c.value = valor;
            c.font = { name: XL_FUENTE, size: 10 };
            c.alignment = { vertical: 'middle', horizontal: i === 0 || i >= 3 ? 'left' : 'left' };
            c.border = xlBorde();
            if (par) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.banda } };
        });
        ctx.resaltarClave(r.getCell(2));
        ctx.resaltarEstado(r.getCell(7));
        if (!u) {
            r.getCell(3).font = { name: XL_FUENTE, size: 10, italic: true, color: { argb: XL.rojo } };
        }
        ctx.enlazarCorreo(r.getCell(6));
        r.outlineLevel = 1;
        r.height = 18;
        fila++;
    };

    const vacio = (texto) => {
        hoja.mergeCells(fila, 1, fila, ancho);
        const c = hoja.getCell(fila, 1);
        c.value = texto;
        c.font = { name: XL_FUENTE, size: 10, italic: true, color: { argb: XL.gris } };
        c.alignment = { horizontal: 'center' };
        c.border = xlBorde();
        hoja.getRow(fila).outlineLevel = 1;
        fila++;
    };

    const carpetas = (_carpetasVisibles || []).slice()
        .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));

    for (const c of carpetas) {
        const gente = (ctx.miembros[c.id] || []).slice().sort((a, b) =>
            (ORDEN_VINCULO[a.vinculo] - ORDEN_VINCULO[b.vinculo]) ||
            a.usuario.localeCompare(b.usuario, 'es'));
        grupo('CARPETA:  ' + c.nombre +
            '      ·  ' + (c.activa === false ? 'DESACTIVADA' : 'activa') +
            '  ·  ' + cuantos(gente.length, 'persona', 'personas') +
            '  ·  ' + cuantos(c.totalArchivos || 0, 'archivo', 'archivos'),
            c.activa === false ? XL.ambarSuave : XL.cianSuave);
        if (!gente.length) vacio('Todavía no hay nadie asignado a esta carpeta.');
        else gente.forEach((m, i) => persona(m.usuario, m.vinculo, i % 2 === 1));
        fila++;   // renglón vacío entre carpetas
    }

    /* Cuentas sin carpeta al final (si no, no saldrían). */
    const sueltos = _usuariosCache.filter(u =>
        !ctx.VE_TODO.includes(u.rol) && !(ctx.carpetasDe[u.usuario] || []).length);
    if (sueltos.length) {
        grupo('SIN CARPETA:  ' + cuantos(sueltos.length, 'cuenta que no está asignada', 'cuentas que no están asignadas') +
            ' a ningún proceso', XL.rojoSuave);
        sueltos.forEach((u, i) => persona(u.usuario, '—', i % 2 === 1));
        fila++;
    }

    const mandos = _usuariosCache.filter(u => ctx.VE_TODO.includes(u.rol));
    if (mandos.length) {
        grupo('ADMINISTRADORES Y MONITORES:  ven todas las carpetas por su rol, ' +
            'no se asignan a ninguna', XL.verdeSuave);
        mandos.forEach((u, i) => persona(u.usuario, 'Todas', i % 2 === 1));
    }

    if (fila === 3) vacio('No hay carpetas en esta notaría.');

    hoja.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
    return hoja;
}

/* ---- Portada ---- */
function xlPortada(libro, ctx, roles) {
    const ancho = 6;
    const hoja = libro.addWorksheet('Portada', {
        properties: { tabColor: { argb: XL.navy } },
        pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    hoja.columns = [{ width: 4 }, { width: 26 }, { width: 30 }, { width: 18 }, { width: 18 }, { width: 6 }];
    hoja.views = [{ showGridLines: false }];

    hoja.getRow(1).height = 10;
    xlBanda(hoja, 2, ancho, 'PORTAL DOCUMENTAL', XL.navy, 20);
    const sub = xlBanda(hoja, 3, ancho, 'CREDENCIALES DE ACCESO', XL.cian, 13);
    sub.font = { name: XL_FUENTE, size: 13, bold: true, color: { argb: XL.blanco } };
    hoja.getRow(4).height = 14;

    let fila = 5;
    // Etiqueta a la izquierda, valor a la derecha
    const dato = (etiqueta, valor, enlace) => {
        const a = hoja.getCell(fila, 2);
        a.value = etiqueta;
        a.font = { name: XL_FUENTE, size: 10, bold: true, color: { argb: XL.navy } };
        a.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.banda } };
        a.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        a.border = xlBorde();
        hoja.mergeCells(fila, 3, fila, 5);
        const b = hoja.getCell(fila, 3);
        b.value = enlace ? { text: valor, hyperlink: enlace } : valor;
        b.font = enlace
            ? { name: XL_FUENTE, size: 10, color: { argb: XL.cian }, underline: true }
            : { name: XL_FUENTE, size: 10 };
        b.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        b.border = xlBorde();
        hoja.getRow(fila).height = 19;
        fila++;
    };

    dato('Notaría', ctx.notaria);
    dato('Generado', ctx.generado);
    dato('Generado por', ctx.generadoPor);
    dato('Dirección del portal', ctx.portal || '(sin determinar)', ctx.portal || undefined);
    fila++;

    xlBanda(hoja, fila, ancho, 'CUENTAS POR TIPO', XL.navy700, 11); fila++;
    const cab = hoja.getRow(fila);
    [[2, 'Tipo de cuenta'], [3, 'Activas'], [4, 'Total']].forEach(([i, t]) => {
        const c = cab.getCell(i);
        c.value = t;
        c.font = { name: XL_FUENTE, size: 10, bold: true, color: { argb: XL.blanco } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.navy700 } };
        c.alignment = { horizontal: i === 2 ? 'left' : 'center', indent: i === 2 ? 1 : 0 };
        c.border = xlBorde(XL.navy700);
    });
    cab.height = 20;
    fila++;

    for (const [rol, titulo] of roles) {
        const total = _usuariosCache.filter(u => u.rol === rol).length;
        const activos = _usuariosCache.filter(u => u.rol === rol && u.activo !== false).length;
        const r = hoja.getRow(fila);
        [[2, titulo], [3, activos], [4, total]].forEach(([col, v]) => {
            const c = r.getCell(col);
            c.value = v;
            c.font = { name: XL_FUENTE, size: 10 };
            c.alignment = { horizontal: col === 2 ? 'left' : 'center', indent: col === 2 ? 1 : 0 };
            c.border = xlBorde();
            if (fila % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.banda } };
        });
        fila++;
    }

    const rt = hoja.getRow(fila);
    [[2, 'TOTAL'], [3, _usuariosCache.filter(u => u.activo !== false).length], [4, _usuariosCache.length]]
        .forEach(([col, v]) => {
            const c = rt.getCell(col);
            c.value = v;
            c.font = { name: XL_FUENTE, size: 10, bold: true, color: { argb: XL.blanco } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.navy700 } };
            c.alignment = { horizontal: col === 2 ? 'left' : 'center', indent: col === 2 ? 1 : 0 };
            c.border = xlBorde(XL.navy700);
        });
    fila += 2;

    const carp = (_carpetasVisibles || []).length;
    dato('Carpetas del expediente', cuantos(carp, 'proceso', 'procesos') + '. El detalle está en la hoja «Por carpeta»');
    fila++;

    /* Aviso: el archivo lleva contraseñas reales de clientes y acreedores. */
    xlBanda(hoja, fila, ancho, 'ADVERTENCIA', XL.rojo, 12); fila++;
    hoja.mergeCells(fila, 2, fila + 3, 5);
    const av = hoja.getCell(fila, 2);
    av.value = 'Este archivo contiene las contraseñas de acceso al portal.\n' +
        'No lo envíes por correo ni lo dejes en una carpeta compartida. ' +
        'Guárdalo cifrado y bórralo cuando termines de usarlo.\n' +
        'Para entregarle sus datos a una persona, usa el botón «Copiar correo» ' +
        'del portal: manda solo lo suyo y no la lista entera.';
    av.font = { name: XL_FUENTE, size: 10, color: { argb: XL.rojo } };
    av.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.rojoSuave } };
    av.alignment = { vertical: 'top', horizontal: 'left', wrapText: true, indent: 1 };
    av.border = xlBorde(XL.rojo);

    return hoja;
}

/* Usuarios a Excel: portada, todos, por carpeta y una hoja por rol.
   La contraseña sale de credenciales (la que asignó el admin). La real está
   en auth.users como hash y no se puede leer. Las que faltan salen en rojo
   y se arreglan con "Completar contraseñas". */
async function exportarUsuariosExcel() {
    if (!ES_ADMIN) return;
    const boton = document.querySelector('[data-accion="exportar-usuarios-excel"]');
    const textoBoton = boton ? boton.innerHTML : '';
    try {
        if (boton) { boton.disabled = true; boton.textContent = 'Generando…'; }
        const ExcelJS = await cargarExcelJS();
        const libro = new ExcelJS.Workbook();
        libro.creator = 'Portal Documental';
        libro.company = NOMBRE_ENTIDAD;
        libro.created = new Date();

        const hoy = new Date();
        const nombreNotaria = (id) => {
            const n = _notariasDisponibles.find(x => String(x.id) === String(id));
            return n ? n.ciudad + ' · ' + n.nombre : '';
        };
        const fecha = (ms) => ms ? new Date(ms).toLocaleString('es-CO',
            { dateStyle: 'medium', timeStyle: 'short' }) : '';

        /* Quién está en qué carpeta, desde _carpetasVisibles (sin consultas nuevas).
           El vínculo (deudor o acreedor) sale del rol del perfil. */
        const porUsuario = {};
        for (const u of _usuariosCache) porUsuario[u.usuario] = u;

        const miembros = {};    // carpeta → [{ usuario, vinculo }]
        const carpetasDe = {};  // usuario → [{ nombre, vinculo }]
        const anotar = (c, usuario, vinculo) => {
            (miembros[c.id] = miembros[c.id] || []).push({ usuario, vinculo });
            (carpetasDe[usuario] = carpetasDe[usuario] || []).push({ nombre: c.nombre, vinculo });
        };
        for (const c of (_carpetasVisibles || [])) {
            for (const u of (c.operadores || [])) anotar(c, u, 'Operador');
            for (const u of (c.asignados || [])) {
                anotar(c, u, (porUsuario[u] || {}).rol === 'acreedor' ? 'Acreedor' : 'Deudor');
            }
        }

        /* Admin y monitor ven todo por rol: no se dejan en blanco. */
        const VE_TODO = ['administrador', 'monitor'];
        const carpetasTexto = (u) => {
            if (VE_TODO.includes(u.rol)) return 'Todas (por su rol)';
            const suyas = carpetasDe[u.usuario] || [];
            return suyas.length ? suyas.map(v => v.nombre).join(' · ') : '(ninguna)';
        };

        // Rojo sobre rosa: la que hay que arreglar
        const resaltarClave = (c) => {
            if (c.value !== '(sin anotar)') return;
            c.font = { name: XL_FUENTE, size: 10, bold: true, color: { argb: XL.rojo } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.rojoSuave } };
        };
        const resaltarEstado = (c) => {
            // Asignación a una cuenta borrada: en gris (en verde parecería activa).
            if (!c.value) {
                c.value = '—';
                c.font = { name: XL_FUENTE, size: 10, color: { argb: XL.gris } };
                c.alignment = { vertical: 'middle', horizontal: 'center' };
                return;
            }
            const malo = c.value === 'Desactivado';
            c.font = { name: XL_FUENTE, size: 10, bold: true,
                       color: { argb: malo ? XL.ambar : XL.verde } };
            c.fill = { type: 'pattern', pattern: 'solid',
                       fgColor: { argb: malo ? XL.ambarSuave : XL.verdeSuave } };
            c.alignment = { vertical: 'middle', horizontal: 'center' };
        };
        const enlazarCorreo = (c) => {
            const v = String(c.value || '');
            if (!v.includes('@')) return;
            c.value = { text: v, hyperlink: 'mailto:' + v };
            c.font = { name: XL_FUENTE, size: 10, color: { argb: XL.cian }, underline: true };
        };

        const pintarPersona = (hoja, fila, u, par) => {
            const v = [
                u.usuario,
                u.clave || '(sin anotar)',
                u.nombre,
                ETIQUETAS_ROL[u.rol] || u.rol,
                carpetasTexto(u),
                u.correo || '',
                (u.notarias || []).map(nombreNotaria).filter(Boolean).join(' / '),
                u.activo === false ? 'Desactivado' : 'Activo',
                fecha(u.ultimaConexion),
                fecha(u.claveActualizada),
                fecha(u.creado)
            ];
            const r = hoja.getRow(fila);
            v.forEach((valor, i) => {
                const c = r.getCell(i + 1);
                c.value = valor;
                c.font = { name: XL_FUENTE, size: 10 };
                c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: i === 4 };
                c.border = xlBorde();
                if (par) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.banda } };
            });
            r.getCell(1).font = { name: XL_FUENTE, size: 10, bold: true };
            resaltarClave(r.getCell(2));
            resaltarEstado(r.getCell(8));
            enlazarCorreo(r.getCell(6));
            r.height = 18;
        };

        const ctx = {
            notaria: notariaActual()
                ? notariaActual().ciudad + ' · ' + notariaActual().nombre
                : 'Todas las notarías',
            generado: hoy.toLocaleString('es-CO', { dateStyle: 'full', timeStyle: 'short' }),
            generadoPor: (sesion && sesion.nombre) || '',
            portal: enlacePortal(),
            porUsuario, miembros, carpetasDe, VE_TODO,
            pintarPersona, resaltarClave, resaltarEstado, enlazarCorreo
        };

        const roles = [
            ['administrador', 'Administradores', XL.navy700],
            ['operador',      'Operadores',      XL.cian],
            ['cliente',       'Deudores',        XL.verde],
            ['acreedor',      'Acreedores',      XL.naranja],
            ['monitor',       'Monitores',       XL.gris]
        ];

        xlPortada(libro, ctx, roles);
        xlHojaGente(libro, 'Todos', _usuariosCache, ctx, XL.cian);
        xlHojaPorCarpeta(libro, ctx);
        for (const [rol, titulo, color] of roles) {
            xlHojaGente(libro, titulo, _usuariosCache.filter(u => u.rol === rol), ctx, color);
        }

        const datos = await libro.xlsx.writeBuffer();
        const blob = new Blob([datos], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const url = URL.createObjectURL(blob);
        const enlace = document.createElement('a');
        enlace.href = url;
        enlace.download = 'credenciales_portal_' + hoy.toISOString().slice(0, 10) + '.xlsx';
        document.body.appendChild(enlace);
        enlace.click();
        enlace.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);

        registrarActividad('exportar-usuarios', 'Excel de credenciales');

        const sinAnotar = _usuariosCache.filter(u => !u.clave).length;
        avisar(sinAnotar
            ? 'Excel descargado. ' + cuantos(sinAnotar, 'cuenta sale', 'cuentas salen') + ' en rojo por no tener ' +
              'contraseña anotada: arréglalas de una vez con «Completar contraseñas».'
            : 'Excel descargado con las credenciales. Contiene contraseñas: guárdalo con cuidado.');
    } catch (e) {
        avisar((e && e.message) || 'No se pudo generar el Excel.', 'error');
    } finally {
        if (boton) { boton.disabled = false; boton.innerHTML = textoBoton; }
    }
}

/* ============ FORMATOS DE CORREO ============
   Plantillas en correos.js; aquí la pantalla. "Copiar con formato" deja el
   HTML en el portapapeles para pegarlo en Gmail. "Abrir en el correo" solo
   pone destinatario y asunto (mailto: no admite HTML y se corta). */
let _correoUsuario = null;
let _correoFormato = 'bienvenida';

function abrirCorreoUsuario(nombreUsuario) {
    if (!ES_ADMIN) return;
    const u = _usuariosCache.find(x => x.usuario === nombreUsuario);
    if (!u) { avisar('No se encontró esa cuenta.', 'error'); return; }
    _correoUsuario = u;
    _correoFormato = 'bienvenida';
    document.querySelectorAll('#correo-formatos button').forEach(b =>
        b.classList.toggle('activa', b.dataset.formato === _correoFormato));
    document.getElementById('correo-destinatario').textContent = u.nombre || u.usuario;
    document.getElementById('modal-correo').hidden = false;
    pintarCorreo();
}

/* En celular el correo (600 px) se encoge para verse entero, sin barra de lado. */
function ajustarVistaCorreo() {
    const vista = document.getElementById('correo-vista');
    const lienzo = vista && vista.firstElementChild;
    if (!lienzo || document.getElementById('modal-correo').hidden) return;
    lienzo.style.zoom = '';
    const ancho = lienzo.scrollWidth, cabe = vista.clientWidth;
    if (ancho > cabe + 1) lienzo.style.zoom = String(Math.max(0.4, cabe / ancho));
}
window.addEventListener('resize', ajustarVistaCorreo);

function cerrarModalCorreo() {
    document.getElementById('modal-correo').hidden = true;
    _correoUsuario = null;
}

function cambiarFormatoCorreo(clave) {
    if (!FORMATOS_CORREO[clave]) return;
    _correoFormato = clave;
    document.querySelectorAll('#correo-formatos button').forEach(b =>
        b.classList.toggle('activa', b.dataset.formato === clave));
    pintarCorreo();
}

/* Datos para las plantillas. Si la persona está en una sola carpeta, se nombra. */
function datosCorreo() {
    const u = _correoUsuario || {};
    const suyas = (_carpetasVisibles || []).filter(c =>
        (c.asignados || []).includes(u.usuario) || (c.operadores || []).includes(u.usuario));
    const n = notariaActual();
    return {
        nombre: u.nombre || '',
        rol: u.rol || '',
        usuario: u.usuario || '',
        clave: u.clave || '',
        carpeta: suyas.length === 1 ? suyas[0].nombre : '',
        portal: enlacePortal(),
        notaria: n ? n.ciudad + ' · ' + n.nombre : '',
        // Sin firma personal: lo manda la notaría

    };
}

function pintarCorreo() {
    const datos = datosCorreo();
    const correo = FORMATOS_CORREO[_correoFormato].arma(datos);
    document.getElementById('correo-asunto').value = correo.asunto;
    document.getElementById('correo-vista').innerHTML = '<div class="pt-correo-lienzo">' + correo.html + '</div>';
    ajustarVistaCorreo();

    // Sin contraseña anotada no hay correo de credenciales
    const aviso = document.getElementById('correo-aviso');
    // La bienvenida también lleva credenciales
    const llevaClave = _correoFormato === 'credenciales' || _correoFormato === 'bienvenida';
    const falta = llevaClave && !datos.clave;
    aviso.hidden = !falta;
    if (falta) {
        aviso.textContent = 'Esta cuenta no tiene contraseña anotada, así que el recuadro ' +
            'saldría vacío. Usa «Completar contraseñas» o restablécele la clave desde Editar, ' +
            'y vuelve aquí.';
    }
    return correo;
}

async function copiarCorreo(soloTexto) {
    const correo = FORMATOS_CORREO[_correoFormato].arma(datosCorreo());
    try {
        if (soloTexto) {
            await navigator.clipboard.writeText(correo.texto);
        } else if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            // HTML para Gmail, texto para el Bloc de notas
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([correo.html], { type: 'text/html' }),
                'text/plain': new Blob([correo.texto], { type: 'text/plain' })
            })]);
        } else {
            // Sin ClipboardItem: se copia la selección (con formato)
            const vista = document.getElementById('correo-vista');
            const rango = document.createRange();
            // El contenido del lienzo, sin su zoom
            rango.selectNodeContents(vista.firstElementChild || vista);
            const sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(rango);
            document.execCommand('copy');
            sel.removeAllRanges();
        }
        avisar(soloTexto
            ? 'Copiado como texto. Pégalo en el correo.'
            : 'Copiado con formato. Pégalo en Gmail y llega igual que aquí.');
        registrarActividad('formato-correo', _correoFormato + ' · ' + (_correoUsuario || {}).usuario);
    } catch (e) {
        avisar('El navegador no dejó copiar. Selecciona la vista previa con el ratón y usa Ctrl+C.', 'error');
    }
}

/* Abre el correo con destinatario y asunto. El cuerpo se pega aparte. */
function abrirCorreoEnCliente() {
    const u = _correoUsuario || {};
    const correo = FORMATOS_CORREO[_correoFormato].arma(datosCorreo());
    const destino = u.correo || '';
    if (!destino) {
        avisar('Esta cuenta no tiene correo de contacto. Añádeselo en Editar usuario.', 'error');
        return;
    }
    location.href = 'mailto:' + encodeURIComponent(destino) +
        '?subject=' + encodeURIComponent(correo.asunto);
    avisar('Se abrió tu programa de correo. Pega el mensaje con «Copiar con formato».');
}

/* ============ COMPLETAR CONTRASEÑAS QUE FALTAN ============
   No recupera nada (bcrypt no se puede leer): asigna una nueva y la anota.
   Por eso se avisa antes: las de hoy dejan de servir. La cuenta propia
   queda fuera (cambiarla cortaría la sesión a la mitad). */
let _completandoClaves = false;

async function completarClavesFaltantes() {
    if (!ES_ADMIN || _completandoClaves) return;

    const yo = (sesion && sesion.usuario) || '';
    const faltan = _usuariosCache.filter(u => !u.clave && u.usuario !== yo);

    if (!faltan.length) {
        avisar(_usuariosCache.some(u => !u.clave && u.usuario === yo)
            ? 'Las demás cuentas ya tienen su contraseña anotada. La tuya no se cambia desde aquí: hazlo en Editar usuario.'
            : 'Todas las cuentas ya tienen su contraseña anotada.');
        return;
    }

    const ok = await confirmarPortal(
        cuantos(faltan.length, 'cuenta no tiene', 'cuentas no tienen') + ' contraseña anotada, y la que usan hoy ' +
        'no se puede leer: el servidor solo guarda un hash. Para que salgan en el Excel ' +
        'hay que asignarles una nueva.\n\n' +
        (faltan.length === 1
            ? 'Si continúas, esa persona dejará de entrar con su contraseña actual y tendrás que ' +
              'darle la nueva, que quedará en el Excel. '
            : 'Si continúas, esas ' + faltan.length + ' personas dejarán de entrar con su ' +
              'contraseña actual y tendrás que darles la nueva, que quedará en el Excel. ') +
        'Tu propia cuenta no se toca.',
        'Asignar contraseña nueva a ' + cuantos(faltan.length, 'cuenta', 'cuentas'));
    if (!ok) return;

    const caja = document.getElementById('claves-progreso');
    const eti = document.getElementById('claves-progreso-eti');
    const num = document.getElementById('claves-progreso-num');
    const barra = document.getElementById('claves-progreso-barra');
    const quien = document.getElementById('claves-progreso-quien');
    const boton = document.querySelector('[data-accion="completar-claves"]');

    _completandoClaves = true;
    if (boton) boton.disabled = true;
    if (caja) {
        caja.hidden = false;
        caja.classList.remove('pt-progreso--listo', 'pt-progreso--fallo');
        eti.textContent = 'Asignando contraseñas…';
        num.textContent = '0 de ' + faltan.length;
        barra.style.width = '0%';
        quien.textContent = '';
    }

    let hechas = 0, listas = 0;
    const fallidas = [];

    // De tres en tres: cada cuenta son dos llamadas
    await enTandas(faltan, 3, async (u) => {
        try {
            const clave = generarClaveSegura();
            await restablecerClave(u, clave);
            // El apunte va después: si falla, la clave ya cambió y hay que saberlo
            await credencialGuardar(u.usuario, clave);
            listas++;
        } catch (e) {
            fallidas.push(u.usuario + ' (' + ((e && e.message) || 'error') + ')');
        }
        hechas++;
        if (caja) {
            num.textContent = hechas + ' de ' + faltan.length;
            barra.style.width = Math.round((hechas / faltan.length) * 100) + '%';
            quien.textContent = u.usuario;
        }
    });

    if (caja) {
        caja.classList.toggle('pt-progreso--fallo', fallidas.length > 0);
        caja.classList.toggle('pt-progreso--listo', fallidas.length === 0);
        eti.textContent = fallidas.length ? 'Terminado con fallos' : 'Contraseñas asignadas';
        num.textContent = listas + ' de ' + faltan.length;
        barra.style.width = '100%';
        quien.textContent = '';
        setTimeout(() => { if (caja) caja.hidden = true; }, 8000);
    }

    _completandoClaves = false;
    if (boton) boton.disabled = false;

    registrarActividad('completar-claves', cuantos(listas, 'contraseña asignada', 'contraseñas asignadas'));
    try { aplicarUsuarios(await dbTodos('usuarios')); } catch (_) { /* la vista se refresca al volver */ }

    if (fallidas.length) {
        avisar('Se asignaron ' + listas + ' de ' + faltan.length + '. Sin cambiar: ' +
            fallidas.slice(0, 3).join(', ') +
            (fallidas.length > 3 ? ' y ' + (fallidas.length - 3) + ' más.' : '.'), 'error');
    } else {
        avisar(cuantos(listas, 'contraseña asignada y anotada', 'contraseñas asignadas y anotadas') +
            '. Descarga el Excel: ya salen todas. ' +
            'Acuérdate de darle la nueva a cada persona.');
    }
}

/* ============ CENTRO DE NOTIFICACIONES (admin) ============ */
const VERBOS_ACCION = {
    'ingreso':            { ic: 'ingreso',        verbo: 'inició sesión en el portal' },
    'abrir-carpeta':      { ic: 'carpeta-abrir',  verbo: 'abrió la carpeta' },
    'ver-archivo':        { ic: 'ver',            verbo: 'visualizó' },
    'descargar-archivo':  { ic: 'descargar',      verbo: 'descargó' },
    'descargar-zip':      { ic: 'paquete',        verbo: 'descargó la carpeta (ZIP)' },
    'subir-archivo':      { ic: 'subir',          verbo: 'subió' },
    'eliminar-archivo':   { ic: 'eliminar',       verbo: 'eliminó' },
    'vaciar-carpeta':     { ic: 'eliminar',       verbo: 'vació el expediente:' },
    'crear-carpeta':      { ic: 'carpeta-nueva',  verbo: 'creó la carpeta' },
    'editar-carpeta':     { ic: 'editar',         verbo: 'editó la carpeta' },
    'activar-carpeta':    { ic: 'activar',        verbo: 'activó la carpeta' },
    'desactivar-carpeta': { ic: 'desactivar',     verbo: 'desactivó la carpeta' },
    'eliminar-carpeta':   { ic: 'eliminar',       verbo: 'eliminó la carpeta' },
    'actualizar-estado':  { ic: 'estado',         verbo: 'actualizó la etapa de' },
    'actualizar-notas':   { ic: 'editar',         verbo: 'actualizó las notas de' },
    'actualizar-deudor':  { ic: 'usuario',        verbo: 'actualizó los datos del deudor de' },
    'mensaje-chat':       { ic: 'chat',           verbo: 'escribió en el chat' },
    'notificar-audiencia':{ ic: 'campana',        verbo: 'notificó la audiencia' },
    'generar-expediente': { ic: 'expediente',     verbo: 'generó el expediente de' },
    'ordenar-documentos': { ic: 'editar',         verbo: 'reorganizó los documentos de' },
    'crear-proceso':      { ic: 'estado',         verbo: 'creó el proceso' },
    'completar-proceso':  { ic: 'activar',        verbo: 'completó el proceso' },
    'eliminar-proceso':   { ic: 'eliminar',       verbo: 'eliminó el proceso' },
    'pausar-tramite':     { ic: 'desactivar',     verbo: 'pausó el trámite' },
    'iniciar-tramite':    { ic: 'estado',         verbo: 'inició el conteo (60 días) de' },
    'prorroga-tramite':   { ic: 'estado',         verbo: 'aplicó la prórroga (90 días) a' },
    'llamada-soporte':    { ic: 'chat',           verbo: 'llamó por soporte a' },
    'fin-tramite':        { ic: 'activar',        verbo: 'dio fin al trámite' },
    'consentimiento':     { ic: 'documento',      verbo: 'aceptó la política de datos' },
    'constancia-acreedores': { ic: 'descargar',   verbo: 'descargó la constancia de acreedores de' },
    'reactivar-tramite':  { ic: 'activar',        verbo: 'reactivó el trámite' },
    'corregir-proceso':   { ic: 'editar',         verbo: 'corrigió el proceso' }
};
const ROLES_NOTIF = ['cliente', 'acreedor', 'operador', 'monitor'];
let _actividadCache = [];
let _rolNotifActivo = 'cliente';
let _filtroNotifCarpeta = '';   // '' = todo; id = esa carpeta

/* Registro de actividad (admin y monitor). */
async function mostrarVistaNotificaciones() {
    if (!ES_SUPERVISION) return; // admin y monitor (lectura)
    mostrarVista('vista-notificaciones');
    document.getElementById('lista-notificaciones').innerHTML =
        esqueletoLista(8);
    const [actividad, carpetas] = await Promise.all([listarActividad(), dbTodos('carpetas')]);
    _actividadCache = actividad;

    // Filtro por carpeta
    const zona = document.getElementById('filtro-notif-carpeta-zona');
    if (zona) {
        zona.innerHTML = '<label class="pt-nota">' + icono('buscar', 14) + ' Carpeta: ' +
            '<select id="filtro-notif-carpeta">' +
            '<option value="">Todas las carpetas</option>' +
            carpetas.sort((a, b) => a.nombre.localeCompare(b.nombre)).map(c =>
                '<option value="' + c.id + '"' + (String(_filtroNotifCarpeta) === String(c.id) ? ' selected' : '') + '>' +
                escaparHtml(c.nombre) + '</option>').join('') +
            '</select></label>';
        document.getElementById('filtro-notif-carpeta').addEventListener('change', (e) => {
            _filtroNotifCarpeta = e.target.value;
            pintarNotificaciones();
        });
    }
    pintarNotificaciones();
}

/* Filtro por rol. */
function cambiarRolNotif(rol) {
    if (!ROLES_NOTIF.includes(rol)) return;
    _rolNotifActivo = rol;
    document.querySelectorAll('#sub-pestanas-notif button').forEach(b =>
        b.classList.toggle('activa', b.dataset.rol === rol));
    pintarNotificaciones();
}

/* Registro filtrado. */
function pintarNotificaciones() {
    // Toda la actividad del rol. Con filtro de carpeta, los ingresos al portal
    // siguen saliendo (no van atados a carpeta).
    const eventos = _actividadCache.filter(e =>
        e.rol === _rolNotifActivo &&
        (!_filtroNotifCarpeta || String(e.carpetaId) === String(_filtroNotifCarpeta) || e.accion === 'ingreso'));
    const lista = document.getElementById('lista-notificaciones');
    const vacio = document.getElementById('notificaciones-vacio');

    if (eventos.length === 0) {
        lista.innerHTML = '';
        vacio.hidden = false;
        vacio.textContent = 'Todavía no hay actividad registrada de ' + ETIQUETAS_ROL[_rolNotifActivo].toLowerCase() + 's' +
            (_filtroNotifCarpeta ? ' en esa carpeta.' : '.');
        return;
    }
    vacio.hidden = true;

    // Agrupado por día
    let html = '';
    let diaActual = '';
    for (const e of eventos) {
        const dia = new Date(e.fecha).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        if (dia !== diaActual) {
            diaActual = dia;
            html += '<p class="pt-notif-dia">' + escaparHtml(dia.charAt(0).toUpperCase() + dia.slice(1)) + '</p>';
        }
        const info = VERBOS_ACCION[e.accion] || { ic: 'adjunto', verbo: e.accion };
        const hora = new Date(e.fecha).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        html += '<div class="pt-notif">' +
            '<span class="pt-notif__icono">' + icono(info.ic) + '</span>' +
            '<div class="pt-notif__texto">' +
                '<p><strong>' + escaparHtml(e.nombre || e.usuario) + '</strong> ' + escaparHtml(info.verbo) +
                    (e.objetivo ? ' <span class="pt-notif__objetivo">«' + escaparHtml(e.objetivo) + '»</span>' : '') + '</p>' +
                '<p class="pt-notif__hora">' + hora + '</p>' +
            '</div>' +
        '</div>';
    }
    lista.innerHTML = html;
}

/* Crea un usuario por la función del servidor (el navegador nunca ve la clave de servicio). */
async function crearUsuario(evento) {
    evento.preventDefault();
    if (!ES_ADMIN) return;

    const usuario = document.getElementById('nuevo-usuario').value.trim().toLowerCase();
    const nombre = document.getElementById('nuevo-nombre').value.trim();
    const clave = document.getElementById('nueva-clave').value;
    const rol = document.getElementById('nuevo-rol').value;
    const correo = document.getElementById('nuevo-correo').value.trim();
    const notarias = notariasMarcadasEnFormulario();

    // El admin ve todas por rol; los demás necesitan su oficina
    if (rol !== 'administrador' && _notariasDisponibles.length && !notarias.length) {
        avisar('Elige la notaría donde va a trabajar este usuario.', 'error');
        return;
    }
    if (rol !== 'administrador' && rol !== 'operador' && notarias.length > 1) {
        avisar('Este rol trabaja en una sola notaría.', 'error');
        return;
    }

    if (!usuario || !nombre || clave.length < 8 || !ROLES_VALIDOS.includes(rol)) {
        avisar('Revisa los datos: la contraseña necesita mínimo 8 caracteres.', 'error');
        return;
    }
    // Correo obligatorio para operador, cliente y acreedor (avisos). Admin y monitor no.
    if (correoObligatorio(rol)) {
        if (!correo || !esCorreoValido(correo)) {
            avisar('El rol «' + rol + '» necesita un correo de contacto válido: ' +
                   'por ahí le llegan los avisos del trámite.', 'error');
            return;
        }
    } else if (correo && !esCorreoValido(correo)) {
        avisar('El correo de contacto no tiene un formato válido.', 'error');
        return;
    }
    const existente = await dbObtener('usuarios', usuario);
    if (existente) {
        avisar('Ya existe un usuario con ese nombre.', 'error');
        return;
    }
    try {
        const aviso = await crearUsuarioDatos(usuario, nombre, rol, clave, correo, notarias);
        // Se anota la clave para el Excel. Si falla, la cuenta ya existe: solo se avisa.
        try { await credencialGuardar(usuario, clave); }
        catch (e) { avisar('Usuario creado, pero no se pudo anotar la contraseña: ' + (e.message || ''), 'error'); }
        avisar(aviso || ('Usuario "' + usuario + '" creado.'), aviso ? 'error' : undefined);
    } catch (e) {
        avisar(e.message || 'No se pudo crear el usuario.', 'error');
        return;
    }
    document.getElementById('form-usuario').reset();
    alternarCajonUsuario(false);
    await mostrarVistaUsuarios();
}

/* Quién necesita correo: operador, cliente y acreedor.
   La misma regla está en la base (perfiles_correo_obligatorio). */
const ROLES_CON_CORREO = ['operador', 'cliente', 'acreedor'];

function correoObligatorio(rol) {
    return ROLES_CON_CORREO.includes(rol);
}

/* Correo obligatorio u opcional según el rol (con la etiqueta). */
function ajustarCampoCorreo(idCampo, idEtiqueta, rol) {
    const campo = document.getElementById(idCampo);
    const etiqueta = document.getElementById(idEtiqueta);
    if (!campo) return;
    const obliga = correoObligatorio(rol);
    campo.required = obliga;
    campo.placeholder = obliga ? 'nombre@ejemplo.com' : 'Opcional para este rol';
    if (etiqueta) {
        etiqueta.textContent = obliga
            ? 'Correo electrónico (obligatorio: se usa para los avisos del trámite)'
            : 'Correo electrónico (opcional para administrador y monitor)';
    }
}

/* Formato básico de correo. */
function esCorreoValido(c) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c || ''));
}

/* ============ EDITAR USUARIO ============
   La contraseña anterior no se puede ver; se asigna una nueva. */
let usuarioEditando = null;

/* Abre la edición. */
function abrirModalUsuario(usuario) {
    if (!ES_ADMIN || !usuario) return;
    usuarioEditando = usuario;
    document.getElementById('editar-usuario-id').value = usuario.usuario;
    document.getElementById('editar-nombre').value = usuario.nombre || '';
    document.getElementById('editar-correo').value = usuario.correo || '';
    document.getElementById('editar-clave').value = '';
    document.getElementById('editar-notificar').checked = false;
    ajustarCampoCorreo('editar-correo', 'etiqueta-editar-correo', usuario.rol);
    document.getElementById('modal-usuario').hidden = false;
    document.getElementById('editar-nombre').focus();
    // Notarías aparte (otra tabla)
    pintarNotariasDeEdicion(usuario);
}

/* Notarías del usuario editado. Las carpetas no se mueven con él. */
async function pintarNotariasDeEdicion(usuario) {
    const campo = document.getElementById('campo-editar-notarias');
    const caja = document.getElementById('editar-notarias');
    const etiqueta = document.getElementById('etiqueta-editar-notarias');
    if (!campo || !caja) return;

    await cargarCatalogoNotarias();
    const activas = _notariasFormulario.filter(n => n.activa);
    // El admin ya las tiene todas
    if (!activas.length || usuario.rol === 'administrador') {
        campo.hidden = true; caja.innerHTML = ''; return;
    }
    campo.hidden = false;

    let suyas = [];
    try { suyas = (await notariasDePerfil(usuario.usuario)).map(String); }
    catch (e) { suyas = []; }

    const varias = usuario.rol === 'operador';
    etiqueta.textContent = varias
        ? 'Notarías donde puede trabajar (puede marcar varias)'
        : 'Notaría';
    caja.innerHTML = activas.map(n =>
        '<label class="pt-notaria-casilla">' +
            '<input type="' + (varias ? 'checkbox' : 'radio') + '" ' +
                   'name="notaria-editar" value="' + n.id + '"' +
                   (suyas.includes(String(n.id)) ? ' checked' : '') + '>' +
            '<span><b>' + escaparHtml(n.ciudad) + '</b> · ' + escaparHtml(n.nombre) + '</span>' +
        '</label>').join('');
}

/* Cierra la edición. */
function cerrarModalUsuario() {
    document.getElementById('modal-usuario').hidden = true;
    usuarioEditando = null;
}

/* Guarda cambios. La contraseña la cambia la función del servidor. */
async function guardarEdicionUsuario(evento) {
    evento.preventDefault();
    if (!ES_ADMIN || !usuarioEditando) return;

    const nombre = document.getElementById('editar-nombre').value.trim();
    const correo = document.getElementById('editar-correo').value.trim();
    const clave = document.getElementById('editar-clave').value;
    const notificar = document.getElementById('editar-notificar').checked;

    if (!nombre) { avisar('El nombre no puede quedar vacío.', 'error'); return; }
    // Misma regla que al crear: perfiles viejos sin correo deben completarlo.
    if (correoObligatorio(usuarioEditando.rol)) {
        if (!correo || !esCorreoValido(correo)) {
            avisar('El rol «' + usuarioEditando.rol + '» necesita un correo de ' +
                   'contacto válido antes de guardar.', 'error');
            return;
        }
    } else if (correo && !esCorreoValido(correo)) {
        avisar('El correo de contacto no tiene un formato válido.', 'error'); return;
    }
    if (clave && clave.length < 8) { avisar('La contraseña nueva necesita mínimo 8 caracteres.', 'error'); return; }
    if (notificar && !clave) { avisar('Marca «notificar» solo cuando pongas una contraseña nueva.', 'error'); return; }
    if (notificar && !correo) { avisar('Para notificar, el usuario debe tener un correo de contacto.', 'error'); return; }

    try {
        await dbGuardar('usuarios', { ...usuarioEditando, nombre, correo });

        // Notarías aparte
        const campoNot = document.getElementById('campo-editar-notarias');
        if (campoNot && !campoNot.hidden) {
            const marcadas = [...document.querySelectorAll('#editar-notarias input:checked')]
                .map(x => Number(x.value));
            if (!marcadas.length) {
                avisar('El usuario necesita al menos una notaría.', 'error');
                return;
            }
            await perfilNotariasFijar(usuarioEditando.usuario, marcadas);
        }

        if (clave) {
            await restablecerClave(usuarioEditando, clave);
            try { await credencialGuardar(usuarioEditando.usuario, clave); }
            catch (e) { avisar('Contraseña cambiada, pero no se pudo anotar: ' + (e.message || ''), 'error'); }
            // Si tenía solicitud de clave pendiente, se marca resuelta.
            try {
                const pendientes = await solicitudesClaveListar();
                const suya = pendientes.find(s => s.usuario === usuarioEditando.usuario);
                if (suya) await solicitudClaveResolver(suya.id);
            } catch (e) { /* no bloquea el cambio de clave */ }
        }
        avisar('Usuario actualizado' + (clave ? ', contraseña restablecida.' : '.'));
        if (notificar && clave && correo) {
            notificarClavePorCorreo({ nombre, usuario: usuarioEditando.usuario, correo, clave });
        }
    } catch (e) {
        avisar((e && e.message) || 'No se pudo actualizar el usuario.', 'error');
        return;
    }
    cerrarModalUsuario();
    await mostrarVistaUsuarios();
}

/* Abre el correo del admin con el aviso redactado (no se envía solo). */
function notificarClavePorCorreo(datos) {
    const asunto = 'Portal Documental: tu contraseña fue restablecida';
    const cuerpo =
        'Hola ' + datos.nombre + ',\n\n' +
        'El administrador restableció tu contraseña del Portal Documental.\n\n' +
        'Usuario: ' + datos.usuario + '\n' +
        'Nueva contraseña: ' + datos.clave + '\n\n' +
        'Ingresa y, por seguridad, cámbiala cuando puedas.\n\n' +
        NOMBRE_ENTIDAD + '.';
    const enlace = document.createElement('a');
    enlace.href = 'mailto:' + encodeURIComponent(datos.correo) +
        '?subject=' + encodeURIComponent(asunto) +
        '&body=' + encodeURIComponent(cuerpo);
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
}

/* El último admin activo no se puede desactivar ni borrar */
async function esUltimoAdminActivo(nombreUsuario) {
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo || objetivo.rol !== 'administrador' || objetivo.activo === false) return false;
    const usuarios = await dbTodos('usuarios');
    const adminsActivos = usuarios.filter(u => u.rol === 'administrador' && u.activo !== false);
    return adminsActivos.length <= 1;
}

/* Activa o desactiva una cuenta. */
async function alternarUsuario(nombreUsuario) {
    if (!ES_ADMIN || nombreUsuario === sesion.usuario) return;
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo) return;

    if (objetivo.activo !== false && await esUltimoAdminActivo(nombreUsuario)) {
        avisar('No puedes desactivar al último administrador activo.', 'error');
        return;
    }
    objetivo.activo = objetivo.activo === false;
    await dbGuardar('usuarios', objetivo);
    avisar(objetivo.activo
        ? 'Usuario "' + nombreUsuario + '" activado: ya puede ingresar.'
        : 'Usuario "' + nombreUsuario + '" desactivado: no podrá ingresar al portal.');
    await mostrarVistaUsuarios();
}

/* Borra una cuenta (con confirmación). */
async function eliminarUsuario(nombreUsuario) {
    if (!ES_ADMIN || nombreUsuario === sesion.usuario) return;
    const objetivo = await dbObtener('usuarios', nombreUsuario);
    if (!objetivo) return;

    if (await esUltimoAdminActivo(nombreUsuario)) {
        avisar('No puedes eliminar al último administrador activo.', 'error');
        return;
    }
    if (!await confirmarPortal('¿Eliminar al usuario "' + nombreUsuario + '"?')) return;
    await dbEliminar('usuarios', nombreUsuario);
    avisar('Usuario eliminado.');
    await mostrarVistaUsuarios();
}

/* ============ EVENTOS ============ */
function conectarEventos() {
    // Un solo escuchador para todos los data-accion
    document.addEventListener('click', (evento) => {
        // La campana se cierra con clic fuera
        const dd = document.getElementById('campana-dropdown');
        if (dd && !dd.hidden && !evento.target.closest('.pt-campana-envoltura')) dd.hidden = true;

        // Clic fuera cierra el menú ⋯
        if (!evento.target.closest('.pt-menu')) cerrarMenusFila();

        const boton = evento.target.closest('[data-accion]');
        if (!boton) return;
        if (boton.getAttribute('aria-busy') === 'true') return;   // ya está en eso
        const id = Number(boton.dataset.id);

        // Elegir una opción también lo cierra
        if (boton.closest('.pt-menu__lista')) cerrarMenusFila();

        switch (boton.dataset.accion) {
            case 'salir':             confirmarSalida(); break;
            case 'ver-carpetas':      mostrarVistaCarpetas(); break;
            case 'alternar-subida':   alternarZonaSubida(); break;

            // Subcarpetas dentro de la carpeta
            case 'abrir-subcarpeta':     abrirSubcarpeta(boton.dataset.sub); break;
            case 'nueva-subcarpeta':     nuevaSubcarpetaAccion(); break;
            case 'renombrar-subcarpeta': renombrarSubcarpetaAccion(); break;
            case 'eliminar-subcarpeta':  eliminarSubcarpetaAccion(); break;
            case 'texto-cancelar':       _responderTexto(null); break;
            case 'abrir-cajon-usuario':  alternarCajonUsuario(true); break;
            case 'cerrar-cajon-usuario': alternarCajonUsuario(false); break;

            // Barra lateral en pantallas angostas
            case 'abrir-lateral':     mostrarLateral(); break;
            case 'plegar-lateral':    plegarLateral(true); break;

            // Notarías
            case 'elegir-notaria':    elegirNotaria(boton.dataset.notaria); break;
            case 'marcar-notaria':    marcarNotaria(boton.dataset.notaria); break;
            case 'entrar-notaria':    entrarNotariaMarcada(); break;
            case 'cerrar-modal-notaria': cerrarModalNotaria(); break;
            case 'cambiar-notaria':   cambiarNotaria(); break;
            case 'volver-al-portal':  volverAlPortal(); break;
            case 'nueva-notaria':     nuevaNotariaAccion(); break;
            case 'editar-notaria':    editarNotariaAccion(id); break;
            case 'alternar-notaria':  alternarNotariaAccion(id); break;
            case 'cerrar-lateral':    alternarLateral(false); break;

            // Menú ⋯ de carpeta
            case 'menu-carpeta':      alternarMenuFila('menu-carpeta-' + id); break;
            case 'menu-tramite':      alternarMenuFila('menu-tramite-' + id); break;

            // Estados y calendario de vencimientos
            case 'ver-estados':          mostrarVistaEstados(); break;
            case 'refrescar-estados':    cargarYPintarEstados(); break;
            case 'alternar-vista-estados':
                _vistaEstados = (_vistaEstados === 'tabla' ? 'tablero' : 'tabla');
                pintarEstados();
                break;
            case 'ver-calendario-vencimientos': mostrarVistaCalendarioVenc(); break;
            case 'refrescar-calendario': mostrarVistaCalendarioVenc(); break;
            case 'nuevo-proceso':        abrirModalProceso(id); break;
            case 'cerrar-modal-proceso': cerrarModalProceso(); break;
            case 'completar-proceso':    completarProcesoAccion(id); break;
            case 'eliminar-proceso':     eliminarProcesoAccion(id); break;
            case 'pausar-tramite':       pausarTramiteAccion(id); break;
            case 'reactivar-tramite':    reactivarTramiteAccion(id); break;
            case 'iniciar-tramite':      iniciarTramiteAccion(id); break;
            case 'prorroga-tramite':     prorrogaTramiteAccion(id); break;
            case 'filtro-estados':       cambiarFiltroEstados(boton.dataset.filtro); break;

            // Soporte y llamadas
            case 'soporte-abrir':        abrirSoporte(); break;
            case 'soporte-minimizar':
                // el clic en un botón de la cabecera no minimiza dos veces
                minimizarSoporte(); break;
            case 'soporte-volver':       evento.stopPropagation(); pintarSoporteLista(); break;
            case 'soporte-elegir':
                abrirHiloSoporte({ id: boton.dataset.uuid, nombre: boton.dataset.nombre,
                                   rol: boton.dataset.rol, usuario: boton.dataset.usuario }); break;
            case 'soporte-alternar':     alternarSoporte(); break;
            case 'soporte-llamar':       evento.stopPropagation(); iniciarLlamadaSoporte(); break;
            case 'quitar-adjunto-soporte': quitarAdjuntoSoporte(); break;
            case 'descargar-adjunto-soporte': descargarAdjuntoDeSoporte(id); break;
            case 'llamada-aceptar':      aceptarLlamada(); break;
            case 'llamada-colgar':       terminarLlamada(true); break;
            case 'llamada-mic':          alternarMicrofono(); break;
            case 'llamada-altavoz':      alternarAltavoz(); break;

            // Campana
            case 'campana-abrir':        alternarCampana(); break;
            case 'manual-abrir':         if (window.abrirManual) abrirManual(); break;
            case 'manual-cerrar':        if (window.cerrarManual) cerrarManual(); break;
            case 'campana-limpiar':      limpiarCampana(); break;
            case 'campana-leidas':       marcarCampanaLeidas(); break;
            case 'avisos-abrir':         abrirAvisosPush(); break;
            case 'avisos-cerrar':        document.getElementById('modal-avisos').hidden = true; break;
            case 'avisos-activar':       alternarAvisosPush(); break;
            case 'avisos-probar':        probarAvisosPush(); break;

            // Usuarios: rol y Excel
            case 'filtro-rol-usuario':   cambiarFiltroRolUsuario(boton.dataset.rol); break;
            case 'exportar-usuarios-excel': conGiro(boton, exportarUsuariosExcel()); break;
            case 'completar-claves': completarClavesFaltantes(); break;
            case 'correo-usuario': abrirCorreoUsuario(boton.dataset.usuario); break;
            case 'cerrar-modal-correo': cerrarModalCorreo(); break;
            case 'correo-formato': cambiarFormatoCorreo(boton.dataset.formato); break;
            case 'correo-copiar': copiarCorreo(false); break;
            case 'correo-copiar-texto': copiarCorreo(true); break;
            case 'correo-abrir-cliente': abrirCorreoEnCliente(); break;
            case 'exportar-estados':  conGiro(boton, exportarEstadosExcel()); break;

            // Confirmación, consentimiento y consentimientos
            case 'confirmar-si':         _responderConfirmacion(true); break;
            case 'confirmar-no':         _responderConfirmacion(false); break;
            case 'consentimiento-aceptar': aceptarConsentimientoAccion(); break;
            case 'usuarios-panel':       cambiarPanelUsuarios(boton.dataset.panel); break;

            // Credenciales, fin de trámite, enlaces, chat y llamada
            case 'generar-credenciales': generarCredenciales(); break;
            case 'generar-clave-editar': generarClaveEditar(); break;
            case 'finalizar-tramite':    finalizarTramiteAccion(id); break;
            case 'notif-abrir':          abrirDesdeNotificacion(boton.dataset.tipo, id || null, boton.dataset.mensaje); break;
            case 'notif-eliminar':       evento.stopPropagation(); eliminarNotificacion(boton.dataset.notif, boton.closest('.pt-campana-item')); break;
            case 'carpeta-tab-rol':      cambiarTabRolCarpeta(boton.dataset.grupo); break;
            case 'chat-carpeta-abrir':   abrirChatCarpeta(); break;
            case 'chat-carpeta-minimizar': minimizarChatCarpeta(); break;
            case 'chat-carpeta-alternar': _chatCarpetaMin ? abrirChatCarpeta() : minimizarChatCarpeta(); break;
            case 'llamada-minimizar':    minimizarLlamada(); break;
            case 'llamada-restaurar':    restaurarLlamada(); break;
            case 'llamada-mic-mini':     alternarMicrofono(); break;
            case 'llamada-altavoz-mini': alternarAltavoz(); break;
            case 'editar-proceso':       abrirModalEditarProceso(id); break;
            case 'cerrar-modal-editar-proceso': cerrarModalEditarProceso(); break;
            case 'detalle-tramite':
                // si fue un botón de la fila, manda ese botón
                if (evento.target.closest('button') && evento.target.closest('button').dataset.accion !== 'detalle-tramite') break;
                abrirDetalleTramite(id); break;
            case 'cerrar-modal-detalle-tramite': cerrarDetalleTramite(); break;
            case 'cerrar-modal-visor':   cerrarModalVisor(); break;
            // El enlace abre el visor; el aviso se cierra después (no quitar el enlace en pleno clic)
            case 'abrir-visor-bloqueado': setTimeout(cerrarModalVisor, 0); break;
            case 'cal-venc-mes':         cambiarMesCalVenc(boton.dataset.delta); break;
            case 'cal-venc-dia':         _diaCalVencSel = boton.dataset.fecha; pintarCalendarioVenc(); break;
            case 'cal-venc-limpiar':
                _filtroCalOperador = ''; _filtroCalTramite = ''; _diaCalVencSel = null;
                pintarCalendarioVenc(); break;

            // Constancias (consentimientos y actividad de acreedores)
            case 'consentimiento-ver':       verConsentimiento(id); break;
            case 'consentimiento-descargar': descargarConstanciaConsentimiento(id); break;
            case 'descargar-constancia-acreedores': descargarConstanciaAcreedores(); break;

            case 'filtro-carpetas':   cambiarFiltroCarpetas(boton.dataset.filtro); break;
            case 'ver-usuarios':      mostrarVistaUsuarios(); break;
            case 'ver-almacenamiento':   mostrarVistaAlmacenamiento(); break;
            case 'ver-rendimiento':      if (typeof mostrarVistaRendimiento === 'function') mostrarVistaRendimiento(); break;
            case 'refrescar-almacenamiento': refrescarAlmacenamiento(); break;
            case 'ver-notificaciones':   mostrarVistaNotificaciones(); break;
            case 'refrescar-notificaciones': mostrarVistaNotificaciones(); break;
            case 'notif-rol':         cambiarRolNotif(boton.dataset.rol); break;
            case 'nueva-carpeta':     abrirModalCarpeta(null); break;
            case 'cerrar-modal':      cerrarModalCarpeta(); break;
            case 'abrir-carpeta':     abrirCarpeta(id); break;
            case 'editar-carpeta':    dbObtener('carpetas', id).then(c => c && abrirModalCarpeta(c)); break;
            case 'alternar-carpeta':  alternarCarpeta(id); break;
            case 'eliminar-carpeta':  eliminarCarpeta(id); break;
            case 'ver-archivo':       verArchivo(id); break;
            case 'descargar-archivo': conGiro(boton, descargarArchivo(id)); break;
            case 'alternar-descarga-partes': alternarDescargaPartes(id); break;
            case 'eliminar-archivo':  eliminarArchivo(id); break;
            case 'renombrar-archivo': renombrarArchivoAccion(id); break;
            case 'alternar-usuario':  alternarUsuario(boton.dataset.usuario); break;
            case 'eliminar-usuario':  eliminarUsuario(boton.dataset.usuario); break;
            case 'editar-usuario':    dbObtener('usuarios', boton.dataset.usuario).then(u => u && abrirModalUsuario(u)); break;
            case 'cerrar-modal-usuario': cerrarModalUsuario(); break;
            case 'editar-descripcion':   mostrarEditorDescripcion(); break;
            case 'cancelar-descripcion': ocultarEditorDescripcion(); break;
            case 'sub-carpeta':          cambiarSubPestanaCarpeta(boton.dataset.panel); break;
            case 'descargar-zip':        conGiro(boton, descargarCarpetaZip()); break;
            case 'chat-canal':           cambiarCanal(boton.dataset.canal); break;
            case 'descargar-adjunto':    descargarAdjuntoDeChat(id); break;
            case 'quitar-adjunto-chat':  quitarAdjuntoChat(); break;

            // Audiencias
            case 'cal-mes':              cambiarMesCalendario(boton.dataset.delta); break;
            case 'dia-calendario':       abrirModalAudiencia({ fecha: boton.dataset.fecha }); break;
            case 'notificar-audiencia':  abrirModalAudiencia(null); break;
            case 'notificar-audiencia-existente': {
                const a = _audienciasCache.find(x => x.id === id);
                if (a) abrirModalAudiencia(a);
                break;
            }
            case 'eliminar-audiencia':   eliminarAudiencia(id); break;
            case 'cerrar-modal-audiencia': cerrarModalAudiencia(); break;

            // Recordatorios personales
            case 'nuevo-recordatorio':   abrirModalRecordatorio(null); break;
            case 'editar-recordatorio': {
                const r = _recordatoriosPanelCache.find(x => x.id === id);
                if (r) abrirModalRecordatorio(r);
                break;
            }
            case 'eliminar-recordatorio': eliminarRecordatorio(id); break;
            case 'cerrar-modal-recordatorio': cerrarModalRecordatorio(); break;
            case 'cerrar-popup-recordatorios': cerrarRecordatorioVisible(); break;

            // Notificaciones de la carpeta
            case 'refrescar-notif-carpeta': pintarNotifCarpeta(carpetaAbierta); break;
            case 'notif-carpeta-rol':       cambiarRolNotifCarpeta(boton.dataset.rol); break;

            // Editar documentos
            case 'editar-documentos':    empezarEdicionOrden(); break;
            case 'vaciar-carpeta':       vaciarCarpeta(); break;
            case 'guardar-orden':        guardarOrdenDocumentos(); break;
            case 'cancelar-orden':       cancelarEdicionOrden(); break;
            case 'cancelar-subida':      cancelarSubida(); break;
            case 'cerrar-consejo':       cerrarConsejo(); break;
            case 'orden-subir':          moverArchivoEnOrden(id, -1); break;
            case 'orden-bajar':          moverArchivoEnOrden(id, 1); break;
            case 'plegar-anexos':        plegarAnexos(id); break;

            // Expediente (PDF)
            case 'generar-expediente':   abrirModalExpediente(); break;
            case 'cerrar-modal-expediente': cerrarModalExpediente(); break;
            case 'crear-expediente':     conGiro(boton, crearExpediente()); break;
            case 'expediente-subir':     moverSeleccionExpediente(id, -1); break;
            case 'expediente-bajar':     moverSeleccionExpediente(id, 1); break;
        }
    });

    // El orden de marcado define el orden del PDF
    document.addEventListener('change', (e) => {
        if (e.target.dataset && e.target.dataset.accionCambio === 'chequeo-expediente') {
            alternarSeleccionExpediente(Number(e.target.value), e.target.checked);
        }
        // Mover a otra subcarpeta
        if (e.target.dataset && e.target.dataset.accionCambio === 'mover-archivo') {
            moverArchivoAccion(Number(e.target.dataset.id), e.target.value);
        }
        // "Anexo de…" en Editar documentos
        if (e.target.dataset && e.target.dataset.accionCambio === 'fijar-anexo') {
            cambiarAnexoEnEdicion(Number(e.target.dataset.id), e.target.value);
        }
    });

    document.getElementById('form-carpeta').addEventListener('submit', guardarCarpeta);
    document.getElementById('form-usuario').addEventListener('submit', crearUsuario);
    const formNotaria = document.getElementById('form-notaria');
    if (formNotaria) formNotaria.addEventListener('submit', guardarNotaria);
    // Una notaría o varias según el rol
    const selRol = document.getElementById('nuevo-rol');
    if (selRol) {
        selRol.addEventListener('change', () => {
            pintarNotariasDeFormulario(notariasMarcadasEnFormulario());
            ajustarCampoCorreo('nuevo-correo', 'etiqueta-nuevo-correo', selRol.value);
        });
        ajustarCampoCorreo('nuevo-correo', 'etiqueta-nuevo-correo', selRol.value);
    }
    // Modal de texto
    const formTexto = document.getElementById('form-texto');
    if (formTexto) {
        formTexto.addEventListener('submit', (e) => {
            e.preventDefault();
            _responderTexto(document.getElementById('texto-valor').value.trim());
        });
    }
    document.getElementById('form-editar-usuario').addEventListener('submit', guardarEdicionUsuario);
    document.getElementById('form-descripcion').addEventListener('submit', guardarDescripcion);
    document.getElementById('form-mensaje').addEventListener('submit', enviarMensaje);
    document.getElementById('form-audiencia').addEventListener('submit', enviarNotificacionAudiencia);
    document.getElementById('form-recordatorio').addEventListener('submit', guardarRecordatorio);
    document.getElementById('form-proceso').addEventListener('submit', crearProcesoDesdeModal);
    document.getElementById('form-editar-proceso').addEventListener('submit', guardarEdicionProceso);
    document.getElementById('form-soporte').addEventListener('submit', enviarSoporte);

    // Adjuntos del soporte: clip y arrastrar
    const soporteAdjunto = document.getElementById('soporte-adjunto');
    if (soporteAdjunto) {
        soporteAdjunto.addEventListener('change', () => {
            if (soporteAdjunto.files && soporteAdjunto.files[0]) ponerAdjuntoSoporte(soporteAdjunto.files[0]);
        });
    }
    const soportePanel = document.getElementById('soporte-panel');
    if (soportePanel) {
        soportePanel.addEventListener('dragover', (e) => { e.preventDefault(); soportePanel.classList.add('pt-arrastrando'); });
        soportePanel.addEventListener('dragleave', (e) => {
            if (!soportePanel.contains(e.relatedTarget)) soportePanel.classList.remove('pt-arrastrando');
        });
        soportePanel.addEventListener('drop', (e) => {
            e.preventDefault();
            soportePanel.classList.remove('pt-arrastrando');
            if (document.getElementById('form-soporte').hidden) return; // sin hilo abierto no se adjunta
            if (e.dataTransfer && e.dataTransfer.files.length > 0) ponerAdjuntoSoporte(e.dataTransfer.files[0]);
        });
    }

    // Buscadores: filtran al escribir
    const buscadorCarpetas = document.getElementById('buscador-carpetas');
    if (buscadorCarpetas) buscadorCarpetas.addEventListener('input', () => {
        _busquedaCarpetas = buscadorCarpetas.value;
        pintarCarpetasSegunFiltro();
    });
    const buscadorEstados = document.getElementById('buscador-estados');
    if (buscadorEstados) buscadorEstados.addEventListener('input', () => {
        _busquedaEstados = buscadorEstados.value;
        pintarEstados();
    });
    const buscadorUsuarios = document.getElementById('buscador-usuarios');
    if (buscadorUsuarios) buscadorUsuarios.addEventListener('input', () => {
        _busquedaUsuarios = buscadorUsuarios.value;
        pintarListaUsuarios();
    });

    // Vista previa del vencimiento del proceso nuevo
    document.getElementById('proceso-dias').addEventListener('input', () => {
        const dias = Math.floor(Number(document.getElementById('proceso-dias').value));
        document.getElementById('proceso-venc-previo').textContent =
            (dias && dias > 0)
                ? 'Si se crea hoy, vence el ' + formatoVencimiento(calcularVencimientoHabil(new Date(), dias)) + '.'
                : '';
    });

    // Adjuntar en el chat
    const adjuntoChat = document.getElementById('chat-adjunto');
    if (adjuntoChat) {
        adjuntoChat.addEventListener('change', () => {
            if (adjuntoChat.files && adjuntoChat.files[0]) ponerAdjuntoChat(adjuntoChat.files[0]);
        });
    }

    // Subida con selector
    const entrada = document.getElementById('entrada-archivos');
    entrada.addEventListener('change', async () => {
        await subirArchivos([...entrada.files]);
        entrada.value = '';
    });

    // Subida arrastrando
    const zona = document.getElementById('zona-subida');
    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('arrastrando'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('arrastrando'));
    zona.addEventListener('drop', async (e) => {
        e.preventDefault();
        zona.classList.remove('arrastrando');
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
            await subirArchivos([...e.dataTransfer.files]);
        }
    });

    // Clic fuera cierra los modales
    document.getElementById('modal-carpeta').addEventListener('click', (e) => {
        if (e.target.id === 'modal-carpeta') cerrarModalCarpeta();
    });
    document.getElementById('modal-usuario').addEventListener('click', (e) => {
        if (e.target.id === 'modal-usuario') cerrarModalUsuario();
    });
    document.getElementById('modal-audiencia').addEventListener('click', (e) => {
        if (e.target.id === 'modal-audiencia') cerrarModalAudiencia();
    });
    document.getElementById('modal-recordatorio').addEventListener('click', (e) => {
        if (e.target.id === 'modal-recordatorio') cerrarModalRecordatorio();
    });
    document.getElementById('modal-avisos').addEventListener('click', (e) => {
        if (e.target.id === 'modal-avisos') e.target.hidden = true;
    });
    document.getElementById('modal-expediente').addEventListener('click', (e) => {
        if (e.target.id === 'modal-expediente') cerrarModalExpediente();
    });
    document.getElementById('modal-proceso').addEventListener('click', (e) => {
        if (e.target.id === 'modal-proceso') cerrarModalProceso();
    });
    document.getElementById('modal-editar-proceso').addEventListener('click', (e) => {
        if (e.target.id === 'modal-editar-proceso') cerrarModalEditarProceso();
    });
    document.getElementById('modal-detalle-tramite').addEventListener('click', (e) => {
        if (e.target.id === 'modal-detalle-tramite') cerrarDetalleTramite();
    });
}

/* ============ UTILIDADES ============ */
function escaparHtml(texto) {
    return String(texto).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/* Extensión en minúsculas, sin punto. */
function extensionDe(nombre) {
    const partes = String(nombre).toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
}

/* Icono según el tipo. */
function iconoArchivo(ext) {
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx') return icono('documento');
    if (ext === 'xls' || ext === 'xlsx') return icono('hoja');
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') return icono('imagen');
    if (ext === 'mp3') return icono('audio');
    if (ext === 'mp4') return icono('video');
    return icono('adjunto');
}

/* Bytes en KB o MB. */
function formatoTamano(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

/* Fecha corta para la tabla: "14/09/26 10:51" (la larga partía la fila en cuatro). */
function formatoFechaTabla(marca) {
    if (!marca) return '—';
    const f = new Date(marca);
    const dos = (n) => String(n).padStart(2, '0');
    return dos(f.getDate()) + '/' + dos(f.getMonth() + 1) + '/' + String(f.getFullYear()).slice(2) +
           ' ' + dos(f.getHours()) + ':' + dos(f.getMinutes());
}

/* Fecha y hora en formato colombiano. */
function formatoFecha(marca) {
    if (!marca) return '—';
    return new Date(marca).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

let toastTemporizador = null;
/* Aviso flotante (error en rojo y más tiempo). */
function avisar(mensaje, tipo) {
    const toast = document.getElementById('toast');
    if (!toast) { console.warn('Aviso (sin toast):', mensaje); return; }
    toast.textContent = mensaje;
    toast.className = 'pt-toast visible' + (tipo === 'error' ? ' pt-toast--error' : '');
    clearTimeout(toastTemporizador);
    toastTemporizador = setTimeout(() => toast.classList.remove('visible'), 4000);
}

