// Archivo Kraft: los mismos colores y letras del portal
import { loadFont as cargarFamiljen } from '@remotion/google-fonts/FamiljenGrotesk';
import { loadFont as cargarWorkSans } from '@remotion/google-fonts/WorkSans';
import { loadFont as cargarPlexMono } from '@remotion/google-fonts/IBMPlexMono';
import { loadFont as cargarBricolage } from '@remotion/google-fonts/BricolageGrotesque';

export const COLOR = {
    pizarra: '#454B48',
    pizarra2: '#2F3431',
    carton: '#5F6562',
    kraft: '#C9A46A',
    kraft2: '#B8925A',
    kraftTxt: '#7A5A26',
    kraftSuave: '#F3E8D4',
    verde: '#2E7D4F',
    verdeSuave: '#E1F0E6',
    rojo: '#A2452F',
    rojoSuave: '#F6E3DD',
    fondo: '#F2F3F3',
    linea: '#E2E4E3',
    claro: '#DCDFDD',
    blanco: '#FFFFFF',
};

export type Tono = 'kraft' | 'verde' | 'rojo' | 'pizarra';
export const TONO: Record<Tono, { fondo: string; texto: string; punto: string }> = {
    kraft: { fondo: COLOR.kraftSuave, texto: '#6E5119', punto: COLOR.kraft },
    verde: { fondo: COLOR.verdeSuave, texto: '#22603C', punto: COLOR.verde },
    rojo: { fondo: COLOR.rojoSuave, texto: '#8E3420', punto: COLOR.rojo },
    pizarra: { fondo: '#ECEDEC', texto: COLOR.pizarra, punto: COLOR.pizarra },
};

const subconjuntos: { subsets: ('latin' | 'latin-ext')[] } = { subsets: ['latin', 'latin-ext'] };
export const FUENTE = {
    titulos: cargarFamiljen('normal', { weights: ['600', '700'], ...subconjuntos }).fontFamily,
    texto: cargarWorkSans('normal', { weights: ['400', '500', '600'], ...subconjuntos }).fontFamily,
    mono: cargarPlexMono('normal', { weights: ['400', '500'], ...subconjuntos }).fontFamily,
    logo: cargarBricolage('normal', { weights: ['700'], subsets: ['latin'] }).fontFamily,
};
