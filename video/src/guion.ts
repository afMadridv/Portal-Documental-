// El guion como datos: textos, tiempos, fuentes de imagen y avisos de cada escena.
// Lo comparten las dos composiciones (16:9 y 9:16).
import type { Tono } from './marca';

export const FPS = 30;
export const seg = (s: number) => Math.round(s * FPS);

// Dirección que sale al final; cámbiala por la de tu despliegue
export const SITIO = 'portal-documental-lac.vercel.app';

// Encuadre sobre la fuente (x, y del centro, de 0 a 1)
export type Foco = { en: number; x: number; y: number; zoom: number };
export type AvisoGuion = { en: number; titulo: string; detalle: string; tono: Tono };
export type Cifra = { valor: number; rotulo: string; tono: Tono };
// Archivo en public/ y su proporción (ancho / alto)
export type Fuente = { archivo: string; proporcion: number };

export type EscenaUI = {
    tipo: 'ui';
    id: string;
    dura: number;
    eti: string;
    titulo: string;
    sub: string;
    escritorio: Fuente[];
    celular?: Fuente[];
    focos?: Foco[];
    avisos?: AvisoGuion[];
    cifras?: Cifra[];
};
export type EscenaMovimiento = { tipo: 'gancho' | 'problema' | 'marca' | 'dias' | 'cierre'; id: string; dura: number };
export type Escena = EscenaUI | EscenaMovimiento;

// Primero tu grabación; si no está, la captura del modo práctica
// (capturas de 1440×900, o 1440×1320 en las pantallas largas)
const ALTA = 1440 / 1320;
const esc = (n: string, captura: string, proporcion = 1.6): Fuente[] => [
    { archivo: `grabaciones/escritorio/${n}.mp4`, proporcion: 16 / 9 },
    { archivo: `capturas/${captura}.webp`, proporcion },
];
const cel = (n: string, captura: string): Fuente[] => [
    { archivo: `grabaciones/celular/${n}.mp4`, proporcion: 390 / 844 },
    { archivo: `capturas/${captura}.webp`, proporcion: 390 / 844 },
];

export const ESCENAS: Escena[] = [
    { tipo: 'gancho', id: 'gancho', dura: 4 },
    { tipo: 'problema', id: 'problema', dura: 5 },
    { tipo: 'marca', id: 'marca', dura: 4.5 },
    {
        tipo: 'ui', id: 'oficinas', dura: 6.5,
        eti: '01 · Oficinas',
        titulo: 'Notarías y centros de conciliación.',
        sub: 'Cada oficina con sus carpetas. El portal se ajusta al trámite.',
        escritorio: esc('01-oficinas', '01-oficinas'),
        focos: [{ en: 0, x: 0.5, y: 0.5, zoom: 1 }, { en: 2.4, x: 0.68, y: 0.2, zoom: 1.8 }, { en: 5.4, x: 0.62, y: 0.32, zoom: 1.6 }],
        avisos: [
            { en: 2.2, titulo: 'Notaría · insolvencia', detalle: '60 días hábiles, 90 con prórroga', tono: 'verde' },
            { en: 3.4, titulo: 'Centro de conciliación', detalle: '3 meses, prorrogables 3 más', tono: 'kraft' },
        ],
    },
    {
        tipo: 'ui', id: 'carpetas', dura: 7,
        eti: '02 · Carpetas',
        titulo: 'Una carpeta por proceso.',
        sub: 'Lo activo, lo que vence y lo vencido, de un vistazo.',
        escritorio: esc('02-carpetas', '02-carpetas'),
        celular: cel('02-carpetas', 'm-carpetas'),
        focos: [{ en: 0, x: 0.6, y: 0.28, zoom: 1.5 }, { en: 3.5, x: 0.55, y: 0.66, zoom: 1.7 }],
        cifras: [
            { valor: 6, rotulo: 'activas', tono: 'pizarra' },
            { valor: 2, rotulo: 'por vencer', tono: 'kraft' },
            { valor: 1, rotulo: 'vencida', tono: 'rojo' },
        ],
    },
    {
        tipo: 'ui', id: 'documentos', dura: 7.5,
        eti: '03 · Documentos',
        titulo: 'Arrastra, suelta y queda en el legajo.',
        sub: 'Anexos 1.1 y 1.2, subcarpetas, audios y videos.',
        escritorio: esc('03-documentos', '03-documentos', ALTA),
        focos: [{ en: 0, x: 0.5, y: 0.2, zoom: 1.3 }, { en: 3, x: 0.45, y: 0.55, zoom: 1.8 }, { en: 6.5, x: 0.42, y: 0.6, zoom: 1.5 }],
        avisos: [
            { en: 3, titulo: 'Documento nuevo', detalle: 'Certificado de ingresos.pdf', tono: 'pizarra' },
            { en: 4.6, titulo: 'Anexo 1.2', detalle: 'Unido a la solicitud', tono: 'kraft' },
        ],
    },
    { tipo: 'dias', id: 'dias', dura: 6 },
    {
        tipo: 'ui', id: 'estados', dura: 6,
        eti: '04 · Plazos',
        titulo: 'El semáforo avisa antes de que venza.',
        sub: 'Verde al día, naranja por vencer, rojo vencido.',
        escritorio: esc('04-estados', '04-estados'),
        focos: [{ en: 0, x: 0.5, y: 0.45, zoom: 1.2 }, { en: 3, x: 0.3, y: 0.42, zoom: 1.8 }],
        avisos: [
            { en: 2, titulo: 'Vence mañana', detalle: 'Martha L. Ríos · 2026-0418', tono: 'kraft' },
            { en: 3.6, titulo: 'Venció hace 2 días', detalle: 'Inversiones Duarte · 2026-0397', tono: 'rojo' },
        ],
    },
    {
        tipo: 'ui', id: 'audiencias', dura: 7.5,
        eti: '05 · Audiencias',
        titulo: 'Cita la audiencia. Las partes se enteran.',
        sub: 'Correo a cada parte y constancia de notificación en PDF.',
        escritorio: esc('05-audiencias', '05-audiencias', ALTA),
        focos: [{ en: 0, x: 0.55, y: 0.3, zoom: 1.4 }, { en: 3.5, x: 0.45, y: 0.5, zoom: 1.8 }],
        avisos: [
            { en: 3.2, titulo: 'Audiencia notificada', detalle: 'Deudor y acreedores avisados por correo', tono: 'verde' },
            { en: 4.8, titulo: 'Constancia lista', detalle: 'Constancia de notificación.pdf', tono: 'pizarra' },
        ],
    },
    {
        tipo: 'ui', id: 'conciliacion', dura: 7,
        eti: '06 · Conciliación',
        titulo: 'En el centro, todo habla de conciliación.',
        sub: 'Convocante y convocado, 3 meses y el resultado al cerrar.',
        escritorio: esc('06-conciliacion', '06-resultado'),
        focos: [{ en: 0, x: 0.5, y: 0.45, zoom: 1.2 }, { en: 3.2, x: 0.42, y: 0.42, zoom: 2 }],
        avisos: [{ en: 3.5, titulo: 'Acuerdo total', detalle: 'Recuerda registrarlo en el SICAAC', tono: 'verde' }],
    },
    {
        tipo: 'ui', id: 'equipo', dura: 7,
        eti: '07 · En equipo',
        titulo: 'Chat por trámite y avisos en el celular.',
        sub: 'Cliente, acreedores y operador, cada uno en lo suyo.',
        escritorio: esc('07-chat', '07-chat'),
        celular: cel('07-cliente', 'm-cliente-carpeta'),
        focos: [{ en: 0, x: 0.86, y: 0.45, zoom: 1.7 }],
        avisos: [
            { en: 2.4, titulo: 'Mensaje del cliente', detalle: '“¿Debo llevar algún documento?”', tono: 'pizarra' },
            { en: 4, titulo: 'Vence en 1 semana', detalle: 'Aviso en el celular del administrador', tono: 'kraft' },
        ],
    },
    {
        tipo: 'ui', id: 'expediente', dura: 5.5,
        eti: '08 · Expediente',
        titulo: 'Todo el expediente en un PDF.',
        sub: 'En el orden que elijas y numerado. O la carpeta entera en un ZIP.',
        escritorio: esc('08-expediente', '08-expediente'),
        focos: [{ en: 0, x: 0.5, y: 0.45, zoom: 1.3 }, { en: 3, x: 0.42, y: 0.42, zoom: 1.8 }],
    },
    { tipo: 'cierre', id: 'cierre', dura: 6.5 },
];

// Cuadros que dura cada transición; se solapan con las escenas
export const TRANSICION = 12;
export const DURACION = ESCENAS.reduce((t, e) => t + seg(e.dura), 0) - TRANSICION * (ESCENAS.length - 1);
