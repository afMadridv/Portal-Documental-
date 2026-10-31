// Capturas del portal con datos inventados (modo práctica), para la página de
// inicio y para el video. Usa Edge sin ventana por el protocolo DevTools.
//   node capturas.mjs        (o: npm run capturas)
// Salidas: ../sitio/img/inicio/ (las que usa la página) y public/capturas/ (todas).
// Otra ruta de Edge o Chrome: variable NAVEGADOR.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SITIO = path.join(AQUI, '..', 'sitio');
const WEB = path.join(SITIO, 'img', 'inicio');
const VIDEO = path.join(AQUI, 'public', 'capturas');
const NAVEGADOR = process.env.NAVEGADOR || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EN_LA_PAGINA = ['01-oficinas', '02-carpetas', '03-documentos', '04-estados', '05-audiencias', 'm-cliente-carpeta'];
const PUERTO = 8741, DEPURAR = 9333;
const BASE = `http://127.0.0.1:${PUERTO}/portal/`;

// Copia del sitio en modo práctica: sin Supabase, con los datos de ejemplo de db.js
const PRACTICA = fs.mkdtempSync(path.join(os.tmpdir(), 'legajo-practica-'));
fs.cpSync(SITIO, PRACTICA, { recursive: true, filter: (o) => !o.includes(path.join('manual', 'videos')) && !o.endsWith('.mp4') });
const config = path.join(PRACTICA, 'portal', 'js', 'config.js');
fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(/SUPABASE_URL: '[^']*'/, "SUPABASE_URL: ''"));
fs.mkdirSync(WEB, { recursive: true });
fs.mkdirSync(VIDEO, { recursive: true });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const servidor = spawn('python', ['-m', 'http.server', String(PUERTO), '-d', PRACTICA], { stdio: 'ignore' });
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'legajo-capturas-'));
const navegador = spawn(NAVEGADOR, ['--headless=new', `--remote-debugging-port=${DEPURAR}`, `--user-data-dir=${perfil}`,
    '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--force-color-profile=srgb', '--lang=es-CO', 'about:blank'], { stdio: 'ignore' });

let ws, n = 0;
const pendientes = new Map();
const errores = [];
function terminar(codigo) {
    try { ws && ws.close(); } catch { }
    navegador.kill(); servidor.kill();
    process.exit(codigo);
}
async function conectar() {
    for (let i = 0; i < 40; i++) {
        try {
            const lista = await (await fetch(`http://127.0.0.1:${DEPURAR}/json/list`)).json();
            const pagina = lista.find((t) => t.type === 'page');
            if (pagina) return pagina.webSocketDebuggerUrl;
        } catch { }
        await esperar(250);
    }
    throw new Error('El navegador no abrió el puerto de depuración');
}
const cdp = (method, params = {}) => new Promise((ok, mal) => {
    const id = ++n;
    pendientes.set(id, { ok, mal });
    ws.send(JSON.stringify({ id, method, params }));
});
async function evaluar(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(expr.slice(0, 70) + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
}
async function hasta(expr, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await evaluar(expr)) return; } catch { }
        await esperar(250);
    }
    throw new Error('No llegó: ' + expr);
}
let ancho = 1440, alto = 900;
async function tamano(w, h, dpr, movil = false) {
    ancho = w; alto = h;
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: movil });
}
async function ir(url) {
    await cdp('Page.navigate', { url });
    await esperar(700);
    await hasta('document.readyState === "complete"');
}

// Sin animaciones ni avisos que tapen
const QUIETO = `(() => { if (document.getElementById('captura-quieta')) return true; const s = document.createElement('style'); s.id = 'captura-quieta';
  s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important} .pt-toast,#modal-cierre-tramite{display:none!important}';
  document.head.appendChild(s); return true; })()`;

// Video a 2x; la página, más liviana
async function foto(nombre, escalaWeb = 0.75) {
    await evaluar(QUIETO);
    await esperar(600);
    const v = await cdp('Page.captureScreenshot', { format: 'webp', quality: 90 });
    fs.writeFileSync(path.join(VIDEO, nombre + '.webp'), Buffer.from(v.data, 'base64'));
    if (EN_LA_PAGINA.includes(nombre)) {
        const w = await cdp('Page.captureScreenshot', {
            format: 'webp', quality: 82, clip: { x: 0, y: 0, width: ancho, height: alto, scale: escalaWeb },
        });
        fs.writeFileSync(path.join(WEB, nombre + '.webp'), Buffer.from(w.data, 'base64'));
    }
    console.log('foto', nombre);
}

async function entrar(usuario, clave) {
    await evaluar(`localStorage.removeItem('portal_sesion'); sessionStorage.clear(); true`).catch(() => { });
    await ir(BASE);
    await hasta(`!!document.getElementById('form-login')`);
    await evaluar(`document.getElementById('campo-usuario').value = '${usuario}';
        document.getElementById('campo-clave').value = '${clave}';
        document.getElementById('form-login').requestSubmit(); true`);
    // El portal deja la barra en /portal/: se reconoce porque ya cargó app.js
    await hasta(`typeof abrirCarpeta === 'function' && document.readyState === 'complete'`);
    await esperar(1500);
}
const clic = (sel) => evaluar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('falta ${sel}'); e.click(); return true; })()`);
const elegirOficina = (ciudad) => evaluar(`(() => {
    const o = [...document.querySelectorAll('.pt-oficina')].find(x => x.textContent.includes(${JSON.stringify(ciudad)}));
    if (!o) throw new Error('sin oficina ${ciudad}');
    o.click(); document.getElementById('boton-entrar-notaria').click(); return true; })()`);
const abrirCarpetaCon = (texto) => evaluar(`(() => {
    const t = [...document.querySelectorAll('.pt-tarjeta-carpeta')].find(x => x.textContent.includes(${JSON.stringify(texto)}));
    if (!t) throw new Error('sin carpeta ${texto}');
    abrirCarpeta(Number(t.dataset.id)); return true; })()`);
const arriba = () => evaluar(`scrollTo(0, 0); true`);
const pantallaDeOficinas = async () => {
    // Recuerda la última oficina y entra directo: se vuelve a la pantalla de elegir
    await evaluar(`if (!document.querySelector('#pt-elegir:not([hidden]) .pt-oficina')) mostrarPantallaNotarias(); true`);
    await hasta(`document.querySelectorAll('.pt-oficina').length >= 2`);
};

try {
    ws = new WebSocket(await conectar());
    await new Promise((ok, mal) => { ws.onopen = ok; ws.onerror = mal; });
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pendientes.has(m.id)) {
            const p = pendientes.get(m.id); pendientes.delete(m.id);
            m.error ? p.mal(new Error(m.error.message)) : p.ok(m.result);
        } else if (m.method === 'Runtime.exceptionThrown') {
            errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        }
    };
    await cdp('Page.enable');
    await cdp('Runtime.enable');

    // ---- Escritorio ----
    await tamano(1440, 900, 2);
    await ir(BASE);
    await hasta(`typeof dbTodos === 'function' && dbTodos('carpetas').then(c => c.length >= 10)`, 60000);
    await foto('00-ingreso');

    await entrar('administrador', 'administrador123');
    await pantallaDeOficinas();
    await foto('01-oficinas');

    await elegirOficina('Santa Marta');
    await hasta(`document.querySelectorAll('.pt-tarjeta-carpeta').length >= 5`);
    await esperar(800);
    await foto('02-carpetas');

    await abrirCarpetaCon('Martha');
    await hasta(`document.querySelectorAll('#panel-archivos tbody tr').length >= 3`);
    await esperar(800);
    await arriba();
    await foto('03-carpeta');
    // Desplazar descuadra la barra lateral fija: mejor una ventana más alta
    await tamano(1440, 1320, 2);
    await esperar(800);
    await arriba();
    await foto('03-documentos');

    await evaluar(`cambiarSubPestanaCarpeta('audiencias'); true`);
    await esperar(1200);
    await arriba();
    await foto('05-audiencias');
    await tamano(1440, 900, 2);

    await evaluar(`cambiarSubPestanaCarpeta('archivos'); true`);
    await esperar(600);
    await arriba();
    await evaluar(`abrirChatCarpeta(); true`);
    await esperar(1500);
    await foto('07-chat');
    await evaluar(`minimizarChatCarpeta(); true`);

    await evaluar(`void abrirModalExpediente(); true`);
    await esperar(1500);
    await foto('08-expediente');
    await evaluar(`cerrarModalExpediente(); true`);

    await clic('#pestana-estados');
    await esperar(2000);
    await arriba();
    await foto('04-estados');

    await clic('#pestana-calendario');
    await esperar(2000);
    await arriba();
    await foto('04-calendario');

    // Centro de conciliación
    await evaluar(`mostrarPantallaNotarias(); true`);
    await hasta(`document.querySelectorAll('.pt-oficina').length >= 2`);
    await elegirOficina('Barranquilla');
    await hasta(`document.querySelectorAll('.pt-tarjeta-carpeta').length >= 2`);
    await esperar(800);
    await foto('06-centro');
    await evaluar(`void pedirResultado('Conciliación — Ferretería Puerto con Inmobiliaria Sol (Exp. 2026-0415)'); true`);
    await esperar(800);
    await foto('06-resultado');
    await clic('#modal-resultado [data-cancelar]');

    // ---- Celular ----
    await tamano(390, 844, 3, true);
    await entrar('administrador', 'administrador123');
    await pantallaDeOficinas();
    await elegirOficina('Santa Marta');
    await hasta(`document.querySelectorAll('.pt-tarjeta-carpeta').length >= 5`);
    await esperar(800);
    await arriba();
    await foto('m-carpetas', 0.6);

    await entrar('cliente', 'cliente123');
    await esperar(1000);
    await evaluar(`(() => { const m = document.getElementById('modal-consentimiento');
        if (m && !m.hidden) { document.getElementById('consentimiento-acepto').checked = true; aceptarConsentimientoAccion(); } return true; })()`);
    await esperar(1500);
    await foto('m-cliente', 0.6);
    await abrirCarpetaCon('Pedro');
    await esperar(1500);
    await arriba();
    await foto('m-cliente-carpeta', 0.6);

    if (errores.length) console.log('Errores en la página:\n' + [...new Set(errores)].join('\n'));
    terminar(0);
} catch (e) {
    console.error('Falló:', e.message);
    if (errores.length) console.log('Errores en la página:\n' + [...new Set(errores)].join('\n'));
    terminar(1);
}
