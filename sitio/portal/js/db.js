/*! Legajo · modo práctica (IndexedDB en el navegador)
  En la nube, nube.js reemplaza estas funciones con las de Supabase.
  Andrés Madrid · andresmadrid.vercel.app */
const DB_NOMBRE = 'portal_documental';
const DB_VERSION = 13; // v13: datos de ejemplo completos (dos oficinas, diez carpetas)

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

/* ¿La carpeta es de un centro de conciliación? */
async function _esDeCentro(carpeta) {
    if (!carpeta || carpeta.notariaId == null) return false;
    const n = await dbObtener('notarias', Number(carpeta.notariaId));
    return !!n && n.tipo === 'centro';
}

/* Fecha ISO más n meses. Si cae en día no hábil, pasa al siguiente hábil. */
function _sumarMeses(iso, n) {
    const [a, m, d] = iso.split('-').map(Number);
    const f = new Date(a, m - 1 + n, d);
    // 31 de enero + 1 mes no salta a marzo
    if (f.getDate() !== d) f.setDate(0);
    return primerDiaHabil(fechaISOLocal(f));
}

/* Conteo del trámite. Notaría: 60 días hábiles, 90 con prórroga.
   Centro: 3 meses, 6 con prórroga. */
async function tramiteIniciar(carpetaId, fecha) {
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.pausado) throw new Error('El trámite está pausado: reactívalo antes de iniciar el conteo.');
    if (carpeta.fechaInicioTramite) throw new Error('El conteo del trámite ya fue iniciado el ' + carpeta.fechaInicioTramite + '.');
    const inicio = fecha || fechaISOLocal(new Date());
    const vence = (await _esDeCentro(carpeta))
        ? _sumarMeses(inicio, 3) : calcularVencimientoHabil(inicio, 60);
    await dbGuardar('carpetas', {
        ...carpeta,
        fechaInicioTramite: inicio,
        diasHabilesTramite: Math.max(contarDiasHabiles(inicio, vence), 1),
        tieneProrroga: false,
        fechaVencimientoTramite: vence,
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
    const vence = (await _esDeCentro(carpeta))
        ? _sumarMeses(carpeta.fechaVencimientoTramite || carpeta.fechaInicioTramite, 3)
        : calcularVencimientoHabil(carpeta.fechaInicioTramite, 90);
    await dbGuardar('carpetas', {
        ...carpeta,
        diasHabilesTramite: Math.max(contarDiasHabiles(carpeta.fechaInicioTramite, vence), 1),
        tieneProrroga: true,
        fechaVencimientoTramite: vence
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
async function tramiteFinalizar(carpetaId, resultado) {
    if (!_esAdminLocal()) throw new Error('Solo el administrador puede dar fin al trámite.');
    const carpeta = await dbObtener('carpetas', carpetaId);
    if (!carpeta) throw new Error('Carpeta no encontrada.');
    if (carpeta.finalizado) throw new Error('El trámite ya estaba finalizado.');
    if (!resultado && await _esDeCentro(carpeta)) throw new Error('La conciliación necesita un resultado para cerrarse.');
    const hoy = fechaISOLocal(new Date());
    await dbGuardar('carpetas', {
        ...carpeta, finalizado: true, fechaFinTramite: hoy, resultado: resultado || null,
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
            tipo: n.tipo === 'centro' ? 'centro' : 'notaria',
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
        .map(n => ({ id: n.id, nombre: n.nombre, ciudad: n.ciudad, activa: n.activa !== false,
                     tipo: n.tipo === 'centro' ? 'centro' : 'notaria' }))
        .sort((a, b) => (a.ciudad + a.nombre).localeCompare(b.ciudad + b.nombre));
}

async function notariaCrear(nombre, ciudad, tipo) {
    return dbAgregar('notarias', {
        nombre: String(nombre).trim(),
        ciudad: String(ciudad).trim(),
        tipo: tipo === 'centro' ? 'centro' : 'notaria',
        activa: true,
        creada: Date.now()
    });
}

async function notariaEditar(id, nombre, ciudad, activa, tipo) {
    const n = await dbObtener('notarias', Number(id));
    if (!n) throw new Error('La oficina no existe.');
    if (nombre) n.nombre = String(nombre).trim();
    if (ciudad) n.ciudad = String(ciudad).trim();
    if (activa !== undefined && activa !== null) n.activa = !!activa;
    if (tipo && tipo !== (n.tipo || 'notaria')) {
        // Con carpetas no: sus plazos se contaron con las otras reglas
        const carpetas = await dbTodos('carpetas');
        if (carpetas.some(c => c.notariaId === n.id)) {
            throw new Error('Esta oficina ya tiene carpetas: su tipo no se puede cambiar.');
        }
        n.tipo = tipo;
    }
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

/* ============ DATOS DE PRÁCTICA ============
   Todo inventado: personas, empresas, expedientes y documentos.
   Las fechas salen de hoy, para que el semáforo tenga de todo. */

// PDF de una página con texto, válido para el visor
function _pdfDePractica(titulo, lineas) {
    const limpio = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '-').replace(/[()\\]/g, '\\$&');
    const texto = ['BT /F1 18 Tf 72 730 Td (' + limpio(titulo) + ') Tj ET']
        .concat(lineas.map((l, i) => 'BT /F1 11 Tf 72 ' + (692 - i * 18) + ' Td (' + limpio(l) + ') Tj ET'))
        .join('\n');
    const objetos = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length ' + texto.length + ' >>\nstream\n' + texto + '\nendstream',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    let pdf = '%PDF-1.4\n';
    const posiciones = [];
    objetos.forEach((o, i) => { posiciones.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = pdf.length;
    pdf += 'xref\n0 ' + (objetos.length + 1) + '\n0000000000 65535 f \n' +
        posiciones.map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('') +
        'trailer\n<< /Size ' + (objetos.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    return new Blob([pdf], { type: 'application/pdf' });
}

// Foto de ejemplo; sin OffscreenCanvas queda un PDF
async function _imagenDePractica(texto) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const lienzo = new OffscreenCanvas(640, 400);
    const g = lienzo.getContext('2d');
    g.fillStyle = '#F3E8D4'; g.fillRect(0, 0, 640, 400);
    g.fillStyle = '#C9A46A'; g.fillRect(32, 32, 160, 200);
    g.fillStyle = '#454B48'; g.font = 'bold 28px sans-serif'; g.fillText(texto, 220, 90);
    g.font = '20px sans-serif'; g.fillText('Documento de ejemplo', 220, 130);
    return lienzo.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

async function sembrarDatosIniciales() {
    const existentes = await dbTodos('usuarios');
    if (existentes.length > 0) return;

    const hoy = fechaISOLocal(new Date());
    const atras = n => restarDiasHabiles(hoy, n);
    const adelante = n => sumarDiasHabiles(hoy, n);
    const haceDias = n => Date.now() - n * 86400000;

    // Una notaría (insolvencia) y un centro de conciliación
    const santaMarta = await dbAgregar('notarias', {
        nombre: 'Notaría Primera', ciudad: 'Santa Marta', tipo: 'notaria', activa: true, creada: Date.now()
    });
    const barranquilla = await dbAgregar('notarias', {
        nombre: 'Centro de Conciliación Caribe', ciudad: 'Barranquilla', tipo: 'centro', activa: true, creada: Date.now()
    });
    const ambas = [santaMarta, barranquilla];

    // Los cuatro primeros son los del README; los demás entran con usuario + 123
    const usuariosDemo = [
        ['administrador', 'Ana María Restrepo', 'administrador', 'administrador123', []],
        ['operador', 'Carlos Mendoza', 'operador', 'operador123', ambas],
        ['cliente', 'Pedro Gutiérrez', 'cliente', 'cliente123', [santaMarta]],
        ['acreedor', 'Banco de la Costa', 'acreedor', 'acreedor123', [santaMarta]],
        ['lcantillo', 'Laura P. Cantillo', 'operador', 'lcantillo123', [santaMarta]],
        ['dvergara', 'Daniel Vergara', 'operador', 'dvergara123', [barranquilla]],
        ['monitor', 'Mónica Ruiz', 'monitor', 'monitor123', ambas],
        ['mrios', 'Martha L. Ríos', 'cliente', 'mrios123', [santaMarta]],
        ['iduarte', 'Inversiones Duarte S.A.S.', 'cliente', 'iduarte123', [santaMarta]],
        ['lgil', 'Luz Marina Gil', 'cliente', 'lgil123', [santaMarta]],
        ['jsalas', 'Jorge E. Salas', 'cliente', 'jsalas123', [santaMarta]],
        ['jortega', 'José M. Ortega', 'cliente', 'jortega123', [santaMarta]],
        ['cavanzar', 'Cooperativa Avanzar', 'acreedor', 'cavanzar123', [santaMarta]],
        ['fnorte', 'Financiera del Norte', 'acreedor', 'fnorte123', [santaMarta]],
        ['cpena', 'Carlos A. Peña', 'cliente', 'cpena123', [barranquilla]],
        ['mgomez', 'Marta Gómez', 'cliente', 'mgomez123', [barranquilla]],
        ['fpuerto', 'Ferretería Puerto Ltda.', 'cliente', 'fpuerto123', [barranquilla]],
        ['isol', 'Inmobiliaria Sol S.A.S.', 'acreedor', 'isol123', [barranquilla]],
        ['arrio', 'Arrendamientos del Río', 'acreedor', 'arrio123', [barranquilla]]
    ];
    const nombre = {};
    for (const [usuario, nom, rol, clave, notarias] of usuariosDemo) {
        nombre[usuario] = nom;
        await dbAgregar('usuarios', {
            usuario, nombre: nom, rol, activo: true,
            correo: usuario + '@ejemplo.com',
            notariaId: notarias[0] || santaMarta,
            // El admin no lleva oficinas asignadas
            notarias: rol === 'administrador' ? [] : notarias,
            clave: await protegerClave(clave),
            creado: haceDias(60)
        });
    }

    // Carpeta con su plazo, procesos, subcarpeta de audiencias y documentos
    async function carpeta(d) {
        const id = await dbAgregar('carpetas', {
            nombre: d.nombre, descripcion: d.descripcion || '', tipoProceso: d.tipoProceso || null,
            activa: d.activa !== false, notariaId: d.oficina, asignados: d.partes, operadores: d.operadores,
            creadaPor: 'administrador', fecha: haceDias(d.creadaHace || 30),
            ...(d.tramite || {})
        });
        const audiencias = await dbAgregar('subcarpetas', { carpetaId: id, nombre: 'Audiencias', orden: 1, creado: Date.now() });
        let orden = 1;
        const ids = {};
        for (const doc of d.documentos || []) {
            const blob = doc.nombre.endsWith('.jpg')
                ? (await _imagenDePractica(nombre[d.partes[0]] || 'Ejemplo')) || _pdfDePractica(doc.nombre, [])
                : _pdfDePractica(doc.nombre.replace(/\.pdf$/, ''), [
                    d.nombre, 'Documento de ejemplo del modo practica de Legajo.',
                    'Los nombres, fechas y cifras son inventados.'
                ]);
            ids[doc.nombre] = await dbAgregar('archivos', {
                carpetaId: id,
                subcarpetaId: doc.enAudiencias ? audiencias : null,
                nombre: doc.nombre, tipo: blob.type, tamano: doc.kb * 1024, blob,
                descargablePartes: true,
                anexoDe: doc.anexoDe ? ids[doc.anexoDe] : null,
                orden: orden++,
                subidoPor: nombre[doc.por] || doc.por,
                fecha: haceDias(doc.hace)
            });
        }
        // En la nube estos contadores los lleva la base
        const docs = d.documentos || [];
        if (docs.length) {
            const c = await dbObtener('carpetas', id);
            await dbGuardar('carpetas', {
                ...c, totalArchivos: docs.length,
                pesoTotalMb: docs.reduce((t, doc) => t + doc.kb, 0) / 1024
            });
        }
        let n = 1;
        for (const p of d.procesos || []) {
            await dbAgregar('procesos', {
                carpetaId: id, nombre: p.nombre, dias: p.dias || 10, orden: n++,
                completado: !!p.completado, fechaInicio: atras(p.desde || 10), fechaInicioHabil: atras(p.desde || 10),
                fechaVencimiento: p.vence, fechaCompletado: p.completado ? atras(1) : null,
                pausado: !!p.pausado, diasRestantesAlPausar: p.pausado ? p.restantes : null,
                semaforoManual: null, creado: Date.now()
            });
        }
        for (const a of d.audiencias || []) {
            await dbAgregar('audiencias', {
                carpetaId: id, titulo: a.titulo, fecha: a.fecha, hora: a.hora, enlace: a.enlace || '',
                creadoPor: d.operadores[0] || 'administrador', creado: haceDias(2)
            });
        }
        for (const m of d.mensajes || []) {
            const autor = usuariosDemo.find(u => u[0] === m.de);
            await dbAgregar('mensajes', {
                carpetaId: id, canal: m.canal, autorUsuario: m.de, autorNombre: autor[1], rol: autor[2],
                texto: m.texto, archivoNombre: '', archivoTamano: 0, archivoTipo: '', archivoBlob: null,
                fecha: Date.now() - m.minutos * 60000
            });
        }
        return id;
    }

    // Plazo del trámite: insolvencia en días hábiles, conciliación en meses
    const insolvencia = (inicio, dias) => ({
        fechaInicioTramite: inicio, diasHabilesTramite: dias, tieneProrroga: dias > 60,
        fechaVencimientoTramite: calcularVencimientoHabil(inicio, dias), diasRestantesTramiteAlPausar: null
    });
    const conciliacion = (inicio, vence) => ({
        fechaInicioTramite: inicio, diasHabilesTramite: Math.max(contarDiasHabiles(inicio, vence), 1),
        tieneProrroga: false, fechaVencimientoTramite: vence, diasRestantesTramiteAlPausar: null
    });
    const tresMesesAntes = iso => { const f = new Date(iso + 'T00:00:00'); f.setMonth(f.getMonth() - 3); return fechaISOLocal(f); };

    // ---- Notaría Primera, Santa Marta ----
    await carpeta({
        nombre: 'Insolvencia — Martha L. Ríos (Exp. 2026-0418)', oficina: santaMarta, tipoProceso: 'natural_no_comerciante',
        descripcion: 'Audiencia de negociación fijada. Falta el certificado de tradición del vehículo.',
        partes: ['mrios', 'acreedor', 'cavanzar'], operadores: ['operador'], creadaHace: 84,
        tramite: insolvencia(atras(57), 60),
        documentos: [
            { nombre: 'Solicitud de negociación de deudas.pdf', kb: 820, por: 'mrios', hace: 82 },
            { nombre: 'Relación de acreencias.pdf', kb: 96, por: 'mrios', hace: 82, anexoDe: 'Solicitud de negociación de deudas.pdf' },
            { nombre: 'Certificado de ingresos.pdf', kb: 142, por: 'mrios', hace: 3, anexoDe: 'Solicitud de negociación de deudas.pdf' },
            { nombre: 'Poder especial del apoderado.pdf', kb: 640, por: 'mrios', hace: 81 },
            { nombre: 'Cédula de ciudadanía.jpg', kb: 488, por: 'mrios', hace: 3 },
            { nombre: 'Auto de aceptación — 2026-0418.pdf', kb: 412, por: 'operador', hace: 78 },
            { nombre: 'Citación a audiencia de negociación.pdf', kb: 205, por: 'operador', hace: 6, enAudiencias: true }
        ],
        procesos: [
            { nombre: 'Aceptación de la solicitud', completado: true, vence: atras(50), desde: 57 },
            { nombre: 'Audiencia de negociación de deudas', vence: adelante(1), desde: 15 }
        ],
        audiencias: [
            { titulo: 'Audiencia de negociación de deudas', fecha: adelante(3), hora: '09:00' },
            { titulo: 'Continuación de la audiencia', fecha: adelante(13), hora: '14:30', enlace: 'https://reunion.ejemplo.com/legajo-0418' }
        ],
        mensajes: [
            { canal: 'cliente', de: 'mrios', texto: 'Buenos días. Ya subí la cédula y el certificado de ingresos.', minutos: 1500 },
            { canal: 'cliente', de: 'operador', texto: 'Recibidos, gracias. La audiencia quedó para dentro de tres días hábiles, a las 9:00.', minutos: 1440 },
            { canal: 'cliente', de: 'mrios', texto: '¿Debo llevar algún documento adicional?', minutos: 95 },
            { canal: 'cliente', de: 'operador', texto: 'Solo la cédula original. Lo demás ya está en el expediente.', minutos: 80 },
            { canal: 'acreedor', de: 'cavanzar', texto: 'Enviamos la relación de la deuda actualizada a este mes.', minutos: 2900 },
            { canal: 'acreedor', de: 'operador', texto: 'Gracias. Quedó como anexo 1.1 de la solicitud.', minutos: 2850 }
        ]
    });
    await carpeta({
        nombre: 'Insolvencia — Inversiones Duarte S.A.S. (Exp. 2026-0397)', oficina: santaMarta, tipoProceso: 'pequeno_comerciante',
        descripcion: 'Pendiente la relación de acreencias actualizada.',
        partes: ['iduarte', 'acreedor', 'fnorte'], operadores: ['lcantillo'], creadaHace: 95,
        tramite: insolvencia(atras(62), 60),
        documentos: [
            { nombre: 'Solicitud de negociación de deudas.pdf', kb: 1180, por: 'iduarte', hace: 93 },
            { nombre: 'Estados financieros 2025.pdf', kb: 2310, por: 'iduarte', hace: 93 },
            { nombre: 'Auto de aceptación — 2026-0397.pdf', kb: 398, por: 'lcantillo', hace: 88 }
        ],
        procesos: [{ nombre: 'Relación de acreencias actualizada', vence: atras(2), desde: 12 }]
    });
    await carpeta({
        nombre: 'Insolvencia — Luz Marina Gil (Exp. 2026-0381)', oficina: santaMarta, tipoProceso: 'natural_no_comerciante',
        partes: ['lgil', 'cavanzar'], operadores: ['lcantillo'], creadaHace: 34,
        tramite: insolvencia(atras(21), 60),
        documentos: [
            { nombre: 'Solicitud de negociación de deudas.pdf', kb: 760, por: 'lgil', hace: 32 },
            { nombre: 'Poder especial del apoderado.pdf', kb: 512, por: 'lgil', hace: 32 }
        ],
        procesos: [{ nombre: 'Notificación a los acreedores', vence: adelante(12), desde: 5 }],
        audiencias: [{ titulo: 'Audiencia de negociación de deudas', fecha: adelante(18), hora: '09:30' }]
    });
    await carpeta({
        nombre: 'Insolvencia — Jorge E. Salas (Exp. 2026-0374)', oficina: santaMarta, tipoProceso: 'natural_no_comerciante',
        descripcion: 'Prórroga aplicada a solicitud de las partes.',
        partes: ['jsalas', 'acreedor', 'fnorte'], operadores: ['operador'], creadaHace: 110,
        tramite: insolvencia(atras(71), 90),
        documentos: [
            { nombre: 'Solicitud de negociación de deudas.pdf', kb: 905, por: 'jsalas', hace: 108 },
            { nombre: 'Propuesta de acuerdo de pago.pdf', kb: 330, por: 'jsalas', hace: 9 },
            { nombre: 'Acta de audiencia de negociación.pdf', kb: 288, por: 'operador', hace: 20, enAudiencias: true }
        ],
        procesos: [
            { nombre: 'Audiencia de negociación', completado: true, vence: atras(15), desde: 40 },
            { nombre: 'Acuerdo de pago', vence: adelante(15), desde: 10 }
        ],
        audiencias: [{ titulo: 'Audiencia de acuerdo de pago', fecha: adelante(7), hora: '10:00' }]
    });
    await carpeta({
        nombre: 'Insolvencia — José M. Ortega (Exp. 2026-0362)', oficina: santaMarta, tipoProceso: 'pequeno_comerciante',
        descripcion: 'Pausado: el deudor pidió aplazar mientras llega un documento de la DIAN.',
        partes: ['jortega', 'cavanzar'], operadores: ['lcantillo'], creadaHace: 50,
        tramite: { ...insolvencia(atras(30), 60), pausado: true, fechaPausa: atras(4), diasRestantesTramiteAlPausar: 34 },
        documentos: [{ nombre: 'Solicitud de negociación de deudas.pdf', kb: 690, por: 'jortega', hace: 48 }],
        procesos: [{ nombre: 'Aceptación de la solicitud', vence: adelante(6), desde: 8, pausado: true, restantes: 6 }]
    });
    await carpeta({
        nombre: 'Insolvencia — Pedro Gutiérrez (Exp. 2026-0301)', oficina: santaMarta, tipoProceso: 'natural_no_comerciante',
        partes: ['cliente', 'acreedor'], operadores: ['operador'], creadaHace: 14,
        tramite: insolvencia(atras(9), 60),
        documentos: [
            { nombre: 'Solicitud de negociación de deudas.pdf', kb: 702, por: 'cliente', hace: 12 },
            { nombre: 'Relación de acreencias.pdf', kb: 88, por: 'cliente', hace: 12, anexoDe: 'Solicitud de negociación de deudas.pdf' }
        ],
        procesos: [{ nombre: 'Aceptación de la solicitud', vence: adelante(5), desde: 9 }],
        mensajes: [
            { canal: 'cliente', de: 'cliente', texto: 'Hola, ¿en qué va mi trámite?', minutos: 300 },
            { canal: 'cliente', de: 'operador', texto: 'Buenas tardes. Estamos revisando la solicitud; esta semana sale el auto.', minutos: 260 }
        ]
    });
    await carpeta({
        nombre: 'Insolvencia — Caso de práctica (Exp. 2026-0002)', oficina: santaMarta,
        descripcion: 'Carpeta sin operador y desactivada: solo la ve el administrador.',
        activa: false, partes: ['cliente'], operadores: [], creadaHace: 200
    });

    // ---- Centro de Conciliación Caribe, Barranquilla ----
    const finPena = atras(3);
    await carpeta({
        nombre: 'Conciliación — Carlos A. Peña con Inmobiliaria Sol (Exp. 2026-0402)', oficina: barranquilla,
        descripcion: 'Terminó con acuerdo total sobre la entrega del inmueble.',
        partes: ['cpena', 'isol'], operadores: ['dvergara', 'operador'], creadaHace: 70,
        tramite: {
            ...conciliacion(atras(45), adelante(20)),
            finalizado: true, fechaFinTramite: finPena, resultado: 'acuerdo_total',
            fechaDesactivacion: sumarDiasHabiles(finPena, 30)
        },
        documentos: [
            { nombre: 'Solicitud de conciliación.pdf', kb: 540, por: 'cpena', hace: 68 },
            { nombre: 'Contrato de arrendamiento.pdf', kb: 1320, por: 'cpena', hace: 68 },
            { nombre: 'Acta de conciliación — acuerdo total.pdf', kb: 310, por: 'dvergara', hace: 4, enAudiencias: true }
        ]
    });
    const inicioGomez = atras(22);
    await carpeta({
        nombre: 'Conciliación — Marta Gómez con Arrendamientos del Río (Exp. 2026-0410)', oficina: barranquilla,
        partes: ['mgomez', 'arrio'], operadores: ['dvergara'], creadaHace: 32,
        tramite: conciliacion(inicioGomez, _sumarMeses(inicioGomez, 3)),
        documentos: [
            { nombre: 'Solicitud de conciliación.pdf', kb: 480, por: 'mgomez', hace: 31 },
            { nombre: 'Citación a audiencia de conciliación.pdf', kb: 176, por: 'dvergara', hace: 5, enAudiencias: true }
        ],
        procesos: [{ nombre: 'Audiencia de conciliación', vence: adelante(8), desde: 6 }],
        audiencias: [{ titulo: 'Audiencia de conciliación', fecha: adelante(6), hora: '11:00' }]
    });
    const venceFerreteria = adelante(4);
    await carpeta({
        nombre: 'Conciliación — Ferretería Puerto con Inmobiliaria Sol (Exp. 2026-0415)', oficina: barranquilla,
        descripcion: 'Segunda citación: el convocado no asistió a la primera.',
        partes: ['fpuerto', 'isol'], operadores: ['operador'], creadaHace: 95,
        tramite: conciliacion(tresMesesAntes(venceFerreteria), venceFerreteria),
        documentos: [
            { nombre: 'Solicitud de conciliación.pdf', kb: 610, por: 'fpuerto', hace: 92 },
            { nombre: 'Constancia de inasistencia.pdf', kb: 120, por: 'operador', hace: 15, enAudiencias: true }
        ],
        procesos: [{ nombre: 'Segunda audiencia de conciliación', vence: adelante(1), desde: 10 }],
        audiencias: [{ titulo: 'Segunda audiencia de conciliación', fecha: adelante(1), hora: '08:30' }]
    });
}
