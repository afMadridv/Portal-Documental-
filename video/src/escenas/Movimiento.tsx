// Escenas de motion graphics: gancho, problema, marca, días hábiles y cierre
import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLOR, FUENTE, TONO, type Tono } from '../marca';
import { SITIO, seg } from '../guion';
import { useFormato } from '../formato';
import { Icono, Logo } from '../componentes/Marca';
import { Rotulo, Subir, Titular } from '../componentes/Piezas';

const fijo = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Brillo: React.FC = () => (
    <AbsoluteFill style={{ background: 'radial-gradient(60% 50% at 50% 55%, rgba(201,164,106,.22), transparent 70%)' }} />
);

// 0–4 s: hojas kraft que caen y un plazo que se acaba
export const Gancho: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const { vertical, ancho, alto } = useFormato();
    const dia = Math.min(60, 48 + Math.floor(interpolate(frame, [seg(1), seg(3.2)], [0, 12], fijo)));
    const lleno = dia === 60;
    return (
        <AbsoluteFill style={{ background: COLOR.pizarra, overflow: 'hidden' }}>
            {Array.from({ length: 9 }).map((_, i) => {
                const s = spring({ frame: frame - i * 4, fps, config: { damping: 15, stiffness: 70 } });
                const x = (random(`x${i}`) * 0.7 + 0.15) * ancho;
                const giro = (random(`g${i}`) - 0.5) * 50;
                const finY = alto * (vertical ? 0.78 : 0.74) + random(`y${i}`) * 60;
                return (
                    <div key={i} style={{
                        position: 'absolute', left: x - 110, top: interpolate(s, [0, 1], [-320, finY - 150]),
                        width: 220, height: 290, borderRadius: 10, background: i % 3 ? COLOR.kraft : COLOR.kraft2,
                        boxShadow: '0 20px 40px -20px rgba(0,0,0,.6)', transform: `rotate(${giro * s}deg)`, opacity: 0.95,
                    }} />
                );
            })}
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: vertical ? '0 72px 300px' : '0 160px 200px', gap: 30 }}>
                <Titular texto="¿Cuántos plazos vencen esta semana?" tam={vertical ? 104 : 104} color={COLOR.fondo} alinear="center" ancho={vertical ? 936 : 1300} />
                <Subir desde={1} style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
                    <span style={{ font: `500 ${vertical ? 30 : 26}px ${FUENTE.mono}`, color: COLOR.claro, letterSpacing: '.08em' }}>DÍA HÁBIL</span>
                    <b style={{ font: `700 ${vertical ? 120 : 110}px/1 ${FUENTE.titulos}`, color: lleno ? '#E58B74' : COLOR.kraft, fontVariantNumeric: 'tabular-nums' }}>{dia}</b>
                    <span style={{ font: `500 ${vertical ? 30 : 26}px ${FUENTE.mono}`, color: COLOR.claro }}>DE 60</span>
                </Subir>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

// 4–9 s: el caos de hoy, que termina dentro de una carpeta
const RUIDO: { canal: string; texto: string; tono: Tono }[] = [
    { canal: 'Correo', texto: 'RV: acreencias_v3_FINAL.pdf', tono: 'pizarra' },
    { canal: 'Chat', texto: '¿Ya me citaron a la audiencia?', tono: 'verde' },
    { canal: 'Hoja de cálculo', texto: 'plazos (2).xlsx', tono: 'verde' },
    { canal: 'Carpeta compartida', texto: 'Escaneo 0042.pdf', tono: 'kraft' },
    { canal: 'Llamada perdida', texto: 'Acreedor · 3 intentos', tono: 'rojo' },
    { canal: 'Nota', texto: '¿Vence el 14 o el 15?', tono: 'kraft' },
];
export const Problema: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const { vertical, ancho, alto } = useFormato();
    const junta = interpolate(frame, [seg(3.4), seg(4.4)], [0, 1], { ...fijo, easing: Easing.in(Easing.cubic) });
    const carpeta = spring({ frame: frame - seg(3.3), fps, config: { damping: 12 } });
    return (
        <AbsoluteFill style={{ background: COLOR.fondo, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: vertical ? 250 : 110, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '0 72px', opacity: 1 - junta }}>
                <Titular texto="Expedientes en correos, chats y hojas sueltas." tam={vertical ? 80 : 74} alinear="center" ancho={vertical ? 936 : 1400} />
            </div>
            {RUIDO.map((r, i) => {
                const s = spring({ frame: frame - seg(0.4) - i * 6, fps, config: { damping: 10, stiffness: 160 } });
                const bx = (vertical ? [0.08, 0.5, 0.12, 0.46, 0.1, 0.42] : [0.06, 0.62, 0.3, 0.7, 0.12, 0.44])[i] * ancho;
                const by = (vertical ? [0.36, 0.42, 0.52, 0.6, 0.7, 0.78] : [0.36, 0.33, 0.5, 0.58, 0.68, 0.74])[i] * alto;
                const tiembla = Math.sin(frame * 0.9 + i) * 3 * (1 - junta);
                const x = interpolate(junta, [0, 1], [bx, ancho / 2 - 230]);
                const y = interpolate(junta, [0, 1], [by, alto / 2 - 40]);
                return (
                    <div key={r.canal} style={{
                        position: 'absolute', left: x, top: y, width: 460, display: 'flex', flexDirection: 'column', gap: 4,
                        padding: '18px 22px', background: COLOR.blanco, borderRadius: 14, borderLeft: `6px solid ${TONO[r.tono].punto}`,
                        boxShadow: '0 24px 40px -22px rgba(0,0,0,.4)', opacity: s * (1 - junta),
                        transform: `scale(${s * (1 - junta * 0.8)}) rotate(${(random(`r${i}`) - 0.5) * 10 + tiembla}deg)`,
                    }}>
                        <span style={{ font: `500 18px ${FUENTE.mono}`, color: COLOR.carton, letterSpacing: '.06em', textTransform: 'uppercase' }}>{r.canal}</span>
                        <b style={{ font: `600 26px ${FUENTE.texto}`, color: COLOR.pizarra2 }}>{r.texto}</b>
                    </div>
                );
            })}
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: carpeta, transform: `scale(${0.6 + carpeta * 0.4})` }}>
                <Icono tam={vertical ? 300 : 260} desde={3.3} clip={COLOR.pizarra} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

// 9–13 s: la marca se arma
export const Marca: React.FC = () => {
    const { vertical } = useFormato();
    return (
        <AbsoluteFill style={{ background: COLOR.pizarra }}>
            <Brillo />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: vertical ? 50 : 44, padding: '0 72px' }}>
                <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', gap: vertical ? 40 : 46 }}>
                    <Icono tam={vertical ? 240 : 200} />
                    <Logo tam={vertical ? 210 : 200} desde={0.2} />
                </div>
                <Titular texto="Cada proceso, en orden y a tiempo." tam={vertical ? 68 : 60} color={COLOR.fondo} desde={1.4} alinear="center" ancho={vertical ? 900 : 1300} />
                <Rotulo texto="Insolvencia · Conciliación" tam={vertical ? 28 : 24} color={COLOR.kraft} desde={2} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

// Días hábiles: el calendario se tacha y los avisos se encienden
const FESTIVOS = [12, 31];
const AVISOS = ['4 semanas', '3 semanas', '2 semanas', '1 semana', '1 día', 'El día'];
export const Dias: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const { vertical } = useFormato();
    const celda = vertical ? 118 : 92;
    const tacha = interpolate(frame, [seg(1), seg(1.8)], [0, 1], fijo);
    const habiles = Math.round(interpolate(frame, [seg(1.6), seg(3.2)], [0, 60], fijo));
    const calendario = (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${celda}px)`, gap: 10 }}>
            {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => (
                <span key={i} style={{ font: `500 ${vertical ? 24 : 20}px ${FUENTE.mono}`, color: COLOR.carton, textAlign: 'center' }}>{d}</span>
            ))}
            {Array.from({ length: 35 }).map((_, i) => {
                const n = i + 1;
                // El mes tiene 31 días: el resto de la rejilla queda vacío
                if (n > 31) return <div key={i} />;
                const finde = i % 7 >= 5 || FESTIVOS.includes(n);
                const aparece = spring({ frame: frame - i * 0.7, fps, config: { damping: 18 } });
                const llena = !finde && interpolate(frame, [seg(1.6) + i * 1.2, seg(1.6) + i * 1.2 + 6], [0, 1], fijo);
                return (
                    <div key={i} style={{
                        position: 'relative', height: celda * 0.82, borderRadius: 10, opacity: aparece,
                        transform: `scale(${0.7 + aparece * 0.3})`,
                        background: finde ? `rgba(95,101,98,${0.08 + tacha * 0.14})` : `rgba(201,164,106,${0.12 + Number(llena) * 0.5})`,
                        border: `1.5px solid ${finde ? '#D5D8D6' : COLOR.kraft}`,
                        font: `500 ${vertical ? 24 : 20}px ${FUENTE.mono}`, color: finde ? '#8A8F8C' : COLOR.pizarra2,
                        display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: 10,
                    }}>
                        {n}
                        {finde && <i style={{
                            position: 'absolute', left: 10, right: 10, top: '50%', height: 3, background: '#8A8F8C',
                            transform: `scaleX(${tacha})`, transformOrigin: 'left',
                        }} />}
                    </div>
                );
            })}
        </div>
    );
    const linea = (
        <div style={{ display: 'grid', gridTemplateColumns: vertical ? 'repeat(3, 1fr)' : 'repeat(6, 1fr)', gap: vertical ? 22 : 16, width: vertical ? 936 : 1700 }}>
            {AVISOS.map((a, i) => {
                const on = spring({ frame: frame - seg(3.4) - i * 5, fps, config: { damping: 12, stiffness: 180 } });
                const ultimo = i >= 4;
                return (
                    <div key={a} style={{
                        display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 12,
                        background: COLOR.blanco, border: `1px solid ${COLOR.linea}`, opacity: on, transform: `translateY(${(1 - on) * 20}px)`,
                    }}>
                        <span style={{ width: 16, height: 16, borderRadius: '50%', background: ultimo ? COLOR.rojo : COLOR.kraft, boxShadow: `0 0 0 ${on * 6}px ${ultimo ? 'rgba(162,69,47,.15)' : 'rgba(201,164,106,.25)'}` }} />
                        <b style={{ font: `600 ${vertical ? 28 : 24}px ${FUENTE.texto}`, color: COLOR.pizarra2 }}>{a}</b>
                    </div>
                );
            })}
        </div>
    );
    const textos = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: vertical ? 936 : 640 }}>
            <Rotulo texto="Días hábiles colombianos" tam={vertical ? 28 : 22} />
            <Titular texto="Sábados, domingos y festivos no cuentan." tam={vertical ? 78 : 64} desde={0.1} />
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
                <b style={{ font: `700 ${vertical ? 130 : 120}px/1 ${FUENTE.titulos}`, color: COLOR.kraftTxt, fontVariantNumeric: 'tabular-nums' }}>{habiles}</b>
                <span style={{ font: `500 ${vertical ? 32 : 28}px ${FUENTE.texto}`, color: COLOR.carton }}>días hábiles · insolvencia</span>
            </div>
            <Subir desde={2.6} style={{ font: `400 ${vertical ? 30 : 26}px ${FUENTE.texto}`, color: COLOR.carton }}>
                En conciliación: 3 meses, prorrogables 3 más.
            </Subir>
        </div>
    );
    return (
        <AbsoluteFill style={{ background: COLOR.fondo }}>
            {vertical ? (
                <AbsoluteFill style={{ padding: '250px 72px 0', flexDirection: 'column', gap: 44 }}>
                    {textos}{calendario}{linea}
                </AbsoluteFill>
            ) : (
                <AbsoluteFill style={{ padding: '110px 110px 0', flexDirection: 'column', gap: 60 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{textos}{calendario}</div>
                    {linea}
                </AbsoluteFill>
            )}
        </AbsoluteFill>
    );
};

// Cierre: marca, frase y el botón al portal
export const Cierre: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const { vertical } = useFormato();
    const boton = spring({ frame: frame - seg(1.6), fps, config: { damping: 12 } });
    const late = 1 + Math.max(0, Math.sin((frame - seg(2.4)) / 9)) * 0.03;
    return (
        <AbsoluteFill style={{ background: COLOR.pizarra }}>
            <Brillo />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: vertical ? 54 : 46, padding: vertical ? '0 72px 200px' : 0 }}>
                <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', gap: vertical ? 36 : 40 }}>
                    <Icono tam={vertical ? 200 : 150} />
                    <Logo tam={vertical ? 180 : 150} desde={0.2} />
                </div>
                <Titular texto="Cada proceso, en orden y a tiempo." tam={vertical ? 64 : 56} color={COLOR.fondo} desde={1} alinear="center" ancho={vertical ? 900 : 1300} />
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 16, padding: vertical ? '30px 54px' : '24px 46px', borderRadius: 12,
                    background: COLOR.kraft, color: COLOR.pizarra2, font: `600 ${vertical ? 40 : 32}px ${FUENTE.texto}`,
                    opacity: boton, transform: `translateY(${(1 - boton) * 30}px) scale(${late})`,
                    boxShadow: '0 20px 40px -18px rgba(201,164,106,.9)',
                }}>
                    Ingresar al portal <span>→</span>
                </div>
                <Subir desde={2.2} style={{ font: `500 ${vertical ? 30 : 26}px ${FUENTE.mono}`, color: COLOR.claro, letterSpacing: '.04em' }}>{SITIO}</Subir>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
