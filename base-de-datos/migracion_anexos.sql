-- ============================================================
-- MIGRACIÓN: anexos de un documento (numeración 1, 1.1, 1.2…)
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va entera dentro de una transacción.
--
-- QUÉ AÑADE
--   Un documento puede ser anexo de otro: la solicitud y, debajo, la
--   cédula, el certificado de ingresos y la relación de acreedores. En
--   la tabla del portal salen como 1, 1.1, 1.2, 1.3, y el anexo viaja
--   siempre con su documento principal.
--
-- LAS REGLAS (las cuida la base, no solo la pantalla)
--   · Un anexo cuelga de un documento principal de la misma carpeta y
--     de la misma subcarpeta.
--   · Dos niveles y no más: un anexo no puede tener anexos, y un
--     documento que tiene anexos no puede volverse anexo de otro.
--   · Si se borra el principal, sus anexos quedan como documentos
--     sueltos (on delete set null): nada se borra sin que nadie lo pida.
--   · Si se mueve el principal a otra subcarpeta, sus anexos se mueven
--     con él. Si se mueve un anexo solo, deja de ser anexo.
--
-- Y UN ARREGLO DE PASO
--   «Mover a otra subcarpeta» no funcionaba en el servidor: el portal
--   hacía un update directo sobre archivos, la tabla no tiene ninguna
--   política de UPDATE, y la base ignoraba el cambio sin dar error. Ahora
--   se mueve por archivo_mover(), que revisa el permiso por dentro.
-- ============================================================

begin;

alter table public.archivos
    add column if not exists anexo_de bigint references public.archivos (id) on delete set null;
create index if not exists idx_archivos_anexo on public.archivos (anexo_de);

comment on column public.archivos.anexo_de is
    'Documento principal del que este es anexo (1.1, 1.2…). Null = documento principal.';


-- ------------------------------------------------------------
-- 1) La regla, en un disparador: vale para la subida y para los cambios
-- ------------------------------------------------------------
create or replace function public.validar_anexo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    p record;
begin
    if new.anexo_de is null then return new; end if;
    if new.anexo_de = new.id then
        raise exception 'Un documento no puede ser anexo de sí mismo.' using errcode = 'check_violation';
    end if;

    select carpeta_id, subcarpeta_id, anexo_de into p from public.archivos where id = new.anexo_de;
    if not found then
        raise exception 'El documento principal ya no existe.' using errcode = 'check_violation';
    end if;
    if p.carpeta_id <> new.carpeta_id or p.subcarpeta_id is distinct from new.subcarpeta_id then
        raise exception 'Un anexo tiene que estar en la misma carpeta y subcarpeta que su documento principal.'
            using errcode = 'check_violation';
    end if;
    if p.anexo_de is not null then
        raise exception 'Ese documento ya es un anexo: los anexos no pueden tener anexos.' using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from public.archivos where anexo_de = new.id) then
        raise exception 'Este documento tiene anexos: primero hay que soltarlos.' using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

-- Solo cuando cambia anexo_de. Los cambios de subcarpeta pasan por
-- archivo_mover(), que ya mueve al principal y a sus anexos juntos; y al
-- borrar una subcarpeta todos sus documentos van a la raíz a la vez. Si
-- el disparador mirara también subcarpeta_id, en ese borrado podría
-- revisar un anexo antes que a su principal y frenarlo sin motivo.
drop trigger if exists validar_anexo on public.archivos;
create trigger validar_anexo
    before insert or update of anexo_de on public.archivos
    for each row execute function public.validar_anexo();


-- ------------------------------------------------------------
-- 2) Marcar o soltar un anexo (p_padre null = vuelve a ser principal)
-- ------------------------------------------------------------
create or replace function public.archivo_fijar_anexo(p_archivo bigint, p_padre bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_carpeta bigint;
begin
    select carpeta_id into v_carpeta from public.archivos where id = p_archivo;
    if v_carpeta is null or not public.puede_subir_a_carpeta(v_carpeta) then
        raise exception 'Sin permiso para organizar los documentos de esta carpeta.' using errcode = '42501';
    end if;
    -- El disparador revisa el resto de la regla
    update public.archivos set anexo_de = p_padre where id = p_archivo;
end;
$$;


-- ------------------------------------------------------------
-- 3) Mover a otra subcarpeta (p_subcarpeta null = raíz de la carpeta)
-- ------------------------------------------------------------
create or replace function public.archivo_mover(p_archivo bigint, p_subcarpeta bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_carpeta bigint;
begin
    select carpeta_id into v_carpeta from public.archivos where id = p_archivo;
    if v_carpeta is null or not public.puede_subir_a_carpeta(v_carpeta) then
        raise exception 'Sin permiso para mover los documentos de esta carpeta.' using errcode = '42501';
    end if;
    if p_subcarpeta is not null and not exists (
        select 1 from public.subcarpetas where id = p_subcarpeta and carpeta_id = v_carpeta
    ) then
        raise exception 'Esa subcarpeta no es de esta carpeta.' using errcode = 'check_violation';
    end if;

    -- Primero el documento (un anexo que se muda solo deja de ser anexo)
    -- y después sus anexos, que lo siguen: en ese orden el disparador
    -- encuentra al principal ya en su sitio nuevo.
    update public.archivos set subcarpeta_id = p_subcarpeta, anexo_de = null where id = p_archivo;
    update public.archivos set subcarpeta_id = p_subcarpeta where anexo_de = p_archivo;
end;
$$;


-- ------------------------------------------------------------
-- 4) Permisos
-- ------------------------------------------------------------
revoke execute on function public.validar_anexo() from public, anon, authenticated;
revoke execute on function public.archivo_fijar_anexo(bigint, bigint) from public, anon;
grant  execute on function public.archivo_fijar_anexo(bigint, bigint) to authenticated;
revoke execute on function public.archivo_mover(bigint, bigint) from public, anon;
grant  execute on function public.archivo_mover(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- authenticated puede las dos funciones; anon ninguna.
select p.proname as funcion,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('archivo_fijar_anexo', 'archivo_mover')
 order by 1;
