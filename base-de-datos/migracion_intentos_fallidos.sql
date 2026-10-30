-- ============================================================
-- MIGRACIÓN: intentos fallidos de ingreso, por cuenta
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- El tablero de Rendimiento contaba los intentos fallidos sin decir de
-- quién. Ahora se guarda cuál cuenta fue, solo si la cuenta existe: lo
-- que se escribe en un usuario que no existe no se guarda (a veces es la
-- contraseña tecleada en el campo equivocado).
--
--   registrar_intento_fallido(usuario)   la llama la pantalla de ingreso
--                                        (anon). Nunca dice si la cuenta
--                                        existe. Máximo 30 por cuenta y hora.
--   intentos_fallidos_web(desde, hasta)  solo el administrador activo.
-- ============================================================
begin;

create table if not exists public.intentos_fallidos (
    id        bigserial primary key,
    perfil_id uuid not null references public.perfiles (id) on delete cascade,
    fecha     timestamptz not null default now()
);
create index if not exists idx_intentos_fallidos_fecha  on public.intentos_fallidos (fecha);
create index if not exists idx_intentos_fallidos_perfil on public.intentos_fallidos (perfil_id, fecha);

-- Sin políticas: solo se toca por las funciones de abajo
alter table public.intentos_fallidos enable row level security;
revoke all on public.intentos_fallidos from public, anon, authenticated;
revoke all on sequence public.intentos_fallidos_id_seq from public, anon, authenticated;


create or replace function public.registrar_intento_fallido(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    -- Sirve igual si escribió el usuario o el correo interno (usuario@dominio)
    u   text := split_part(lower(trim(coalesce(p_usuario, ''))), '@', 1);
    pid uuid;
begin
    if length(u) < 2 or length(u) > 60 then return; end if;
    select id into pid from public.perfiles where lower(usuario) = u limit 1;
    if pid is null then return; end if;
    if (select count(*) from public.intentos_fallidos
         where perfil_id = pid and fecha > now() - interval '1 hour') >= 30 then
        return;
    end if;
    insert into public.intentos_fallidos (perfil_id) values (pid);
end;
$$;


create or replace function public.intentos_fallidos_web(p_desde date, p_hasta date)
returns table (usuario text, nombre text, rol text, intentos bigint, ultimo timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
    ZONA constant text := 'America/Bogota';
    d1 date := least(p_desde, p_hasta);
    d2 date := greatest(p_desde, p_hasta);
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede ver los intentos fallidos.' using errcode = '42501';
    end if;
    return query
        select p.usuario, p.nombre, p.rol, count(*)::bigint, max(i.fecha)
          from public.intentos_fallidos i
          join public.perfiles p on p.id = i.perfil_id
         where i.fecha >= d1::timestamp at time zone ZONA
           and i.fecha <  (d2 + 1)::timestamp at time zone ZONA
         group by p.usuario, p.nombre, p.rol
         order by count(*) desc, max(i.fecha) desc
         limit 50;
end;
$$;


revoke execute on function public.registrar_intento_fallido(text) from public;
grant  execute on function public.registrar_intento_fallido(text) to anon, authenticated;
revoke execute on function public.intentos_fallidos_web(date, date) from public, anon;
grant  execute on function public.intentos_fallidos_web(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- registrar: anon y authenticated. Leer: solo authenticated (y adentro, solo admin).
select p.proname as funcion,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('registrar_intento_fallido', 'intentos_fallidos_web')
 order by 1;
