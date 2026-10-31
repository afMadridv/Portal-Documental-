// Un solo guion, dos encuadres: el tamaño de la composición decide la disposición
import { useVideoConfig } from 'remotion';

export const useFormato = () => {
    const { width, height } = useVideoConfig();
    const vertical = height > width;
    return {
        vertical,
        ancho: width,
        alto: height,
        // En Reels y Shorts la app tapa arriba (perfil) y abajo (texto, botones);
        // la columna derecha la ocupan los íconos de me gusta y comentar.
        seguro: vertical
            ? { arriba: 250, abajo: 420, izquierda: 72, derecha: 150 }
            : { arriba: 90, abajo: 90, izquierda: 110, derecha: 110 },
        // Letra más grande en celular: se ve en una pantalla de 6 pulgadas
        letra: vertical ? 1.3 : 1,
    };
};
