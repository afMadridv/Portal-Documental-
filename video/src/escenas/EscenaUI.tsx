// Escena con interfaz real: texto + grabación + avisos. Se acomoda sola a 16:9 o 9:16.
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLOR, FUENTE, TONO } from '../marca';
import { seg, type EscenaUI as Datos } from '../guion';
import { useFormato } from '../formato';
import { Aviso, Contador, Rotulo, Subir, Titular } from '../componentes/Piezas';
import { Celular, Navegador } from '../componentes/Marcos';
import { Grabacion } from '../componentes/Grabacion';

const BARRA = 56; // alto de la barra del navegador

// Sitios de los avisos en cada formato
const SITIOS_H: React.CSSProperties[] = [
    { right: 70, top: 120 }, { left: 700, bottom: 110 }, { right: 150, bottom: 80 },
];
const SITIOS_V: React.CSSProperties[] = [
    { left: 56, top: 1150 }, { right: 56, top: 1360 }, { left: 90, top: 1520 },
];

const Cifras: React.FC<{ datos: NonNullable<Datos['cifras']>; letra: number; desde: number }> = ({ datos, letra, desde }) => (
    <Subir desde={desde} style={{ display: 'flex', gap: 28 * letra }}>
        {datos.map((c) => (
            <div key={c.rotulo} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <b style={{ font: `600 ${64 * letra}px/1 ${FUENTE.titulos}`, color: c.tono === 'pizarra' ? COLOR.pizarra2 : TONO[c.tono].texto }}>
                    <Contador valor={c.valor} desde={desde} dura={1} />
                </b>
                <small style={{ font: `500 ${17 * letra}px ${FUENTE.mono}`, letterSpacing: '.06em', textTransform: 'uppercase', color: COLOR.carton }}>
                    {c.rotulo}
                </small>
            </div>
        ))}
    </Subir>
);

export const EscenaUI: React.FC<{ escena: Datos }> = ({ escena }) => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const { vertical, seguro, letra } = useFormato();
    const entra = spring({ frame: frame - 4, fps, config: { damping: 16, stiffness: 110 } });
    const empuje = interpolate(frame, [0, durationInFrames], [1, 1.035]);
    const focos = escena.focos ?? [];

    if (vertical) {
        const conCifras = !!escena.cifras;
        const arribaMedio = 640 + (conCifras ? 150 : 0);
        return (
            <AbsoluteFill style={{ background: COLOR.fondo }}>
                <div style={{ position: 'absolute', top: seguro.arriba, left: seguro.izquierda, right: seguro.izquierda, display: 'flex', flexDirection: 'column', gap: 18 }}>
                    <Rotulo texto={escena.eti} tam={28} />
                    <Titular texto={escena.titulo} tam={78} desde={0.1} ancho={936} />
                    <Subir desde={0.5} style={{ font: `400 34px/1.35 ${FUENTE.texto}`, color: COLOR.carton }}>{escena.sub}</Subir>
                    {escena.cifras && <Cifras datos={escena.cifras} letra={letra} desde={0.8} />}
                </div>
                <div style={{
                    position: 'absolute', top: arribaMedio, left: 0, right: 0, display: 'flex', justifyContent: 'center',
                    opacity: entra, transform: `translateY(${(1 - entra) * 120}px) scale(${empuje})`,
                }}>
                    {escena.celular ? (
                        <Celular alto={1080}>
                            <Grabacion fuentes={escena.celular} ancho={470} alto={1040} />
                        </Celular>
                    ) : (
                        <Navegador ancho={936} alto={1700 - arribaMedio}>
                            <Grabacion fuentes={escena.escritorio} ancho={936} alto={1700 - arribaMedio - BARRA} focos={focos} />
                        </Navegador>
                    )}
                </div>
                {(escena.avisos ?? []).map((a, i) => (
                    <Aviso key={a.titulo} {...a} letra={letra} ancho={430} style={SITIOS_V[i % SITIOS_V.length]} />
                ))}
            </AbsoluteFill>
        );
    }

    // Horizontal: el texto a la izquierda, la ventana a la derecha y el celular encima
    const suaves = focos.map((f) => ({ ...f, zoom: 1 + (f.zoom - 1) * 0.4 }));
    const celular = spring({ frame: frame - seg(1.2), fps, config: { damping: 14, stiffness: 120 } });
    return (
        <AbsoluteFill style={{ background: COLOR.fondo }}>
            <div style={{ position: 'absolute', left: seguro.izquierda, top: 0, bottom: 0, width: 600, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 22 }}>
                <Rotulo texto={escena.eti} tam={22} />
                <Titular texto={escena.titulo} tam={66} desde={0.1} ancho={600} />
                <Subir desde={0.5} style={{ font: `400 28px/1.4 ${FUENTE.texto}`, color: COLOR.carton }}>{escena.sub}</Subir>
                {escena.cifras && <Cifras datos={escena.cifras} letra={1} desde={0.8} />}
            </div>
            <div style={{
                position: 'absolute', left: 770, top: 170,
                opacity: entra,
                transform: `perspective(1800px) translateX(${(1 - entra) * 220}px) rotateY(${(1 - entra) * -14}deg) scale(${empuje})`,
                transformOrigin: '0 50%',
            }}>
                <Navegador ancho={1050} alto={740}>
                    <Grabacion fuentes={escena.escritorio} ancho={1050} alto={740 - BARRA} focos={suaves} />
                </Navegador>
            </div>
            {escena.celular && (
                <div style={{
                    position: 'absolute', left: 735, top: 470, opacity: celular,
                    transform: `translateY(${(1 - celular) * 160}px) rotate(${(1 - celular) * 6 - 3}deg)`,
                }}>
                    <Celular alto={560}>
                        <Grabacion fuentes={escena.celular} ancho={238} alto={540} />
                    </Celular>
                </div>
            )}
            {(escena.avisos ?? []).map((a, i) => (
                <Aviso key={a.titulo} {...a} style={SITIOS_H[i % SITIOS_H.length]} />
            ))}
        </AbsoluteFill>
    );
};
