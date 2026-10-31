-- ============================================================
-- MIGRACIÓN: centros de conciliación junto a las notarías
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ CAMBIA
--   Cada oficina tiene un tipo:
--     notaria  lleva insolvencia (60 días hábiles, 90 con prórroga)
--     centro   lleva conciliación (3 meses desde la solicitud,
--              prorrogables 3 más por acuerdo de las partes, Ley 2220
--              de 2022)
--   Las carpetas no guardan el tipo: lo toman de su oficina.
--
--   mis_notarias() devuelve el tipo, notaria_crear() y notaria_editar()
--   lo reciben. El tipo de una oficina con carpetas no se cambia: sus
--   plazos ya se contaron con las reglas del otro tipo.
--
--   iniciar_tramite() y aplicar_prorroga() cuentan según el tipo. En
--   conciliación el vencimiento es una fecha de calendario y
--   dias_habiles_tramite guarda los días hábiles que caben en ella, para
--   que la pausa y el semáforo sigan funcionando igual.
--
--   carpetas.resultado: cómo terminó la conciliación. Se fija al dar fin
--   al trámite con finalizar_tramite(carpeta, resultado).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Tipo de oficina
-- ------------------------------------------------------------
alter table public.notarias add column if not exists tipo text not null default 'notaria';
alter table public.notarias drop constraint if exists notarias_tipo_check;
alter table public.notarias add constraint notarias_tipo_check
    check (tipo in ('notaria', 'centro'));

comment on column public.notarias.tipo is
    'notaria = insolvencia; centro = centro de conciliación.';

-- Cambian las columnas que devuelve: hay que borrarla. Dentro de la
-- transacción el portal no alcanza a verla ausente.
drop function if exists public.mis_notarias();
create function public.mis_notarias()
returns table (id bigint, nombre text, ciudad text, activa boolean, carpetas bigint, tipo text)
language sql stable security definer set search_path = public
as $$
    select n.id, n.nombre, n.ciudad, n.activa,
           (select count(*) from public.carpetas c
             where c.notaria_id = n.id and c.activa),
           n.tipo
      from public.notarias n
     where n.id in (select public.notarias_del_usuario())
       and n.activa
     order by n.tipo, n.ciudad, n.nombre;
$$;

drop function if exists public.notaria_crear(text, text);
create or replace function public.notaria_crear(
    p_nombre text, p_ciudad text, p_tipo text default 'notaria')
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    nuevo bigint;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede crear oficinas.';
    end if;
    insert into public.notarias (nombre, ciudad, tipo)
         values (trim(p_nombre), trim(p_ciudad), coalesce(nullif(trim(p_tipo), ''), 'notaria'))
      returning id into nuevo;
    return nuevo;
end;
$$;

drop function if exists public.notaria_editar(bigint, text, text, boolean);
create or replace function public.notaria_editar(
    p_id bigint, p_nombre text, p_ciudad text, p_activa boolean, p_tipo text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    actual text;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede editar oficinas.';
    end if;
    select tipo into actual from public.notarias where id = p_id;
    if p_tipo is not null and p_tipo <> actual
       and exists (select 1 from public.carpetas where notaria_id = p_id) then
        raise exception 'Esta oficina ya tiene carpetas: su tipo no se puede cambiar.';
    end if;
    update public.notarias
       set nombre = coalesce(nullif(trim(p_nombre), ''), nombre),
           ciudad = coalesce(nullif(trim(p_ciudad), ''), ciudad),
           activa = coalesce(p_activa, activa),
           tipo   = coalesce(p_tipo, tipo)
     where id = p_id;
end;
$$;

-- Fecha más n meses; si cae en día no hábil, pasa al siguiente hábil
create or replace function public.sumar_meses_habil(f date, n int)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
    d date := (f + make_interval(months => n))::date;
begin
    while not public.es_dia_habil(d) loop d := d + 1; end loop;
    return d;
end;
$$;

-- Tipo de la oficina de una carpeta
create or replace function public.clase_de_carpeta(p_carpeta bigint)
returns text
language sql stable security definer set search_path = public
as $$
    select coalesce(n.tipo, 'notaria')
      from public.carpetas c
      left join public.notarias n on n.id = c.notaria_id
     where c.id = p_carpeta;
$$;

-- ------------------------------------------------------------
-- 2) Plazo según el tipo
-- ------------------------------------------------------------
-- 60 y 90 eran los únicos valores; en conciliación son los días hábiles
-- que caben en 3 o 6 meses.
alter table public.carpetas drop constraint if exists carpetas_dias_habiles_tramite_check;
alter table public.carpetas add constraint carpetas_dias_habiles_tramite_check
    check (dias_habiles_tramite between 1 and 400);

create or replace function public.iniciar_tramite(carpeta bigint, p_fecha date default current_date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
    f date := coalesce(p_fecha, current_date);
    vence date;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para iniciar el conteo de este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de iniciar el conteo'; end if;
    if c.fecha_inicio_tramite is not null then
        raise exception 'El conteo del trámite ya fue iniciado el %', c.fecha_inicio_tramite;
    end if;
    vence := case when public.clase_de_carpeta(carpeta) = 'centro'
                  then public.sumar_meses_habil(f, 3)
                  else public.calcular_vencimiento_habil(f, 60) end;
    update public.carpetas
       set fecha_inicio_tramite = f,
           dias_habiles_tramite = greatest(public.contar_dias_habiles(f, vence), 1),
           tiene_prorroga = false,
           fecha_vencimiento_tramite = vence,
           dias_restantes_tramite_al_pausar = null
     where id = carpeta;
end;
$$;

create or replace function public.aplicar_prorroga(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
    vence date;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para aplicar la prórroga a este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.fecha_inicio_tramite is null then
        raise exception 'El trámite aún no tiene conteo iniciado: usa iniciar_tramite primero';
    end if;
    if c.tiene_prorroga then raise exception 'El trámite ya tiene la prórroga aplicada'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de aplicar la prórroga'; end if;
    -- Conciliación: 3 meses más sobre el vencimiento que tenía
    vence := case when public.clase_de_carpeta(carpeta) = 'centro'
                  then public.sumar_meses_habil(coalesce(c.fecha_vencimiento_tramite, c.fecha_inicio_tramite), 3)
                  else public.calcular_vencimiento_habil(c.fecha_inicio_tramite, 90) end;
    update public.carpetas
       set dias_habiles_tramite = greatest(public.contar_dias_habiles(c.fecha_inicio_tramite, vence), 1),
           tiene_prorroga = true,
           fecha_vencimiento_tramite = vence
     where id = carpeta;
end;
$$;

-- El aviso de la prórroga ya no dice «90 días hábiles»
create or replace function public.notif_carpeta_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.pausado is distinct from old.pausado then
        perform public._notificar_admins(case when new.pausado then 'tramite-pausado' else 'tramite-reactivado' end,
            'El trámite «' || new.nombre || '» fue ' || case when new.pausado then 'pausado' else 'reactivado' end,
            new.id, null);
    end if;
    if new.tiene_prorroga and not old.tiene_prorroga then
        perform public._notificar_admins('tramite-prorroga',
            'Se aplicó la prórroga al trámite «' || new.nombre || '»: ahora vence el ' ||
            to_char(new.fecha_vencimiento_tramite, 'DD/MM/YYYY'),
            new.id, null);
    end if;

    -- La fecha de vencimiento se movió (prórroga, o reactivación tras
    -- una pausa): los avisos viejos ya no valen y además bloquearían
    -- los nuevos, porque cada hito se manda una sola vez.
    if new.fecha_vencimiento_tramite is distinct from old.fecha_vencimiento_tramite then
        delete from public.notificaciones
         where referencia_id = new.id
           and tipo in ('plazo-28', 'plazo-21', 'plazo-14', 'plazo-7', 'plazo-1', 'plazo-0');
    end if;

    return new;
end;
$$;

-- ------------------------------------------------------------
-- 3) Resultado de la conciliación
-- ------------------------------------------------------------
alter table public.carpetas add column if not exists resultado text;
alter table public.carpetas drop constraint if exists carpetas_resultado_check;
alter table public.carpetas add constraint carpetas_resultado_check
    check (resultado is null or resultado in
        ('acuerdo_total', 'acuerdo_parcial', 'no_acuerdo', 'inasistencia', 'desistimiento'));

drop function if exists public.finalizar_tramite(bigint);
create or replace function public.finalizar_tramite(carpeta bigint, p_resultado text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede dar fin al trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya estaba finalizado'; end if;
    if public.clase_de_carpeta(carpeta) = 'centro' and p_resultado is null then
        raise exception 'La conciliación necesita un resultado para cerrarse';
    end if;
    update public.carpetas
       set finalizado = true,
           fecha_fin_tramite = current_date,
           fecha_desactivacion_programada =
               public.sumar_dias_habiles(current_date, public.dias_gracia_cierre()),
           desactivacion_auto_aplicada = false,
           resultado = p_resultado
     where id = carpeta;
end;
$$;

-- ------------------------------------------------------------
-- 4) Permisos
-- ------------------------------------------------------------
do $$
declare f record;
begin
    for f in
        select oid::regprocedure as firma
          from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('mis_notarias', 'notaria_crear', 'notaria_editar',
                           'iniciar_tramite', 'aplicar_prorroga', 'finalizar_tramite')
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
        execute format('grant  execute on function %s to authenticated', f.firma);
    end loop;
end $$;

-- Interna: la usan las funciones de arriba, no el portal
revoke execute on function public.clase_de_carpeta(bigint) from public, anon, authenticated;
revoke execute on function public.sumar_meses_habil(date, int) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
