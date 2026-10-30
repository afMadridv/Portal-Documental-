-- ============================================================
-- MIGRACIÓN: avisos en el celular del administrador, y soporte
--            también para el monitor
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. El monitor tiene su propio hilo en el chat de soporte, igual que
--      un operador: escribe, adjunta, recibe llamadas del administrador
--      y su mensaje le llega a la campana del administrador.
--
--   2. Avisos nuevos en la campana del administrador:
--        archivo-admin     alguien subió un documento: quién, cuál, a
--                          qué carpeta (y subcarpeta)
--        audiencia-nueva   alguien programó una audiencia
--        proceso-nuevo     alguien creó un proceso (lo que se ve en
--                          «Estados»)
--        ingreso-cuenta    se inició sesión con la cuenta del
--                          administrador, desde qué equipo
--        audiencia-hoy     tarea diaria: audiencias de hoy y de mañana
--        audiencia-manana
--        recordatorio      tarea diaria: el recordatorio personal del
--                          administrador que empieza hoy
--      Los que ya existían (soporte, estados, plazos, vencidos,
--      solicitudes de clave) siguen igual.
--
--   3. AVISOS PUSH. Lo que cae en la campana de un administrador le
--      llega también al celular (o al computador) donde activó los
--      avisos, aunque el portal esté cerrado. Así:
--
--        notificaciones (insert)
--          └ disparador push_avisos, una vez por sentencia
--              └ pg_net: POST a la Edge Function avisos-push con los ids
--                  └ push_tomar(ids): marca cada aviso como enviado y
--                    devuelve a qué equipos va
--                      └ la función cifra y entrega por Web Push (VAPID)
--                          └ push_resultado: anota cómo salió y borra
--                            los equipos que ya no existen (404 / 410)
--
--      La base solo manda ids, nunca el texto. Por eso no importa que
--      la función se pueda llamar desde fuera: push_tomar entrega cada
--      aviso UNA vez, solo a su dueño, y solo si tiene menos de 15
--      minutos. Llamarla a mano no inventa avisos ni los repite.
--
--      Si falta pg_net, la función o las claves VAPID, la campana
--      funciona igual que antes: el aviso simplemente no sale al
--      celular. Nada de esto puede tumbar un insert.
--
-- CATEGORÍAS
--   Cada equipo elige qué recibe (documentos, audiencias, estados,
--   soporte, accesos, calendario). Lo dice _push_categoria().
--   'ingreso-propio' (el aviso de cada pestaña nueva) no sale al
--   celular: sería un aviso cada vez que se abre el portal.
--
-- LO QUE HAY QUE HACER EN EL SERVIDOR
--   Claves VAPID en los secretos de las funciones, la función
--   avisos-push, y la URL de la función en push_ajustes si no es la de
--   siempre (ver base-de-datos/LEEME.md).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) El monitor en el chat de soporte
-- ------------------------------------------------------------
create or replace function public.puede_soporte(operador uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or (public.rol_actual() in ('operador', 'monitor') and operador = auth.uid());
$$;

-- Lo que escriba un operador o un monitor le llega al administrador
create or replace function public.notif_soporte_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_quien text := coalesce(nullif(new.autor_nombre, ''), 'Alguien del equipo');
begin
    if new.rol in ('operador', 'monitor') then
        perform public._notificar_admins('soporte',
            v_quien || ' (' || new.rol || ') escribió a soporte: ' ||
            case when coalesce(new.texto, '') <> '' then '«' || left(new.texto, 120) || '»'
                 else 'envió el archivo «' || coalesce(nullif(new.archivo_nombre, ''), 'adjunto') || '»'
            end,
            null, new.id);
    end if;
    return new;
end;
$$;

-- El administrador también puede llamar al monitor desde su hilo
drop policy if exists "solo admin inicia llamadas" on public.llamadas_soporte;
create policy "solo admin inicia llamadas" on public.llamadas_soporte
    for insert with check (
        public.es_admin()
        and iniciador = (select auth.uid())
        and exists (select 1 from public.perfiles p
                    where p.id = destino and p.activo
                      and p.rol in ('operador', 'monitor', 'cliente', 'acreedor'))
    );


-- ------------------------------------------------------------
-- 2) Dónde se guarda cada equipo que recibe avisos
-- ------------------------------------------------------------
-- Una fila por navegador. endpoint, p256dh y auth los da el navegador
-- al suscribirse (PushSubscription.toJSON()); con ellos se cifra el
-- aviso para ese equipo y nadie más puede leerlo en el camino.
create table if not exists public.suscripciones_push (
    id            bigint generated always as identity primary key,
    perfil_id     uuid not null references public.perfiles (id) on delete cascade,
    endpoint      text not null unique
                  check (endpoint ~ '^https://\S+$' and length(endpoint) <= 1000),
    p256dh        text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}=*$'),
    auth          text not null check (auth ~ '^[A-Za-z0-9_-]{16,30}=*$'),
    dispositivo   text not null default '',
    categorias    text[] not null
                  default array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'],
    creada        timestamptz not null default now(),
    ultimo_envio  timestamptz,
    ultimo_estado int            -- lo que respondió el servicio de avisos (201 = entregado)
);
create index if not exists idx_suscripciones_push_perfil on public.suscripciones_push (perfil_id);

-- Cada quien ve las suyas (el portal pregunta si este equipo está
-- activo y cómo salió la prueba). Escribir, solo por las funciones.
alter table public.suscripciones_push enable row level security;
revoke all on public.suscripciones_push from public, anon, authenticated;
revoke all on sequence public.suscripciones_push_id_seq from public, anon, authenticated;
grant select on public.suscripciones_push to authenticated;

drop policy if exists "ver mis equipos con avisos" on public.suscripciones_push;
create policy "ver mis equipos con avisos" on public.suscripciones_push
    for select using (perfil_id = (select auth.uid()));

-- A dónde llama la base. Una sola fila, opcional: sin ella se usa la
-- dirección interna de autohospedado y ninguna clave. En Supabase cloud
-- va https://<proyecto>.supabase.co/functions/v1/avisos-push y la clave
-- igual al secreto AVISOS_CLAVE de la función (viaja en x-aviso-clave).
create table if not exists public.push_ajustes (
    id    int primary key default 1 check (id = 1),
    url   text not null default 'http://functions:9000/avisos-push',
    clave text not null default ''
);
alter table public.push_ajustes enable row level security;
revoke all on public.push_ajustes from public, anon, authenticated;

-- Cuándo salió al celular. Null = todavía no (o no tenía a dónde).
alter table public.notificaciones add column if not exists push_enviado timestamptz;


-- ------------------------------------------------------------
-- 3) Ayudantes
-- ------------------------------------------------------------
-- De qué categoría es cada aviso. Null = no sale al celular.
create or replace function public._push_categoria(p_tipo text)
returns text
language sql immutable
as $$
    select case
        when p_tipo = 'archivo-admin'   then 'documentos'
        when p_tipo = 'audiencia-nueva' then 'audiencias'
        when p_tipo in ('proceso-nuevo', 'proceso-estado', 'proceso-semaforo',
                        'tramite-pausado', 'tramite-reactivado', 'tramite-finalizado',
                        'tramite-prorroga', 'tramite-fin') then 'estados'
        when p_tipo = 'soporte'         then 'soporte'
        when p_tipo in ('ingreso-cuenta', 'solicitud-clave') then 'accesos'
        when p_tipo in ('audiencia-hoy', 'audiencia-manana', 'recordatorio', 'proceso-vencido')
          or p_tipo like 'plazo-%'      then 'calendario'
        when p_tipo = 'push-prueba'     then 'prueba'
    end;
$$;

-- «Android · Chrome» a partir del user-agent, como lo escribe nube.js
create or replace function public._push_dispositivo(ua text)
returns text
language sql immutable
as $$
    select case
               when ua ~* 'android'          then 'Android'
               when ua ~* 'iphone|ipad|ipod' then 'iPhone o iPad'
               when ua ~* 'windows'          then 'Windows'
               when ua ~* 'mac os'           then 'Mac'
               when ua ~* 'linux'            then 'Linux'
               else 'un equipo sin identificar'
           end ||
           coalesce(' · ' || case
               when ua ~ 'Edg/'        then 'Edge'
               when ua ~ 'OPR/|Opera'  then 'Opera'
               when ua ~ 'Chrome/'     then 'Chrome'
               when ua ~ 'Firefox/'    then 'Firefox'
               when ua ~ 'Safari/'     then 'Safari'
           end, '');
$$;

-- '14:30' → '2:30 PM'. Lo que no sea una hora se deja como vino.
create or replace function public._push_hora(p_hora text)
returns text
language plpgsql immutable
as $$
begin
    if coalesce(p_hora, '') !~ '^\d{1,2}:\d{2}' then return nullif(trim(p_hora), ''); end if;
    return to_char(substring(p_hora from '^\d{1,2}:\d{2}')::time, 'FMHH12:MI AM');
exception when others then
    return nullif(trim(p_hora), '');
end;
$$;

-- Quién hizo algo, para el texto del aviso: «Ana Gómez (operador)»
create or replace function public._push_quien(p_respaldo text default '')
returns text
language sql stable security definer set search_path = public
as $$
    select coalesce(
        (select p.nombre || ' (' || p.rol || ')' from public.perfiles p where p.id = auth.uid()),
        nullif(p_respaldo, ''),
        'Alguien');
$$;


-- ------------------------------------------------------------
-- 4) Avisos nuevos para el administrador
-- ------------------------------------------------------------
-- Documento subido. El que lo sube no se avisa a sí mismo
-- (_notificar_admins deja por fuera a quien hace la acción).
create or replace function public.notif_archivo_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
    v_sub     text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    if new.subcarpeta_id is not null then
        select nombre into v_sub from public.subcarpetas where id = new.subcarpeta_id;
    end if;
    perform public._notificar_admins('archivo-admin',
        public._push_quien(new.subido_por_usuario) || ' subió «' || new.nombre ||
        '» a «' || coalesce(v_carpeta, '') || '»' || coalesce(' › ' || v_sub, ''),
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_archivo_admin on public.archivos;
create trigger notif_archivo_admin after insert on public.archivos
    for each row execute function public.notif_archivo_admin();

-- Audiencia programada en el calendario de una carpeta
create or replace function public.notif_audiencia_nueva()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    perform public._notificar_admins('audiencia-nueva',
        public._push_quien() || ' programó la audiencia «' ||
        coalesce(nullif(new.titulo, ''), 'sin título') || '» para el ' ||
        to_char(new.fecha, 'DD/MM/YYYY') ||
        coalesce(' a las ' || public._push_hora(new.hora), '') ||
        ' en «' || coalesce(v_carpeta, '') || '»',
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_audiencia_nueva on public.audiencias;
create trigger notif_audiencia_nueva after insert on public.audiencias
    for each row execute function public.notif_audiencia_nueva();

-- Proceso nuevo (lo que el portal muestra en «Estados»)
create or replace function public.notif_proceso_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    perform public._notificar_admins('proceso-nuevo',
        public._push_quien() || ' creó el proceso «' || new.nombre || '» (' ||
        new.dias_habiles_limite || ' días hábiles, vence el ' ||
        to_char(new.fecha_vencimiento_habil, 'DD/MM/YYYY') || ') en «' ||
        coalesce(v_carpeta, '') || '»',
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_proceso_nuevo on public.procesos_tramite;
create trigger notif_proceso_nuevo after insert on public.procesos_tramite
    for each row execute function public.notif_proceso_nuevo();

-- Inicio de sesión con la cuenta de un administrador. Se le avisa a
-- ese mismo administrador, en todos sus equipos.
--
-- Va sobre auth.sessions, que GoTrue escribe en CADA ingreso con
-- contraseña, pase por el portal o no. Corre dentro del ingreso, así
-- que no puede fallar nunca: cualquier error se traga y el ingreso
-- sigue. El user-agent se lee como jsonb porque esa columna no existe
-- en las versiones viejas de GoTrue.
create or replace function public.notif_ingreso_cuenta()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_ua   text;
    v_quien uuid;
begin
    begin
        if tg_table_schema = 'auth' then
            v_quien := (to_jsonb(new) ->> 'user_id')::uuid;
            v_ua := public._push_dispositivo(coalesce(to_jsonb(new) ->> 'user_agent', ''));
        else
            v_quien := (to_jsonb(new) ->> 'perfil_id')::uuid;
            v_ua := coalesce(nullif(to_jsonb(new) ->> 'dispositivo', ''), 'un equipo sin identificar');
        end if;
        if exists (select 1 from public.perfiles
                    where id = v_quien and rol = 'administrador' and activo) then
            perform public._notificar(v_quien, 'ingreso-cuenta',
                'Se inició sesión con tu usuario en ' || v_ua || ' el ' ||
                to_char(now() at time zone 'America/Bogota', 'DD/MM/YYYY') || ' a las ' ||
                to_char(now() at time zone 'America/Bogota', 'FMHH12:MI AM') ||
                '. Si no fuiste tú, cambia la contraseña.',
                null, null);
        end if;
    exception when others then
        raise warning 'aviso de ingreso: %', sqlerrm;
    end;
    return new;
end;
$$;

-- En auth.sessions si se puede; si no, en public.sesiones, que escribe
-- el portal al entrar (sesion_abrir).
do $$
begin
    drop trigger if exists notif_ingreso_cuenta on public.sesiones;
    begin
        execute 'drop trigger if exists notif_ingreso_cuenta on auth.sessions';
        execute 'create trigger notif_ingreso_cuenta after insert on auth.sessions
                     for each row execute function public.notif_ingreso_cuenta()';
        raise notice 'Aviso de ingreso: en auth.sessions.';
    exception when others then
        create trigger notif_ingreso_cuenta after insert or update of sesion_id on public.sesiones
            for each row execute function public.notif_ingreso_cuenta();
        raise notice 'Aviso de ingreso: sin permiso sobre auth.sessions (%), va en public.sesiones.', sqlerrm;
    end;
end $$;


-- ------------------------------------------------------------
-- 5) Calendario: la tarea de cada mañana
-- ------------------------------------------------------------
-- Audiencias de hoy y de mañana (a los administradores de esa
-- notaría) y los recordatorios propios del administrador que empiezan
-- hoy. Una vez por persona y por audiencia o recordatorio.
create or replace function public.avisos_calendario_diario()
returns int
language plpgsql security definer set search_path = public
as $$
declare
    hoy    date := (now() at time zone 'America/Bogota')::date;
    n      int := 0;
    n_fila int;
begin
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    select p.id, x.tipo,
           left(x.cuando || coalesce(' a las ' || public._push_hora(a.hora), '') ||
                ': audiencia «' || coalesce(nullif(a.titulo, ''), 'sin título') ||
                '» de «' || c.nombre || '»', 300),
           a.carpeta_id, a.id, c.notaria_id
      from public.audiencias a
      join public.carpetas c on c.id = a.carpeta_id and c.activa
      cross join lateral (select case when a.fecha = hoy then 'audiencia-hoy' else 'audiencia-manana' end as tipo,
                                 case when a.fecha = hoy then 'Hoy' else 'Mañana' end as cuando) x
      join public.perfiles p on p.rol = 'administrador' and p.activo
                            and public.perfil_alcanza_notaria(p.id, c.notaria_id)
     where a.fecha in (hoy, hoy + 1)
       and not exists (select 1 from public.notificaciones n
                        where n.tipo = x.tipo and n.referencia_id = a.id
                          and n.destinatario_id = p.id);
    get diagnostics n_fila = row_count;
    n := n + n_fila;

    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    select r.perfil_id, 'recordatorio',
           left('Recordatorio de «' || c.nombre || '»: ' || r.mensaje, 300),
           r.carpeta_id, r.id, c.notaria_id
      from public.recordatorios r
      join public.perfiles p on p.id = r.perfil_id and p.rol = 'administrador' and p.activo
      join public.carpetas c on c.id = r.carpeta_id
     where r.fecha_inicio = hoy
       and not exists (select 1 from public.notificaciones n
                        where n.tipo = 'recordatorio' and n.referencia_id = r.id
                          and n.destinatario_id = r.perfil_id);
    get diagnostics n_fila = row_count;
    return n + n_fila;
end;
$$;

-- 11:45 UTC = 6:45 a. m. en Colombia, antes de la de plazos (7:00).
-- Todos los días: una audiencia de lunes se avisa el domingo.
select cron.unschedule('calendario-diario') where exists (
    select 1 from cron.job where jobname = 'calendario-diario'
);
select cron.schedule(
    'calendario-diario',
    '45 11 * * *',
    $$ select public.avisos_calendario_diario(); $$
);


-- ------------------------------------------------------------
-- 6) De la campana al celular
-- ------------------------------------------------------------
-- Una llamada por sentencia, con todos los ids que tienen a dónde ir.
-- La tarea diaria inserta varios avisos de una vez: así salen en un
-- solo viaje y la función los puede agrupar por equipo.
create or replace function public._push_avisar()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_ids   bigint[];
    v_url   text;
    v_clave text;
begin
    select array_agg(n.id order by n.id) into v_ids
      from nuevas n
      join public.perfiles p on p.id = n.destinatario_id and p.rol = 'administrador' and p.activo
     where public._push_categoria(n.tipo) is not null
       and exists (select 1 from public.suscripciones_push s
                    where s.perfil_id = n.destinatario_id
                      and (public._push_categoria(n.tipo) = 'prueba'
                           or public._push_categoria(n.tipo) = any (s.categorias)));
    if v_ids is null then return null; end if;

    select url, clave into v_url, v_clave from public.push_ajustes where id = 1;
    begin
        perform net.http_post(
            url := coalesce(nullif(v_url, ''), 'http://functions:9000/avisos-push'),
            body := jsonb_build_object('ids', to_jsonb(v_ids)),
            headers := jsonb_build_object('Content-Type', 'application/json') ||
                       case when coalesce(v_clave, '') <> ''
                            then jsonb_build_object('x-aviso-clave', v_clave)
                            else '{}'::jsonb end,
            timeout_milliseconds := 15000);
    exception when others then
        -- Sin pg_net o sin red: la campana sigue, el celular no se entera
        raise warning 'avisos push: no se pudo llamar a la función: %', sqlerrm;
    end;
    return null;
end;
$$;
drop trigger if exists push_avisos on public.notificaciones;
create trigger push_avisos after insert on public.notificaciones
    referencing new table as nuevas
    for each statement execute function public._push_avisar();

-- pg_net viene en la imagen de Supabase. Si no está, se sigue sin él.
do $$
begin
    create extension if not exists pg_net with schema extensions;
exception when others then
    raise notice 'pg_net no está disponible (%): los avisos no saldrán al celular.', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- 7) Lo que llama la Edge Function (service_role)
-- ------------------------------------------------------------
-- Toma los avisos: cada uno una sola vez, recientes, y solo para un
-- administrador activo. Devuelve una entrada por equipo con sus avisos.
create or replace function public.push_tomar(p_ids bigint[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v jsonb;
begin
    with tomadas as (
        update public.notificaciones n
           set push_enviado = now()
         where n.id = any (coalesce(p_ids, '{}'::bigint[]))
           and n.push_enviado is null
           and n.fecha > now() - interval '15 minutes'
           and public._push_categoria(n.tipo) is not null
        returning n.id, n.destinatario_id, n.tipo, n.mensaje, n.carpeta_id, n.notaria_id
    )
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v
      from (
        select s.id, s.endpoint, s.p256dh, s.auth,
               jsonb_agg(jsonb_build_object(
                   'id', t.id, 'tipo', t.tipo, 'mensaje', t.mensaje,
                   'categoria', public._push_categoria(t.tipo),
                   'carpeta', t.carpeta_id,
                   'notaria', case when o.id is null then null
                                   else o.nombre || ' (' || o.ciudad || ')' end)
                   order by t.id) as avisos
          from tomadas t
          join public.perfiles p on p.id = t.destinatario_id and p.activo and p.rol = 'administrador'
          join public.suscripciones_push s on s.perfil_id = t.destinatario_id
               and (public._push_categoria(t.tipo) = 'prueba'
                    or public._push_categoria(t.tipo) = any (s.categorias))
          left join public.notarias o on o.id = t.notaria_id
         group by s.id
      ) e;

    -- La prueba ya cumplió: no se queda en la campana
    delete from public.notificaciones
     where id = any (coalesce(p_ids, '{}'::bigint[]))
       and tipo = 'push-prueba' and push_enviado is not null;
    return v;
end;
$$;

-- Cómo le fue a cada equipo: [{"id": 3, "estado": 201}, ...]
-- 404 y 410 = el navegador ya no tiene esa suscripción: se borra.
create or replace function public.push_resultado(p_resultados jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if jsonb_typeof(p_resultados) is distinct from 'array' then return; end if;
    update public.suscripciones_push s
       set ultimo_envio = now(), ultimo_estado = (r ->> 'estado')::int
      from jsonb_array_elements(p_resultados) r
     where s.id = (r ->> 'id')::bigint;
    delete from public.suscripciones_push s
     using jsonb_array_elements(p_resultados) r
     where s.id = (r ->> 'id')::bigint
       and (r ->> 'estado')::int in (404, 410);
end;
$$;


-- ------------------------------------------------------------
-- 8) Lo que llama el portal (solo administradores)
-- ------------------------------------------------------------
-- Activa este equipo, o lo pone al día si el navegador cambió las
-- llaves. Con p_categorias null conserva las que ya tenía. Máximo 10
-- equipos por persona: el más viejo sale.
create or replace function public.push_suscribir(p_endpoint text, p_p256dh text, p_auth text,
                                                 p_dispositivo text default '',
                                                 p_categorias text[] default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    validas constant text[] := array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'];
    v_cat text[];
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador recibe avisos en el celular.' using errcode = '42501';
    end if;
    if coalesce(p_endpoint, '') !~ '^https://\S+$' or length(p_endpoint) > 1000
       or coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}=*$'
       or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,30}=*$' then
        raise exception 'El navegador entregó una suscripción que no es válida.' using errcode = '22023';
    end if;
    v_cat := case when p_categorias is null then null
                  else array(select c from unnest(validas) c where c = any (p_categorias)) end;

    insert into public.suscripciones_push as s (perfil_id, endpoint, p256dh, auth, dispositivo, categorias)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_dispositivo, ''), 120),
            coalesce(v_cat, validas))
    on conflict (endpoint) do update
        set p256dh = excluded.p256dh,
            auth = excluded.auth,
            dispositivo = excluded.dispositivo,
            -- Mismo navegador, otra cuenta: empieza de cero
            categorias = case
                when v_cat is not null then v_cat
                when s.perfil_id = excluded.perfil_id then s.categorias
                else validas end,
            ultimo_envio  = case when s.perfil_id = excluded.perfil_id then s.ultimo_envio end,
            ultimo_estado = case when s.perfil_id = excluded.perfil_id then s.ultimo_estado end,
            perfil_id = excluded.perfil_id;

    delete from public.suscripciones_push
     where id in (select id from public.suscripciones_push
                   where perfil_id = auth.uid()
                   order by creada desc offset 10);
end;
$$;

create or replace function public.push_quitar(p_endpoint text)
returns void
language sql security definer set search_path = public
as $$
    delete from public.suscripciones_push
     where endpoint = p_endpoint and perfil_id = auth.uid();
$$;

create or replace function public.push_categorias(p_endpoint text, p_categorias text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
    validas constant text[] := array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'];
begin
    update public.suscripciones_push
       set categorias = array(select c from unnest(validas) c where c = any (coalesce(p_categorias, '{}')))
     where endpoint = p_endpoint and perfil_id = auth.uid();
end;
$$;

-- Un aviso de prueba a todos los equipos del administrador. Devuelve
-- su id; el portal mira después ultimo_envio y ultimo_estado.
create or replace function public.push_probar()
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_id bigint;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador recibe avisos en el celular.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.suscripciones_push where perfil_id = auth.uid()) then
        raise exception 'Primero activa los avisos en este equipo.' using errcode = '22023';
    end if;
    if exists (select 1 from public.notificaciones
                where destinatario_id = auth.uid() and tipo = 'push-prueba'
                  and fecha > now() - interval '10 seconds') then
        raise exception 'Espera unos segundos antes de otra prueba.' using errcode = '22023';
    end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje)
    values (auth.uid(), 'push-prueba', 'Si ves esto en tu celular, los avisos del portal quedaron activos.')
    returning id into v_id;
    return v_id;
end;
$$;


-- ------------------------------------------------------------
-- 9) Permisos
-- ------------------------------------------------------------
do $$
declare
    f record;
    internas constant text[] := array[
        '_push_categoria', '_push_dispositivo', '_push_hora', '_push_quien', '_push_avisar',
        'notif_archivo_admin', 'notif_audiencia_nueva', 'notif_proceso_nuevo',
        'notif_ingreso_cuenta', 'notif_soporte_nuevo',
        'avisos_calendario_diario', 'push_tomar', 'push_resultado'
    ];
    del_portal constant text[] := array['push_suscribir', 'push_quitar', 'push_categorias', 'push_probar'];
begin
    for f in
        select p.oid::regprocedure as firma, p.proname as nombre
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname = any (internas) or p.proname = any (del_portal))
    loop
        execute format('revoke execute on function %s from public, anon', f.firma);
        if f.nombre = any (del_portal) then
            execute format('grant execute on function %s to authenticated', f.firma);
        else
            execute format('revoke execute on function %s from authenticated', f.firma);
        end if;
    end loop;
end $$;

grant execute on function public.push_tomar(bigint[])   to service_role;
grant execute on function public.push_resultado(jsonb)  to service_role;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- Del portal: authenticated sí, anon no. De la función: solo service_role.
select p.proname as funcion,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('push_suscribir', 'push_quitar', 'push_categorias', 'push_probar',
                     'push_tomar', 'push_resultado', '_notificar')
 order by 1;

-- ¿Está pg_net? ¿Dónde quedó el aviso de ingreso?
select exists (select 1 from pg_extension where extname = 'pg_net') as pg_net,
       (select string_agg(event_object_schema || '.' || event_object_table, ', ')
          from information_schema.triggers
         where trigger_name = 'notif_ingreso_cuenta') as aviso_de_ingreso_en;
