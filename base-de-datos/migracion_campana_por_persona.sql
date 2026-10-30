-- ============================================================
-- LA CAMPANA, DE VERDAD INDEPENDIENTE POR PERSONA
-- ============================================================
-- La tabla `notificaciones` siempre guardó una fila por destinatario, y
-- la RLS siempre dejó a cada quien ver, marcar y borrar solo las suyas.
-- Eso estaba bien. El problema estaba un paso antes: en QUIÉN decide si
-- un aviso ya se mandó.
--
-- EL DEFECTO
--   Las tres funciones que generan avisos preguntaban así:
--
--       if exists (select 1 from notificaciones
--                   where tipo = 'plazo-7' and referencia_id = c.id)
--       then continue;      -- «este aviso ya salió»
--
--   Sin `destinatario_id`. O sea: ya salió PARA ALGUIEN, en cualquier
--   campana del portal. Tres consecuencias, todas reales:
--
--   1) Quien vacía su campana pierde el aviso para siempre. El operador
--      limpia la suya, pero la fila del administrador sigue existiendo,
--      así que el guardia dice «ya se mandó» y no vuelve a generarlo. El
--      administrador lo sigue viendo; el operador no lo verá nunca más,
--      aunque el plazo siga corriendo.
--
--   2) A quien llega después no le llega nada. Se asigna un acreedor a
--      una carpeta cuyo aviso de «faltan 2 semanas» ya salió: su campana
--      nace vacía y se queda vacía, porque las filas de los demás tapan
--      la suya.
--
--   3) Si TODOS vacían, vuelve a salir para todos. Incluido quien lo
--      había descartado a propósito.
--
-- LA CORRECCIÓN
--   El guardia se mueve dentro del INSERT y se correlaciona con cada
--   destinatario. Deja de ser «¿este aviso existe?» y pasa a ser «¿este
--   aviso existe PARA ESTA PERSONA?». Cada campana se comporta como si
--   fuera la única del portal.
--
--   No cambia nada de la RLS ni de la tabla: no hacía falta tocarlas.
--
-- QUÉ NO CAMBIA, Y POR QUÉ
--   Cuando se mueve la fecha de vencimiento de una carpeta, el trigger
--   `limpiar_avisos_plazo` sigue borrando los avisos de plazo de TODO el
--   mundo. Ahí sí corresponde: el hito viejo dejó de ser cierto para
--   todos a la vez, y el nuevo tiene que poder volver a salir.
-- ============================================================


-- ------------------------------------------------------------
-- 1) El índice que el nuevo guardia necesita
-- ------------------------------------------------------------
-- Antes se preguntaba por (tipo, referencia_id) una vez por proceso.
-- Ahora se pregunta por (tipo, referencia_id, destinatario_id) una vez
-- por persona y por proceso. Sin índice eso es un recorrido completo de
-- la tabla por cada fila candidata, todos los días a las 6 de la mañana.
create index if not exists idx_notif_dedupe
    on public.notificaciones (tipo, referencia_id, destinatario_id);


-- ------------------------------------------------------------
-- 2) Avisos del plazo del trámite (4, 3, 2, 1 semanas, 1 día y hoy)
-- ------------------------------------------------------------
create or replace function public.avisar_plazos_tramite()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    -- De más lejos a más cerca. Días de CALENDARIO que faltan.
    -- Las variables van con prefijo v_ porque sin él "tipo" y
    -- "mensaje" chocan con las columnas de notificaciones y plpgsql
    -- aborta con "column reference is ambiguous".
    hitos constant int[] := array[28, 21, 14, 7, 1, 0];
    c          record;
    v_faltan   int;
    v_hito     int;
    v_tipo     text;
    v_cuando   text;
    v_mensaje  text;
    n_avisos   int := 0;
    n_fila     int;
begin
    for c in
        select id, nombre, fecha_vencimiento_tramite, notaria_id
          from public.carpetas
         where activa
           and not finalizado
           and not pausado                        -- en pausa el reloj está detenido
           and fecha_vencimiento_tramite is not null
    loop
        v_faltan := c.fecha_vencimiento_tramite - current_date;

        -- Ya vencido: de eso avisa 'proceso-vencido', no este aviso
        if v_faltan < 0 then continue; end if;

        -- El hito más cercano al vencimiento que ya se alcanzó. Si
        -- faltan 26 días (el hito de 28 cayó en festivo), sale el de
        -- 4 semanas; si faltan 40, todavía no sale ninguno.
        select min(h) into v_hito from unnest(hitos) as h where v_faltan <= h;
        if v_hito is null then continue; end if;

        v_tipo := 'plazo-' || v_hito;

        v_cuando := case v_hito
            when 28 then 'Faltan 4 semanas'
            when 21 then 'Faltan 3 semanas'
            when 14 then 'Faltan 2 semanas'
            when  7 then 'Falta 1 semana'
            when  1 then 'Falta 1 día'
            else         'Hoy'
        end;

        v_mensaje := case
            when v_hito = 0 then
                'Hoy se cumple el plazo del trámite «' || c.nombre || '»'
            else
                v_cuando || ' para que se cumpla el plazo del trámite «' || c.nombre ||
                '»: vence el ' || to_char(c.fecha_vencimiento_tramite, 'DD/MM/YYYY')
        end;

        -- Una vez por PERSONA, no una vez por carpeta. Antes este
        -- guardia estaba arriba, como un `continue` que saltaba la
        -- carpeta entera en cuanto encontraba el aviso en la campana de
        -- cualquiera. Aquí adentro, cada destinatario se mira solo.
        --
        -- Se recorta el mensaje a 300 igual que _notificar, para que una
        -- carpeta con nombre larguísimo no reviente el insert.
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select d.perfil, v_tipo, left(v_mensaje, 300), c.id, c.id, c.notaria_id
          from public.destinatarios_de_carpeta(c.id) as d(perfil)
         where not exists (
                   select 1 from public.notificaciones n
                    where n.tipo = v_tipo
                      and n.referencia_id = c.id
                      and n.destinatario_id = d.perfil
               );

        get diagnostics n_fila = row_count;
        n_avisos := n_avisos + n_fila;
    end loop;

    return n_avisos;
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'avisar_plazos_tramite'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Procesos ya vencidos (la que dispara el portal al entrar)
-- ------------------------------------------------------------
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    -- El recorrido ya no filtra por «¿existe el aviso?»: ahora repasa
    -- todos los procesos vencidos y es el INSERT el que decide, admin
    -- por admin. Son pocas filas y el índice idx_notif_dedupe resuelve
    -- la comprobación.
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               left('El proceso «' || p.nombre || '» de «' || coalesce(nom, '') ||
                    '» se pasó del plazo', 300),
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id)
          and not exists (
                  select 1 from public.notificaciones n
                   where n.tipo = 'proceso-vencido'
                     and n.referencia_id = p.id
                     and n.destinatario_id = a.id
              );
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 4) La tarea diaria, con el mismo criterio
-- ------------------------------------------------------------
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_fila int;
    n_desactivadas int := 0;
    n_plazos int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Procesos ya vencidos, solo a los administradores de esa notaría,
    -- y solo a quien todavía no lo tenga en SU campana
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               left('El proceso «' || p.nombre || '» de «' || coalesce(nom, '') ||
                    '» se pasó del plazo', 300),
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id)
          and not exists (
                  select 1 from public.notificaciones n
                   where n.tipo = 'proceso-vencido'
                     and n.referencia_id = p.id
                     and n.destinatario_id = a.id
              );

        -- Cuenta avisos de verdad, no vueltas del bucle: antes sumaba 1
        -- por proceso aunque el insert no hubiera puesto ninguna fila.
        get diagnostics n_fila = row_count;
        n_avisos := n_avisos + n_fila;
    end loop;

    -- Avisos del plazo del trámite a todos los de la carpeta
    n_plazos := public.avisar_plazos_tramite();

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'avisos_de_plazo', n_plazos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 5) Comprobación
-- ------------------------------------------------------------
-- Cuenta a cuánta gente le falta un aviso que otros sí tienen. Son los
-- huecos que dejó el guardia viejo. No se rellenan solos de golpe: van
-- saliendo a medida que la tarea diaria vuelva a pasar por cada carpeta
-- y cada proceso vencido.
do $$
declare
    huecos int;
begin
    begin
        select count(*) into huecos
          from (
                select n.tipo, n.referencia_id, n.carpeta_id
                  from public.notificaciones n
                 where n.tipo like 'plazo-%'
                   and n.carpeta_id is not null
                 group by n.tipo, n.referencia_id, n.carpeta_id
                having count(distinct n.destinatario_id) <
                       (select count(*) from public.destinatarios_de_carpeta(n.carpeta_id))
               ) q;

        raise notice 'Avisos de plazo que no alcanzaron a todos los de su carpeta: %', huecos;
        raise notice 'La tarea diaria los completa en su proxima pasada.';
    exception when others then
        -- La comprobación es informativa: si no se puede calcular, la
        -- migración ya hizo su trabajo y no tiene por qué fallar aquí.
        raise notice 'No se pudo contar los huecos (%). Las funciones quedaron aplicadas igual.', sqlerrm;
    end;
end $$;

select 'campana por persona: listo' as resultado;
