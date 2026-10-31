// Logotipo 2a (el clip arma la «L») e ícono 1c (carpeta kraft con clip), animados
import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { evolvePath } from '@remotion/paths';
import { COLOR, FUENTE } from '../marca';
import { seg } from '../guion';

const CLIP_L = 'M34 44H13a3 3 0 0 1-3-3V10a4 4 0 0 1 8 0v28h18a5 5 0 0 1 0 10H9a6 6 0 0 1-6-6V6';
const CLIP_ICONO = 'M14 28V12a5 5 0 0 1 10 0v12M19 28V14';
const fijo = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const Logo: React.FC<{ tam: number; desde?: number; color?: string; clip?: string }> = ({
    tam, desde = 0, color = COLOR.fondo, clip = COLOR.kraft,
}) => {
    const frame = useCurrentFrame() - seg(desde);
    const { fps } = useVideoConfig();
    const trazo = interpolate(frame, [0, fps * 0.9], [0, 1], { ...fijo, easing: Easing.bezier(0.65, 0, 0.35, 1) });
    const texto = interpolate(frame, [fps * 0.55, fps * 1.1], [0, 1], { ...fijo, easing: Easing.out(Easing.cubic) });
    const { strokeDasharray, strokeDashoffset } = evolvePath(trazo, CLIP_L);
    return (
        <div style={{
            display: 'flex', alignItems: 'flex-end', gap: tam * 0.07,
            fontFamily: FUENTE.logo, fontWeight: 700, fontSize: tam, lineHeight: 0.74,
            letterSpacing: '-0.035em', color, whiteSpace: 'nowrap',
        }}>
            <svg width={tam * 0.615} height={tam * 0.775} viewBox="0 0 40 51" style={{ overflow: 'visible' }}>
                <path d={CLIP_L} fill="none" stroke={clip} strokeWidth={tam > 120 ? 2.8 : 3.6}
                    strokeLinecap="round" strokeLinejoin="round"
                    strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
            </svg>
            <span style={{ clipPath: `inset(-40% ${(1 - texto) * 100}% -50% 0)` }}>egajo</span>
        </div>
    );
};

export const Icono: React.FC<{ tam: number; desde?: number; clip?: string; fondo?: [string, string] }> = ({
    tam, desde = 0, clip = COLOR.fondo, fondo = [COLOR.kraft, COLOR.kraft2],
}) => {
    const frame = useCurrentFrame() - seg(desde);
    const { fps } = useVideoConfig();
    const caida = spring({ frame, fps, config: { damping: 11, stiffness: 140 } });
    const trazo = interpolate(frame, [fps * 0.25, fps * 0.8], [0, 1], fijo);
    const { strokeDasharray, strokeDashoffset } = evolvePath(trazo, CLIP_ICONO);
    return (
        <svg width={tam} height={tam} viewBox="0 0 64 64" style={{
            opacity: Math.min(1, caida * 1.5),
            transform: `translateY(${(1 - caida) * -tam * 0.4}px) rotate(${(1 - caida) * -8}deg)`,
        }}>
            <rect x="8" y="18" width="48" height="36" rx="5" fill={fondo[0]} />
            <path d={CLIP_ICONO} fill="none" stroke={clip} strokeWidth="4" strokeLinecap="round"
                strokeDasharray={strokeDasharray} strokeDashoffset={strokeDashoffset} />
            <rect x="8" y="30" width="48" height="24" rx="5" fill={fondo[1]} />
        </svg>
    );
};
