// Dos composiciones con el mismo guion: 16:9 (web, YouTube) y 9:16 (Reels, Shorts)
import React from 'react';
import { Composition, Folder } from 'remotion';
import { DURACION, FPS } from './guion';
import { Video } from './Video';

export const Raiz: React.FC = () => (
    <Folder name="Legajo">
        <Composition id="LegajoHorizontal" component={Video} durationInFrames={DURACION} fps={FPS} width={1920} height={1080} />
        <Composition id="LegajoVertical" component={Video} durationInFrames={DURACION} fps={FPS} width={1080} height={1920} />
    </Folder>
);
