-- ============================================================
-- MIGRACIÓN: el aviso de solicitud de clave dice quién es y se
--            repite si la persona insiste
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. Solicitud de clave («¿Olvidaste tu contraseña?»): el aviso al
--      administrador (campana y celular, categoría Accesos) dice nombre
--      y rol, y si la persona vuelve a pedirla con una solicitud todavía
--      pendiente, avisa otra vez (máximo uno cada 30 minutos). Antes la
--      segunda solicitud no avisaba nada mientras la primera siguiera
--      abierta.
--
--   2. Las llamadas siguen siendo solo del administrador a operadores,
--      monitores y clientes; operadores y monitores escriben por el chat.
--      Una versión anterior de este archivo (migracion_llamadas_al_admin)
--      dejaba que ellos llamaran a la administración y estuvo publicada
--      un rato: si alguien la alcanzó a correr, esto la deshace.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Solicitud de clave: quién es, y aviso otra vez si insiste
-- ------------------------------------------------------------
-- Igual que en migracion_endurecimiento_2026_09.sql (mismos topes y
-- misma respuesta exista o no el usuario), con dos cambios:
--   · el aviso dice nombre y rol; el usuario va primero entre « »
--     porque la campana lo lee de ahí para abrir su ficha;
--   · con una solicitud pendiente, la nueva no se descarta en silencio:
--     si la anterior avisó hace más de 30 minutos, avisa otra vez.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    suyas int;
    v_nombre text;
    v_rol    text;
    v_otra   boolean := false;
    TOPE_GLOBAL   constant int := 40;
    TOPE_USUARIO  constant int := 3;
    VENTANA       constant interval := interval '15 minutes';
    REPETIR       constant interval := interval '30 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    select count(*) into recientes
      from public.solicitudes_clave
     where fecha > now() - VENTANA;
    if recientes >= TOPE_GLOBAL then return; end if;

    select count(*) into suyas
      from public.solicitudes_clave
     where usuario = u and fecha > now() - VENTANA;
    if suyas >= TOPE_USUARIO then return; end if;

    -- Se responde igual exista o no el usuario: lo contrario revelaría
    -- quién tiene cuenta en el portal
    select nombre, rol into v_nombre, v_rol from public.perfiles where usuario = u and activo;
    if not found then return; end if;

    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then
        update public.solicitudes_clave
           set fecha = now()
         where usuario = u and estado = 'pendiente' and fecha < now() - REPETIR;
        if not found then return; end if;
        v_otra := true;
    else
        insert into public.solicitudes_clave (usuario) values (u);
    end if;

    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» (' || coalesce(nullif(v_nombre, ''), 'sin nombre') || ', ' || v_rol || ') ' ||
        case when v_otra then 'vuelve a pedir que le restablezcan la contraseña'
             else 'olvidó su contraseña y solicita restablecerla' end,
        null, null);
end;
$$;

revoke execute on function public.solicitar_restablecimiento(text) from public;
grant  execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2) Sin llamadas del equipo a la administración
-- ------------------------------------------------------------
drop function if exists public.llamar_administracion();
drop trigger if exists notif_llamada_soporte on public.llamadas_soporte;
drop function if exists public.notif_llamada_soporte();
drop index if exists public.idx_llamadas_iniciador_creado;
alter table public.llamadas_soporte drop column if exists grupo;
alter table public.llamadas_soporte drop column if exists iniciador_nombre;
delete from public.notificaciones where tipo in ('llamada-soporte', 'llamada-perdida');

-- La de migracion_avisos_push.sql, sin los dos tipos de llamada
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

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- solicitar_restablecimiento: anon y authenticated (quien olvidó la
-- clave no ha entrado). llamar_administracion no debe salir.
select p.proname as funcion,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('solicitar_restablecimiento', 'llamar_administracion')
 order by 1;
