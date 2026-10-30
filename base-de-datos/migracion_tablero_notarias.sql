-- ============================================================
-- MIGRACIÓN: tablero de la pantalla de notarías
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ ARREGLA
--   La pantalla donde se elige la notaría enseñaba «Por vencer: —» en
--   todas las oficinas. El portal esperaba un `por_vencer` que
--   mis_notarias() nunca devolvió, así que la cifra salía vacía siempre,
--   hubiera o no trámites a punto de vencer.
--
-- QUÉ AÑADE
--   tablero_notarias(): por cada oficina, lo que hace falta para decidir
--   a cuál entrar sin abrirlas una por una.
--
--     carpetas_activas  las carpetas abiertas
--     por_vencer        procesos en naranja (vencen hoy o el siguiente día hábil)
--     vencidos          procesos en rojo (ya se pasaron del plazo)
--
--   Y solo para el administrador, el espacio que ocupa cada oficina en
--   el servidor:
--
--     carpetas_total    activas y desactivadas
--     documentos        cuántos archivos
--     peso_bytes        cuánto pesan
--
--   A los demás esas tres columnas les llegan vacías: la carga de cada
--   oficina no es asunto de las partes ni del operador, igual que en
--   almacenamiento_ver().
--
-- POR QUÉ UNA FUNCIÓN NUEVA Y NO AMPLIAR mis_notarias()
--   Cambiar las columnas que devuelve una función obliga a borrarla y
--   crearla de nuevo, y en el rato entre las dos el portal se queda sin
--   pantalla de notarías. Con una función aparte, mis_notarias() sigue
--   igual y el portal sigue funcionando aunque esta migración no se haya
--   corrido todavía: si tablero_notarias() no existe, las cifras nuevas
--   simplemente no salen.
--
-- DE DÓNDE SALE CADA NÚMERO
--   El color de cada proceso lo decide calcular_semaforo(), la misma que
--   usa listar_procesos(): la pantalla de notarías y la de Estados no
--   pueden contradecirse. Una carpeta en pausa detiene el reloj de todos
--   sus procesos, así que no cuenta como vencida.
--
--   El peso sale de carpetas.peso_total_bytes y total_archivos, que los
--   disparadores mantienen al día al subir y borrar. No se recorre
--   storage.objects: sería lento y daría lo mismo.
--
--   Quien no es administrador solo cuenta lo que puede ver
--   (puede_ver_carpeta), para que la cifra no filtre cuántos trámites
--   tiene la oficina que no son suyos.
-- ============================================================

create or replace function public.tablero_notarias()
returns table (
    notaria_id       bigint,
    carpetas_activas bigint,
    por_vencer       bigint,
    vencidos         bigint,
    carpetas_total   bigint,
    documentos       bigint,
    peso_bytes       bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    admin boolean := public.es_admin();
begin
    return query
    with vis as (
        select c.id, c.notaria_id, c.activa, c.pausado,
               c.total_archivos, c.peso_total_bytes
          from public.carpetas c
         where admin or public.puede_ver_carpeta(c.id)
    ),
    sem as (
        select v.notaria_id,
               public.calcular_semaforo(p.completado, p.pausado or v.pausado,
                                        p.semaforo_manual, p.fecha_vencimiento_habil) as color
          from public.procesos_tramite p
          join vis v on v.id = p.carpeta_id
         where v.activa and not p.completado
    ),
    oficinas as (
        select n.id
          from public.notarias n
         where admin or n.id in (select public.notarias_del_usuario())
        union all
        -- Carpetas de antes de que existieran las notarías, sin oficina.
        -- Solo las ve el administrador, y solo si queda alguna.
        select null::bigint
         where admin and exists (select 1 from vis where vis.notaria_id is null)
    )
    select o.id,
           (select count(*) from vis
             where vis.notaria_id is not distinct from o.id and vis.activa),
           (select count(*) from sem
             where sem.notaria_id is not distinct from o.id and sem.color = 'naranja'),
           (select count(*) from sem
             where sem.notaria_id is not distinct from o.id and sem.color = 'rojo'),
           case when admin then (select count(*) from vis
             where vis.notaria_id is not distinct from o.id) end,
           case when admin then (select coalesce(sum(vis.total_archivos), 0) from vis
             where vis.notaria_id is not distinct from o.id)::bigint end,
           case when admin then (select coalesce(sum(vis.peso_total_bytes), 0) from vis
             where vis.notaria_id is not distinct from o.id)::bigint end
      from oficinas o;
end;
$$;

-- El grant explícito, y solo a quien inició sesión. Revocar de `public`
-- es imprescindible: Postgres concede EXECUTE a ese pseudo-rol en toda
-- función nueva, y revocar solo de `anon` no quita nada.
revoke execute on function public.tablero_notarias() from public, anon;
grant  execute on function public.tablero_notarias() to authenticated;

-- PostgREST guarda en memoria qué funciones existen. Sin esto la nueva
-- no se ve hasta reiniciar el contenedor.
notify pgrst, 'reload schema';

-- Comprobación: tiene que decir que authenticated SÍ puede ejecutarla y
-- anon NO. (Llamarla desde psql no sirve de prueba: ahí no hay sesión
-- del portal, así que devuelve cero filas, que es lo correcto.)
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'tablero_notarias';
