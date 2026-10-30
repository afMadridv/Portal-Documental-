/*! Portal Documental · hojas de cálculo para visor.html
  tabla(): la hoja con cara de Excel. pdf(): la misma hoja en PDF.
  .xlsx con ExcelJS (trae estilos); .xls, .ods y .csv con SheetJS.
  Todo lo que sale del archivo se escapa; enlaces solo http/https/mailto.
  No muestra imágenes, gráficos ni formato condicional.
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    const MAX_FILAS = 3000;
    const MAX_COLS = 200;
    const FILAS_EXTRA = 30;     // filas vacías debajo de los datos
    const COLS_EXTRA = 5;

    const esc = (t) => String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    /* ============ COLORES ============ */
    // Tema de Office 2013+: claro 1, oscuro 1, claro 2, oscuro 2, énfasis 1-6, enlaces
    const TEMA_OFFICE = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31',
                         'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
    // Paleta vieja de 64 colores ("indexed")
    const INDEXADOS = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
        '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
        '800000','008000','000080','808000','800080','008080','C0C0C0','808080',
        '9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
        '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF',
        '00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
        '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696',
        '003366','339966','003300','333300','993300','993366','333399','333333'];

    // Tema del libro o el de Office
    function temaDelLibro(wb) {
        try {
            const xml = wb._themes && Object.values(wb._themes)[0];
            if (!xml) return TEMA_OFFICE;
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const esquema = doc.getElementsByTagName('a:clrScheme')[0];
            if (!esquema) return TEMA_OFFICE;
            const leer = (nombre) => {
                const n = esquema.getElementsByTagName('a:' + nombre)[0];
                if (!n) return null;
                const srgb = n.getElementsByTagName('a:srgbClr')[0];
                const sys = n.getElementsByTagName('a:sysClr')[0];
                const v = srgb ? srgb.getAttribute('val') : sys ? sys.getAttribute('lastClr') : null;
                return /^[0-9A-Fa-f]{6}$/.test(v || '') ? v.toUpperCase() : null;
            };
            const orden = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3',
                           'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
            return orden.map((n, i) => leer(n) || TEMA_OFFICE[i]);
        } catch (e) { return TEMA_OFFICE; }
    }

    function aHsl(hex) {
        const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return [h / 6, s, l];
    }
    function deHsl(h, s, l) {
        const f = (p, q, t) => {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        let r, g, b;
        if (s === 0) { r = g = b = l; } else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
            r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
        }
        return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    // Tinte: positivo aclara, negativo oscurece
    function conTinte(hex, tinte) {
        if (!tinte) return hex;
        const [h, s, l] = aHsl(hex);
        return deHsl(h, s, tinte < 0 ? l * (1 + tinte) : l * (1 - tinte) + tinte);
    }
    // 'RRGGBB' o ''
    function colorHex(c, tema) {
        if (!c) return '';
        let hex = '';
        if (typeof c.argb === 'string' && /^[0-9A-Fa-f]{8}$/.test(c.argb)) hex = c.argb.slice(2);
        else if (typeof c.argb === 'string' && /^[0-9A-Fa-f]{6}$/.test(c.argb)) hex = c.argb;
        else if (Number.isInteger(c.theme) && tema[c.theme]) hex = conTinte(tema[c.theme], Number(c.tint) || 0);
        else if (Number.isInteger(c.indexed)) hex = c.indexed === 64 ? '000000' : c.indexed === 65 ? 'FFFFFF' : (INDEXADOS[c.indexed] || '');
        return /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : '';
    }

    /* ============ NÚMEROS ============ */
    // Miles con punto y decimales con coma, solo dentro de las cifras.
    const aColombia = (t) => String(t).replace(/\d[\d,]*(?:\.\d+)?/g,
        (m) => m.replace(/[.,]/g, (c) => (c === ',' ? '.' : ',')));

    // "General": hasta diez cifras, sin miles
    function general(n) {
        if (!Number.isFinite(n)) return String(n);
        if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
        const a = Math.abs(n);
        const s = (a >= 1e11 || (a > 0 && a < 1e-9))
            ? n.toExponential(5).replace('e+', 'E+').replace('e-', 'E-')
            : String(Number(n.toPrecision(10)));
        return s.replace('.', ',');
    }
    function conFormato(XLSX, valor, formato) {
        if (!formato || /^general$/i.test(formato)) return general(valor);
        try { return aColombia(XLSX.SSF.format(formato, valor)); } catch (e) { return general(valor); }
    }
    const serialDeFecha = (d) => d.getTime() / 86400000 + 25569;

    /* ============ EL MODELO ============
       Igual para las dos librerías: hojas con tamaños, ocultas, combinadas y
       celdas ya formateadas. `activa` = hoja al frente al guardar. */

    // ---- .xlsx con ExcelJS ----
    async function modeloExcelJS(buffer) {
        const ExcelJS = await cargarExcelJS();
        const XLSX = await cargarSheetJS();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        const tema = temaDelLibro(wb);
        const hojas = [];
        hojas.activa = 0;
        const alFrente = Number(wb.views && wb.views[0] && wb.views[0].activeTab) || 0;

        (wb.worksheets || []).forEach((ws, posicion) => {
            if (ws.state === 'hidden' || ws.state === 'veryHidden') return;
            if (posicion === alFrente) hojas.activa = hojas.length;
            const vista = (ws.views && ws.views[0]) || {};
            const props = ws.properties || {};
            const anchoBase = Number(props.defaultColWidth) || 8.43;
            const altoBase = Number(props.defaultRowHeight) || 15;

            // Última fila y columna con algo (o el borde de una combinada)
            let filas = 0, cols = 0;
            ws.eachRow({ includeEmpty: false }, (fila, n) => {
                if (n > filas) filas = n;
                fila.eachCell({ includeEmpty: false }, (celda, c) => { if (c > cols) cols = c; });
            });
            const combinadas = [];
            Object.values(ws._merges || {}).forEach((m) => {
                const r = m && m.model;
                if (!r || !r.top) return;
                combinadas.push({ top: r.top, left: r.left, bottom: r.bottom, right: r.right });
                filas = Math.max(filas, r.bottom);
                cols = Math.max(cols, r.right);
            });
            const recortada = filas > MAX_FILAS || cols > MAX_COLS;
            filas = Math.min(filas, MAX_FILAS);
            cols = Math.min(cols, MAX_COLS);

            // Más la cuadrícula vacía después de los datos
            const colsVista = Math.min(MAX_COLS, Math.max(cols + COLS_EXTRA, 12));
            const anchos = [], ocultasC = new Set();
            for (let c = 1; c <= colsVista; c++) {
                const col = ws.getColumn(c);
                if (col.hidden) ocultasC.add(c);
                anchos[c] = Math.round((Number(col.width) || anchoBase) * 7 + 5);
            }
            const altos = [], ocultasF = new Set();
            const celdas = new Map();
            for (let r = 1; r <= filas; r++) {
                const fila = ws.findRow ? ws.findRow(r) : ws.getRow(r);
                if (fila && fila.hidden) ocultasF.add(r);
                altos[r] = Math.round(((fila && Number(fila.height)) || altoBase) * 4 / 3);
                if (!fila) continue;
                for (let c = 1; c <= cols; c++) {
                    const celda = fila.findCell ? fila.findCell(c) : fila.getCell(c);
                    if (!celda) continue;
                    const dato = leerCeldaExcelJS(celda, XLSX, tema);
                    if (dato) celdas.set(r + ',' + c, dato);
                }
            }

            let imagenes = 0;
            try { imagenes = (ws.getImages ? ws.getImages() : []).length; } catch (e) { imagenes = 0; }

            hojas.push({ nombre: ws.name, filas, cols, anchos, altos, ocultasF, ocultasC, celdas, combinadas,
                         anchoBase: Math.round(anchoBase * 7 + 5), altoBase: Math.round(altoBase * 4 / 3),
                         cuadricula: vista.showGridLines !== false, imagenes, recortada });
        });
        if (hojas.activa >= hojas.length) hojas.activa = 0;
        return hojas;
    }

    function leerCeldaExcelJS(celda, XLSX, tema) {
        let v = celda.value;
        let texto = '', tipo = 's', corridas = null, enlace = '', formula = '';
        try { formula = typeof celda.formula === 'string' ? celda.formula : ''; } catch (e) { formula = ''; }
        if (v && typeof v === 'object' && !(v instanceof Date)) {
            if ('result' in v || 'formula' in v || 'sharedFormula' in v) v = v.result;
            else if (Array.isArray(v.richText)) { corridas = v.richText; v = v.richText.map((x) => x.text || '').join(''); }
            else if ('hyperlink' in v) { enlace = String(v.hyperlink || ''); v = v.text != null ? v.text : v.hyperlink; }
            else if ('error' in v) { v = v.error; tipo = 'e'; }
        }
        if (v && typeof v === 'object' && Array.isArray(v.richText)) { corridas = v.richText; v = v.richText.map((x) => x.text || '').join(''); }
        if (v && typeof v === 'object' && 'error' in v) { v = v.error; tipo = 'e'; }

        const formato = celda.numFmt || (celda.style && celda.style.numFmt) || '';
        if (v instanceof Date) { texto = conFormato(XLSX, serialDeFecha(v), formato || 'd/m/yyyy'); tipo = 'n'; }
        else if (typeof v === 'number') { texto = conFormato(XLSX, v, formato); tipo = 'n'; }
        else if (typeof v === 'boolean') { texto = v ? 'VERDADERO' : 'FALSO'; tipo = 'b'; }
        else if (v != null) texto = String(v);

        const st = celda.style || {};
        const e = estiloDe(st, tema);
        const bordes = bordesDe(st.border, tema);
        if (!texto && !e.fondo && !bordes) return null;
        // Texto con partes de distinto formato
        const partes = corridas && corridas.length > 1
            ? corridas.map((x) => ({ texto: String(x.text || ''), css: cssFuente(x.font, tema) })) : null;
        if (!/^(https?:|mailto:)/i.test(enlace)) enlace = '';
        return { texto, tipo, estilo: e, bordes, corridas: partes, enlace, formula };
    }

    // Fuente: solo letras, números, espacios y guiones
    const fuenteSegura = (n) => String(n || '').replace(/[^\w\s-]/g, '').slice(0, 40).trim();

    function estiloDe(st, tema) {
        const f = st.font || {};
        let fondo = '';
        const relleno = st.fill;
        if (relleno && relleno.type === 'pattern' && relleno.pattern && relleno.pattern !== 'none') {
            fondo = colorHex(relleno.fgColor, tema) || colorHex(relleno.bgColor, tema);
        } else if (relleno && relleno.type === 'gradient' && Array.isArray(relleno.stops) && relleno.stops[0]) {
            fondo = colorHex(relleno.stops[0].color, tema);
        }
        const al = st.alignment || {};
        return {
            fuente: fuenteSegura(f.name),
            negrita: !!f.bold, cursiva: !!f.italic,
            subrayado: !!f.underline, tachado: !!f.strike,
            tam: Number(f.size) > 0 && Number(f.size) < 100 ? Number(f.size) : 11,
            color: colorHex(f.color, tema), fondo,
            horizontal: { left: 'left', center: 'center', right: 'right', justify: 'left',
                          centerContinuous: 'center', distributed: 'center', fill: 'left' }[al.horizontal] || '',
            vertical: { top: 'top', middle: 'middle', bottom: 'bottom', justify: 'middle', distributed: 'middle' }[al.vertical] || 'bottom',
            ajustar: !!al.wrapText,
            indent: Math.min(15, Number(al.indent) || 0)
        };
    }

    // Grosor en puntos de cada borde (PDF). La tabla usa BORDE_CSS.
    const GROSOR = { hair: 0.25, thin: 0.5, dotted: 0.5, dashed: 0.5, dashDot: 0.5, dashDotDot: 0.5,
        medium: 1, mediumDashed: 1, mediumDashDot: 1, mediumDashDotDot: 1, slantDashDot: 1, thick: 1.6, double: 1.4 };
    function bordesDe(b, tema) {
        if (!b) return null;
        const uno = (x) => (x && GROSOR[x.style]) ? { tipo: x.style, ancho: GROSOR[x.style],
            color: colorHex(x.color, tema) || '000000', punteado: /dot|dash/i.test(x.style) } : null;
        const r = { top: uno(b.top), right: uno(b.right), bottom: uno(b.bottom), left: uno(b.left) };
        return (r.top || r.right || r.bottom || r.left) ? r : null;
    }

    // CSV de Excel en español suele venir en Windows-1252
    function textoCsv(buffer) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch (e) { return new TextDecoder('windows-1252').decode(buffer); }
    }

    // ---- .xls, .ods, .csv (y respaldo de .xlsx) con SheetJS ----
    async function modeloSheetJS(buffer, ext) {
        const XLSX = await cargarSheetJS();
        const libro = ext === 'csv'
            // Fechas del CSV como fechas, no como número de serie
            ? XLSX.read(textoCsv(buffer), { type: 'string', raw: false, cellDates: true, dateNF: 'dd/mm/yyyy' })
            : XLSX.read(buffer, { type: 'array', cellStyles: true, cellNF: true, cellDates: false });
        const hojas = [];
        hojas.activa = 0;
        const vistaLibro = libro.Workbook && libro.Workbook.WBView && libro.Workbook.WBView[0];
        const alFrente = Number(vistaLibro && vistaLibro.activeTab) || 0;
        const estiloBase = { fuente: '', negrita: false, cursiva: false, subrayado: false, tachado: false, tam: 11,
                             color: '', fondo: '', horizontal: '', vertical: 'bottom', ajustar: false, indent: 0 };
        libro.SheetNames.forEach((nombre, i) => {
            const info = (libro.Workbook && libro.Workbook.Sheets && libro.Workbook.Sheets[i]) || {};
            if (info.Hidden) return;
            if (i === alFrente) hojas.activa = hojas.length;
            const ws = libro.Sheets[nombre];
            const rango = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { e: { r: -1, c: -1 } };
            let filas = rango.e.r + 1, cols = rango.e.c + 1;
            const combinadas = (ws['!merges'] || []).map((m) => ({ top: m.s.r + 1, left: m.s.c + 1, bottom: m.e.r + 1, right: m.e.c + 1 }));
            const recortada = filas > MAX_FILAS || cols > MAX_COLS;
            filas = Math.min(filas, MAX_FILAS);
            cols = Math.min(cols, MAX_COLS);
            const colsVista = Math.min(MAX_COLS, Math.max(cols + COLS_EXTRA, 12));
            const anchos = [], altos = [], ocultasC = new Set(), ocultasF = new Set();
            for (let c = 1; c <= colsVista; c++) {
                const d = (ws['!cols'] || [])[c - 1] || {};
                if (d.hidden) ocultasC.add(c);
                anchos[c] = Math.round(d.wpx || (d.wch ? d.wch * 7 + 5 : 64));
            }
            for (let r = 1; r <= filas; r++) {
                const d = (ws['!rows'] || [])[r - 1] || {};
                if (d.hidden) ocultasF.add(r);
                altos[r] = Math.round(d.hpx || (d.hpt ? d.hpt * 4 / 3 : 20));
            }
            const celdas = new Map();
            for (let r = 1; r <= filas; r++) {
                for (let c = 1; c <= cols; c++) {
                    const x = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
                    if (!x || x.v == null) continue;
                    let texto, tipo = 's';
                    if (x.t === 'n') { texto = x.z && !/^general$/i.test(x.z) ? conFormato(XLSX, x.v, x.z) : general(x.v); tipo = 'n'; }
                    else if (x.t === 'b') { texto = x.v ? 'VERDADERO' : 'FALSO'; tipo = 'b'; }
                    else if (x.t === 'e') { texto = x.w || String(x.v); tipo = 'e'; }
                    else if (x.t === 'd') { texto = x.w || String(x.v); tipo = 'n'; }
                    else texto = String(x.w != null ? x.w : x.v);
                    celdas.set(r + ',' + c, { texto, tipo, estilo: estiloBase, bordes: null, corridas: null, enlace: '',
                                              formula: typeof x.f === 'string' ? x.f : '' });
                }
            }
            hojas.push({ nombre, filas, cols, anchos, altos, ocultasF, ocultasC, celdas, combinadas,
                         anchoBase: 64, altoBase: 20, cuadricula: true, imagenes: 0, recortada });
        });
        if (hojas.activa >= hojas.length) hojas.activa = 0;
        return hojas;
    }

    /* ============ LA TABLA CON CARA DE EXCEL ============ */
    // CSS de fuente. Lo que entra ya viene validado.
    function cssFuente(f, tema) {
        if (!f) return '';
        let s = '';
        const nombre = fuenteSegura(f.name);
        if (nombre) s += 'font-family:"' + nombre + '",Calibri,Carlito,"Segoe UI",Arial,sans-serif;';
        if (Number(f.size) > 0 && Number(f.size) < 100) s += 'font-size:' + Number(f.size) + 'pt;';
        if (f.bold) s += 'font-weight:700;';
        if (f.italic) s += 'font-style:italic;';
        const deco = [f.underline ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
        if (deco) s += 'text-decoration:' + deco + ';';
        const color = colorHex(f.color, tema);
        if (color) s += 'color:#' + color + ';';
        return s;
    }
    function cssCelda(e) {
        let s = '';
        if (e.fuente) s += 'font-family:"' + e.fuente + '",Calibri,Carlito,"Segoe UI",Arial,sans-serif;';
        if (e.tam !== 11) s += 'font-size:' + e.tam + 'pt;';
        if (e.negrita) s += 'font-weight:700;';
        if (e.cursiva) s += 'font-style:italic;';
        const deco = [e.subrayado ? 'underline' : '', e.tachado ? 'line-through' : ''].filter(Boolean).join(' ');
        if (deco) s += 'text-decoration:' + deco + ';';
        if (e.color) s += 'color:#' + e.color + ';';
        if (e.fondo) s += 'background:#' + e.fondo + ';';
        return s;
    }
    const BORDE_CSS = { thin: '1px solid', hair: '1px solid', dotted: '1px dotted', dashed: '1px dashed',
        dashDot: '1px dashed', dashDotDot: '1px dotted', medium: '2px solid', mediumDashed: '2px dashed',
        mediumDashDot: '2px dashed', mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed',
        thick: '3px solid', double: '3px double' };
    const bordeCss = (b) => b ? (BORDE_CSS[b.tipo] || '1px solid') + ' #' + b.color : '';

    function contenidoCelda(d) {
        if (d.corridas) {
            return d.corridas.map((x) => x.css ? '<span style="' + esc(x.css) + '">' + esc(x.texto) + '</span>' : esc(x.texto)).join('');
        }
        const t = esc(d.texto);
        if (d.enlace) return '<a href="' + esc(d.enlace) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
        return t;
    }

    /* Tabla de una hoja: letras arriba, números a la izquierda (fijos).
       Cada celda lleva data-rc="fila,columna". */
    function tabla(h) {
        const ancho = (c) => h.anchos[c] || h.anchoBase;
        const alto = (r) => h.altos[r] || h.altoBase;
        const filasVista = Math.min(MAX_FILAS, Math.max(h.filas + FILAS_EXTRA, 40));
        // Columnas vacías hasta llenar la pantalla
        let colsVista = Math.min(MAX_COLS, Math.max(h.cols + COLS_EXTRA, 12));
        let anchoUsado = 0;
        for (let c = 1; c <= colsVista; c++) if (!h.ocultasC.has(c)) anchoUsado += ancho(c);
        while (anchoUsado < 2200 && colsVista < MAX_COLS) {
            colsVista++;
            if (!h.ocultasC.has(colsVista)) anchoUsado += ancho(colsVista);
        }

        // Combinadas: se estira la de arriba a la izquierda
        const tapadas = new Set(), maestras = new Map();
        h.combinadas.forEach((m) => {
            if (m.top > filasVista || m.left > colsVista) return;
            const bottom = Math.min(m.bottom, filasVista), right = Math.min(m.right, colsVista);
            let filas = 0, cols = 0;
            for (let r = m.top; r <= bottom; r++) if (!h.ocultasF.has(r)) filas++;
            for (let c = m.left; c <= right; c++) if (!h.ocultasC.has(c)) cols++;
            maestras.set(m.top + ',' + m.left, { filas, cols, bottom, right });
            for (let r = m.top; r <= bottom; r++) {
                for (let c = m.left; c <= right; c++) if (r !== m.top || c !== m.left) tapadas.add(r + ',' + c);
            }
        });

        // Cada celda pinta su borde derecho e inferior; el de arriba y el
        // izquierdo los pone la vecina. Así no salen dobles.
        const borde = (r, c, lado) => {
            const d = h.celdas.get(r + ',' + c);
            return d && d.bordes ? bordeCss(d.bordes[lado]) : '';
        };
        const GRIS = h.cuadricula ? '1px solid #E2E2E2' : '1px solid transparent';

        const visiblesC = [];
        for (let c = 1; c <= colsVista; c++) if (!h.ocultasC.has(c)) visiblesC.push(c);
        const anchoTotal = 46 + visiblesC.reduce((s, c) => s + ancho(c), 0);

        const partes = ['<table class="hx-tabla" style="width:' + anchoTotal + 'px"><colgroup><col style="width:46px">'];
        visiblesC.forEach((c) => partes.push('<col style="width:' + ancho(c) + 'px">'));
        partes.push('</colgroup><thead><tr><th class="hx-esquina"></th>');
        visiblesC.forEach((c) => partes.push('<th data-col="' + c + '">' + letras(c) + '</th>'));
        partes.push('</tr></thead><tbody>');

        for (let r = 1; r <= filasVista; r++) {
            if (h.ocultasF.has(r)) continue;
            let fila = '<tr style="height:' + alto(r) + 'px"><th>' + r + '</th>';
            visiblesC.forEach((c, i) => {
                const clave = r + ',' + c;
                if (tapadas.has(clave)) return;
                const d = h.celdas.get(clave);
                const m = maestras.get(clave);
                const der = m ? m.right : c, aba = m ? m.bottom : r;
                const bDer = borde(r, der, 'right') || borde(r, der + 1, 'left') || GRIS;
                const bAba = borde(aba, c, 'bottom') || borde(aba + 1, c, 'top') || GRIS;
                let css = 'border-right:' + bDer + ';border-bottom:' + bAba + ';';
                if (r === 1 && borde(r, c, 'top')) css += 'border-top:' + borde(r, c, 'top') + ';';
                if (c === 1 && borde(r, c, 'left')) css += 'border-left:' + borde(r, c, 'left') + ';';
                let clase = '';
                if (d) {
                    const e = d.estilo;
                    css += cssCelda(e);
                    const alinear = e.horizontal || (d.tipo === 'n' ? 'right' : (d.tipo === 'b' || d.tipo === 'e') ? 'center' : '');
                    if (alinear) css += 'text-align:' + alinear + ';';
                    if (e.vertical !== 'bottom') css += 'vertical-align:' + e.vertical + ';';
                    if (e.indent) css += 'padding-left:' + (3 + e.indent * 9) + 'px;';
                    if (e.ajustar) clase = 'hx-ajusta';
                    else if (d.texto && (!alinear || alinear === 'left') && !m) {
                        // Texto largo se sale a la derecha si la vecina está vacía
                        const vecina = visiblesC[i + 1] ? h.celdas.get(r + ',' + visiblesC[i + 1]) : null;
                        if (!vecina || !vecina.texto) clase = 'hx-desborda';
                    }
                }
                const expande = m ? (m.cols > 1 ? ' colspan="' + m.cols + '"' : '') + (m.filas > 1 ? ' rowspan="' + m.filas + '"' : '') : '';
                fila += '<td data-rc="' + clave + '"' + expande + (clase ? ' class="' + clase + '"' : '') +
                    ' style="' + esc(css) + '">' + (d ? contenidoCelda(d) : '') + '</td>';
            });
            partes.push(fila + '</tr>');
        }
        partes.push('</tbody></table>');
        return partes.join('');
    }

    /* ============ EL PDF ============ */
    const PAGINA = { ancho: 595.28, alto: 841.89 };   // A4 en puntos
    const MARGEN = 28;
    const CABECERA = 30;    // nombre de hoja y archivo
    const PIE = 20;         // número de página
    const ANCHO_NUM = 24;   // columna de números de fila
    const ALTO_LETRAS = 13; // fila de letras de columna
    const GRIS_LINEA = 'D9D9D9';
    const GRIS_ENCAB = 'F2F2F2';

    // Las fuentes estándar del PDF solo tienen latín de Windows: lo demás sale como ?.
    const EXTRA_WINANSI = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
    function textoPdf(t) {
        let s = '';
        for (const ch of String(t)) {
            const c = ch.codePointAt(0);
            if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || EXTRA_WINANSI.includes(ch)) s += ch;
            else if (ch === '\t' || ch === '\n' || ch === '\r') s += ' ';
            else s += '?';
        }
        return s;
    }

    async function armarPdf(nombreArchivo, hojas) {
        const L = await cargarPdfLib();
        const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = L;
        const doc = await PDFDocument.create();
        doc.setTitle(nombreArchivo);
        doc.setCreator('Portal Documental');
        doc.setProducer('Portal Documental');
        const F = {
            normal: await doc.embedFont(StandardFonts.Helvetica),
            negrita: await doc.embedFont(StandardFonts.HelveticaBold),
            cursiva: await doc.embedFont(StandardFonts.HelveticaOblique),
            negritaCursiva: await doc.embedFont(StandardFonts.HelveticaBoldOblique)
        };
        const color = (hex) => rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
        const fuenteDe = (e) => e.negrita ? (e.cursiva ? F.negritaCursiva : F.negrita) : (e.cursiva ? F.cursiva : F.normal);
        const paginasDeHoja = [];   // para el pie de página

        for (const h of hojas) {
            const visiblesC = [];
            for (let c = 1; c <= h.cols; c++) if (!h.ocultasC.has(c)) visiblesC.push(c);
            const visiblesF = [];
            for (let r = 1; r <= h.filas; r++) if (!h.ocultasF.has(r)) visiblesF.push(r);

            // Vertical si cabe; si no, horizontal; si tampoco, ajustada al ancho.
            const anchoTabla = ANCHO_NUM + visiblesC.reduce((s, c) => s + h.anchos[c] * 0.75, 0);
            const utilV = PAGINA.ancho - 2 * MARGEN, utilH = PAGINA.alto - 2 * MARGEN;
            let apaisada = false, escala = 1;
            if (anchoTabla > utilV / 0.88) {
                apaisada = true;
                if (anchoTabla > utilH) escala = Math.max(0.3, utilH / anchoTabla);
            } else if (anchoTabla > utilV) {
                // Si le falta poco, se achica hasta 12 % antes de voltear
                escala = utilV / anchoTabla;
            }
            const [PW, PH] = apaisada ? [PAGINA.alto, PAGINA.ancho] : [PAGINA.ancho, PAGINA.alto];
            const x0 = MARGEN;
            const anchoCol = (c) => h.anchos[c] * 0.75 * escala;
            const xCol = new Map();
            let xAcum = x0 + ANCHO_NUM * escala;
            visiblesC.forEach((c) => { xCol.set(c, xAcum); xAcum += anchoCol(c); });
            const xFin = xAcum;
            const altoFila = (r) => h.altos[r] * 0.75 * escala;

            // Combinadas: se estira la de arriba a la izquierda
            const tapadas = new Set(), maestras = new Map();
            h.combinadas.forEach((m) => {
                if (m.top > h.filas || m.left > h.cols) return;
                const bottom = Math.min(m.bottom, h.filas), right = Math.min(m.right, h.cols);
                maestras.set(m.top + ',' + m.left, { bottom, right });
                for (let r = m.top; r <= bottom; r++) {
                    for (let c = m.left; c <= right; c++) if (r !== m.top || c !== m.left) tapadas.add(r + ',' + c);
                }
            });
            const anchoHasta = (c1, c2) => visiblesC.filter((c) => c >= c1 && c <= c2).reduce((s, c) => s + anchoCol(c), 0);
            const altoHasta = (r1, r2) => visiblesF.filter((r) => r >= r1 && r <= r2).reduce((s, r) => s + altoFila(r), 0);

            let pagina = null, y = 0;
            const nuevaPagina = () => {
                pagina = doc.addPage([PW, PH]);
                paginasDeHoja.push({ pagina, hoja: h.nombre, PW });
                // Cabecera: hoja a la izquierda, archivo a la derecha
                pagina.drawText(textoPdf(h.nombre), { x: x0, y: PH - MARGEN - 12, size: 11, font: F.negrita, color: color('222222') });
                const arch = textoPdf(nombreArchivo);
                const anchoArch = F.normal.widthOfTextAtSize(arch, 8);
                pagina.drawText(arch, { x: PW - MARGEN - anchoArch, y: PH - MARGEN - 11, size: 8, font: F.normal, color: color('888888') });
                y = PH - MARGEN - CABECERA;
                // Letras de columna en cada página
                const hL = ALTO_LETRAS * Math.max(escala, 0.7);
                pagina.drawRectangle({ x: x0, y: y - hL, width: xFin - x0, height: hL, color: color(GRIS_ENCAB) });
                visiblesC.forEach((c) => {
                    const letra = letras(c);
                    const tam = 7 * Math.max(escala, 0.7);
                    const w = F.normal.widthOfTextAtSize(letra, tam);
                    if (w < anchoCol(c)) {
                        pagina.drawText(letra, { x: xCol.get(c) + (anchoCol(c) - w) / 2, y: y - hL + (hL - tam) / 2 + tam * 0.2, size: tam, font: F.normal, color: color('777777') });
                    }
                    pagina.drawLine({ start: { x: xCol.get(c), y }, end: { x: xCol.get(c), y: y - hL }, thickness: 0.4, color: color('C8C8C8') });
                });
                y -= hL;
            };
            nuevaPagina();

            const avisos = [];
            if (h.imagenes) avisos.push('Esta hoja tiene imágenes o gráficos que aquí no se muestran. Descarga el archivo para verlos.');
            if (h.recortada) avisos.push('La hoja es muy grande: se muestran las primeras ' + MAX_FILAS + ' filas y ' + MAX_COLS + ' columnas.');
            if (!visiblesF.length || !visiblesC.length) avisos.push('La hoja no tiene datos.');
            avisos.forEach((a) => {
                pagina.drawText(textoPdf(a), { x: x0, y: y - 12, size: 8.5, font: F.cursiva, color: color('8A4B08') });
                y -= 14;
            });

            const limite = MARGEN + PIE;
            for (const r of visiblesF) {
                const hF = altoFila(r);
                if (y - hF < limite) nuevaPagina();
                const yTop = y, yBot = y - hF;

                // Número de fila
                pagina.drawRectangle({ x: x0, y: yBot, width: ANCHO_NUM * escala, height: hF, color: color(GRIS_ENCAB) });
                const numTxt = String(r), tamNum = Math.min(7 * Math.max(escala, 0.7), hF * 0.7);
                const wNum = F.normal.widthOfTextAtSize(numTxt, tamNum);
                pagina.drawText(numTxt, { x: x0 + (ANCHO_NUM * escala - wNum) / 2, y: yBot + (hF - tamNum) / 2 + tamNum * 0.2, size: tamNum, font: F.normal, color: color('777777') });

                // 1) fondos y cuadrícula
                const celdasFila = [];
                visiblesC.forEach((c, i) => {
                    const clave = r + ',' + c;
                    if (tapadas.has(clave)) return;
                    const d = h.celdas.get(clave);
                    const m = maestras.get(clave);
                    const w = m ? anchoHasta(c, m.right) : anchoCol(c);
                    const hh = m ? altoHasta(r, m.bottom) : hF;
                    const x = xCol.get(c), yb = yTop - hh;
                    if (d && d.estilo.fondo) pagina.drawRectangle({ x, y: yb, width: w, height: hh, color: color(d.estilo.fondo) });
                    if (h.cuadricula) {
                        // Solo borde: sin color, pdf-lib no rellena
                        pagina.drawRectangle({ x, y: yb, width: w, height: hh, borderColor: color(GRIS_LINEA), borderWidth: 0.3 });
                    }
                    celdasFila.push({ c, i, d, m, x, yb, w, hh });
                });

                // 2) textos, recortados a la celda (o a las vecinas vacías)
                celdasFila.forEach(({ c, i, d, m, x, yb, w, hh }) => {
                    if (!d || !d.texto) return;
                    const e = d.estilo;
                    const fuente = fuenteDe(e);
                    const tam = Math.max(4, e.tam * escala * 0.92);
                    const alinear = e.horizontal || (d.tipo === 'n' ? 'right' : (d.tipo === 'b' || d.tipo === 'e') ? 'center' : 'left');
                    const pad = 2 * escala + (alinear === 'left' ? e.indent * 6 * escala : 0);
                    let anchoDisp = w;
                    if (!e.ajustar && !m && alinear === 'left') {
                        for (let k = i + 1; k < visiblesC.length; k++) {
                            const vc = visiblesC[k], vd = h.celdas.get(r + ',' + vc);
                            if ((vd && vd.texto) || tapadas.has(r + ',' + vc) || maestras.has(r + ',' + vc)) break;
                            anchoDisp += anchoCol(vc);
                        }
                    }
                    let lineas;
                    if (e.ajustar) {
                        lineas = [];
                        String(d.texto).split(/\r?\n/).forEach((parrafo) => {
                            let linea = '';
                            textoPdf(parrafo).split(' ').forEach((palabra) => {
                                const prueba = linea ? linea + ' ' + palabra : palabra;
                                if (linea && fuente.widthOfTextAtSize(prueba, tam) > w - 2 * pad) { lineas.push(linea); linea = palabra; }
                                else linea = prueba;
                            });
                            lineas.push(linea);
                        });
                    } else {
                        lineas = [textoPdf(String(d.texto).replace(/\r?\n/g, ' '))];
                    }
                    const altoLinea = tam * 1.18;
                    const altoTexto = lineas.length * altoLinea;
                    let yBase;
                    if (e.vertical === 'top') yBase = yb + hh - pad - tam * 0.9;
                    else if (e.vertical === 'middle') yBase = yb + (hh + altoTexto) / 2 - tam * 0.95;
                    else yBase = yb + pad + tam * 0.22 + (lineas.length - 1) * altoLinea;
                    const tinta = color(e.color || '000000');

                    pagina.pushOperators(pushGraphicsState(), rectangle(x, yb, anchoDisp, hh), clip(), endPath());
                    lineas.forEach((ln, k) => {
                        const wt = fuente.widthOfTextAtSize(ln, tam);
                        let xt = x + pad;
                        if (alinear === 'right') xt = x + w - pad - wt;
                        else if (alinear === 'center') xt = x + (w - wt) / 2;
                        pagina.drawText(ln, { x: xt, y: yBase - k * altoLinea, size: tam, font: fuente, color: tinta });
                    });
                    pagina.pushOperators(popGraphicsState());
                });

                // 3) bordes del archivo, encima de todo
                celdasFila.forEach(({ c, d, m, x, yb, w, hh }) => {
                    // El borde puede venir en la celda o en la vecina
                    const b = (rr, cc) => { const x2 = h.celdas.get(rr + ',' + cc); return x2 && x2.bordes; };
                    const der = m ? m.right : c, aba = m ? m.bottom : r;
                    const lados = {
                        top: (d && d.bordes && d.bordes.top) || (b(r - 1, c) && b(r - 1, c).bottom),
                        left: (d && d.bordes && d.bordes.left) || (b(r, c - 1) && b(r, c - 1).right),
                        right: (b(r, der) && b(r, der).right) || (b(r, der + 1) && b(r, der + 1).left),
                        bottom: (b(aba, c) && b(aba, c).bottom) || (b(aba + 1, c) && b(aba + 1, c).top)
                    };
                    const linea = (x1, y1, x2, y2, t) => t && pagina.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
                        thickness: t.ancho * Math.max(escala, 0.6), color: color(t.color),
                        dashArray: t.punteado ? [2, 1.5] : undefined });
                    linea(x, yb + hh, x + w, yb + hh, lados.top);
                    linea(x, yb, x + w, yb, lados.bottom);
                    linea(x, yb, x, yb + hh, lados.left);
                    linea(x + w, yb, x + w, yb + hh, lados.right);
                });

                y = yBot;
            }
        }

        if (!doc.getPageCount()) {
            const p = doc.addPage([PAGINA.ancho, PAGINA.alto]);
            p.drawText('El libro no tiene hojas visibles.', { x: MARGEN, y: PAGINA.alto - MARGEN - 20, size: 11, font: F.normal });
        }

        // Pie: "Página n de N"
        const total = doc.getPageCount();
        doc.getPages().forEach((p, i) => {
            const t = 'Página ' + (i + 1) + ' de ' + total;
            const w = F.normal.widthOfTextAtSize(t, 7.5);
            p.drawText(t, { x: p.getWidth() - MARGEN - w, y: MARGEN - 12, size: 7.5, font: F.normal, color: color('999999') });
        });
        return doc.save();
    }

    function letras(c) {
        let s = '';
        while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
        return s;
    }

    /* ============ ENTRADA ============ */
    /* Lee el libro y devuelve las hojas visibles. Lanza error si no puede. */
    async function leer(nombre, blob) {
        const ext = String(nombre || '').split('.').pop().toLowerCase();
        const buffer = await blob.arrayBuffer();
        if (ext === 'xlsx') {
            try {
                return await modeloExcelJS(buffer);
            } catch (e) {
                console.warn('ExcelJS no pudo leer la hoja; se usa SheetJS:', e && e.message);
            }
        }
        const hojas = await modeloSheetJS(buffer, ext);
        // CSV: una hoja con el nombre del archivo, como Excel
        if (ext === 'csv' && hojas[0]) hojas[0].nombre = String(nombre).replace(/\.csv$/i, '');
        return hojas;
    }

    window.VisorHojas = { leer, tabla, pdf: armarPdf, letras, MAX_FILAS, MAX_COLS };
})();
