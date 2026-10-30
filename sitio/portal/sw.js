/*! Portal Documental · service worker de avisos (solo administrador)
    Andrés Madrid · andresmadrid.vercel.app */
// Solo avisos: no guarda páginas ni archivos, el portal carga como siempre.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Cómo se llaman varios avisos juntos de la misma etiqueta
const VARIOS = {
    documentos: (n) => n + ' documentos nuevos',
    estados: (n) => n + ' cambios en Estados',
    soporte: (n) => n + ' mensajes de soporte',
    calendario: (n) => n + ' avisos de calendario'
};
const JUNTAR_MS = 12 * 60 * 60 * 1000;

self.addEventListener('push', (e) => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (x) { d = { b: e.data ? e.data.text() : '' }; }
    e.waitUntil(mostrar(d));
});

async function mostrar(d) {
    const tag = d.g || 'aviso';
    const ahora = Date.now();
    let titulo = d.t || 'Portal Documental';
    let n = 1;
    // Si ya hay uno con la misma etiqueta y es reciente, se suman
    const previa = VARIOS[d.cat] ? (await self.registration.getNotifications({ tag }))[0] : null;
    if (previa && previa.data && ahora - (previa.data.desde || 0) < JUNTAR_MS) {
        n = (previa.data.n || 1) + 1;
        titulo = VARIOS[d.cat](n);
    }
    return self.registration.showNotification(titulo, {
        body: d.b || '',
        tag,
        renotify: true,
        icon: '/img/portal-192.png',
        badge: '/img/portal-insignia.png',
        lang: 'es',
        timestamp: ahora,
        // Juntos de varias carpetas (calendario) llevan a la campana; los demás, a su origen
        data: {
            tipo: n > 1 && d.cat === 'calendario' ? 'resumen' : (d.tipo || ''),
            carpeta: n > 1 && d.cat === 'calendario' ? null : (d.c || null),
            n,
            desde: n > 1 ? previa.data.desde : ahora
        }
    });
}

// Tocar el aviso: al portal abierto si lo hay, si no en una ventana nueva
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const d = e.notification.data || {};
    const destino = '/portal/app.html#aviso=' + encodeURIComponent(d.tipo || '') +
        (d.carpeta ? '&carpeta=' + encodeURIComponent(d.carpeta) : '');
    e.waitUntil((async () => {
        const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const portal = ventanas.find((v) => new URL(v.url).pathname.endsWith('/portal/app.html'));
        if (portal) {
            portal.postMessage({ aviso: d.tipo || '', carpeta: d.carpeta || null });
            return portal.focus();
        }
        return self.clients.openWindow(destino);
    })());
});
