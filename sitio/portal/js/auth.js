/*! Portal Documental · sesión y permisos
  Andrés Madrid · andresmadrid.vercel.app */
const CLAVE_SESION = 'portal_sesion';
const DURACION_SESION = 8 * 60 * 60 * 1000;           // 8 horas: una jornada
const DURACION_RECORDADA = 30 * 24 * 60 * 60 * 1000;  // 30 días: "mantener la sesión"

/* 8 h por defecto: equipos compartidos en la oficina quedan cerrados al día siguiente. */
function duracionDe(sesion) {
    return (sesion && sesion.recordar) ? DURACION_RECORDADA : DURACION_SESION;
}

const ETIQUETAS_ROL = {
    administrador: 'Administrador',
    monitor:       'Monitor',
    operador:      'Operador',
    cliente:       'Cliente',
    acreedor:      'Acreedor'
};

/* Hash SHA-256 en modo práctica. En la nube lo hace Supabase con bcrypt. */
async function protegerClave(texto) {
    try {
        const datos = new TextEncoder().encode(texto);
        const hash = await crypto.subtle.digest('SHA-256', datos);
        const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
        return 'sha256:' + hex;
    } catch (e) {
        return 'plano:' + texto;
    }
}

/* Acepta también el formato viejo en texto plano (cuentas anteriores al hash). */
async function verificarClave(guardada, ingresada) {
    if (typeof guardada !== 'string') return false;
    if (guardada.startsWith('plano:')) return guardada === 'plano:' + ingresada;
    return guardada === await protegerClave(ingresada);
}

/* Sesión vigente o null (si venció, se borra).
   Con "mantener la sesión" el plazo corre desde el último uso. La marca se
   reescribe máximo una vez por hora. */
const REFRESCO_MARCA = 60 * 60 * 1000;

function sesionActual() {
    try {
        const sesion = JSON.parse(localStorage.getItem(CLAVE_SESION));
        if (!sesion || !sesion.usuario) return null;
        const edad = Date.now() - sesion.ts;
        if (edad > duracionDe(sesion)) {
            localStorage.removeItem(CLAVE_SESION);
            return null;
        }
        if (sesion.recordar && edad > REFRESCO_MARCA) {
            sesion.ts = Date.now();
            try { localStorage.setItem(CLAVE_SESION, JSON.stringify(sesion)); } catch (e) { /* cuota llena: la sesión sigue */ }
        }
        return sesion;
    } catch (e) {
        return null;
    }
}

/* Guarda la sesión con su hora, para poder caducarla. */
function guardarSesion(u, recordar) {
    const sesion = {
        usuario: u.usuario,
        nombre: u.nombre,
        rol: u.rol,
        recordar: !!recordar,
        ts: Date.now()
    };
    // uuid del perfil: solo existe en la nube.
    const id = u._id || u.id;
    if (id) sesion._id = id;
    // Id de esta sesión. Si el servidor tiene otra vigente, este equipo fue
    // desplazado por un ingreso posterior y se cierra.
    if (u.sid) sesion.sid = u.sid;
    localStorage.setItem(CLAVE_SESION, JSON.stringify(sesion));
}

/* Cierra la sesión y vuelve al ingreso. */
function cerrarSesion(destino) {
    localStorage.removeItem(CLAVE_SESION);
    location.href = destino || './';
}

/* Valida usuario y contraseña y abre la sesión si la cuenta está activa. */
async function iniciarSesion(usuario, clave, recordar) {
    const nombreUsuario = String(usuario || '').trim().toLowerCase();
    if (!nombreUsuario || !clave) {
        return { error: 'Escribe el usuario y la contraseña.' };
    }
    const registro = await dbObtener('usuarios', nombreUsuario);
    if (!registro || !(await verificarClave(registro.clave, clave))) {
        return { error: 'Usuario o contraseña incorrectos.' };
    }
    if (registro.activo === false) {
        return { error: 'Tu usuario está desactivado. Comunícate con la administración del portal.' };
    }
    guardarSesion(registro, recordar);
    return { usuario: registro };
}
