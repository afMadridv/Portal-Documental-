/*! Portal Documental · librerías externas con huella SRI
  Si el archivo del CDN cambia, el navegador no lo ejecuta.
  Para cambiar de versión, URL y huella juntas:
    jsDelivr: data.jsdelivr.com/v1/packages/npm/<paquete>@<versión>?structure=flat ("hash", con sha256-)
    SheetJS:  curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A (con sha384-)
  Se cargan solo cuando hacen falta.
  Andrés Madrid · andresmadrid.vercel.app */
const LIBRERIAS = {
    pdfLib:      { url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
                   huella: 'sha256-D5pcrQeUHwgmWGyU4InYm5GMRuXBfPLVo8b2ZuO8aU8=' },
    pdfJs:       { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
                   huella: 'sha256-W1eZ5vjGgGYyB6xbQu4U7tKkBvp69I9QwVTwwLFWaUY=' },
    pdfJsWorker: { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
                   huella: 'sha256-/qvfMJdw7SS7oxpUZ4Ns3Iz2OccFryfVK1hbBBu4Uns=' },
    docx:        { url: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.3/dist/docx-preview.min.js',
                   huella: 'sha256-qUpULy0hgLykfC0R35WQzCOCW4GQsAUiVeEoDGH3920=' },
    // 0.20.3 corrige CVE-2023-30533 y CVE-2024-22363. SheetJS ya no publica en npm.
    sheetJS:     { url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
                   huella: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT' },
    jszip:       { url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
                   huella: 'sha256-rMfkFFWoB2W1/Zx+4bgHim0WC7vKRVrq6FTeZclH1Z4=' },
    excelJS:     { url: 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
                   huella: 'sha256-fknaaFiOJQ27i7oZDSyqirN4fMAoS9odiy+AXE33Qsk=' }
};
function fuenteVerificada(script, clave) {
    const lib = LIBRERIAS[clave];
    script.src = lib.url;
    script.integrity = lib.huella;
    script.crossOrigin = 'anonymous';
}

const _promesasLibreria = {};
/* Carga una vez y devuelve window[global]. */
function cargarLibreria(clave, global, queEs) {
    if (window[global]) return Promise.resolve(window[global]);
    if (_promesasLibreria[clave]) return _promesasLibreria[clave];
    _promesasLibreria[clave] = new Promise((resolver, rechazar) => {
        const script = document.createElement('script');
        fuenteVerificada(script, clave);
        script.onload = () => window[global]
            ? resolver(window[global])
            : rechazar(new Error('No se pudo cargar ' + queEs + '.'));
        script.onerror = () => {
            delete _promesasLibreria[clave];
            rechazar(new Error('Sin conexión para cargar ' + queEs + '. Intenta de nuevo.'));
        };
        document.head.appendChild(script);
    });
    return _promesasLibreria[clave];
}

/* pdf-lib: expediente y PDF de las hojas. */
function cargarPdfLib() { return cargarLibreria('pdfLib', 'PDFLib', 'el generador de PDF'); }

/* SheetJS: .xls, .ods, .csv, formatos de número y exportar. */
function cargarSheetJS() { return cargarLibreria('sheetJS', 'XLSX', 'el lector de hojas de cálculo'); }

/* JSZip: ZIP de la carpeta (docx-preview también lo usa). */
function cargarJSZip() { return cargarLibreria('jszip', 'JSZip', 'el compresor ZIP'); }

/* ExcelJS: .xlsx con estilos y exportar. ~900 KB, se baja solo si hace falta. */
function cargarExcelJS() { return cargarLibreria('excelJS', 'ExcelJS', 'el lector de Excel'); }

/* docx-preview necesita JSZip cargado antes (si no: "reading 'loadAsync'"). */
function cargarDocxPreview() {
    return cargarJSZip().then(() => cargarLibreria('docx', 'docx', 'el visor de Word'));
}

/* pdf.js: plan B del expediente cuando pdf-lib no abre un PDF.
   El worker no admite huella, así que se baja con fetch (que sí la
   revisa) y se le pasa como blob. */
async function workerPdfVerificado() {
    const lib = LIBRERIAS.pdfJsWorker;
    const r = await fetch(lib.url, { integrity: lib.huella, mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error('worker de pdf.js: ' + r.status);
    return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'text/javascript' }));
}
let _promesaPdfJs = null;
function cargarPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions.workerSrc) return Promise.resolve(window.pdfjsLib);
    if (_promesaPdfJs) return _promesaPdfJs;
    _promesaPdfJs = cargarLibreria('pdfJs', 'pdfjsLib', 'el lector de PDF').then(async (pdfjsLib) => {
        // el worker trabaja fuera del hilo de la interfaz
        pdfjsLib.GlobalWorkerOptions.workerSrc = await workerPdfVerificado();
        return pdfjsLib;
    }).catch((e) => {
        _promesaPdfJs = null;
        throw new Error('No se pudo cargar el lector de PDF.');
    });
    return _promesaPdfJs;
}
