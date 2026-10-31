// Arma el video con las escenas del guion y transiciones entre ellas
import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { ESCENAS, TRANSICION, seg, type Escena } from './guion';
import { useFormato } from './formato';
import { EscenaUI } from './escenas/EscenaUI';
import { Cierre, Dias, Gancho, Marca, Problema } from './escenas/Movimiento';

const pintar = (e: Escena) => {
    switch (e.tipo) {
        case 'ui': return <EscenaUI escena={e} />;
        case 'gancho': return <Gancho />;
        case 'problema': return <Problema />;
        case 'marca': return <Marca />;
        case 'dias': return <Dias />;
        case 'cierre': return <Cierre />;
    }
};

export const Video: React.FC = () => {
    const { vertical } = useFormato();
    // Entre pantallas de interfaz se desliza; hacia y desde el motion, fundido
    const deslizar = slide({ direction: vertical ? 'from-bottom' : 'from-right' });
    return (
        <TransitionSeries>
            {ESCENAS.map((e, i) => {
                const siguiente = ESCENAS[i + 1];
                const ambasUI = e.tipo === 'ui' && siguiente?.tipo === 'ui';
                return (
                    <React.Fragment key={e.id}>
                        <TransitionSeries.Sequence durationInFrames={seg(e.dura)}>{pintar(e)}</TransitionSeries.Sequence>
                        {siguiente && (
                            <TransitionSeries.Transition
                                presentation={ambasUI ? deslizar : fade()}
                                timing={linearTiming({ durationInFrames: TRANSICION })}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </TransitionSeries>
    );
};
