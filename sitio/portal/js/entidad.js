/*! Portal Documental · datos de la entidad en la página
    Andrés Madrid · andresmadrid.vercel.app */
// [data-entidad="CORREO"] toma su valor de PORTAL_CONFIG.ENTIDAD; los enlaces mailto/tel también.
(function () {
    const E = (typeof PORTAL_CONFIG !== 'undefined' && PORTAL_CONFIG.ENTIDAD) || {};
    window.ENTIDAD = E;
    function pintar() {
        document.querySelectorAll('[data-entidad]').forEach((el) => {
            const v = E[el.dataset.entidad];
            if (!v) return;
            el.textContent = v;
            if (el.tagName === 'A' && el.dataset.entidad === 'CORREO') el.href = 'mailto:' + v;
            if (el.tagName === 'A' && el.dataset.entidad === 'TELEFONO') el.href = 'tel:' + v.replace(/[^\d+]/g, '');
            if (el.tagName === 'A' && el.dataset.entidad === 'WEB') el.href = v;
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pintar);
    else pintar();
})();
