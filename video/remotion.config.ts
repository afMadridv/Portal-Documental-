// Ajustes de render de Remotion: H.264, cuadros en JPEG y sobrescribir la salida
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setOverwriteOutput(true);
