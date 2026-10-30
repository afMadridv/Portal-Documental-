/*! Portal Documental · Edge Function avisos-push
    Andrés Madrid · andresmadrid.vercel.app */
// ============================================================
// Edge Function: avisos-push
// Lleva los avisos de la campana del administrador a su celular (o
// computador), aunque el portal esté cerrado.
//
//   GET   la llave pública VAPID. La pide el portal para suscribir el
//         navegador. Es pública por diseño.
//   POST  {"ids": [12, 13]} desde la base (disparador push_avisos, por
//         pg_net). Toma esos avisos con push_tomar(), los cifra para
//         cada equipo y los entrega por Web Push. Después anota cómo le
//         fue a cada equipo con push_resultado().
//
// QUIÉN PUEDE HACER POST
//   Supabase cloud: la base manda la cabecera x-aviso-clave con el valor
//   de push_ajustes.clave, que debe ser igual al secreto AVISOS_CLAVE.
//   Se despliega con verify_jwt = false (la base no tiene un JWT).
//   Autohospedado sin AVISOS_CLAVE: la base llama a
//   http://functions:9000/avisos-push y lo que trae X-Forwarded-For
//   (vino de internet) se rechaza.
//   Aun si pasara, push_tomar entrega cada aviso una sola vez, a su dueño
//   y solo si es reciente: no hay forma de inventar ni repetir avisos.
//
// SECRETOS DE LA FUNCIÓN:
//   VAPID_PUBLICA    llave pública, base64url (87 caracteres)
//   VAPID_PRIVADA    llave privada, base64url (43 caracteres)
//   VAPID_CONTACTO   mailto:alguien@dominio. Apple y Google lo piden.
//   AVISOS_CLAVE     texto al azar, el mismo de push_ajustes.clave
//   SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase solo.
//
// OPCIONAL:
//   ORIGENES_PERMITIDOS  dominios del portal separados por coma
//                        (https://portal.su-entidad.com).
//
// DESPLIEGUE
//   supabase functions deploy avisos-push --no-verify-jwt
// ============================================================

import { cifrar, firmarVapid } from './webpush.ts';

const ORIGENES = (Deno.env.get('ORIGENES_PERMITIDOS') ||
  'http://localhost:8731,http://127.0.0.1:8731')
  .split(',').map((o) => o.trim()).filter(Boolean);

function cabecerasCors(origen: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origen && ORIGENES.includes(origen) ? origen : ORIGENES[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(obj: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/* Una variable del .env sin comillas ni espacios alrededor */
function variable(nombre: string): string {
  return (Deno.env.get(nombre) || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

// ---- Lo que se ve en el celular ----
const TITULOS: Record<string, string> = {
  'archivo-admin': 'Documento nuevo',
  'audiencia-nueva': 'Audiencia programada',
  'proceso-nuevo': 'Proceso nuevo',
  'proceso-estado': 'Cambio de estado',
  'proceso-semaforo': 'Semáforo del proceso',
  'tramite-pausado': 'Trámite en pausa',
  'tramite-reactivado': 'Trámite reactivado',
  'tramite-finalizado': 'Trámite finalizado',
  'tramite-fin': 'Trámite finalizado',
  'tramite-prorroga': 'Prórroga del trámite',
  'soporte': 'Soporte',
  'ingreso-cuenta': 'Ingreso a tu cuenta',
  'solicitud-clave': 'Solicitud de contraseña',
  'audiencia-hoy': 'Audiencia hoy',
  'audiencia-manana': 'Audiencia mañana',
  'recordatorio': 'Recordatorio',
  'proceso-vencido': 'Proceso vencido',
  'push-prueba': 'Prueba de avisos',
};
const titulo = (tipo: string) => TITULOS[tipo] || (tipo.startsWith('plazo-') ? 'Plazo del trámite' : 'Portal Documental');

// Lo que no puede esperar suena aunque el celular esté ahorrando batería
const URGENTES = ['soporte', 'accesos', 'prueba'];

type Aviso = {
  id: number; tipo: string; mensaje: string; categoria: string;
  carpeta: number | null; notaria: string | null;
};
type Equipo = { id: number; endpoint: string; p256dh: string; auth: string; avisos: Aviso[] };

/* Etiqueta: el celular junta en una sola notificación las que la
   comparten (los cinco documentos de una misma carpeta, por ejemplo). */
function etiqueta(a: Aviso): string {
  if (a.categoria === 'documentos' || a.categoria === 'estados') return a.categoria + '-' + (a.carpeta ?? 0);
  if (['soporte', 'calendario', 'prueba'].includes(a.categoria)) return a.categoria;
  return a.categoria + '-' + a.id;
}

/* Hasta tres avisos van uno por uno; más, en un resumen. Así la tarea
   de la mañana no hace vibrar el celular veinte veces seguidas. */
function mensajes(avisos: Aviso[]): Record<string, unknown>[] {
  const uno = (a: Aviso) => ({
    t: titulo(a.tipo),
    b: (a.notaria ? a.notaria + ' · ' : '') + a.mensaje,
    tipo: a.tipo, cat: a.categoria, c: a.carpeta, g: etiqueta(a),
  });
  if (avisos.length <= 3) return avisos.map(uno);
  return [{
    t: avisos.length + ' avisos nuevos',
    b: avisos.slice(0, 3).map((a) => '• ' + a.mensaje).join('\n') +
       (avisos.length > 3 ? '\n…y ' + (avisos.length - 3) + ' más en la campana' : ''),
    tipo: 'resumen', cat: 'resumen', c: null, g: 'resumen',
  }];
}

/* Un aviso a un equipo. Devuelve el código del servicio de avisos
   (201 bien, 404 / 410 el navegador ya no existe), o 0 si no hubo
   respuesta. */
async function entregar(e: Equipo, carga: Record<string, unknown>, vapid: { pub: string; priv: string; contacto: string }): Promise<number> {
  let cuerpo: Awaited<ReturnType<typeof cifrar>>;
  try {
    cuerpo = await cifrar(new TextEncoder().encode(JSON.stringify(carga)), e.p256dh, e.auth);
  } catch (err) {
    // Llaves que no son de la curva: ese equipo no va a servir nunca.
    // 410 hace que push_resultado lo borre; los demás siguen.
    console.error('avisos-push: las llaves de un equipo no sirven, se quita:', err);
    return 410;
  }
  const corta = new AbortController();
  const reloj = setTimeout(() => corta.abort(), 8000);
  try {
    const r = await fetch(e.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await firmarVapid(e.endpoint, vapid.pub, vapid.priv, vapid.contacto),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // Un día: si el celular está apagado más tiempo, el aviso ya no sirve
        'TTL': carga.cat === 'prueba' ? '600' : '86400',
        'Urgency': URGENTES.includes(String(carga.cat)) ? 'high' : 'normal',
      },
      body: cuerpo,
      signal: corta.signal,
    });
    if (r.status >= 400) {
      console.error('avisos-push: el servicio respondió', r.status, 'a un equipo:',
                    (await r.text().catch(() => '')).slice(0, 200));
    } else {
      await r.body?.cancel().catch(() => {});
    }
    return r.status;
  } catch (err) {
    console.error('avisos-push: sin respuesta del servicio de avisos:', err);
    return 0;
  } finally {
    clearTimeout(reloj);
  }
}

/* Una función de la base, con la llave de servicio */
async function rpc(nombre: string, args: unknown): Promise<unknown> {
  const url = Deno.env.get('SUPABASE_URL');
  const clave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !clave) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(url + '/rest/v1/rpc/' + nombre, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: clave, Authorization: 'Bearer ' + clave },
    body: JSON.stringify(args),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(nombre + ' respondió ' + r.status + ': ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

Deno.serve(async (req: Request) => {
  const origen = req.headers.get('Origin');
  const cors = cabecerasCors(origen);
  const responder = (obj: unknown, status = 200) => json(obj, status, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origen && !ORIGENES.includes(origen)) return responder({ error: 'Origen no permitido.' }, 403);

  const vapid = {
    pub: variable('VAPID_PUBLICA'),
    priv: variable('VAPID_PRIVADA'),
    contacto: variable('VAPID_CONTACTO') || 'mailto:soporte@example.com',
  };
  const configurado = /^[A-Za-z0-9_-]{87}$/.test(vapid.pub) && /^[A-Za-z0-9_-]{43}$/.test(vapid.priv);

  if (req.method === 'GET') {
    if (!configurado) return responder({ error: 'Los avisos no están configurados en el servidor.', configurar: true }, 503);
    return responder({ publica: vapid.pub });
  }
  if (req.method !== 'POST') return responder({ error: 'Método no permitido.' }, 405);

  // Con AVISOS_CLAVE (cloud) manda la clave; sin ella, solo desde dentro
  const secreto = variable('AVISOS_CLAVE');
  if (secreto ? req.headers.get('x-aviso-clave') !== secreto : !!req.headers.get('x-forwarded-for')) {
    return responder({ error: 'No permitido.' }, 403);
  }
  if (!configurado) {
    console.error('avisos-push: faltan VAPID_PUBLICA / VAPID_PRIVADA; los avisos se quedan en la campana.');
    return responder({ error: 'Sin claves VAPID.' }, 503);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const ids = (Array.isArray(body?.ids) ? body.ids : [])
      .map((x: unknown) => Number(x)).filter((x: number) => Number.isInteger(x) && x > 0).slice(0, 500);
    if (!ids.length) return responder({ ok: true, equipos: 0 });

    const equipos = (await rpc('push_tomar', { p_ids: ids }) || []) as Equipo[];
    const resultados = await Promise.all(equipos.map(async (e) => {
      let estado = 0;
      for (const carga of mensajes(e.avisos || [])) {
        estado = await entregar(e, carga, vapid);
        if (estado === 404 || estado === 410) break;   // ese navegador ya no existe
      }
      return { id: e.id, estado };
    }));
    if (resultados.length) {
      await rpc('push_resultado', { p_resultados: resultados }).catch((err) =>
        console.error('avisos-push: no se pudo anotar el resultado:', err));
    }
    return responder({ ok: true, equipos: resultados.length });
  } catch (e) {
    console.error('avisos-push:', e);
    return responder({ error: 'No se pudieron enviar los avisos.' }, 500);
  }
});
