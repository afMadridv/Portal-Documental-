-- ============================================================
-- MIGRACIÓN: el monitor sale de las conversaciones
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ CAMBIA
--   El monitor tenía permiso de lectura sobre los mensajes del chat de
--   la carpeta y sobre sus adjuntos. Deja de tenerlo.
--
-- POR QUÉ NO BASTABA CON QUITARLO DE LA INTERFAZ
--   Esconder el chat en app.js no revoca nada: el permiso seguiría
--   concedido y cualquiera con una sesión de monitor podría leer las
--   conversaciones llamando a la API por su cuenta, sin pasar por el
--   portal. Una restricción que solo vive en el navegador no es una
--   restricción, es una sugerencia.
--
-- QUÉ SIGUE VIENDO EL MONITOR
--   Todo lo que necesita para supervisar: carpetas, plazos, estados,
--   perfiles, asignaciones, actividad, información del deudor y el
--   almacenamiento. Lo que pierde son las conversaciones entre el
--   operador y las partes, que son otra cosa.
-- ============================================================

drop policy if exists "monitor ve mensajes" on public.mensajes;
drop policy if exists "monitor descarga adjuntos de chat" on storage.objects;


-- ------------------------------------------------------------
-- Comprobación: si queda alguna, se dice
-- ------------------------------------------------------------
do $$
declare n int;
begin
    select count(*) into n
    from pg_policies
    where policyname in ('monitor ve mensajes', 'monitor descarga adjuntos de chat');

    if n > 0 then
        raise exception 'Quedaron % política(s) de chat para el monitor', n;
    end if;
    raise notice 'El monitor ya no tiene lectura sobre los chats ni sus adjuntos.';
end $$;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- Debe devolver cero filas:
--
--   select tablename, policyname from pg_policies
--    where policyname ilike '%monitor%'
--      and (tablename = 'mensajes' or tablename = 'objects');
--
-- Y las que SÍ debe conservar:
--
--   select tablename, policyname from pg_policies
--    where policyname ilike '%monitor%' order by tablename;
-- ============================================================
