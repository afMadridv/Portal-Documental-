-- ============================================================
-- MIGRACIÓN: «En línea» solo lo ve el administrador
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va entera dentro de una transacción.
--
-- QUÉ PASABA
--   El punto verde de «En línea» en Usuarios salía de un canal de
--   Realtime llamado «portal-presencia». Cada sesión se anunciaba ahí
--   con su nombre de usuario, y esos canales los puede abrir cualquiera
--   que tenga la clave pública (va en config.js): una persona sin cuenta
--   veía quién estaba conectado y cuándo, y cualquier cliente con sesión
--   veía los usuarios de los demás.
--
-- QUÉ HACE AHORA
--   Cada sesión abierta da un latido por minuto (latido()), que deja la
--   hora en la tabla presencia. El administrador pregunta quién dio
--   latido en los últimos dos minutos (conectados()). La tabla no se lee
--   por la API: solo esas dos funciones la tocan, y conectados() solo le
--   responde a un administrador activo.
--
--   Se pierde el «al instante»: quien cierra el portal pasa a
--   «Desconectado» a los dos minutos como mucho. Para saber quién está
--   trabajando alcanza, y a cambio nadie de fuera lo ve.
--
-- LEY 1581 DE 2012
--   Saber si alguien está conectado es un dato personal. Se trata con un
--   fin concreto (soporte y seguridad del portal), lo ve solo quien lo
--   necesita (el administrador) y la política de tratamiento de datos lo
--   dice (privacidad.html).
-- ============================================================

begin;

create table if not exists public.presencia (
    perfil_id uuid primary key references public.perfiles (id) on delete cascade,
    visto     timestamptz not null default now()
);

comment on table public.presencia is
    'Último latido de cada sesión abierta. Lo escribe latido() y lo lee conectados() (solo administrador).';

-- Sin políticas a propósito: con RLS encendida y ninguna política, la
-- API no deja leer ni escribir. Todo pasa por las funciones de abajo.
alter table public.presencia enable row level security;
revoke all on table public.presencia from anon, authenticated;


-- Cada sesión, una vez por minuto
create or replace function public.latido()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then return; end if;
    -- Una cuenta desactivada no cuenta como conectada
    if not exists (select 1 from public.perfiles where id = auth.uid() and activo) then return; end if;
    insert into public.presencia (perfil_id, visto) values (auth.uid(), now())
    on conflict (perfil_id) do update set visto = excluded.visto;
end;
$$;


-- Quién dio latido en los últimos dos minutos. Solo el administrador.
create or replace function public.conectados()
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede ver quién está conectado.' using errcode = '42501';
    end if;
    return query
        select p.usuario
          from public.presencia x
          join public.perfiles p on p.id = x.perfil_id
         where x.visto > now() - interval '2 minutes'
           and p.activo;
end;
$$;


revoke execute on function public.latido()     from public, anon;
grant  execute on function public.latido()     to authenticated;
revoke execute on function public.conectados() from public, anon;
grant  execute on function public.conectados() to authenticated;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- authenticated puede llamar a las dos funciones; anon a ninguna, y
-- nadie lee la tabla directamente.
select p.proname as funcion,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('latido', 'conectados')
 order by 1;
