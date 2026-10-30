-- ============================================================
-- MIGRACIÓN: vuelven a cerrarse las funciones internas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va entera dentro de una transacción.
--
-- QUÉ PASÓ
--   migracion_seguridad_2026_08.sql le había quitado a todo el mundo el
--   permiso de ejecutar _notificar y _notificar_admins. Su comentario lo
--   explica: con ellas, cualquiera puede meter avisos falsos en la
--   campana de otro usuario, con la cara del portal. Un phishing servido
--   desde casa.
--
--   Un mes después, migracion_endurecimiento_2026_09.sql recorrió TODAS
--   las funciones SECURITY DEFINER y le devolvió el permiso a
--   `authenticated` a cada una que no estuviera en su lista de internas.
--   Esa lista era corta y no traía _notificar ni _notificar_admins. Desde
--   entonces cualquier usuario con sesión (un cliente, un acreedor) puede
--   llamar por HTTP a
--
--     POST /rest/v1/rpc/_notificar
--
--   y dejarle a quien quiera, administrador incluido, un aviso con el
--   texto que se le antoje. Con recalcular_peso_carpeta pasó lo mismo, y
--   en una instalación nueva también con almacenamiento_registrar, que
--   deja poner cifras falsas en la barra del disco.
--
--   El endurecimiento ya viene corregido en el repositorio para que
--   volver a correrlo no las abra otra vez. Esta migración arregla el
--   servidor, que ya lo corrió con la lista vieja.
--
-- QUÉ HACE
--   1. Les quita el EXECUTE a PUBLIC, anon y authenticated a las
--      funciones que solo se llaman desde dentro de la base (desde otras
--      funciones o desde la tarea diaria) y a todas las de disparador.
--      Las funciones SECURITY DEFINER que las llaman corren como su
--      dueño, así que siguen funcionando igual.
--   2. Le quita al rol anon cualquier permiso sobre las tablas. Hoy ya no
--      puede leer nada porque las políticas se lo impiden, pero el
--      permiso seguía ahí: una política mal escrita mañana y la tabla
--      queda abierta. Quien no ha iniciado sesión no necesita tocar una
--      tabla: las visitas al ingreso y «olvidé mi contraseña» pasan por funciones.
--   3. Cada llamada de soporte recibe un nombre de canal al azar. La
--      señalización de la llamada viaja por un canal de Realtime, y esos
--      canales los puede abrir cualquiera que tenga la clave pública
--      (que va en config.js). Con el nombre «llamada-<número>», alguien
--      podía escuchar la negociación o meter una respuesta falsa y
--      quedarse con la llamada. El nombre nuevo solo lo pueden leer los
--      dos participantes, porque vive en su fila de llamadas_soporte.
--
-- SI ALGO FALLA
--   Nada del portal llama a estas funciones desde el navegador (se
--   comprobó en nube.js). Si aun así algo deja de funcionar, la consulta
--   del final dice qué permisos quedaron.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Funciones internas: nadie las llama por HTTP
-- ------------------------------------------------------------
do $$
declare
    f record;
    internas constant text[] := array[
        '_notificar', '_notificar_admins',
        'almacenamiento_registrar', 'recalcular_peso_carpeta',
        'cron_plazos_diario', 'avisar_plazos_tramite',
        'destinatarios_de_carpeta', 'perfil_alcanza_notaria'
    ];
begin
    for f in
        select p.oid::regprocedure as firma
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname = any(internas) or p.prorettype = 'trigger'::regtype)
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 2) anon sin permisos sobre las tablas
-- ------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Y en las tablas que se creen de aquí en adelante. Para las que crea
-- supabase_admin puede faltar permiso: si pasa, se sigue sin ese paso.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
do $$
begin
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
exception when others then
    raise notice 'Sin permiso para cambiar los privilegios por defecto de supabase_admin: %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- 3) Un canal secreto por llamada
-- ------------------------------------------------------------
-- gen_random_uuid() es parte de Postgres desde la 13 y usa el
-- generador fuerte del sistema. Al añadir la columna, cada llamada
-- vieja recibe su propio valor.
alter table public.llamadas_soporte
    add column if not exists canal text not null default gen_random_uuid()::text;

comment on column public.llamadas_soporte.canal is
    'Nombre del canal de Realtime de la llamada. Solo lo leen los dos participantes (RLS).';

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- Todas las filas deben decir false en las dos columnas, salvo
-- registrar_evento_web y solicitar_restablecimiento, que son públicas
-- a propósito y no salen aquí.
select p.proname as funcion,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('_notificar', '_notificar_admins', 'almacenamiento_registrar',
                     'recalcular_peso_carpeta')
 order by 1;

-- Debe dar 0: anon ya no tiene ningún permiso sobre tablas de public
select count(*) as permisos_de_anon_en_tablas
  from information_schema.role_table_grants
 where grantee = 'anon' and table_schema = 'public';
