/*! Legajo · movimiento de la página de inicio
    Andrés Madrid · andresmadrid.vercel.app */
(function () {
    const quieto = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const anio = document.getElementById('anio');
    if (anio) anio.textContent = new Date().getFullYear();

    // Barra más compacta y con sombra al bajar
    const barra = document.getElementById('barra');
    const alBajar = () => barra.classList.toggle('barra--abajo', scrollY > 8);
    addEventListener('scroll', alBajar, { passive: true });
    alBajar();

    // Contadores de 0 al número
    const cuentas = document.querySelectorAll('[data-cuenta]');
    if (!quieto) cuentas.forEach((el) => { el.textContent = '0'; });
    function contar(el) {
        const fin = Number(el.dataset.cuenta);
        if (quieto) { el.textContent = fin; return; }
        const t0 = performance.now();
        const dura = 900 + fin * 12;
        const paso = (t) => {
            const p = Math.min(1, (t - t0) / dura);
            el.textContent = Math.round(fin * (1 - Math.pow(1 - p, 3)));
            if (p < 1) requestAnimationFrame(paso);
        };
        setTimeout(() => requestAnimationFrame(paso), 700);
    }

    // Lo que entra en pantalla se anima una sola vez
    function mostrar(el) {
        el.classList.add('visible');
        el.querySelectorAll('[data-cuenta]').forEach(contar);
    }
    const piezas = document.querySelectorAll('[data-revela]');
    if (!('IntersectionObserver' in window)) {
        piezas.forEach(mostrar);
    } else {
        const io = new IntersectionObserver((entradas) => {
            entradas.forEach((e) => {
                if (!e.isIntersecting) return;
                mostrar(e.target);
                io.unobserve(e.target);
            });
        }, { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
        piezas.forEach((el) => io.observe(el));
    }

    // La vista del portal se inclina un poco con el puntero
    const escenario = document.querySelector('.escenario');
    const giro = escenario && escenario.querySelector('.vista-giro');
    if (giro && !quieto && matchMedia('(pointer: fine)').matches) {
        escenario.addEventListener('pointermove', (e) => {
            const r = escenario.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width - 0.5;
            const y = (e.clientY - r.top) / r.height - 0.5;
            giro.style.setProperty('--ry', (x * 4).toFixed(2) + 'deg');
            giro.style.setProperty('--rx', (-y * 3).toFixed(2) + 'deg');
        });
        escenario.addEventListener('pointerleave', () => {
            giro.style.setProperty('--ry', '0deg');
            giro.style.setProperty('--rx', '0deg');
        });
    }
})();
