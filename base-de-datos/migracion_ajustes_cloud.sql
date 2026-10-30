-- ============================================================
-- MIGRACIÓN: ajustes para Supabase cloud
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. Fija el search_path de las tres funciones de ayuda de los
--      avisos. El linter de Supabase las marca: sin search_path fijo,
--      quien cambie el suyo podría hacerlas resolver otra cosa.
--   2. Le quita a los usuarios con sesión el EXECUTE de
--      rls_auto_enable(), la función que Supabase cloud crea para
--      encender RLS en tablas nuevas. migracion_endurecimiento_2026_09.sql
--      recorre todas las SECURITY DEFINER de public y se lo devolvía.
-- ============================================================

begin;

alter function public._push_categoria(text)   set search_path = pg_catalog, public;
alter function public._push_hora(text)        set search_path = pg_catalog, public;
alter function public._push_dispositivo(text) set search_path = pg_catalog, public;

-- Solo existe en Supabase cloud; en autohospedado no hay nada que hacer
do $$
begin
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
        revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
    end if;
end $$;

commit;
