/*! Legajo · plantillas de correo
  Bienvenida, contraseña nueva y "todo va por el portal". Cada una
  devuelve { asunto, html, texto }.
  Tablas y estilos en línea a propósito: Gmail y Outlook se comen el
  CSS normal. 600 px de ancho para que quepa en Outlook.
  Andrés Madrid · andresmadrid.vercel.app */

const CORREO = {
    cian:   '#7A5A26',   // kraft oscuro: con el kraft claro el blanco no se lee
    navy:   '#454B48',   // gris pizarra
    navy700:'#2F3431',
    gris:   '#5F6562',
    borde:  '#E2E4E3',
    fondo:  '#F2F3F3',
    rojo:   '#A2452F',
    rojoBg: '#F6E3DD',
    ambar:  '#7A5A26',
    ambarBg:'#F3E8D4'
};

const CORREO_FUENTE = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

function _esc(t) {
    return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* Saludo con el rol: "Buen día, monitor Juan Pérez:" */
const ROL_CORREO = { administrador: 'administrador', monitor: 'monitor', operador: 'operador',
                     cliente: 'cliente', acreedor: 'acreedor' };
function _saludo(d, html) {
    const nombre = d.nombre ? (html ? '<strong>' + _esc(d.nombre) + '</strong>' : d.nombre) : '';
    const quien = [ROL_CORREO[d.rol] || '', nombre].filter(Boolean).join(' ');
    return 'Buen día' + (quien ? ', ' + quien : '') + ':';
}

/* Cabecera con el nombre del portal y la notaría. */
function _cabecera(notaria) {
    return '' +
    '<tr><td style="background:' + CORREO.navy + ';padding:22px 28px;">' +
      '<div style="font:700 20px/1.2 ' + CORREO_FUENTE + ';color:#ffffff;letter-spacing:.5px;">' +
        'LEGAJO</div>' +
      (notaria
        ? '<div style="font:400 13px/1.4 ' + CORREO_FUENTE + ';color:#D9C29A;padding-top:4px;">' +
            _esc(notaria) + '</div>'
        : '') +
    '</td></tr>';
}

/* Franja bajo la cabecera. */
function _franja(texto, color) {
    return '<tr><td style="background:' + (color || CORREO.cian) + ';padding:10px 28px;' +
        'font:700 13px/1.2 ' + CORREO_FUENTE + ';color:#ffffff;letter-spacing:1px;">' +
        _esc(texto).toUpperCase() + '</td></tr>';
}

/* Botón en tabla: Outlook no respeta el padding de un <a>. */
function _boton(texto, url) {
    return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">' +
      '<tr><td style="background:' + CORREO.cian + ';border-radius:6px;">' +
        '<a href="' + _esc(url) + '" style="display:inline-block;padding:13px 28px;' +
          'font:700 15px/1 ' + CORREO_FUENTE + ';color:#ffffff;text-decoration:none;">' +
          _esc(texto) + '</a>' +
      '</td></tr>' +
    '</table>';
}

/* Recuadro de usuario y contraseña (bienvenida y contraseña nueva). */
function _cajaDatos(usuario, clave) {
    const fila = (eti, valor) => '' +
        '<tr>' +
          '<td width="110" style="font:400 13px/1.8 ' + CORREO_FUENTE + ';color:' + CORREO.gris + ';">' +
            eti + '</td>' +
          '<td style="font:700 17px/1.8 \'Courier New\',Courier,monospace;color:' + CORREO.navy + ';">' +
            _esc(valor || '') + '</td>' +
        '</tr>';
    return '' +
    '<tr><td style="padding:4px 28px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
          'style="border:2px solid ' + CORREO.cian + ';border-radius:6px;">' +
        '<tr><td style="background:' + CORREO.cian + ';padding:8px 16px;' +
            'font:700 12px/1.2 ' + CORREO_FUENTE + ';color:#ffffff;letter-spacing:1px;">' +
          'TUS DATOS DE INGRESO</td></tr>' +
        '<tr><td style="padding:16px;">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' +
            fila('Usuario', usuario) + fila('Contraseña', clave) +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>';
}

/* Aviso de no compartir la contraseña. */
function _avisoClave() {
    return '' +
    '<tr><td style="padding:18px 28px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
          'style="background:' + CORREO.ambarBg + ';border-left:4px solid ' + CORREO.ambar + ';">' +
        '<tr><td style="padding:12px 16px;font:400 13px/1.6 ' + CORREO_FUENTE + ';color:' + CORREO.ambar + ';">' +
          '<strong>Guarda este correo o anota los datos en un lugar seguro.</strong><br>' +
          'No compartas tu contraseña con nadie. Nadie te la va a pedir por ' +
          'correo, por teléfono ni por WhatsApp.' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>';
}

function _envoltura(interior) {
    return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
        'style="background:#ECEDEC;padding:24px 12px;">' +
      '<tr><td align="center">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" ' +
            'style="width:600px;max-width:100%;background:#ffffff;border:1px solid ' + CORREO.borde + ';">' +
          interior +
        '</table>' +
      '</td></tr>' +
    '</table>';
}

/* ============ 0. BIENVENIDA ============
   Primer correo: credenciales y qué es el portal, todo junto. */
function correoBienvenida(d) {
    d = d || {};
    const portal = d.portal || '';
    const cuerpo = '' +
    _cabecera(d.notaria) +
    _franja('Bienvenido a Legajo') +
    '<tr><td style="padding:28px 28px 8px;font:400 15px/1.65 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
      '<p style="margin:0 0 16px;">' + _saludo(d, true) + '</p>' +
      '<p style="margin:0 0 12px;">Se abrió tu cuenta en el <strong>Legajo</strong>, ' +
        'que es donde se lleva tu trámite de principio a fin. Abajo están los datos con los ' +
        'que entras.</p>' +
      (d.carpeta
        ? '<p style="margin:0 0 12px;">Tu carpeta es: <strong>' + _esc(d.carpeta) + '</strong></p>'
        : '') +
    '</td></tr>' +

    _cajaDatos(d.usuario, d.clave) +

    (portal ? '<tr><td style="padding:14px 28px 0;">' + _boton('Entrar al portal', portal) +
      '<p style="margin:-8px 0 8px;font:400 13px/1.5 ' + CORREO_FUENTE + ';color:' + CORREO.gris + ';">' +
        'Si el botón no abre, copia esta dirección en el navegador:<br>' +
        '<span style="color:' + CORREO.cian + ';">' + _esc(portal) + '</span></p>' +
    '</td></tr>' : '') +

    '<tr><td style="padding:6px 28px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
          'style="background:' + CORREO.fondo + ';border:1px solid ' + CORREO.borde + ';">' +
        '<tr><td style="padding:14px 16px;font:400 13px/1.7 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
          '<strong>Qué vas a encontrar ahí</strong><br>' +
          '• El <strong>expediente completo</strong>, con todos los documentos del trámite.<br>' +
          '• Las <strong>audiencias</strong>: fecha, hora y el enlace para conectarte.<br>' +
          '• La <strong>etapa</strong> en que va el proceso y los plazos en días hábiles.<br>' +
          '• Los documentos nuevos, en cuanto se agregan.<br>' +
          '<br>' +
          'No se envía nada por separado ni por otro canal. <strong>Entra con frecuencia</strong>: ' +
          'los plazos corren en días hábiles y no esperan.' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>' +

    _avisoClave() +
    '<tr><td style="padding:8px 28px 26px;"></td></tr>';

    const texto =
        'LEGAJO' + (d.notaria ? ' — ' + d.notaria : '') + '\n' +
        'BIENVENIDO A LEGAJO\n\n' +
        _saludo(d) + '\n\n' +
        'Se abrió tu cuenta en Legajo, que es donde se lleva tu trámite\n' +
        'de principio a fin. Abajo están los datos con los que entras.\n\n' +
        (d.carpeta ? 'Tu carpeta es: ' + d.carpeta + '\n\n' : '') +
        '--------------------------------\n' +
        ' TUS DATOS DE INGRESO\n' +
        ' Usuario:    ' + (d.usuario || '') + '\n' +
        ' Contraseña: ' + (d.clave || '') + '\n' +
        '--------------------------------\n\n' +
        (portal ? 'Entra aquí: ' + portal + '\n\n' : '') +
        'Qué vas a encontrar ahí:\n' +
        '- El expediente completo, con todos los documentos del trámite.\n' +
        '- Las audiencias: fecha, hora y el enlace para conectarte.\n' +
        '- La etapa en que va el proceso y los plazos en días hábiles.\n' +
        '- Los documentos nuevos, en cuanto se agregan.\n\n' +
        'No se envía nada por separado ni por otro canal. Entra con frecuencia: los\n' +
        'plazos corren en días hábiles y no esperan.\n\n' +
        'Guarda este correo o anota los datos en un lugar seguro. No compartas tu\n' +
        'contraseña con nadie. Nadie te la va a pedir por correo, por teléfono ni\n' +
        'por WhatsApp.\n';

    return {
        asunto: 'Tus datos de acceso a Legajo',
        html: _envoltura(cuerpo),
        texto: texto
    };
}

/* ============ 1. CONTRASEÑA NUEVA ============
   Usuario y contraseña al final, en su recuadro, fáciles de copiar. */
function correoCredenciales(d) {
    d = d || {};
    const portal = d.portal || '';
    const cuerpo = '' +
    _cabecera(d.notaria) +
    _franja('Datos de acceso') +
    '<tr><td style="padding:28px 28px 8px;font:400 15px/1.65 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
      '<p style="margin:0 0 16px;">' + _saludo(d, true) + '</p>' +
      '<p style="margin:0 0 16px;">Tu contraseña de Legajo fue cambiada. ' +
        'Desde ahora entra con los datos que aparecen abajo. La contraseña anterior ya no sirve.</p>' +
      (portal ? '<p style="margin:0 0 4px;">Entra aquí:</p>' + _boton('Entrar al portal', portal) +
        '<p style="margin:0 0 16px;font:400 13px/1.5 ' + CORREO_FUENTE + ';color:' + CORREO.gris + ';">' +
          'Si el botón no abre, copia esta dirección en el navegador:<br>' +
          '<span style="color:' + CORREO.cian + ';">' + _esc(portal) + '</span></p>' : '') +
    '</td></tr>' +

    _cajaDatos(d.usuario, d.clave) +
    _avisoClave() +
    '<tr><td style="padding:8px 28px 26px;"></td></tr>';

    const texto =
        'LEGAJO' + (d.notaria ? ' — ' + d.notaria : '') + '\n' +
        'DATOS DE ACCESO\n\n' +
        _saludo(d) + '\n\n' +
        'Tu contraseña de Legajo fue cambiada. Desde ahora entra con los\n' +
        'datos que aparecen abajo. La contraseña anterior ya no sirve.\n\n' +
        (portal ? 'Entra aquí: ' + portal + '\n\n' : '') +
        '--------------------------------\n' +
        ' TUS DATOS DE INGRESO\n' +
        ' Usuario:    ' + (d.usuario || '') + '\n' +
        ' Contraseña: ' + (d.clave || '') + '\n' +
        '--------------------------------\n\n' +
        'Guarda este correo o anota los datos en un lugar seguro. No compartas tu\n' +
        'contraseña con nadie. Nadie te la va a pedir por correo, por teléfono ni\n' +
        'por WhatsApp.\n';

    return {
        asunto: 'Legajo: tus datos de acceso' + (d.usuario ? ' (' + d.usuario + ')' : ''),
        html: _envoltura(cuerpo),
        texto: texto
    };
}

/* ============ 2. TODO VA POR EL PORTAL ============
   Para el deudor y los acreedores: el expediente, las audiencias y los
   plazos se siguen ahí. */
function correoDocumentos(d) {
    d = d || {};
    const portal = d.portal || '';
    const paso = (n, titulo, detalle) => '' +
        '<tr>' +
          '<td width="34" valign="top" style="padding:0 0 14px;">' +
            '<div style="width:26px;height:26px;background:' + CORREO.cian + ';border-radius:13px;' +
              'font:700 14px/26px ' + CORREO_FUENTE + ';color:#ffffff;text-align:center;">' + n + '</div>' +
          '</td>' +
          '<td valign="top" style="padding:0 0 14px;font:400 14px/1.55 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
            '<strong>' + _esc(titulo) + '</strong><br>' +
            '<span style="color:' + CORREO.gris + ';">' + _esc(detalle) + '</span>' +
          '</td>' +
        '</tr>';

    const cuerpo = '' +
    _cabecera(d.notaria) +
    _franja('Tu trámite se lleva por el portal') +
    '<tr><td style="padding:28px 28px 4px;font:400 15px/1.65 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
      '<p style="margin:0 0 16px;">' + _saludo(d, true) + '</p>' +
      '<p style="margin:0 0 12px;"><strong>Todo tu trámite se lleva en Legajo.</strong> ' +
        'Ahí está el expediente completo, los documentos que se van agregando, las audiencias ' +
        'con su fecha y su enlace para conectarte, y en qué etapa va el proceso.</p>' +
      '<p style="margin:0 0 12px;">No se envía nada por separado ni por otro canal: lo que ' +
        'necesites saber de tu proceso está ahí, y ahí es donde hay que mirarlo. ' +
        '<strong>Entra con frecuencia</strong>: los plazos corren en días hábiles y no esperan.</p>' +
      (d.carpeta
        ? '<p style="margin:0 0 8px;">Tu carpeta en el portal es: <strong>' + _esc(d.carpeta) + '</strong></p>'
        : '') +
    '</td></tr>' +

    (portal ? '<tr><td style="padding:0 28px;">' + _boton('Entrar al portal', portal) +
      '<p style="margin:-8px 0 8px;font:400 13px/1.5 ' + CORREO_FUENTE + ';color:' + CORREO.gris + ';">' +
        'Si el botón no abre, copia esta dirección en el navegador:<br>' +
        '<span style="color:' + CORREO.cian + ';">' + _esc(portal) + '</span></p>' +
    '</td></tr>' : '') +

    '<tr><td style="padding:8px 28px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' +
        paso(1, 'Entra con tu usuario y contraseña',
             'Son los que te entregó la notaría. Si no los tienes, responde este correo.') +
        paso(2, 'Abre tu carpeta',
             'Verás el nombre de tu proceso en la lista de carpetas.') +
        paso(3, 'Consulta los documentos',
             'Se abren en el navegador sin descargar nada, y cada uno tiene su botón de descarga.') +
      '</table>' +
    '</td></tr>' +

    '<tr><td style="padding:6px 28px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
          'style="background:' + CORREO.fondo + ';border:1px solid ' + CORREO.borde + ';">' +
        '<tr><td style="padding:14px 16px;font:400 13px/1.7 ' + CORREO_FUENTE + ';color:' + CORREO.navy + ';">' +
          '<strong>Qué vas a encontrar en tu carpeta</strong><br>' +
          '• El <strong>expediente completo</strong>, con todos los documentos del trámite.<br>' +
          '• Las <strong>audiencias programadas</strong>: fecha, hora y el enlace para conectarte.<br>' +
          '• La <strong>etapa</strong> en que va el proceso y los plazos en días hábiles.<br>' +
          '• Los documentos nuevos, en cuanto se agregan.<br>' +
          '• Puedes descargar el expediente entero de una vez, en un solo archivo comprimido.<br>' +
          '• Entra desde el computador o desde el celular, con la misma cuenta. ' +
            'Solo puede estar abierta en un dispositivo a la vez.' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>' +

    '<tr><td style="padding:8px 28px 26px;"></td></tr>';

    const texto =
        'LEGAJO' + (d.notaria ? ' — ' + d.notaria : '') + '\n' +
        'TU TRÁMITE SE LLEVA POR EL PORTAL\n\n' +
        _saludo(d) + '\n\n' +
        'Todo tu trámite se lleva en Legajo. Ahí está el expediente\n' +
        'completo, los documentos que se van agregando, las audiencias con su fecha y\n' +
        'su enlace para conectarte, y en qué etapa va el proceso.\n\n' +
        'No se envía nada por separado ni por otro canal: lo que necesites saber de tu\n' +
        'proceso está ahí, y ahí es donde hay que mirarlo. Entra con frecuencia: los\n' +
        'plazos corren en días hábiles y no esperan.\n\n' +
        (d.carpeta ? 'Tu carpeta en el portal es: ' + d.carpeta + '\n\n' : '') +
        (portal ? 'Entra aquí: ' + portal + '\n\n' : '') +
        '1. Entra con tu usuario y contraseña.\n' +
        '2. Abre tu carpeta.\n' +
        '3. Consulta los documentos: se abren en el navegador, y cada uno tiene su\n' +
        '   botón de descarga.\n\n' +
        'Qué vas a encontrar en tu carpeta:\n' +
        '- El expediente completo, con todos los documentos del trámite.\n' +
        '- Las audiencias programadas: fecha, hora y el enlace para conectarte.\n' +
        '- La etapa en que va el proceso y los plazos en días hábiles.\n' +
        '- Los documentos nuevos, en cuanto se agregan.\n' +
        '- Puedes descargar el expediente entero de una vez, comprimido.\n' +
        '- Entra desde el computador o desde el celular, con la misma cuenta.\n' +
        '  Solo puede estar abierta en un dispositivo a la vez.\n';

    return {
        asunto: 'Tu trámite se lleva en Legajo',
        html: _envoltura(cuerpo),
        texto: texto
    };
}

const FORMATOS_CORREO = {
    bienvenida:   { titulo: 'Bienvenida (cuenta nueva)',          arma: correoBienvenida },
    credenciales: { titulo: 'Contraseña nueva',                   arma: correoCredenciales },
    documentos:   { titulo: 'Ver documentos del trámite',         arma: correoDocumentos }
};
