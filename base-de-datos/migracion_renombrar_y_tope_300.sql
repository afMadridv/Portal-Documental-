-- ============================================================
-- MIGRACIÓN: renombrar documentos y tope de 300 MB por archivo
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. archivo_renombrar(): el administrador y el operador responsable
--      de la carpeta le cambian el nombre a un documento, audio o video.
--      Solo cambia el nombre que se ve (y con el que se descarga): el
--      binario sigue en la misma ruta del bucket, así que no se mueve
--      nada en Storage. La extensión no se puede cambiar, porque de ella
--      dependen la vista previa y qué subcarpeta admite el archivo.
--      La tabla no tiene política de UPDATE: se hace solo por aquí.
--
--   2. El bucket pasa de 500 a 300 MB por archivo. Un video de 100 MB
--      se rechazaba con «The object exceeded the maximum allowed size»:
--      el portal decía 500 pero el servidor cortaba antes (el
--      FILE_SIZE_LIMIT del contenedor de Storage viene en 50 MB en el
--      docker-compose.yml de Supabase si no se cambia ahí mismo).
--      Los tres límites quedan en 300 MB: este bucket, el límite global
--      de Storage y TAMANO_MAXIMO en js/app.js.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Renombrar
-- ------------------------------------------------------------
create or replace function public.archivo_renombrar(p_archivo bigint, p_nombre text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_carpeta bigint;
    v_actual  text;
    v_nuevo   text;
    v_ext     text;
begin
    select carpeta_id, nombre into v_carpeta, v_actual from public.archivos where id = p_archivo;
    if v_carpeta is null or not public.puede_subir_a_carpeta(v_carpeta) then
        raise exception 'Sin permiso para renombrar los documentos de esta carpeta.' using errcode = '42501';
    end if;

    -- Sin caracteres de control ni barras, espacios juntos, hasta 200
    v_nuevo := regexp_replace(coalesce(p_nombre, ''), '[[:cntrl:]/\\]+', ' ', 'g');
    v_nuevo := btrim(regexp_replace(v_nuevo, '\s+', ' ', 'g'));

    -- La extensión se conserva: si no la trae, se le pone la de antes
    v_ext := lower(substring(v_actual from '\.([^.]+)$'));
    if v_ext is not null and lower(coalesce(substring(v_nuevo from '\.([^.]+)$'), '')) <> v_ext then
        v_nuevo := btrim(v_nuevo, ' .') || '.' || v_ext;
    end if;

    if v_nuevo = '' or v_nuevo = '.' || coalesce(v_ext, '') then
        raise exception 'El documento necesita un nombre.' using errcode = 'check_violation';
    end if;
    if char_length(v_nuevo) > 200 then
        raise exception 'El nombre es muy largo (máximo 200 caracteres).' using errcode = 'check_violation';
    end if;

    update public.archivos set nombre = v_nuevo where id = p_archivo;
    return v_nuevo;
end;
$$;

revoke execute on function public.archivo_renombrar(bigint, text) from public, anon;
grant  execute on function public.archivo_renombrar(bigint, text) to authenticated;


-- ------------------------------------------------------------
-- 2) 300 MB por archivo
-- ------------------------------------------------------------
update storage.buckets
   set file_size_limit = 314572800          -- 300 MB
 where id = 'documentos';

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- 314572800, y authenticated sí / anon no.
select id, file_size_limit from storage.buckets where id = 'documentos';
select has_function_privilege('authenticated', 'public.archivo_renombrar(bigint, text)', 'execute') as authenticated_puede,
       has_function_privilege('anon',          'public.archivo_renombrar(bigint, text)', 'execute') as anon_puede;
