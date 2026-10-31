/*! Legajo · métricas de la pantalla de ingreso
  Manda solo el evento, el origen en una palabra, el tipo de equipo y
  un número al azar de la pestaña (sessionStorage). Nada de lo que la
  persona escribe. Si falla, no pasa nada.
  No cuenta localhost ni robots.
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    const cfg = (typeof PORTAL_CONFIG !== 'undefined') ? PORTAL_CONFIG : null;
    const CLAVE_SESION = 'mc_metricas_sesion';
    const CLAVE_ORIGEN = 'mc_metricas_origen';

    function apagado() {
        if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) return true;
        if (location.protocol === 'file:' ||
            /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return true;
        const ua = String(navigator.userAgent || '');
        if (navigator.webdriver ||
            /bot|crawl|spider|slurp|lighthouse|headless|facebookexternalhit/i.test(ua) ||
            /^WhatsApp\//.test(ua)) return true;   // vista previa de enlace, no una persona
        return false;
    }

    function azar() {
        try {
            const b = new Uint8Array(12);
            crypto.getRandomValues(b);
            return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            return (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 24);
        }
    }

    // Sin sessionStorage (modo privado): en memoria, recargar suma visita.
    let sesionMemoria = null;
    function sesion() {
        try {
            let s = sessionStorage.getItem(CLAVE_SESION);
            if (!s || !/^[a-z0-9]{12,40}$/.test(s)) {
                s = azar();
                sessionStorage.setItem(CLAVE_SESION, s);
            }
            return s;
        } catch (e) {
            return sesionMemoria || (sesionMemoria = azar());
        }
    }

    /* Origen en una palabra. Se fija en la primera página de la pestaña. */
    function clasificar(texto) {
        const t = String(texto || '').toLowerCase();
        if (!t) return 'directo';
        if (/google\./.test(t) || t === 'google') return 'google';
        if (/bing\.|yahoo\.|duckduckgo\.|ecosia\.|brave\./.test(t) || /^(bing|yahoo|duckduckgo)$/.test(t)) return 'buscador';
        if (/whatsapp|wa\.me/.test(t)) return 'whatsapp';
        if (/facebook|fb\.|^fb$|messenger/.test(t)) return 'facebook';
        if (/instagram|^ig$/.test(t)) return 'instagram';
        if (/tiktok/.test(t)) return 'tiktok';
        return 'otro';
    }
    function origen() {
        try {
            const guardado = sessionStorage.getItem(CLAVE_ORIGEN);
            if (guardado) return guardado;
        } catch (e) { /* sin sessionStorage se calcula cada vez */ }
        let o;
        // utm manda sobre el referer
        const utm = new URLSearchParams(location.search).get('utm_source');
        if (utm) {
            o = clasificar(utm);
        } else {
            let host = '';
            try { host = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { host = ''; }
            o = host && host === location.hostname ? 'sitio' : clasificar(host);
        }
        try { sessionStorage.setItem(CLAVE_ORIGEN, o); } catch (e) { /* nada */ }
        return o;
    }

    function dispositivo() {
        const ua = String(navigator.userAgent || '');
        if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tableta';
        if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'movil';
        // iPad con iOS 13+ dice ser Mac: se nota por la pantalla táctil
        if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return 'tableta';
        return 'escritorio';
    }

    /* Registra el evento. No espera respuesta. */
    function medir(tipo) {
        if (apagado()) return;
        try {
            fetch(cfg.SUPABASE_URL + '/rest/v1/rpc/registrar_evento_web', {
                method: 'POST',
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    // Solo apikey: la clave publishable no es un JWT y no va en Authorization
                    'apikey': cfg.SUPABASE_KEY
                },
                body: JSON.stringify({
                    p_tipo: tipo,
                    p_sesion: sesion(),
                    p_origen: origen(),
                    p_dispositivo: dispositivo()
                })
            }).catch(() => {});
        } catch (e) { /* nunca rompe la página */ }
    }

    window.medir = medir;
})();
