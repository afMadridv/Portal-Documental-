-- ============================================================
-- MIGRACIÓN: auth.uid() una vez por consulta, no una por fila
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va ENTERA dentro de una transacción: si algo falla a mitad, no queda
-- ninguna política a medio rehacer.
--
-- QUÉ ARREGLA
--   Una política como
--       using (perfil_id = auth.uid())
--   hace que Postgres llame a auth.uid() UNA VEZ POR CADA FILA que
--   examina. Listar los 1.499 archivos de una carpeta son 1.499
--   llamadas donde cabía una.
--
--   Escrita así
--       using (perfil_id = (select auth.uid()))
--   el planificador la reconoce como subconsulta sin correlación, la
--   evalúa una sola vez antes de empezar (un InitPlan) y reusa el
--   resultado para todas las filas.
--
--   Mismo resultado y misma seguridad: auth.uid() devuelve lo mismo
--   durante toda la consulta, así que calcularlo una vez o mil da
--   idéntica respuesta. Lo único que cambia es cuánto trabaja la base.
--
-- POR QUÉ SE HACE LEYENDO pg_policies Y NO REESCRIBIENDO LOS ARCHIVOS
--   Las políticas están repartidas entre esquema.sql y seis migraciones.
--   Reescribirlas a mano en los archivos deja fuera cualquiera que se
--   haya creado por otro lado, y obliga a acertar cincuenta veces
--   seguidas. Esto lee lo que la base TIENE de verdad, lo reescribe y
--   cuenta lo que tocó.
--
-- QUÉ NO TOCA
--   Los auth.uid() que están dentro de funciones (mi_rol,
--   registrar_actividad, es_admin...). Ahí no hay ganancia: el cuerpo
--   de una función se ejecuta una vez, no una por fila.
-- ============================================================

begin;

-- ---- Antes ----
do $$
declare
    n int;
begin
    select count(*) into n
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ 'auth\.uid\(\)' or coalesce(with_check, '') ~ 'auth\.uid\(\)');
    raise notice 'Políticas con auth.uid(): %', n;
end $$;


do $$
declare
    p            record;
    v_using      text;
    v_check      text;
    v_roles      text;
    v_sql        text;
    v_tocadas    int := 0;
    v_saltadas   int := 0;
begin
    -- El regexp_replace de abajo deja el texto en su forma cruda antes
    -- de envolverlo: deshace un (select auth.uid()) que ya estuviera
    -- puesto, para no acabar con (select (select ...)) al correr esta
    -- migración dos veces. Postgres devuelve la subconsulta deparseada
    -- como «( SELECT auth.uid() AS uid)», de ahí el AS opcional.
    for p in
        select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_policies
        where schemaname = 'public'
          and (coalesce(qual, '') ~ 'auth\.uid\(\)' or coalesce(with_check, '') ~ 'auth\.uid\(\)')
        order by tablename, policyname
    loop
        v_using := p.qual;
        v_check := p.with_check;

        if v_using is not null then
            v_using := regexp_replace(v_using, '\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+\w+)?\s*\)', 'auth.uid()', 'gi');
            v_using := replace(v_using, 'auth.uid()', '(select auth.uid())');
        end if;
        if v_check is not null then
            v_check := regexp_replace(v_check, '\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+\w+)?\s*\)', 'auth.uid()', 'gi');
            v_check := replace(v_check, 'auth.uid()', '(select auth.uid())');
        end if;

        -- Ya estaba envuelta: no se toca
        if v_using is not distinct from p.qual and v_check is not distinct from p.with_check then
            v_saltadas := v_saltadas + 1;
            continue;
        end if;

        -- PUBLIC es palabra reservada, no un rol: entrecomillarla haría
        -- que Postgres buscara un rol llamado "public", que no existe.
        select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ')
          into v_roles
          from unnest(p.roles) as r;
        v_roles := coalesce(v_roles, 'public');

        execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);

        v_sql := format('create policy %I on %I.%I as %s for %s to %s',
            p.policyname, p.schemaname, p.tablename,
            case when p.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
            lower(p.cmd),
            v_roles);
        if v_using is not null then v_sql := v_sql || format(' using (%s)', v_using); end if;
        if v_check is not null then v_sql := v_sql || format(' with check (%s)', v_check); end if;

        execute v_sql;
        v_tocadas := v_tocadas + 1;
    end loop;

    raise notice 'Reescritas: %   ya estaban: %', v_tocadas, v_saltadas;
end $$;


-- ---- Después: si queda alguna suelta, se deshace todo ----
-- Una migración que arregla "casi todas" es peor que no correrla: deja
-- creyendo que el trabajo está hecho.
do $$
declare
    n int := 0;
    r record;
begin
    -- Suelta = nombra auth.uid() y NO tiene ningún (select auth.uid()).
    -- Se mira `qual` y `with_check` por separado: una política puede
    -- traer los dos y basta con que uno quede crudo.
    for r in
        select tablename, policyname from pg_policies
        where schemaname = 'public'
          and (   (coalesce(qual, '')       ~ 'auth\.uid\(\)'
               and coalesce(qual, '')      !~ '\(\s*SELECT\s+auth\.uid')
               or (coalesce(with_check, '') ~ 'auth\.uid\(\)'
               and coalesce(with_check, '')!~ '\(\s*SELECT\s+auth\.uid'))
    loop
        raise warning 'sin envolver: %.%', r.tablename, r.policyname;
        n := coalesce(n, 0) + 1;
    end loop;

    if coalesce(n, 0) > 0 then
        raise exception 'Quedaron % política(s) sin envolver; se deshace todo.', n;
    end if;

    raise notice 'Todas las políticas evalúan auth.uid() una vez por consulta.';
end $$;

commit;


-- ============================================================
-- COMPROBACIÓN (se puede correr cuando se quiera, solo lee)
-- ============================================================
-- Debe devolver cero filas.
--
--   select tablename, policyname
--   from pg_policies
--   where schemaname = 'public'
--     and (coalesce(qual,'') ~ 'auth\.uid\(\)' or coalesce(with_check,'') ~ 'auth\.uid\(\)')
--     and (coalesce(qual,'') !~ '\(\s*SELECT\s+auth\.uid'
--          and coalesce(with_check,'') !~ '\(\s*SELECT\s+auth\.uid');
--
-- Y para ver el efecto, sobre una carpeta con muchos archivos:
--
--   explain (analyze, buffers)
--   select * from public.archivos where carpeta_id = <id>;
--
-- Antes aparece auth.uid() dentro del Filter de cada fila; después
-- aparece una línea «InitPlan 1» arriba y el filtro usa su resultado.
-- ============================================================
