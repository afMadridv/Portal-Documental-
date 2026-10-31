// Piezas de motion: avisos flotantes, contadores, rótulos y titulares por palabras
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLOR, FUENTE, TONO, type Tono } from '../marca';
import { seg } from '../guion';

const fijo = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// Aviso como los de la campana: entra con rebote y queda flotando
export const Aviso: React.FC<{
    en: number; titulo: string; detalle: string; tono: Tono; ancho?: number; letra?: number; style?: React.CSSProperties;
}> = ({ en, titulo, detalle, tono, ancho = 420, letra = 1, style }) => {
    const frame = useCurrentFrame() - seg(en);
    const { fps } = useVideoConfig();
    if (frame < 0) return null;
    const entra = spring({ frame, fps, config: { damping: 12, stiffness: 170 } });
    const flota = Math.sin((frame / fps) * 1.6) * 6;
    return (
        <div style={{
            position: 'absolute', width: ancho * letra, display: 'flex', alignItems: 'center', gap: 16 * letra,
            padding: `${16 * letra}px ${20 * letra}px`, background: COLOR.blanco, border: `1px solid ${COLOR.linea}`,
            borderRadius: 16 * letra, boxShadow: '0 24px 48px -20px rgba(0,0,0,.45)',
            opacity: Math.min(1, entra * 1.4),
            transform: `translateY(${(1 - entra) * 40 + flota}px) scale(${0.88 + entra * 0.12})`,
            ...style,
        }}>
            <span style={{ width: 14 * letra, height: 14 * letra, borderRadius: '50%', flex: 'none', background: TONO[tono].punto }} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <b style={{ font: `600 ${22 * letra}px ${FUENTE.texto}`, color: COLOR.pizarra2 }}>{titulo}</b>
                <small style={{ font: `400 ${18 * letra}px ${FUENTE.texto}`, color: COLOR.carton, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detalle}</small>
            </span>
        </div>
    );
};

// Cuenta de 0 al valor
export const Contador: React.FC<{ valor: number; desde?: number; dura?: number }> = ({ valor, desde = 0, dura = 1 }) => {
    const frame = useCurrentFrame();
    const p = interpolate(frame, [seg(desde), seg(desde + dura)], [0, 1], fijo);
    return <>{Math.round(valor * (1 - Math.pow(1 - p, 3)))}</>;
};

// Rótulo en mono, como las fichas del portal
export const Rotulo: React.FC<{ texto: string; color?: string; tam?: number; desde?: number }> = ({
    texto, color = COLOR.kraftTxt, tam = 22, desde = 0,
}) => {
    const frame = useCurrentFrame() - seg(desde);
    const o = interpolate(frame, [0, 12], [0, 1], fijo);
    return (
        <div style={{
            font: `500 ${tam}px ${FUENTE.mono}`, letterSpacing: '0.08em', textTransform: 'uppercase', color,
            opacity: o, transform: `translateY(${(1 - o) * 12}px)`,
        }}>{texto}</div>
    );
};

// Titular que entra palabra por palabra
export const Titular: React.FC<{
    texto: string; tam: number; color?: string; desde?: number; alinear?: 'left' | 'center'; ancho?: number;
}> = ({ texto, tam, color = COLOR.pizarra2, desde = 0, alinear = 'left', ancho }) => {
    const frame = useCurrentFrame() - seg(desde);
    const { fps } = useVideoConfig();
    const palabras = texto.split(' ');
    return (
        <div style={{
            font: `700 ${tam}px/1.02 ${FUENTE.titulos}`, letterSpacing: '-0.025em', color,
            textAlign: alinear, maxWidth: ancho, textWrap: 'balance' as React.CSSProperties['textWrap'],
        }}>
            {palabras.map((p, i) => {
                const s = spring({ frame: frame - i * 2.5, fps, config: { damping: 18, stiffness: 150 } });
                return (
                    <span key={i} style={{
                        display: 'inline-block', opacity: s, marginRight: '0.24em',
                        transform: `translateY(${(1 - s) * 0.5}em)`, filter: `blur(${(1 - s) * 6}px)`,
                    }}>{p}</span>
                );
            })}
        </div>
    );
};

// Texto que aparece subiendo
export const Subir: React.FC<{ desde?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ desde = 0, children, style }) => {
    const frame = useCurrentFrame() - seg(desde);
    const o = interpolate(frame, [0, 15], [0, 1], fijo);
    return <div style={{ opacity: o, transform: `translateY(${(1 - o) * 20}px)`, ...style }}>{children}</div>;
};
