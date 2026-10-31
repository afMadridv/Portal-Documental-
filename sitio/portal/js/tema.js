/*! Legajo · tema claro/oscuro
  El <head> de cada página lo aplica antes de pintar; aquí solo el botón.
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    const CLAVE_TEMA = 'portal_tema';

    function esOscuro() {
        return document.documentElement.dataset.tema === 'oscuro';
    }

    // Cambia el tema y lo recuerda
    window.alternarTema = function () {
        const html = document.documentElement;
        if (esOscuro()) {
            delete html.dataset.tema;
            try { localStorage.setItem(CLAVE_TEMA, 'claro'); } catch (e) { /* sin storage */ }
        } else {
            html.dataset.tema = 'oscuro';
            try { localStorage.setItem(CLAVE_TEMA, 'oscuro'); } catch (e) { /* sin storage */ }
        }
        pintarBotonesTema();
    };

    // Icono y etiqueta del botón según el tema actual.
    function pintarBotonesTema() {
        const oscuro = esOscuro();
        document.querySelectorAll('[data-accion="alternar-tema"]').forEach(function (boton) {
            const tam = boton.dataset.iconoTam ? Number(boton.dataset.iconoTam) : 18;
            if (typeof icono === 'function') boton.innerHTML = icono(oscuro ? 'sol' : 'luna', tam);
            boton.setAttribute('aria-pressed', String(oscuro));
            const etq = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
            boton.setAttribute('aria-label', etq);
            boton.setAttribute('title', etq);
        });
    }
    window.pintarBotonesTema = pintarBotonesTema;

    // Un solo escuchador, sirve en el ingreso y en el portal.
    document.addEventListener('click', function (evento) {
        const boton = evento.target.closest('[data-accion="alternar-tema"]');
        if (boton) { evento.preventDefault(); window.alternarTema(); }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', pintarBotonesTema);
    } else {
        pintarBotonesTema();
    }
})();
