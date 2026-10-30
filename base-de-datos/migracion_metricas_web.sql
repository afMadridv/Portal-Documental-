-- ============================================================
-- MIGRACIÓN: rendimiento del portal y metas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va ENTERA dentro de una transacción: si algo falla a mitad, no queda
-- media tabla ni una función sin sus permisos.
--
-- QUÉ AÑADE
--   La sección «Rendimiento» del portal, que solo ve el administrador. Responde dos preguntas:
--
--     1. Cuánta gente abre la pantalla de ingreso, cuántos entran y
--        cuántos intentos fallan.
--     2. Si el mes va camino de cumplir las metas que fija la entidad.
--
-- QUÉ SE GUARDA, Y QUÉ NO
--   Una fila por cosa que pasa: «alguien abrió el ingreso», «alguien
--   intentó entrar y falló». Con cada fila van:
--
--     sesion       un número al azar que vive en la pestaña
--                  (sessionStorage) y se borra al cerrarla. Sirve para
--                  que recargar la página no cuente otra visita. No
--                  identifica a nadie y no se cruza con nada.
--     origen       de dónde llegó, en una palabra: google, whatsapp,
--                  facebook, directo... Nunca la dirección completa.
--     dispositivo  movil, tableta o escritorio.
--
--   NO se guarda la IP, ni el nombre, ni el correo, ni el teléfono. La
--   política de datos (privacidad.html) lo dice así.
--
-- QUIÉN ESCRIBE
--   La pantalla de ingreso, con la clave pública, por registrar_evento_web().
--   Acepta solo una lista cerrada de tipos, una vez por pestaña cada uno,
--   y con un tope por hora para que un guion no llene el disco.
--
-- QUIÉN LEE
--   Solo el administrador, por metricas_web(). Las tablas no tienen
--   políticas RLS: nadie las lee ni las escribe directamente por la API.
--
-- LOS INGRESOS AL PORTAL
--   No hacen falta eventos nuevos: el portal ya apunta cada ingreso en
--   `actividad` (accion = 'ingreso'). Se cuentan de ahí, sin los del
--   administrador, que entra a trabajar y no es lo que mide la meta.
--
-- SE PUEDE VOLVER A CORRER
--   Si este archivo cambia (por ejemplo, metricas_web() devuelve una
--   cifra nueva para el tablero), basta con correrlo otra vez: las tablas
--   y los datos se quedan como están y las funciones se reemplazan.
--
-- SI ESTA MIGRACIÓN NO SE HA CORRIDO
--   El ingreso al portal funciona igual: la llamada para contar falla en
--   silencio y nadie lo nota. El tablero dice que falta la migración.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Las tablas
-- ------------------------------------------------------------
create table if not exists public.eventos_web (
    id          bigint generated always as identity primary key,
    fecha       timestamptz not null default now(),
    tipo        text not null,
    sesion      text not null default '',
    origen      text not null default '',
    dispositivo text not null default '',
    detalle     jsonb not null default '{}'::jsonb
);

comment on table public.eventos_web is
    'Lo que pasa en el ingreso al portal, sin datos personales. Lo lee metricas_web().';

-- La lista de tipos, en un solo sitio. Se rehace para poder añadir tipos
-- en otra migración sin tener que borrar la tabla.
alter table public.eventos_web drop constraint if exists eventos_web_tipo_check;
alter table public.eventos_web add constraint eventos_web_tipo_check check (tipo in (
    'portal_visita',      -- abrió la pantalla de ingreso del portal
    'portal_fallido'      -- intentó entrar y el usuario o la clave no sirvieron
));

create index if not exists idx_eventos_web_tipo_fecha on public.eventos_web (tipo, fecha);
create index if not exists idx_eventos_web_fecha      on public.eventos_web (fecha);
-- Para «una vez por pestaña»
create index if not exists idx_eventos_web_sesion     on public.eventos_web (sesion, tipo) where sesion <> '';

-- Las metas del mes. Una fila por meta; 0 quiere decir «sin meta».
create table if not exists public.metas_web (
    clave           text primary key,
    valor           integer not null default 0,
    actualizada     timestamptz not null default now(),
    actualizada_por text not null default ''
);

alter table public.metas_web drop constraint if exists metas_web_clave_check;
alter table public.metas_web add constraint metas_web_clave_check check (clave in (
    'portal_visitas',     -- visitas a la pantalla de ingreso en el mes
    'portal_ingresos'     -- ingresos al portal (sin administradores)
));
alter table public.metas_web drop constraint if exists metas_web_valor_check;
alter table public.metas_web add constraint metas_web_valor_check check (valor between 0 and 10000000);

comment on table public.metas_web is
    'Metas mensuales del tablero de rendimiento. Las escribe guardar_metas_web().';

-- Sin políticas a propósito: con RLS encendida y ninguna política, la
-- API no deja leer ni escribir. Todo pasa por las funciones de abajo.
alter table public.eventos_web enable row level security;
alter table public.metas_web   enable row level security;
revoke all on table public.eventos_web from anon, authenticated;
revoke all on table public.metas_web   from anon, authenticated;


-- ------------------------------------------------------------
-- 2) Lo que apunta la página (pública)
-- ------------------------------------------------------------
-- Nunca responde error: quien llama es una página pública y un fallo
-- aquí no tiene nada que decirle a nadie. Lo que no cumple, se ignora.
create or replace function public.registrar_evento_web(
    p_tipo        text,
    p_sesion      text default '',
    p_origen      text default '',
    p_dispositivo text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    s text := coalesce(p_sesion, '');
    recientes int;
    -- Muy por encima de lo que el portal recibe en una hora de verdad.
    -- Si se alcanza, es un guion: se deja de apuntar hasta que pase.
    TOPE_HORA constant int := 3000;
begin
    if p_tipo is null or p_tipo not in ('portal_visita', 'portal_fallido') then
        return;
    end if;

    -- La sesión la genera la página: letras y números, nada más
    if s !~ '^[a-z0-9]{12,40}$' then return; end if;

    -- Una vez por pestaña: recargar no suma otra visita
    if exists (select 1 from public.eventos_web where sesion = s and tipo = p_tipo) then
        return;
    end if;

    select count(*) into recientes
      from public.eventos_web
     where fecha > now() - interval '1 hour';
    if recientes >= TOPE_HORA then return; end if;

    insert into public.eventos_web (tipo, sesion, origen, dispositivo)
    values (
        p_tipo, s,
        case when p_origen in ('directo', 'google', 'buscador', 'facebook', 'instagram',
                               'whatsapp', 'tiktok', 'sitio', 'otro')
             then p_origen else 'otro' end,
        case when p_dispositivo in ('movil', 'tableta', 'escritorio')
             then p_dispositivo else '' end
    );
end;
$$;


-- ------------------------------------------------------------
-- 3) El tablero (solo administrador)
-- ------------------------------------------------------------
-- Devuelve todo el tablero en un solo JSON, para un rango de fechas en
-- hora de Colombia (ambos días incluidos). Trae además:
--   · el periodo anterior de igual duración, para las comparaciones;
--   · el mes calendario del último día del rango, para las metas.
create or replace function public.metricas_web(p_desde date, p_hasta date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    ZONA constant text := 'America/Bogota';
    d1 date := least(p_desde, p_hasta);
    d2 date := greatest(p_desde, p_hasta);
    hoy date := (now() at time zone ZONA)::date;
    dias int;
    ini timestamptz;
    fin timestamptz;
    ini_ant timestamptz;
    mes_ini date;
    mes_sig date;
    m_ini timestamptz;
    m_fin timestamptz;
    r jsonb;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede ver el rendimiento del portal.'
            using errcode = '42501';
    end if;
    if d1 is null or d2 is null then
        raise exception 'Faltan las fechas del rango.' using errcode = '22023';
    end if;

    -- Más de un año y pico no cabe en una gráfica diaria
    if d2 - d1 > 400 then d1 := d2 - 400; end if;
    dias    := d2 - d1 + 1;
    ini     := d1::timestamp at time zone ZONA;
    fin     := (d2 + 1)::timestamp at time zone ZONA;
    ini_ant := (d1 - dias)::timestamp at time zone ZONA;
    mes_ini := date_trunc('month', d2::timestamp)::date;
    mes_sig := (mes_ini + interval '1 month')::date;
    m_ini   := mes_ini::timestamp at time zone ZONA;
    m_fin   := mes_sig::timestamp at time zone ZONA;

    select jsonb_build_object(
        'desde', d1,
        'hasta', d2,
        'dias',  dias,
        'hoy',   hoy,

        -- Cuántas veces pasó cada cosa, en el rango y en el anterior
        'totales', (
            select coalesce(jsonb_object_agg(tipo, n), '{}'::jsonb)
              from (select tipo, count(*) as n from public.eventos_web
                     where fecha >= ini and fecha < fin group by tipo) t),
        'anteriores', (
            select coalesce(jsonb_object_agg(tipo, n), '{}'::jsonb)
              from (select tipo, count(*) as n from public.eventos_web
                     where fecha >= ini_ant and fecha < ini group by tipo) t),

        -- Día por día (solo los días con algo; el tablero rellena los ceros)
        'serie', (
            select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'tipo', tipo, 'n', n) order by dia, tipo), '[]'::jsonb)
              from (select (fecha at time zone ZONA)::date as dia, tipo, count(*) as n
                      from public.eventos_web
                     where fecha >= ini and fecha < fin
                     group by 1, 2) s),

        -- Los ingresos salen de la bitácora que ya existe
        'portal', jsonb_build_object(
            'ingresos', (select count(*) from public.actividad
                          where accion = 'ingreso' and rol <> 'administrador'
                            and fecha >= ini and fecha < fin),
            'ingresos_ant', (select count(*) from public.actividad
                              where accion = 'ingreso' and rol <> 'administrador'
                                and fecha >= ini_ant and fecha < ini),
            'personas', (select count(distinct perfil_id) from public.actividad
                          where accion = 'ingreso' and rol <> 'administrador'
                            and fecha >= ini and fecha < fin),
            'por_rol', (
                select coalesce(jsonb_agg(jsonb_build_object('rol', rol, 'n', n) order by n desc, rol), '[]'::jsonb)
                  from (select rol, count(*) as n from public.actividad
                         where accion = 'ingreso' and rol <> 'administrador'
                           and fecha >= ini and fecha < fin
                         group by rol) s),
            'serie', (
                select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'n', n) order by dia), '[]'::jsonb)
                  from (select (fecha at time zone ZONA)::date as dia, count(*) as n
                          from public.actividad
                         where accion = 'ingreso' and rol <> 'administrador'
                           and fecha >= ini and fecha < fin
                         group by 1) s)
        ),

        -- El mes de las metas: el del último día del rango
        'mes', jsonb_build_object(
            'inicio', mes_ini,
            'fin',    mes_sig - 1,
            'portal_visitas', (select count(*) from public.eventos_web
                                where tipo = 'portal_visita' and fecha >= m_ini and fecha < m_fin),
            'portal_ingresos', (select count(*) from public.actividad
                                 where accion = 'ingreso' and rol <> 'administrador'
                                   and fecha >= m_ini and fecha < m_fin)
        ),

        'metas', (select coalesce(jsonb_object_agg(clave, valor), '{}'::jsonb) from public.metas_web),
        'metas_actualizadas', (select jsonb_build_object('fecha', actualizada, 'por', actualizada_por)
                                 from public.metas_web order by actualizada desc limit 1),

        -- Desde cuándo hay datos: antes de esta fecha las cifras son cero
        -- porque no se medía, no porque no viniera nadie
        'primer_evento', (select min(fecha) from public.eventos_web)
    ) into r;

    return r;
end;
$$;


-- ------------------------------------------------------------
-- 4) Guardar las metas (solo administrador)
-- ------------------------------------------------------------
-- Recibe {"portal_visitas": 800, "portal_ingresos": 40}. Las claves que
-- no vienen no se tocan; un valor vacío o que no es número, tampoco.
create or replace function public.guardar_metas_web(p_metas jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    k text;
    v text;
    quien text;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede cambiar las metas.' using errcode = '42501';
    end if;
    if p_metas is null or jsonb_typeof(p_metas) <> 'object' then return; end if;

    select usuario into quien from public.perfiles where id = auth.uid();

    foreach k in array array['portal_visitas', 'portal_ingresos'] loop
        v := p_metas ->> k;
        continue when v is null or v !~ '^\d{1,8}$';
        insert into public.metas_web (clave, valor, actualizada, actualizada_por)
        values (k, least(v::int, 10000000), now(), coalesce(quien, ''))
        on conflict (clave) do update
            set valor = excluded.valor,
                actualizada = excluded.actualizada,
                actualizada_por = excluded.actualizada_por;
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 5) Permisos
-- ------------------------------------------------------------
-- Revocar de PUBLIC además de anon: el permiso por defecto viene de
-- PUBLIC (ver migracion_endurecimiento_2026_09.sql).
revoke execute on function public.registrar_evento_web(text, text, text, text) from public;
grant  execute on function public.registrar_evento_web(text, text, text, text) to anon, authenticated;

revoke execute on function public.metricas_web(date, date) from public, anon;
grant  execute on function public.metricas_web(date, date) to authenticated;

revoke execute on function public.guardar_metas_web(jsonb) from public, anon;
grant  execute on function public.guardar_metas_web(jsonb) to authenticated;

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
--   select tipo, count(*), min(fecha), max(fecha)
--     from public.eventos_web group by tipo order by tipo;
--
-- Unos minutos después de publicar, «portal_visita» debería tener filas.
--
-- LIMPIEZA (opcional, a mano)
--   Cada fila pesa unos pocos bytes; un año de visitas cabe en unos
--   pocos MB. Si algún día se quiere podar:
--     delete from public.eventos_web where fecha < now() - interval '2 years';
-- ============================================================
