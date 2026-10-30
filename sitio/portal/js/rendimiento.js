/*! Portal Documental · Rendimiento (solo administrador)
  Visitas al ingreso, inicios de sesión, intentos fallidos y metas.
  Todo sale de metricas_web(), que solo responde al admin activo.
  Gráficas en SVG a mano. Colores fijos por cifra: cian visitas,
  rosa ingresos, ámbar fallidos.
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    const vista = document.getElementById('vista-rendimiento');
    if (!vista) return;

    const ZONA = 'America/Bogota';
    const CLAVE_PERIODO = 'rd_periodo';
    const CLAVE_LINEAS = 'rd_lineas_portal';
    const $ = (id) => document.getElementById(id);

    /* ============ UTILIDADES ============ */
    function esc(t) {
        return String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const num = (n) => Number(n || 0).toLocaleString('es-CO');
    function pct(parte, todo) {
        parte = Number(parte || 0);
        if (!todo) return '—';
        const p = (parte / todo) * 100;
        return p.toLocaleString('es-CO', { maximumFractionDigits: p > 0 && p < 10 ? 1 : 0 }) + ' %';
    }
    const plural = (n, uno, varios) => num(n) + ' ' + (Number(n) === 1 ? uno : varios);

    // Fechas 'AAAA-MM-DD' en hora de Colombia, calculadas en UTC
    const hoyColombia = () => new Intl.DateTimeFormat('en-CA',
        { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const aUTC = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
    const aISO = (f) => f.toISOString().slice(0, 10);
    const sumarDias = (iso, n) => { const f = aUTC(iso); f.setUTCDate(f.getUTCDate() + n); return aISO(f); };
    const diasEntre = (a, b) => Math.round((aUTC(b) - aUTC(a)) / 86400000);
    const fecha = (iso, op) => aUTC(iso).toLocaleDateString('es-CO', Object.assign({ timeZone: 'UTC' }, op));
    const fechaCorta = (iso) => fecha(iso, { day: 'numeric', month: 'short' });
    const fechaLarga = (iso) => fecha(iso, { day: 'numeric', month: 'long', year: 'numeric' });
    const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    /* ============ CIFRAS ============ */
    const NOMBRE = {
        portal_visita: 'Visitas al ingreso',
        portal_ingreso: 'Ingresos al portal',
        portal_fallido: 'Intentos fallidos'
    };
    const COLOR = {
        portal_visita: 'var(--rd-c-visitas)',
        portal_ingreso: 'var(--rd-c-portal)',
        portal_fallido: 'var(--rd-c-enviados)'
    };

    /* ============ ESTADO ============ */
    let periodo = '30';
    try { periodo = localStorage.getItem(CLAVE_PERIODO) || '30'; } catch (e) { /* nada */ }
    let rangoLibre = null;
    let datos = null;
    let cargando = false;
    // Líneas visibles en "Día a día" (mínimo una)
    let lineas = { portal_visita: true, portal_ingreso: true, portal_fallido: true };
    try { Object.assign(lineas, JSON.parse(localStorage.getItem(CLAVE_LINEAS) || '{}')); } catch (e) { /* nada */ }

    /* ============ ENTRADA ============ */
    window.mostrarVistaRendimiento = async function () {
        if (typeof ES_ADMIN !== 'undefined' && !ES_ADMIN) return;
        if (typeof mostrarVista === 'function') mostrarVista('vista-rendimiento');
        await cargar();
    };

    function rangoDe(p) {
        const hoy = hoyColombia();
        if (p === '7' || p === '30' || p === '90') return { desde: sumarDias(hoy, -(Number(p) - 1)), hasta: hoy };
        if (p === 'mes') return { desde: hoy.slice(0, 8) + '01', hasta: hoy };
        if (p === 'mes-ant') {
            const fin = sumarDias(hoy.slice(0, 8) + '01', -1);
            return { desde: fin.slice(0, 8) + '01', hasta: fin };
        }
        if (p === 'rango' && rangoLibre) return rangoLibre;
        return { desde: sumarDias(hoy, -29), hasta: hoy };
    }

    function pintarPeriodos() {
        vista.querySelectorAll('#rd-periodos button').forEach((b) => {
            const activo = b.dataset.periodo === periodo;
            b.classList.toggle('activo', activo);
            b.setAttribute('aria-pressed', String(activo));
        });
        $('rd-form-rango').hidden = periodo !== 'rango';
    }

    $('rd-periodos').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-periodo]');
        if (!b) return;
        periodo = b.dataset.periodo;
        pintarPeriodos();
        if (periodo === 'rango') {
            const r = rangoLibre || rangoDe('30');
            $('rd-desde').value = r.desde;
            $('rd-hasta').value = r.hasta;
            $('rd-desde').focus();
            return;
        }
        try { localStorage.setItem(CLAVE_PERIODO, periodo); } catch (err) { /* nada */ }
        cargar();
    });
    $('rd-form-rango').addEventListener('submit', (e) => {
        e.preventDefault();
        let desde = $('rd-desde').value, hasta = $('rd-hasta').value;
        if (!desde || !hasta) return;
        if (desde > hasta) [desde, hasta] = [hasta, desde];
        rangoLibre = { desde, hasta };
        cargar();
    });
    $('rd-refrescar').addEventListener('click', () => cargar());

    function mostrarAviso(titulo, texto, conReintento) {
        const aviso = $('rd-aviso');
        aviso.innerHTML = '<b>' + esc(titulo) + '</b><p>' + texto + '</p>' +
            (conReintento ? '<button type="button" class="pt-boton pt-boton--mini pt-boton--primario" id="rd-reintentar">Intentar de nuevo</button>' : '');
        aviso.hidden = false;
        const b = $('rd-reintentar');
        if (b) b.addEventListener('click', () => cargar());
    }

    /* ============ CARGA ============ */
    async function cargar() {
        if (cargando) return;
        if (typeof window.metricasWebLeer !== 'function') {
            $('rd-tablero').hidden = true;
            mostrarAviso('Este tablero necesita la base de datos',
                'Solo funciona con el portal conectado a Supabase (MODO «nube» en config.js).');
            return;
        }
        if (periodo === 'rango' && !rangoLibre) periodo = '30';
        pintarPeriodos();
        const r = rangoDe(periodo);
        cargando = true;
        vista.setAttribute('aria-busy', 'true');
        if (!datos) esqueletoTablero();
        try {
            datos = await window.metricasWebLeer(r.desde, r.hasta);
            $('rd-aviso').hidden = true;
            $('rd-tablero').hidden = false;
            pintarTodo();
        } catch (e) {
            const m = String((e && (e.message || e.details)) || e || '');
            const codigo = e && e.code;
            if (codigo === '42501' || /administrador/i.test(m)) {
                $('rd-tablero').hidden = true;
                mostrarAviso('Solo el administrador puede ver esta sección',
                    'Tu cuenta no tiene permiso para ver estas cifras.');
            } else if (codigo === 'PGRST202' || /metricas_web|schema cache|does not exist|Could not find/i.test(m)) {
                $('rd-tablero').hidden = true;
                mostrarAviso('Falta un paso en el servidor',
                    'Hay que ejecutar <code>migracion_metricas_web.sql</code> en la base (viene dentro de ' +
                    '<code>Salva_vidas.sql</code>). Mientras tanto el portal funciona con ' +
                    'normalidad, pero no se está registrando ninguna cifra.', true);
            } else {
                // Si había algo pintado, se queda
                mostrarAviso('No pudimos cargar las cifras', 'Revisa tu conexión a internet e inténtalo de nuevo.', true);
            }
        } finally {
            cargando = false;
            vista.setAttribute('aria-busy', 'false');
        }
    }

    /* Primera carga: el tablero con su forma, en gris */
    const bloque = (alto) => '<span class="pt-esq pt-esq--bloque" style="height:' + alto + 'px" aria-hidden="true"></span>';
    const linea = (ancho, chica) => '<span class="pt-esq pt-esq--linea' + (chica ? ' pt-esq--chica' : '') + '" style="width:' + ancho + '"></span>';
    function esqueletoTablero() {
        $('rd-aviso').hidden = true;
        $('rd-tablero').hidden = false;
        $('rd-kpis').innerHTML = [0, 1, 2].map((i) =>
            '<div class="pt-panorama__caja rd-kpi" aria-hidden="true">' +
            '<div class="pt-panorama__tit">' + linea('70%') + '</div>' +
            '<div class="pt-panorama__num"><span class="pt-esq pt-esq--cifra"></span></div>' +
            '<div class="pt-panorama__pie">' + linea(i % 2 ? '60%' : '80%') + '</div>' +
            '<span class="pt-esq rd-kpi__linea"></span></div>').join('');
        $('rd-metas-sub').innerHTML = linea('18rem');
        $('rd-metas').innerHTML = [0, 1].map(() =>
            '<div class="rd-meta" aria-hidden="true"><span class="pt-esq rd-anillo" style="border-radius:50%"></span>' +
            '<div class="rd-meta__texto" style="flex:1">' + linea('60%') + linea('85%', true) + linea('45%', true) + '</div></div>').join('');
        $('rd-linea-sub').innerHTML = linea('14rem');
        const ancho = ($('rd-linea').clientWidth || 800);
        $('rd-linea').innerHTML = bloque(ancho < 600 ? 220 : 280);
        $('rd-portal').innerHTML = bloque(180);
    }

    /* ============ SERIES POR DÍA ============ */
    function porDia(clave) {
        const cuenta = {};
        if (clave === 'portal_ingreso') ((datos.portal && datos.portal.serie) || []).forEach((f) => { cuenta[f.dia] = f.n; });
        else (datos.serie || []).forEach((f) => { if (f.tipo === clave) cuenta[f.dia] = f.n; });
        const out = [];
        for (let d = datos.desde; d <= datos.hasta; d = sumarDias(d, 1)) out.push({ dia: d, valor: cuenta[d] || 0 });
        return out;
    }
    /* Más de 92 días van por semana */
    function agrupar(puntos) {
        if (puntos.length <= 92) {
            return puntos.map((p) => ({ valor: p.valor, corta: fechaCorta(p.dia),
                larga: mayus(fecha(p.dia, { weekday: 'long', day: 'numeric', month: 'long' })) }));
        }
        const semanas = [];
        puntos.forEach((p) => {
            const lunes = sumarDias(p.dia, -((aUTC(p.dia).getUTCDay() + 6) % 7));
            const ult = semanas[semanas.length - 1];
            if (ult && ult.lunes === lunes) ult.valor += p.valor;
            else semanas.push({ lunes, valor: p.valor });
        });
        return semanas.map((s) => ({ valor: s.valor, corta: fechaCorta(s.lunes),
            larga: 'Semana del ' + fecha(s.lunes, { day: 'numeric', month: 'long' }) }));
    }

    /* ============ BURBUJA ============ */
    const burbuja = $('rd-burbuja');
    // filas: [{ valor, nombre, color }]
    function mostrarBurbuja(x, y, titulo, filas) {
        burbuja.textContent = '';
        const t = document.createElement('div');
        t.className = 'rd-burbuja__titulo';
        t.textContent = titulo;
        burbuja.appendChild(t);
        filas.forEach((f) => {
            const fila = document.createElement('div');
            fila.className = 'rd-burbuja__fila';
            if (f.color) {
                const i = document.createElement('i');
                i.style.background = f.color;
                fila.appendChild(i);
            }
            const b = document.createElement('b');
            b.textContent = f.valor;
            fila.appendChild(b);
            if (f.nombre) {
                const s = document.createElement('span');
                s.textContent = f.nombre;
                fila.appendChild(s);
            }
            burbuja.appendChild(fila);
        });
        burbuja.hidden = false;
        const r = burbuja.getBoundingClientRect();
        let left = x + 14, top = y - r.height - 12;
        if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
        if (left < 8) left = 8;
        if (top < 8) top = y + 18;
        burbuja.style.left = left + 'px';
        burbuja.style.top = top + 'px';
    }
    const ocultarBurbuja = () => { burbuja.hidden = true; };
    window.addEventListener('scroll', ocultarBurbuja, { passive: true, capture: true });

    /* Cualquier elemento con data-burbuja-* muestra la burbuja (ratón o teclado). */
    const datoBurbuja = (el) => ({
        titulo: el.dataset.burbujaTitulo || '',
        filas: [{ valor: el.dataset.burbujaValor || '', nombre: el.dataset.burbujaNombre || '', color: el.dataset.burbujaColor || '' }]
    });
    vista.addEventListener('pointermove', (e) => {
        const el = e.target.closest && e.target.closest('[data-burbuja-titulo]');
        if (!el) { if (!e.target.closest('.rd-grafica--propia')) ocultarBurbuja(); return; }
        const b = datoBurbuja(el);
        mostrarBurbuja(e.clientX, e.clientY, b.titulo, b.filas);
    });
    vista.addEventListener('pointerleave', ocultarBurbuja);
    vista.addEventListener('focusin', (e) => {
        const el = e.target.closest && e.target.closest('[data-burbuja-titulo]');
        if (!el) { ocultarBurbuja(); return; }
        const r = el.getBoundingClientRect();
        const b = datoBurbuja(el);
        mostrarBurbuja(r.left + r.width / 2, r.top, b.titulo, b.filas);
    });
    vista.addEventListener('focusout', ocultarBurbuja);

    const atributosBurbuja = (titulo, valor, nombre, color) =>
        ' tabindex="0" data-burbuja-titulo="' + esc(titulo) + '" data-burbuja-valor="' + esc(valor) + '"' +
        ' data-burbuja-nombre="' + esc(nombre || '') + '" data-burbuja-color="' + esc(color || '') + '"';

    /* ============ PIEZAS DE DIBUJO ============ */
    /* Tope redondo del eje: 7 → 8, 43 → 50, 1.280 → 1.500 */
    function topeRedondo(max) {
        if (max <= 4) return 4;
        const pot = Math.pow(10, Math.floor(Math.log10(max)));
        for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
            if (f * pot >= max && Number.isInteger((f * pot) / 4)) return f * pot;
        }
        return Math.ceil(max / 4) * 4;
    }
    // Columna con punta redonda y base recta
    function rutaColumna(x, y, w, h) {
        if (h <= 0) return '';
        const r = Math.min(4, w / 2, h);
        return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
            'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
    }
    function ejeY(ancho, m, h, tope) {
        let s = '';
        for (let i = 0; i <= 4; i++) {
            const v = (tope / 4) * i;
            const y = (m.arriba + h - (v / tope) * h).toFixed(1);
            s += '<line class="' + (i === 0 ? 'base' : 'guia') + '" x1="' + m.izquierda + '" x2="' + (ancho - m.derecha) + '" y1="' + y + '" y2="' + y + '"/>' +
                '<text class="eje" x="' + (m.izquierda - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end">' + num(v) + '</text>';
        }
        return s;
    }

    /* ---- Línea fina con relleno, para las cifras de arriba ---- */
    function lineaMini(valores, color) {
        if (valores.length < 2) return '';
        const max = Math.max(1, ...valores);
        const paso = 200 / (valores.length - 1);
        const pts = valores.map((n, i) => [i * paso, 34 - (n / max) * 30]);
        const linea = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
        return '<svg class="rd-kpi__linea" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true">' +
            '<path d="' + linea + 'L200,36L0,36Z" fill="' + color + '" opacity=".12"/>' +
            '<path d="' + linea + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" ' +
                'stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
    }

    /* ---- Anillo de meta: arco = logrado, rayita = dónde ir hoy ---- */
    function anillo(fraccion, ritmo, color, centro, bajo, vacio) {
        const r = 46, C = 2 * Math.PI * r;
        const f = Math.max(0, Math.min(1, fraccion));
        let s = '<svg class="rd-anillo" viewBox="0 0 112 112" aria-hidden="true">' +
            '<circle cx="56" cy="56" r="' + r + '" class="rd-anillo__pista' + (vacio ? ' rd-anillo__pista--vacia' : '') + '"/>';
        if (f > 0) {
            s += '<circle cx="56" cy="56" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="10" stroke-linecap="round" ' +
                'stroke-dasharray="' + (f * C).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 56 56)"/>';
        }
        if (ritmo != null && ritmo > 0 && ritmo < 1) {
            const a = ritmo * 2 * Math.PI - Math.PI / 2;
            s += '<line class="rd-anillo__ritmo" x1="' + (56 + 38 * Math.cos(a)).toFixed(1) + '" y1="' + (56 + 38 * Math.sin(a)).toFixed(1) +
                '" x2="' + (56 + 54 * Math.cos(a)).toFixed(1) + '" y2="' + (56 + 54 * Math.sin(a)).toFixed(1) + '"/>';
        }
        s += '<text x="56" y="' + (bajo ? 56 : 62) + '" text-anchor="middle" class="rd-anillo__num">' + esc(centro) + '</text>';
        if (bajo) s += '<text x="56" y="73" text-anchor="middle" class="rd-anillo__txt">' + esc(bajo) + '</text>';
        return s + '</svg>';
    }

    /* ---- Columnas, una serie ---- */
    function columnas(caja, puntos, op) {
        const ancho = Math.max(240, Math.floor(caja.clientWidth || 500));
        const alto = op.alto || 200;
        const m = { arriba: 20, derecha: 4, abajo: 24, izquierda: 34 };
        const w = ancho - m.izquierda - m.derecha, h = alto - m.arriba - m.abajo;
        const n = puntos.length;
        const max = Math.max(0, ...puntos.map((p) => p.valor));
        const tope = topeRedondo(max);
        const banda = w / n;
        const anchoCol = Math.max(1, Math.min(22, banda - Math.max(2, banda * 0.3)));
        const cada = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / (op.anchoEtiqueta || 58)))));
        const iPico = max > 0 ? puntos.findIndex((p) => p.valor === max) : -1;
        let s = '<svg viewBox="0 0 ' + ancho + ' ' + alto + '" width="' + ancho + '" height="' + alto + '" role="img" aria-label="' + esc(op.descripcion || '') + '">' +
            ejeY(ancho, m, h, tope);
        puntos.forEach((p, i) => {
            const xb = m.izquierda + i * banda;
            const x = xb + (banda - anchoCol) / 2;
            const hc = (p.valor / tope) * h;
            const y = m.arriba + h - hc;
            s += '<rect class="blanco" data-i="' + i + '" x="' + xb.toFixed(1) + '" y="' + m.arriba + '" width="' + banda.toFixed(1) + '" height="' + h + '"/>' +
                '<path class="col" fill="' + op.color + '" d="' + rutaColumna(+x.toFixed(1), +y.toFixed(1), +anchoCol.toFixed(1), +hc.toFixed(1)) + '"/>';
            if (i % cada === 0) s += '<text class="eje" x="' + (xb + banda / 2).toFixed(1) + '" y="' + (alto - 6) + '" text-anchor="middle">' + esc(p.corta) + '</text>';
            if (i === iPico) s += '<text class="marca" x="' + (xb + banda / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle">' + num(p.valor) + '</text>';
        });
        caja.innerHTML = s + '</svg>';
        caja.classList.add('rd-grafica--propia');
        const svg = caja.querySelector('svg');
        svg.addEventListener('pointermove', (e) => {
            const r = e.target.closest('.blanco');
            if (!r) { ocultarBurbuja(); return; }
            const p = puntos[Number(r.dataset.i)];
            mostrarBurbuja(e.clientX, e.clientY, p.larga, [{ valor: num(p.valor), nombre: op.unidad, color: op.color }]);
        });
        svg.addEventListener('pointerleave', ocultarBurbuja);
    }

    /* ---- Líneas en un solo eje ----
       La burbuja sigue al puntero y trae todas las líneas de ese día. */
    function lineasGrafica(caja, ejeX, series) {
        const ancho = Math.max(280, Math.floor(caja.clientWidth || 800));
        const alto = ancho < 600 ? 220 : 280;
        const m = { arriba: 16, derecha: 14, abajo: 26, izquierda: 38 };
        const w = ancho - m.izquierda - m.derecha, h = alto - m.arriba - m.abajo;
        const n = ejeX.length;
        const max = Math.max(0, ...series.flatMap((s) => s.valores));
        const tope = topeRedondo(max);
        const x = (i) => m.izquierda + (n === 1 ? w / 2 : (i * w) / (n - 1));
        const y = (v) => m.arriba + h - (v / tope) * h;
        const cada = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));

        let s = '<svg viewBox="0 0 ' + ancho + ' ' + alto + '" width="' + ancho + '" height="' + alto + '" role="img" aria-label="' +
            esc(series.map((se) => se.nombre + ': ' + num(se.valores.reduce((a, b) => a + b, 0))).join(', ')) + '">' +
            ejeY(ancho, m, h, tope);
        ejeX.forEach((p, i) => {
            if (i % cada === 0) s += '<text class="eje" x="' + x(i).toFixed(1) + '" y="' + (alto - 6) + '" text-anchor="middle">' + esc(p.corta) + '</text>';
        });
        series.forEach((se, k) => {
            const d = se.valores.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join('');
            // Relleno solo en la primera línea
            if (k === 0) s += '<path d="' + d + 'L' + x(n - 1).toFixed(1) + ',' + y(0) + 'L' + x(0).toFixed(1) + ',' + y(0) + 'Z" fill="' + se.color + '" opacity=".10"/>';
            s += '<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
            const ult = se.valores[n - 1];
            s += '<circle class="rd-punto-final" cx="' + x(n - 1).toFixed(1) + '" cy="' + y(ult).toFixed(1) + '" r="4" fill="' + se.color + '"/>';
        });
        s += '<line class="rd-cruz" x1="0" x2="0" y1="' + m.arriba + '" y2="' + (m.arriba + h) + '" visibility="hidden"/>';
        series.forEach((se, k) => { s += '<circle class="rd-punto-cruz" data-k="' + k + '" r="4.5" fill="' + se.color + '" visibility="hidden"/>'; });
        s += '<rect class="blanco" x="' + m.izquierda + '" y="' + m.arriba + '" width="' + w + '" height="' + h + '"/>';
        caja.innerHTML = s + '</svg>';
        caja.classList.add('rd-grafica--propia');

        const svg = caja.querySelector('svg');
        const cruz = svg.querySelector('.rd-cruz');
        const puntos = svg.querySelectorAll('.rd-punto-cruz');
        svg.addEventListener('pointermove', (e) => {
            const caja2 = svg.getBoundingClientRect();
            const px = ((e.clientX - caja2.left) / caja2.width) * ancho;
            const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - m.izquierda) / w) * (n - 1))));
            cruz.setAttribute('x1', x(i)); cruz.setAttribute('x2', x(i)); cruz.setAttribute('visibility', 'visible');
            puntos.forEach((c) => {
                const se = series[Number(c.dataset.k)];
                c.setAttribute('cx', x(i)); c.setAttribute('cy', y(se.valores[i])); c.setAttribute('visibility', 'visible');
            });
            mostrarBurbuja(e.clientX, e.clientY, ejeX[i].larga,
                series.map((se) => ({ valor: num(se.valores[i]), nombre: se.nombre.toLowerCase(), color: se.color })));
        });
        svg.addEventListener('pointerleave', () => {
            cruz.setAttribute('visibility', 'hidden');
            puntos.forEach((c) => c.setAttribute('visibility', 'hidden'));
            ocultarBurbuja();
        });
    }

    /* ---- Barras horizontales ---- */
    function barras(filas, unidad, color) {
        const max = Math.max(1, ...filas.map((f) => f.valor));
        return '<ul class="rd-barras">' + filas.map((f) =>
            '<li><div class="rd-barra__cab"><span class="rd-barra__nombre">' + esc(f.nombre) + '</span>' +
                '<span class="rd-barra__valor">' + f.texto + '</span></div>' +
                '<div class="rd-barra__pista"' + atributosBurbuja(f.nombre, num(f.valor), unidad, color) + '>' +
                    '<div class="rd-barra__lleno" style="width:' + ((f.valor / max) * 100).toFixed(2) + '%;background:' + color + '"></div></div>' +
                (f.nota ? '<div class="rd-barra__nota">' + f.nota + '</div>' : '') +
            '</li>').join('') + '</ul>';
    }

    /* ============ EL TABLERO ============ */
    function pintarTodo() {
        const d = datos;
        $('rd-rango-txt').textContent = d.desde === d.hasta ? fechaLarga(d.hasta)
            : 'Del ' + (d.desde.slice(0, 4) === d.hasta.slice(0, 4) ? fecha(d.desde, { day: 'numeric', month: 'long' }) : fechaLarga(d.desde)) +
              ' al ' + fechaLarga(d.hasta);
        pintarKpis();
        pintarMetas();
        pintarLineas();
        pintarPortal();
        pintarNota();
    }

    /* ---- Las tres cifras de arriba ---- */
    function pintarKpis() {
        const t = datos.totales || {}, a = datos.anteriores || {}, p = datos.portal || {};
        const frente = datos.dias === 1 ? 'frente al día anterior' : 'frente a los ' + datos.dias + ' días anteriores';
        const tarjetas = [
            { clave: 'portal_visita', valor: t.portal_visita, antes: a.portal_visita,
              pie: t.portal_visita ? 'Pantallas de ingreso abiertas' : 'Todavía sin visitas' },
            { clave: 'portal_ingreso', valor: p.ingresos, antes: p.ingresos_ant,
              pie: !p.personas ? 'Nadie ha entrado' : p.personas === 1 ? 'De una sola persona' : 'De ' + num(p.personas) + ' personas distintas' },
            { clave: 'portal_fallido', valor: t.portal_fallido, antes: a.portal_fallido,
              pie: t.portal_fallido ? 'Usuario o contraseña incorrectos' : 'Ninguno en este periodo' }
        ];
        $('rd-kpis').innerHTML = tarjetas.map((k) => {
            const v = k.valor || 0, antes = k.antes || 0;
            let comparacion;
            if (!antes && !v) comparacion = '<span class="rd-delta rd-delta--igual">Sin actividad todavía</span>';
            else if (!antes) comparacion = '<span class="rd-delta rd-delta--igual">Sin datos del periodo anterior</span>';
            else {
                const cambio = Math.round(((v - antes) / antes) * 100);
                comparacion = cambio === 0
                    ? '<span class="rd-delta rd-delta--igual">Igual</span> <span>' + frente + '</span>'
                    : '<span class="rd-delta rd-delta--' + (cambio > 0 ? 'sube' : 'baja') + '"><span aria-hidden="true">' + (cambio > 0 ? '▲' : '▼') + '</span>' +
                      '<span class="rd-sr">' + (cambio > 0 ? 'Subió ' : 'Bajó ') + '</span>' + Math.abs(cambio).toLocaleString('es-CO') + ' %</span> <span>' + frente + '</span>';
            }
            return '<div class="pt-panorama__caja rd-kpi">' +
                '<div class="pt-panorama__tit"><i class="rd-punto" style="background:' + COLOR[k.clave] + '" aria-hidden="true"></i>' + esc(NOMBRE[k.clave]) + '</div>' +
                '<div class="pt-panorama__num">' + num(v) + '</div>' +
                '<div class="rd-kpi__comp">' + comparacion + '</div>' +
                '<div class="pt-panorama__pie">' + esc(k.pie) + '</div>' +
                lineaMini(porDia(k.clave).map((q) => q.valor), COLOR[k.clave]) +
            '</div>';
        }).join('');
    }

    /* ---- Metas del mes: un anillo por meta ---- */
    // uno/varios para la cifra ("faltan 12 visitas"), unos para el género ("unas 600")
    const METAS = [
        { clave: 'portal_visitas', serie: 'portal_visita', nombre: 'Visitas al ingreso', uno: 'visita', varios: 'visitas', unos: 'unas' },
        { clave: 'portal_ingresos', serie: 'portal_ingreso', nombre: 'Ingresos al portal', uno: 'ingreso', varios: 'ingresos', unos: 'unos' }
    ];

    function pintarMetas() {
        const mes = datos.mes || {}, metas = datos.metas || {}, hoy = datos.hoy;
        const diasMes = diasEntre(mes.inicio, mes.fin) + 1;
        const corridos = hoy < mes.inicio ? 0 : (hoy > mes.fin ? diasMes : diasEntre(mes.inicio, hoy) + 1);
        const cerrado = hoy > mes.fin;
        const quedan = diasMes - corridos;
        $('rd-metas-titulo').textContent = 'Metas de ' + fecha(mes.inicio, { month: 'long', year: 'numeric' });
        $('rd-metas-sub').textContent = cerrado
            ? 'Este mes ya terminó. Así cerró cada meta.'
            : 'Vamos en el día ' + corridos + ' de ' + diasMes + '. La rayita de cada anillo marca hasta dónde deberías ir hoy para cumplir a fin de mes.';

        $('rd-metas').innerHTML = METAS.map((g) => {
            const meta = Number(metas[g.clave] || 0), real = Number(mes[g.clave] || 0);
            const color = COLOR[g.serie];
            if (!meta) {
                return '<div class="rd-meta">' + anillo(0, null, color, num(real), 'en el mes', true) +
                    '<div class="rd-meta__texto"><div class="rd-meta__nombre">' + esc(g.nombre) + '</div>' +
                    '<span class="rd-estado rd-estado--nada">Sin meta</span>' +
                    '<button type="button" class="rd-meta__fijar" data-rd-accion="fijar-meta">Fijar una meta</button></div></div>';
            }
            const esperado = meta * (corridos / diasMes);
            const proyeccion = corridos ? Math.round((real / corridos) * diasMes) : 0;
            let estado, clase;
            if (real >= meta) { estado = '<i aria-hidden="true">✓</i> Cumplida'; clase = 'bien'; }
            else if (cerrado) { estado = '<i aria-hidden="true">!</i> No se alcanzó'; clase = 'ojo'; }
            else if (real >= esperado * 0.95) { estado = 'Va bien'; clase = 'camino'; }
            else { estado = '<i aria-hidden="true">!</i> Va atrasada'; clase = 'ojo'; }
            const cuantos = (n) => plural(n, g.uno, g.varios);
            let pie;
            if (real > meta) pie = 'Se cumplió con ' + cuantos(real - meta) + ' de más.';
            else if (real === meta) pie = 'Se cumplió exactamente.';
            else if (cerrado) pie = 'Quedaron faltando ' + cuantos(meta - real) + '.';
            else {
                pie = 'Faltan ' + cuantos(meta - real) + (quedan === 0 ? ' y hoy es el último día.' : quedan === 1 ? ' y queda 1 día.' : ' y quedan ' + quedan + ' días.');
                if (corridos && quedan) pie += ' Al ritmo actual, el mes cerraría con ' + g.unos + ' ' + num(proyeccion) + '.';
            }
            const ritmo = !cerrado && corridos && real < meta ? esperado / meta : null;
            return '<div class="rd-meta" role="meter" aria-label="' + esc(g.nombre) + '" aria-valuemin="0" aria-valuemax="' + meta + '" aria-valuenow="' + Math.min(real, meta) + '">' +
                anillo(real / meta, ritmo, color, pct(real, meta), num(real) + ' de ' + num(meta)) +
                '<div class="rd-meta__texto"><div class="rd-meta__nombre">' + esc(g.nombre) + '</div>' +
                '<span class="rd-estado rd-estado--' + clase + '">' + estado + '</span>' +
                '<p class="rd-meta__pie">' + esc(pie) + '</p></div></div>';
        }).join('');
    }

    /* ---- Día a día ---- */
    function pintarLineas() {
        const claves = ['portal_visita', 'portal_ingreso', 'portal_fallido'];
        if (!claves.some((k) => lineas[k])) lineas.portal_visita = true;
        const crudos = {};
        claves.forEach((k) => { crudos[k] = porDia(k); });
        const semanal = crudos.portal_visita.length > 92;
        const ejeX = agrupar(crudos.portal_visita);
        const visibles = claves.filter((k) => lineas[k]).map((k) => ({
            clave: k, nombre: NOMBRE[k], color: COLOR[k], valores: agrupar(crudos[k]).map((p) => p.valor)
        }));

        $('rd-linea-leyenda').innerHTML = claves.map((k) =>
            '<button type="button" data-linea="' + k + '" aria-pressed="' + !!lineas[k] + '" class="' + (lineas[k] ? 'activo' : '') + '">' +
                '<i style="background:' + COLOR[k] + '" aria-hidden="true"></i>' + esc(NOMBRE[k]) + '</button>').join('');

        const total = crudos.portal_visita.reduce((a, p) => a + p.valor, 0);
        const promedio = (total / crudos.portal_visita.length).toLocaleString('es-CO', { maximumFractionDigits: 1 });
        $('rd-linea-sub').textContent = (total
            ? 'En este periodo hubo ' + plural(total, 'visita', 'visitas') + ' al ingreso' +
              (crudos.portal_visita.length > 1 ? ', unas ' + promedio + ' por día' : '') + '.'
            : 'En este periodo no hubo visitas al ingreso.') +
            (semanal ? ' Cada punto es una semana.' : '') + ' Toca un nombre para mostrar u ocultar su línea.';
        lineasGrafica($('rd-linea'), ejeX, visibles);

        const todas = claves;
        const cols = todas.map((k) => porDia(k));
        let filas = '';
        for (let i = cols[0].length - 1; i >= 0; i--) {
            filas += '<tr><td>' + esc(fecha(cols[0][i].dia, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })) + '</td>' +
                cols.map((c) => '<td class="num">' + num(c[i].valor) + '</td>').join('') + '</tr>';
        }
        $('rd-linea-tabla').innerHTML = '<div class="rd-tabla-envoltura"><table class="rd-tabla"><thead><tr><th>Día</th>' +
            todas.map((k) => '<th class="num">' + esc(NOMBRE[k]) + '</th>').join('') + '</tr></thead><tbody>' + filas + '</tbody></table></div>';
    }
    $('rd-linea-leyenda').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-linea]');
        if (!b || !datos) return;
        const k = b.dataset.linea;
        const encendidas = Object.keys(lineas).filter((x) => lineas[x]);
        if (lineas[k] && encendidas.length === 1) return;   // siempre queda una
        lineas[k] = !lineas[k];
        try { localStorage.setItem(CLAVE_LINEAS, JSON.stringify(lineas)); } catch (err) { /* nada */ }
        pintarLineas();
    });

    /* ---- Portal Documental ---- */
    const ROL = { cliente: 'Clientes', acreedor: 'Acreedores', operador: 'Operadores', monitor: 'Monitores' };
    function pintarPortal() {
        const t = datos.totales || {}, p = datos.portal || {};
        const caja = (eti, valor, extra) =>
            '<div class="pt-panorama__caja"><div class="pt-panorama__tit">' + esc(eti) + '</div>' +
            '<div class="pt-panorama__num">' + num(valor) + '</div>' +
            (extra ? '<div class="pt-panorama__pie">' + esc(extra) + '</div>' : '') + '</div>';
        const roles = p.por_rol || [];

        $('rd-portal').innerHTML =
            '<div class="rd-portal">' +
                '<div class="rd-portal__cifras">' +
                    caja('Visitas al ingreso', t.portal_visita) +
                    caja('Inicios de sesión', p.ingresos, p.personas ? (p.personas === 1 ? 'de 1 persona' : 'de ' + num(p.personas) + ' personas') : '') +
                    caja('Intentos fallidos', t.portal_fallido, t.portal_fallido ? 'usuario o contraseña incorrectos' : '') +
                '</div>' +
                '<div><p class="rd-subtitulo">Quién entra</p>' +
                    (roles.length ? barras(roles.map((r) => ({ nombre: ROL[r.rol] || r.rol, valor: r.n, texto: '<b>' + num(r.n) + '</b> · ' + pct(r.n, p.ingresos) })),
                        'inicios de sesión', COLOR.portal_ingreso)
                        : '<p class="rd-vacio">En este periodo nadie ha entrado al portal.</p>') + '</div>' +
                '<div><p class="rd-subtitulo">Inicios de sesión por día</p><div class="rd-grafica" id="rd-portal-dias"></div></div>' +
            '</div>' +
            '<div id="rd-fallidos"></div>';
        pintarFallidos(t.portal_fallido || 0);
        const dias = agrupar(porDia('portal_ingreso'));
        columnas($('rd-portal-dias'), dias, { color: COLOR.portal_ingreso, alto: 190, unidad: 'inicios de sesión', descripcion: 'Inicios de sesión en el portal por día' });
    }

    /* Cuentas con intentos fallidos en el periodo (migracion_intentos_fallidos.sql).
       Solo cuentas que existen; lo escrito en usuarios inexistentes no se guarda. */
    const ROL_UNO = { administrador: 'Administrador', monitor: 'Monitor', operador: 'Operador', cliente: 'Cliente', acreedor: 'Acreedor' };
    let _fallidosTurno = 0;
    async function pintarFallidos(total) {
        const caja = $('rd-fallidos');
        if (!caja || typeof window.intentosFallidosLeer !== 'function') return;
        const turno = ++_fallidosTurno;
        let filas;
        try {
            filas = await window.intentosFallidosLeer(datos.desde, datos.hasta);
        } catch (e) {
            // Sin la migración la tarjeta sigue igual, sin la lista
            if (turno === _fallidosTurno) caja.innerHTML = '';
            return;
        }
        if (turno !== _fallidosTurno) return;
        if (!filas.length) {
            caja.innerHTML = total
                ? '<p class="rd-fallidos__nota">Ningún intento fallido fue con una cuenta que exista: fueron usuarios mal escritos o que no están en el portal.</p>'
                : '';
            return;
        }
        const cuando = (iso) => new Date(iso).toLocaleString('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        caja.innerHTML = '<p class="rd-subtitulo">Cuentas con intentos fallidos</p>' +
            '<div class="rd-tabla-envoltura"><table class="rd-tabla"><thead><tr>' +
                '<th scope="col">Cuenta</th><th scope="col">Rol</th><th scope="col" class="num">Intentos</th><th scope="col">Último</th>' +
            '</tr></thead><tbody>' +
            filas.map((f) => '<tr><td><b>' + esc(f.nombre || f.usuario) + '</b> <span class="rd-fallidos__usuario">' + esc(f.usuario) + '</span></td>' +
                '<td>' + esc(ROL_UNO[f.rol] || f.rol || '') + '</td>' +
                '<td class="num">' + num(f.intentos) + '</td>' +
                '<td>' + esc(cuando(f.ultimo)) + '</td></tr>').join('') +
            '</tbody></table></div>' +
            '<p class="rd-fallidos__nota">Muchos intentos seguidos en una misma cuenta pueden ser alguien que olvidó la clave o alguien probando contraseñas.</p>';
    }

    /* ---- Nota al pie ---- */
    function pintarNota() {
        const hora = new Date().toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: ZONA });
        let txt = 'Las visitas al ingreso son anónimas: contamos cuántas veces pasa algo, nunca quién lo hace. ' +
            'Solo los intentos fallidos de cuentas del portal se nombran, como registro de seguridad. ' +
            'Cada pestaña abierta cuenta como una visita, así que recargar la página no la duplica. ' +
            'Los ingresos al portal se toman del registro de actividad y no incluyen a los administradores. ';
        if (!datos.primer_evento) {
            txt += 'Todavía no hay datos: las cifras empiezan a sumar en cuanto alguien abra la pantalla de ingreso.';
        } else {
            const desde = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date(datos.primer_evento));
            txt += 'Hay datos desde el ' + fechaLarga(desde) + '.' +
                (desde > datos.desde ? ' Los días anteriores aparecen en cero porque todavía no se medían.' : '');
        }
        // "p. m." ya trae punto
        $('rd-nota').textContent = txt + ' Última actualización: ' + hora + (/\.$/.test(hora) ? '' : '.');
    }

    /* ============ METAS: EDITAR ============ */
    const dialogo = $('rd-dialogo-metas');
    function abrirMetas() {
        const metas = (datos && datos.metas) || {};
        METAS.forEach((g) => { $('rd-meta-' + g.clave).value = metas[g.clave] || ''; });
        $('rd-metas-error').hidden = true;
        if (typeof dialogo.showModal === 'function') dialogo.showModal();
        else dialogo.setAttribute('open', '');
        $('rd-meta-portal_visitas').focus();
    }
    const cerrarMetas = () => { if (dialogo.open) dialogo.close(); };
    $('rd-btn-metas').addEventListener('click', abrirMetas);
    $('rd-metas').addEventListener('click', (e) => { if (e.target.closest('[data-rd-accion="fijar-meta"]')) abrirMetas(); });
    $('rd-metas-cancelar').addEventListener('click', cerrarMetas);
    $('rd-form-metas').addEventListener('submit', async (e) => {
        e.preventDefault();
        const valores = {};
        for (const g of METAS) {
            const v = $('rd-meta-' + g.clave).value.trim();
            const n = v === '' ? 0 : Math.floor(Number(v));
            if (!Number.isFinite(n) || n < 0 || n > 10000000) {
                $('rd-metas-error').textContent = 'En «' + g.nombre + '» escribe un número entero, de 0 en adelante.';
                $('rd-metas-error').hidden = false;
                $('rd-meta-' + g.clave).focus();
                return;
            }
            valores[g.clave] = String(n);
        }
        const boton = $('rd-metas-guardar');
        boton.disabled = true;
        boton.textContent = 'Guardando…';
        try {
            await window.metricasWebGuardarMetas(valores);
            cerrarMetas();
            await cargar();
        } catch (err) {
            $('rd-metas-error').textContent = /administrador/i.test(String(err && err.message))
                ? 'Solo un administrador puede cambiar las metas.'
                : 'No pudimos guardar las metas. Revisa tu conexión e inténtalo de nuevo.';
            $('rd-metas-error').hidden = false;
        } finally {
            boton.disabled = false;
            boton.textContent = 'Guardar metas';
        }
    });

    /* Redibuja al cambiar el ancho */
    let reloj = null;
    window.addEventListener('resize', () => {
        clearTimeout(reloj);
        reloj = setTimeout(() => { if (datos && !vista.hidden && !$('rd-tablero').hidden) pintarTodo(); }, 150);
    });
})();
