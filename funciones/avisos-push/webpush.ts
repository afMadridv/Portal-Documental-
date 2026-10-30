/*! Portal Documental · Web Push con WebCrypto (VAPID y cifrado aes128gcm)
    Andrés Madrid · andresmadrid.vercel.app */
// ============================================================
// Lo mínimo para mandar un aviso a un navegador, sin librerías:
//
//   firmarVapid   la cabecera Authorization (RFC 8292). Le dice al
//                 servicio de avisos (Google, Apple, Mozilla) que el
//                 aviso viene de este servidor: la llave pública es la
//                 misma con la que el navegador se suscribió.
//   cifrar        el cuerpo cifrado para ESE navegador (RFC 8291 sobre
//                 RFC 8188). Solo él tiene la llave privada que lo abre;
//                 Google o Apple lo transportan sin poder leerlo.
//
// Todo con crypto.subtle, que tienen Deno y Node 22: así se prueba en el
// equipo de desarrollo contra el ejemplo del RFC 8291 (apéndice A).
// ============================================================

const texto = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deB64u(s: string) {
  const limpio = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(limpio + '='.repeat((4 - (limpio.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Bytes con su ArrayBuffer propio: lo que piden crypto.subtle y fetch
type Bytes = ReturnType<typeof deB64u>;

function unir(...partes: Uint8Array[]): Bytes {
  const total = partes.reduce((n, p) => n + p.length, 0);
  const salida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { salida.set(p, i); i += p.length; }
  return salida;
}

async function hkdf(sal: Bytes, ikm: Bytes, info: Bytes, largo: number): Promise<Bytes> {
  const llave = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: sal, info }, llave, largo * 8));
}

/* Llave privada P-256 a partir de la pública (65 bytes, 0x04 x y) y la
   privada (32 bytes en base64url), como las da `web-push generate-vapid-keys`
   o el openssl de la guía. */
async function llavePrivada(publica: Bytes, d: string, uso: 'ECDSA' | 'ECDH'): Promise<CryptoKey> {
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64u(publica.slice(1, 33)), y: b64u(publica.slice(33, 65)), d,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: uso, namedCurve: 'P-256' }, false,
    uso === 'ECDSA' ? ['sign'] : ['deriveBits']);
}

/* «vapid t=<jwt>, k=<llave pública>». Vale 12 horas (Apple no acepta
   más de 24). `contacto` es mailto: o https: y lo exige Apple. */
export async function firmarVapid(endpoint: string, publica: string, privada: string,
                                  contacto: string): Promise<string> {
  const cabeza = b64u(texto.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const cuerpo = b64u(texto.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: contacto,
  })));
  const llave = await llavePrivada(deB64u(publica), privada, 'ECDSA');
  // WebCrypto entrega la firma como r||s (64 bytes), que es lo que pide JWS
  const firma = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, llave, texto.encode(cabeza + '.' + cuerpo)));
  return 'vapid t=' + cabeza + '.' + cuerpo + '.' + b64u(firma) + ', k=' + publica;
}

/* Cifra `mensaje` para un navegador. `fijo` es solo para la prueba con
   el ejemplo del RFC: en uso normal la sal y las llaves salen al azar. */
export async function cifrar(mensaje: Bytes, p256dh: string, auth: string,
                             fijo?: { sal: Bytes; publica: string; privada: string }): Promise<Bytes> {
  const delNavegador = deB64u(p256dh);
  const secreto = deB64u(auth);
  const sal = fijo ? fijo.sal : crypto.getRandomValues(new Uint8Array(16));

  let mia: CryptoKey;
  let miaPublica: Bytes;
  if (fijo) {
    miaPublica = deB64u(fijo.publica);
    mia = await llavePrivada(miaPublica, fijo.privada, 'ECDH');
  } else {
    const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    mia = par.privateKey;
    miaPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  }

  const suya = await crypto.subtle.importKey('raw', delNavegador, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: suya }, mia, 256));

  // RFC 8291 §3.4: primero se mezcla con el secreto de autenticación...
  const ikm = await hkdf(secreto, compartido,
    unir(texto.encode('WebPush: info\0'), delNavegador, miaPublica), 32);
  // ...y de ahí salen la llave y el nonce del contenido (RFC 8188)
  const cek = await hkdf(sal, ikm, texto.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(sal, ikm, texto.encode('Content-Encoding: nonce\0'), 12);

  // Un solo registro: el mensaje, el delimitador 0x02 y nada de relleno
  const llave = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, llave, unir(mensaje, new Uint8Array([2]))));

  // Cabecera: sal (16) | tamaño de registro (4) | largo de la llave (1) | llave
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return unir(sal, rs, new Uint8Array([miaPublica.length]), miaPublica, cifrado);
}
