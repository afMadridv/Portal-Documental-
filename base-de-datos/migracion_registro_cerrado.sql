-- ============================================================
-- MIGRACIÓN: una cuenta que no creó un administrador nace inactiva
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ PASABA
--   El trigger crear_perfil_nuevo le daba a TODA cuenta nueva de Auth un
--   perfil de cliente ACTIVO. Con el registro público de Supabase abierto
--   (lo estuvo hasta el 29/09/2026, incluido el registro por teléfono con
--   confirmación automática), cualquiera con la clave pública podía
--   crearse una cuenta y entrar al portal. No veía carpetas, porque no
--   tenía ninguna asignada, pero no debía poder entrar.
--
--   El registro ya se cerró en el .env (DISABLE_SIGNUP=true,
--   ENABLE_PHONE_SIGNUP=false). Esto es la segunda cerradura: si algún día
--   se vuelve a abrir por error, la cuenta nace inactiva, y una cuenta
--   inactiva no tiene rol (rol_actual() exige activo), así que no ve nada
--   y el ingreso la rechaza.
--
-- QUIÉN ACTIVA
--   La Edge Function crear-usuario, que solo acepta a un administrador
--   activo, marca la cuenta como activa al fijar su rol. Es el único
--   camino por el que el portal crea cuentas.
--
--   La primera cuenta de una base vacía sigue naciendo administradora y
--   activa: es la que se crea a mano al instalar (base-de-datos/LEEME.md).
-- ============================================================

create or replace function public.crear_perfil_nuevo()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
    total integer;
begin
    select count(*) into total from public.perfiles;
    insert into public.perfiles (id, usuario, nombre, rol, activo)
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'usuario', split_part(new.email, '@', 1)),
        coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)),
        case when total = 0 then 'administrador' else 'cliente' end,
        -- Solo la primera; las demás las activa crear-usuario
        total = 0
    );
    return new;
end;
$$;

-- Comprobación: cuentas de Auth que NO salieron de crear-usuario. Esas
-- siempre tienen correo usuario@portal.documental.com; una con teléfono o con
-- otro correo vino del registro público y hay que revisarla. Lo normal
-- es que esta consulta no devuelva ninguna fila.
select u.id, coalesce(u.email, '') as correo, coalesce(u.phone, '') as telefono,
       u.created_at, u.last_sign_in_at, p.rol, p.activo
  from auth.users u
  left join public.perfiles p on p.id = u.id
 where coalesce(u.phone, '') <> ''
    or u.email is null
    or u.email not like '%@portal.documental.com'
 order by u.created_at;
