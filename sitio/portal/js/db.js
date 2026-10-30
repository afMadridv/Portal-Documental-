/*! Portal Documental · modo práctica (IndexedDB en el navegador)
  En la nube, nube.js reemplaza estas funciones con las de Supabase.
  Andrés Madrid · andresmadrid.vercel.app */
const DB_NOMBRE = 'portal_documental';
const DB_VERSION = 12; // v12: notarías (varias oficinas en un solo portal)

let _db = null;

/* Abre la base local. Subir DB_VERSION reinicia los datos de práctica. */
function abrirDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolver, rechazar) => {
        const peticion = indexedDB.open(DB_NOMBRE, DB_VERSION);

        peticion.onupgradeneeded = (e) => {
            const db = e.target.result;
            // Versión nueva: datos de práctica desde cero
            for (const nombre of ['usuarios', 'carpetas', 'archivos', 'actividad', 'chat', 'hoja', 'mensajes', 'audiencias', 'recordatorios', 'procesos', 'subcarpetas', 'notarias']) {
                if (db.objectStoreNames.contains(nombre)) db.deleteObjectStore(nombre);
            }
            db.createObjectStore('usuarios', { keyPath: 'usuario' });
            db.createObjectStore('carpetas', { keyPath: 'id', autoIncrement: true });
            const archivos = db.createObjectStore('archivos', { keyPath: 'id', autoIncrement: true });
            archivos.createIndex('porCarpeta', 'carpetaId', { unique: false });
            db.createObjectStore('actividad', { keyPath: 'id', autoIncrement: true });
            // Mensajería del trámite: dos canales por carpeta (cliente / acreedor)
            const mensajes = db.createObjectStore('mensajes', { keyPath: 'id', autoIncrement: true });
            mensajes.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Info del deudor: una fila por carpeta (clave = carpetaId)
            // Audiencias del calendario de cada carpeta
            const audiencias = db.createObjectStore('audiencias', { keyPath: 'id', autoIncrement: true });
            audiencias.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Recordatorios personales (solo los ve quien los crea)
            const recordatorios = db.createObjectStore('recordatorios', { keyPath: 'id', autoIncrement: true });
            recordatorios.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Procesos del trámite (semáforo por días hábiles)
            const procesos = db.createObjectStore('procesos', { keyPath: 'id', autoIncrement: true });
            procesos.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Subcarpetas: agrupan los documentos dentro de una carpeta
            const subcarpetas = db.createObjectStore('subcarpetas', { keyPath: 'id', autoIncrement: true });
            subcarpetas.createIndex('porCarpeta', 'carpetaId', { unique: false });
            // Notarías: cada carpeta en una, cada usuario en una o varias
            db.createObjectStore('notarias', { keyPath: 'id', autoIncrement: true });
        };

        peticion.onsuccess = () => { _db = peticion.result; resolver(_db); };
        peticion.onerror = () => rechazar(peticion.error);
    });
}

/* IndexedDB con promesas */
function _transaccion(almacen, modo, operacion) {
    return abrirDB().then(db => new Promise((resolver, rechazar) => {
        const tx = db.transaction(almacen, modo);
        const peticion = operacion(tx.objectStore(almacen));
        peticion.onsuccess = () => resolver(peticion.result);
        peticion.onerror = () => rechazar(peticion.error);
    }));
}

/* Inserta un registro nuevo y devuelve su id. */
function dbAgregar(almacen, valor)  { return _transaccion(almacen, 'readwrite', s => s.add(valor)); }
/* Inserta o reemplaza un registro por su clave. */
function dbGuardar(almacen, valor)  { return _transaccion(almacen, 'readwrite', s => s.put(valor)); }
/* Trae un registro por su clave. */
function dbObtener(almacen, clave)  { return _transaccion(almacen, 'readonly',  s => s.get(clave)); }
/* Trae todos los registros de un almacén. */
function dbTodos(almacen)           { return _transaccion(almacen, 'readonly',  s => s.getAll()); }
/* Borra un registro por su clave. */
function dbEliminar(almacen, clave) { return _transaccion(almacen, 'readwrite', s => s.delete(clave)); }

/* Documentos de una carpeta, usando el índice por carpetaId. */
function dbArchivosDeCarpeta(carpetaId) {
    return abrirDB().then(db => new Promise((resolver, rechazar) => {
        const tx = db.transaction('archivos', 'readonly');
        const peticion = tx.objectStore('archivos').index('porCarpeta').getAll(carpetaId);
        peticion.onsuccess = () => resolver(peticion.result);
        peticion.onerror = () => rechazar(peticion.error);
    }));
}

/* Marca si las partes pueden descargar un archivo (modo local) */
async function fijarDescargaPartes(archivoId, permitir) {
    const a = await dbObtener('archivos', archivoId);
    if (!a) return;
    await dbGuardar('archivos', { ...a, descargablePartes: !!permitir });
}

/* Borra los documentos de una carpeta y devuelve cuántos había. */
async function dbEliminarArchivosDeCarpeta(carpetaId, alProgresar) {
    const archivos = await dbArchivosDeCarpeta(carpetaId);
    let n = 0;
    for (const a of archivos) {
        await dbEliminar('archivos', a.id);
        n++;
        if (alProgresar) alProgresar(n, archivos.length);
    }
    return archivos.length;
}

/* Bitácora local. En la nube va por una función del servidor.
   Nunca rompe la acción principal. */
async function registrarActividad(accion, objetivo, carpetaId) {
    try {
        const s = sesionActual();
        if (!s) return;
        await dbAgregar('actividad', {
            usuario: s.usuario, nombre: s.nombre, rol: s.rol,
            accion, objetivo: objetivo || '',
            carpetaId: carpetaId || null,
            fecha: Date.now()
        });
    } catch (e) { /* silencioso */ }
}

/* Lista la bitácora más reciente primero (solo la usa el administrador) */
async function listarActividad() {
    try {
        const todo = await dbTodos('actividad');
        todo.sort((a, b) => b.fecha - a.fecha);
        return todo.slice(0, 300);
    } catch (e) { return []; }
}

/* Actividad de una carpeta. En la nube, RLS limita al operador a las suyas. */
async function listarActividadDeCarpeta(carpetaId) {
    try {
        const todo = await dbTodos('actividad');
        return todo
            .filter(e => e.carpetaId === carpetaId)
            .sort((a, b) => b.fecha - a.fecha)
            .slice(0, 200);
    } catch (e) { return []; }
}

/* ============ AUDIENCIAS (calendario de la carpeta, modo local) ============ */
async function audienciasListar(carpetaId) {
    const todas = await dbTodos('audiencias');
    return todas
        .filter(a => a.carpetaId === carpetaId)
        .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}
/* Guarda o actualiza una audiencia del calendario de la carpeta. */
async function audienciaGuardar(carpetaId, datos) {
    const s = sesionActual() || {};
    await dbAgregar('audiencias', {
        carpetaId,
        titulo: datos.titulo || '',
        fecha: datos.fecha,            // 'AAAA-MM-DD'
        hora: datos.hora || '',        // 'HH:MM'
        enlace: datos.enlace || '',
        creadoPor: s.usuario || '',
        creado: Date.now()
    });
}
/* Borra una audiencia marcada. */
async function audienciaEliminar(id) {
    await dbEliminar('audiencias', id);
}

/* ============ RECORDATORIOS PERSONALES (modo local) ============
   Cada quien ve solo los suyos (en la nube, por RLS). */
async function recordatoriosListar(carpetaId) {
    const s = sesionActual() || {};
    const todos = await dbTodos('recordatorios');
    return todos
        .filter(r => r.carpetaId === carpetaId && r.usuario === s.usuario)
        .sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
}
/* Guarda un recordatorio privado del operador. */
async function recordatorioGuardar(datos) {
    const s = sesionActual() || {};
    if (datos.id) {
        const reg = await dbObtener('recordatorios', datos.id);
        if (!reg || reg.usuario !== s.usuario) throw new Error('Recordatorio no encontrado.');
        await dbGuardar('recordatorios', { ...reg, mensaje: datos.mensaje, fechaInicio: datos.fechaInicio, fechaFin: datos.fechaFin });
        return;
    }
    await dbAgregar('recordatorios', {
        usuario: s.usuario || '',
        carpetaId: datos.carpetaId,
        mensaje: datos.mensaje || '',
        fechaInicio: datos.fechaInicio,  // 'AAAA-MM-DD'
        fechaFin: datos.fechaFin,
        creado: Date.now()
    });
}
/* Borra un recordatorio. */
async function recordatorioEliminar(id) {
    const s = sesionActual() || {};
    const reg = await dbObtener('recordatorios', id);
    if (!reg || reg.usuario !== s.usuario) return;
    await dbEliminar('recordatorios', id);
}
/* TODOS mis recordatorios (calendario general del operador, modo local) */
async function recordatoriosMios() {
    const s = sesionActual() || {};
    const [todos, carpetas] = await Promise.all([dbTodos('recordatorios'), dbTodos('carpetas')]);
    const nombrePorCarpeta = {};
    for (const c of carpetas) nombrePorCarpeta[c.id] = c.nombre;
    return todos
        .filter(r => r.usuario === s.usuario)
        .map(r => ({ ...r, carpetaNombre: nombrePorCarpeta[r.carpetaId] || '' }));
}

/* Mis recordatorios vigentes hoy, con el nombre de la carpeta. */
async function recordatoriosVigentes() {
    const s = sesionActual() || {};
    const hoy = fechaISOLocal(new Date());
    const [todos, carpetas] = await Promise.all([dbTodos('recordatorios'), dbTodos('carpetas')]);
    const nombrePorCarpeta = {};
    for (const c of carpetas) nombrePorCarpeta[c.id] = c.nombre;
    return todos
        .filter(r => r.usuario === s.usuario && r.fechaInicio <= hoy && hoy <= r.fechaFin)
        .map(r => ({ ...r, carpetaNombre: nombrePorCarpeta[r.carpetaId] || '' }));
}

/* 'AAAA-MM-DD' local (toISOString correría el día) */
function fechaISOLocal(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

/* ============ ORDEN MANUAL DE DOCUMENTOS (modo local) ============ */
async function actualizarOrdenArchivos(carpetaId, ids) {
    let n = 1;
    for (const id of ids) {
        const a = await dbObtener('archivos', id);
        if (a && a.carpetaId === carpetaId) {
            a.orden = n++;
            await dbGuardar('archivos', a);
        }
    }
}

/* ============ ASIGNADOS DE LA CARPETA (modo local) ============
   Deudor y acreedores con su correo, para avisar audiencias. */
async function asignadosDeCarpeta(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) return [];
    const usuarios = await dbTodos('usuarios');
    return usuarios
        .filter(u => (carpeta.asignados || []).includes(u.usuario) && u.activo !== false)
        .map(u => ({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, correo: u.correo || '' }));
}

/* ============ MENSAJERÍA DEL TRÁMITE (modo local) ============
   Canales 'cliente' y 'acreedor'. En la nube: tabla mensajes con RLS. */
async function mensajesListar(carpetaId, canal) {
    const todos = await dbTodos('mensajes');
    return todos
        .filter(m => m.carpetaId === carpetaId && m.canal === canal)
        .sort((a, b) => a.fecha - b.fecha);
}
/* Guarda un mensaje del chat del trámite. */
async function mensajesGuardar(carpetaId, canal, texto, archivo) {
    const s = sesionActual() || {};
    await dbAgregar('mensajes', {
        carpetaId, canal,
        autorUsuario: s.usuario || '',
        autorNombre: s.nombre || s.usuario || '',
        rol: s.rol || '',
        texto: texto || '',
        // adjunto opcional (en local va en el mismo registro)
        archivoNombre: archivo ? archivo.name : '',
        archivoTamano: archivo ? archivo.size : 0,
        archivoTipo: archivo ? (archivo.type || 'application/octet-stream') : '',
        archivoBlob: archivo || null,
        fecha: Date.now()
    });
}

/* Adjunto de un mensaje. En la nube sale de Storage. */
async function descargarAdjuntoChat(mensajeId) {
    const m = await dbObtener('mensajes', mensajeId);
    if (!m || !m.archivoBlob) throw new Error('El mensaje no tiene adjunto.');
    return { nombre: m.archivoNombre, blob: m.archivoBlob };
}

/* Archivos de una carpeta con su contenido, para el ZIP. */
async function descargarBlobsDeCarpeta(carpetaId, alProgresar) {
    // Personal: todo. Cliente y acreedor: solo lo permitido.
    let archivos = await dbArchivosDeCarpeta(carpetaId);
    const ses = sesionActual();
    if (ses && (ses.rol === 'cliente' || ses.rol === 'acreedor')) {
        archivos = archivos.filter(a => a.descargablePartes !== false);
    }
    if (alProgresar) alProgresar(archivos.length, archivos.length);
    return archivos.map(a => ({ id: a.id, nombre: a.nombre, blob: a.blob }));
}

/* Cambia solo la descripción (estado) de la carpeta. */
async function actualizarDescripcionCarpeta(carpetaId, descripcion) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) return;
    carpeta.descripcion = descripcion;
    await dbGuardar('carpetas', carpeta);
}



/* ============ SEMÁFOROS (modo local) ============
   Mismas reglas que el servidor. Plazos con diasHabiles.js. */
function _esAdminLocal() { const s = sesionActual(); return s && s.rol === 'administrador'; }

/* Copia local de calcular_semaforo (solo modo práctica). */
function _semaforoLocal(p) {
    if (p.pausado) return { semaforo: 'pausado', diasRestantes: null };
    if (p.completado) return { semaforo: 'verde', diasRestantes: null };
    if (!p.completado && p.semaforoManual) {
        return { semaforo: p.semaforoManual, diasRestantes: contarDiasHabiles(fechaISOLocal(new Date()), p.fechaVencimiento) };
    }
    if (!p.fechaVencimiento) return { semaforo: 'verde', diasRestantes: null };
    const hoy = fechaISOLocal(new Date());
    const restantes = contarDiasHabiles(hoy, p.fechaVencimiento);
    if (p.fechaVencimiento < hoy) return { semaforo: 'rojo', diasRestantes: restantes };
    if (restantes <= 1) return { semaforo: 'naranja', diasRestantes: restantes };
    return { semaforo: 'verde', diasRestantes: restantes };
}

/* Procesos de una carpeta, ya ordenados y con su semáforo calculado. */
async function procesosListar(carpetaId) {
    const todos = await dbTodos('procesos');
    return todos
        .filter(p => p.carpetaId === carpetaId)
        .sort((a, b) => (a.orden - b.orden) || (a.id - b.id))
        .map(p => ({ ...p, ..._semaforoLocal(p) }));
}

/* Procesos visibles, para el tablero y el calendario. */
async function procesosTodos() {
    const todos = await dbTodos('procesos');
    return todos
        .sort((a, b) => (a.carpetaId - b.carpetaId) || (a.orden - b.orden))
        .map(p => ({ ...p, ..._semaforoLocal(p) }));
}

/* Crea un proceso y calcula su vencimiento en días hábiles. */
async function procesoCrear(carpetaId, datos) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de crear procesos.');
    if (!datos.nombre || !String(datos.nombre).trim()) throw new Error('El proceso necesita un nombre.');
    const dias = Math.floor(Number(datos.dias));
    if (!dias || dias <= 0) throw new Error('El plazo en días hábiles debe ser mayor que cero.');
    const existentes = await procesosListar(carpetaId);
    const hoy = fechaISOLocal(new Date());
    return dbAgregar('procesos', {
        carpetaId,
        nombre: String(datos.nombre).trim().slice(0, 120),
        dias,
        orden: datos.orden || (existentes.length ? Math.max(...existentes.map(p => p.orden)) + 1 : 1),
        completado: false,
        fechaInicio: hoy,
        fechaInicioHabil: primerDiaHabil(hoy),
        fechaVencimiento: calcularVencimientoHabil(hoy, dias),
        fechaCompletado: null,
        pausado: false,
        diasRestantesAlPausar: null,
        semaforoManual: null,
        creado: Date.now()
    });
}

/* Marca el proceso como completado con la fecha de hoy. */
async function procesoCompletar(procesoId) {
    const p = await dbObtener('procesos', procesoId);
    if (!p) throw new Error('Proceso no encontrado.');
    if (p.completado) throw new Error('Este proceso ya estaba completado.');
    if (p.pausado) throw new Error('El trámite está pausado: reactívalo primero.');
    const hoy = fechaISOLocal(new Date());
    if (hoy > p.fechaVencimiento && !_esAdminLocal()) {
        throw new Error('El plazo ya venció: solo el administrador puede marcarlo como completado.');
    }
    await dbGuardar('procesos', { ...p, completado: true, fechaCompletado: hoy, semaforoManual: null });
}

/* Borra un proceso del trámite. */
async function procesoEliminar(procesoId) {
    await dbEliminar('procesos', procesoId);
}

/* Pausa: se guarda el momento para descontarlo después. */
async function tramitePausar(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite ya estaba pausado.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, pausado: true, fechaPausa: hoy, fechaReactivacion: null,
        // también congela el conteo del trámite (60/90 días)
        diasRestantesTramiteAlPausar: carpeta.fechaVencimientoTramite
            ? Math.max(contarDiasHabiles(hoy, carpeta.fechaVencimientoTramite), 0)
            : null
    });
    for (const p of await procesosListar(carpetaId)) {
        if (p.completado) continue;
        await dbGuardar('procesos', {
            ...p, pausado: true, fechaPausa: hoy,
            diasRestantesAlPausar: Math.max(contarDiasHabiles(hoy, p.fechaVencimiento), 0)
        });
    }
}

/* Reactiva y corre los vencimientos lo que duró la pausa. */
async function tramiteReactivar(carpetaId) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (!carpeta.pausado) throw new Error('El trámite no está pausado.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, pausado: false, fechaReactivacion: hoy,
        fechaVencimientoTramite: (carpeta.diasRestantesTramiteAlPausar === null || carpeta.diasRestantesTramiteAlPausar === undefined)
            ? (carpeta.fechaVencimientoTramite || null)
            : sumarDiasHabiles(hoy, carpeta.diasRestantesTramiteAlPausar),
        diasRestantesTramiteAlPausar: null
    });
    for (const p of await procesosListar(carpetaId)) {
        if (p.completado || !p.pausado) continue;
        await dbGuardar('procesos', {
            ...p, pausado: false, fechaPausa: null, fechaReactivacion: hoy,
            fechaVencimiento: sumarDiasHabiles(hoy, p.diasRestantesAlPausar || 0)
        });
    }
}

/* Conteo del trámite: 60 días hábiles, 90 con prórroga */
async function tramiteIniciar(carpetaId, fecha) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de iniciar el conteo.');
    if (carpeta.fechaInicioTramite) throw new Error('El conteo del trámite ya fue iniciado el ' + carpeta.fechaInicioTramite + '.');
    const inicio = fecha || fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta,
        fechaInicioTramite: inicio,
        diasHabilesTramite: 60,
        tieneProrroga: false,
        fechaVencimientoTramite: calcularVencimientoHabil(inicio, 60),
        diasRestantesTramiteAlPausar: null
    });
}

/* Prórroga: una por trámite. */
async function tramiteProrroga(carpetaId) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede aplicar la prórroga.');
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (!carpeta.fechaInicioTramite) throw new Error('El trámite aún no tiene conteo iniciado.');
    if (carpeta.tieneProrroga) throw new Error('El trámite ya tiene la prórroga aplicada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de aplicar la prórroga.');
    await dbGuardar('carpetas', {
        ...carpeta,
        diasHabilesTramite: 90,
        tieneProrroga: true,
        fechaVencimientoTramite: calcularVencimientoHabil(carpeta.fechaInicioTramite, 90)
    });
}

/* Corrección de un proceso por el admin (nombre, plazo o estado). */
async function procesoEditarAdmin(procesoId, cambios) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede corregir procesos.');
    const p = await dbObtener('procesos', procesoId);
    if (!p) throw new Error('Proceso no encontrado.');
    const nuevo = { ...p };
    if (cambios.nombre) nuevo.nombre = String(cambios.nombre).trim().slice(0, 120);
    if (cambios.dias) nuevo.dias = Math.max(1, Math.floor(Number(cambios.dias)));
    if (cambios.vencimiento) nuevo.fechaVencimiento = cambios.vencimiento;
    if (typeof cambios.completado === 'boolean') {
        nuevo.completado = cambios.completado;
        nuevo.fechaCompletado = cambios.completado ? (p.fechaCompletado || fechaISOLocal(new Date())) : null;
    }
    if (cambios.semaforo !== undefined && cambios.semaforo !== null) {
        nuevo.semaforoManual = cambios.semaforo === '' ? null : cambios.semaforo;
    }
    await dbGuardar('procesos', nuevo);
}

/* ============ SOPORTE Y LLAMADAS (solo en la nube) ============
   En práctica existen para que la interfaz no se rompa. */
async function soporteOperadores() { return []; }
/* Mensajes de un hilo de soporte. */
async function soporteMensajes() { return []; }
/* Envía un mensaje al hilo de soporte. */
async function soporteEnviar() { throw new Error('El chat de soporte solo está disponible en modo nube.'); }
/* Recupera el adjunto de un mensaje de soporte. */
async function descargarAdjuntoSoporte() { throw new Error('Solo disponible en modo nube.'); }
/* Solicitud de cambio de contraseña para el admin. */
async function solicitarRestablecimiento() {}
/* Solicitudes de contraseña pendientes. */
async function solicitudesClaveListar() { return []; }
/* Marca una solicitud de contraseña como atendida. */
async function solicitudClaveResolver() {}
/* Marca como leídos los mensajes de un hilo de soporte. */
async function marcarLeidosSoporte() {}
/* Marca como leídos los mensajes de un canal del chat. */
async function marcarLeidosCanal() {}
/* Cuántos mensajes sin leer hay por canal. */
async function chatsNoLeidos() { return []; }
/* Cuántos mensajes de soporte hay sin leer. */
async function soporteNoLeidos() { return []; }
/* En práctica no hay tiempo real: devuelve una baja vacía. */
function suscribirMensajesNuevos() { return null; }
/* Sin efecto en práctica (un solo navegador). */
function suscribirLlamadasEntrantes() { return null; }
/* Registra una llamada de soporte. Sin efecto en modo práctica. */
async function llamadaCrear() { throw new Error('Las llamadas solo están disponibles en modo nube.'); }
/* Cambia el estado de una llamada. Sin efecto en modo práctica. */
async function llamadaActualizar() {}
/* Canal de señalización de la llamada. Sin efecto en práctica. */
function canalSenalizacion() { return { enviar: () => {}, cerrar: () => {} }; }

/* Campana: en local no hay triggers */
/* Sin servidor que medir: no hay barra de almacenamiento. */
async function almacenamientoLeer() { return null; }

/* En práctica las credenciales no se guardan aparte. */
async function credencialGuardar(usuario, clave) {}

/* En práctica nadie puede quitar el acceso: siempre 'viva'. */
async function sesionSigueViva() { return 'viva'; }

/* Sin campana en práctica. Recibe la notaría por compatibilidad. */
async function notificacionesListar(notaria) { return []; }
/* Marca notificaciones como leídas. */
async function notificacionesMarcarLeidas() {}
/* Borra una notificación. */
async function notificacionEliminar() {}
/* Vacía la campana (en práctica no hay nada). */
async function notificacionesLimpiar(notaria) {}
/* ============ SUBCARPETAS (modo práctica) ============ */
async function subcarpetasListar(carpetaId) {
    const todas = await dbTodos('subcarpetas');
    return todas
        .filter(s => String(s.carpetaId) === String(carpetaId))
        .sort((a, b) => (a.orden - b.orden) || a.nombre.localeCompare(b.nombre));
}

/* Crea una subcarpeta dentro de una carpeta. */
async function subcarpetaCrear(carpetaId, nombre) {
    const limpio = String(nombre || '').trim().slice(0, 60);
    if (!limpio) throw new Error('La subcarpeta necesita un nombre.');
    const existentes = await subcarpetasListar(carpetaId);
    if (existentes.some(s => s.nombre.toLowerCase() === limpio.toLowerCase())) {
        throw new Error('Ya existe una subcarpeta con ese nombre en esta carpeta.');
    }
    return dbAgregar('subcarpetas', {
        carpetaId: carpetaId, nombre: limpio,
        orden: existentes.length + 1, creado: Date.now()
    });
}

/* Cambia el nombre de una subcarpeta. */
async function subcarpetaRenombrar(subcarpetaId, nombre) {
    const limpio = String(nombre || '').trim().slice(0, 60);
    if (!limpio) throw new Error('La subcarpeta necesita un nombre.');
    const sub = await dbObtener('subcarpetas', Number(subcarpetaId));
    if (!sub) throw new Error('Subcarpeta no encontrada.');
    const hermanas = await subcarpetasListar(sub.carpetaId);
    if (hermanas.some(s => s.id !== sub.id && s.nombre.toLowerCase() === limpio.toLowerCase())) {
        throw new Error('Ya existe una subcarpeta con ese nombre en esta carpeta.');
    }
    sub.nombre = limpio;
    return dbGuardar('subcarpetas', sub);
}

/* Al borrarla, los documentos vuelven a la raíz */
async function subcarpetaEliminar(subcarpetaId) {
    const id = Number(subcarpetaId);
    const archivos = await dbTodos('archivos');
    for (const a of archivos) {
        if (String(a.subcarpetaId) === String(id)) {
            a.subcarpetaId = null;
            await dbGuardar('archivos', a);
        }
    }
    return dbEliminar('subcarpetas', id);
}

/* Mueve un documento a otra subcarpeta (null = raíz). */
/* Como archivo_mover(): un anexo que se muda solo deja de ser anexo y
   los anexos se van con su principal. */
async function archivoMover(archivoId, subcarpetaId) {
    const a = await dbObtener('archivos', Number(archivoId));
    if (!a) throw new Error('Archivo no encontrado.');
    const destino = subcarpetaId ? Number(subcarpetaId) : null;
    a.subcarpetaId = destino;
    a.anexoDe = null;
    await dbGuardar('archivos', a);
    for (const hijo of await dbArchivosDeCarpeta(a.carpetaId)) {
        if (hijo.anexoDe === a.id) await dbGuardar('archivos', { ...hijo, subcarpetaId: destino });
    }
}

/* Como archivo_renombrar(): sin barras ni control, hasta 200, la extensión no cambia. */
async function archivoRenombrar(archivoId, nombre) {
    const a = await dbObtener('archivos', Number(archivoId));
    if (!a) throw new Error('Archivo no encontrado.');
    let nuevo = String(nombre || '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    const ext = extensionDe(a.nombre);
    if (ext && extensionDe(nuevo) !== ext) nuevo = nuevo.replace(/^[ .]+|[ .]+$/g, '') + '.' + ext;
    if (!nuevo || nuevo === '.' + ext) throw new Error('El documento necesita un nombre.');
    if (nuevo.length > 200) throw new Error('El nombre es muy largo (máximo 200 caracteres).');
    a.nombre = nuevo;
    await dbGuardar('archivos', a);
    return nuevo;
}

/* Marca un documento como anexo de otro (null = principal). Mismas reglas que la base. */
async function archivoFijarAnexo(archivoId, padreId) {
    const a = await dbObtener('archivos', Number(archivoId));
    if (!a) throw new Error('Archivo no encontrado.');
    if (padreId) {
        const p = await dbObtener('archivos', Number(padreId));
        const hermanos = await dbArchivosDeCarpeta(a.carpetaId);
        if (!p || p.id === a.id) throw new Error('El documento principal ya no existe.');
        if (p.carpetaId !== a.carpetaId || (p.subcarpetaId || null) !== (a.subcarpetaId || null)) {
            throw new Error('Un anexo tiene que estar en la misma carpeta y subcarpeta que su documento principal.');
        }
        if (p.anexoDe) throw new Error('Ese documento ya es un anexo: los anexos no pueden tener anexos.');
        if (hermanos.some(h => h.anexoDe === a.id)) throw new Error('Este documento tiene anexos: primero hay que soltarlos.');
    }
    a.anexoDe = padreId ? Number(padreId) : null;
    await dbGuardar('archivos', a);
}

/* Avisos de procesos vencidos. En la nube también hay tarea diaria. */
async function notificacionesGenerarVencidos() {}
/* Deja constancia del inicio de sesión. */
async function notificarMiIngreso() {}
/* Escucha notificaciones nuevas. Sin efecto en modo práctica. */
function suscribirNotificaciones() { return null; }

/* Presencia (en local, sin tiempo real) */
async function registrarConexion() {
    try {
        const s = sesionActual();
        if (!s) return;
        const u = await dbObtener('usuarios', s.usuario);
        if (u) await dbGuardar('usuarios', { ...u, ultimaConexion: Date.now() });
    } catch (e) { /* silencioso */ }
}
/* Sin efecto en práctica. */
function presenciaIniciar() { return null; }

/* Cierre del trámite (local): solo admin */
async function tramiteFinalizar(carpetaId) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede dar fin al trámite.');
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.finalizado) throw new Error('El trámite ya estaba finalizado.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, finalizado: true, fechaFinTramite: hoy,
        // 30 días hábiles para que las partes descarguen
        fechaDesactivacion: sumarDiasHabiles(hoy, 30)
    });
}

/* Avisos de cierre (local). Desactiva las carpetas con el plazo cumplido. */
async function avisosFinTramite() {
    const carpetas = (await dbTodos('carpetas')).filter(c => c.finalizado && c.fechaDesactivacion);
    const hoy = fechaISOLocal(new Date());
    for (const c of carpetas) {
        if (c.activa && !c.desactivacionAutoAplicada && c.fechaDesactivacion <= hoy) {
            await dbGuardar('carpetas', { ...c, activa: false, desactivacionAutoAplicada: true });
            c.activa = false;
        }
    }
    return carpetas
        .filter(c => puedeVerCarpeta(c))
        .map(c => ({
            carpetaId: c.id, nombre: c.nombre, fechaFin: c.fechaFinTramite,
            fechaDesactivacion: c.fechaDesactivacion,
            diasRestantes: Math.max(contarDiasHabiles(hoy, c.fechaDesactivacion), 0),
            activa: !!c.activa
        }));
}

/* Consentimiento de datos (modo local) */
async function perfilPropio() {
    const s = sesionActual() || {};
    const u = s.usuario ? await dbObtener('usuarios', s.usuario) : null;
    return u ? { usuario: u.usuario, nombre: u.nombre, rol: u.rol, primerLogin: u.primerLogin !== false } : null;
}
/* Registra la aceptación del tratamiento de datos. */
async function consentimientoAceptar(version) {
    const s = sesionActual() || {};
    const u = s.usuario ? await dbObtener('usuarios', s.usuario) : null;
    if (!u) return;
    await dbGuardar('usuarios', { ...u, primerLogin: false, consentimiento: { fecha: Date.now(), version: version || '1.0' } });
}
/* Lista quién aceptó el tratamiento de datos y cuándo. */
async function consentimientosListar() {
    const usuarios = await dbTodos('usuarios');
    return usuarios.filter(u => u.consentimiento).map(u => ({
        usuario: u.usuario, nombre: u.nombre, rol: u.rol,
        fecha: u.consentimiento.fecha, version: u.consentimiento.version
    }));
}

/* Crea un usuario (local). En la nube, nube.js lo hace en Supabase. */
async function crearUsuarioDatos(usuario, nombre, rol, clave, correo, notarias) {
    // Operador: varias notarías. Los demás: una (su oficina). Admin: todas por rol.
    const lista = (notarias || []).map(Number).filter(Boolean);
    await dbAgregar('usuarios', {
        usuario, nombre, rol,
        activo: true,
        correo: correo || null,
        notariaId: lista.length ? lista[0] : null,
        notarias: rol === 'operador' ? lista : [],
        clave: await protegerClave(clave),
        creado: Date.now()
    });
    return '';
}

/* Restablece la contraseña (local). En la nube, Edge Function. */
async function restablecerClave(usuario, nuevaClave) {
    const reg = await dbObtener('usuarios', usuario.usuario);
    if (!reg) throw new Error('Usuario no encontrado.');
    reg.clave = await protegerClave(nuevaClave);
    await dbGuardar('usuarios', reg);
}

/* Usuarios y carpetas de ejemplo la primera vez */
/* ============ NOTARÍAS (modo práctica) ============
   Igual que en nube.js: con dos o más notarías se elige al entrar.
   Admin: todas por rol. Operador: varias. Resto: la suya. */

/* Notarías de un usuario */
async function _notariasDeUsuario(usuario) {
    const u = await dbObtener('usuarios', usuario);
    if (!u) return [];
    if (u.rol === 'administrador') {
        const todas = await dbTodos('notarias');
        return todas.map(n => n.id);
    }
    // Operador: varias; el resto, la de origen
    const propias = Array.isArray(u.notarias) ? u.notarias.slice() : [];
    if (u.notariaId && !propias.includes(u.notariaId)) propias.push(u.notariaId);
    return propias;
}

/* Notarías de la sesión actual, con carpetas activas de cada una */
async function misNotarias() {
    const ses = sesionActual();
    if (!ses) return [];
    const permitidas = await _notariasDeUsuario(ses.usuario);
    const todas = await dbTodos('notarias');
    const carpetas = await dbTodos('carpetas');
    const procesos = await dbTodos('procesos');
    return todas
        .filter(n => n.activa !== false && permitidas.includes(n.id))
        .map(n => ({
            id: n.id, nombre: n.nombre, ciudad: n.ciudad, activa: n.activa !== false,
            carpetas: carpetas.filter(c => c.notariaId === n.id && c.activa).length,
            // Procesos en rojo o naranja, para la pantalla de selección
            porVencer: procesos.filter(pr => {
                if (pr.completado || pr.pausado) return false;
                const c = carpetas.find(x => x.id === pr.carpetaId);
                if (!c || !c.activa || c.notariaId !== n.id) return false;
                return pr.semaforo === 'rojo' || pr.semaforo === 'naranja';
            }).length
        }))
        .sort((a, b) => (a.ciudad + a.nombre).localeCompare(b.ciudad + b.nombre));
}

/* Cifras por oficina, como tablero_notarias() en el servidor. */
async function tableroNotarias() {
    const ses = sesionActual();
    if (!ses) return [];
    const admin = ses.rol === 'administrador';
    const permitidas = await _notariasDeUsuario(ses.usuario);
    const [todas, carpetas, procesos, archivos] = await Promise.all([
        dbTodos('notarias'), dbTodos('carpetas'), procesosTodos(), dbTodos('archivos')
    ]);
    const bytesPorCarpeta = {}, docsPorCarpeta = {};
    for (const a of archivos) {
        bytesPorCarpeta[a.carpetaId] = (bytesPorCarpeta[a.carpetaId] || 0) + (a.tamano || 0);
        docsPorCarpeta[a.carpetaId] = (docsPorCarpeta[a.carpetaId] || 0) + 1;
    }
    const ids = todas.filter(n => admin || permitidas.includes(n.id)).map(n => n.id);
    if (admin && carpetas.some(c => c.notariaId == null)) ids.push(null);
    return ids.map(id => {
        const suyas = carpetas.filter(c => (c.notariaId == null ? null : c.notariaId) === id);
        const abiertas = suyas.filter(c => c.activa);
        const colores = procesos.filter(p => !p.completado && abiertas.some(c => c.id === p.carpetaId))
            .map(p => {
                const c = abiertas.find(x => x.id === p.carpetaId);
                return (p.pausado || (c && c.pausado)) ? 'pausado' : p.semaforo;
            });
        return {
            notariaId: id,
            carpetas: abiertas.length,
            porVencer: colores.filter(x => x === 'naranja').length,
            vencidos: colores.filter(x => x === 'rojo').length,
            carpetasTotal: admin ? suyas.length : null,
            documentos: admin ? suyas.reduce((t, c) => t + (docsPorCarpeta[c.id] || 0), 0) : null,
            pesoBytes: admin ? suyas.reduce((t, c) => t + (bytesPorCarpeta[c.id] || 0), 0) : null
        };
    });
}

/* Todas las notarías (formularios del admin) */
async function notariasListar() {
    const todas = await dbTodos('notarias');
    return todas
        .map(n => ({ id: n.id, nombre: n.nombre, ciudad: n.ciudad, activa: n.activa !== false }))
        .sort((a, b) => (a.ciudad + a.nombre).localeCompare(b.ciudad + b.nombre));
}

async function notariaCrear(nombre, ciudad) {
    return dbAgregar('notarias', {
        nombre: String(nombre).trim(),
        ciudad: String(ciudad).trim(),
        activa: true,
        creada: Date.now()
    });
}

async function notariaEditar(id, nombre, ciudad, activa) {
    const n = await dbObtener('notarias', Number(id));
    if (!n) throw new Error('La notaría no existe.');
    if (nombre) n.nombre = String(nombre).trim();
    if (ciudad) n.ciudad = String(ciudad).trim();
    if (activa !== undefined && activa !== null) n.activa = !!activa;
    return dbGuardar('notarias', n);
}

/* Fija las notarías de un usuario (reemplaza la lista). */
async function perfilNotariasFijar(usuario, ids) {
    const u = await dbObtener('usuarios', usuario);
    if (!u) throw new Error('El usuario no existe.');
    const lista = (ids || []).map(Number).filter(Boolean);

    if (u.rol === 'administrador') {
        // El admin ya las tiene todas por rol
        u.notarias = [];
    } else if (u.rol !== 'operador') {
        if (lista.length !== 1) throw new Error('Este rol trabaja en una sola notaría.');
        u.notariaId = lista[0];
        u.notarias = [];
    } else {
        if (!lista.length) throw new Error('El operador necesita al menos una notaría.');
        u.notarias = lista;
        u.notariaId = lista[0];
    }
    return dbGuardar('usuarios', u);
}

/* Notarías de un usuario, para el formulario de edición */
async function notariasDePerfil(usuario) {
    return _notariasDeUsuario(usuario);
}

/* Mueve una carpeta a otra notaría */
async function carpetaFijarNotaria(carpetaId, notariaId) {
    const c = await dbObtener('carpetas', Number(carpetaId));
    if (!c) throw new Error('La carpeta no existe.');
    c.notariaId = Number(notariaId);
    return dbGuardar('carpetas', c);
}

async function sembrarDatosIniciales() {
    const existentes = await dbTodos('usuarios');
    if (existentes.length > 0) return;

    // Dos notarías para probar la selección
    const santaMarta = await dbAgregar('notarias', {
        nombre: 'Notaría 2', ciudad: 'Santa Marta', activa: true, creada: Date.now()
    });
    const barranquilla = await dbAgregar('notarias', {
        nombre: 'Notaría 5', ciudad: 'Barranquilla', activa: true, creada: Date.now()
    });

    const usuariosDemo = [
        // El admin no lleva notarías asignadas
        { usuario: 'administrador', nombre: 'Ana Administradora', rol: 'administrador', clave: 'administrador123', correo: 'ana@ejemplo.com', notariaId: santaMarta, notarias: [] },
        // El operador está en las dos ciudades: le toca elegir
        { usuario: 'operador',      nombre: 'Carlos Operador',    rol: 'operador',      clave: 'operador123',      correo: 'carlos@ejemplo.com', notariaId: santaMarta, notarias: [santaMarta, barranquilla] },
        // Cliente y acreedor: una sola, entran directo
        { usuario: 'cliente',       nombre: 'Pedro Cliente',      rol: 'cliente',       clave: 'cliente123',       correo: 'pedro@ejemplo.com', notariaId: santaMarta, notarias: [] },
        { usuario: 'acreedor',      nombre: 'Banco Acreedor',     rol: 'acreedor',      clave: 'acreedor123',      correo: 'banco@ejemplo.com', notariaId: santaMarta, notarias: [] }
    ];
    for (const u of usuariosDemo) {
        await dbAgregar('usuarios', {
            usuario: u.usuario,
            nombre: u.nombre,
            rol: u.rol,
            activo: true,
            correo: u.correo,
            notariaId: u.notariaId,
            notarias: u.notarias,
            clave: await protegerClave(u.clave),
            creado: Date.now()
        });
    }

    await dbAgregar('carpetas', {
        nombre: 'Insolvencia — Pedro Cliente (Exp. 001-2026)',
        descripcion: 'Notas internas: audiencia de conciliación pendiente de fecha.',
        activa: true,
        notariaId: santaMarta,
        asignados: ['cliente', 'acreedor'],
        operadores: ['operador'],
        creadaPor: 'administrador',
        fecha: Date.now()
    });
    await dbAgregar('carpetas', {
        nombre: 'Conciliación — Caso de práctica (Exp. 002-2026)',
        descripcion: 'Carpeta sin operador asignado y desactivada: solo la ve el administrador.',
        activa: false,
        notariaId: santaMarta,
        asignados: ['cliente'],
        operadores: [],
        creadaPor: 'administrador',
        fecha: Date.now()
    });
    // En la otra ciudad, para probar el cambio de notaría
    await dbAgregar('carpetas', {
        nombre: 'Insolvencia — Marta Gómez (Exp. 010-2026)',
        descripcion: 'Expediente de la notaría de Barranquilla.',
        activa: true,
        notariaId: barranquilla,
        asignados: [],
        operadores: ['operador'],
        creadaPor: 'administrador',
        fecha: Date.now()
    });
}
