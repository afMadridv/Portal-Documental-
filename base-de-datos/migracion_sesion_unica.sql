-- ============================================================
-- MIGRACIÓN: una sola sesión abierta por cuenta
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ RESUELVE
--   La misma cuenta podía estar abierta a la vez en el computador y en
--   el celular, y ninguna de las dos se enteraba de la otra. En un
--   portal de expedientes eso significa que una credencial prestada
--   sirve para dos personas al mismo tiempo, y que al retirarle el
--   acceso a alguien queda la duda de cuántos dispositivos tenía.
--
--   Ahora cada ingreso anota cuál es LA sesión vigente. Los demás
--   dispositivos lo notan al preguntar y se cierran solos.
--
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN `perfiles`
--   El portal hace `select *` sobre `perfiles` para la lista de
--   usuarios. Con la marca de sesión ahí dentro, el identificador de
--   sesión de TODA la notaría acabaría en el navegador del
--   administrador cada vez que abre esa pantalla. No es una credencial
--   por sí sola (hace falta además el token de la persona), pero no hay
--   ninguna razón para repartirlo.
--
-- QUIÉN PUEDE ESCRIBIR AQUÍ
--   Nadie directamente. La tabla no tiene políticas de insert, update
--   ni delete: solo se toca por `sesion_abrir()`, que es SECURITY
--   DEFINER y siempre escribe la fila de quien llama. Así nadie puede
--   marcar como vigente la sesión de otro.
-- ============================================================

create table if not exists public.sesiones (
    perfil_id   uuid primary key references public.perfiles (id) on delete cascade,
    sesion_id   uuid not null,
    dispositivo text not null default '',
    desde       timestamptz not null default now()
);

alter table public.sesiones enable row level security;

-- Cada quien ve la suya, y nada más. Sirve para que el portal pueda
-- decir desde cuándo y desde dónde está abierta.
drop policy if exists "ver mi propia sesion" on public.sesiones;
create policy "ver mi propia sesion" on public.sesiones
    for select using (perfil_id = (select auth.uid()));


-- ------------------------------------------------------------
-- Abrir sesión: anota esta como la vigente y devuelve su identificador
-- ------------------------------------------------------------
create or replace function public.sesion_abrir(p_dispositivo text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid := gen_random_uuid();
begin
    if auth.uid() is null then
        raise exception 'Sin sesión de autenticación';
    end if;

    insert into public.sesiones (perfil_id, sesion_id, dispositivo, desde)
    values (auth.uid(), v_id, coalesce(left(p_dispositivo, 120), ''), now())
    on conflict (perfil_id) do update
        set sesion_id = excluded.sesion_id,
            dispositivo = excluded.dispositivo,
            desde = now();

    return v_id;
end;
$$;


-- ------------------------------------------------------------
-- Estado de la sesión que pregunta
-- ------------------------------------------------------------
-- Tres respuestas en una sola ida al servidor:
--
--   'viva'       todo en orden
--   'fuera'      el perfil ya no existe, o está desactivado
--   'desplazada' alguien entró después en otro dispositivo
--
-- Son tres y no dos a propósito. El portal trata distinto «te quitaron
-- la cuenta» de «entraste en otro sitio», porque lo que hay que decirle
-- a la persona es distinto.
--
-- Una sesión SIN identificador (abierta antes de esta migración)
-- devuelve 'viva': la migración no echa a nadie por sí sola. Queda
-- sujeta al desplazamiento en cuanto vuelva a entrar.
create or replace function public.sesion_estado(p_sesion uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_activo boolean;
    v_vigente uuid;
begin
    if auth.uid() is null then
        return 'fuera';
    end if;

    select activo into v_activo from public.perfiles where id = auth.uid();
    if not found then return 'fuera'; end if;
    if v_activo is false then return 'fuera'; end if;

    select sesion_id into v_vigente from public.sesiones where perfil_id = auth.uid();
    if found and p_sesion is not null and v_vigente <> p_sesion then
        return 'desplazada';
    end if;

    return 'viva';
end;
$$;

revoke execute on function public.sesion_abrir(text)  from public, anon;
revoke execute on function public.sesion_estado(uuid) from public, anon;
grant execute on function public.sesion_abrir(text)  to authenticated;
grant execute on function public.sesion_estado(uuid) to authenticated;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
--   select p.usuario, s.dispositivo, s.desde
--     from public.sesiones s join public.perfiles p on p.id = s.perfil_id
--    order by s.desde desc;
--
-- Una fila por cuenta, con el último dispositivo que entró.
-- ============================================================
