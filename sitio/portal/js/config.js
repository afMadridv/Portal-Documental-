/*! Portal Documental · configuración
  nube = Supabase, local = datos de práctica en este navegador.
  La clave anónima es pública; lo que protege los datos son las reglas RLS.
  Andrés Madrid · andresmadrid.vercel.app */
const PORTAL_CONFIG = {
    MODO: 'nube',
    // Proyecto de Supabase (https://<proyecto>.supabase.co) y su clave anónima.
    // Vacíos: el portal corre en modo práctica, con datos de ejemplo en el navegador.
    SUPABASE_URL: 'https://nsjytwlbqnxpkdbsfiva.supabase.co',
    SUPABASE_KEY: 'sb_publishable_3L0wDX-oGufHLP8vH7ECzQ_8LLJnI5p',
    // Debe coincidir con DOMINIO_USUARIOS de las funciones y de la base
    DOMINIO_USUARIOS: 'portal.documental.com',
    // Datos de la entidad que usa el portal: consentimiento, páginas legales y correos
    ENTIDAD: {
        NOMBRE: 'Su Entidad',
        RAZON_SOCIAL: 'Su Entidad S.A.S.',
        NIT: '000.000.000-0',
        REGISTRO: 'Matrícula mercantil 00000000 · Cámara de Comercio de su ciudad',
        DIRECCION: 'Dirección de la oficina principal',
        CIUDAD: 'Su ciudad',
        CORREO: 'contacto@su-entidad.com',
        TELEFONO: '+57 300 000 0000',
        WEB: ''
    }
};
