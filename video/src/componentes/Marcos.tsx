// Marcos donde va la interfaz real: ventana de navegador y celular
import React from 'react';
import { COLOR, FUENTE } from '../marca';
import { Icono } from './Marca';

export const Navegador: React.FC<{ ancho: number; alto: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
    ancho, alto, children, style,
}) => (
    <div style={{
        width: ancho, height: alto, borderRadius: 18, overflow: 'hidden', background: COLOR.blanco,
        border: `1px solid ${COLOR.carton}`, boxShadow: '0 50px 90px -40px rgba(0,0,0,.55)',
        display: 'flex', flexDirection: 'column', ...style,
    }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 20px', background: '#DCDEDD', flex: 'none' }}>
            <span style={{ display: 'flex', gap: 9 }}>
                {[0, 1, 2].map((i) => <i key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: '#B9BDBB' }} />)}
            </span>
            <span style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', borderRadius: '8px 8px 0 0',
                background: COLOR.fondo, font: `500 17px ${FUENTE.texto}`, color: COLOR.pizarra,
            }}>
                <Icono tam={22} desde={-5} clip={COLOR.pizarra} /> Legajo
            </span>
        </div>
        <div style={{ position: 'relative', flex: 1 }}>{children}</div>
    </div>
);

export const Celular: React.FC<{ alto: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ alto, children, style }) => {
    const ancho = alto * 0.462;
    const borde = alto * 0.018;
    return (
        <div style={{
            width: ancho, height: alto, borderRadius: alto * 0.075, padding: borde, background: COLOR.pizarra2,
            boxShadow: '0 50px 90px -40px rgba(0,0,0,.6)', ...style,
        }}>
            <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: alto * 0.06, overflow: 'hidden', background: COLOR.fondo }}>
                {children}
                <span style={{
                    position: 'absolute', top: alto * 0.012, left: '50%', width: ancho * 0.3, height: alto * 0.028,
                    transform: 'translateX(-50%)', borderRadius: 99, background: COLOR.pizarra2,
                }} />
            </div>
        </div>
    );
};
