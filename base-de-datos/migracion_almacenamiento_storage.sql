-- ============================================================
-- MIGRACIÓN: el espacio se mide en Storage, no en el disco
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ PASABA
--   La sección Almacenamiento leía la fila que escribía medir-disco.sh
--   con df en un servidor propio. En Supabase cloud no hay disco que
--   medir: los documentos viven en Storage y el plan trae un cupo
--   (1 GB en el gratis, 100 GB en Pro). Sin ese script la sección decía
--   «El servidor todavía no ha medido el disco» para siempre.
--
-- QUÉ HACE
--   almacenamiento_ver() calcula en el momento, sin tarea aparte:
--     total  el cupo del plan, en almacenamiento.total_mb (1024 si está en 0)
--     usado  todo lo que hay en Storage (lo que cuenta contra el cupo)
--     docs   lo que pesan los documentos de los expedientes
--     libre  total menos usado
--   La diferencia entre usado y docs son los adjuntos de chat y soporte.
--
--   almacenamiento_cupo(mb) deja al administrador fijar el cupo cuando
--   se cambia de plan:
--     select public.almacenamiento_cupo(102400);   -- 100 GB (Pro)
-- ============================================================

begin;

create or replace function public.almacenamiento_ver()
returns table (
    total_bytes bigint,
    usado_bytes bigint,
    libre_bytes bigint,
    docs_bytes  bigint,
    medido      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_total bigint;
    v_usado bigint;
begin
    if not public.es_admin() then
        return;   -- cero filas, sin error
    end if;
    select (coalesce(nullif(a.total_mb, 0), 1024) * 1048576)::bigint into v_total
      from public.almacenamiento a where a.id = 1;
    v_total := coalesce(v_total, 1024::bigint * 1048576);
    select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into v_usado
      from storage.objects o;
    return query
    select v_total,
           v_usado,
           greatest(v_total - v_usado, 0),
           coalesce((select sum(c.peso_total_bytes) from public.carpetas c), 0)::bigint,
           now();
end;
$$;

create or replace function public.almacenamiento_cupo(p_mb numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede cambiar el cupo.' using errcode = '42501';
    end if;
    if p_mb is null or p_mb <= 0 then
        raise exception 'El cupo tiene que ser mayor que cero.' using errcode = '22023';
    end if;
    insert into public.almacenamiento (id, total_mb, actualizado)
    values (1, p_mb, now())
    on conflict (id) do update set total_mb = excluded.total_mb, actualizado = now();
end;
$$;

revoke execute on function public.almacenamiento_ver()          from public, anon;
grant  execute on function public.almacenamiento_ver()          to authenticated;
revoke execute on function public.almacenamiento_cupo(numeric)  from public, anon;
grant  execute on function public.almacenamiento_cupo(numeric)  to authenticated;

notify pgrst, 'reload schema';

commit;
