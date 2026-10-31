/*! Legajo · pie legal común (ingreso, portal y páginas legales)
  Andrés Madrid · andresmadrid.vercel.app */
(function () {
    var caja = document.getElementById('pie-legal');
    if (!caja) return;

    // Habeas data visible en todas las pantallas: el portal maneja datos de terceros.
    var enlaces = function (lista) {
        return lista.map(function (x) {
            return '<a href="' + x[1] + '"' +
                (x[1].indexOf('http') === 0 ? ' target="_blank" rel="noopener noreferrer"' : '') +
                '>' + x[0] + '</a>';
        }).join('');
    };

    caja.className = 'pt-pie';
    caja.innerHTML =
        '<div class="pt-pie__cols">' +
            '<div class="pt-pie__col">' +
                '<span class="pt-pie__eti">Legal</span>' +
                enlaces([
                    ['Términos de uso', 'terminos.html'],
                    ['Tratamiento de datos', 'privacidad.html'],
                    ['Marco legal', 'terminos.html#marco-legal']
                ]) +
            '</div>' +
            '<div class="pt-pie__col pt-pie__col--ancha">' +
                '<span class="pt-pie__eti">Tus datos</span>' +
                '<p>Los datos personales y los documentos de cada trámite se usan solo para ' +
                'llevarlo, conforme a la Ley 1581 de 2012. La política de tratamiento de datos ' +
                'explica cómo consultarlos, corregirlos o pedir que se borren.</p>' +
            '</div>' +
        '</div>' +
        '<div class="pt-pie__raya">' +
            // Sin el nombre de la entidad: el portal lo usan las notarías.
            '<span>Legajo · ' + new Date().getFullYear() + '</span>' +
        '</div>';
})();
