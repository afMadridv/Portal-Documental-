// La interfaz real: la primera fuente que exista en public/ (grabación MP4 o
// captura fija), con encuadre animado. Si no hay ninguna, deja un hueco con el
// nombre para saber qué grabar.
import React from 'react';
import { Easing, Img, OffthreadVideo, getStaticFiles, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { COLOR, FUENTE } from '../marca';
import { seg, type Foco, type Fuente } from '../guion';

const fijo = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

function encuadre(frame: number, focos: Foco[]) {
    if (focos.length === 0) return { x: 0.5, y: 0.5, zoom: 1 };
    if (focos.length === 1) return focos[0];
    const t = focos.map((f) => seg(f.en));
    const suave = { ...fijo, easing: Easing.inOut(Easing.cubic) };
    return {
        x: interpolate(frame, t, focos.map((f) => f.x), suave),
        y: interpolate(frame, t, focos.map((f) => f.y), suave),
        zoom: interpolate(frame, t, focos.map((f) => f.zoom), suave),
    };
}

export const Grabacion: React.FC<{ fuentes: Fuente[]; ancho: number; alto: number; focos?: Foco[] }> = ({
    fuentes, ancho, alto, focos = [],
}) => {
    const frame = useCurrentFrame();
    const hay = getStaticFiles().map((f) => f.name);
    const fuente = fuentes.find((f) => hay.includes(f.archivo));
    if (!fuente) return <Hueco archivo={fuentes[0].archivo} />;

    // Una captura fija se acerca despacio para no quedar quieta
    const esImagen = /\.(webp|png|jpe?g)$/i.test(fuente.archivo);
    const deriva = esImagen ? interpolate(frame, [0, seg(8)], [1, 1.06], fijo) : 1;
    const e = encuadre(frame, focos);
    const zoom = Math.max(1, e.zoom * deriva);

    // Tamaño que cubre el marco y punto de foco (x, y de la fuente) al centro,
    // sin dejar ver los bordes
    const base = Math.max(ancho, alto * fuente.proporcion);
    const w = base * zoom;
    const h = (base / fuente.proporcion) * zoom;
    const izquierda = Math.min(0, Math.max(ancho - w, ancho / 2 - e.x * w));
    const arriba = Math.min(0, Math.max(alto - h, alto / 2 - e.y * h));
    const estilo: React.CSSProperties = { position: 'absolute', left: izquierda, top: arriba, width: w, height: h, maxWidth: 'none' };
    return (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: COLOR.fondo }}>
            {esImagen
                ? <Img src={staticFile(fuente.archivo)} style={estilo} />
                : <OffthreadVideo src={staticFile(fuente.archivo)} muted style={estilo} />}
        </div>
    );
};

const Hueco: React.FC<{ archivo: string }> = ({ archivo }) => (
    <div style={{
        position: 'absolute', inset: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12, border: `3px dashed ${COLOR.kraft}`, borderRadius: 14, background: '#F7F2E9', textAlign: 'center', padding: 24,
    }}>
        <span style={{ font: `500 20px ${FUENTE.mono}`, color: COLOR.kraftTxt, letterSpacing: '.06em' }}>GRABACIÓN PENDIENTE</span>
        <span style={{ font: `400 22px ${FUENTE.mono}`, color: COLOR.carton }}>public/{archivo}</span>
    </div>
);
