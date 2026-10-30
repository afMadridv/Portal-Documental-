/*! Portal Documental · modo de uso (pasos y video corto por tema)
    Andrés Madrid · andresmadrid.vercel.app */
(function () {
    /* Dos pestañas. El administrador y el monitor ven las dos;
       el operador la suya; cliente y acreedor la de ellos. */
    const PESTANAS = [
        { id: 'operador', titulo: 'Operador', roles: ['administrador', 'operador', 'monitor'] },
        { id: 'partes', titulo: 'Cliente y acreedor', roles: ['administrador', 'monitor', 'cliente', 'acreedor'] }
    ];

    /* Cada tema: pestaña, título, pasos y video opcional.
       Los videos van en portal/manual/videos/ ya pasados por
       herramientas/optimizar_videos.sh (H.264, 720p, arranque rápido). */
    const TEMAS = [
        {
            id: 'semaforo',
            pestana: 'operador',
            titulo: 'Cómo actualizar el semáforo de un plazo de insolvencia',
            resumen: 'El color lo calcula el portal con días hábiles. Usted lo mueve al completar, crear, pausar o prorrogar.',
            pasos: [
                'En el menú de la izquierda abra <b>Estados</b>.',
                'Ubique el trámite. El operador lo ve como una tarjeta con sus procesos; el administrador pulsa <b>Ver detalle</b> (o toca la fila).',
                'Cuando termine una etapa, pulse <b>Completar</b> en ese proceso (o <b>Marcar como completado</b> en el proceso actual) y confirme. El semáforo pasa al siguiente proceso pendiente.',
                'Si falta una etapa, pulse <b>+ Nuevo proceso</b>, escriba el nombre y el plazo en días hábiles. El portal calcula el día de vencimiento.',
                'Si el trámite se suspende, pulse <b>Pausar trámite</b>: el reloj se detiene y el semáforo queda en gris. Para seguir, <b>Reactivar trámite</b>.',
                'Para el plazo de ley use <b>Iniciar plazo (60 días hábiles)</b> y, si hace falta, <b>Prórroga: +30 días hábiles</b> (una sola vez).'
            ],
            nota: 'Colores: <b>verde</b> al día, <b>naranja</b> por vencer (0 a 1 día hábil), <b>rojo</b> vencido, <b>gris</b> en pausa. Sábados, domingos y festivos no cuentan. Solo el administrador puede fijar el color a mano con <b>Editar</b>, y queda registrado.',
            video: 'manual/videos/semaforo.mp4'
        },
        {
            id: 'subir',
            pestana: 'operador',
            titulo: 'Cómo subir documentos, audios y videos',
            resumen: 'Cada archivo queda en su carpeta, numerado, y usted decide si las partes lo pueden descargar.',
            pasos: [
                'En <b>Carpetas</b> pulse <b>Abrir</b> en la carpeta del trámite.',
                'Elija dónde va: <b>Documentos</b> (el expediente escrito: PDF, Word, Excel e imágenes escaneadas), <b>Audiencias</b> (solo audio o video) u otra subcarpeta.',
                'Pulse <b>+ Subir archivos</b>.',
                'Deje marcada la casilla si el cliente y los acreedores pueden descargarlos. Si la desmarca, solo podrán verlos.',
                'Arrastre los archivos al recuadro o pulse <b>Seleccionar archivos</b> para buscarlos en el equipo o el celular.',
                'Espere la barra verde. Los archivos aparecen en la tabla con su número.'
            ],
            nota: 'Máximo 300 MB por archivo. Antes de subir un video grabado con el celular o la pantalla, comprímalo: carga más rápido y se ve sin trabarse. La descarga se puede cambiar después con el interruptor de la columna <b>Descarga</b>.',
            video: 'manual/videos/subir.mp4'
        },
        {
            id: 'renombrar',
            pestana: 'operador',
            titulo: 'Cómo cambiar el nombre de un documento o video',
            resumen: 'El nombre cambia; la extensión se conserva.',
            pasos: [
                'Abra la carpeta y ubique el archivo en la tabla.',
                'Pulse el lápiz (<b>Renombrar</b>) de esa fila.',
                'Escriba el nombre nuevo y pulse <b>Guardar</b>.'
            ],
            nota: 'Si borra la extensión (.pdf, .mp4) el portal la vuelve a poner. El cambio queda en la actividad de la carpeta.',
            video: 'manual/videos/renombrar.mp4'
        },
        {
            id: 'expediente',
            pestana: 'operador',
            titulo: 'Cómo generar el expediente en un solo PDF',
            resumen: 'Une los documentos que usted marque, en el orden que usted elija.',
            pasos: [
                'Abra la carpeta del trámite y pulse <b>Generar expediente</b>.',
                'Marque los documentos uno por uno: el orden en que los marca es el orden del PDF.',
                'Para cambiar el orden use las flechas de cada documento marcado.',
                'Pulse <b>Generar PDF</b> y espere la descarga.'
            ],
            nota: 'Solo se unen PDF e imágenes (PNG y JPG). Word, Excel, audio y video quedan por fuera.',
            video: 'manual/videos/expediente.mp4'
        },
        {
            id: 'chat',
            pestana: 'operador',
            titulo: 'Cómo usar el chat del trámite',
            resumen: 'Escríbales al deudor y a los acreedores sin salir del portal.',
            pasos: [
                'Abra la carpeta y pulse <b>Chat del trámite</b>.',
                'Elija el canal: <b>Cliente ↔ operador</b> para el deudor o <b>Acreedor ↔ operador</b> para los acreedores.',
                'En el canal de acreedores, en <b>Conversar con</b>, elija <b>Todos los acreedores</b> o uno solo.',
                'Escriba y pulse <b>Enviar</b>. Con el clip adjunta un archivo.'
            ],
            nota: 'Cada parte ve solo su chat: el deudor no ve el de los acreedores y cada acreedor ve solo sus mensajes. Para hablarle al administrador use el globo de la cabecera.',
            video: 'manual/videos/chat.mp4'
        },
        {
            id: 'documentos',
            pestana: 'partes',
            titulo: 'Cómo ver y descargar sus documentos',
            resumen: 'Consulte lo que la entidad subió a su trámite.',
            pasos: [
                'En <b>Carpetas</b> pulse <b>Abrir</b> en la carpeta de su trámite.',
                'Baje hasta la tabla de documentos. Las subcarpetas (Audiencias, Notificaciones) también pueden tener archivos.',
                'Pulse <b>Ver</b> para abrir el documento. En el computador se abre en otra pestaña; en la app del celular, dentro del portal.',
                'Pulse <b>Descargar</b> para guardarlo. Si dice <b>Solo lectura</b>, puede verlo pero no descargarlo.',
                'Con <b>Descargar carpeta (ZIP)</b> baja de una vez todo lo que tiene descarga permitida.'
            ],
            nota: 'Cuando el trámite termina, tiene 30 días hábiles para descargar sus documentos. Después la carpeta se cierra.',
            video: 'manual/videos/documentos-cliente.mp4'
        },
        {
            id: 'seguimiento',
            pestana: 'partes',
            titulo: 'Cómo ver en qué va su trámite',
            resumen: 'El semáforo y el calendario de audiencias, sin cambiar nada.',
            pasos: [
                'Abra la carpeta de su trámite.',
                'Arriba verá la etapa actual con su color, el día de vencimiento y los días hábiles que quedan.',
                'Debajo está la cadena de etapas: tachadas las terminadas, luego la actual y las que siguen.',
                'En la pestaña <b>Calendario</b> están las audiencias programadas, con fecha y hora.'
            ],
            nota: 'Verde: al día. Naranja: vence hoy o mañana. Rojo: vencido. Gris: en pausa. Sábados, domingos y festivos no cuentan. Los cambios los hace el operador del trámite.',
            video: 'manual/videos/leer-semaforo.mp4'
        }
    ];

    let raiz = null;
    let ultimoFoco = null;
    let pestanaActiva = null;

    function rolActual() {
        try { return (typeof sesion !== 'undefined' && sesion && sesion.rol) || ''; }
        catch (e) { return ''; }
    }

    function pestanasDelRol() {
        const rol = rolActual();
        return PESTANAS.filter(p => !rol || p.roles.includes(rol));
    }

    /* El reproductor se arma al abrir el tema: así no se piden todos los videos. */
    function montarVideo(caja, tema) {
        if (caja.dataset.listo) return;
        caja.dataset.listo = '1';
        if (!tema.video) { caja.appendChild(sinVideo()); return; }
        const video = document.createElement('video');
        // Atributos para celular: dentro de la página, sin sonido, con controles y sin bajar todo
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute('muted', '');
        video.controls = true;
        video.preload = 'metadata';
        if (tema.poster) video.poster = tema.poster;
        const fuente = document.createElement('source');
        // #t=0.1 hace que el iPhone muestre el primer cuadro antes de reproducir
        fuente.src = tema.video + '#t=0.1';
        fuente.type = 'video/mp4';
        fuente.addEventListener('error', () => { video.remove(); caja.appendChild(sinVideo()); });
        video.appendChild(fuente);
        video.setAttribute('aria-label', 'Video: ' + tema.titulo);
        caja.appendChild(video);
    }

    function sinVideo() {
        const p = document.createElement('div');
        p.className = 'pt-manual__sin-video';
        p.innerHTML = icono('video', 28) + '<span>El video de este tema está en preparación.<br>Siga los pasos.</span>';
        return p;
    }

    function pintar() {
        const pestanas = pestanasDelRol();
        const barra = raiz.querySelector('#manual-pestanas');
        const lista = raiz.querySelector('#manual-temas');
        // Con una sola pestaña no hace falta la barra
        barra.hidden = pestanas.length < 2;
        barra.innerHTML = pestanas.map(p =>
            '<button type="button" role="tab" id="manual-pestana-' + p.id + '" data-pestana="' + p.id + '"' +
            ' aria-controls="manual-temas" aria-selected="false" tabindex="-1">' + p.titulo + '</button>').join('');

        const temas = TEMAS.filter(t => pestanas.some(p => p.id === t.pestana));
        const numero = {};
        lista.innerHTML = temas.map(t => {
            numero[t.pestana] = (numero[t.pestana] || 0) + 1;
            const grupo = PESTANAS.find(p => p.id === t.pestana).titulo;
            return '<details class="pt-manual__tema" name="manual-tema" data-tema="' + t.id + '" data-pestana="' + t.pestana + '">' +
                '<summary>' +
                    '<span class="pt-manual__num">' + numero[t.pestana] + '</span>' +
                    '<span class="pt-manual__cab"><span class="pt-manual__grupo">' + grupo + '</span>' +
                        '<b>' + t.titulo + '</b><small>' + t.resumen + '</small></span>' +
                    '<span class="pt-manual__flecha" aria-hidden="true"></span>' +
                '</summary>' +
                '<div class="pt-manual__cuerpo">' +
                    '<div class="pt-manual__texto">' +
                        '<ol class="pt-manual__pasos">' + t.pasos.map(p => '<li>' + p + '</li>').join('') + '</ol>' +
                        (t.nota ? '<p class="pt-manual__nota">' + t.nota + '</p>' : '') +
                    '</div>' +
                    '<div class="pt-manual__medio"><div class="video-container"></div></div>' +
                '</div>' +
            '</details>';
        }).join('') || '<p class="pt-nota">No hay temas para su rol todavía.</p>';

        lista.querySelectorAll('details').forEach(d => {
            const tema = TEMAS.find(t => t.id === d.dataset.tema);
            const caja = d.querySelector('.video-container');
            d.addEventListener('toggle', () => {
                if (d.open) {
                    montarVideo(caja, tema);
                    // Solo un tema abierto a la vez (por si el navegador no usa name)
                    lista.querySelectorAll('details[open]').forEach(o => { if (o !== d) o.open = false; });
                } else {
                    const v = caja.querySelector('video');
                    if (v) v.pause();
                }
            });
        });

        barra.addEventListener('click', e => {
            const b = e.target.closest('[data-pestana]');
            if (b) mostrarPestana(b.dataset.pestana);
        });
        // Flechas para moverse entre pestañas
        barra.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const botones = [...barra.querySelectorAll('[data-pestana]')];
            const i = botones.findIndex(b => b.dataset.pestana === pestanaActiva);
            const j = e.key === 'Home' ? 0 : e.key === 'End' ? botones.length - 1
                : (i + (e.key === 'ArrowRight' ? 1 : -1) + botones.length) % botones.length;
            e.preventDefault();
            mostrarPestana(botones[j].dataset.pestana);
            botones[j].focus();
        });

        // Cliente y acreedor arrancan en la suya; los demás en Operador
        const inicial = pestanas.find(p => p.id === 'partes' && ['cliente', 'acreedor'].includes(rolActual())) || pestanas[0];
        if (inicial) mostrarPestana(inicial.id);
    }

    function mostrarPestana(id) {
        pestanaActiva = id;
        raiz.querySelectorAll('#manual-pestanas [data-pestana]').forEach(b => {
            const activa = b.dataset.pestana === id;
            b.classList.toggle('activa', activa);
            b.setAttribute('aria-selected', String(activa));
            b.tabIndex = activa ? 0 : -1;
        });
        const lista = raiz.querySelector('#manual-temas');
        if (raiz.querySelector('#manual-pestana-' + id)) lista.setAttribute('aria-labelledby', 'manual-pestana-' + id);
        const buscar = raiz.querySelector('#manual-buscar');
        if (buscar.value) { buscar.value = ''; }
        filtrar('');
        // Al cambiar, se abre el primer tema de la pestaña
        const temas = [...lista.querySelectorAll('details[data-pestana="' + id + '"]')];
        if (temas.length && !temas.some(d => d.open)) temas[0].open = true;
    }

    function normalizar(texto) {
        return texto.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    /* Sin texto: la pestaña activa. Con texto: lo que coincida en las dos. */
    function filtrar(texto) {
        const q = normalizar(texto);
        const lista = raiz.querySelector('#manual-temas');
        const enDos = !!q && pestanasDelRol().length > 1;
        lista.classList.toggle('pt-manual__lista--buscando', enDos);
        raiz.querySelector('#manual-pestanas').classList.toggle('pt-manual__pestanas--buscando', enDos);
        let visibles = 0;
        lista.querySelectorAll('.pt-manual__tema').forEach(d => {
            const ve = q ? normalizar(d.textContent).includes(q) : d.dataset.pestana === pestanaActiva;
            d.hidden = !ve;
            if (!ve && d.open) d.open = false;
            if (ve) visibles++;
        });
        raiz.querySelector('#manual-vacio').hidden = visibles > 0;
    }

    function alTeclado(e) {
        if (e.key === 'Escape' && raiz && !raiz.hidden) { e.preventDefault(); cerrarManual(); }
    }

    function abrirManual() {
        raiz = raiz || document.getElementById('manual');
        if (!raiz) return;
        ultimoFoco = document.activeElement;
        if (!raiz.dataset.pintado) {
            pintar();
            raiz.dataset.pintado = '1';
            raiz.querySelector('#manual-buscar').addEventListener('input', e => filtrar(e.target.value));
        }
        raiz.hidden = false;
        document.body.classList.add('pt-manual-abierto');
        document.addEventListener('keydown', alTeclado);
        raiz.querySelector('[data-accion="manual-cerrar"].pt-manual__cerrar').focus();
    }

    function cerrarManual() {
        if (!raiz) return;
        raiz.querySelectorAll('video').forEach(v => v.pause());
        raiz.hidden = true;
        document.body.classList.remove('pt-manual-abierto');
        document.removeEventListener('keydown', alTeclado);
        if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
    }

    window.abrirManual = abrirManual;
    window.cerrarManual = cerrarManual;
})();
