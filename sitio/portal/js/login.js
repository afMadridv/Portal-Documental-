/*! Legajo · inicio de sesión
  Andrés Madrid · andresmadrid.vercel.app */
document.addEventListener('DOMContentLoaded', async () => {
    const formulario = document.getElementById('form-login');
    const mensajeError = document.getElementById('mensaje-error');
    const botonEntrar = document.getElementById('boton-entrar');

    // Si el portal cerró la sesión (cuenta borrada o inactiva), se dice por qué.
    try {
        const motivo = sessionStorage.getItem('portal_motivo_salida');
        if (motivo) {
            sessionStorage.removeItem('portal_motivo_salida');
            mensajeError.textContent = motivo;
            mensajeError.hidden = false;
        }
    } catch (e) { /* sin sessionStorage simplemente no se explica */ }

    // Olvidé mi contraseña: queda en solicitudes_clave y le llega al admin.
    const botonOlvide = document.getElementById('olvide-clave');
    const dialogo = document.getElementById('dialogo-olvide');
    if (botonOlvide && dialogo) {
        const campo = document.getElementById('olvide-usuario');
        const mensaje = document.getElementById('olvide-mensaje');
        botonOlvide.addEventListener('click', () => {
            campo.value = document.getElementById('campo-usuario').value.trim().toLowerCase();
            mensaje.hidden = true;
            dialogo.showModal();
            campo.focus();
        });
        document.getElementById('olvide-cancelar').addEventListener('click', () => dialogo.close());
        document.getElementById('olvide-enviar').addEventListener('click', async () => {
            const usuario = campo.value.trim().toLowerCase();
            if (!usuario) { campo.focus(); return; }
            const boton = document.getElementById('olvide-enviar');
            boton.disabled = true;
            try {
                if (typeof solicitarRestablecimiento === 'function') {
                    await solicitarRestablecimiento(usuario);
                }
            } catch (e) { /* siempre la misma respuesta */ }
            boton.disabled = false;
            // Mismo mensaje exista o no el usuario.
            mensaje.textContent = 'Solicitud enviada. Si el usuario existe, la administración ' +
                'te asignará una contraseña nueva y te la hará llegar.';
            mensaje.hidden = false;
            campo.value = '';
            setTimeout(() => dialogo.close(), 3500);
        });
    }

    // Mostrar / ocultar contraseña
    const campoClave = document.getElementById('campo-clave');
    const botonVerClave = document.getElementById('ver-clave');
    if (botonVerClave && campoClave) {
        botonVerClave.addEventListener('click', () => {
            const oculta = campoClave.type === 'password';
            campoClave.type = oculta ? 'text' : 'password';
            botonVerClave.innerHTML = icono(oculta ? 'ojo-cerrado' : 'ver');
            botonVerClave.setAttribute('aria-pressed', String(oculta));
            botonVerClave.setAttribute('aria-label', oculta ? 'Ocultar contraseña' : 'Mostrar contraseña');
            campoClave.focus();
        });
    }

    // Primero el formulario: si la siembra falla, el ingreso sigue andando.
    formulario.addEventListener('submit', async (evento) => {
        evento.preventDefault();
        mensajeError.hidden = true;
        botonEntrar.disabled = true;
        botonEntrar.textContent = 'Verificando…';

        try {
            const usuario = document.getElementById('campo-usuario').value;
            const clave = document.getElementById('campo-clave').value;
            const recordar = !!(document.getElementById('campo-recordar') || {}).checked;
            const resultado = await iniciarSesion(usuario, clave, recordar);

            if (resultado.error) {
                mensajeError.textContent = resultado.error;
                mensajeError.hidden = false;
                // Intento fallido real (campos vacíos no cuentan).
                if (typeof medir === 'function' && usuario.trim() && clave) medir('portal_fallido');
                // De qué cuenta (solo si existe; lo decide la base)
                if (typeof window.registrarIntentoFallido === 'function' && usuario.trim() && clave) {
                    window.registrarIntentoFallido(usuario.trim());
                }
                return;
            }
            // Se registra antes de redirigir o se pierde.
            if (typeof registrarActividad === 'function') {
                await registrarActividad('ingreso', '').catch(() => {});
            }
            location.href = 'app.html';
        } catch (e) {
            mensajeError.textContent = 'Ocurrió un error inesperado. Intenta de nuevo.';
            mensajeError.hidden = false;
        } finally {
            botonEntrar.disabled = false;
            botonEntrar.textContent = 'Ingresar';
        }
    });

    try {
        await sembrarDatosIniciales();
    } catch (e) {
        // Dos pestañas sembrando a la vez pueden chocar; da igual, ya existen.
        console.warn('Siembra de datos:', e);
    }

    // Sesión válida: entrar directo.
    if (sesionActual()) {
        location.replace('app.html');
        return;
    }

    // Visita a la pantalla de ingreso (quien ya tenía sesión no cuenta).
    if (typeof medir === 'function') medir('portal_visita');

    // En la barra queda /portal/ a secas.
    if (/\/index\.html$/.test(location.pathname)) {
        history.replaceState(history.state, '', './' + location.search + location.hash);
    }
});
