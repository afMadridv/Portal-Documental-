/*! Portal Documental · conexión a Supabase
  Con MODO 'nube' reemplaza las funciones de db.js por Auth, Postgres y
  Storage. app.js y login.js no se enteran.
  Andrés Madrid · andresmadrid.vercel.app */
(() => {
    const cfg = (typeof PORTAL_CONFIG !== 'undefined') ? PORTAL_CONFIG : null;
    if (!cfg || cfg.MODO !== 'nube' || !cfg.SUPABASE_URL) return;
    if (!window.supabase || !window.supabase.createClient) {
        console.warn('No cargó supabase-js; el portal sigue en modo local.');
        return;
    }

    const nube = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

    console.info('Portal Documental: conectado a Supabase (' + cfg.SUPABASE_URL + ')');

    /* ============ UTILIDADES ============ */
    function aEmail(usuario) {
        return usuario.includes('@') ? usuario : (usuario + '@' + cfg.DOMINIO_USUARIOS);
    }

    // acentos que separa NFD (U+0300 a U+036F)
    const MARCAS_ACENTO = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

    function limpiarNombre(nombre) {
        return String(nombre)
            .normalize('NFD').replace(MARCAS_ACENTO, '') // sin tildes
            .replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    function errorLegible(e) {
        const m = String((e && (e.message || e.error_description)) || e || '');
        if (m.includes('Invalid login credentials')) return 'Usuario o contraseña incorrectos.';
        if (m.includes('Email not confirmed')) return 'El usuario existe pero su correo no está confirmado. En Supabase: Authentication → Sign In / Providers → Email → desactivar "Confirm email".';
        if (m.includes('User already registered')) return 'Ya existe un usuario con ese nombre.';
        if (m.includes('Signups not allowed') || m.includes('signup_disabled')) return 'El registro de usuarios está desactivado en Supabase. Actívalo en Authentication → Sign In / Providers → "Allow new users to sign up" para poder crear operadores, clientes y acreedores.';
        if (m.includes('rate limit') || m.includes('For security purposes') || m.includes('over_email_send')) return 'Supabase limitó temporalmente los registros. Espera un momento y vuelve a intentarlo.';
        if (m.includes('Password should be')) return 'La contraseña no cumple el mínimo configurado en Supabase.';
        // "schema cache" sale igual si falta una tabla o una columna: se muestra
        // el texto crudo, que dice qué falta.
        if (m.includes('schema cache') || m.includes('does not exist')) {
            return 'A la base le falta algo que el portal necesita; seguramente quedó una migración sin correr. Dice: ' + m;
        }
        if (m.includes('Failed to fetch') || m.includes('NetworkError')) return 'Sin conexión con Supabase. Revisa tu internet.';
        if (m.includes('row-level security')) return 'Tu rol no tiene permiso para esa acción.';
        // Storage cortó antes que el portal: los topes del servidor no cuadran
        if (m.includes('exceeded the maximum allowed size') || m.includes('Payload too large')) {
            return 'el servidor no aceptó un archivo tan grande; avísale al administrador';
        }
        // El mensaje de Postgres para esta restricción no se entiende
        if (m.includes('perfiles_correo_obligatorio')) return 'Este rol necesita un correo de contacto: por ahí le llegan los avisos del trámite.';
        return m || 'Error de conexión con la base de datos.';
    }

    function fallar(e) { throw new Error(errorLegible(e)); }

    function sesionNube() { return sesionActual() || {}; }

    /* "Android", "Windows"... en vez del user-agent completo. */
    function _dispositivo() {
        const ua = String(navigator.userAgent || '');
        const so = /Android/i.test(ua) ? 'Android'
                 : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone o iPad'
                 : /Windows/i.test(ua) ? 'Windows'
                 : /Mac OS/i.test(ua) ? 'Mac'
                 : /Linux/i.test(ua) ? 'Linux' : 'otro';
        const nav = /Edg\//.test(ua) ? 'Edge'
                  : /OPR\/|Opera/.test(ua) ? 'Opera'
                  : /Chrome\//.test(ua) ? 'Chrome'
                  : /Firefox\//.test(ua) ? 'Firefox'
                  : /Safari\//.test(ua) ? 'Safari' : '';
        return (so + (nav ? ' · ' + nav : '')).slice(0, 120);
    }

    /* ============ AUTENTICACIÓN ============ */
    window.iniciarSesion = async (usuario, clave, recordar) => {
        const nombreUsuario = String(usuario || '').trim().toLowerCase();
        if (!nombreUsuario || !clave) return { error: 'Escribe el usuario y la contraseña.' };

        const { data, error } = await nube.auth.signInWithPassword({
            email: aEmail(nombreUsuario), password: clave
        });
        if (error) return { error: errorLegible(error) };

        const { data: perfil, error: errorPerfil } = await nube
            .from('perfiles').select('*').eq('id', data.user.id).maybeSingle();
        if (errorPerfil) { await nube.auth.signOut(); return { error: errorLegible(errorPerfil) }; }
        if (!perfil) {
            await nube.auth.signOut();
            return { error: 'Tu cuenta no tiene perfil en el portal (¿se ejecutó esquema.sql antes de crear los usuarios?).' };
        }
        if (perfil.activo === false) {
            await nube.auth.signOut();
            return { error: 'Tu usuario está desactivado. Comunícate con la administración del portal.' };
        }

        // Esta pasa a ser la sesión vigente; las de otros equipos se cierran
        // solas al preguntar. Si la llamada falla, se entra igual.
        let sid = null;
        try {
            const { data: id, error: errSid } = await nube.rpc(
                'sesion_abrir', { p_dispositivo: _dispositivo() });
            // supabase-js no lanza: hay que revisar `error`.
            if (errSid) console.warn('sesion_abrir:', errSid.message || errSid);
            sid = id || null;
        } catch (e) { console.warn('sesion_abrir:', e && e.message); }

        // Por guardarSesion, que maneja el plazo y "mantener la sesión".
        guardarSesion(Object.assign({ sid: sid }, perfil), recordar);
        return { usuario: perfil };
    };

    /* ¿La cuenta sigue activa en el servidor? 'viva', 'fuera' o 'nose'.
       Con 'nose' no se cierra nada (un bache de red sacaría a todos).
       Hace falta porque borrar la cuenta no toca la copia en localStorage. */
    window.sesionSigueViva = async () => {
        const ses = sesionActual();
        if (!ses || !ses._id) return 'nose';
        try {
            // Va al servidor (getSession solo mira lo local).
            const { data, error } = await nube.rpc('sesion_estado',
                { p_sesion: ses.sid || null });
            if (error) {
                // Token rechazado = cuenta fuera. Otros errores no son concluyentes.
                const m = String((error && error.message) || '');
                if (/sesion_estado|schema cache|does not exist/i.test(m)) return 'nose'; // falta la migración
                return /JWT|token|not authenticated|401|403/i.test(m) ? 'fuera' : 'nose';
            }
            return data || 'nose';
        } catch (e) { return 'nose'; }
    };

    window.cerrarSesion = (destino) => {
        localStorage.removeItem(CLAVE_SESION);
        // pase lo que pase con la red, se navega al destino indicado
        nube.auth.signOut().catch(() => {}).finally(() => { location.href = destino || './'; });
    };

    // En la nube no se siembran datos de demostración
    window.sembrarDatosIniciales = async () => {};

    /* ============ ADAPTADORES DE DATOS ============ */
    async function listarPerfiles() {
        // Notarías extra del operador en la misma consulta; RLS filtra.
        // Las credenciales solo llegan si pregunta un admin (RLS).
        const [rPerfiles, rNotarias, rClaves] = await Promise.all([
            nube.from('perfiles').select('*').order('usuario'),
            nube.from('perfil_notarias').select('perfil_id, notaria_id'),
            nube.from('credenciales').select('perfil_id, clave, actualizada')
        ]);
        const { data, error } = rPerfiles;
        if (error) fallar(error);
        const extra = {};
        for (const f of (rNotarias.data || [])) {
            (extra[f.perfil_id] = extra[f.perfil_id] || []).push(f.notaria_id);
        }
        const claves = {};
        for (const c of (rClaves.data || [])) {
            claves[c.perfil_id] = { clave: c.clave, actualizada: Date.parse(c.actualizada) };
        }
        return data.map(p => ({
            usuario: p.usuario, nombre: p.nombre, rol: p.rol,
            activo: p.activo, correo: p.correo || '', creado: Date.parse(p.creado), _id: p.id,
            notariaId: p.notaria_id || null,
            notarias: extra[p.id] || (p.notaria_id ? [p.notaria_id] : []),
            primerLogin: p.primer_login !== false,
            clave: (claves[p.id] || {}).clave || '',
            claveActualizada: (claves[p.id] || {}).actualizada || null,
            ultimaConexion: p.ultima_conexion ? Date.parse(p.ultima_conexion) : null
        }));
    }

    /* uuid → usuario (solo el admin lee todos los perfiles) */
    function _mapaUsuarios(ses, perfiles) {
        const usuarioPorId = {};
        (perfiles || []).forEach(p => { usuarioPorId[p.id] = p.usuario; });
        if (ses._id) usuarioPorId[ses._id] = ses.usuario;
        return usuarioPorId;
    }

    async function listarCarpetas() {
        const ses = sesionNube();
        // RLS filtra por rol. Las 4 consultas van en paralelo.
        const [rCarpetas, rAsignados, rOperadores, rPerfiles] = await Promise.all([
            nube.from('carpetas').select('*'),
            nube.from('carpeta_asignados').select('carpeta_id, perfil_id'),
            nube.from('carpeta_operadores').select('carpeta_id, perfil_id'),
            ['administrador', 'monitor'].includes(ses.rol)
                ? nube.from('perfiles').select('id, usuario')
                : Promise.resolve({ data: null, error: null })
        ]);
        if (rCarpetas.error) fallar(rCarpetas.error);
        if (rAsignados.error) fallar(rAsignados.error);
        if (rOperadores.error) fallar(rOperadores.error);
        const usuarioPorId = _mapaUsuarios(ses, rPerfiles.data);

        return rCarpetas.data.map(c => ({
            id: c.id, nombre: c.nombre, descripcion: c.descripcion,
            pausado: !!c.pausado, fechaPausa: c.fecha_pausa || null,
            fechaReactivacion: c.fecha_reactivacion || null,
            fechaInicioTramite: c.fecha_inicio_tramite || null,
            diasHabilesTramite: c.dias_habiles_tramite || 60,
            tieneProrroga: !!c.tiene_prorroga,
            fechaVencimientoTramite: c.fecha_vencimiento_tramite || null,
            pesoTotalMb: Number(c.peso_total_mb || 0),
            totalArchivos: Number(c.total_archivos || 0),
            finalizado: !!c.finalizado,
            fechaFinTramite: c.fecha_fin_tramite || null,
            fechaDesactivacion: c.fecha_desactivacion_programada || null,
            activa: c.activa, creadaPor: c.creada_por, fecha: Date.parse(c.fecha),
            notariaId: c.notaria_id || null,
            tipoProceso: c.tipo_proceso || null,
            asignados: (rAsignados.data || [])
                .filter(a => a.carpeta_id === c.id)
                .map(a => usuarioPorId[a.perfil_id] || a.perfil_id),
            operadores: (rOperadores.data || [])
                .filter(o => o.carpeta_id === c.id)
                .map(o => usuarioPorId[o.perfil_id] || o.perfil_id)
        }));
    }

    /* Una carpeta con sus vínculos */
    async function obtenerCarpeta(clave) {
        const ses = sesionNube();
        const [rC, rA, rO, rPerfiles] = await Promise.all([
            nube.from('carpetas').select('*').eq('id', clave).maybeSingle(),
            nube.from('carpeta_asignados').select('perfil_id').eq('carpeta_id', clave),
            nube.from('carpeta_operadores').select('perfil_id').eq('carpeta_id', clave),
            ['administrador', 'monitor'].includes(ses.rol)
                ? nube.from('perfiles').select('id, usuario')
                : Promise.resolve({ data: null, error: null })
        ]);
        if (rC.error) fallar(rC.error);
        if (!rC.data) return undefined;
        if (rA.error) fallar(rA.error);
        if (rO.error) fallar(rO.error);
        const usuarioPorId = _mapaUsuarios(ses, rPerfiles.data);
        const c = rC.data;
        return {
            id: c.id, nombre: c.nombre, descripcion: c.descripcion,
            pausado: !!c.pausado, fechaPausa: c.fecha_pausa || null,
            fechaReactivacion: c.fecha_reactivacion || null,
            fechaInicioTramite: c.fecha_inicio_tramite || null,
            diasHabilesTramite: c.dias_habiles_tramite || 60,
            tieneProrroga: !!c.tiene_prorroga,
            fechaVencimientoTramite: c.fecha_vencimiento_tramite || null,
            pesoTotalMb: Number(c.peso_total_mb || 0),
            totalArchivos: Number(c.total_archivos || 0),
            finalizado: !!c.finalizado,
            fechaFinTramite: c.fecha_fin_tramite || null,
            fechaDesactivacion: c.fecha_desactivacion_programada || null,
            activa: c.activa, creadaPor: c.creada_por, fecha: Date.parse(c.fecha),
            asignados: (rA.data || []).map(a => usuarioPorId[a.perfil_id] || a.perfil_id),
            operadores: (rO.data || []).map(o => usuarioPorId[o.perfil_id] || o.perfil_id)
        };
    }

    /* Reemplaza asignados y operadores (una lectura, escrituras en paralelo) */
    async function guardarTodosVinculos(carpetaId, asignados, operadores) {
        const { data: perfiles, error } = await nube.from('perfiles').select('id, usuario');
        if (error) fallar(error);
        const idPorUsuario = {};
        (perfiles || []).forEach(p => { idPorUsuario[p.usuario] = p.id; });

        const reemplazar = async (tabla, usuarios) => {
            const { error: errorBorra } = await nube.from(tabla)
                .delete().eq('carpeta_id', carpetaId);
            if (errorBorra) fallar(errorBorra);
            const filas = (usuarios || [])
                .map(u => idPorUsuario[u]).filter(Boolean)
                .map(perfilId => ({ carpeta_id: carpetaId, perfil_id: perfilId }));
            if (filas.length > 0) {
                const { error: errorInserta } = await nube.from(tabla).insert(filas);
                if (errorInserta) fallar(errorInserta);
            }
        };
        await Promise.all([
            reemplazar('carpeta_asignados', asignados),
            reemplazar('carpeta_operadores', operadores)
        ]);
    }

    window.dbTodos = async (almacen) => {
        if (almacen === 'usuarios') return listarPerfiles();
        if (almacen === 'carpetas') return listarCarpetas();
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos').select('id, carpeta_id');
            if (error) fallar(error);
            return data.map(a => ({ id: a.id, carpetaId: a.carpeta_id }));
        }
        return [];
    };

    window.dbObtener = async (almacen, clave) => {
        if (almacen === 'usuarios') {
            const { data, error } = await nube.from('perfiles')
                .select('*').eq('usuario', clave).maybeSingle();
            if (error) fallar(error);
            if (!data) return undefined;
            return {
                usuario: data.usuario, nombre: data.nombre, rol: data.rol,
                activo: data.activo, correo: data.correo || '', creado: Date.parse(data.creado), _id: data.id
            };
        }
        if (almacen === 'carpetas') {
            return obtenerCarpeta(clave);
        }
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos')
                .select('*').eq('id', clave).maybeSingle();
            if (error) fallar(error);
            if (!data) return undefined;
            const { data: blob, error: errorBlob } = await nube.storage
                .from('documentos').download(data.ruta_storage);
            if (errorBlob) fallar(errorBlob);
            return {
                id: data.id, carpetaId: data.carpeta_id, nombre: data.nombre,
                tipo: data.tipo, tamano: data.tamano, blob,
                subidoPor: data.subido_por_usuario, fecha: Date.parse(data.fecha)
            };
        }
        return undefined;
    };

    window.dbAgregar = async (almacen, valor) => {
        const ses = sesionNube();
        if (almacen === 'carpetas') {
            const { data, error } = await nube.from('carpetas').insert({
                nombre: valor.nombre,
                descripcion: valor.descripcion || '',
                activa: !!valor.activa,
                // La carpeta cae en la notaría abierta
                notaria_id: valor.notariaId || null,
                // Régimen del trámite (cambia la ley aplicable)
                tipo_proceso: valor.tipoProceso || null,
                creada_por: ses._id || null
            }).select('id').single();
            if (error) fallar(error);
            await guardarTodosVinculos(data.id, valor.asignados, valor.operadores);
            return data.id;
        }
        if (almacen === 'archivos') {
            // <carpeta>/<subcarpeta>/<archivo>: el primer segmento no cambia, las
            // reglas de Storage siguen igual.
            const sub = valor.subcarpetaId ? valor.subcarpetaId + '/' : '';
            const ruta = valor.carpetaId + '/' + sub + Date.now() + '_' + limpiarNombre(valor.nombre);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, valor.blob, { contentType: valor.tipo || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            const { error: errorFila } = await nube.from('archivos').insert({
                carpeta_id: valor.carpetaId, nombre: valor.nombre,
                subcarpeta_id: valor.subcarpetaId || null,
                tipo: valor.tipo || '', tamano: valor.tamano || 0,
                ruta_storage: ruta,
                descargable_partes: valor.descargablePartes !== false,
                // nombre visible; la identidad real va en subido_por
                subido_por: ses._id || null, subido_por_usuario: ses.nombre || ses.usuario || '',
                // anexo_de solo si es anexo: así funciona aunque falte la columna
                ...(valor.anexoDe ? { anexo_de: Number(valor.anexoDe) } : {})
            });
            if (errorFila) fallar(errorFila);
            return;
        }
        throw new Error('Operación no disponible en la nube: agregar en ' + almacen);
    };

    window.dbGuardar = async (almacen, valor) => {
        if (almacen === 'carpetas') {
            const { error } = await nube.from('carpetas').update({
                nombre: valor.nombre,
                descripcion: valor.descripcion || '',
                tipo_proceso: valor.tipoProceso || null,
                activa: !!valor.activa
            }).eq('id', valor.id);
            if (error) fallar(error);
            if (valor.asignados || valor.operadores) {
                await guardarTodosVinculos(valor.id, valor.asignados || [], valor.operadores || []);
            }
            return;
        }
        if (almacen === 'usuarios') {
            const { error } = await nube.from('perfiles').update({
                nombre: valor.nombre, rol: valor.rol, activo: valor.activo !== false,
                correo: valor.correo || null
            }).eq(valor._id ? 'id' : 'usuario', valor._id || valor.usuario);
            if (error) fallar(error);
            return;
        }
        throw new Error('Operación no disponible en la nube: guardar en ' + almacen);
    };

    window.dbEliminar = async (almacen, clave) => {
        if (almacen === 'carpetas') {
            const { error } = await nube.from('carpetas').delete().eq('id', clave);
            if (error) fallar(error);
            return;
        }
        if (almacen === 'archivos') {
            const { data, error } = await nube.from('archivos')
                .select('ruta_storage').eq('id', clave).maybeSingle();
            if (error) fallar(error);
            if (data) await nube.storage.from('documentos').remove([data.ruta_storage]);
            const { error: errorFila } = await nube.from('archivos').delete().eq('id', clave);
            if (errorFila) fallar(errorFila);
            return;
        }
        if (almacen === 'usuarios') {
            // Quita el perfil (pierde el acceso). La cuenta se borra del todo en Supabase.
            const { error } = await nube.from('perfiles').delete().eq('usuario', clave);
            if (error) fallar(error);
            return;
        }
    };

    /* PostgREST corta en 1000 filas sin avisar. Esto pide de mil en mil
       hasta que una tanda venga incompleta. */
    const TOPE_FILAS = 1000;
    async function traerTodas(consulta) {
        const todas = [];
        for (let desde = 0; ; desde += TOPE_FILAS) {
            const { data, error } = await consulta(desde, desde + TOPE_FILAS - 1);
            if (error) fallar(error);
            const tanda = data || [];
            todas.push(...tanda);
            if (tanda.length < TOPE_FILAS) return todas;
        }
    }

    // Sin migracion_anexos.sql no hay anexo_de: se pide una vez y, si
    // falta, se sigue sin ella.
    const COLUMNAS_ARCHIVO = 'id, carpeta_id, subcarpeta_id, nombre, tipo, tamano, subido_por_usuario, fecha, orden, descargable_partes';
    let _hayAnexos = true;
    window.dbArchivosDeCarpeta = async (carpetaId) => {
        const pedir = (columnas) => traerTodas((desde, hasta) => nube.from('archivos')
            .select(columnas)
            .eq('carpeta_id', carpetaId)
            // Orden estable o las tandas repiten y saltan filas
            .order('id', { ascending: true })
            .range(desde, hasta));
        let data;
        try {
            data = await pedir(COLUMNAS_ARCHIVO + (_hayAnexos ? ', anexo_de' : ''));
        } catch (e) {
            if (!_hayAnexos || !/anexo_de/.test(String(e && e.message))) throw e;
            _hayAnexos = false;
            data = await pedir(COLUMNAS_ARCHIVO);
        }
        return data.map(a => ({
            id: a.id, carpetaId: a.carpeta_id, subcarpetaId: a.subcarpeta_id,
            nombre: a.nombre, tipo: a.tipo,
            tamano: a.tamano, subidoPor: a.subido_por_usuario,
            fecha: Date.parse(a.fecha), orden: a.orden,
            descargablePartes: a.descargable_partes !== false,
            anexoDe: a.anexo_de || null
        }));
    };

    /* Marca si las partes (cliente/acreedor) pueden descargar un archivo */
    /* ============ SUBCARPETAS ============
       Un nivel. Las maneja quien puede subir; las ven todos los de la carpeta. */
    window.subcarpetasListar = async (carpetaId) => {
        const { data, error } = await nube.from('subcarpetas')
            .select('*').eq('carpeta_id', carpetaId).order('orden').order('nombre');
        if (error) fallar(error);
        return (data || []).map(s => ({
            id: s.id, carpetaId: s.carpeta_id, nombre: s.nombre,
            orden: s.orden, creado: Date.parse(s.creado)
        }));
    };

    window.subcarpetaCrear = async (carpetaId, nombre) => {
        const ses = sesionNube();
        const limpio = String(nombre || '').trim().slice(0, 60);
        if (!limpio) throw new Error('La subcarpeta necesita un nombre.');
        const { data, error } = await nube.from('subcarpetas').insert({
            carpeta_id: carpetaId, nombre: limpio, creado_por: ses._id || null
        }).select('id').single();
        if (error) {
            if (String(error.message || '').includes('duplicate') ||
                String(error.code || '') === '23505') {
                throw new Error('Ya existe una subcarpeta con ese nombre en esta carpeta.');
            }
            fallar(error);
        }
        return data.id;
    };

    window.subcarpetaRenombrar = async (subcarpetaId, nombre) => {
        const limpio = String(nombre || '').trim().slice(0, 60);
        if (!limpio) throw new Error('La subcarpeta necesita un nombre.');
        const { error } = await nube.from('subcarpetas')
            .update({ nombre: limpio }).eq('id', subcarpetaId);
        if (error) {
            if (String(error.message || '').includes('duplicate') ||
                String(error.code || '') === '23505') {
                throw new Error('Ya existe una subcarpeta con ese nombre en esta carpeta.');
            }
            fallar(error);
        }
    };

    /* Al borrar la subcarpeta, los documentos vuelven a la raíz (set null). */
    window.subcarpetaEliminar = async (subcarpetaId) => {
        const { error } = await nube.from('subcarpetas').delete().eq('id', subcarpetaId);
        if (error) fallar(error);
    };

    /* Mueve un documento de subcarpeta (null = raíz) por archivo_mover().
       El update directo no está permitido. Los anexos se mudan con él. */
    window.archivoMover = async (archivoId, subcarpetaId) => {
        const { error } = await nube.rpc('archivo_mover',
            { p_archivo: Number(archivoId), p_subcarpeta: subcarpetaId ? Number(subcarpetaId) : null });
        if (error) fallar(error);
    };

    /* Solo el nombre visible; la base conserva la extensión y revisa el permiso. */
    window.archivoRenombrar = async (archivoId, nombre) => {
        const { data, error } = await nube.rpc('archivo_renombrar',
            { p_archivo: Number(archivoId), p_nombre: String(nombre || '') });
        if (error) fallar(error);
        return data;
    };

    /* Anexo de otro documento (1.1, 1.2) o principal con null. Valida la base. */
    window.archivoFijarAnexo = async (archivoId, padreId) => {
        const { error } = await nube.rpc('archivo_fijar_anexo',
            { p_archivo: Number(archivoId), p_padre: padreId ? Number(padreId) : null });
        if (error) fallar(error);
    };

    window.fijarDescargaPartes = async (archivoId, permitir) => {
        const { error } = await nube.rpc('fijar_descarga_partes', { archivo: archivoId, permitir: !!permitir });
        if (error) fallar(error);
    };

    /* Orden manual: solo la columna 'orden', validado en el servidor. */
    window.actualizarOrdenArchivos = async (carpetaId, ids) => {
        const { error } = await nube.rpc('actualizar_orden_archivos', {
            carpeta: carpetaId, ids
        });
        if (error) fallar(error);
    };

    /* Borra binarios y filas; devuelve cuántos había. Rutas de cien en
       cien: las peticiones gigantes se cortaban a medias. */
    window.dbEliminarArchivosDeCarpeta = async (carpetaId, alProgresar) => {
        // De mil en mil: si no, quedaban binarios sin fila.
        const data = await traerTodas((desde, hasta) => nube.from('archivos')
            .select('id, ruta_storage').eq('carpeta_id', carpetaId)
            .order('id', { ascending: true }).range(desde, hasta));
        const rutas = (data || []).map(a => a.ruta_storage).filter(Boolean);
        const POR_TANDA = 100;
        for (let i = 0; i < rutas.length; i += POR_TANDA) {
            await nube.storage.from('documentos').remove(rutas.slice(i, i + POR_TANDA));
            // Avance por tandas para que no parezca congelado
            if (alProgresar) alProgresar(Math.min(i + POR_TANDA, rutas.length), rutas.length);
        }
        const { error: errorFilas } = await nube.from('archivos')
            .delete().eq('carpeta_id', carpetaId);
        if (errorFilas) fallar(errorFilas);
        return (data || []).length;
    };

    /* Bitácora: el servidor pone el actor; solo el admin la lee. */
    window.registrarActividad = async (accion, objetivo, carpetaId) => {
        try {
            await nube.rpc('registrar_actividad', {
                p_accion: accion, p_objetivo: objetivo || '',
                p_carpeta: carpetaId || null
            });
        } catch (e) { /* la auditoría nunca rompe la acción principal */ }
    };

    window.listarActividad = async () => {
        const { data, error } = await nube.from('actividad')
            .select('usuario, nombre, rol, accion, objetivo, fecha, carpeta_id')
            .order('fecha', { ascending: false })
            .limit(300);
        if (error) fallar(error);
        return (data || []).map(a => ({
            usuario: a.usuario, nombre: a.nombre, rol: a.rol,
            accion: a.accion, objetivo: a.objetivo, fecha: Date.parse(a.fecha),
            carpetaId: a.carpeta_id || null
        }));
    };

    /* Actividad de una carpeta (admin y operador responsable). */
    window.listarActividadDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.from('actividad')
            .select('usuario, nombre, rol, accion, objetivo, fecha')
            .eq('carpeta_id', carpetaId)
            .order('fecha', { ascending: false })
            .limit(200);
        if (error) fallar(error);
        return (data || []).map(a => ({
            usuario: a.usuario, nombre: a.nombre, rol: a.rol,
            accion: a.accion, objetivo: a.objetivo, fecha: Date.parse(a.fecha)
        }));
    };

    /* ============ AUDIENCIAS (calendario de la carpeta, modo nube) ============ */
    window.audienciasListar = async (carpetaId) => {
        const { data, error } = await nube.from('audiencias')
            .select('id, carpeta_id, titulo, fecha, hora, enlace, descripcion, creado')
            .eq('carpeta_id', carpetaId)
            .order('fecha', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(a => ({
            id: a.id, carpetaId: a.carpeta_id, titulo: a.titulo,
            fecha: a.fecha, hora: a.hora, enlace: a.enlace, creado: Date.parse(a.creado)
        }));
    };
    window.audienciaGuardar = async (carpetaId, datos) => {
        const ses = sesionNube();
        const { error } = await nube.from('audiencias').insert({
            carpeta_id: carpetaId,
            titulo: datos.titulo || '',
            fecha: datos.fecha,
            hora: datos.hora || '',
            enlace: datos.enlace || '',
            descripcion: datos.descripcion || '',
            creado_por: ses._id || null
        });
        if (error) fallar(error);
    };
    window.audienciaEliminar = async (id) => {
        const { error } = await nube.from('audiencias').delete().eq('id', id);
        if (error) fallar(error);
    };

    /* ============ RECORDATORIOS (modo nube) ============
       Cada quien ve solo los suyos (RLS). */
    const _mapRecordatorio = (r) => ({
        id: r.id, carpetaId: r.carpeta_id, mensaje: r.mensaje,
        fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin,
        carpetaNombre: (r.carpetas && r.carpetas.nombre) || ''
    });
    window.recordatoriosListar = async (carpetaId) => {
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin')
            .eq('carpeta_id', carpetaId)
            .order('fecha_inicio', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };
    window.recordatorioGuardar = async (datos) => {
        const ses = sesionNube();
        if (datos.id) {
            const { error } = await nube.from('recordatorios').update({
                mensaje: datos.mensaje, fecha_inicio: datos.fechaInicio, fecha_fin: datos.fechaFin
            }).eq('id', datos.id);
            if (error) fallar(error);
            return;
        }
        const { error } = await nube.from('recordatorios').insert({
            perfil_id: ses._id, carpeta_id: datos.carpetaId,
            mensaje: datos.mensaje || '',
            fecha_inicio: datos.fechaInicio, fecha_fin: datos.fechaFin
        });
        if (error) fallar(error);
    };
    window.recordatorioEliminar = async (id) => {
        const { error } = await nube.from('recordatorios').delete().eq('id', id);
        if (error) fallar(error);
    };
    /* Todos mis recordatorios (RLS limita a los propios). */
    window.recordatoriosMios = async () => {
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin, carpetas(nombre)')
            .order('fecha_inicio', { ascending: true });
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };
    window.recordatoriosVigentes = async () => {
        const hoy = fechaISOLocal(new Date());
        const { data, error } = await nube.from('recordatorios')
            .select('id, carpeta_id, mensaje, fecha_inicio, fecha_fin, carpetas(nombre)')
            .lte('fecha_inicio', hoy)
            .gte('fecha_fin', hoy);
        if (error) fallar(error);
        return (data || []).map(_mapRecordatorio);
    };

    /* Asignados con correo, para avisar audiencias (valida el servidor). */
    window.asignadosDeCarpeta = async (carpetaId) => {
        const { data, error } = await nube.rpc('asignados_de_carpeta', { carpeta: carpetaId });
        if (error) fallar(error);
        return (data || []).map(p => ({
            id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol, correo: p.correo || ''
        }));
    };

    /* Archivos con contenido para el ZIP, en paralelo. */
    window.descargarBlobsDeCarpeta = async (carpetaId, alProgresar) => {
        // De mil en mil: si no, el ZIP salía incompleto
        const data = await traerTodas((desde, hasta) => nube.from('archivos')
            .select('id, nombre, ruta_storage, descargable_partes').eq('carpeta_id', carpetaId)
            .order('id', { ascending: true }).range(desde, hasta));
        // Personal: todo. Cliente y acreedor: solo lo permitido.
        const ses = sesionActual();
        let filas = data || [];
        if (ses && (ses.rol === 'cliente' || ses.rol === 'acreedor')) {
            filas = filas.filter(f => f.descargable_partes !== false);
        }
        const total = filas.length;
        let hechos = 0;
        return Promise.all(filas.map(async (fila) => {
            const { data: blob, error: errorBlob } = await nube.storage
                .from('documentos').download(fila.ruta_storage);
            if (errorBlob) fallar(errorBlob);
            hechos++;
            if (alProgresar) alProgresar(hechos, total);
            return { id: fila.id, nombre: fila.nombre, blob };
        }));
    };

    /* ============ MENSAJERÍA DEL TRÁMITE (modo nube) ============
       RLS por canal: cliente en 'cliente', acreedor en 'acreedor', personal en ambos. */
    window.mensajesListar = async (carpetaId, canal) => {
        const { data, error } = await nube.from('mensajes')
            .select('id, perfil_id, destinatario_id, autor_usuario, autor_nombre, rol, texto, fecha, archivo_nombre, archivo_tamano')
            .eq('carpeta_id', carpetaId)
            .eq('canal', canal)
            .order('fecha', { ascending: true })
            .limit(500);
        if (error) fallar(error);
        return (data || []).map(m => ({
            id: m.id,
            perfilId: m.perfil_id || null,
            destinatarioId: m.destinatario_id || null,
            autorUsuario: m.autor_usuario, autorNombre: m.autor_nombre,
            rol: m.rol, texto: m.texto, fecha: Date.parse(m.fecha),
            archivoNombre: m.archivo_nombre || '', archivoTamano: m.archivo_tamano || 0
        }));
    };
    /* destinatarioId: acreedor puntual o null = todos */
    window.mensajesGuardar = async (carpetaId, canal, texto, archivo, destinatarioId) => {
        const ses = sesionNube();
        // Adjunto: primero a Storage (chat/<carpeta>/<canal>/...), luego el mensaje.
        let ruta = '', nombre = '', tamano = 0, tipo = '';
        if (archivo) {
            ruta = 'chat/' + carpetaId + '/' + canal + '/' + Date.now() + '_' + limpiarNombre(archivo.name);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, archivo, { contentType: archivo.type || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            nombre = archivo.name; tamano = archivo.size; tipo = archivo.type || '';
        }
        const { error } = await nube.from('mensajes').insert({
            carpeta_id: carpetaId, canal, perfil_id: ses._id || null,
            destinatario_id: destinatarioId || null,
            autor_usuario: ses.usuario || '', autor_nombre: ses.nombre || ses.usuario || '',
            rol: ses.rol || '', texto: texto || '',
            archivo_nombre: nombre, archivo_ruta: ruta,
            archivo_tamano: tamano, archivo_tipo: tipo
        });
        if (error) fallar(error);
    };

    /* Adjunto de chat: ruta por id y descarga de Storage (RLS por canal). */
    window.descargarAdjuntoChat = async (mensajeId) => {
        const { data, error } = await nube.from('mensajes')
            .select('archivo_ruta, archivo_nombre')
            .eq('id', mensajeId).maybeSingle();
        if (error) fallar(error);
        if (!data || !data.archivo_ruta) throw new Error('El mensaje no tiene adjunto.');
        const { data: blob, error: errorBlob } = await nube.storage
            .from('documentos').download(data.archivo_ruta);
        if (errorBlob) fallar(errorBlob);
        return { nombre: data.archivo_nombre, blob };
    };

    /* Cambia la descripción (admin u operador responsable). */
    window.actualizarDescripcionCarpeta = async (carpetaId, descripcion) => {
        const { error } = await nube.rpc('actualizar_descripcion', {
            carpeta: carpetaId,
            nueva_descripcion: descripcion
        });
        if (error) fallar(error);
    };

    /* Crear usuario por la Edge Function crear-usuario (service_role solo en
       el servidor). El registro público queda apagado. */
    /* ============ NOTARÍAS ============
       Mismos nombres que en db.js. Quién entra a qué notaría lo decide la base. */

    /* uuid a partir del nombre de usuario */
    async function _idDePerfil(usuario) {
        const { data, error } = await nube.from('perfiles')
            .select('id').eq('usuario', usuario).maybeSingle();
        if (error) fallar(error);
        if (!data) throw new Error('El usuario no existe.');
        return data.id;
    }

    /* Notarías de la sesión, con carpetas activas de cada una */
    window.misNotarias = async () => {
        const { data, error } = await nube.rpc('mis_notarias');
        if (error) fallar(error);
        return (data || []).map(n => ({
            id: n.id, nombre: n.nombre, ciudad: n.ciudad,
            activa: n.activa !== false,
            carpetas: Number(n.carpetas || 0),
            // Procesos vencidos o por vencer, para escoger oficina
            porVencer: Number(n.por_vencer || 0)
        }));
    };

    /* Cifras por oficina (migracion_tablero_notarias.sql). null si la función
       no existe todavía; otros errores sí se lanzan. */
    window.tableroNotarias = async () => {
        const { data, error } = await nube.rpc('tablero_notarias');
        if (error) {
            const falta = error.code === 'PGRST202' || error.code === '42883' ||
                          /could not find the function|does not exist/i.test(error.message || '');
            if (falta) return null;
            fallar(error);
        }
        const num = (v) => (v === null || v === undefined) ? null : Number(v);
        return (data || []).map(t => ({
            notariaId: t.notaria_id,
            carpetas: num(t.carpetas_activas) || 0,
            porVencer: num(t.por_vencer) || 0,
            vencidos: num(t.vencidos) || 0,
            carpetasTotal: num(t.carpetas_total),
            documentos: num(t.documentos),
            pesoBytes: num(t.peso_bytes)
        }));
    };

    /* Todas las notarías visibles (formularios del admin) */
    window.notariasListar = async () => {
        const { data, error } = await nube.from('notarias')
            .select('id, nombre, ciudad, activa').order('ciudad');
        if (error) fallar(error);
        return (data || []).map(n => ({
            id: n.id, nombre: n.nombre, ciudad: n.ciudad, activa: n.activa !== false
        }));
    };

    window.notariaCrear = async (nombre, ciudad) => {
        const { data, error } = await nube.rpc('notaria_crear', {
            p_nombre: nombre, p_ciudad: ciudad
        });
        if (error) fallar(error);
        return data;
    };

    window.notariaEditar = async (id, nombre, ciudad, activa) => {
        const { error } = await nube.rpc('notaria_editar', {
            p_id: id, p_nombre: nombre || null,
            p_ciudad: ciudad || null,
            p_activa: (activa === undefined ? null : activa)
        });
        if (error) fallar(error);
    };

    /* Reemplaza la lista de notarías de un usuario */
    window.perfilNotariasFijar = async (usuario, ids) => {
        const perfil = await _idDePerfil(usuario);
        const { error } = await nube.rpc('perfil_notarias_fijar', {
            p_perfil: perfil, p_notarias: (ids || []).map(Number)
        });
        if (error) fallar(error);
    };

    window.notariasDePerfil = async (usuario) => {
        const perfil = await _idDePerfil(usuario);
        const { data, error } = await nube.rpc('notarias_de_perfil', { p_perfil: perfil });
        if (error) fallar(error);
        return (data || []).map(x => (typeof x === 'object' ? x.notarias_de_perfil : x)).map(Number);
    };

    window.carpetaFijarNotaria = async (carpetaId, notariaId) => {
        const { error } = await nube.rpc('carpeta_fijar_notaria', {
            p_carpeta: carpetaId, p_notaria: notariaId
        });
        if (error) fallar(error);
    };

    window.crearUsuarioDatos = async (usuario, nombre, rol, clave, correo, notarias) => {
        const { data, error } = await nube.functions.invoke('crear-usuario', {
            body: {
                usuario, nombre, rol, clave, correo,
                notarias: (notarias || []).map(Number),
                dominio: cfg.DOMINIO_USUARIOS
            }
        });
        if (error) {
            let detalle = '';
            try { const r = await error.context.json(); detalle = r && r.error; } catch (_) { /* sin cuerpo */ }
            throw new Error(detalle ||
                'No se pudo crear el usuario. Verifica que la Edge Function "crear-usuario" esté desplegada (ver servidor/INSTALAR-EN-SERVIDOR.md).');
        }
        if (data && data.error) throw new Error(data.error);
        return '';
    };

    /* Restablecer la clave de otro: Edge Function restablecer-clave, solo admin. */
    /* Guarda la contraseña que el admin acaba de asignar. */
    window.credencialGuardar = async (usuario, clave) => {
        const { error } = await nube.rpc('credencial_fijar',
            { p_usuario: usuario, p_clave: clave });
        if (error) fallar(error);
    };

    window.restablecerClave = async (usuario, nuevaClave) => {
        if (sesionNube().rol !== 'administrador') {
            throw new Error('Solo el administrador puede restablecer contraseñas.');
        }
        if (!usuario || !usuario._id) throw new Error('No se encontró el identificador del usuario.');
        const { data, error } = await nube.functions.invoke('restablecer-clave', {
            body: { user_id: usuario._id, password: nuevaClave }
        });
        if (error) {
            let detalle = '';
            try { const r = await error.context.json(); detalle = r && r.error; } catch (_) { /* sin cuerpo */ }
            throw new Error(detalle ||
                'No se pudo restablecer la contraseña. Verifica que la Edge Function "restablecer-clave" esté desplegada (ver servidor/INSTALAR-EN-SERVIDOR.md).');
        }
        if (data && data.error) throw new Error(data.error);
    };

    /* ============ SEMÁFOROS (modo nube) ============
       Color y días restantes vienen del servidor. Las escrituras van por
       funciones que validan permisos y plazos. */
    const _mapProceso = (p) => ({
        id: p.id, carpetaId: p.carpeta_id, nombre: p.nombre,
        dias: p.dias_habiles_limite, orden: p.orden,
        completado: p.completado,
        fechaInicio: p.fecha_inicio_proceso,
        fechaInicioHabil: p.fecha_inicio_proceso_habil,
        fechaVencimiento: p.fecha_vencimiento_habil,
        fechaCompletado: p.fecha_completado,
        pausado: p.pausado,
        diasRestantesAlPausar: p.dias_restantes_al_pausar,
        semaforoManual: p.semaforo_manual || null,
        semaforo: p.semaforo,                 // color del servidor
        diasRestantes: (p.dias_restantes === null || p.dias_restantes === undefined) ? null : p.dias_restantes,
        creado: Date.parse(p.creado)
    });
    window.procesosListar = async (carpetaId) => {
        const { data, error } = await nube.rpc('listar_procesos', { carpeta: carpetaId });
        if (error) fallar(error);
        return (data || []).map(_mapProceso);
    };
    window.procesosTodos = async () => {
        const { data, error } = await nube.rpc('listar_procesos', { carpeta: null });
        if (error) fallar(error);
        return (data || []).map(_mapProceso);
    };
    window.procesoCrear = async (carpetaId, datos) => {
        const { data, error } = await nube.rpc('crear_proceso_tramite', {
            carpeta: carpetaId, p_nombre: datos.nombre,
            p_dias: datos.dias, p_orden: datos.orden || null
        });
        if (error) fallar(error);
        return data;
    };
    window.procesoCompletar = async (procesoId) => {
        const { error } = await nube.rpc('completar_proceso', { proceso: procesoId });
        if (error) fallar(error);
    };
    window.procesoEliminar = async (procesoId) => {
        const { error } = await nube.rpc('eliminar_proceso', { proceso: procesoId });
        if (error) fallar(error);
    };
    window.tramitePausar = async (carpetaId) => {
        const { error } = await nube.rpc('pausar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    window.tramiteReactivar = async (carpetaId) => {
        const { error } = await nube.rpc('reactivar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    /* Conteo del trámite: 60 días hábiles (90 con prórroga) */
    window.tramiteIniciar = async (carpetaId, fecha) => {
        const { error } = await nube.rpc('iniciar_tramite', {
            carpeta: carpetaId, p_fecha: fecha || null
        });
        if (error) fallar(error);
    };
    window.tramiteProrroga = async (carpetaId) => {
        const { error } = await nube.rpc('aplicar_prorroga', { carpeta: carpetaId });
        if (error) fallar(error);
    };
    /* Fin de trámite: solo admin (valida el servidor) */
    window.tramiteFinalizar = async (carpetaId) => {
        const { error } = await nube.rpc('finalizar_tramite', { carpeta: carpetaId });
        if (error) fallar(error);
    };

    /* Trámites cerrados que aún se pueden ver y días para descargar. De paso
       desactiva los vencidos. */
    window.avisosFinTramite = async () => {
        try { await nube.rpc('aplicar_desactivaciones_automaticas'); } catch (e) { /* no rompe el ingreso */ }
        const { data, error } = await nube.rpc('avisos_fin_tramite');
        if (error) { console.warn('No se pudieron cargar los avisos de cierre:', error.message); return []; }
        return (data || []).map(a => ({
            carpetaId: a.carpeta_id,
            nombre: a.nombre,
            fechaFin: a.fecha_fin,
            fechaDesactivacion: a.fecha_desactivacion,
            diasRestantes: Number(a.dias_habiles_restantes || 0),
            activa: !!a.activa
        }));
    };

    /* ============ PRESENCIA Y ÚLTIMA CONEXIÓN (modo nube) ============ */
    window.registrarConexion = async () => {
        try { await nube.rpc('registrar_conexion'); } catch (e) { /* no rompe nada */ }
    };
    /* En línea: cada sesión late cada minuto y solo el admin pregunta quién
       latió en los últimos dos (migracion_presencia_privada.sql).
       Sin la migración, todos salen "Desconectado". */
    let _presencia = null;
    window.presenciaIniciar = (alCambiar) => {
        const ses = sesionNube();
        if (!ses.usuario) return null;
        // Al entrar y al cambiar de notaría; se paran los relojes anteriores
        if (_presencia) _presencia.cerrar();
        const latir = () => { nube.rpc('latido').then(() => {}, () => {}); };
        latir();
        const relojLatido = setInterval(latir, 60000);

        let relojConsulta = null;
        if (ses.rol === 'administrador') {
            const consultar = async () => {
                const { data, error } = await nube.rpc('conectados');
                if (error) return;
                alCambiar(new Set((data || []).map(x => (typeof x === 'object' ? x.conectados : x))));
            };
            consultar();
            relojConsulta = setInterval(consultar, 30000);
        }
        _presencia = {
            cerrar: () => { clearInterval(relojLatido); clearInterval(relojConsulta); }
        };
        return _presencia;
    };
    /* Corrección del admin: solo los campos que cambian ('' = automático) */
    window.procesoEditarAdmin = async (procesoId, cambios) => {
        const { error } = await nube.rpc('editar_proceso_admin', {
            proceso: procesoId,
            p_nombre: cambios.nombre ?? null,
            p_dias: cambios.dias ?? null,
            p_vencimiento: cambios.vencimiento ?? null,
            p_completado: (typeof cambios.completado === 'boolean') ? cambios.completado : null,
            p_semaforo: cambios.semaforo ?? null
        });
        if (error) fallar(error);
    };

    /* ============ CHAT DE SOPORTE (admin, operador y monitor, modo nube) ============
       Un hilo por operador o monitor. RLS: puede_soporte. */
    window.soporteOperadores = async () => {
        const { data, error } = await nube.from('perfiles')
            .select('id, usuario, nombre, rol, activo')
            .in('rol', ['operador', 'monitor']).eq('activo', true)
            .order('nombre');
        if (error) fallar(error);
        return (data || []).map(p => ({ _id: p.id, usuario: p.usuario, nombre: p.nombre, rol: p.rol }));
    };
    window.soporteMensajes = async (operadorId) => {
        const { data, error } = await nube.from('mensajes_soporte')
            .select('id, operador_id, autor_id, autor_nombre, rol, texto, leido, fecha, archivo_nombre, archivo_tamano')
            .eq('operador_id', operadorId)
            .order('fecha', { ascending: true })
            .limit(500);
        if (error) fallar(error);
        return (data || []).map(m => ({
            id: m.id, operadorId: m.operador_id, autorId: m.autor_id,
            autorNombre: m.autor_nombre, rol: m.rol, texto: m.texto,
            leido: m.leido, fecha: Date.parse(m.fecha),
            archivoNombre: m.archivo_nombre || '', archivoTamano: m.archivo_tamano || 0
        }));
    };
    /* Adjunto a Storage en soporte/<operador>/...; aquí solo metadatos. */
    window.soporteEnviar = async (operadorId, texto, archivo) => {
        const ses = sesionNube();
        let ruta = '', nombre = '', tamano = 0, tipo = '';
        if (archivo) {
            ruta = 'soporte/' + operadorId + '/' + Date.now() + '_' + limpiarNombre(archivo.name);
            const { error: errorSube } = await nube.storage.from('documentos')
                .upload(ruta, archivo, { contentType: archivo.type || 'application/octet-stream' });
            if (errorSube) fallar(errorSube);
            nombre = archivo.name; tamano = archivo.size; tipo = archivo.type || '';
        }
        const { error } = await nube.from('mensajes_soporte').insert({
            operador_id: operadorId, autor_id: ses._id,
            autor_nombre: ses.nombre || ses.usuario || '',
            rol: ses.rol || '', texto: texto || '',
            archivo_nombre: nombre, archivo_ruta: ruta,
            archivo_tamano: tamano, archivo_tipo: tipo
        });
        if (error) fallar(error);
    };
    /* Descarga el adjunto de un mensaje de soporte (RLS valida el hilo) */
    window.descargarAdjuntoSoporte = async (mensajeId) => {
        const { data, error } = await nube.from('mensajes_soporte')
            .select('archivo_ruta, archivo_nombre').eq('id', mensajeId).maybeSingle();
        if (error) fallar(error);
        if (!data || !data.archivo_ruta) throw new Error('El mensaje no tiene adjunto.');
        const { data: blob, error: errorBlob } = await nube.storage
            .from('documentos').download(data.archivo_ruta);
        if (errorBlob) fallar(errorBlob);
        return { nombre: data.archivo_nombre, blob };
    };
    window.marcarLeidosSoporte = async (operadorId) => {
        const { error } = await nube.rpc('marcar_leidos_soporte', { operador: operadorId });
        if (error) fallar(error);
    };
    window.marcarLeidosCanal = async (carpetaId, canal) => {
        const { error } = await nube.rpc('marcar_leidos_de_canal', { carpeta: carpetaId, canal_chat: canal });
        if (error) fallar(error);
    };
    window.chatsNoLeidos = async () => {
        const { data, error } = await nube.rpc('no_leidos_chats');
        if (error) fallar(error);
        return (data || []).map(f => ({ carpetaId: f.carpeta_id, canal: f.canal, noLeidos: Number(f.no_leidos) }));
    };
    window.soporteNoLeidos = async () => {
        const { data, error } = await nube.rpc('no_leidos_soporte');
        if (error) fallar(error);
        return (data || []).map(f => ({ operadorId: f.operador_id, noLeidos: Number(f.no_leidos) }));
    };

    /* Tiempo real de mensajes nuevos. Realtime respeta la RLS. */
    window.suscribirMensajesNuevos = (alLlegar) => {
        try {
            return nube.channel('portal-mensajes')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes' },
                    (x) => alLlegar('carpeta', x.new))
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes_soporte' },
                    (x) => alLlegar('soporte', x.new))
                .subscribe();
        } catch (e) { return null; }
    };

    /* ============ LLAMADAS DE SOPORTE (WebRTC, modo nube) ============
       Solo el admin crea la llamada. Señalización por Realtime broadcast. */
    /* Canal de la llamada: nombre al azar que pone la base y solo leen los
       dos participantes (antes era "llamada-<número>", adivinable). */
    const _canalDeLlamada = {};
    window.llamadaCrear = async (destinoId) => {
        const ses = sesionNube();
        const fila = { iniciador: ses._id, destino: destinoId };
        let { data, error } = await nube.from('llamadas_soporte')
            .insert(fila).select('id, canal').single();
        // Migración vieja: sin columna canal
        if (error && /canal/.test(String(error.message))) {
            ({ data, error } = await nube.from('llamadas_soporte')
                .insert(fila).select('id').single());
        }
        if (error) fallar(error);
        if (data.canal) _canalDeLlamada[data.id] = data.canal;
        return data.id;
    };
    window.llamadaActualizar = async (llamadaId, estado) => {
        const { error } = await nube.from('llamadas_soporte')
            .update({ estado }).eq('id', llamadaId);
        if (error) fallar(error);
    };
    /* alCambiar: la llamada dejó de sonar antes de contestar (el admin colgó) */
    window.suscribirLlamadasEntrantes = (alSonar, alCambiar) => {
        const ses = sesionNube();
        if (!ses._id) return null;
        try {
            return nube.channel('portal-llamadas')
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'llamadas_soporte',
                    filter: 'destino=eq.' + ses._id
                }, (x) => {
                    if (x.new && x.new.canal) _canalDeLlamada[x.new.id] = x.new.canal;
                    alSonar(x.new);
                })
                .on('postgres_changes', {
                    event: 'UPDATE', schema: 'public', table: 'llamadas_soporte',
                    filter: 'destino=eq.' + ses._id
                }, (x) => { if (alCambiar && x.new) alCambiar(x.new); })
                .subscribe();
        } catch (e) { return null; }
    };
    /* Canal de señalización de una llamada */
    window.canalSenalizacion = (llamadaId, alRecibir) => {
        const nombre = 'llamada-' + (_canalDeLlamada[llamadaId] || llamadaId);
        const canal = nube.channel(nombre, { config: { broadcast: { self: false } } });
        canal.on('broadcast', { event: 'sdp' }, (m) => alRecibir(m.payload)).subscribe();
        return {
            enviar: (payload) => canal.send({ type: 'broadcast', event: 'sdp', payload }),
            cerrar: () => { try { nube.removeChannel(canal); } catch (e) {} }
        };
    };

    /* ============ NOTIFICACIONES (campana, modo nube) ============
       Cada quien lee y marca solo las suyas. */
    /* Avisos de la notaría abierta. Los que no son de ninguna oficina
       (soporte, ingreso, clave) se ven siempre. null = todas. */
    window.notificacionesListar = async (notaria) => {
        let consulta = nube.from('notificaciones')
            .select('id, tipo, mensaje, carpeta_id, referencia_id, leido, fecha, notaria_id');
        if (notaria !== null && notaria !== undefined && notaria !== '') {
            // Number() a propósito: va en un filtro de texto
            consulta = consulta.or('notaria_id.is.null,notaria_id.eq.' + Number(notaria));
        }
        const { data, error } = await consulta
            .order('fecha', { ascending: false })
            .limit(50);
        if (error) fallar(error);
        return (data || []).map(n => ({
            id: n.id, tipo: n.tipo, mensaje: n.mensaje,
            carpetaId: n.carpeta_id, referenciaId: n.referencia_id,
            notariaId: n.notaria_id,
            leido: n.leido, fecha: Date.parse(n.fecha)
        }));
    };
    /* Espacio del servidor (migracion_almacenamiento_ver.sql):
       { ... }  la medición
       null     no eres admin o aún no hay medición
       error    se muestra, no se inventa un número */
    /* Rendimiento (solo admin). Pasa el código de error: 42501 sin permiso,
       PGRST202 falta la migración. */
    window.metricasWebLeer = async (desde, hasta) => {
        const { data, error } = await nube.rpc('metricas_web', { p_desde: desde, p_hasta: hasta });
        if (error) throw error;
        return data;
    };
    // Intento fallido de una cuenta. La base solo lo guarda si la cuenta existe.
    window.registrarIntentoFallido = (usuario) =>
        nube.rpc('registrar_intento_fallido', { p_usuario: String(usuario || '').slice(0, 80) }).then(() => {}, () => {});
    // Cuentas con intentos fallidos en el rango (solo admin)
    window.intentosFallidosLeer = async (desde, hasta) => {
        const { data, error } = await nube.rpc('intentos_fallidos_web', { p_desde: desde, p_hasta: hasta });
        if (error) throw error;
        return data || [];
    };
    window.metricasWebGuardarMetas = async (metas) => {
        const { error } = await nube.rpc('guardar_metas_web', { p_metas: metas });
        if (error) throw error;
    };

    window.almacenamientoLeer = async () => {
        const { data, error } = await nube.rpc('almacenamiento_ver');
        if (error) fallar(error);
        const fila = Array.isArray(data) ? data[0] : data;
        if (!fila || !Number(fila.total_bytes)) return null;
        return {
            totalBytes: Number(fila.total_bytes),
            usadoBytes: Number(fila.usado_bytes),
            libreBytes: Number(fila.libre_bytes),
            docsBytes:  Number(fila.docs_bytes),
            medido:     Date.parse(fila.medido)
        };
    };

    window.notificacionesMarcarLeidas = async (ids) => {
        const { error } = await nube.rpc('marcar_notificaciones_leidas', { ids: ids || null });
        if (error) fallar(error);
    };
    /* Borra una notificación propia */
    window.notificacionEliminar = async (id) => {
        const { error } = await nube.from('notificaciones').delete().eq('id', id);
        if (error) fallar(error);
    };

    /* Vacía la campana (las de la notaría abierta, o todas). RLS solo deja
       borrar las propias. */
    window.notificacionesLimpiar = async (notaria) => {
        let q = nube.from('notificaciones').delete().eq('destinatario_id', sesionNube()._id);
        if (notaria) q = q.eq('notaria_id', notaria);
        const { error } = await q;
        if (error) fallar(error);
    };
    /* Solo admin: avisos de vencidos (una vez por proceso) */
    window.notificacionesGenerarVencidos = async () => {
        const { error } = await nube.rpc('generar_notificaciones_vencidos');
        if (error) fallar(error);
    };
    /* Aviso de ingreso en la campana (lo decide el servidor) */
    window.notificarMiIngreso = async () => {
        try { await nube.rpc('notificar_mi_ingreso'); } catch (e) { /* no rompe el ingreso */ }
    };
    /* ============ AVISOS EN EL CELULAR (solo admin) ============
       La llave pública sale de la función avisos-push; el resto, de las
       funciones push_* de la base. */
    window.avisosPushClave = async () => {
        const { data, error } = await nube.functions.invoke('avisos-push', { method: 'GET' });
        if (error || !data || !data.publica) {
            const e = new Error('El servidor todavía no tiene configurados los avisos.');
            e.configurar = true;
            throw e;
        }
        return data.publica;
    };
    window.avisosPushSuscribir = async (sub, categorias) => {
        const j = sub.toJSON();
        const { error } = await nube.rpc('push_suscribir', {
            p_endpoint: j.endpoint, p_p256dh: (j.keys || {}).p256dh || '', p_auth: (j.keys || {}).auth || '',
            p_dispositivo: _dispositivo(), p_categorias: categorias || null
        });
        if (error) fallar(error);
    };
    window.avisosPushQuitar = async (endpoint) => {
        const { error } = await nube.rpc('push_quitar', { p_endpoint: endpoint });
        if (error) fallar(error);
    };
    window.avisosPushCategorias = async (endpoint, categorias) => {
        const { error } = await nube.rpc('push_categorias', { p_endpoint: endpoint, p_categorias: categorias });
        if (error) fallar(error);
    };
    window.avisosPushProbar = async () => {
        const { data, error } = await nube.rpc('push_probar');
        if (error) fallar(error);
        return data;
    };
    // Este equipo en la base (null si no está): categorías y cómo salió el último
    window.avisosPushMio = async (endpoint) => {
        const { data, error } = await nube.from('suscripciones_push')
            .select('categorias, dispositivo, ultimo_envio, ultimo_estado')
            .eq('endpoint', endpoint).maybeSingle();
        if (error) fallar(error);
        return data ? {
            categorias: data.categorias || [], dispositivo: data.dispositivo || '',
            ultimoEnvio: data.ultimo_envio ? Date.parse(data.ultimo_envio) : null,
            ultimoEstado: data.ultimo_estado
        } : null;
    };

    /* Olvidé mi contraseña: cualquiera deja la solicitud; el servidor avisa a los admins. */
    window.solicitarRestablecimiento = async (usuario) => {
        const { error } = await nube.rpc('solicitar_restablecimiento', { p_usuario: usuario });
        if (error) fallar(error);
    };
    /* Solicitudes pendientes (solo admin) */
    window.solicitudesClaveListar = async () => {
        const { data, error } = await nube.from('solicitudes_clave')
            .select('id, usuario, estado, fecha')
            .eq('estado', 'pendiente')
            .order('fecha', { ascending: false });
        if (error) fallar(error);
        return (data || []).map(s => ({ id: s.id, usuario: s.usuario, fecha: Date.parse(s.fecha) }));
    };
    window.solicitudClaveResolver = async (id) => {
        const { error } = await nube.rpc('resolver_solicitud_clave', { solicitud: id });
        if (error) fallar(error);
    };
    window.suscribirNotificaciones = (alLlegar) => {
        const ses = sesionNube();
        if (!ses._id) return null;
        try {
            return nube.channel('portal-notificaciones')
                .on('postgres_changes', {
                    event: 'INSERT', schema: 'public', table: 'notificaciones',
                    filter: 'destinatario_id=eq.' + ses._id
                }, (x) => alLlegar(x.new))
                .subscribe();
        } catch (e) { return null; }
    };

    /* ============ CONSENTIMIENTO DE DATOS (modo nube) ============ */
    window.perfilPropio = async () => {
        const ses = sesionNube();
        if (!ses._id) return null;
        const { data, error } = await nube.from('perfiles')
            .select('usuario, nombre, rol, primer_login').eq('id', ses._id).maybeSingle();
        if (error) fallar(error);
        return data ? {
            usuario: data.usuario, nombre: data.nombre, rol: data.rol,
            primerLogin: data.primer_login !== false
        } : null;
    };
    window.consentimientoAceptar = async (version) => {
        const { error } = await nube.rpc('aceptar_consentimiento', { p_version: version || '1.0' });
        if (error) fallar(error);
    };
    window.consentimientosListar = async () => {
        const { data, error } = await nube.rpc('listar_consentimientos');
        if (error) fallar(error);
        return (data || []).map(c => ({
            usuario: c.usuario, nombre: c.nombre, rol: c.rol,
            fecha: Date.parse(c.fecha_aceptacion), version: c.version_politica
        }));
    };

    /* ============ SESIÓN HUÉRFANA ============ */
    // Si Supabase ya cerró la sesión, el espejo local deja ver un portal
    // vacío. Mejor volver al ingreso.
    document.addEventListener('DOMContentLoaded', async () => {
        if (!sesionActual()) return;
        // La página de ingreso se reconoce por su formulario (index.html o /portal/).
        if (document.getElementById('form-login')) return;
        const { data } = await nube.auth.getSession();
        if (!data.session) {
            localStorage.removeItem(CLAVE_SESION);
            location.replace('./');
        }
    });
})();
