/*! Portal Documental · visor de Word y Excel (visor.html)
  Word como PDF, hojas con cara de Excel, en pestaña aparte
  (en la app del celular, en un marco dentro del portal).
  No tiene sesión: le pide el archivo al portal que lo abrió
  (postMessage + clave en el #). Todo lo pesado corre aquí, que es la
  pestaña al frente. Enlaces del Word: solo http, https y mailto.
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const clave = location.hash.slice(1);
    // En la app del celular (pantalla de inicio) el visor va en un marco dentro del portal
    const EMBEBIDO = window.parent !== window;
    const portal = window.opener || (EMBEBIDO ? window.parent : null);
    let archivo = null;     // { nombre, blob, descargable }
    let recibido = false;

    const esc = (t) => String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const extension = (n) => String(n || '').split('.').pop().toLowerCase();

    const ICONOS = {
        menos: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        mas: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        ajustar: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/></svg>',
        imprimir: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2"/><path d="M7 14h10v6H7z"/></svg>',
        descargar: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
    };
    // Icono de la pestaña, como Word o Excel
    const ICONO_PESTANA = (color, letra) => 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="' + color + '"/>' +
        '<text x="16" y="22.5" font-family="Segoe UI,Arial,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">' + letra + '</text></svg>');

    /* ============ ESTADO: CARGANDO O ERROR ============ */
    function estado(texto, nota, esError) {
        $('v-app').hidden = true;
        $('v-estado').hidden = false;
        $('v-estado-descargar').hidden = true;
        $('v-estado').classList.toggle('v-estado--error', !!esError);
        $('v-ruedita').hidden = !!esError;
        $('v-estado-texto').textContent = texto;
        $('v-estado-nota').hidden = !nota;
        $('v-estado-nota').textContent = nota || '';
    }
    // No se puede mostrar: aviso y, si se puede, botón de descarga
    function sinVista(texto, nota) {
        estado(texto, nota, true);
        const boton = $('v-estado-descargar');
        if (!archivo || !archivo.descargable) return;
        if (!boton.getAttribute('href')) prepararDescarga(boton);
        boton.hidden = false;
    }
    function mostrarApp(clase) {
        const app = $('v-app');
        app.className = 'v-app ' + clase;
        $('v-estado').hidden = true;
        app.hidden = false;
        return app;
    }
    let _avisoTimer = null;
    function avisar(texto) {
        const a = $('v-aviso');
        a.textContent = texto;
        a.hidden = false;
        clearTimeout(_avisoTimer);
        _avisoTimer = setTimeout(() => { a.hidden = true; }, 6000);
    }

    /* ============ PEDIRLE EL ARCHIVO AL PORTAL ============ */
    const DE_NUEVO = 'Vuelve a la pestaña del portal y pulsa «Ver» otra vez.';
    if (!/^[0-9a-f-]{36}$/i.test(clave) || !portal || portal.closed) {
        estado('Este documento se abre desde el portal.', 'Entra al portal y pulsa «Ver» en el documento.', true);
        return;
    }
    window.addEventListener('message', (e) => {
        const d = e.data;
        if (e.origin !== location.origin || e.source !== portal || !d || d.token !== clave) return;
        if (d.tipo === 'visor-bajando') {
            recibido = true;
            if (d.nombre) document.title = String(d.nombre);
            estado('Abriendo ' + (d.nombre || 'el documento') + '…');
        } else if (d.tipo === 'visor-archivo') {
            recibido = true;
            abrir(d);
        } else if (d.tipo === 'visor-error') {
            recibido = true;
            estado('No se pudo abrir el documento.', String(d.mensaje || DE_NUEVO), true);
        }
    });
    try {
        portal.postMessage({ tipo: 'visor-pide', token: clave }, location.origin);
    } catch (e) {
        estado('No se pudo abrir el documento.', DE_NUEVO, true);
        return;
    }
    setTimeout(() => {
        if (!recibido) estado('El portal no respondió.', DE_NUEVO, true);
    }, 12000);

    /* ============ ABRIR SEGÚN EL TIPO ============ */
    async function abrir(d) {
        if (!(d.blob instanceof Blob)) { estado('No se pudo abrir el documento.', DE_NUEVO, true); return; }
        archivo = { nombre: String(d.nombre || 'documento'), blob: d.blob, descargable: d.descargable !== false };
        document.title = archivo.nombre;
        const ext = extension(archivo.nombre);
        try {
            if (ext === 'docx') await abrirWord();
            else if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) await abrirHoja();
            else if (ext === 'doc') {
                sinVista('Este Word es del formato antiguo (.doc) y no se puede ver aquí.',
                    archivo.descargable ? 'Descárgalo para abrirlo en Word, o pide que lo suban como .docx.' : 'Pide que lo suban como .docx.');
            } else {
                sinVista('Este tipo de archivo no se puede ver aquí.', archivo.descargable ? 'Descárgalo para abrirlo en tu computador.' : '');
            }
        } catch (e) {
            console.warn('Visor:', e);
            sinVista('No se pudo mostrar el documento.',
                ((e && e.message) ? e.message + ' ' : '') + (archivo.descargable ? 'Puedes descargarlo para abrirlo en Word o Excel.' : ''));
        }
    }

    // Descargar el original. El portal lo anota en la actividad.
    function prepararDescarga(enlace) {
        if (!enlace) return;
        if (!archivo.descargable) { enlace.remove(); return; }
        enlace.href = URL.createObjectURL(archivo.blob);
        enlace.download = archivo.nombre;
        enlace.addEventListener('click', () => {
            try { portal.postMessage({ tipo: 'visor-descargo', token: clave }, location.origin); } catch (e) { /* el portal ya se cerró */ }
        });
    }

    /* ============ WORD, COMO UN PDF ============ */
    async function abrirWord() {
        estado('Preparando el documento…');
        document.getElementById('v-icono').href = ICONO_PESTANA('#185ABD', 'W');
        const docx = await cargarDocxPreview();
        const app = $('v-app');
        app.className = 'v-app v-word';
        app.innerHTML =
            '<header class="vw-barra">' +
                '<div class="vw-archivo"><span class="vw-logo" aria-hidden="true">W</span>' +
                    '<span class="vw-nombre" title="' + esc(archivo.nombre) + '">' + esc(archivo.nombre) + '</span></div>' +
                '<div class="vw-centro">' +
                    '<span class="vw-paginas" aria-label="Página"><span id="vw-pag">1</span> / <span id="vw-total">1</span></span>' +
                    '<span class="vw-sep" aria-hidden="true"></span>' +
                    '<button type="button" class="vw-boton" data-zoom="-1" title="Alejar" aria-label="Alejar">' + ICONOS.menos + '</button>' +
                    '<span id="vw-zoom" class="vw-zoom">100 %</span>' +
                    '<button type="button" class="vw-boton" data-zoom="1" title="Acercar" aria-label="Acercar">' + ICONOS.mas + '</button>' +
                    '<button type="button" class="vw-boton" id="vw-ajustar" title="Ajustar al ancho de la ventana" aria-label="Ajustar al ancho">' + ICONOS.ajustar + '</button>' +
                '</div>' +
                '<div class="vw-acciones">' +
                    '<button type="button" class="vw-boton" id="v-imprimir" title="Imprimir" aria-label="Imprimir">' + ICONOS.imprimir + '</button>' +
                    '<a class="vw-boton" id="v-descargar" title="Descargar" aria-label="Descargar">' + ICONOS.descargar + '</a>' +
                '</div>' +
            '</header>' +
            '<main id="vw-hojas" class="vw-hojas" tabindex="-1"></main>';
        const cont = $('vw-hojas');
        // Corta las páginas donde Word las cortó al guardar.
        await docx.renderAsync(archivo.blob, cont, null, {
            className: 'docx', inWrapper: true, ignoreLastRenderedPageBreak: false,
            renderComments: false, renderChanges: false, useBase64URL: true
        });
        limpiarEnlaces(cont);
        prepararDescarga($('v-descargar'));
        $('v-imprimir').addEventListener('click', () => window.print());

        mostrarApp('v-word');
        const envoltura = cont.querySelector('.docx-wrapper') || cont;
        const paginas = Array.from(cont.querySelectorAll('section.docx'));
        $('vw-total').textContent = String(Math.max(1, paginas.length));
        const anchoPagina = paginas[0] ? paginas[0].offsetWidth : 816;

        // 100 % si la página cabe; si no (celular), ajustada al ancho
        let zoom = 100;
        const ajustado = () => Math.max(25, Math.min(200, Math.floor((cont.clientWidth - 40) / anchoPagina * 100)));
        const fijarZoom = (z) => {
            zoom = Math.max(25, Math.min(300, Math.round(z)));
            envoltura.style.zoom = String(zoom / 100);
            $('vw-zoom').textContent = zoom + ' %';
            contarPagina();
        };
        app.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
            const pasos = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
            const sube = Number(b.dataset.zoom) > 0;
            const siguiente = sube ? pasos.find((p) => p > zoom) : pasos.slice().reverse().find((p) => p < zoom);
            fijarZoom(siguiente || zoom);
        }));
        $('vw-ajustar').addEventListener('click', () => fijarZoom(ajustado()));

        // Página actual: la que ocupa el tercio de arriba
        let pendiente = false;
        function contarPagina() {
            if (pendiente) return;
            pendiente = true;
            requestAnimationFrame(() => {
                pendiente = false;
                const linea = cont.getBoundingClientRect().top + cont.clientHeight / 3;
                let n = 1;
                paginas.forEach((p, i) => { if (p.getBoundingClientRect().top <= linea) n = i + 1; });
                $('vw-pag').textContent = String(n);
            });
        }
        cont.addEventListener('scroll', contarPagina, { passive: true });
        window.addEventListener('resize', contarPagina);
        fijarZoom(anchoPagina + 40 > cont.clientWidth ? ajustado() : 100);
        cont.focus({ preventScroll: true });
    }

    // Enlaces del Word: solo web y correo. Los #marcadores se quedan.
    function limpiarEnlaces(raiz) {
        raiz.querySelectorAll('a').forEach((a) => {
            const href = a.getAttribute('href');
            if (href == null) { a.removeAttribute('xlink:href'); return; }
            if (href.startsWith('#')) return;
            let bueno = false;
            try { bueno = ['http:', 'https:', 'mailto:'].includes(new URL(href, location.href).protocol); } catch (e) { bueno = false; }
            if (!bueno) { a.removeAttribute('href'); return; }
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
    }

    /* ============ HOJA DE CÁLCULO, CON CARA DE EXCEL ============ */
    async function abrirHoja() {
        estado('Preparando la hoja de cálculo…', 'Si el libro es grande, puede tardar unos segundos.');
        document.getElementById('v-icono').href = ICONO_PESTANA('#107C41', 'X');
        const H = window.VisorHojas;
        const hojas = await H.leer(archivo.nombre, archivo.blob);
        const app = $('v-app');
        app.className = 'v-app v-hoja';
        app.innerHTML =
            '<header class="hx-barra">' +
                '<div class="hx-archivo"><span class="hx-logo" aria-hidden="true">X</span>' +
                    '<span class="hx-nombre" title="' + esc(archivo.nombre) + '">' + esc(archivo.nombre) + '</span>' +
                    '<span class="hx-nota">Solo lectura</span></div>' +
                '<div class="hx-acciones">' +
                    '<div class="hx-zoom" role="group" aria-label="Zoom">' +
                        '<button type="button" class="hx-boton" data-zoom="-1" title="Alejar" aria-label="Alejar">' + ICONOS.menos + '</button>' +
                        '<span id="hx-zoom">100 %</span>' +
                        '<button type="button" class="hx-boton" data-zoom="1" title="Acercar" aria-label="Acercar">' + ICONOS.mas + '</button>' +
                    '</div>' +
                    '<button type="button" class="hx-boton hx-boton--texto" id="hx-pdf" title="Ver la hoja como PDF, para imprimirla o guardarla">' +
                        ICONOS.imprimir + '<span>PDF</span></button>' +
                    '<a class="hx-boton hx-boton--texto" id="v-descargar" title="Descargar el archivo original">' +
                        ICONOS.descargar + '<span>Descargar</span></a>' +
                '</div>' +
            '</header>' +
            '<div class="hx-formula">' +
                '<span class="hx-dir" id="hx-dir"></span>' +
                '<span class="hx-fx" aria-hidden="true">fx</span>' +
                '<span class="hx-val" id="hx-val"></span>' +
            '</div>' +
            '<main id="hx-hojas" class="hx-hojas" tabindex="0"></main>' +
            '<nav id="hx-pestanas" class="hx-pestanas" role="tablist" aria-label="Hojas del libro"></nav>';
        prepararDescarga($('v-descargar'));
        mostrarApp('v-hoja');

        const main = $('hx-hojas');
        const pestanas = $('hx-pestanas');
        if (!hojas.length) {
            main.innerHTML = '<p class="hx-aviso">El libro no tiene hojas visibles.</p>';
            $('hx-pdf').remove();
            return;
        }
        pestanas.innerHTML = hojas.map((h, i) =>
            '<button type="button" role="tab" data-hoja="' + i + '" aria-selected="false">' + esc(h.nombre) + '</button>').join('');

        const secciones = [];
        const posiciones = [];     // posición de cada hoja al cambiar de pestaña
        let actual = -1, zoom = 100, sel = null;

        function verHoja(i) {
            if (i === actual) return;
            if (actual >= 0) posiciones[actual] = [main.scrollLeft, main.scrollTop];
            deseleccionar();
            actual = i;
            if (!secciones[i]) {
                const h = hojas[i];
                const s = document.createElement('section');
                s.className = 'hx-hoja';
                let avisos = '';
                if (h.imagenes) avisos += '<p class="hx-aviso">Esta hoja tiene imágenes o gráficos que el visor no muestra. Descarga el archivo para verlos.</p>';
                if (h.recortada) avisos += '<p class="hx-aviso">La hoja es muy grande: aquí se ven las primeras ' + H.MAX_FILAS + ' filas y ' + H.MAX_COLS + ' columnas.</p>';
                s.innerHTML = avisos + H.tabla(h);
                main.appendChild(s);
                secciones[i] = s;
            }
            secciones.forEach((s, j) => { if (s) s.hidden = j !== i; });
            secciones[i].style.zoom = String(zoom / 100);
            pestanas.querySelectorAll('button').forEach((b, j) => {
                b.classList.toggle('hx-activa', j === i);
                b.setAttribute('aria-selected', String(j === i));
            });
            const botonActivo = pestanas.children[i];
            if (botonActivo) botonActivo.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const [x, y] = posiciones[i] || [0, 0];
            main.scrollTo(x, y);
            const primera = secciones[i].querySelector('td[data-rc]');
            if (primera && !posiciones[i]) seleccionar(primera, false);
        }
        pestanas.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-hoja]');
            if (b) verHoja(Number(b.dataset.hoja));
        });

        // ---- Celda seleccionada y barra de fórmulas ----
        function deseleccionar() {
            if (!sel) return;
            sel.classList.remove('hx-sel');
            const s = secciones[actual];
            if (s) s.querySelectorAll('.hx-cab-activa').forEach((x) => x.classList.remove('hx-cab-activa'));
            sel = null;
            $('hx-dir').textContent = '';
            $('hx-val').textContent = '';
        }
        function seleccionar(td, mover) {
            deseleccionar();
            sel = td;
            td.classList.add('hx-sel');
            const [r, c] = td.dataset.rc.split(',').map(Number);
            $('hx-dir').textContent = H.letras(c) + r;
            const d = hojas[actual].celdas.get(td.dataset.rc);
            $('hx-val').textContent = d ? (d.formula ? '=' + d.formula : d.texto) : '';
            // Resalta la letra de la columna y el número de la fila
            const s = secciones[actual];
            const cabCol = s.querySelector('thead th[data-col="' + c + '"]');
            if (cabCol) cabCol.classList.add('hx-cab-activa');
            const cabFila = td.parentElement && td.parentElement.firstElementChild;
            if (cabFila) cabFila.classList.add('hx-cab-activa');
            if (mover) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        main.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const td = e.target.closest('td[data-rc]');
            if (td) seleccionar(td, false);
        });
        // Flechas: a la siguiente celda visible
        main.addEventListener('keydown', (e) => {
            const pasos = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, 1] };
            if (!sel || !pasos[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
            let [dr, dc] = pasos[e.key];
            if (e.shiftKey && (e.key === 'Enter' || e.key === 'Tab')) { dr = -dr; dc = -dc; }
            e.preventDefault();
            let [r, c] = sel.dataset.rc.split(',').map(Number);
            for (let intento = 0; intento < 60; intento++) {
                r += dr; c += dc;
                if (r < 1 || c < 1) return;
                const td = secciones[actual].querySelector('td[data-rc="' + r + ',' + c + '"]');
                if (td) { seleccionar(td, true); return; }
            }
        });

        // ---- Zoom ----
        app.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
            zoom = Math.max(50, Math.min(200, zoom + Number(b.dataset.zoom) * 10));
            if (secciones[actual]) secciones[actual].style.zoom = String(zoom / 100);
            $('hx-zoom').textContent = zoom + ' %';
        }));

        // ---- PDF para imprimir o guardar ----
        $('hx-pdf').addEventListener('click', async () => {
            const boton = $('hx-pdf');
            if (boton.disabled) return;
            boton.disabled = true;
            boton.querySelector('span').textContent = 'Preparando…';
            try {
                const bytes = await H.pdf(archivo.nombre, hojas);
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
                // En la app no hay pestañas: el PDF ocupa el marco
                if (EMBEBIDO) { location.assign(url); return; }
                if (!window.open(url, '_blank')) {
                    // Tardó y el navegador ya no deja abrir la pestaña: queda un enlace
                    const enlace = document.createElement('a');
                    enlace.className = boton.className;
                    enlace.href = url;
                    enlace.target = '_blank';
                    enlace.rel = 'noopener';
                    enlace.innerHTML = ICONOS.imprimir + '<span>Abrir PDF</span>';
                    boton.replaceWith(enlace);
                    return;
                }
            } catch (e) {
                console.warn('Hoja a PDF:', e);
                avisar('No se pudo preparar el PDF. ' + ((e && e.message) || ''));
            }
            boton.disabled = false;
            boton.querySelector('span').textContent = 'PDF';
        });

        verHoja(hojas.activa || 0);
        main.focus({ preventScroll: true });
    }
})();
