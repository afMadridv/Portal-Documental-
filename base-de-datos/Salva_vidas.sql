-- ============================================================
-- SALVA_VIDAS.sql
-- La estructura completa de la base del Portal Documental, en un solo
-- archivo.
-- ============================================================
-- NO SE EDITA A MANO. Lo arma armar_salva_vidas.mjs con los archivos de
-- esta carpeta. Para cambiar la base se escribe una migración nueva, se
-- agrega a la tabla de base-de-datos/LEEME.md y se vuelve a armar:
--     node base-de-datos/armar_salva_vidas.mjs
--
-- QUÉ TRAE
--   Todo lo que hace falta para que el portal funcione en un Supabase
--   nuevo: las tablas y sus columnas, los índices, las funciones, los
--   permisos de cada rol (RLS), los disparadores, el bucket de los
--   documentos, la tarea diaria de los plazos y los festivos hasta 2030.
--   Son las 31 partes de abajo, en orden.
--
-- QUÉ NO TRAE: LOS DATOS
--   Usuarios, notarías, carpetas, documentos, mensajes y cifras no van
--   aquí, ni en git: son datos personales de expedientes judiciales,
--   y la tabla de credenciales guarda contraseñas. De esos se encargan
--   los respaldos de la base.
--
-- CUÁNDO SE USA
--   Sobre un Supabase recién creado y vacío. Deja el portal listo para
--   crear el primer administrador (base-de-datos/LEEME.md).
--
-- CÓMO
--   psql "<cadena de conexión>" -v ON_ERROR_STOP=1 -f Salva_vidas.sql
--
--   ON_ERROR_STOP=1 corta en el primer error: si algo falla, se lee la
--   PARTE donde se detuvo y se resuelve antes de seguir. Cada parte va
--   en su propia transacción, así que lo que ya pasó queda bien hecho.
--
-- Partes: 31    Huella: 78a15b97967f61e9
-- ============================================================


-- ############################################################
-- PARTE 1 DE 31: esquema.sql
-- Las tablas, funciones, políticas, el bucket y la publicación de Realtime
-- ############################################################

-- ============================================================
-- PORTAL DOCUMENTAL: base de datos PostgreSQL

-- TABLAS
-- ============================================================

-- Perfil de cada usuario (complementa auth.users de Supabase)
create table if not exists public.perfiles (
    id      uuid primary key references auth.users (id) on delete cascade,
    usuario text not null unique,
    nombre  text not null,
    rol     text not null default 'cliente'
            check (rol in ('administrador', 'operador', 'cliente', 'acreedor')),
    activo  boolean not null default true,
    correo  text,                          -- correo de contacto (opcional), para avisos
    creado  timestamptz not null default now()
);

-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.perfiles add column if not exists correo text;

-- Carpetas de procesos
create table if not exists public.carpetas (
    id          bigint generated always as identity primary key,
    nombre      text not null,
    descripcion text not null default '',
    activa      boolean not null default true,
    creada_por  uuid references public.perfiles (id) on delete set null,
    fecha       timestamptz not null default now()
);

-- Qué cliente/acreedor puede ver qué carpeta
create table if not exists public.carpeta_asignados (
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    primary key (carpeta_id, perfil_id)
);

-- Qué operador es responsable de qué carpeta (el operador SOLO
-- ve y trabaja las carpetas donde aparece aquí)
create table if not exists public.carpeta_operadores (
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    primary key (carpeta_id, perfil_id)
);

-- Metadatos de cada archivo (el archivo físico vive en Storage)
create table if not exists public.archivos (
    id                 bigint generated always as identity primary key,
    carpeta_id         bigint not null references public.carpetas (id) on delete cascade,
    nombre             text not null,
    tipo               text not null default '',
    tamano             bigint not null default 0,
    ruta_storage       text not null,      -- convención: <id-carpeta>/<nombre-archivo>
    subido_por         uuid references public.perfiles (id) on delete set null,
    subido_por_usuario text not null default '',  -- nombre visible del actor, para mostrarlo sin exponer perfiles
    fecha              timestamptz not null default now()
);

-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.archivos add column if not exists subido_por_usuario text not null default '';

-- Orden manual de los documentos dentro de la carpeta ("Editar documentos"
-- y "Generar expediente"): menor número = más arriba. NULL = sin ordenar
-- (se muestra por fecha). Solo se cambia por la función
-- actualizar_orden_archivos (más abajo), nunca por update directo.
alter table public.archivos add column if not exists orden integer;

-- Bitácora de actividad (centro de notificaciones del administrador):
-- registra ingresos y toda acción sobre carpetas y archivos.
create table if not exists public.actividad (
    id        bigint generated always as identity primary key,
    perfil_id uuid references public.perfiles (id) on delete set null,
    usuario   text not null default '',   -- snapshot del actor
    nombre    text not null default '',
    rol       text not null default '',
    accion    text not null,
    objetivo  text not null default '',
    fecha     timestamptz not null default now()
);

-- Carpeta a la que pertenece la acción (si aplica): permite que el operador
-- vea las notificaciones de SU carpeta (ingresos, vistas y descargas de las
-- partes del trámite) sin acceder a la bitácora global del administrador.
alter table public.actividad add column if not exists carpeta_id bigint references public.carpetas (id) on delete set null;

-- Mensajería del trámite por carpeta. Dos canales:
--   'cliente'  → conversación cliente ↔ operador
--   'acreedor' → conversación acreedor ↔ operador
-- El administrador ve y escribe en ambos; el cliente solo en el suyo y el
-- acreedor solo en el suyo (validado por RLS más abajo).
create table if not exists public.mensajes (
    id            bigint generated always as identity primary key,
    carpeta_id    bigint not null references public.carpetas (id) on delete cascade,
    canal         text not null check (canal in ('cliente', 'acreedor')),
    perfil_id     uuid references public.perfiles (id) on delete set null,
    autor_usuario text not null default '',   -- snapshot del actor
    autor_nombre  text not null default '',
    rol           text not null default '',
    texto         text not null,
    fecha         timestamptz not null default now()
);

-- Adjuntos en el chat: un mensaje puede llevar un archivo (el contenido vive
-- en Storage bajo 'chat/<id-carpeta>/<canal>/...'; aquí solo los metadatos).
-- (por si la tabla ya existía de una versión anterior del esquema)
alter table public.mensajes add column if not exists archivo_nombre text not null default '';
alter table public.mensajes add column if not exists archivo_ruta   text not null default '';
alter table public.mensajes add column if not exists archivo_tamano bigint not null default 0;
alter table public.mensajes add column if not exists archivo_tipo   text not null default '';

-- Audiencias del proceso: fechas marcadas por el operador en el calendario
-- de la carpeta. Las gestionan el administrador y el operador responsable;
-- las VEN también el deudor y los acreedores de la carpeta (calendario del
-- trámite) y además se pueden notificar por correo.
create table if not exists public.audiencias (
    id         bigint generated always as identity primary key,
    carpeta_id bigint not null references public.carpetas (id) on delete cascade,
    titulo     text not null default '',
    fecha      date not null,
    hora       text not null default '',   -- 'HH:MM' (texto simple, lo pone el operador)
    enlace     text not null default '',   -- link de Meet (opcional)
    creado_por uuid references public.perfiles (id) on delete set null,
    creado     timestamptz not null default now()
);

-- Recordatorios personales por carpeta: SOLO los ve quien los crea.
-- Mientras la fecha de hoy esté dentro del rango, el portal muestra la
-- ventana emergente al ingresar.
create table if not exists public.recordatorios (
    id           bigint generated always as identity primary key,
    perfil_id    uuid not null references public.perfiles (id) on delete cascade,
    carpeta_id   bigint not null references public.carpetas (id) on delete cascade,
    mensaje      text not null,
    fecha_inicio date not null,
    fecha_fin    date not null,
    creado       timestamptz not null default now()
);

-- Información del deudor y su apoderado (INF. DEUDOR, Ley 2445 de 2025).
-- Una sola fila por carpeta. Acceso por dos capas (ver RLS más abajo):
-- admin y operador responsable leen/escriben; el cliente asignado SOLO lee
-- la suya; el acreedor NO accede bajo ninguna circunstancia (ni lectura).
create table if not exists public.deudores_info (
    id           bigint generated always as identity primary key,
    carpeta_id   bigint not null references public.carpetas (id) on delete cascade unique,
    nombre       text not null default '',
    cedula       text not null default '',
    actividad    text not null default '',
    empleador    text not null default '',
    estado_civil text not null default '',
    correo       text not null default '',
    apoderado_nombre text not null default '',
    apoderado_cedula text not null default '',
    apoderado_tp     text not null default '',
    apoderado_correo text not null default '',
    actualizado  timestamptz not null default now()
);

create index if not exists idx_archivos_carpeta on public.archivos (carpeta_id);
create index if not exists idx_asignados_perfil on public.carpeta_asignados (perfil_id);
create index if not exists idx_operadores_perfil on public.carpeta_operadores (perfil_id);
create index if not exists idx_actividad_fecha on public.actividad (fecha desc);
create index if not exists idx_actividad_rol on public.actividad (rol);
create index if not exists idx_mensajes_carpeta on public.mensajes (carpeta_id, canal, fecha);
create index if not exists idx_actividad_carpeta on public.actividad (carpeta_id, fecha desc);
create index if not exists idx_audiencias_carpeta on public.audiencias (carpeta_id, fecha);
create index if not exists idx_recordatorios_perfil on public.recordatorios (perfil_id, fecha_fin);

-- ============================================================
-- 2) PERFIL AUTOMÁTICO AL REGISTRAR UN USUARIO
--    Seguridad: el rol NUNCA viene del registro (nadie puede
--    auto-nombrarse administrador). El PRIMER usuario creado
--    queda como administrador; los demás nacen como 'cliente'
--    y el administrador les asigna su rol (el portal lo hace
--    automáticamente al crearlos).
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
    insert into public.perfiles (id, usuario, nombre, rol)
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'usuario', split_part(new.email, '@', 1)),
        coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)),
        case when total = 0 then 'administrador' else 'cliente' end
    );
    return new;
end;
$$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
    after insert on auth.users
    for each row execute function public.crear_perfil_nuevo();

-- Protección en el servidor: nunca dejar el portal sin un administrador
-- activo. Bloquea eliminar, desactivar o quitarle el rol al último admin,
-- incluso si alguien lo intentara por API saltándose la interfaz.
create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    otros_admins integer;
begin
    if OLD.rol = 'administrador' and OLD.activo
       and not (TG_OP = 'UPDATE' and NEW.rol = 'administrador' and NEW.activo) then
        select count(*) into otros_admins
        from public.perfiles
        where rol = 'administrador' and activo and id <> OLD.id;
        if otros_admins = 0 then
            raise exception 'No se puede dejar el portal sin ningún administrador activo';
        end if;
    end if;
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
end;
$$;

drop trigger if exists proteger_admin on public.perfiles;
create trigger proteger_admin
    before update or delete on public.perfiles
    for each row execute function public.proteger_ultimo_admin();

-- ============================================================
-- 3) FUNCIONES DE APOYO (qué rol tiene quien está conectado)
--    Un usuario DESACTIVADO no tiene rol → pierde todo acceso.
-- ============================================================
create or replace function public.rol_actual()
returns text
language sql stable security definer set search_path = public
as $$
    select rol from public.perfiles where id = auth.uid() and activo;
$$;

create or replace function public.es_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'administrador';
$$;

create or replace function public.es_personal()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() in ('administrador', 'operador');
$$;

-- ¿Es el usuario conectado operador responsable de esta carpeta?
-- Solo cuenta si la carpeta está ACTIVA: si el administrador la desactiva,
-- el operador deja de verla, subir, eliminar y actualizar su estado, hasta
-- que se vuelva a activar.
create or replace function public.es_operador_de(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'operador'
       and exists (
            select 1
            from public.carpeta_operadores o
            join public.carpetas c on c.id = o.carpeta_id
            where o.carpeta_id = carpeta
              and o.perfil_id = auth.uid()
              and c.activa
       );
$$;

-- ¿Puede el usuario conectado ver esta carpeta?
-- admin → todas · operador → solo las suyas · cliente/acreedor → asignadas y activas
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or public.es_operador_de(carpeta)
        or exists (
            select 1
            from public.carpetas c
            join public.carpeta_asignados a on a.carpeta_id = c.id
            where c.id = carpeta
              and c.activa
              and a.perfil_id = auth.uid()
              and public.rol_actual() is not null
        );
$$;

-- ¿Puede subir archivos a esta carpeta? (admin, o el operador responsable)
create or replace function public.puede_subir_a_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin() or public.es_operador_de(carpeta);
$$;

-- ¿El usuario conectado está asignado a esta carpeta ACTIVA con alguno de
-- estos roles? (sirve para los chats: cliente o acreedor de la carpeta)
create or replace function public.es_asignado_de(carpeta bigint, roles text[])
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = any(roles)
       and exists (
            select 1
            from public.carpeta_asignados a
            join public.carpetas c on c.id = a.carpeta_id
            where a.carpeta_id = carpeta
              and a.perfil_id = auth.uid()
              and c.activa
       );
$$;

-- ¿Puede el usuario conectado ver/escribir en este canal de chat de la carpeta?
--   admin            → ambos canales
--   operador resp.   → ambos canales
--   cliente asignado → solo el canal 'cliente'
--   acreedor asignado→ solo el canal 'acreedor'
create or replace function public.puede_chat(carpeta bigint, canal_chat text)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or public.es_operador_de(carpeta)
        or (canal_chat = 'cliente'  and public.es_asignado_de(carpeta, array['cliente']))
        or (canal_chat = 'acreedor' and public.es_asignado_de(carpeta, array['acreedor']));
$$;

-- Actualiza SOLO la descripción (estado del trámite) de una carpeta.
-- La puede usar el admin o el operador responsable; ninguna otra
-- columna se puede tocar por esta vía.
create or replace function public.actualizar_descripcion(carpeta bigint, nueva_descripcion text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para actualizar esta carpeta';
    end if;
    update public.carpetas
       set descripcion = coalesce(nueva_descripcion, '')
     where id = carpeta;
end;
$$;


-- Registra una acción en la bitácora. El actor (usuario/nombre/rol) se
-- toma del servidor según auth.uid(), así NO se puede falsificar quién hizo qué.
-- p_carpeta (opcional) vincula la acción a una carpeta, para que el operador
-- responsable pueda ver la actividad de SUS procesos.
-- (se elimina la firma anterior de 2 parámetros para que la llamada RPC no sea ambigua)
drop function if exists public.registrar_actividad(text, text);
create or replace function public.registrar_actividad(p_accion text, p_objetivo text, p_carpeta bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    perfil record;
begin
    select usuario, nombre, rol into perfil
    from public.perfiles where id = auth.uid() and activo;
    if not found then return; end if;
    insert into public.actividad (perfil_id, usuario, nombre, rol, accion, objetivo, carpeta_id)
    values (auth.uid(), perfil.usuario, perfil.nombre, perfil.rol,
            left(coalesce(p_accion, ''), 40), left(coalesce(p_objetivo, ''), 300), p_carpeta);
end;
$$;

-- Guarda el orden manual de los documentos de una carpeta. Recibe los ids
-- en el orden deseado y numera desde 1. SOLO toca la columna 'orden' y SOLO
-- de archivos de esa carpeta; la puede usar el admin o el operador responsable.
create or replace function public.actualizar_orden_archivos(carpeta bigint, ids bigint[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para ordenar los documentos de esta carpeta';
    end if;
    update public.archivos a
       set orden = pos.n
      from unnest(ids) with ordinality as pos(id_archivo, n)
     where a.id = pos.id_archivo
       and a.carpeta_id = carpeta;
end;
$$;

-- Devuelve las personas asignadas a una carpeta (deudor/cliente y acreedores)
-- con su id y correo de contacto: para la notificación de audiencias y para
-- dirigir mensajes a UN acreedor. Solo la usa el personal de la carpeta.
-- (el DROP es necesario: una versión anterior devolvía otras columnas y
--  Postgres no permite cambiar el tipo de retorno con create or replace)
drop function if exists public.asignados_de_carpeta(bigint);
create or replace function public.asignados_de_carpeta(carpeta bigint)
returns table (id uuid, usuario text, nombre text, rol text, correo text)
language plpgsql stable security definer set search_path = public
as $$
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para consultar los asignados de esta carpeta';
    end if;
    return query
        select p.id, p.usuario, p.nombre, p.rol, coalesce(p.correo, '')
        from public.carpeta_asignados a
        join public.perfiles p on p.id = a.perfil_id
        where a.carpeta_id = carpeta and p.activo
        order by p.rol, p.nombre;
end;
$$;

-- Saca el id de carpeta de una ruta de Storage '<id-carpeta>/archivo.pdf'
create or replace function public.carpeta_de_ruta(ruta text)
returns bigint
language plpgsql immutable
as $$
begin
    return ((string_to_array(ruta, '/'))[1])::bigint;
exception when others then
    return null;
end;
$$;

-- Rutas de adjuntos de chat: 'chat/<id-carpeta>/<canal>/archivo.pdf'
create or replace function public.chat_carpeta_de_ruta(ruta text)
returns bigint
language plpgsql immutable
as $$
begin
    return (split_part(ruta, '/', 2))::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_canal_de_ruta(ruta text)
returns text
language plpgsql immutable
as $$
begin
    return split_part(ruta, '/', 3);
exception when others then
    return null;
end;
$$;

-- El servidor fija la fecha de actualización de deudores_info (no se confía
-- en la hora del navegador).
create or replace function public.tocar_actualizado()
returns trigger
language plpgsql
as $$
begin
    new.actualizado := now();
    return new;
end;
$$;

drop trigger if exists deudores_tocar_actualizado on public.deudores_info;
create trigger deudores_tocar_actualizado
    before update on public.deudores_info
    for each row execute function public.tocar_actualizado();

-- ============================================================
-- 4) SEGURIDAD POR FILAS (RLS)
--    Cada consulta se filtra EN EL SERVIDOR según el rol;
--    nadie puede saltársela desde el navegador.
-- ============================================================
alter table public.perfiles           enable row level security;
alter table public.carpetas           enable row level security;
alter table public.carpeta_asignados  enable row level security;
alter table public.carpeta_operadores enable row level security;
alter table public.archivos           enable row level security;
alter table public.actividad          enable row level security;
alter table public.mensajes           enable row level security;
alter table public.deudores_info      enable row level security;
alter table public.audiencias         enable row level security;
alter table public.recordatorios      enable row level security;

-- Limpieza de reglas de versiones anteriores (cuando el operador veía todo)
drop policy if exists "personal ve todas las carpetas" on public.carpetas;
drop policy if exists "personal sube archivos" on public.archivos;
drop policy if exists "personal sube documentos" on storage.objects;

-- PERFILES
drop policy if exists "ver mi propio perfil" on public.perfiles;
create policy "ver mi propio perfil" on public.perfiles
    for select using (id = auth.uid());

drop policy if exists "admin ve todos los perfiles" on public.perfiles;
create policy "admin ve todos los perfiles" on public.perfiles
    for select using (public.es_admin());

drop policy if exists "admin actualiza perfiles" on public.perfiles;
create policy "admin actualiza perfiles" on public.perfiles
    for update using (public.es_admin()) with check (public.es_admin());

drop policy if exists "admin elimina perfiles" on public.perfiles;
create policy "admin elimina perfiles" on public.perfiles
    for delete using (public.es_admin());

-- CARPETAS
drop policy if exists "admin ve todas las carpetas" on public.carpetas;
create policy "admin ve todas las carpetas" on public.carpetas
    for select using (public.es_admin());

drop policy if exists "operador ve sus carpetas" on public.carpetas;
create policy "operador ve sus carpetas" on public.carpetas
    for select using (public.es_operador_de(id));

drop policy if exists "asignados ven sus carpetas activas" on public.carpetas;
create policy "asignados ven sus carpetas activas" on public.carpetas
    for select using (
        activa
        and public.rol_actual() is not null
        and exists (
            select 1 from public.carpeta_asignados a
            where a.carpeta_id = id and a.perfil_id = auth.uid()
        )
    );

drop policy if exists "admin crea carpetas" on public.carpetas;
create policy "admin crea carpetas" on public.carpetas
    for insert with check (public.es_admin());

drop policy if exists "admin edita carpetas" on public.carpetas;
create policy "admin edita carpetas" on public.carpetas
    for update using (public.es_admin()) with check (public.es_admin());

drop policy if exists "admin elimina carpetas" on public.carpetas;
create policy "admin elimina carpetas" on public.carpetas
    for delete using (public.es_admin());

-- ASIGNACIONES (clientes/acreedores que ven la carpeta)
drop policy if exists "ver asignaciones propias o del personal" on public.carpeta_asignados;
create policy "ver asignaciones propias o del personal" on public.carpeta_asignados
    for select using (
        public.es_admin()
        or perfil_id = auth.uid()
        or public.es_operador_de(carpeta_id)
    );

drop policy if exists "admin gestiona asignaciones" on public.carpeta_asignados;
create policy "admin gestiona asignaciones" on public.carpeta_asignados
    for all using (public.es_admin()) with check (public.es_admin());

-- OPERADORES RESPONSABLES de cada carpeta
drop policy if exists "ver operadores propios o admin" on public.carpeta_operadores;
create policy "ver operadores propios o admin" on public.carpeta_operadores
    for select using (public.es_admin() or perfil_id = auth.uid());

drop policy if exists "admin gestiona operadores" on public.carpeta_operadores;
create policy "admin gestiona operadores" on public.carpeta_operadores
    for all using (public.es_admin()) with check (public.es_admin());

-- ARCHIVOS (metadatos)
drop policy if exists "ver archivos segun carpeta" on public.archivos;
create policy "ver archivos segun carpeta" on public.archivos
    for select using (public.puede_ver_carpeta(carpeta_id));

drop policy if exists "sube admin u operador de la carpeta" on public.archivos;
create policy "sube admin u operador de la carpeta" on public.archivos
    for insert with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "admin elimina archivos" on public.archivos;
drop policy if exists "elimina admin u operador de la carpeta" on public.archivos;
create policy "elimina admin u operador de la carpeta" on public.archivos
    for delete using (public.puede_subir_a_carpeta(carpeta_id));

-- ACTIVIDAD (bitácora): el administrador lee todo; el operador SOLO la
-- actividad vinculada a sus carpetas (notificaciones del trámite). Se escribe
-- únicamente por la función registrar_actividad (no hay política de insert directo).
drop policy if exists "admin ve actividad" on public.actividad;
create policy "admin ve actividad" on public.actividad
    for select using (public.es_admin());

drop policy if exists "operador ve actividad de sus carpetas" on public.actividad;
create policy "operador ve actividad de sus carpetas" on public.actividad
    for select using (carpeta_id is not null and public.es_operador_de(carpeta_id));

-- AUDIENCIAS: las VEN todos los de la carpeta (deudor y acreedores incluidos,
-- para el calendario del trámite); solo el personal (admin u operador
-- responsable) las crea, edita o elimina.
drop policy if exists "personal ve audiencias" on public.audiencias;
drop policy if exists "ven audiencias los de la carpeta" on public.audiencias;
create policy "ven audiencias los de la carpeta" on public.audiencias
    for select using (public.puede_ver_carpeta(carpeta_id));

drop policy if exists "personal gestiona audiencias" on public.audiencias;
create policy "personal gestiona audiencias" on public.audiencias
    for all using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

-- RECORDATORIOS: privados. Cada quien ve, crea, edita y borra SOLO los suyos
-- (y debe ser personal con acceso de gestión a la carpeta al crearlos).
drop policy if exists "recordatorios propios" on public.recordatorios;
create policy "recordatorios propios" on public.recordatorios
    for select using (perfil_id = auth.uid());

drop policy if exists "crear recordatorio propio" on public.recordatorios;
create policy "crear recordatorio propio" on public.recordatorios
    for insert with check (perfil_id = auth.uid() and public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "editar recordatorio propio" on public.recordatorios;
create policy "editar recordatorio propio" on public.recordatorios
    for update using (perfil_id = auth.uid()) with check (perfil_id = auth.uid());

drop policy if exists "borrar recordatorio propio" on public.recordatorios;
create policy "borrar recordatorio propio" on public.recordatorios
    for delete using (perfil_id = auth.uid());

-- MENSAJES (chats del trámite): cada quien ve y escribe SOLO en el canal que
-- le corresponde (cliente o acreedor); el operador responsable y el
-- administrador acceden a ambos. Todo validado EN EL SERVIDOR.
drop policy if exists "ver mensajes del canal" on public.mensajes;
create policy "ver mensajes del canal" on public.mensajes
    for select using (public.puede_chat(carpeta_id, canal));

drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (public.puede_chat(carpeta_id, canal));

drop policy if exists "admin borra mensajes" on public.mensajes;
create policy "admin borra mensajes" on public.mensajes
    for delete using (public.es_admin());

-- INFO DEUDOR (deudores_info): dos capas de acceso. OJO: NO se usa
-- puede_ver_carpeta porque esa función también deja pasar al acreedor.
--   admin                 → lee y escribe todo
--   operador responsable  → lee y escribe la de su carpeta
--   cliente asignado      → SOLO lee la de su propia carpeta
--   acreedor              → SIN acceso (ni lectura): no aparece en ninguna regla
drop policy if exists "ver info deudor" on public.deudores_info;
create policy "ver info deudor" on public.deudores_info
    for select using (
        public.es_admin()
        or public.es_operador_de(carpeta_id)
        or public.es_asignado_de(carpeta_id, array['cliente'])
    );

drop policy if exists "crea info deudor admin u operador" on public.deudores_info;
create policy "crea info deudor admin u operador" on public.deudores_info
    for insert with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "edita info deudor admin u operador" on public.deudores_info;
create policy "edita info deudor admin u operador" on public.deudores_info
    for update using (public.puede_subir_a_carpeta(carpeta_id))
            with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "admin borra info deudor" on public.deudores_info;
create policy "admin borra info deudor" on public.deudores_info
    for delete using (public.es_admin());

-- ============================================================
-- 5) STORAGE: bucket privado para los documentos
--    Convención de rutas: <id-carpeta>/<nombre-archivo>
-- ============================================================
insert into storage.buckets (id, name, public)
values ('documentos', 'documentos', false)
on conflict (id) do nothing;

-- Límite por archivo. El navegador valida contra el MISMO número
-- (TAMANO_MAXIMO en app.js): si no coinciden, o se sube algo que Storage
-- rechaza al final, o se prohíbe algo que sí cabía.
-- 500 MB para que quepan las grabaciones de audiencias.
update storage.buckets set file_size_limit = 524288000 where id = 'documentos';

drop policy if exists "sube documentos admin u operador" on storage.objects;
create policy "sube documentos admin u operador" on storage.objects
    for insert with check (
        bucket_id = 'documentos'
        and public.puede_subir_a_carpeta(public.carpeta_de_ruta(name))
    );

drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_ver_carpeta(public.carpeta_de_ruta(name))
    );

drop policy if exists "admin borra documentos" on storage.objects;
drop policy if exists "borra documentos admin u operador" on storage.objects;
create policy "borra documentos admin u operador" on storage.objects
    for delete using (
        bucket_id = 'documentos'
        and public.puede_subir_a_carpeta(public.carpeta_de_ruta(name))
    );

-- ADJUNTOS DE CHAT ('chat/<id-carpeta>/<canal>/...'): puede subir y descargar
-- quien puede escribir en ese canal (cliente en el suyo, acreedor en el suyo,
-- operador responsable y admin en ambos). Es la misma regla puede_chat de los
-- mensajes. carpeta_de_ruta devuelve null para 'chat/...', así que las
-- políticas de documentos de carpeta no aplican a estas rutas.
drop policy if exists "chat sube adjuntos" on storage.objects;
create policy "chat sube adjuntos" on storage.objects
    for insert with check (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.puede_chat(public.chat_carpeta_de_ruta(name), public.chat_canal_de_ruta(name))
    );

drop policy if exists "chat descarga adjuntos" on storage.objects;
create policy "chat descarga adjuntos" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.puede_chat(public.chat_carpeta_de_ruta(name), public.chat_canal_de_ruta(name))
    );

drop policy if exists "admin borra adjuntos de chat" on storage.objects;
create policy "admin borra adjuntos de chat" on storage.objects
    for delete using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.es_admin()
    );

-- ============================================================
-- 6) ROL MONITOR (solo lectura global)
--    Igual al administrador pero SIN editar ni eliminar nada y
--    SIN acceso a la pestaña de usuarios del portal (aunque sí
--    lee los perfiles para mostrar nombres en las vistas).
-- ============================================================
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('administrador', 'monitor', 'operador', 'cliente', 'acreedor'));

create or replace function public.es_monitor()
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.rol_actual() = 'monitor';
$$;

-- El monitor entra a TODO en modo lectura: se agrega a puede_ver_carpeta
-- (cubre archivos, audiencias y descargas de Storage por las reglas ya creadas).
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or public.es_monitor()
        or public.es_operador_de(carpeta)
        or exists (
            select 1
            from public.carpetas c
            join public.carpeta_asignados a on a.carpeta_id = c.id
            where c.id = carpeta
              and c.activa
              and a.perfil_id = auth.uid()
              and public.rol_actual() is not null
        );
$$;

drop policy if exists "monitor ve todos los perfiles" on public.perfiles;
create policy "monitor ve todos los perfiles" on public.perfiles
    for select using (public.es_monitor());

drop policy if exists "monitor ve todas las carpetas" on public.carpetas;
create policy "monitor ve todas las carpetas" on public.carpetas
    for select using (public.es_monitor());

drop policy if exists "monitor ve asignaciones" on public.carpeta_asignados;
create policy "monitor ve asignaciones" on public.carpeta_asignados
    for select using (public.es_monitor());

drop policy if exists "monitor ve operadores" on public.carpeta_operadores;
create policy "monitor ve operadores" on public.carpeta_operadores
    for select using (public.es_monitor());

drop policy if exists "monitor ve actividad" on public.actividad;
create policy "monitor ve actividad" on public.actividad
    for select using (public.es_monitor());

drop policy if exists "monitor ve mensajes" on public.mensajes;
create policy "monitor ve mensajes" on public.mensajes
    for select using (public.es_monitor());

drop policy if exists "monitor ve info deudor" on public.deudores_info;
create policy "monitor ve info deudor" on public.deudores_info
    for select using (public.es_monitor());

drop policy if exists "monitor descarga adjuntos de chat" on storage.objects;
create policy "monitor descarga adjuntos de chat" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and name like 'chat/%'
        and public.es_monitor()
    );

-- ============================================================
-- 7) SEMÁFOROS DE PROCESOS POR DÍAS HÁBILES COLOMBIANOS
--    Cada carpeta (trámite) tiene procesos con plazo en días
--    hábiles (de lunes a viernes, sin festivos de Colombia). El semáforo:
--      verde   → completado o faltan 2+ días hábiles
--      naranja → hoy es el último día hábil o falta 1
--      rojo    → vencido sin completar
--      pausado → el trámite está en pausa (el reloj se detiene)
--    La MISMA lista de festivos vive en js/diasHabiles.js:
--    si se agrega un año aquí, agregarlo allá.
-- ============================================================

-- Festivos oficiales de Colombia (Ley 51 de 1983)
create table if not exists public.festivos_colombia (
    id     bigint generated always as identity primary key,
    fecha  date not null unique,
    nombre text not null default '',
    anio   int generated always as (extract(year from fecha)::int) stored
);

insert into public.festivos_colombia (fecha, nombre) values
    -- 2024
    ('2024-01-01','Año Nuevo'),('2024-01-08','Reyes Magos'),('2024-03-25','San José'),
    ('2024-03-28','Jueves Santo'),('2024-03-29','Viernes Santo'),('2024-05-01','Día del Trabajo'),
    ('2024-05-13','Ascensión del Señor'),('2024-06-03','Corpus Christi'),('2024-06-10','Sagrado Corazón'),
    ('2024-07-01','San Pedro y San Pablo'),('2024-07-20','Independencia de Colombia'),('2024-08-07','Batalla de Boyacá'),
    ('2024-08-19','Asunción de la Virgen'),('2024-10-14','Día de la Raza'),('2024-11-04','Todos los Santos'),
    ('2024-11-11','Independencia de Cartagena'),('2024-12-08','Inmaculada Concepción'),('2024-12-25','Navidad'),
    -- 2025
    ('2025-01-01','Año Nuevo'),('2025-01-06','Reyes Magos'),('2025-03-24','San José'),
    ('2025-04-17','Jueves Santo'),('2025-04-18','Viernes Santo'),('2025-05-01','Día del Trabajo'),
    ('2025-06-02','Ascensión del Señor'),('2025-06-23','Corpus Christi'),('2025-06-30','Sagrado Corazón / San Pedro y San Pablo'),
    ('2025-07-20','Independencia de Colombia'),('2025-08-07','Batalla de Boyacá'),('2025-08-18','Asunción de la Virgen'),
    ('2025-10-13','Día de la Raza'),('2025-11-03','Todos los Santos'),('2025-11-17','Independencia de Cartagena'),
    ('2025-12-08','Inmaculada Concepción'),('2025-12-25','Navidad'),
    -- 2026
    ('2026-01-01','Año Nuevo'),('2026-01-12','Reyes Magos'),('2026-03-23','San José'),
    ('2026-04-02','Jueves Santo'),('2026-04-03','Viernes Santo'),('2026-05-01','Día del Trabajo'),
    ('2026-05-18','Ascensión del Señor'),('2026-06-08','Corpus Christi'),('2026-06-15','Sagrado Corazón'),
    ('2026-06-29','San Pedro y San Pablo'),('2026-07-20','Independencia de Colombia'),('2026-08-07','Batalla de Boyacá'),
    ('2026-08-17','Asunción de la Virgen'),('2026-10-12','Día de la Raza'),('2026-11-02','Todos los Santos'),
    ('2026-11-16','Independencia de Cartagena'),('2026-12-08','Inmaculada Concepción'),('2026-12-25','Navidad'),
    -- 2027
    ('2027-01-01','Año Nuevo'),('2027-01-11','Reyes Magos'),('2027-03-22','San José'),
    ('2027-03-25','Jueves Santo'),('2027-03-26','Viernes Santo'),('2027-05-01','Día del Trabajo'),
    ('2027-05-10','Ascensión del Señor'),('2027-05-31','Corpus Christi'),('2027-06-07','Sagrado Corazón'),
    ('2027-07-05','San Pedro y San Pablo'),('2027-07-20','Independencia de Colombia'),('2027-08-07','Batalla de Boyacá'),
    ('2027-08-16','Asunción de la Virgen'),('2027-10-18','Día de la Raza'),('2027-11-01','Todos los Santos'),
    ('2027-11-15','Independencia de Cartagena'),('2027-12-08','Inmaculada Concepción'),('2027-12-25','Navidad')
on conflict (fecha) do nothing;

alter table public.festivos_colombia enable row level security;

drop policy if exists "todos leen festivos" on public.festivos_colombia;
create policy "todos leen festivos" on public.festivos_colombia
    for select using (auth.uid() is not null);

drop policy if exists "admin gestiona festivos" on public.festivos_colombia;
create policy "admin gestiona festivos" on public.festivos_colombia
    for all using (public.es_admin()) with check (public.es_admin());

-- ---- Funciones de días hábiles (mismas reglas que js/diasHabiles.js) ----
create or replace function public.es_dia_habil(f date)
returns boolean
language sql stable security definer set search_path = public
as $$
    select extract(isodow from f) < 6
       and not exists (select 1 from public.festivos_colombia where fecha = f);
$$;

-- Suma N días hábiles (el conteo empieza DESPUÉS de la fecha dada)
create or replace function public.sumar_dias_habiles(f date, n int)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
    d date := f;
    faltan int := greatest(coalesce(n, 0), 0);
begin
    while faltan > 0 loop
        d := d + 1;
        if public.es_dia_habil(d) then faltan := faltan - 1; end if;
    end loop;
    return d;
end;
$$;

-- Días hábiles ENTRE dos fechas (excluye la inicial, incluye la final).
-- Negativo si fecha_fin < fecha_inicio (días hábiles de atraso).
create or replace function public.contar_dias_habiles(f_inicio date, f_fin date)
returns int
language plpgsql stable security definer set search_path = public
as $$
declare
    d date;
    tope date;
    cuenta int := 0;
    signo int := 1;
begin
    if f_fin < f_inicio then
        d := f_fin; tope := f_inicio; signo := -1;
    else
        d := f_inicio; tope := f_fin;
    end if;
    while d < tope loop
        d := d + 1;
        if public.es_dia_habil(d) then cuenta := cuenta + 1; end if;
    end loop;
    return cuenta * signo;
end;
$$;

-- Vencimiento de un plazo de N días hábiles contados desde f_inicio.
-- Si f_inicio no es hábil, el plazo corre desde el siguiente día hábil.
create or replace function public.calcular_vencimiento_habil(f_inicio date, dias int)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
    d date := f_inicio;
begin
    if not public.es_dia_habil(d) then
        while not public.es_dia_habil(d) loop d := d + 1; end loop;
        return public.sumar_dias_habiles(d, greatest(dias, 1) - 1);
    end if;
    return public.sumar_dias_habiles(d, greatest(dias, 1));
end;
$$;

-- ---- Pausa del trámite a nivel de carpeta ----
alter table public.carpetas add column if not exists pausado boolean not null default false;
alter table public.carpetas add column if not exists fecha_pausa date;
alter table public.carpetas add column if not exists fecha_reactivacion date;

-- ---- Procesos del trámite (semáforo por días hábiles) ----
create table if not exists public.procesos_tramite (
    id                        bigint generated always as identity primary key,
    carpeta_id                bigint not null references public.carpetas (id) on delete cascade,
    nombre                    text not null,                 -- "Aceptación", "Litigación", ...
    dias_habiles_limite       int not null check (dias_habiles_limite > 0),
    orden                     int not null default 1,
    completado                boolean not null default false,
    fecha_inicio_proceso      date not null default current_date,
    fecha_inicio_proceso_habil date,                         -- primer día hábil del plazo
    fecha_vencimiento_habil   date not null,
    fecha_completado          date,
    completado_por            uuid references public.perfiles (id) on delete set null,
    pausado                   boolean not null default false,
    fecha_pausa               date,
    dias_restantes_al_pausar  int,
    fecha_reactivacion        date,
    -- El administrador puede fijar el semáforo a mano (null = automático)
    semaforo_manual           text check (semaforo_manual is null or semaforo_manual in ('verde', 'naranja', 'rojo')),
    editado_por               uuid references public.perfiles (id) on delete set null,
    editado                   timestamptz,
    creado_por                uuid references public.perfiles (id) on delete set null,
    creado                    timestamptz not null default now()
);

create index if not exists idx_procesos_carpeta on public.procesos_tramite (carpeta_id, orden);
create index if not exists idx_procesos_vencimiento on public.procesos_tramite (fecha_vencimiento_habil) where not completado;

alter table public.procesos_tramite enable row level security;

-- Los VEN todos los de la carpeta (y el monitor); se escriben ÚNICAMENTE
-- por las funciones de abajo (no hay políticas de escritura directa).
drop policy if exists "ver procesos de la carpeta" on public.procesos_tramite;
create policy "ver procesos de la carpeta" on public.procesos_tramite
    for select using (public.puede_ver_carpeta(carpeta_id));

-- Crea un proceso dentro del trámite (admin u operador responsable).
create or replace function public.crear_proceso_tramite(carpeta bigint, p_nombre text, p_dias int, p_orden int default null)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
    nuevo_id bigint;
    inicio_habil date;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para crear procesos en esta carpeta';
    end if;
    if p_nombre is null or trim(p_nombre) = '' then
        raise exception 'El proceso necesita un nombre';
    end if;
    if p_dias is null or p_dias <= 0 then
        raise exception 'El plazo en días hábiles debe ser mayor que cero';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta;
    if en_pausa then
        raise exception 'El trámite está pausado: reactívalo antes de crear procesos';
    end if;
    inicio_habil := current_date;
    while not public.es_dia_habil(inicio_habil) loop inicio_habil := inicio_habil + 1; end loop;
    insert into public.procesos_tramite
        (carpeta_id, nombre, dias_habiles_limite, orden,
         fecha_inicio_proceso, fecha_inicio_proceso_habil, fecha_vencimiento_habil, creado_por)
    values
        (carpeta, left(trim(p_nombre), 120), p_dias,
         coalesce(p_orden, (select coalesce(max(orden), 0) + 1 from public.procesos_tramite where carpeta_id = carpeta)),
         current_date, inicio_habil,
         public.calcular_vencimiento_habil(current_date, p_dias), auth.uid())
    returning id into nuevo_id;
    return nuevo_id;
end;
$$;

-- Marca un proceso como completado. El operador NO puede completar un
-- proceso ya vencido (solo el administrador puede corregirlo).
create or replace function public.completar_proceso(proceso bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select * into p from public.procesos_tramite where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
    if not public.puede_subir_a_carpeta(p.carpeta_id) then
        raise exception 'Sin permiso para actualizar este proceso';
    end if;
    if p.completado then raise exception 'Este proceso ya estaba completado'; end if;
    if p.pausado then raise exception 'El trámite está pausado: reactívalo primero'; end if;
    if current_date > p.fecha_vencimiento_habil and not public.es_admin() then
        raise exception 'El plazo ya venció: solo el administrador puede marcarlo como completado';
    end if;
    update public.procesos_tramite
       set completado = true, fecha_completado = current_date,
           completado_por = auth.uid(), semaforo_manual = null
     where id = proceso;
end;
$$;

-- Corrección del administrador: puede ajustar nombre, plazo, vencimiento,
-- estado de completado y fijar el semáforo a mano ('' = volver a automático).
-- Queda registrado quién editó y cuándo.
create or replace function public.editar_proceso_admin(
    proceso bigint,
    p_nombre text default null,
    p_dias int default null,
    p_vencimiento date default null,
    p_completado boolean default null,
    p_semaforo text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede corregir procesos';
    end if;
    if p_dias is not null and p_dias <= 0 then
        raise exception 'El plazo en días hábiles debe ser mayor que cero';
    end if;
    if p_semaforo is not null and p_semaforo not in ('', 'verde', 'naranja', 'rojo') then
        raise exception 'Semáforo no válido';
    end if;
    update public.procesos_tramite set
        nombre = coalesce(left(trim(p_nombre), 120), nombre),
        dias_habiles_limite = coalesce(p_dias, dias_habiles_limite),
        fecha_vencimiento_habil = coalesce(p_vencimiento, fecha_vencimiento_habil),
        completado = coalesce(p_completado, completado),
        fecha_completado = case
            when p_completado is true then coalesce(fecha_completado, current_date)
            when p_completado is false then null
            else fecha_completado end,
        semaforo_manual = case
            when p_semaforo is null then semaforo_manual
            when p_semaforo = '' then null
            else p_semaforo end,
        editado_por = auth.uid(),
        editado = now()
    where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
end;
$$;

-- Elimina un proceso (admin u operador responsable de la carpeta)
create or replace function public.eliminar_proceso(proceso bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    carpeta bigint;
begin
    select carpeta_id into carpeta from public.procesos_tramite where id = proceso;
    if not found then raise exception 'Proceso no encontrado'; end if;
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para eliminar este proceso';
    end if;
    delete from public.procesos_tramite where id = proceso;
end;
$$;

-- ============================================================
-- 8) SEMÁFORO CENTRALIZADO (única fuente de verdad) Y CONTEO
--    DEL TRÁMITE COMPLETO: 60 días hábiles (90 con prórroga)
-- ============================================================

-- El color del semáforo se calcula SOLO aquí (el navegador únicamente
-- pinta lo que recibe de listar_procesos):
--   pausado → 'pausado' · completado → 'verde' · manual del admin manda
--   vencido (fecha < hoy) → 'rojo' · quedan 0 o 1 días hábiles → 'naranja'
--   quedan 2+ → 'verde'
create or replace function public.calcular_semaforo(
    p_completado boolean,
    p_pausado boolean,
    p_semaforo_manual text,
    p_vencimiento date
)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
    restantes int;
begin
    if p_pausado then return 'pausado'; end if;
    if p_completado then return 'verde'; end if;
    if p_semaforo_manual in ('verde', 'naranja', 'rojo') then return p_semaforo_manual; end if;
    if p_vencimiento is null then return 'verde'; end if;
    if p_vencimiento < current_date then return 'rojo'; end if;
    restantes := public.contar_dias_habiles(current_date, p_vencimiento);
    if restantes <= 1 then return 'naranja'; end if;
    return 'verde';
end;
$$;

-- Procesos de una carpeta (o de TODAS las visibles si carpeta es null)
-- con el semáforo y los días hábiles restantes YA calculados en el servidor.
create or replace function public.listar_procesos(carpeta bigint default null)
returns table (
    id bigint, carpeta_id bigint, nombre text, dias_habiles_limite int, orden int,
    completado boolean, fecha_inicio_proceso date, fecha_inicio_proceso_habil date,
    fecha_vencimiento_habil date, fecha_completado date, pausado boolean,
    dias_restantes_al_pausar int, fecha_reactivacion date, semaforo_manual text,
    creado timestamptz, semaforo text, dias_restantes int
)
language plpgsql stable security definer set search_path = public
as $$
begin
    if carpeta is not null and not public.puede_ver_carpeta(carpeta) then
        raise exception 'Sin permiso para ver los procesos de esta carpeta';
    end if;
    return query
    select p.id, p.carpeta_id, p.nombre, p.dias_habiles_limite, p.orden,
           p.completado, p.fecha_inicio_proceso, p.fecha_inicio_proceso_habil,
           p.fecha_vencimiento_habil, p.fecha_completado, p.pausado,
           p.dias_restantes_al_pausar, p.fecha_reactivacion, p.semaforo_manual,
           p.creado,
           public.calcular_semaforo(p.completado, p.pausado, p.semaforo_manual, p.fecha_vencimiento_habil),
           case when p.completado or p.pausado then null
                else public.contar_dias_habiles(current_date, p.fecha_vencimiento_habil) end
    from public.procesos_tramite p
    where case when carpeta is null then public.puede_ver_carpeta(p.carpeta_id)
               else p.carpeta_id = carpeta end
    order by p.carpeta_id, p.orden, p.id;
end;
$$;

-- ---- Conteo del trámite completo (a nivel de carpeta) ----
alter table public.carpetas add column if not exists fecha_inicio_tramite date;
alter table public.carpetas add column if not exists dias_habiles_tramite int not null default 60;
alter table public.carpetas drop constraint if exists carpetas_dias_habiles_tramite_check;
alter table public.carpetas add constraint carpetas_dias_habiles_tramite_check
    check (dias_habiles_tramite in (60, 90));
alter table public.carpetas add column if not exists tiene_prorroga boolean not null default false;
alter table public.carpetas add column if not exists fecha_vencimiento_tramite date;
alter table public.carpetas add column if not exists dias_restantes_tramite_al_pausar int;

-- Pausa/reactivación AMPLIADAS: congelan y reanudan también el vencimiento
-- del trámite completo, igual que ya lo hacían con cada proceso.
create or replace function public.pausar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para pausar este trámite';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta for update;
    if en_pausa is null then raise exception 'Carpeta no encontrada'; end if;
    if en_pausa then raise exception 'El trámite ya estaba pausado'; end if;
    update public.carpetas
       set pausado = true, fecha_pausa = current_date, fecha_reactivacion = null,
           dias_restantes_tramite_al_pausar = case
               when fecha_vencimiento_tramite is null then null
               else greatest(public.contar_dias_habiles(current_date, fecha_vencimiento_tramite), 0) end
     where id = carpeta;
    update public.procesos_tramite
       set pausado = true, fecha_pausa = current_date,
           dias_restantes_al_pausar = greatest(public.contar_dias_habiles(current_date, fecha_vencimiento_habil), 0)
     where carpeta_id = carpeta and not completado;
end;
$$;

create or replace function public.reactivar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    en_pausa boolean;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para reactivar este trámite';
    end if;
    select pausado into en_pausa from public.carpetas where id = carpeta for update;
    if en_pausa is null then raise exception 'Carpeta no encontrada'; end if;
    if not en_pausa then raise exception 'El trámite no está pausado'; end if;
    update public.carpetas
       set pausado = false, fecha_reactivacion = current_date,
           fecha_vencimiento_tramite = case
               when dias_restantes_tramite_al_pausar is null then fecha_vencimiento_tramite
               else public.sumar_dias_habiles(current_date, dias_restantes_tramite_al_pausar) end,
           dias_restantes_tramite_al_pausar = null
     where id = carpeta;
    update public.procesos_tramite
       set pausado = false, fecha_reactivacion = current_date, fecha_pausa = null,
           fecha_vencimiento_habil = public.sumar_dias_habiles(current_date, coalesce(dias_restantes_al_pausar, 0))
     where carpeta_id = carpeta and not completado and pausado;
end;
$$;

-- ============================================================
-- 9) CHAT DE SOPORTE (admin ↔ operador), LEÍDO/NO LEÍDO,
--    LLAMADAS DE SOPORTE Y TIEMPO REAL
-- ============================================================

-- Un hilo de soporte por operador; cualquier administrador lo atiende.
create table if not exists public.mensajes_soporte (
    id           bigint generated always as identity primary key,
    operador_id  uuid not null references public.perfiles (id) on delete cascade, -- dueño del hilo
    autor_id     uuid not null references public.perfiles (id) on delete cascade, -- quién escribió
    autor_nombre text not null default '',   -- snapshot del actor
    rol          text not null default '',
    texto        text not null,
    leido        boolean not null default false,
    fecha_leido  timestamptz,
    fecha        timestamptz not null default now()
);
create index if not exists idx_msoporte_operador on public.mensajes_soporte (operador_id, fecha);

alter table public.mensajes_soporte enable row level security;

create or replace function public.puede_soporte(operador uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or (public.rol_actual() = 'operador' and operador = auth.uid());
$$;

drop policy if exists "ver soporte propio o admin" on public.mensajes_soporte;
create policy "ver soporte propio o admin" on public.mensajes_soporte
    for select using (public.puede_soporte(operador_id) or public.es_monitor());

drop policy if exists "escribir soporte" on public.mensajes_soporte;
create policy "escribir soporte" on public.mensajes_soporte
    for insert with check (public.puede_soporte(operador_id) and autor_id = auth.uid());

drop policy if exists "admin borra soporte" on public.mensajes_soporte;
create policy "admin borra soporte" on public.mensajes_soporte
    for delete using (public.es_admin());

-- Leído/no leído en los chats de carpeta
alter table public.mensajes add column if not exists leido boolean not null default false;
alter table public.mensajes add column if not exists fecha_leido timestamptz;

create or replace function public.marcar_leidos_de_canal(carpeta bigint, canal_chat text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_chat(carpeta, canal_chat) then
        raise exception 'Sin permiso sobre este chat';
    end if;
    update public.mensajes
       set leido = true, fecha_leido = now()
     where carpeta_id = carpeta and canal = canal_chat
       and not leido
       and (perfil_id is distinct from auth.uid());
end;
$$;

create or replace function public.marcar_leidos_soporte(operador uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.puede_soporte(operador) then
        raise exception 'Sin permiso sobre este chat de soporte';
    end if;
    update public.mensajes_soporte
       set leido = true, fecha_leido = now()
     where operador_id = operador
       and not leido
       and autor_id <> auth.uid();
end;
$$;

-- Contadores de no leídos (solo mensajes AJENOS) para el usuario conectado
create or replace function public.no_leidos_chats()
returns table (carpeta_id bigint, canal text, no_leidos bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select m.carpeta_id, m.canal, count(*)
    from public.mensajes m
    where not m.leido
      and (m.perfil_id is distinct from auth.uid())
      and public.puede_chat(m.carpeta_id, m.canal)
    group by m.carpeta_id, m.canal;
end;
$$;

create or replace function public.no_leidos_soporte()
returns table (operador_id uuid, no_leidos bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
    select m.operador_id, count(*)
    from public.mensajes_soporte m
    where not m.leido
      and m.autor_id <> auth.uid()
      and public.puede_soporte(m.operador_id)
    group by m.operador_id;
end;
$$;

-- LLAMADAS: solo el administrador crea la fila (el servidor lo exige);
-- la señalización WebRTC viaja por Supabase Realtime broadcast y el
-- destinatario solo se une si existe una llamada dirigida a él.
create table if not exists public.llamadas_soporte (
    id         uuid primary key default gen_random_uuid(),
    iniciador  uuid not null references public.perfiles (id) on delete cascade,
    destino    uuid not null references public.perfiles (id) on delete cascade,
    estado     text not null default 'sonando'
               check (estado in ('sonando', 'aceptada', 'rechazada', 'terminada', 'perdida')),
    creado     timestamptz not null default now()
);
create index if not exists idx_llamadas_destino on public.llamadas_soporte (destino, creado desc);

alter table public.llamadas_soporte enable row level security;

drop policy if exists "participantes ven la llamada" on public.llamadas_soporte;
create policy "participantes ven la llamada" on public.llamadas_soporte
    for select using (iniciador = auth.uid() or destino = auth.uid());

drop policy if exists "solo admin inicia llamadas" on public.llamadas_soporte;
create policy "solo admin inicia llamadas" on public.llamadas_soporte
    for insert with check (
        public.es_admin()
        and iniciador = auth.uid()
        and exists (select 1 from public.perfiles p
                    where p.id = destino and p.activo
                      and p.rol in ('operador', 'cliente', 'acreedor'))
    );

drop policy if exists "participantes actualizan estado" on public.llamadas_soporte;
create policy "participantes actualizan estado" on public.llamadas_soporte
    for update using (iniciador = auth.uid() or destino = auth.uid())
        with check (iniciador = auth.uid() or destino = auth.uid());

-- Tiempo real: la publicación supabase_realtime estaba vacía; se publican
-- las tablas de chat para recibir mensajes al instante en el navegador.
do $$
begin
    begin
        alter publication supabase_realtime add table public.mensajes;
    exception when duplicate_object then null;
    end;
    begin
        alter publication supabase_realtime add table public.mensajes_soporte;
    exception when duplicate_object then null;
    end;
    begin
        alter publication supabase_realtime add table public.llamadas_soporte;
    exception when duplicate_object then null;
    end;
end $$;

-- ============================================================
-- 10) NOTIFICACIONES por destinatario (campana del portal)
--     Cada quien ve SOLO las suyas (el admin también solo las suyas).
--     Se insertan únicamente desde los triggers de abajo.
--     El admin NUNCA recibe notificación de los chats cliente-operador
--     ni acreedor-operador: el filtro vive en notif_mensaje_nuevo.
-- ============================================================
create table if not exists public.notificaciones (
    id              bigint generated always as identity primary key,
    destinatario_id uuid not null references public.perfiles (id) on delete cascade,
    tipo            text not null,
    mensaje         text not null default '',
    carpeta_id      bigint references public.carpetas (id) on delete cascade,
    referencia_id   bigint,
    leido           boolean not null default false,
    fecha           timestamptz not null default now()
);
create index if not exists idx_notif_destinatario on public.notificaciones (destinatario_id, leido, fecha desc);

alter table public.notificaciones enable row level security;

drop policy if exists "ver mis notificaciones" on public.notificaciones;
create policy "ver mis notificaciones" on public.notificaciones
    for select using (destinatario_id = auth.uid());

drop policy if exists "marcar mis notificaciones" on public.notificaciones;
create policy "marcar mis notificaciones" on public.notificaciones
    for update using (destinatario_id = auth.uid())
        with check (destinatario_id = auth.uid());

drop policy if exists "borrar mis notificaciones" on public.notificaciones;
create policy "borrar mis notificaciones" on public.notificaciones
    for delete using (destinatario_id = auth.uid());

create or replace function public._notificar(destino uuid, p_tipo text, p_mensaje text, p_carpeta bigint default null, p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if destino is null then return; end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
    values (destino, left(coalesce(p_tipo, ''), 40), left(coalesce(p_mensaje, ''), 300), p_carpeta, p_ref);
end;
$$;

create or replace function public._notificar_admins(p_tipo text, p_mensaje text, p_carpeta bigint default null, p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    a record;
begin
    for a in select id from public.perfiles where rol = 'administrador' and activo and id is distinct from auth.uid()
    loop
        perform public._notificar(a.id, p_tipo, p_mensaje, p_carpeta, p_ref);
    end loop;
end;
$$;

-- Mensaje del personal → SOLO al cliente/acreedor del canal (nunca al admin)
create or replace function public.notif_mensaje_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    nom text;
begin
    if new.rol in ('operador', 'administrador') then
        select nombre into nom from public.carpetas where id = new.carpeta_id;
        for d in
            select p.id from public.carpeta_asignados a
            join public.perfiles p on p.id = a.perfil_id
            where a.carpeta_id = new.carpeta_id and p.activo
              and p.rol = new.canal
              and p.id is distinct from new.perfil_id
        loop
            perform public._notificar(d.id, 'mensaje-nuevo',
                'Nuevo mensaje del operador en tu trámite «' || coalesce(nom, '') || '»',
                new.carpeta_id, new.id);
        end loop;
    end if;
    return new;
end;
$$;
drop trigger if exists notif_mensaje on public.mensajes;
create trigger notif_mensaje after insert on public.mensajes
    for each row execute function public.notif_mensaje_nuevo();

-- Archivo nuevo → clientes/acreedores asignados
create or replace function public.notif_archivo_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    nom text;
begin
    select nombre into nom from public.carpetas where id = new.carpeta_id;
    for d in
        select p.id from public.carpeta_asignados a
        join public.perfiles p on p.id = a.perfil_id
        where a.carpeta_id = new.carpeta_id and p.activo
          and p.rol in ('cliente', 'acreedor')
    loop
        perform public._notificar(d.id, 'archivo-nuevo',
            'Nuevo documento «' || new.nombre || '» en tu trámite «' || coalesce(nom, '') || '»',
            new.carpeta_id, new.id);
    end loop;
    return new;
end;
$$;
drop trigger if exists notif_archivo on public.archivos;
create trigger notif_archivo after insert on public.archivos
    for each row execute function public.notif_archivo_nuevo();

-- Operador escribe en soporte → aviso a administradores
create or replace function public.notif_soporte_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.rol = 'operador' then
        perform public._notificar_admins('soporte',
            coalesce(new.autor_nombre, 'Un operador') || ' pide soporte: «' || left(new.texto, 120) || '»',
            null, new.id);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_soporte on public.mensajes_soporte;
create trigger notif_soporte after insert on public.mensajes_soporte
    for each row execute function public.notif_soporte_nuevo();

-- Cambios de procesos (completado/semáforo) y trámite finalizado → admins
create or replace function public.notif_proceso_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    nom text;
    pendientes int;
begin
    select nombre into nom from public.carpetas where id = new.carpeta_id;
    if new.completado is distinct from old.completado then
        perform public._notificar_admins('proceso-estado',
            'El proceso «' || new.nombre || '» de «' || coalesce(nom, '') || '» ' ||
            case when new.completado then 'fue completado' else 'volvió a pendiente' end,
            new.carpeta_id, new.id);
        if new.completado then
            select count(*) into pendientes from public.procesos_tramite
            where carpeta_id = new.carpeta_id and not completado;
            if pendientes = 0 then
                perform public._notificar_admins('tramite-finalizado',
                    'Todos los procesos de «' || coalesce(nom, '') || '» quedaron completados',
                    new.carpeta_id, null);
            end if;
        end if;
    end if;
    if new.semaforo_manual is distinct from old.semaforo_manual then
        perform public._notificar_admins('proceso-semaforo',
            'El semáforo del proceso «' || new.nombre || '» de «' || coalesce(nom, '') || '» cambió a ' ||
            coalesce(new.semaforo_manual, 'automático'),
            new.carpeta_id, new.id);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_proceso on public.procesos_tramite;
create trigger notif_proceso after update on public.procesos_tramite
    for each row execute function public.notif_proceso_cambio();

-- Pausa / reactivación / prórroga → admins
create or replace function public.notif_carpeta_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.pausado is distinct from old.pausado then
        perform public._notificar_admins(case when new.pausado then 'tramite-pausado' else 'tramite-reactivado' end,
            'El trámite «' || new.nombre || '» fue ' || case when new.pausado then 'pausado' else 'reactivado' end,
            new.id, null);
    end if;
    if new.tiene_prorroga and not old.tiene_prorroga then
        perform public._notificar_admins('tramite-prorroga',
            'Se aplicó la prórroga (90 días hábiles) al trámite «' || new.nombre || '»',
            new.id, null);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_carpeta on public.carpetas;
create trigger notif_carpeta after update on public.carpetas
    for each row execute function public.notif_carpeta_cambio();

-- Plazos vencidos (sin tarea nocturna): el portal del ADMIN la llama al
-- refrescar la campana; genera la notificación UNA sola vez por proceso.
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    for p in
        select pt.id, pt.nombre, pt.carpeta_id
        from public.procesos_tramite pt
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id
        from public.perfiles a where a.rol = 'administrador' and a.activo;
    end loop;
end;
$$;

create or replace function public.marcar_notificaciones_leidas(ids bigint[] default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.notificaciones
       set leido = true
     where destinatario_id = auth.uid()
       and not leido
       and (ids is null or id = any(ids));
end;
$$;

do $$
begin
    begin
        alter publication supabase_realtime add table public.notificaciones;
    exception when duplicate_object then null;
    end;
end $$;

-- ============================================================
-- 11) CONSENTIMIENTO DE DATOS Y PESO CACHEADO POR CARPETA
-- ============================================================
alter table public.perfiles add column if not exists primer_login boolean not null default true;

create table if not exists public.consentimientos (
    id               bigint generated always as identity primary key,
    perfil_id        uuid not null references public.perfiles (id) on delete cascade,
    fecha_aceptacion timestamptz not null default now(),
    version_politica text not null default '1.0'
);
create index if not exists idx_consent_perfil on public.consentimientos (perfil_id);

alter table public.consentimientos enable row level security;

drop policy if exists "admin ve consentimientos" on public.consentimientos;
create policy "admin ve consentimientos" on public.consentimientos
    for select using (public.es_admin() or perfil_id = auth.uid());

create or replace function public.aceptar_consentimiento(p_version text default '1.0')
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if auth.uid() is null then raise exception 'No autenticado'; end if;
    insert into public.consentimientos (perfil_id, version_politica)
    values (auth.uid(), left(coalesce(p_version, '1.0'), 20));
    update public.perfiles set primer_login = false where id = auth.uid();
end;
$$;

create or replace function public.listar_consentimientos()
returns table (usuario text, nombre text, rol text, fecha_aceptacion timestamptz, version_politica text)
language plpgsql stable security definer set search_path = public
as $$
begin
    if not (public.es_admin() or public.es_monitor()) then
        raise exception 'Solo la administración puede ver los consentimientos';
    end if;
    return query
    select p.usuario, p.nombre, p.rol, c.fecha_aceptacion, c.version_politica
    from public.consentimientos c
    join public.perfiles p on p.id = c.perfil_id
    order by c.fecha_aceptacion desc;
end;
$$;

-- Peso total (MB) y nº de documentos por carpeta, cacheados y mantenidos por
-- trigger (cubre TODAS las vías de subida/eliminación/edición de archivos).
alter table public.carpetas add column if not exists peso_total_mb numeric(12,2) not null default 0;
alter table public.carpetas add column if not exists total_archivos int not null default 0;

create or replace function public.actualizar_peso_carpeta()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    objetivo bigint := coalesce(new.carpeta_id, old.carpeta_id);
begin
    update public.carpetas c
       set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                     from public.archivos a where a.carpeta_id = objetivo), 0),
           total_archivos = coalesce((select count(*) from public.archivos a
                                      where a.carpeta_id = objetivo), 0)
     where c.id = objetivo;
    if tg_op = 'UPDATE' and new.carpeta_id is distinct from old.carpeta_id then
        update public.carpetas c
           set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                         from public.archivos a where a.carpeta_id = old.carpeta_id), 0),
               total_archivos = coalesce((select count(*) from public.archivos a
                                          where a.carpeta_id = old.carpeta_id), 0)
         where c.id = old.carpeta_id;
    end if;
    return null;
end;
$$;

drop trigger if exists peso_carpeta on public.archivos;
create trigger peso_carpeta after insert or update or delete on public.archivos
    for each row execute function public.actualizar_peso_carpeta();

update public.carpetas c
   set peso_total_mb = coalesce((select round(sum(a.tamano) / 1048576.0, 2)
                                 from public.archivos a where a.carpeta_id = c.id), 0),
       total_archivos = coalesce((select count(*) from public.archivos a
                                  where a.carpeta_id = c.id), 0);

-- ============================================================
-- 12) BACKLOG: última conexión, detalle de audiencias, fin de
--     trámite, prórroga para operadores e hilos por acreedor
-- ============================================================

-- Última conexión (la marca cada usuario al entrar al portal)
alter table public.perfiles add column if not exists ultima_conexion timestamptz;

create or replace function public.registrar_conexion()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if auth.uid() is null then return; end if;
    update public.perfiles set ultima_conexion = now() where id = auth.uid();
end;
$$;

-- Detalle libre en cada audiencia del calendario
alter table public.audiencias add column if not exists descripcion text not null default '';

-- Fin de trámite: EXCLUSIVO del administrador
alter table public.carpetas add column if not exists finalizado boolean not null default false;
alter table public.carpetas add column if not exists fecha_fin_tramite date;

create or replace function public.finalizar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede dar fin al trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya estaba finalizado'; end if;
    update public.carpetas
       set finalizado = true, fecha_fin_tramite = current_date
     where id = carpeta;
end;
$$;

create or replace function public.notif_fin_tramite()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.finalizado and not old.finalizado then
        perform public._notificar_admins('tramite-fin',
            'El administrador dio FIN al trámite «' || new.nombre || '»', new.id, null);
    end if;
    return new;
end;
$$;
drop trigger if exists notif_fin on public.carpetas;
create trigger notif_fin after update on public.carpetas
    for each row execute function public.notif_fin_tramite();

-- La prórroga ahora la puede aplicar también el OPERADOR responsable, y ni
-- la prórroga ni el inicio del conteo corren sobre un trámite finalizado.
create or replace function public.aplicar_prorroga(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para aplicar la prórroga a este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.fecha_inicio_tramite is null then
        raise exception 'El trámite aún no tiene conteo iniciado: usa iniciar_tramite primero';
    end if;
    if c.tiene_prorroga then raise exception 'El trámite ya tiene la prórroga aplicada'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de aplicar la prórroga'; end if;
    update public.carpetas
       set dias_habiles_tramite = 90,
           tiene_prorroga = true,
           fecha_vencimiento_tramite = public.calcular_vencimiento_habil(c.fecha_inicio_tramite, 90)
     where id = carpeta;
end;
$$;

create or replace function public.iniciar_tramite(carpeta bigint, p_fecha date default current_date)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
    f date := coalesce(p_fecha, current_date);
begin
    if not public.puede_subir_a_carpeta(carpeta) then
        raise exception 'Sin permiso para iniciar el conteo de este trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya está finalizado'; end if;
    if c.pausado then raise exception 'El trámite está pausado: reactívalo antes de iniciar el conteo'; end if;
    if c.fecha_inicio_tramite is not null then
        raise exception 'El conteo del trámite ya fue iniciado el %', c.fecha_inicio_tramite;
    end if;
    update public.carpetas
       set fecha_inicio_tramite = f,
           dias_habiles_tramite = 60,
           tiene_prorroga = false,
           fecha_vencimiento_tramite = public.calcular_vencimiento_habil(f, 60),
           dias_restantes_tramite_al_pausar = null
     where id = carpeta;
end;
$$;

-- Hilos por acreedor en el canal 'acreedor':
--   acreedor escribe → destinatario_id null (va al personal)
--   personal escribe → destinatario_id = acreedor elegido, o null = TODOS
-- Cada acreedor SOLO ve su propio hilo (y los avisos "para todos").
alter table public.mensajes add column if not exists destinatario_id uuid references public.perfiles (id) on delete set null;

create or replace function public.es_personal_de_chat(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin() or public.es_operador_de(carpeta);
$$;

drop policy if exists "ver mensajes del canal" on public.mensajes;
create policy "ver mensajes del canal" on public.mensajes
    for select using (
        public.puede_chat(carpeta_id, canal)
        and (
            canal = 'cliente'
            or public.rol_actual() <> 'acreedor'
            or perfil_id = auth.uid()
            or destinatario_id = auth.uid()
            or (destinatario_id is null and rol in ('operador', 'administrador'))
        )
    );

drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (
        public.puede_chat(carpeta_id, canal)
        and (public.es_personal_de_chat(carpeta_id) or destinatario_id is null)
    );

-- ============================================================
-- 13) PRE-DESPLIEGUE: integridad de autor y avisos de ingreso
-- ============================================================

-- El límite por archivo ya se fijó arriba (sección 5). Aquí había un
-- SEGUNDO `update` que lo bajaba a 100 MB, y como corre después, era el
-- que mandaba: una instalación nueva terminaba en 100 MB por más que la
-- sección 5 dijera otra cosa. El número vive en un solo sitio.

-- Nadie puede firmar como otro: el autor de mensajes/archivos DEBE ser el
-- usuario conectado, y un trigger sobreescribe los snapshots con los datos
-- reales del perfil (aunque el navegador mande otros).
drop policy if exists "escribir mensajes del canal" on public.mensajes;
create policy "escribir mensajes del canal" on public.mensajes
    for insert with check (
        public.puede_chat(carpeta_id, canal)
        and perfil_id = auth.uid()
        and (public.es_personal_de_chat(carpeta_id) or destinatario_id is null)
    );

drop policy if exists "sube admin u operador de la carpeta" on public.archivos;
create policy "sube admin u operador de la carpeta" on public.archivos
    for insert with check (
        public.puede_subir_a_carpeta(carpeta_id)
        and subido_por = auth.uid()
    );

create or replace function public.fijar_autor_mensaje()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select usuario, nombre, rol into p from public.perfiles where id = auth.uid();
    if found then
        new.perfil_id := auth.uid();
        new.autor_usuario := p.usuario;
        new.autor_nombre := p.nombre;
        new.rol := p.rol;
    end if;
    return new;
end;
$$;
drop trigger if exists autor_mensaje on public.mensajes;
create trigger autor_mensaje before insert on public.mensajes
    for each row execute function public.fijar_autor_mensaje();

create or replace function public.fijar_autor_archivo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select nombre into p from public.perfiles where id = auth.uid();
    if found then
        new.subido_por := auth.uid();
        new.subido_por_usuario := p.nombre;
    end if;
    return new;
end;
$$;
drop trigger if exists autor_archivo on public.archivos;
create trigger autor_archivo before insert on public.archivos
    for each row execute function public.fijar_autor_archivo();

-- Aviso de ingreso propio en la campana del administrador (fecha/hora),
-- estilo "nuevo inicio de sesión". Lo llama el portal al ingresar.
create or replace function public.notificar_mi_ingreso()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    select nombre, rol into p from public.perfiles where id = auth.uid() and activo;
    if not found then return; end if;
    if p.rol <> 'administrador' then return; end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
    values (auth.uid(), 'ingreso-propio',
            'Ingreso al portal el ' || to_char(now() at time zone 'America/Bogota', 'DD/MM/YYYY') ||
            ' a las ' || to_char(now() at time zone 'America/Bogota', 'HH12:MI AM'),
            null, null);
end;
$$;

-- ============================================================
-- 14) OLVIDÉ MI CONTRASEÑA Y ADJUNTOS DE SOPORTE
-- ============================================================
create table if not exists public.solicitudes_clave (
    id           bigint generated always as identity primary key,
    usuario      text not null,
    estado       text not null default 'pendiente' check (estado in ('pendiente','resuelta')),
    fecha        timestamptz not null default now(),
    resuelta_por uuid references public.perfiles (id) on delete set null,
    fecha_resuelta timestamptz
);
create index if not exists idx_solicitudes_estado on public.solicitudes_clave (estado, fecha desc);
alter table public.solicitudes_clave enable row level security;

drop policy if exists "admin ve solicitudes de clave" on public.solicitudes_clave;
create policy "admin ve solicitudes de clave" on public.solicitudes_clave
    for select using (public.es_admin());
drop policy if exists "admin resuelve solicitudes de clave" on public.solicitudes_clave;
create policy "admin resuelve solicitudes de clave" on public.solicitudes_clave
    for update using (public.es_admin()) with check (public.es_admin());

-- La llama quien olvidó su clave (SIN sesión). Silencio si no existe (no
-- revela usuarios) y no duplica pendientes; avisa a los administradores.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
begin
    if u = '' or length(u) > 30 then return; end if;
    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;
    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

create or replace function public.resolver_solicitud_clave(solicitud bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then raise exception 'Solo el administrador puede resolver solicitudes'; end if;
    update public.solicitudes_clave
       set estado = 'resuelta', resuelta_por = auth.uid(), fecha_resuelta = now()
     where id = solicitud and estado = 'pendiente';
end;
$$;

-- Adjuntos del chat de soporte ('soporte/<uuid-operador>/...')
alter table public.mensajes_soporte add column if not exists archivo_nombre text not null default '';
alter table public.mensajes_soporte add column if not exists archivo_ruta   text not null default '';
alter table public.mensajes_soporte add column if not exists archivo_tamano bigint not null default 0;
alter table public.mensajes_soporte add column if not exists archivo_tipo   text not null default '';

create or replace function public.soporte_operador_de_ruta(ruta text)
returns uuid language plpgsql immutable as $$
begin
    return (split_part(ruta, '/', 2))::uuid;
exception when others then return null;
end; $$;

drop policy if exists "soporte sube adjuntos" on storage.objects;
create policy "soporte sube adjuntos" on storage.objects
    for insert with check (bucket_id = 'documentos' and name like 'soporte/%'
        and public.puede_soporte(public.soporte_operador_de_ruta(name)));
drop policy if exists "soporte descarga adjuntos" on storage.objects;
create policy "soporte descarga adjuntos" on storage.objects
    for select using (bucket_id = 'documentos' and name like 'soporte/%'
        and public.puede_soporte(public.soporte_operador_de_ruta(name)));
drop policy if exists "admin borra adjuntos de soporte" on storage.objects;
create policy "admin borra adjuntos de soporte" on storage.objects
    for delete using (bucket_id = 'documentos' and name like 'soporte/%' and public.es_admin());

-- ============================================================
-- 14) CIERRE DEL TRÁMITE: 30 días hábiles para descargar
-- ============================================================
-- Al dar fin al trámite la carpeta sigue accesible 30 días hábiles para que
-- las partes descarguen sus documentos. Cumplido el plazo se desactiva sola;
-- el administrador puede volver a activarla y ya no se vuelve a desactivar.

alter table public.carpetas add column if not exists fecha_desactivacion_programada date;
alter table public.carpetas add column if not exists desactivacion_auto_aplicada boolean not null default false;

-- Días hábiles de gracia tras el fin del trámite
create or replace function public.dias_gracia_cierre()
returns int language sql immutable as $$ select 30 $$;

create or replace function public.finalizar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede dar fin al trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya estaba finalizado'; end if;
    update public.carpetas
       set finalizado = true,
           fecha_fin_tramite = current_date,
           fecha_desactivacion_programada =
               public.sumar_dias_habiles(current_date, public.dias_gracia_cierre()),
           desactivacion_auto_aplicada = false
     where id = carpeta;
end;
$$;

-- Avisa a admins, al operador responsable y a las partes (cliente y acreedores)
create or replace function public.notif_fin_tramite()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    aviso text;
begin
    if new.finalizado and not old.finalizado then
        perform public._notificar_admins('tramite-fin',
            'Se dio FIN al trámite «' || new.nombre || '»', new.id, null);

        aviso := 'El trámite «' || new.nombre || '» finalizó. Tienes ' ||
                 public.dias_gracia_cierre() || ' días hábiles (hasta el ' ||
                 to_char(coalesce(new.fecha_desactivacion_programada,
                     public.sumar_dias_habiles(current_date, public.dias_gracia_cierre())), 'DD/MM/YYYY') ||
                 ') para descargar los documentos de la carpeta. Después de esa fecha ' ||
                 'deberás solicitarlos escribiendo al correo de la entidad.';

        for d in
            select p.id from public.carpeta_asignados a
            join public.perfiles p on p.id = a.perfil_id
            where a.carpeta_id = new.id and p.activo
            union
            select p.id from public.carpeta_operadores o
            join public.perfiles p on p.id = o.perfil_id
            where o.carpeta_id = new.id and p.activo
        loop
            perform public._notificar(d.id, 'tramite-cierre-descarga', aviso, new.id, null);
        end loop;
    end if;
    return new;
end;
$$;
drop trigger if exists notif_fin on public.carpetas;
create trigger notif_fin after update on public.carpetas
    for each row execute function public.notif_fin_tramite();

-- Desactivación automática al cumplirse el plazo. Se ejecuta sola cada vez que
-- alguien consulta sus avisos, así no hace falta un programador de tareas.
create or replace function public.aplicar_desactivaciones_automaticas()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.carpetas
       set activa = false, desactivacion_auto_aplicada = true
     where finalizado
       and activa
       and not desactivacion_auto_aplicada
       and fecha_desactivacion_programada is not null
       and fecha_desactivacion_programada <= current_date;
end;
$$;

-- Carpetas finalizadas que el usuario todavía puede ver, con los días hábiles
-- que le quedan para descargar. Alimenta el aviso de cada ingreso y el modal.
create or replace function public.avisos_fin_tramite()
returns table (
    carpeta_id bigint,
    nombre text,
    fecha_fin date,
    fecha_desactivacion date,
    dias_habiles_restantes int,
    activa boolean
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
        select c.id, c.nombre, c.fecha_fin_tramite, c.fecha_desactivacion_programada,
               greatest(public.contar_dias_habiles(current_date, c.fecha_desactivacion_programada), 0),
               c.activa
        from public.carpetas c
        where c.finalizado
          and c.fecha_desactivacion_programada is not null
          and public.puede_ver_carpeta(c.id)
        order by c.fecha_desactivacion_programada;
end;
$$;

-- ============================================================
-- 15) DESCARGA POR ARCHIVO: el operador decide qué se puede bajar
-- ============================================================
-- Cada documento lleva una marca "descargable por las partes". El cliente y el
-- acreedor SIEMPRE pueden abrir y leer los documentos de su carpeta; la marca
-- solo decide si además pueden descargarlos (botón "Descargar" y ZIP).
-- Por eso Storage sigue permitiendo la lectura a quien ya tiene acceso a la
-- carpeta: sin leer los bytes no se puede mostrar el documento en pantalla.

alter table public.archivos add column if not exists descargable_partes boolean not null default true;

-- Lectura de documentos: quien tiene acceso a la carpeta puede abrirlos
drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_ver_carpeta(public.carpeta_de_ruta(name))
    );

-- Ya no se usa: la marca se aplica en el portal, no en Storage
drop function if exists public.puede_descargar_archivo(text);

-- El operador responsable (o el admin) cambia la disponibilidad de un archivo
create or replace function public.fijar_descarga_partes(archivo bigint, permitir boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c bigint;
begin
    select carpeta_id into c from public.archivos where id = archivo;
    if c is null then raise exception 'Archivo no encontrado'; end if;
    if not public.puede_subir_a_carpeta(c) then
        raise exception 'Sin permiso para cambiar la descarga de este archivo';
    end if;
    update public.archivos set descargable_partes = permitir where id = archivo;
end;
$$;


-- ============================================================
-- 16) TABLAS QUE FALTABAN EN ESTE ARCHIVO
-- ============================================================
-- chat_mensajes y hoja_trabajo existían en la base pero no en el
-- esquema: correr esquema.sql en un proyecto nuevo producía una
-- base distinta a la de producción. Aquí quedan alineadas.
-- ============================================================

-- Chat del trámite con asistente (es_ia marca las respuestas
-- automáticas; ley_citada guarda la norma que se referenció).
create table if not exists public.chat_mensajes (
    id             bigint generated always as identity primary key,
    carpeta_id     bigint not null references public.carpetas (id) on delete cascade,
    perfil_id      uuid references public.perfiles (id) on delete set null,
    autor_usuario  text not null default '',
    autor_nombre   text not null default '',
    rol            text not null default '',
    texto          text not null,
    es_ia          boolean not null default false,
    bloqueado      boolean not null default false,
    ley_citada     text,
    fecha          timestamptz not null default now()
);
create index if not exists idx_chat_mensajes_perfil on public.chat_mensajes (perfil_id);
create index if not exists idx_chat_mensajes_carpeta on public.chat_mensajes (carpeta_id, fecha);

alter table public.chat_mensajes enable row level security;

drop policy if exists "ver chat de la carpeta" on public.chat_mensajes;
create policy "ver chat de la carpeta" on public.chat_mensajes
    for select using (public.puede_ver_carpeta(carpeta_id));

-- El autor NO se acepta del cliente: lo sobrescribe el trigger
-- fijar_autor_chat (ver migracion_seguridad_2026_08.sql).
drop policy if exists "escribir chat en la carpeta" on public.chat_mensajes;
create policy "escribir chat en la carpeta" on public.chat_mensajes
    for insert with check (
        public.puede_ver_carpeta(carpeta_id)
        and perfil_id = auth.uid()
    );

drop policy if exists "admin borra chat" on public.chat_mensajes;
create policy "admin borra chat" on public.chat_mensajes
    for delete using (public.es_admin());

-- Hoja de trabajo del operador: una por carpeta, contenido libre.
create table if not exists public.hoja_trabajo (
    carpeta_id      bigint primary key references public.carpetas (id) on delete cascade,
    datos           jsonb not null default '{}'::jsonb,
    actualizado     timestamptz not null default now(),
    actualizado_por uuid references public.perfiles (id) on delete set null
);
create index if not exists idx_hoja_trabajo_actualizado on public.hoja_trabajo (actualizado_por);

alter table public.hoja_trabajo enable row level security;

drop policy if exists "ver hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo;
create policy "ver hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo
    for select using (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "crear hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo;
create policy "crear hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo
    for insert with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "editar hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo;
create policy "editar hoja de trabajo (personal de la carpeta)" on public.hoja_trabajo
    for update using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

drop policy if exists "borrar hoja de trabajo (admin)" on public.hoja_trabajo;
create policy "borrar hoja de trabajo (admin)" on public.hoja_trabajo
    for delete using (public.es_admin());
-- ============================================================
-- 17) SUBCARPETAS dentro de una carpeta
-- ============================================================
--
-- Permite agrupar los documentos del trámite: «Audiencias»,
-- «Notificaciones», «Soportes»…  Es UN SOLO NIVEL: la carpeta
-- sigue siendo el trámite y la subcarpeta solo ordena lo que
-- hay dentro.
--
-- POR QUÉ NO CAMBIAN LAS REGLAS DE ACCESO
-- Las rutas de Storage pasan de
--     <id-carpeta>/<archivo>
-- a
--     <id-carpeta>/<id-subcarpeta>/<archivo>
-- El PRIMER segmento sigue siendo el id de la carpeta, y es lo
-- único que mira carpeta_de_ruta(), de la que dependen todas las
-- políticas del bucket. Verificado: '12/5/acta.pdf' resuelve a 12.
-- ============================================================

create table if not exists public.subcarpetas (
    id          bigint generated always as identity primary key,
    carpeta_id  bigint not null references public.carpetas (id) on delete cascade,
    nombre      text not null check (length(trim(nombre)) between 1 and 60),
    orden       int not null default 1,
    creado_por  uuid references public.perfiles (id) on delete set null,
    creado      timestamptz not null default now(),
    unique (carpeta_id, nombre)
);
create index if not exists idx_subcarpetas_carpeta on public.subcarpetas (carpeta_id, orden);
create index if not exists idx_subcarpetas_creado_por on public.subcarpetas (creado_por);

alter table public.subcarpetas enable row level security;

-- La ven todos los que ven la carpeta (incluye monitor y partes)
drop policy if exists "ver subcarpetas de la carpeta" on public.subcarpetas;
create policy "ver subcarpetas de la carpeta" on public.subcarpetas
    for select using (public.puede_ver_carpeta(carpeta_id));

-- Las gestiona quien puede subir a la carpeta (admin y operador responsable)
drop policy if exists "personal gestiona subcarpetas" on public.subcarpetas;
create policy "personal gestiona subcarpetas" on public.subcarpetas
    for all using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

-- Un archivo está en una subcarpeta o en la raíz (null).
-- on delete set null: al borrar la subcarpeta los documentos NO se
-- pierden, vuelven a la raíz de la carpeta.
alter table public.archivos
    add column if not exists subcarpeta_id bigint
    references public.subcarpetas (id) on delete set null;
create index if not exists idx_archivos_subcarpeta on public.archivos (subcarpeta_id);


-- ############################################################
-- PARTE 2 DE 31: migracion_cierre_y_descargas.sql
-- Cierre de trámite y control de descargas
-- ############################################################

-- ============================================================
-- MIGRACIÓN: cierre del trámite + descarga por archivo
-- ============================================================
-- Pégalo completo en el SQL Editor de Supabase y ejecútalo.
-- Es idempotente: se puede correr varias veces sin romper nada
-- (usa "add column if not exists" y "create or replace"), y no
-- borra datos existentes.
--
-- Incluye:
--   14) Fin de trámite con 30 días hábiles de gracia y
--       desactivación automática de la carpeta.
--   15) Interruptor de descarga por archivo para las partes.
-- ============================================================

-- ============================================================
-- 14) CIERRE DEL TRÁMITE: 30 días hábiles para descargar
-- ============================================================
-- Al dar fin al trámite la carpeta sigue accesible 30 días hábiles para que
-- las partes descarguen sus documentos. Cumplido el plazo se desactiva sola;
-- el administrador puede volver a activarla y ya no se vuelve a desactivar.

alter table public.carpetas add column if not exists fecha_desactivacion_programada date;
alter table public.carpetas add column if not exists desactivacion_auto_aplicada boolean not null default false;

-- Días hábiles de gracia tras el fin del trámite
create or replace function public.dias_gracia_cierre()
returns int language sql immutable as $$ select 30 $$;

create or replace function public.finalizar_tramite(carpeta bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c record;
begin
    if not public.es_admin() then
        raise exception 'Solo el administrador puede dar fin al trámite';
    end if;
    select * into c from public.carpetas where id = carpeta for update;
    if not found then raise exception 'Carpeta no encontrada'; end if;
    if c.finalizado then raise exception 'El trámite ya estaba finalizado'; end if;
    update public.carpetas
       set finalizado = true,
           fecha_fin_tramite = current_date,
           fecha_desactivacion_programada =
               public.sumar_dias_habiles(current_date, public.dias_gracia_cierre()),
           desactivacion_auto_aplicada = false
     where id = carpeta;
end;
$$;

-- Avisa a admins, al operador responsable y a las partes (cliente y acreedores)
create or replace function public.notif_fin_tramite()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    d record;
    aviso text;
begin
    if new.finalizado and not old.finalizado then
        perform public._notificar_admins('tramite-fin',
            'Se dio FIN al trámite «' || new.nombre || '»', new.id, null);

        aviso := 'El trámite «' || new.nombre || '» finalizó. Tienes ' ||
                 public.dias_gracia_cierre() || ' días hábiles (hasta el ' ||
                 to_char(coalesce(new.fecha_desactivacion_programada,
                     public.sumar_dias_habiles(current_date, public.dias_gracia_cierre())), 'DD/MM/YYYY') ||
                 ') para descargar los documentos de la carpeta. Después de esa fecha ' ||
                 'deberás solicitarlos escribiendo al correo de la entidad.';

        for d in
            select p.id from public.carpeta_asignados a
            join public.perfiles p on p.id = a.perfil_id
            where a.carpeta_id = new.id and p.activo
            union
            select p.id from public.carpeta_operadores o
            join public.perfiles p on p.id = o.perfil_id
            where o.carpeta_id = new.id and p.activo
        loop
            perform public._notificar(d.id, 'tramite-cierre-descarga', aviso, new.id, null);
        end loop;
    end if;
    return new;
end;
$$;
drop trigger if exists notif_fin on public.carpetas;
create trigger notif_fin after update on public.carpetas
    for each row execute function public.notif_fin_tramite();

-- Desactivación automática al cumplirse el plazo. Se ejecuta sola cada vez que
-- alguien consulta sus avisos, así no hace falta un programador de tareas.
create or replace function public.aplicar_desactivaciones_automaticas()
returns void
language plpgsql security definer set search_path = public
as $$
begin
    update public.carpetas
       set activa = false, desactivacion_auto_aplicada = true
     where finalizado
       and activa
       and not desactivacion_auto_aplicada
       and fecha_desactivacion_programada is not null
       and fecha_desactivacion_programada <= current_date;
end;
$$;

-- Carpetas finalizadas que el usuario todavía puede ver, con los días hábiles
-- que le quedan para descargar. Alimenta el aviso de cada ingreso y el modal.
create or replace function public.avisos_fin_tramite()
returns table (
    carpeta_id bigint,
    nombre text,
    fecha_fin date,
    fecha_desactivacion date,
    dias_habiles_restantes int,
    activa boolean
)
language plpgsql stable security definer set search_path = public
as $$
begin
    return query
        select c.id, c.nombre, c.fecha_fin_tramite, c.fecha_desactivacion_programada,
               greatest(public.contar_dias_habiles(current_date, c.fecha_desactivacion_programada), 0),
               c.activa
        from public.carpetas c
        where c.finalizado
          and c.fecha_desactivacion_programada is not null
          and public.puede_ver_carpeta(c.id)
        order by c.fecha_desactivacion_programada;
end;
$$;

-- ============================================================
-- 15) DESCARGA POR ARCHIVO: el operador decide qué se puede bajar
-- ============================================================
-- Cada documento lleva una marca "descargable por las partes". El cliente y el
-- acreedor SIEMPRE pueden abrir y leer los documentos de su carpeta; la marca
-- solo decide si además pueden descargarlos (botón "Descargar" y ZIP).
-- Por eso Storage sigue permitiendo la lectura a quien ya tiene acceso a la
-- carpeta: sin leer los bytes no se puede mostrar el documento en pantalla.

alter table public.archivos add column if not exists descargable_partes boolean not null default true;

-- Lectura de documentos: quien tiene acceso a la carpeta puede abrirlos
drop policy if exists "descarga segun carpeta asignada" on storage.objects;
create policy "descarga segun carpeta asignada" on storage.objects
    for select using (
        bucket_id = 'documentos'
        and public.puede_ver_carpeta(public.carpeta_de_ruta(name))
    );

-- Ya no se usa: la marca se aplica en el portal, no en Storage
drop function if exists public.puede_descargar_archivo(text);

-- El operador responsable (o el admin) cambia la disponibilidad de un archivo
create or replace function public.fijar_descarga_partes(archivo bigint, permitir boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    c bigint;
begin
    select carpeta_id into c from public.archivos where id = archivo;
    if c is null then raise exception 'Archivo no encontrado'; end if;
    if not public.puede_subir_a_carpeta(c) then
        raise exception 'Sin permiso para cambiar la descarga de este archivo';
    end if;
    update public.archivos set descargable_partes = permitir where id = archivo;
end;
$$;


-- ############################################################
-- PARTE 3 DE 31: migracion_subcarpetas.sql
-- Subcarpetas
-- ############################################################

-- ============================================================
-- MIGRACIÓN: subcarpetas dentro de una carpeta
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Permite agrupar los documentos del trámite: «Audiencias»,
-- «Notificaciones», «Soportes»…  Es UN SOLO NIVEL: la carpeta
-- sigue siendo el trámite y la subcarpeta solo ordena lo que
-- hay dentro.
--
-- POR QUÉ NO CAMBIAN LAS REGLAS DE ACCESO
-- Las rutas de Storage pasan de
--     <id-carpeta>/<archivo>
-- a
--     <id-carpeta>/<id-subcarpeta>/<archivo>
-- El PRIMER segmento sigue siendo el id de la carpeta, y es lo
-- único que mira carpeta_de_ruta(), de la que dependen todas las
-- políticas del bucket. Verificado: '12/5/acta.pdf' resuelve a 12.
-- ============================================================

create table if not exists public.subcarpetas (
    id          bigint generated always as identity primary key,
    carpeta_id  bigint not null references public.carpetas (id) on delete cascade,
    nombre      text not null check (length(trim(nombre)) between 1 and 60),
    orden       int not null default 1,
    creado_por  uuid references public.perfiles (id) on delete set null,
    creado      timestamptz not null default now(),
    unique (carpeta_id, nombre)
);
create index if not exists idx_subcarpetas_carpeta on public.subcarpetas (carpeta_id, orden);
create index if not exists idx_subcarpetas_creado_por on public.subcarpetas (creado_por);

alter table public.subcarpetas enable row level security;

-- La ven todos los que ven la carpeta (incluye monitor y partes)
drop policy if exists "ver subcarpetas de la carpeta" on public.subcarpetas;
create policy "ver subcarpetas de la carpeta" on public.subcarpetas
    for select using (public.puede_ver_carpeta(carpeta_id));

-- Las gestiona quien puede subir a la carpeta (admin y operador responsable)
drop policy if exists "personal gestiona subcarpetas" on public.subcarpetas;
create policy "personal gestiona subcarpetas" on public.subcarpetas
    for all using (public.puede_subir_a_carpeta(carpeta_id))
        with check (public.puede_subir_a_carpeta(carpeta_id));

-- Un archivo está en una subcarpeta o en la raíz (null).
-- on delete set null: al borrar la subcarpeta los documentos NO se
-- pierden, vuelven a la raíz de la carpeta.
alter table public.archivos
    add column if not exists subcarpeta_id bigint
    references public.subcarpetas (id) on delete set null;
create index if not exists idx_archivos_subcarpeta on public.archivos (subcarpeta_id);


-- ############################################################
-- PARTE 4 DE 31: migracion_seguridad_2026_08.sql
-- Endurecimiento de permisos
-- ############################################################

-- ============================================================
-- CORRECCIONES DE SEGURIDAD Y SALUD: auditoría de 2026-08
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- Este archivo NO depende de n8n. Recoge lo que salió de la
-- auditoría de ingreso, sesión, verificación de rol y límites
-- de uso, más el saneamiento de índices y search_path.
--
-- Contenido:
--   1) Quitar el permiso de ejecución de PUBLIC/anon en las
--      funciones internas (era el hueco más grave).
--   2) Impedir la suplantación de autor en chat_mensajes.
--   3) Límite de uso en "olvidé mi contraseña".
--   4) Índices en las claves foráneas.
--   5) search_path fijo en las utilidades.
-- ============================================================


-- ============================================================
-- 1) PERMISOS DE EJECUCIÓN
-- ============================================================
-- En PostgreSQL toda función nace con EXECUTE concedido a PUBLIC,
-- y Supabase además concede EXECUTE a anon y authenticated por
-- defecto en cada función nueva del esquema public. Un
-- "revoke ... from anon" NO basta: hay que revocar de los tres.
--
-- Sin esto, cualquiera SIN SESIÓN podía llamar por HTTP a
--   POST /rest/v1/rpc/_notificar
-- e insertar avisos falsos en la campana de cualquier usuario
-- del portal (vector de phishing con la apariencia del sitio).
--
-- Las funciones de trigger tampoco necesitan permiso: las
-- dispara PostgreSQL, que las ejecuta como su dueño.
do $$
declare
    f record;
    internas text[] := array[
        '_notificar', '_notificar_admins',
        'crear_perfil_nuevo', 'proteger_ultimo_admin',
        'fijar_autor_mensaje', 'fijar_autor_archivo', 'fijar_autor_chat',
        'notif_mensaje_nuevo', 'notif_archivo_nuevo', 'notif_soporte_nuevo',
        'notif_proceso_cambio', 'notif_carpeta_cambio', 'notif_fin_tramite',
        'actualizar_peso_carpeta', 'tocar_actualizado',
        'generar_notificaciones_vencidos', 'aplicar_desactivaciones_automaticas',
        'rls_auto_enable', 'archivo_descargable_partes'
    ];
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any(internas)
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;

-- Estas dos las invoca el portal desde la sesión del administrador
grant execute on function public.generar_notificaciones_vencidos() to authenticated;
grant execute on function public.aplicar_desactivaciones_automaticas() to authenticated;


-- ============================================================
-- 2) chat_mensajes: impedir que se falsifique el autor
-- ============================================================
-- La política de INSERT solo pedía puede_ver_carpeta(carpeta_id),
-- sin verificar quién dice ser el autor. Un cliente o un acreedor
-- podía insertar un mensaje con rol = 'administrador', el nombre
-- de la entidad y es_ia = true. En un expediente de insolvencia
-- eso es suplantación dentro de una pieza del proceso.
--
-- Mismo patrón que ya usa la tabla 'mensajes': el servidor
-- sobrescribe los campos de autoría con los datos reales.
create or replace function public.fijar_autor_chat()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    p record;
begin
    -- auth.uid() es null cuando escribe un proceso del servidor:
    -- en ese caso se respeta lo enviado.
    if auth.uid() is null then return new; end if;

    select usuario, nombre, rol into p from public.perfiles where id = auth.uid();
    if not found then
        raise exception 'Sin perfil activo: no se puede escribir en el chat';
    end if;
    new.perfil_id      := auth.uid();
    new.autor_usuario  := p.usuario;
    new.autor_nombre   := p.nombre;
    new.rol            := p.rol;
    -- Un humano nunca puede marcar su mensaje como respuesta de la IA
    new.es_ia          := false;
    return new;
end;
$$;
revoke execute on function public.fijar_autor_chat() from public, anon, authenticated;

drop trigger if exists autor_chat on public.chat_mensajes;
create trigger autor_chat before insert on public.chat_mensajes
    for each row execute function public.fijar_autor_chat();

-- Y además en la política, para que quede en dos capas
drop policy if exists "escribir chat en la carpeta" on public.chat_mensajes;
create policy "escribir chat en la carpeta" on public.chat_mensajes
    for insert with check (
        public.puede_ver_carpeta(carpeta_id)
        and perfil_id = auth.uid()
    );


-- ============================================================
-- 3) LÍMITE DE USO en "olvidé mi contraseña"
-- ============================================================
-- solicitar_restablecimiento se llama SIN sesión (es su razón de
-- ser). Ya no repetía solicitudes del mismo usuario, pero nada
-- impedía recorrer una lista de nombres y llenar la campana del
-- administrador con cientos de avisos.
--
-- Se devuelve lo mismo pase lo que pase: no se revela si el
-- usuario existe, ni si se alcanzó el tope.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    TOPE_POR_VENTANA constant int := 10;   -- solicitudes nuevas
    VENTANA constant interval := interval '15 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    -- Tope global: frena el recorrido de nombres de usuario
    select count(*) into recientes
    from public.solicitudes_clave
    where fecha > now() - VENTANA;
    if recientes >= TOPE_POR_VENTANA then return; end if;

    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;

    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

-- Esta sí debe poder llamarla quien no tiene sesión: es el
-- "olvidé mi contraseña" de la pantalla de ingreso.
grant execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ============================================================
-- 4) ÍNDICES EN LAS CLAVES FORÁNEAS
-- ============================================================
-- Una clave foránea sin índice obliga a recorrer la tabla entera
-- cada vez que se borra o actualiza la fila referenciada. Con
-- 'on delete cascade' en casi todas, borrar una carpeta o un
-- perfil recorría varias tablas completas.
-- Crear índices no cambia ningún comportamiento: solo acelera.
create index if not exists idx_actividad_perfil          on public.actividad (perfil_id);
create index if not exists idx_archivos_subido_por       on public.archivos (subido_por);
create index if not exists idx_audiencias_creado_por     on public.audiencias (creado_por);
create index if not exists idx_carpetas_creada_por       on public.carpetas (creada_por);
create index if not exists idx_chat_mensajes_perfil      on public.chat_mensajes (perfil_id);
create index if not exists idx_hoja_trabajo_actualizado  on public.hoja_trabajo (actualizado_por);
create index if not exists idx_llamadas_iniciador        on public.llamadas_soporte (iniciador);
create index if not exists idx_mensajes_destinatario     on public.mensajes (destinatario_id);
create index if not exists idx_mensajes_perfil           on public.mensajes (perfil_id);
create index if not exists idx_soporte_autor             on public.mensajes_soporte (autor_id);
create index if not exists idx_notificaciones_carpeta    on public.notificaciones (carpeta_id);
create index if not exists idx_procesos_completado_por   on public.procesos_tramite (completado_por);
create index if not exists idx_procesos_creado_por       on public.procesos_tramite (creado_por);
create index if not exists idx_procesos_editado_por      on public.procesos_tramite (editado_por);
create index if not exists idx_recordatorios_carpeta     on public.recordatorios (carpeta_id);
create index if not exists idx_solicitudes_resuelta_por  on public.solicitudes_clave (resuelta_por);


-- ============================================================
-- 5) search_path FIJO EN LAS UTILIDADES
-- ============================================================
-- Sin 'set search_path', el camino de búsqueda lo decide quien
-- llama. Las cuatro primeras se usan DENTRO de las reglas de
-- Storage (deciden a qué carpeta pertenece un archivo), así que
-- su comportamiento no debe depender de la sesión que las invoca.
-- Solo usan funciones nativas: fijar el camino no cambia lo que
-- devuelven.
create or replace function public.carpeta_de_ruta(ruta text)
returns bigint language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return ((string_to_array(ruta, '/'))[1])::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_carpeta_de_ruta(ruta text)
returns bigint language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return (split_part(ruta, '/', 2))::bigint;
exception when others then
    return null;
end;
$$;

create or replace function public.chat_canal_de_ruta(ruta text)
returns text language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return split_part(ruta, '/', 3);
exception when others then
    return null;
end;
$$;

create or replace function public.soporte_operador_de_ruta(ruta text)
returns uuid language plpgsql immutable set search_path = pg_catalog, public
as $$
begin
    return (split_part(ruta, '/', 2))::uuid;
exception when others then return null;
end;
$$;

create or replace function public.dias_gracia_cierre()
returns int language sql immutable set search_path = pg_catalog, public
as $$ select 30 $$;

create or replace function public.tocar_actualizado()
returns trigger language plpgsql set search_path = pg_catalog, public
as $$
begin
    new.actualizado := now();
    return new;
end;
$$;
revoke execute on function public.tocar_actualizado() from public, anon, authenticated;


-- ============================================================
-- PENDIENTE (no se aplica aquí)
-- ============================================================
-- a) Activar "Leaked Password Protection" en el panel de Supabase
--    (Authentication → Policies). Es un interruptor, no código.
--
-- b) 21 políticas RLS re-evalúan auth.uid() por fila. La receta de
--    Supabase es envolverlo en (select auth.uid()). Da mejora real
--    A ESCALA, pero implica reescribir 21 reglas de control de
--    acceso a mano, y un error ahí no da un fallo visible: abre un
--    permiso. Hacerlo con pruebas de acceso por rol, no de corrido.
--
-- c) El bucket 'documentos' acepta cualquier tipo de archivo
--    (allowed_mime_types = null). La lista blanca vive solo en el
--    navegador. Fijarla en el servidor requiere revisar antes que
--    ningún archivo ya subido quede fuera.


-- ############################################################
-- PARTE 5 DE 31: migracion_festivos_y_cron.sql
-- Festivos hasta 2030 y la tarea diaria
-- ############################################################

-- ============================================================
-- MIGRACIÓN: festivos 2028-2030 y tarea diaria de plazos
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- 1) FESTIVOS hasta 2030. Antes solo llegaban a 2027: a partir de
--    2028 el semáforo habría calculado plazos legales mal, en
--    silencio. Las fechas se generaron con el algoritmo de Pascua
--    gregoriana + traslado al lunes (Ley 51 de 1983), validado
--    reproduciendo exactamente 2024-2027 antes de usarlo.
--    OJO: la MISMA lista vive en sitio/portal/js/diasHabiles.js. Si se
--    agrega un año aquí, agregarlo allá (y viceversa).
--
-- 2) TAREA DIARIA. Dos procesos del portal no corrían solos:
--      generar_notificaciones_vencidos()  solo hacía algo cuando
--        un ADMINISTRADOR tenía el portal abierto (guard es_admin).
--      aplicar_desactivaciones_automaticas()  solo se disparaba
--        cuando alguien iniciaba sesión.
--    cron_plazos_diario() hace ambas cosas sin guard de sesión y
--    la dispara pg_cron todos los días.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Festivos oficiales de Colombia 2028-2030
-- ------------------------------------------------------------
insert into public.festivos_colombia (fecha, nombre) values
    ('2028-01-01','Año Nuevo'),
    ('2028-01-10','Reyes Magos'),
    ('2028-03-20','San José'),
    ('2028-04-13','Jueves Santo'),
    ('2028-04-14','Viernes Santo'),
    ('2028-05-01','Día del Trabajo'),
    ('2028-05-29','Ascensión del Señor'),
    ('2028-06-19','Corpus Christi'),
    ('2028-06-26','Sagrado Corazón'),
    ('2028-07-03','San Pedro y San Pablo'),
    ('2028-07-20','Independencia de Colombia'),
    ('2028-08-07','Batalla de Boyacá'),
    ('2028-08-21','Asunción de la Virgen'),
    ('2028-10-16','Día de la Raza'),
    ('2028-11-06','Todos los Santos'),
    ('2028-11-13','Independencia de Cartagena'),
    ('2028-12-08','Inmaculada Concepción'),
    ('2028-12-25','Navidad'),
    ('2029-01-01','Año Nuevo'),
    ('2029-01-08','Reyes Magos'),
    ('2029-03-19','San José'),
    ('2029-03-29','Jueves Santo'),
    ('2029-03-30','Viernes Santo'),
    ('2029-05-01','Día del Trabajo'),
    ('2029-05-14','Ascensión del Señor'),
    ('2029-06-04','Corpus Christi'),
    ('2029-06-11','Sagrado Corazón'),
    ('2029-07-02','San Pedro y San Pablo'),
    ('2029-07-20','Independencia de Colombia'),
    ('2029-08-07','Batalla de Boyacá'),
    ('2029-08-20','Asunción de la Virgen'),
    ('2029-10-15','Día de la Raza'),
    ('2029-11-05','Todos los Santos'),
    ('2029-11-12','Independencia de Cartagena'),
    ('2029-12-08','Inmaculada Concepción'),
    ('2029-12-25','Navidad'),
    ('2030-01-01','Año Nuevo'),
    ('2030-01-07','Reyes Magos'),
    ('2030-03-25','San José'),
    ('2030-04-18','Jueves Santo'),
    ('2030-04-19','Viernes Santo'),
    ('2030-05-01','Día del Trabajo'),
    ('2030-06-03','Ascensión del Señor'),
    ('2030-06-24','Corpus Christi'),
    ('2030-07-01','Sagrado Corazón / San Pedro y San Pablo'),
    ('2030-07-20','Independencia de Colombia'),
    ('2030-08-07','Batalla de Boyacá'),
    ('2030-08-19','Asunción de la Virgen'),
    ('2030-10-14','Día de la Raza'),
    ('2030-11-04','Todos los Santos'),
    ('2030-11-11','Independencia de Cartagena'),
    ('2030-12-08','Inmaculada Concepción'),
    ('2030-12-25','Navidad')
on conflict (fecha) do nothing;


-- ------------------------------------------------------------
-- 2) Tarea diaria de plazos
-- ------------------------------------------------------------
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_desactivadas int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Avisar a los administradores de los procesos ya vencidos
    for p in
        select pt.id, pt.nombre, pt.carpeta_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo;
        n_avisos := n_avisos + 1;
    end loop;

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

-- Solo la llama el programador. Nadie por HTTP.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Programación diaria (pg_cron)
-- ------------------------------------------------------------
-- 12:00 UTC = 07:00 en Colombia (UTC-5, sin horario de verano).
-- La propia función descarta fines de semana y festivos.
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule('plazos-diario') where exists (
    select 1 from cron.job where jobname = 'plazos-diario'
);

select cron.schedule(
    'plazos-diario',
    '0 12 * * *',
    $$ select public.cron_plazos_diario(); $$
);


-- ############################################################
-- PARTE 6 DE 31: migracion_notarias.sql
-- Multi-notaría: reescribe puede_ver_carpeta
-- ############################################################

-- ============================================================
-- MIGRACIÓN: varias notarías en un solo portal
-- ------------------------------------------------------------
-- El portal pasa de atender una sola oficina a atender varias.
-- Cada carpeta pertenece a una notaría y cada usuario tiene las
-- notarías donde puede trabajar.
--
-- Regla que gobierna toda la interfaz: si el usuario tiene dos o
-- más notarías, elige al entrar; si tiene una, entra directo y el
-- portal se ve igual que antes. No hay reglas por rol, sale del
-- conteo. Un operador de una sola ciudad no nota el cambio.
--
-- El administrador las ve todas por su rol, sin necesidad de
-- asignárselas una por una.
--
-- Es idempotente: se puede correr más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tablas
-- ------------------------------------------------------------
create table if not exists public.notarias (
    id     bigint generated always as identity primary key,
    nombre text not null check (length(trim(nombre)) between 1 and 80),
    ciudad text not null check (length(trim(ciudad)) between 1 and 60),
    activa boolean not null default true,
    creada timestamptz not null default now(),
    unique (nombre, ciudad)
);

comment on table public.notarias is
    'Oficinas que atiende el portal. La ciudad es lo que se muestra junto a "Portal Documental".';

-- Cada carpeta vive en una notaría
alter table public.carpetas
    add column if not exists notaria_id bigint references public.notarias (id);

-- Notaría de origen del usuario. Para monitor, cliente y acreedor es
-- la única donde trabajan. Para el operador es la primera, y las demás
-- salen de perfil_notarias.
alter table public.perfiles
    add column if not exists notaria_id bigint references public.notarias (id);

-- Operador que atiende varias ciudades: una fila por notaría
create table if not exists public.perfil_notarias (
    perfil_id  uuid   not null references public.perfiles (id) on delete cascade,
    notaria_id bigint not null references public.notarias (id) on delete cascade,
    primary key (perfil_id, notaria_id)
);

create index if not exists idx_carpetas_notaria on public.carpetas (notaria_id);
create index if not exists idx_perfiles_notaria on public.perfiles (notaria_id);
create index if not exists idx_perfil_notarias_perfil on public.perfil_notarias (perfil_id);

-- ------------------------------------------------------------
-- 2) Datos de partida
-- ------------------------------------------------------------
-- Las carpetas y los usuarios que ya existen necesitan una notaría.
-- Se crea una y se les asigna, para poder dejar la columna en
-- not null sin perder nada. El administrador puede renombrarla
-- después desde el portal. En una base vacía no se crea ninguna.
insert into public.notarias (nombre, ciudad)
select 'Notaría principal', 'Sin ciudad'
where not exists (select 1 from public.notarias)
  and (exists (select 1 from public.carpetas) or exists (select 1 from public.perfiles));

update public.carpetas
   set notaria_id = (select min(id) from public.notarias)
 where notaria_id is null;

update public.perfiles
   set notaria_id = (select min(id) from public.notarias)
 where notaria_id is null;

-- Ya no puede haber carpetas sin notaría
alter table public.carpetas alter column notaria_id set not null;

-- Los operadores que ya existían quedan asignados a su notaría de origen
insert into public.perfil_notarias (perfil_id, notaria_id)
select p.id, p.notaria_id
  from public.perfiles p
 where p.rol = 'operador'
   and p.notaria_id is not null
on conflict do nothing;

-- ------------------------------------------------------------
-- 3) Quién puede ver qué notaría
-- ------------------------------------------------------------
-- Importante: esto es SEGURIDAD, no preferencia de pantalla. La
-- notaría que el usuario está mirando en este momento se guarda en
-- el navegador y solo filtra la vista. Lo que decide a qué tiene
-- derecho es esta función, que corre en la base.
create or replace function public.notarias_del_usuario()
returns setof bigint
language sql stable security definer set search_path = public
as $$
    -- El administrador las ve todas por su rol. El monitor NO: aunque
    -- lee todas las carpetas, se le asigna una oficina como a los
    -- demás, que es lo que se pidió.
    select n.id
      from public.notarias n
     where public.es_admin()
    union
    -- Los demás, la suya de origen
    select p.notaria_id
      from public.perfiles p
     where p.id = auth.uid()
       and p.activo
       and p.notaria_id is not null
    union
    -- Y el operador, las que le hayan asignado además
    select pn.notaria_id
      from public.perfil_notarias pn
      join public.perfiles p on p.id = pn.perfil_id
     where pn.perfil_id = auth.uid()
       and p.activo;
$$;

create or replace function public.puede_ver_notaria(notaria bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select notaria is not null
       and notaria in (select public.notarias_del_usuario());
$$;

-- ------------------------------------------------------------
-- 4) El filtro de notaría entra en el punto único de verdad
-- ------------------------------------------------------------
-- puede_ver_carpeta() es de donde cuelgan las políticas y las
-- funciones que listan. Añadir aquí el filtro lo propaga a todo
-- sin tocar quince sitios.
create or replace function public.puede_ver_carpeta(carpeta bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
    select
        -- La carpeta tiene que estar en una notaría del usuario.
        -- El administrador pasa siempre, porque las tiene todas.
        exists (
            select 1 from public.carpetas c
             where c.id = carpeta
               and public.puede_ver_notaria(c.notaria_id)
        )
        and (
            public.es_admin()
            -- El monitor ve todo en solo lectura. Estaba en la base pero
            -- no en esquema.sql: sin esta línea perdería el acceso.
            or public.es_monitor()
            or public.es_operador_de(carpeta)
            or exists (
                select 1
                  from public.carpetas c
                  join public.carpeta_asignados a on a.carpeta_id = c.id
                 where c.id = carpeta
                   and c.activa
                   and a.perfil_id = auth.uid()
                   and public.rol_actual() is not null
            )
        );
$$;

-- Las políticas de lectura de carpetas heredan el mismo filtro.
-- Se reescriben apoyándose en puede_ver_carpeta para que exista
-- un solo lugar donde cambiar las reglas.
drop policy if exists "admin ve todas las carpetas" on public.carpetas;
create policy "admin ve todas las carpetas" on public.carpetas
    for select using (public.es_admin() and public.puede_ver_notaria(notaria_id));

drop policy if exists "operador ve sus carpetas" on public.carpetas;
create policy "operador ve sus carpetas" on public.carpetas
    for select using (public.es_operador_de(id) and public.puede_ver_notaria(notaria_id));

drop policy if exists "asignados ven sus carpetas activas" on public.carpetas;
create policy "asignados ven sus carpetas activas" on public.carpetas
    for select using (
        activa
        and public.rol_actual() is not null
        and public.puede_ver_notaria(notaria_id)
        and exists (
            select 1 from public.carpeta_asignados a
            where a.carpeta_id = id and a.perfil_id = auth.uid()
        )
    );

drop policy if exists "monitor ve todas las carpetas" on public.carpetas;
create policy "monitor ve todas las carpetas" on public.carpetas
    for select using (public.es_monitor() and public.puede_ver_notaria(notaria_id));

-- ------------------------------------------------------------
-- 5) Seguridad de las tablas nuevas
-- ------------------------------------------------------------
alter table public.notarias        enable row level security;
alter table public.perfil_notarias enable row level security;

-- Cada quien ve las notarías donde puede trabajar. Sin esto, la
-- pantalla de selección le mostraría oficinas ajenas.
drop policy if exists "ver mis notarias" on public.notarias;
create policy "ver mis notarias" on public.notarias
    for select using (id in (select public.notarias_del_usuario()));

drop policy if exists "admin crea notarias" on public.notarias;
create policy "admin crea notarias" on public.notarias
    for insert with check (public.es_admin());

drop policy if exists "admin edita notarias" on public.notarias;
create policy "admin edita notarias" on public.notarias
    for update using (public.es_admin()) with check (public.es_admin());

-- No hay política de borrado a propósito: una notaría con carpetas
-- no se elimina, se desactiva. Borrarla dejaría expedientes huérfanos.

drop policy if exists "ver asignaciones de notaria" on public.perfil_notarias;
create policy "ver asignaciones de notaria" on public.perfil_notarias
    for select using (public.es_admin() or perfil_id = auth.uid());

drop policy if exists "admin asigna notarias" on public.perfil_notarias;
create policy "admin asigna notarias" on public.perfil_notarias
    for all using (public.es_admin()) with check (public.es_admin());

-- ------------------------------------------------------------
-- 6) Funciones que usa el portal
-- ------------------------------------------------------------

-- Notarías donde el usuario puede entrar, con el conteo de carpetas
-- activas de cada una. El conteo alimenta la pantalla de selección.
create or replace function public.mis_notarias()
returns table (id bigint, nombre text, ciudad text, activa boolean, carpetas bigint)
language sql stable security definer set search_path = public
as $$
    select n.id, n.nombre, n.ciudad, n.activa,
           (select count(*) from public.carpetas c
             where c.notaria_id = n.id and c.activa)
      from public.notarias n
     where n.id in (select public.notarias_del_usuario())
       and n.activa
     order by n.ciudad, n.nombre;
$$;

-- Alta de notaría (solo administrador)
create or replace function public.notaria_crear(p_nombre text, p_ciudad text)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    nuevo bigint;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede crear notarías.';
    end if;
    insert into public.notarias (nombre, ciudad)
         values (trim(p_nombre), trim(p_ciudad))
      returning id into nuevo;
    return nuevo;
end;
$$;

-- Renombrar o activar/desactivar una notaría
create or replace function public.notaria_editar(
    p_id bigint, p_nombre text, p_ciudad text, p_activa boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede editar notarías.';
    end if;
    update public.notarias
       set nombre = coalesce(nullif(trim(p_nombre), ''), nombre),
           ciudad = coalesce(nullif(trim(p_ciudad), ''), ciudad),
           activa = coalesce(p_activa, activa)
     where id = p_id;
end;
$$;

-- Fija en qué notarías puede trabajar un operador. Reemplaza la lista
-- completa: lo que no venga en el arreglo se le quita.
create or replace function public.perfil_notarias_fijar(
    p_perfil uuid, p_notarias bigint[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
    rol_destino text;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede asignar notarías.';
    end if;

    select rol into rol_destino from public.perfiles where id = p_perfil;
    if rol_destino is null then
        raise exception 'El usuario no existe.';
    end if;

    -- El administrador las tiene todas por su rol: asignárselas una por
    -- una no aporta nada y confundiría al leer la tabla.
    if rol_destino = 'administrador' then
        delete from public.perfil_notarias where perfil_id = p_perfil;
        return;
    end if;

    -- Monitor, cliente y acreedor trabajan en una sola oficina. Se les
    -- fija como notaría de origen y no se les crean filas extra.
    if rol_destino <> 'operador' then
        if array_length(p_notarias, 1) is distinct from 1 then
            raise exception 'Este rol trabaja en una sola notaría.';
        end if;
        update public.perfiles set notaria_id = p_notarias[1] where id = p_perfil;
        delete from public.perfil_notarias where perfil_id = p_perfil;
        return;
    end if;

    -- Operador: puede tener varias
    if coalesce(array_length(p_notarias, 1), 0) = 0 then
        raise exception 'El operador necesita al menos una notaría.';
    end if;

    delete from public.perfil_notarias
     where perfil_id = p_perfil
       and notaria_id <> all (p_notarias);

    insert into public.perfil_notarias (perfil_id, notaria_id)
    select p_perfil, unnest(p_notarias)
    on conflict do nothing;

    -- La de origen queda como la primera de la lista, para que el
    -- portal tenga a dónde entrar si alguna vez queda con una sola
    update public.perfiles set notaria_id = p_notarias[1] where id = p_perfil;
end;
$$;

-- Notarías de un usuario concreto, para pintar las casillas al editarlo
create or replace function public.notarias_de_perfil(p_perfil uuid)
returns setof bigint
language sql stable security definer set search_path = public
as $$
    select notaria_id from public.perfil_notarias where perfil_id = p_perfil
    union
    select notaria_id from public.perfiles
     where id = p_perfil and notaria_id is not null;
$$;

-- ------------------------------------------------------------
-- 7) Crear carpeta dentro de una notaría
-- ------------------------------------------------------------
-- La carpeta nueva cae en la notaría que el portal tenga abierta. Se
-- valida que el usuario tenga derecho a esa oficina: si no, podría
-- crear expedientes en una notaría ajena.
create or replace function public.carpeta_fijar_notaria(
    p_carpeta bigint, p_notaria bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede mover una carpeta de notaría.';
    end if;
    if not public.puede_ver_notaria(p_notaria) then
        raise exception 'Notaría no permitida.';
    end if;
    update public.carpetas set notaria_id = p_notaria where id = p_carpeta;
end;
$$;

-- ------------------------------------------------------------
-- 8) Permisos de ejecución
-- ------------------------------------------------------------
-- En PostgreSQL toda función nace con EXECUTE concedido a PUBLIC, y
-- Supabase además concede a anon y authenticated. Revocar solo de anon
-- no basta: el rol hereda de PUBLIC. Hay que revocar de los tres y
-- volver a conceder a quien de verdad lo necesita.
do $$
declare f record;
begin
    for f in
        select oid::regprocedure as firma
          from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('notarias_del_usuario', 'puede_ver_notaria', 'mis_notarias',
                           'notaria_crear', 'notaria_editar', 'perfil_notarias_fijar',
                           'notarias_de_perfil', 'carpeta_fijar_notaria')
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
        execute format('grant  execute on function %s to authenticated', f.firma);
    end loop;
end $$;

-- notarias_del_usuario y puede_ver_notaria SÍ necesitan EXECUTE para
-- 'authenticated', aunque solo las llamen las políticas.
--
-- Las políticas RLS se evalúan con los privilegios de QUIEN CONSULTA,
-- no con los del dueño de la tabla. puede_ver_notaria aparece en las
-- cuatro políticas de lectura de carpetas y notarias_del_usuario en la
-- de notarias: sin este permiso, leer carpetas falla con
-- "permission denied for function puede_ver_notaria" para todos los
-- roles, y el portal se queda sin datos.
--
-- Exponerlas no filtra nada: ambas resuelven desde auth.uid(), así que
-- cada usuario solo obtiene lo suyo.
grant execute on function public.notarias_del_usuario()     to authenticated;
grant execute on function public.puede_ver_notaria(bigint)  to authenticated;


-- ############################################################
-- PARTE 7 DE 31: migracion_avisos_plazo.sql
-- Avisos del plazo a 4, 3, 2, 1 semanas, 1 día y el mismo día
-- ############################################################

-- ============================================================
-- MIGRACIÓN: avisos del plazo del trámite (60/90 días hábiles)
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ FALTABA
--   El portal ya avisaba cuando un PROCESO se pasaba del plazo
--   ('proceso-vencido'), es decir, cuando ya era tarde y solo al
--   administrador. Del plazo del TRÁMITE completo (los 60 días
--   hábiles de la Ley 1564, o 90 con prórroga) no avisaba nada.
--
-- QUÉ HACE AHORA
--   Seis avisos, a todos los que están dentro de la carpeta:
--     4 semanas antes   (28 días de calendario)
--     3 semanas antes   (21)
--     2 semanas antes   (14)
--     1 semana antes    (7)
--     1 día antes       (1)
--     el mismo día      (0)
--
-- POR QUÉ DÍAS DE CALENDARIO Y NO HÁBILES
--   El aviso es un recordatorio, no un cómputo legal. "4 semanas
--   antes" significa cuatro semanas de calendario para quien lo
--   recibe. La fecha de vencimiento que se anuncia sí está
--   calculada en días hábiles: la calculó calcular_vencimiento_habil
--   al iniciar el trámite, saltando fines de semana y festivos.
--
-- SI EL DÍA EXACTO CAE EN FIN DE SEMANA O FESTIVO
--   La tarea diaria no corre esos días. El hito no se pierde: la
--   condición es "faltan N días o menos" y cada hito se manda una
--   sola vez, así que el lunes siguiente sale el aviso pendiente.
--   Nunca salen varios hitos atrasados de golpe: solo el más
--   cercano al vencimiento.
--
-- PRÓRROGA Y PAUSA
--   Ambas mueven la fecha de vencimiento hacia adelante. Los avisos
--   ya mandados quedarían bloqueando los nuevos, así que el trigger
--   de la carpeta los borra y la cuenta empieza otra vez con la
--   fecha nueva.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Quién está "dentro" de una carpeta
-- ------------------------------------------------------------
-- Operadores responsables, partes asignadas (cliente y acreedores),
-- los administradores (ven todas las notarías) y los monitores de la
-- notaría de esa carpeta. Solo perfiles activos.
--
-- OJO: es security definer y devuelve ids de perfiles, así que NO se
-- expone a los usuarios: solo la llama la tarea diaria.
create or replace function public.destinatarios_de_carpeta(p_carpeta bigint)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    -- Operadores responsables
    select o.perfil_id
      from public.carpeta_operadores o
      join public.perfiles p on p.id = o.perfil_id and p.activo
     where o.carpeta_id = p_carpeta
    union
    -- Partes: cliente y acreedores
    select a.perfil_id
      from public.carpeta_asignados a
      join public.perfiles p on p.id = a.perfil_id and p.activo
     where a.carpeta_id = p_carpeta
    union
    -- Administradores: ven todas las notarías
    select p.id
      from public.perfiles p
     where p.rol = 'administrador' and p.activo
    union
    -- Monitores, solo los de la notaría de la carpeta
    select p.id
      from public.perfiles p
      join public.carpetas c on c.id = p_carpeta
     where p.rol = 'monitor' and p.activo
       and c.notaria_id is not null
       and c.notaria_id in (select public.notarias_de_perfil(p.id));
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'destinatarios_de_carpeta'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 2) Los avisos del plazo
-- ------------------------------------------------------------
-- Devuelve cuántos avisos generó (para el registro de la tarea).
create or replace function public.avisar_plazos_tramite()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    -- De más lejos a más cerca. Días de CALENDARIO que faltan.
    -- Las variables van con prefijo v_ porque sin él "tipo" y
    -- "mensaje" chocan con las columnas de notificaciones y plpgsql
    -- aborta con "column reference is ambiguous".
    hitos constant int[] := array[28, 21, 14, 7, 1, 0];
    c          record;
    d          record;
    v_faltan   int;
    v_hito     int;
    v_tipo     text;
    v_cuando   text;
    v_mensaje  text;
    n_avisos   int := 0;
begin
    for c in
        select id, nombre, fecha_vencimiento_tramite
          from public.carpetas
         where activa
           and not finalizado
           and not pausado                        -- en pausa el reloj está detenido
           and fecha_vencimiento_tramite is not null
    loop
        v_faltan := c.fecha_vencimiento_tramite - current_date;

        -- Ya vencido: de eso avisa 'proceso-vencido', no este aviso
        if v_faltan < 0 then continue; end if;

        -- El hito más cercano al vencimiento que ya se alcanzó. Si
        -- faltan 26 días (el hito de 28 cayó en festivo), sale el de
        -- 4 semanas; si faltan 40, todavía no sale ninguno.
        select min(h) into v_hito from unnest(hitos) as h where v_faltan <= h;
        if v_hito is null then continue; end if;

        v_tipo := 'plazo-' || v_hito;

        -- Cada hito, una sola vez por carpeta
        if exists (
            select 1 from public.notificaciones n
             where n.tipo = v_tipo and n.referencia_id = c.id
        ) then continue; end if;

        v_cuando := case v_hito
            when 28 then 'Faltan 4 semanas'
            when 21 then 'Faltan 3 semanas'
            when 14 then 'Faltan 2 semanas'
            when  7 then 'Falta 1 semana'
            when  1 then 'Falta 1 día'
            else         'Hoy'
        end;

        v_mensaje := case
            when v_hito = 0 then
                'Hoy se cumple el plazo del trámite «' || c.nombre || '»'
            else
                v_cuando || ' para que se cumpla el plazo del trámite «' || c.nombre ||
                '»: vence el ' || to_char(c.fecha_vencimiento_tramite, 'DD/MM/YYYY')
        end;

        for d in select perfil from public.destinatarios_de_carpeta(c.id) as perfil loop
            perform public._notificar(d.perfil, v_tipo, v_mensaje, c.id, c.id);
            n_avisos := n_avisos + 1;
        end loop;
    end loop;

    return n_avisos;
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'avisar_plazos_tramite'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Prórroga y reactivación: la cuenta empieza de nuevo
-- ------------------------------------------------------------
-- Se reemplaza el trigger que ya existía, conservando lo que hacía
-- (avisar a los administradores de pausa, reactivación y prórroga) y
-- añadiendo el borrado de los avisos de plazo cuando la fecha de
-- vencimiento se mueve.
create or replace function public.notif_carpeta_cambio()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
    if new.pausado is distinct from old.pausado then
        perform public._notificar_admins(case when new.pausado then 'tramite-pausado' else 'tramite-reactivado' end,
            'El trámite «' || new.nombre || '» fue ' || case when new.pausado then 'pausado' else 'reactivado' end,
            new.id, null);
    end if;
    if new.tiene_prorroga and not old.tiene_prorroga then
        perform public._notificar_admins('tramite-prorroga',
            'Se aplicó la prórroga (90 días hábiles) al trámite «' || new.nombre || '»',
            new.id, null);
    end if;

    -- La fecha de vencimiento se movió (prórroga, o reactivación tras
    -- una pausa): los avisos viejos ya no valen y además bloquearían
    -- los nuevos, porque cada hito se manda una sola vez.
    if new.fecha_vencimiento_tramite is distinct from old.fecha_vencimiento_tramite then
        delete from public.notificaciones
         where referencia_id = new.id
           and tipo in ('plazo-28', 'plazo-21', 'plazo-14', 'plazo-7', 'plazo-1', 'plazo-0');
    end if;

    return new;
end;
$$;

drop trigger if exists notif_carpeta on public.carpetas;
create trigger notif_carpeta after update on public.carpetas
    for each row execute function public.notif_carpeta_cambio();


-- ------------------------------------------------------------
-- 4) Engancharlo a la tarea diaria
-- ------------------------------------------------------------
-- Misma tarea de siempre (fines de semana y festivos fuera), ahora
-- con los avisos del plazo del trámite.
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_desactivadas int := 0;
    n_plazos int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Avisar a los administradores de los procesos ya vencidos
    for p in
        select pt.id, pt.nombre, pt.carpeta_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id, referencia_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo;
        n_avisos := n_avisos + 1;
    end loop;

    -- Avisar del plazo del trámite a todos los de la carpeta
    n_plazos := public.avisar_plazos_tramite();

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'avisos_de_plazo', n_plazos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ############################################################
-- PARTE 8 DE 31: migracion_notificaciones_por_notaria.sql
-- Los avisos no se mezclan entre oficinas, y el correo obligatorio por rol
-- ############################################################

-- ============================================================
-- MIGRACIÓN: las notificaciones no se mezclan entre notarías
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   El reparto de notificaciones se escribió cuando había una sola
--   notaría, así que decía «a todos los administradores» sin más.
--   Con cuatro notarías, un administrador de Santa Marta recibía los
--   avisos de Medellín, Barranquilla y Bogotá. No es una fuga de datos
--   (la RLS de notificaciones siempre fue destinatario_id = auth.uid())
--   pero sí es ruido que hace inservible la campana: entre veinte avisos
--   ajenos se pierde el propio.
--
--   Cuatro sitios repartían sin filtrar:
--     _notificar_admins()                  pausa, prórroga, procesos
--     generar_notificaciones_vencidos()    procesos vencidos
--     cron_plazos_diario()                 procesos vencidos, tarea diaria
--     destinatarios_de_carpeta()           avisos del plazo del trámite
--
-- LA SOLUCIÓN, EN DOS CAPAS
--   1) REPARTO. Cada aviso va solo a quien alcanza esa notaría. Se
--      resuelve con perfil_alcanza_notaria().
--   2) VISTA. notificaciones gana la columna notaria_id, y la campana
--      del portal filtra por la notaría abierta. Así un administrador
--      con acceso a dos oficinas ve una campana por oficina en vez de
--      las dos revueltas.
--
-- EL ADMINISTRADOR GLOBAL
--   Un administrador SIN notaría asignada sigue recibiendo todo: es el
--   dueño del portal y así se comportaba antes. Uno CON notaría
--   asignada recibe solo la suya. La diferencia la marca tener o no
--   filas en perfil_notarias / perfiles.notaria_id, que es el mismo
--   criterio que ya usa notarias_del_usuario() para la seguridad.
-- ============================================================


-- ------------------------------------------------------------
-- 1) La columna de notaría en las notificaciones
-- ------------------------------------------------------------
-- Se guarda en la fila en vez de deducirla con un join contra carpetas
-- porque el cliente filtra por ella en cada refresco de la campana, y
-- porque hay avisos sin carpeta (soporte, ingreso, solicitud de clave)
-- que no pertenecen a ninguna oficina.
alter table public.notificaciones
    add column if not exists notaria_id bigint references public.notarias (id) on delete cascade;

-- El índice de la campana: mis avisos, de esta notaría, sin leer.
create index if not exists idx_notif_dest_notaria
    on public.notificaciones (destinatario_id, notaria_id, leido, fecha desc);

-- Las que ya existen: se deduce de su carpeta. Las que no tienen
-- carpeta se quedan en null a propósito y se ven siempre.
update public.notificaciones n
   set notaria_id = c.notaria_id
  from public.carpetas c
 where c.id = n.carpeta_id
   and n.notaria_id is null;


-- ------------------------------------------------------------
-- 2) ¿Este perfil alcanza esta notaría?
-- ------------------------------------------------------------
-- Sin notarías asignadas = administrador global, lo recibe todo.
-- Aviso sin notaría (soporte, ingreso) = lo recibe todo el mundo.
create or replace function public.perfil_alcanza_notaria(p_perfil uuid, p_notaria bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select case
        when p_perfil is null then false
        when p_notaria is null then true
        when not exists (select 1 from public.notarias_de_perfil(p_perfil)) then true
        else p_notaria in (select public.notarias_de_perfil(p_perfil))
    end;
$$;

-- La llaman funciones internas, no el cliente.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'perfil_alcanza_notaria'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Al insertar el aviso, se sella la notaría
-- ------------------------------------------------------------
-- Un solo sitio la escribe, así que ninguna ruta se puede olvidar.
create or replace function public._notificar(destino uuid, p_tipo text, p_mensaje text,
                                             p_carpeta bigint default null,
                                             p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    v_notaria bigint;
begin
    if destino is null then return; end if;
    if p_carpeta is not null then
        select notaria_id into v_notaria from public.carpetas where id = p_carpeta;
    end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    values (destino, left(coalesce(p_tipo, ''), 40), left(coalesce(p_mensaje, ''), 300),
            p_carpeta, p_ref, v_notaria);
end;
$$;


-- ------------------------------------------------------------
-- 4) A los administradores, solo los de esa notaría
-- ------------------------------------------------------------
create or replace function public._notificar_admins(p_tipo text, p_mensaje text,
                                                    p_carpeta bigint default null,
                                                    p_ref bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    a record;
    v_notaria bigint;
begin
    -- Sin carpeta no hay notaría (soporte): va a todos, como antes.
    if p_carpeta is not null then
        select notaria_id into v_notaria from public.carpetas where id = p_carpeta;
    end if;

    for a in
        select p.id
          from public.perfiles p
         where p.rol = 'administrador'
           and p.activo
           and p.id is distinct from auth.uid()
           and public.perfil_alcanza_notaria(p.id, v_notaria)
    loop
        perform public._notificar(a.id, p_tipo, p_mensaje, p_carpeta, p_ref);
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 5) Procesos vencidos: mismo filtro
-- ------------------------------------------------------------
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id);
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 6) Los avisos del plazo: el administrador se acota igual que el monitor
-- ------------------------------------------------------------
create or replace function public.destinatarios_de_carpeta(p_carpeta bigint)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    -- Operadores responsables
    select o.perfil_id
      from public.carpeta_operadores o
      join public.perfiles p on p.id = o.perfil_id and p.activo
     where o.carpeta_id = p_carpeta
    union
    -- Partes: cliente y acreedores
    select a.perfil_id
      from public.carpeta_asignados a
      join public.perfiles p on p.id = a.perfil_id and p.activo
     where a.carpeta_id = p_carpeta
    union
    -- Administradores que alcanzan la notaría de la carpeta.
    -- Uno sin notaría asignada es global y sigue recibiendo todo.
    select p.id
      from public.perfiles p
      join public.carpetas c on c.id = p_carpeta
     where p.rol = 'administrador' and p.activo
       and public.perfil_alcanza_notaria(p.id, c.notaria_id)
    union
    -- Monitores: solo los de esa notaría, sin excepción de global
    select p.id
      from public.perfiles p
      join public.carpetas c on c.id = p_carpeta
     where p.rol = 'monitor' and p.activo
       and c.notaria_id is not null
       and c.notaria_id in (select public.notarias_de_perfil(p.id));
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'destinatarios_de_carpeta'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 7) La tarea diaria, con el mismo filtro en los vencidos
-- ------------------------------------------------------------
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_desactivadas int := 0;
    n_plazos int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Procesos ya vencidos, solo a los administradores de esa notaría
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
          and not exists (
              select 1 from public.notificaciones n
              where n.tipo = 'proceso-vencido' and n.referencia_id = pt.id
          )
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               'El proceso «' || p.nombre || '» de «' || coalesce(nom, '') || '» se pasó del plazo',
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id);
        n_avisos := n_avisos + 1;
    end loop;

    -- Avisos del plazo del trámite a todos los de la carpeta
    n_plazos := public.avisar_plazos_tramite();

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'avisos_de_plazo', n_plazos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 8) Correo obligatorio según el rol
-- ------------------------------------------------------------
-- El correo se usa para los avisos de audiencia y del trámite, así que
-- operador, cliente y acreedor lo necesitan. Administrador y monitor
-- entran al portal y ven la campana ahí mismo: para ellos es opcional.
--
-- POR QUÉ UN TRIGGER Y NO UNA RESTRICCIÓN CHECK
--   Se intentó primero con un CHECK y rompió la creación de usuarios
--   entera. El trigger crear_perfil_nuevo genera todo perfil como
--   'cliente' con correo nulo, y la Edge Function le pone el rol y el
--   correo un paso después: el CHECK se evalúa también al INSERTAR, así
--   que reventaba antes de que nadie tuviera ocasión de poner el correo.
--
--   Con un trigger BEFORE UPDATE el perfil puede NACER sin correo,
--   durante el instante que la Edge Function tarda en completarlo, pero
--   no se puede GUARDAR sin él. La regla se mantiene y la creación
--   funciona.
alter table public.perfiles drop constraint if exists perfiles_correo_obligatorio;

create or replace function public.exigir_correo_por_rol()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Administrador y monitor entran al portal y ven la campana ahí
    -- mismo: para ellos el correo es opcional.
    if new.rol in ('administrador', 'monitor') then
        return new;
    end if;

    -- Operador, cliente y acreedor reciben por correo los avisos de
    -- audiencia y del trámite, así que sin correo no se guardan.
    if new.correo is null or btrim(new.correo) = '' then
        raise exception 'El rol «%» necesita un correo de contacto: por ahí le llegan los avisos del trámite.', new.rol
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists exigir_correo on public.perfiles;
create trigger exigir_correo
    before update on public.perfiles
    for each row execute function public.exigir_correo_por_rol();


-- ############################################################
-- PARTE 9 DE 31: migracion_credenciales.sql
-- Las contraseñas asignadas, para el Excel
-- ############################################################

-- ============================================================
-- MIGRACIÓN: credenciales asignadas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ NO SE PUEDE "MOSTRAR LA CONTRASEÑA ACTUAL"
--   auth.users guarda la contraseña como hash bcrypt ($2a$10$...), que
--   es de una sola dirección. El texto original no está guardado en
--   ninguna parte: ni Supabase, ni el dueño de la base, ni nadie con la
--   service_role key puede leerlo, porque no existe. No es una
--   restricción que se pueda saltar; es cómo funciona un hash.
--
-- LO QUE SÍ SE PUEDE, Y RESUELVE EL MISMO PROBLEMA
--   En este portal NO hay cambio de contraseña por cuenta propia: no
--   existe ninguna pantalla donde el usuario se la cambie. TODAS las
--   contraseñas las pone el administrador, al crear la cuenta o al
--   restablecerla. Así que guardar lo que el administrador escribe no
--   recupera nada: anota lo que él mismo eligió. Y como nadie más la
--   cambia, ese valor coincide siempre con la contraseña vigente.
--
--   Resultado práctico: el Excel de usuarios sale con las credenciales
--   y no hay que restablecerle la clave a nadie cada vez que la olvida.
--
-- EL RIESGO, DICHO CLARO
--   Estas contraseñas quedan legibles para cualquiera con acceso de
--   administrador o con un volcado de la base, y son de clientes y
--   acreedores reales, que además suelen repetir contraseña en otros
--   sitios. Por eso van en tabla aparte con RLS de solo administrador,
--   y no como columna de perfiles: así no se escapan en un select *.
--
--   Las cuentas creadas ANTES de esta migración salen "(sin anotar)".
--   Para que aparezcan hay que restablecerles la clave una vez.
-- ============================================================

create table if not exists public.credenciales (
    perfil_id       uuid primary key references public.perfiles (id) on delete cascade,
    clave           text not null,
    actualizada     timestamptz not null default now(),
    actualizada_por uuid references public.perfiles (id) on delete set null
);

alter table public.credenciales enable row level security;

drop policy if exists "admin gestiona credenciales" on public.credenciales;
create policy "admin gestiona credenciales" on public.credenciales
    for all using (public.es_admin()) with check (public.es_admin());


-- Guardar la clave que el administrador acaba de asignar.
-- Recibe el usuario y no el uuid porque es lo que el cliente tiene a
-- mano después de crear la cuenta.
create or replace function public.credencial_fijar(p_usuario text, p_clave text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
begin
    if not public.es_admin() then
        raise exception 'Solo un administrador puede guardar credenciales';
    end if;
    if coalesce(p_clave, '') = '' then return; end if;

    -- Usuario inexistente: se sale en silencio, no se crea basura
    select id into v_id from public.perfiles where usuario = lower(trim(p_usuario));
    if v_id is null then return; end if;

    insert into public.credenciales (perfil_id, clave, actualizada, actualizada_por)
    values (v_id, p_clave, now(), auth.uid())
    on conflict (perfil_id) do update
        set clave = excluded.clave,
            actualizada = now(),
            actualizada_por = excluded.actualizada_por;
end;
$$;

revoke execute on function public.credencial_fijar(text, text) from public, anon;
grant execute on function public.credencial_fijar(text, text) to authenticated;


-- ############################################################
-- PARTE 10 DE 31: migracion_tipo_proceso.sql
-- El régimen de la carpeta
-- ############################################################

-- ============================================================
-- MIGRACIÓN: el tipo de proceso de la carpeta
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ EXISTE ESTE ARCHIVO
--   La columna `carpetas.tipo_proceso` se creó a mano en el panel de
--   Supabase y nunca quedó escrita en una migración. El proyecto de la
--   nube la tenía; el repositorio, no. Mientras hubo un solo servidor
--   la diferencia no se notó.
--
--   Se notó al instalar el portal en un servidor propio siguiendo los
--   SQL del repositorio: la base nació sin la columna y guardar una
--   carpeta fallaba con
--
--     PGRST204: Could not find the 'tipo_proceso' column of 'carpetas'
--               in the schema cache
--
--   Este archivo cierra esa diferencia. Correrlo en la nube no cambia
--   nada, porque la columna ya está.
-- ============================================================

alter table public.carpetas add column if not exists tipo_proceso text;

-- Los dos regímenes que maneja el portal (TIPOS_PROCESO en app.js).
-- Se admite null: las carpetas viejas se crearon antes de que el campo
-- existiera y la tarjeta simplemente no muestra la etiqueta.
alter table public.carpetas drop constraint if exists carpetas_tipo_proceso_check;
alter table public.carpetas add constraint carpetas_tipo_proceso_check
    check (tipo_proceso is null
           or tipo_proceso in ('natural_no_comerciante', 'pequeno_comerciante'));

-- PostgREST guarda el mapa de columnas en memoria. Sin este aviso sigue
-- respondiendo que la columna no existe hasta que alguien lo reinicie.
notify pgrst, 'reload schema';


-- ############################################################
-- PARTE 11 DE 31: migracion_almacenamiento.sql
-- La barra de espacio lee el disco de verdad
-- ############################################################

-- ============================================================
-- MIGRACIÓN: el almacenamiento se mide, no se escribe a mano
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   La barra de almacenamiento llevaba el tope escrito en el código
--   (50 MB, que además era el límite POR ARCHIVO, no el total). Un
--   número a mano miente el día que se cambia de disco o de plan.
--
-- POR QUÉ NO SE PUEDE LEER EL DISCO DIRECTAMENTE
--   El navegador no ve el disco del servidor, y Postgres tampoco:
--   sabe cuánto pesa su base, pero no cuánto queda libre en el
--   sistema de archivos. Quien sí lo sabe es el propio servidor.
--
-- LA SOLUCIÓN
--   Una tarea del sistema corre `df` cada pocos minutos y escribe una
--   fila aquí. El portal la lee por la API de siempre, con su RLS.
--   Sin servicios nuevos, sin puertos nuevos, sin agentes.
--
--   Si la tabla está vacía (por ejemplo en Supabase Cloud, donde no
--   hay tarea que la llene), el portal cae de vuelta al valor de
--   config.js. Así el mismo código sirve en los dos sitios.
-- ============================================================

create table if not exists public.almacenamiento (
    id          int primary key default 1 check (id = 1),  -- una sola fila
    total_mb    numeric not null default 0,
    usado_mb    numeric not null default 0,
    libre_mb    numeric not null default 0,
    -- Lo que ocupan los expedientes, aparte del sistema y la base
    docs_mb     numeric not null default 0,
    actualizado timestamptz not null default now()
);

insert into public.almacenamiento (id) values (1) on conflict (id) do nothing;

alter table public.almacenamiento enable row level security;

-- EL PERMISO DE TABLA, EXPLÍCITO
--   En Supabase Cloud las tablas nuevas heredan los grants por las
--   default privileges del proyecto. En autohospedado esa herencia no
--   está configurada igual, así que una tabla creada por `postgres`
--   nace sin permisos para `authenticated` y la consulta devuelve
--   vacío sin dar error: el portal cree que no hay medición y cae al
--   valor de config.js. Se concede a mano para que no dependa de eso.
grant select on public.almacenamiento to authenticated;

-- Solo administradores. La ocupación del disco dice cuánta carga lleva
-- la notaría, y eso no es asunto de clientes, acreedores ni operadores.
-- Coincide con la barra del portal, que solo se le pinta al admin.
drop policy if exists "ver almacenamiento" on public.almacenamiento;
create policy "ver almacenamiento" on public.almacenamiento
    for select using (public.es_admin());


-- Registrar la medición. La llama la tarea del sistema por psql, no
-- el portal: por eso queda fuera del alcance de anon y authenticated.
create or replace function public.almacenamiento_registrar(
    p_total_mb numeric, p_usado_mb numeric, p_libre_mb numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_docs numeric;
begin
    -- El peso de los expedientes ya viene cacheado por carpeta
    select coalesce(sum(peso_total_mb), 0) into v_docs from public.carpetas;

    insert into public.almacenamiento (id, total_mb, usado_mb, libre_mb, docs_mb, actualizado)
    values (1, p_total_mb, p_usado_mb, p_libre_mb, v_docs, now())
    on conflict (id) do update
        set total_mb = excluded.total_mb,
            usado_mb = excluded.usado_mb,
            libre_mb = excluded.libre_mb,
            docs_mb  = excluded.docs_mb,
            actualizado = now();
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'almacenamiento_registrar'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ############################################################
-- PARTE 12 DE 31: migracion_tope_archivo.sql
-- 500 MB por archivo, para las grabaciones de audiencias
-- ############################################################

-- ============================================================
-- MIGRACIÓN: 500 MB por archivo, para que quepan las audiencias
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   El bucket aceptaba 50 MB por archivo. La subcarpeta de audiencias
--   existe para guardar grabaciones, y una hora de video no baja de
--   unos 300 MB en calidad alta ni de 100 en calidad normal. O sea que
--   el sitio hecho para videos rechazaba los videos.
--
-- POR QUÉ 500 Y NO MÁS
--   La subida va en una sola petición: no es reanudable. Si se corta a
--   la mitad hay que repetirla entera, y el navegador tiene el archivo
--   completo en memoria mientras tanto. A 500 MB eso ya es una espera
--   larga en una conexión colombiana corriente, que es justo por lo que
--   el portal avisa de comprimir el video antes de subirlo. Para pasar
--   de aquí habría que implementar subida reanudable (TUS), que es otro
--   trabajo.
--
-- HAY QUE CAMBIARLO EN TRES SITIOS, NO EN UNO
--   1. Aquí, el bucket (lo que Storage acepta).
--   2. `TAMANO_MAXIMO` en app.js (lo que el navegador deja escoger).
--   3. `FILE_SIZE_LIMIT` en el .env del servidor autohospedado, si está
--      puesto: manda sobre el del bucket. En Supabase Cloud no existe.
--   Si los tres no dicen lo mismo, el archivo viaja entero y lo rechazan
--   al final, o se prohíbe algo que sí cabía.
-- ============================================================

update storage.buckets
   set file_size_limit = 524288000          -- 500 MB
 where id = 'documentos';

-- Comprobación: tiene que decir 524288000
select id, file_size_limit from storage.buckets where id = 'documentos';


-- ############################################################
-- PARTE 13 DE 31: migracion_peso_incremental.sql
-- El peso de la carpeta se suma en vez de recontarse en cada archivo
-- ############################################################

-- ============================================================
-- MIGRACIÓN: el peso de la carpeta se suma, no se recalcula
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- EL PROBLEMA
--   `peso_carpeta` es un disparador FOR EACH ROW sobre `archivos`, y en
--   cada fila volvía a recorrer TODOS los archivos de la carpeta para
--   sumarlos:
--
--     set peso_total_mb = (select sum(a.tamano) from archivos a
--                          where a.carpeta_id = objetivo)
--
--   Subir el archivo número N cuesta leer N filas, así que subir N
--   archivos cuesta N²/2 lecturas. Con 880 archivos ya en la carpeta,
--   subir 300 más son más de 300.000 lecturas, y cada una escribe la
--   MISMA fila de `carpetas`. Las subidas en paralelo se quedan
--   esperando ese bloqueo y Postgres las corta:
--
--     canceling statement due to statement timeout
--     The connection to the database timed out
--
--   No había ningún límite de archivos. Solo se ponía cuadráticamente
--   más lento hasta que dejaba de terminar a tiempo.
--
-- LA SOLUCIÓN
--   Sumar el delta en vez de recontar. Al insertar se suma el tamaño
--   del archivo nuevo; al borrar se resta; al mover se resta de una
--   carpeta y se suma a la otra. Coste constante, no importa cuántos
--   archivos haya.
--
-- POR QUÉ APARECE UNA COLUMNA NUEVA
--   `peso_total_mb` es numeric(12,2). Ir sumándole megas redondeados a
--   dos decimales acumula error: cada archivo puede desviar hasta
--   0,005 MB, y con miles de archivos la cifra deja de cuadrar con la
--   realidad. Se guarda el total exacto en BYTES y los MB se derivan
--   de ahí. `peso_total_mb` se mantiene al día para no tocar el portal
--   ni las consultas que ya la usan.
-- ============================================================

-- 1) El contador exacto, en bytes
alter table public.carpetas
    add column if not exists peso_total_bytes bigint not null default 0;

-- 2) Ponerlo al día con lo que ya hay (una sola pasada, no por fila)
update public.carpetas c
   set peso_total_bytes = coalesce((select sum(a.tamano)
                                    from public.archivos a
                                    where a.carpeta_id = c.id), 0);

-- 3) Recalcular desde cero una carpeta. No la usa el disparador: está
--    para reparar a mano si alguna vez hiciera falta, o después de una
--    carga masiva hecha por fuera del portal.
create or replace function public.recalcular_peso_carpeta(p_carpeta bigint)
returns void
language sql
security definer
set search_path = public
as $$
    update public.carpetas c
       set peso_total_bytes = coalesce((select sum(a.tamano) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0),
           peso_total_mb    = round(coalesce((select sum(a.tamano) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0) / 1048576.0, 2),
           total_archivos   = coalesce((select count(*) from public.archivos a
                                        where a.carpeta_id = p_carpeta), 0)
     where c.id = p_carpeta;
$$;

-- Solo para mantenimiento: nadie la llama desde el portal.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'recalcular_peso_carpeta'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- 4) El disparador, ahora incremental
create or replace function public.actualizar_peso_carpeta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        update public.carpetas
           set peso_total_bytes = peso_total_bytes + coalesce(new.tamano, 0),
               peso_total_mb    = round((peso_total_bytes + coalesce(new.tamano, 0)) / 1048576.0, 2),
               total_archivos   = total_archivos + 1
         where id = new.carpeta_id;

    elsif tg_op = 'DELETE' then
        -- greatest(...,0) por si un recuento quedara descuadrado en el
        -- pasado: nunca se muestra un peso negativo
        update public.carpetas
           set peso_total_bytes = greatest(peso_total_bytes - coalesce(old.tamano, 0), 0),
               peso_total_mb    = round(greatest(peso_total_bytes - coalesce(old.tamano, 0), 0) / 1048576.0, 2),
               total_archivos   = greatest(total_archivos - 1, 0)
         where id = old.carpeta_id;

    elsif tg_op = 'UPDATE' then
        if new.carpeta_id is distinct from old.carpeta_id then
            -- El archivo cambió de carpeta: sale de una y entra en otra
            update public.carpetas
               set peso_total_bytes = greatest(peso_total_bytes - coalesce(old.tamano, 0), 0),
                   peso_total_mb    = round(greatest(peso_total_bytes - coalesce(old.tamano, 0), 0) / 1048576.0, 2),
                   total_archivos   = greatest(total_archivos - 1, 0)
             where id = old.carpeta_id;

            update public.carpetas
               set peso_total_bytes = peso_total_bytes + coalesce(new.tamano, 0),
                   peso_total_mb    = round((peso_total_bytes + coalesce(new.tamano, 0)) / 1048576.0, 2),
                   total_archivos   = total_archivos + 1
             where id = new.carpeta_id;

        elsif new.tamano is distinct from old.tamano then
            -- Misma carpeta, cambió el tamaño: solo la diferencia
            update public.carpetas
               set peso_total_bytes = greatest(peso_total_bytes + coalesce(new.tamano, 0) - coalesce(old.tamano, 0), 0),
                   peso_total_mb    = round(greatest(peso_total_bytes + coalesce(new.tamano, 0) - coalesce(old.tamano, 0), 0) / 1048576.0, 2)
             where id = new.carpeta_id;
        end if;
        -- Mover un archivo de subcarpeta no cambia ningún total: se
        -- sale sin tocar la carpeta, que es el caso más frecuente.
    end if;

    return null;
end;
$$;

drop trigger if exists peso_carpeta on public.archivos;
create trigger peso_carpeta after insert or update or delete on public.archivos
    for each row execute function public.actualizar_peso_carpeta();


-- 5) Dejar los MB cuadrados con los bytes recién contados
update public.carpetas c
   set peso_total_mb  = round(c.peso_total_bytes / 1048576.0, 2),
       total_archivos = coalesce((select count(*) from public.archivos a
                                  where a.carpeta_id = c.id), 0);

-- Comprobación: las dos columnas tienen que dar lo mismo que la suma real
select c.id, c.nombre, c.total_archivos, c.peso_total_mb,
       (select count(*) from public.archivos a where a.carpeta_id = c.id) as archivos_reales,
       round(coalesce((select sum(a.tamano) from public.archivos a
                       where a.carpeta_id = c.id), 0) / 1048576.0, 2) as mb_reales
from public.carpetas c
order by c.id;


-- ############################################################
-- PARTE 14 DE 31: migracion_almacenamiento_ver.sql
-- El portal consulta el disco por una función, no leyendo la tabla
-- ############################################################

-- ============================================================
-- MIGRACIÓN: el portal consulta el disco por una función propia
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- POR QUÉ NO SE LEE LA TABLA DIRECTAMENTE
--   La primera versión leía `public.almacenamiento` por la API con su
--   política RLS. Para que eso funcione tienen que acertar a la vez el
--   grant de tabla a `authenticated`, la política, y el EXECUTE sobre
--   `es_admin()` que la política llama. Falló, y falló CALLADA: la
--   consulta devolvía cero filas sin error, el portal lo tomaba por
--   «aquí no hay medición» y pintaba el tope de config.js. La barra
--   decía 1 GB donde había 231, y nada en pantalla decía por qué.
--
--   Una función SECURITY DEFINER con la comprobación adentro deja un
--   solo permiso que acertar. Y el portal distingue «no eres admin»
--   de «no se pudo leer», en vez de inventarse un número.
--
-- QUÉ DEVUELVE
--   El disco en bytes, tal como lo midió la tarea `medir-disco` con
--   `df`, más CUÁNDO lo midió, para que el portal pueda decir si el
--   dato está fresco o lleva rato sin actualizarse.
--
--   El peso de los expedientes NO sale de esa medición: se suma en el
--   momento desde `carpetas.peso_total_bytes`, que los disparadores
--   mantienen al día. Así esa cifra es exacta al segundo aunque la
--   tarea del sistema solo corra cada pocos minutos.
--
--   A quien no es administrador le devuelve cero filas, sin error: la
--   ocupación del servidor no es asunto de las partes ni del operador,
--   y un error en la consola de todos los demás sería ruido.
-- ============================================================

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
begin
    if not public.es_admin() then
        return;   -- cero filas, sin error
    end if;

    return query
    select (a.total_mb * 1048576)::bigint,
           (a.usado_mb * 1048576)::bigint,
           (a.libre_mb * 1048576)::bigint,
           coalesce((select sum(c.peso_total_bytes) from public.carpetas c), 0)::bigint,
           a.actualizado
      from public.almacenamiento a
     where a.id = 1;
end;
$$;

-- El grant explícito, y solo a quien ha iniciado sesión. Revocar de
-- `public` es imprescindible: Postgres concede EXECUTE a ese pseudo-rol
-- en toda función nueva, y revocar solo de `anon` no quita nada.
revoke execute on function public.almacenamiento_ver() from public, anon;
grant  execute on function public.almacenamiento_ver() to authenticated;

-- `almacenamiento_registrar` la llama la tarea del sistema por psql, no
-- el portal. El endurecimiento concede EXECUTE a `authenticated` sobre
-- toda función SECURITY DEFINER que no esté en su lista de internas, y
-- esta se le colaba. Se vuelve a cerrar aquí.
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'almacenamiento_registrar'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;

-- Comprobación: tiene que decir que authenticated SÍ puede ejecutar
-- almacenamiento_ver, y que NO puede ejecutar almacenamiento_registrar.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('almacenamiento_ver', 'almacenamiento_registrar')
 order by p.proname;


-- ############################################################
-- PARTE 15 DE 31: migracion_rls_initplan.sql
-- auth.uid() se evalúa una vez por consulta y no una por fila
-- ############################################################

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


-- ############################################################
-- PARTE 16 DE 31: migracion_sesion_unica.sql
-- Una sola sesión abierta por cuenta: el último ingreso desplaza al anterior
-- ############################################################

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


-- ############################################################
-- PARTE 17 DE 31: migracion_monitor_sin_chat.sql
-- El monitor deja de leer las conversaciones y sus adjuntos
-- ############################################################

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


-- ############################################################
-- PARTE 18 DE 31: migracion_endurecimiento_2026_09.sql
-- Cierra el acceso anónimo
-- ############################################################

-- ============================================================
-- MIGRACIÓN: endurecimiento tras la auditoría de septiembre 2026
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
--
-- QUÉ ENCONTRÓ LA AUDITORÍA
--   46 funciones SECURITY DEFINER del portal se podían ejecutar SIN
--   iniciar sesión, vía /rest/v1/rpc/<nombre>. Ninguna hacía daño,
--   porque todas revisan permisos por dentro y con anon auth.uid() es
--   null, pero dejarlas expuestas significa que el día que a una se le
--   olvide la guardia, el agujero ya está abierto al público.
--
-- LA TRAMPA DE PUBLIC
--   `revoke execute ... from anon` no hace NADA por sí solo. El permiso
--   no viene del rol anon: viene de PUBLIC, el pseudo-rol al que
--   Postgres concede EXECUTE automáticamente en toda función nueva. Hay
--   que revocar de `public` Y de `anon`.
--
-- Y EL PELIGRO DE PASARSE
--   Las políticas RLS se evalúan con los privilegios de QUIEN CONSULTA,
--   no del dueño de la tabla. Si al revocar de PUBLIC se deja sin
--   EXECUTE a `authenticated` sobre puede_ver_carpeta(), TODOS los
--   usuarios dejan de ver sus carpetas. Por eso después de revocar hay
--   que volver a conceder a authenticated de forma explícita.
--   (Ya nos pasó una vez con puede_ver_notaria.)
-- ============================================================


-- ------------------------------------------------------------
-- 1) Cerrar el acceso anónimo, sin romper el de los usuarios
-- ------------------------------------------------------------
do $$
declare
    f record;
    -- Solo las llaman otras funciones, la tarea programada o el servidor.
    -- Nadie por HTTP.
    --
    -- _notificar y _notificar_admins NO pueden faltar aquí. La primera
    -- versión de esta lista no las traía y este bucle les devolvió el
    -- permiso a todos los usuarios con sesión: cualquiera podía dejarle
    -- avisos falsos en la campana a otro (ver migracion_permisos_internos.sql).
    -- Las de disparador tampoco lo necesitan: el bucle las cierra todas.
    internas constant text[] := array[
        '_notificar', '_notificar_admins',
        'almacenamiento_registrar', 'recalcular_peso_carpeta',
        'cron_plazos_diario', 'avisar_plazos_tramite',
        'destinatarios_de_carpeta', 'perfil_alcanza_notaria',
        -- migracion_avisos_push.sql
        '_push_quien', 'avisos_calendario_diario', 'push_tomar', 'push_resultado'
    ];
    -- Anónimas POR DISEÑO. Si se vuelve a correr este archivo después
    -- de migracion_metricas_web.sql, el ingreso tiene que poder
    -- seguir contando sus visitas.
    publicas constant text[] := array[
        'solicitar_restablecimiento',   -- quien olvidó la clave no ha entrado
        'registrar_evento_web'          -- quien abre el ingreso aún no tiene sesión
    ];
begin
    for f in
        select p.oid::regprocedure as firma, p.proname as nombre,
               p.prorettype = 'trigger'::regtype as disparador
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
    loop
        execute format('revoke execute on function %s from public, anon', f.firma);

        if f.nombre = any(internas) or f.disparador then
            execute format('revoke execute on function %s from authenticated', f.firma);
        elsif f.nombre = any(publicas) then
            execute format('grant execute on function %s to anon, authenticated', f.firma);
        else
            execute format('grant execute on function %s to authenticated', f.firma);
        end if;
    end loop;
end $$;


-- ------------------------------------------------------------
-- 2) Índices que faltaban en claves foráneas
-- ------------------------------------------------------------
-- El índice de notificaciones empieza por destinatario_id, así que no
-- cubre una búsqueda por notaría sola: por ejemplo al borrar una
-- notaría, que arrastra sus avisos en cascada.
create index if not exists idx_notificaciones_notaria
    on public.notificaciones (notaria_id);
create index if not exists idx_perfil_notarias_notaria
    on public.perfil_notarias (notaria_id);


-- ------------------------------------------------------------
-- 3) El límite de tamaño, igual en los tres sitios
-- ------------------------------------------------------------
-- Producción tenía 100 MB y esquema.sql decía 50 MB: se habían
-- separado. Después migracion_tope_archivo.sql lo subió a 500 MB para
-- las grabaciones de audiencias. Esta migración se escribió antes, pero
-- en el orden de instalación corre DESPUÉS de esa: por eso dice 500 y
-- no 50. Con 50 aquí, un servidor nuevo quedaba aceptando 50 MB
-- mientras el portal dejaba escoger 500, y el video se rechazaba al
-- final de la subida.
-- Para cambiarlo hay que tocar TRES sitios: este número (y el de
-- migracion_tope_archivo.sql), TAMANO_MAXIMO en app.js, y
-- FILE_SIZE_LIMIT del .env en el servidor autohospedado.
update storage.buckets set file_size_limit = 524288000 where id = 'documentos';   -- 500 MB


-- ------------------------------------------------------------
-- 4) Límite de solicitudes de clave, por usuario y no solo global
-- ------------------------------------------------------------
-- Antes: 10 cada 15 minutos EN TOTAL. Diez peticiones bastaban para
-- dejar sin restablecimiento a toda la notaría durante ese rato: una
-- denegación de servicio que cuesta diez clics.
-- Ahora: 3 por usuario y 40 en total. Corta el abuso sin que una
-- persona pueda bloquear a las demás.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    suyas int;
    TOPE_GLOBAL   constant int := 40;
    TOPE_USUARIO  constant int := 3;
    VENTANA       constant interval := interval '15 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    select count(*) into recientes
      from public.solicitudes_clave
     where fecha > now() - VENTANA;
    if recientes >= TOPE_GLOBAL then return; end if;

    select count(*) into suyas
      from public.solicitudes_clave
     where usuario = u and fecha > now() - VENTANA;
    if suyas >= TOPE_USUARIO then return; end if;

    -- Se responde igual exista o no el usuario: lo contrario revelaría
    -- quién tiene cuenta en el portal
    if not exists (select 1 from public.perfiles where usuario = u and activo) then return; end if;
    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then return; end if;

    insert into public.solicitudes_clave (usuario) values (u);
    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» olvidó su contraseña y solicita restablecerla', null, null);
end;
$$;

revoke execute on function public.solicitar_restablecimiento(text) from public;
grant execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ------------------------------------------------------------
-- 5) Comprobación: nadie debería haber perdido acceso
-- ------------------------------------------------------------
-- Simula la sesión de cada usuario activo y cuenta lo que ve. Si al
-- correr esta migración en un servidor nuevo alguna fila dice ERROR,
-- falta un grant y hay que resolverlo ANTES de dejar entrar a nadie.
do $$
declare
    u record; n_c int; n_a int; r text := ''; fallo boolean := false;
begin
    for u in select id, usuario, rol from public.perfiles where activo order by rol, usuario loop
        perform set_config('request.jwt.claims',
                 json_build_object('sub', u.id::text, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        begin
            select count(*) into n_c from public.carpetas;
            select count(*) into n_a from public.archivos;
            r := r || format('%s/%s:%s/%s ', u.rol, u.usuario, n_c, n_a);
        exception when others then
            fallo := true;
            r := r || format('%s/%s ERROR:%s ', u.rol, u.usuario, SQLERRM);
        end;
        perform set_config('role', 'postgres', true);
    end loop;

    if fallo then
        raise exception 'HAY USUARIOS SIN ACCESO: %', r;
    end if;
    raise notice 'Acceso verificado (rol/usuario:carpetas/archivos): %', r;
end $$;


-- ############################################################
-- PARTE 19 DE 31: migracion_campana_por_persona.sql
-- Cada campana decide sola: el aviso ya no se salta porque otro lo tenga
-- ############################################################

-- ============================================================
-- LA CAMPANA, DE VERDAD INDEPENDIENTE POR PERSONA
-- ============================================================
-- La tabla `notificaciones` siempre guardó una fila por destinatario, y
-- la RLS siempre dejó a cada quien ver, marcar y borrar solo las suyas.
-- Eso estaba bien. El problema estaba un paso antes: en QUIÉN decide si
-- un aviso ya se mandó.
--
-- EL DEFECTO
--   Las tres funciones que generan avisos preguntaban así:
--
--       if exists (select 1 from notificaciones
--                   where tipo = 'plazo-7' and referencia_id = c.id)
--       then continue;      -- «este aviso ya salió»
--
--   Sin `destinatario_id`. O sea: ya salió PARA ALGUIEN, en cualquier
--   campana del portal. Tres consecuencias, todas reales:
--
--   1) Quien vacía su campana pierde el aviso para siempre. El operador
--      limpia la suya, pero la fila del administrador sigue existiendo,
--      así que el guardia dice «ya se mandó» y no vuelve a generarlo. El
--      administrador lo sigue viendo; el operador no lo verá nunca más,
--      aunque el plazo siga corriendo.
--
--   2) A quien llega después no le llega nada. Se asigna un acreedor a
--      una carpeta cuyo aviso de «faltan 2 semanas» ya salió: su campana
--      nace vacía y se queda vacía, porque las filas de los demás tapan
--      la suya.
--
--   3) Si TODOS vacían, vuelve a salir para todos. Incluido quien lo
--      había descartado a propósito.
--
-- LA CORRECCIÓN
--   El guardia se mueve dentro del INSERT y se correlaciona con cada
--   destinatario. Deja de ser «¿este aviso existe?» y pasa a ser «¿este
--   aviso existe PARA ESTA PERSONA?». Cada campana se comporta como si
--   fuera la única del portal.
--
--   No cambia nada de la RLS ni de la tabla: no hacía falta tocarlas.
--
-- QUÉ NO CAMBIA, Y POR QUÉ
--   Cuando se mueve la fecha de vencimiento de una carpeta, el trigger
--   `limpiar_avisos_plazo` sigue borrando los avisos de plazo de TODO el
--   mundo. Ahí sí corresponde: el hito viejo dejó de ser cierto para
--   todos a la vez, y el nuevo tiene que poder volver a salir.
-- ============================================================


-- ------------------------------------------------------------
-- 1) El índice que el nuevo guardia necesita
-- ------------------------------------------------------------
-- Antes se preguntaba por (tipo, referencia_id) una vez por proceso.
-- Ahora se pregunta por (tipo, referencia_id, destinatario_id) una vez
-- por persona y por proceso. Sin índice eso es un recorrido completo de
-- la tabla por cada fila candidata, todos los días a las 6 de la mañana.
create index if not exists idx_notif_dedupe
    on public.notificaciones (tipo, referencia_id, destinatario_id);


-- ------------------------------------------------------------
-- 2) Avisos del plazo del trámite (4, 3, 2, 1 semanas, 1 día y hoy)
-- ------------------------------------------------------------
create or replace function public.avisar_plazos_tramite()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    -- De más lejos a más cerca. Días de CALENDARIO que faltan.
    -- Las variables van con prefijo v_ porque sin él "tipo" y
    -- "mensaje" chocan con las columnas de notificaciones y plpgsql
    -- aborta con "column reference is ambiguous".
    hitos constant int[] := array[28, 21, 14, 7, 1, 0];
    c          record;
    v_faltan   int;
    v_hito     int;
    v_tipo     text;
    v_cuando   text;
    v_mensaje  text;
    n_avisos   int := 0;
    n_fila     int;
begin
    for c in
        select id, nombre, fecha_vencimiento_tramite, notaria_id
          from public.carpetas
         where activa
           and not finalizado
           and not pausado                        -- en pausa el reloj está detenido
           and fecha_vencimiento_tramite is not null
    loop
        v_faltan := c.fecha_vencimiento_tramite - current_date;

        -- Ya vencido: de eso avisa 'proceso-vencido', no este aviso
        if v_faltan < 0 then continue; end if;

        -- El hito más cercano al vencimiento que ya se alcanzó. Si
        -- faltan 26 días (el hito de 28 cayó en festivo), sale el de
        -- 4 semanas; si faltan 40, todavía no sale ninguno.
        select min(h) into v_hito from unnest(hitos) as h where v_faltan <= h;
        if v_hito is null then continue; end if;

        v_tipo := 'plazo-' || v_hito;

        v_cuando := case v_hito
            when 28 then 'Faltan 4 semanas'
            when 21 then 'Faltan 3 semanas'
            when 14 then 'Faltan 2 semanas'
            when  7 then 'Falta 1 semana'
            when  1 then 'Falta 1 día'
            else         'Hoy'
        end;

        v_mensaje := case
            when v_hito = 0 then
                'Hoy se cumple el plazo del trámite «' || c.nombre || '»'
            else
                v_cuando || ' para que se cumpla el plazo del trámite «' || c.nombre ||
                '»: vence el ' || to_char(c.fecha_vencimiento_tramite, 'DD/MM/YYYY')
        end;

        -- Una vez por PERSONA, no una vez por carpeta. Antes este
        -- guardia estaba arriba, como un `continue` que saltaba la
        -- carpeta entera en cuanto encontraba el aviso en la campana de
        -- cualquiera. Aquí adentro, cada destinatario se mira solo.
        --
        -- Se recorta el mensaje a 300 igual que _notificar, para que una
        -- carpeta con nombre larguísimo no reviente el insert.
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select d.perfil, v_tipo, left(v_mensaje, 300), c.id, c.id, c.notaria_id
          from public.destinatarios_de_carpeta(c.id) as d(perfil)
         where not exists (
                   select 1 from public.notificaciones n
                    where n.tipo = v_tipo
                      and n.referencia_id = c.id
                      and n.destinatario_id = d.perfil
               );

        get diagnostics n_fila = row_count;
        n_avisos := n_avisos + n_fila;
    end loop;

    return n_avisos;
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'avisar_plazos_tramite'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 3) Procesos ya vencidos (la que dispara el portal al entrar)
-- ------------------------------------------------------------
create or replace function public.generar_notificaciones_vencidos()
returns void
language plpgsql security definer set search_path = public
as $$
declare
    p record;
    nom text;
begin
    if not public.es_admin() then return; end if;
    -- El recorrido ya no filtra por «¿existe el aviso?»: ahora repasa
    -- todos los procesos vencidos y es el INSERT el que decide, admin
    -- por admin. Son pocas filas y el índice idx_notif_dedupe resuelve
    -- la comprobación.
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado
          and pt.fecha_vencimiento_habil < current_date
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               left('El proceso «' || p.nombre || '» de «' || coalesce(nom, '') ||
                    '» se pasó del plazo', 300),
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id)
          and not exists (
                  select 1 from public.notificaciones n
                   where n.tipo = 'proceso-vencido'
                     and n.referencia_id = p.id
                     and n.destinatario_id = a.id
              );
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 4) La tarea diaria, con el mismo criterio
-- ------------------------------------------------------------
create or replace function public.cron_plazos_diario()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    hoy date := current_date;
    p record;
    nom text;
    n_avisos int := 0;
    n_fila int;
    n_desactivadas int := 0;
    n_plazos int := 0;
begin
    if not public.es_dia_habil(hoy) then
        return jsonb_build_object('ejecutado', false, 'fecha', hoy,
                                  'motivo', 'fin de semana o festivo colombiano');
    end if;

    -- Procesos ya vencidos, solo a los administradores de esa notaría,
    -- y solo a quien todavía no lo tenga en SU campana
    for p in
        select pt.id, pt.nombre, pt.carpeta_id, c.notaria_id
        from public.procesos_tramite pt
        join public.carpetas c on c.id = pt.carpeta_id
        where not pt.completado and not pt.pausado and not c.pausado
          and pt.fecha_vencimiento_habil < hoy
    loop
        select nombre into nom from public.carpetas where id = p.carpeta_id;
        insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                           referencia_id, notaria_id)
        select a.id, 'proceso-vencido',
               left('El proceso «' || p.nombre || '» de «' || coalesce(nom, '') ||
                    '» se pasó del plazo', 300),
               p.carpeta_id, p.id, p.notaria_id
        from public.perfiles a
        where a.rol = 'administrador' and a.activo
          and public.perfil_alcanza_notaria(a.id, p.notaria_id)
          and not exists (
                  select 1 from public.notificaciones n
                   where n.tipo = 'proceso-vencido'
                     and n.referencia_id = p.id
                     and n.destinatario_id = a.id
              );

        -- Cuenta avisos de verdad, no vueltas del bucle: antes sumaba 1
        -- por proceso aunque el insert no hubiera puesto ninguna fila.
        get diagnostics n_fila = row_count;
        n_avisos := n_avisos + n_fila;
    end loop;

    -- Avisos del plazo del trámite a todos los de la carpeta
    n_plazos := public.avisar_plazos_tramite();

    -- Cerrar las carpetas cuyo plazo de descarga ya se cumplió
    with apagadas as (
        update public.carpetas
           set activa = false, desactivacion_auto_aplicada = true
         where finalizado and activa
           and not desactivacion_auto_aplicada
           and fecha_desactivacion_programada is not null
           and fecha_desactivacion_programada <= hoy
        returning id
    )
    select count(*) into n_desactivadas from apagadas;

    return jsonb_build_object(
        'ejecutado', true,
        'fecha', hoy,
        'procesos_vencidos_avisados', n_avisos,
        'avisos_de_plazo', n_plazos,
        'carpetas_desactivadas', n_desactivadas
    );
end;
$$;

do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as firma
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'cron_plazos_diario'
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 5) Comprobación
-- ------------------------------------------------------------
-- Cuenta a cuánta gente le falta un aviso que otros sí tienen. Son los
-- huecos que dejó el guardia viejo. No se rellenan solos de golpe: van
-- saliendo a medida que la tarea diaria vuelva a pasar por cada carpeta
-- y cada proceso vencido.
do $$
declare
    huecos int;
begin
    begin
        select count(*) into huecos
          from (
                select n.tipo, n.referencia_id, n.carpeta_id
                  from public.notificaciones n
                 where n.tipo like 'plazo-%'
                   and n.carpeta_id is not null
                 group by n.tipo, n.referencia_id, n.carpeta_id
                having count(distinct n.destinatario_id) <
                       (select count(*) from public.destinatarios_de_carpeta(n.carpeta_id))
               ) q;

        raise notice 'Avisos de plazo que no alcanzaron a todos los de su carpeta: %', huecos;
        raise notice 'La tarea diaria los completa en su proxima pasada.';
    exception when others then
        -- La comprobación es informativa: si no se puede calcular, la
        -- migración ya hizo su trabajo y no tiene por qué fallar aquí.
        raise notice 'No se pudo contar los huecos (%). Las funciones quedaron aplicadas igual.', sqlerrm;
    end;
end $$;

select 'campana por persona: listo' as resultado;


-- ############################################################
-- PARTE 20 DE 31: migracion_tablero_notarias.sql
-- La pantalla de notarías muestra lo que vence y, al administrador, lo que ocupa cada oficina
-- ############################################################

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


-- ############################################################
-- PARTE 21 DE 31: migracion_registro_cerrado.sql
-- Una cuenta que no creó un administrador nace inactiva
-- ############################################################

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


-- ############################################################
-- PARTE 22 DE 31: migracion_metricas_web.sql
-- El tablero «Rendimiento» del administrador: visitas al ingreso, ingresos al portal y metas del mes
-- ############################################################

-- ============================================================
-- MIGRACIÓN: rendimiento del portal y metas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va ENTERA dentro de una transacción: si algo falla a mitad, no queda
-- media tabla ni una función sin sus permisos.
--
-- QUÉ AÑADE
--   La sección «Rendimiento» del portal, que solo ve el administrador. Responde dos preguntas:
--
--     1. Cuánta gente abre la pantalla de ingreso, cuántos entran y
--        cuántos intentos fallan.
--     2. Si el mes va camino de cumplir las metas que fija la entidad.
--
-- QUÉ SE GUARDA, Y QUÉ NO
--   Una fila por cosa que pasa: «alguien abrió el ingreso», «alguien
--   intentó entrar y falló». Con cada fila van:
--
--     sesion       un número al azar que vive en la pestaña
--                  (sessionStorage) y se borra al cerrarla. Sirve para
--                  que recargar la página no cuente otra visita. No
--                  identifica a nadie y no se cruza con nada.
--     origen       de dónde llegó, en una palabra: google, whatsapp,
--                  facebook, directo... Nunca la dirección completa.
--     dispositivo  movil, tableta o escritorio.
--
--   NO se guarda la IP, ni el nombre, ni el correo, ni el teléfono. La
--   política de datos (privacidad.html) lo dice así.
--
-- QUIÉN ESCRIBE
--   La pantalla de ingreso, con la clave pública, por registrar_evento_web().
--   Acepta solo una lista cerrada de tipos, una vez por pestaña cada uno,
--   y con un tope por hora para que un guion no llene el disco.
--
-- QUIÉN LEE
--   Solo el administrador, por metricas_web(). Las tablas no tienen
--   políticas RLS: nadie las lee ni las escribe directamente por la API.
--
-- LOS INGRESOS AL PORTAL
--   No hacen falta eventos nuevos: el portal ya apunta cada ingreso en
--   `actividad` (accion = 'ingreso'). Se cuentan de ahí, sin los del
--   administrador, que entra a trabajar y no es lo que mide la meta.
--
-- SE PUEDE VOLVER A CORRER
--   Si este archivo cambia (por ejemplo, metricas_web() devuelve una
--   cifra nueva para el tablero), basta con correrlo otra vez: las tablas
--   y los datos se quedan como están y las funciones se reemplazan.
--
-- SI ESTA MIGRACIÓN NO SE HA CORRIDO
--   El ingreso al portal funciona igual: la llamada para contar falla en
--   silencio y nadie lo nota. El tablero dice que falta la migración.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Las tablas
-- ------------------------------------------------------------
create table if not exists public.eventos_web (
    id          bigint generated always as identity primary key,
    fecha       timestamptz not null default now(),
    tipo        text not null,
    sesion      text not null default '',
    origen      text not null default '',
    dispositivo text not null default '',
    detalle     jsonb not null default '{}'::jsonb
);

comment on table public.eventos_web is
    'Lo que pasa en el ingreso al portal, sin datos personales. Lo lee metricas_web().';

-- La lista de tipos, en un solo sitio. Se rehace para poder añadir tipos
-- en otra migración sin tener que borrar la tabla.
alter table public.eventos_web drop constraint if exists eventos_web_tipo_check;
alter table public.eventos_web add constraint eventos_web_tipo_check check (tipo in (
    'portal_visita',      -- abrió la pantalla de ingreso del portal
    'portal_fallido'      -- intentó entrar y el usuario o la clave no sirvieron
));

create index if not exists idx_eventos_web_tipo_fecha on public.eventos_web (tipo, fecha);
create index if not exists idx_eventos_web_fecha      on public.eventos_web (fecha);
-- Para «una vez por pestaña»
create index if not exists idx_eventos_web_sesion     on public.eventos_web (sesion, tipo) where sesion <> '';

-- Las metas del mes. Una fila por meta; 0 quiere decir «sin meta».
create table if not exists public.metas_web (
    clave           text primary key,
    valor           integer not null default 0,
    actualizada     timestamptz not null default now(),
    actualizada_por text not null default ''
);

alter table public.metas_web drop constraint if exists metas_web_clave_check;
alter table public.metas_web add constraint metas_web_clave_check check (clave in (
    'portal_visitas',     -- visitas a la pantalla de ingreso en el mes
    'portal_ingresos'     -- ingresos al portal (sin administradores)
));
alter table public.metas_web drop constraint if exists metas_web_valor_check;
alter table public.metas_web add constraint metas_web_valor_check check (valor between 0 and 10000000);

comment on table public.metas_web is
    'Metas mensuales del tablero de rendimiento. Las escribe guardar_metas_web().';

-- Sin políticas a propósito: con RLS encendida y ninguna política, la
-- API no deja leer ni escribir. Todo pasa por las funciones de abajo.
alter table public.eventos_web enable row level security;
alter table public.metas_web   enable row level security;
revoke all on table public.eventos_web from anon, authenticated;
revoke all on table public.metas_web   from anon, authenticated;


-- ------------------------------------------------------------
-- 2) Lo que apunta la página (pública)
-- ------------------------------------------------------------
-- Nunca responde error: quien llama es una página pública y un fallo
-- aquí no tiene nada que decirle a nadie. Lo que no cumple, se ignora.
create or replace function public.registrar_evento_web(
    p_tipo        text,
    p_sesion      text default '',
    p_origen      text default '',
    p_dispositivo text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    s text := coalesce(p_sesion, '');
    recientes int;
    -- Muy por encima de lo que el portal recibe en una hora de verdad.
    -- Si se alcanza, es un guion: se deja de apuntar hasta que pase.
    TOPE_HORA constant int := 3000;
begin
    if p_tipo is null or p_tipo not in ('portal_visita', 'portal_fallido') then
        return;
    end if;

    -- La sesión la genera la página: letras y números, nada más
    if s !~ '^[a-z0-9]{12,40}$' then return; end if;

    -- Una vez por pestaña: recargar no suma otra visita
    if exists (select 1 from public.eventos_web where sesion = s and tipo = p_tipo) then
        return;
    end if;

    select count(*) into recientes
      from public.eventos_web
     where fecha > now() - interval '1 hour';
    if recientes >= TOPE_HORA then return; end if;

    insert into public.eventos_web (tipo, sesion, origen, dispositivo)
    values (
        p_tipo, s,
        case when p_origen in ('directo', 'google', 'buscador', 'facebook', 'instagram',
                               'whatsapp', 'tiktok', 'sitio', 'otro')
             then p_origen else 'otro' end,
        case when p_dispositivo in ('movil', 'tableta', 'escritorio')
             then p_dispositivo else '' end
    );
end;
$$;


-- ------------------------------------------------------------
-- 3) El tablero (solo administrador)
-- ------------------------------------------------------------
-- Devuelve todo el tablero en un solo JSON, para un rango de fechas en
-- hora de Colombia (ambos días incluidos). Trae además:
--   · el periodo anterior de igual duración, para las comparaciones;
--   · el mes calendario del último día del rango, para las metas.
create or replace function public.metricas_web(p_desde date, p_hasta date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    ZONA constant text := 'America/Bogota';
    d1 date := least(p_desde, p_hasta);
    d2 date := greatest(p_desde, p_hasta);
    hoy date := (now() at time zone ZONA)::date;
    dias int;
    ini timestamptz;
    fin timestamptz;
    ini_ant timestamptz;
    mes_ini date;
    mes_sig date;
    m_ini timestamptz;
    m_fin timestamptz;
    r jsonb;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede ver el rendimiento del portal.'
            using errcode = '42501';
    end if;
    if d1 is null or d2 is null then
        raise exception 'Faltan las fechas del rango.' using errcode = '22023';
    end if;

    -- Más de un año y pico no cabe en una gráfica diaria
    if d2 - d1 > 400 then d1 := d2 - 400; end if;
    dias    := d2 - d1 + 1;
    ini     := d1::timestamp at time zone ZONA;
    fin     := (d2 + 1)::timestamp at time zone ZONA;
    ini_ant := (d1 - dias)::timestamp at time zone ZONA;
    mes_ini := date_trunc('month', d2::timestamp)::date;
    mes_sig := (mes_ini + interval '1 month')::date;
    m_ini   := mes_ini::timestamp at time zone ZONA;
    m_fin   := mes_sig::timestamp at time zone ZONA;

    select jsonb_build_object(
        'desde', d1,
        'hasta', d2,
        'dias',  dias,
        'hoy',   hoy,

        -- Cuántas veces pasó cada cosa, en el rango y en el anterior
        'totales', (
            select coalesce(jsonb_object_agg(tipo, n), '{}'::jsonb)
              from (select tipo, count(*) as n from public.eventos_web
                     where fecha >= ini and fecha < fin group by tipo) t),
        'anteriores', (
            select coalesce(jsonb_object_agg(tipo, n), '{}'::jsonb)
              from (select tipo, count(*) as n from public.eventos_web
                     where fecha >= ini_ant and fecha < ini group by tipo) t),

        -- Día por día (solo los días con algo; el tablero rellena los ceros)
        'serie', (
            select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'tipo', tipo, 'n', n) order by dia, tipo), '[]'::jsonb)
              from (select (fecha at time zone ZONA)::date as dia, tipo, count(*) as n
                      from public.eventos_web
                     where fecha >= ini and fecha < fin
                     group by 1, 2) s),

        -- Los ingresos salen de la bitácora que ya existe
        'portal', jsonb_build_object(
            'ingresos', (select count(*) from public.actividad
                          where accion = 'ingreso' and rol <> 'administrador'
                            and fecha >= ini and fecha < fin),
            'ingresos_ant', (select count(*) from public.actividad
                              where accion = 'ingreso' and rol <> 'administrador'
                                and fecha >= ini_ant and fecha < ini),
            'personas', (select count(distinct perfil_id) from public.actividad
                          where accion = 'ingreso' and rol <> 'administrador'
                            and fecha >= ini and fecha < fin),
            'por_rol', (
                select coalesce(jsonb_agg(jsonb_build_object('rol', rol, 'n', n) order by n desc, rol), '[]'::jsonb)
                  from (select rol, count(*) as n from public.actividad
                         where accion = 'ingreso' and rol <> 'administrador'
                           and fecha >= ini and fecha < fin
                         group by rol) s),
            'serie', (
                select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'n', n) order by dia), '[]'::jsonb)
                  from (select (fecha at time zone ZONA)::date as dia, count(*) as n
                          from public.actividad
                         where accion = 'ingreso' and rol <> 'administrador'
                           and fecha >= ini and fecha < fin
                         group by 1) s)
        ),

        -- El mes de las metas: el del último día del rango
        'mes', jsonb_build_object(
            'inicio', mes_ini,
            'fin',    mes_sig - 1,
            'portal_visitas', (select count(*) from public.eventos_web
                                where tipo = 'portal_visita' and fecha >= m_ini and fecha < m_fin),
            'portal_ingresos', (select count(*) from public.actividad
                                 where accion = 'ingreso' and rol <> 'administrador'
                                   and fecha >= m_ini and fecha < m_fin)
        ),

        'metas', (select coalesce(jsonb_object_agg(clave, valor), '{}'::jsonb) from public.metas_web),
        'metas_actualizadas', (select jsonb_build_object('fecha', actualizada, 'por', actualizada_por)
                                 from public.metas_web order by actualizada desc limit 1),

        -- Desde cuándo hay datos: antes de esta fecha las cifras son cero
        -- porque no se medía, no porque no viniera nadie
        'primer_evento', (select min(fecha) from public.eventos_web)
    ) into r;

    return r;
end;
$$;


-- ------------------------------------------------------------
-- 4) Guardar las metas (solo administrador)
-- ------------------------------------------------------------
-- Recibe {"portal_visitas": 800, "portal_ingresos": 40}. Las claves que
-- no vienen no se tocan; un valor vacío o que no es número, tampoco.
create or replace function public.guardar_metas_web(p_metas jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    k text;
    v text;
    quien text;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador puede cambiar las metas.' using errcode = '42501';
    end if;
    if p_metas is null or jsonb_typeof(p_metas) <> 'object' then return; end if;

    select usuario into quien from public.perfiles where id = auth.uid();

    foreach k in array array['portal_visitas', 'portal_ingresos'] loop
        v := p_metas ->> k;
        continue when v is null or v !~ '^\d{1,8}$';
        insert into public.metas_web (clave, valor, actualizada, actualizada_por)
        values (k, least(v::int, 10000000), now(), coalesce(quien, ''))
        on conflict (clave) do update
            set valor = excluded.valor,
                actualizada = excluded.actualizada,
                actualizada_por = excluded.actualizada_por;
    end loop;
end;
$$;


-- ------------------------------------------------------------
-- 5) Permisos
-- ------------------------------------------------------------
-- Revocar de PUBLIC además de anon: el permiso por defecto viene de
-- PUBLIC (ver migracion_endurecimiento_2026_09.sql).
revoke execute on function public.registrar_evento_web(text, text, text, text) from public;
grant  execute on function public.registrar_evento_web(text, text, text, text) to anon, authenticated;

revoke execute on function public.metricas_web(date, date) from public, anon;
grant  execute on function public.metricas_web(date, date) to authenticated;

revoke execute on function public.guardar_metas_web(jsonb) from public, anon;
grant  execute on function public.guardar_metas_web(jsonb) to authenticated;

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
--   select tipo, count(*), min(fecha), max(fecha)
--     from public.eventos_web group by tipo order by tipo;
--
-- Unos minutos después de publicar, «portal_visita» debería tener filas.
--
-- LIMPIEZA (opcional, a mano)
--   Cada fila pesa unos pocos bytes; un año de visitas cabe en unos
--   pocos MB. Si algún día se quiere podar:
--     delete from public.eventos_web where fecha < now() - interval '2 years';
-- ============================================================


-- ############################################################
-- PARTE 23 DE 31: migracion_permisos_internos.sql
-- Vuelve a cerrar _notificar y las demás funciones internas, le quita a anon los permisos sobre tablas y le da a cada llamada de soporte un canal secreto
-- ############################################################

-- ============================================================
-- MIGRACIÓN: vuelven a cerrarse las funciones internas
-- ============================================================
-- Idempotente: se puede correr varias veces sin romper nada.
-- Va entera dentro de una transacción.
--
-- QUÉ PASÓ
--   migracion_seguridad_2026_08.sql le había quitado a todo el mundo el
--   permiso de ejecutar _notificar y _notificar_admins. Su comentario lo
--   explica: con ellas, cualquiera puede meter avisos falsos en la
--   campana de otro usuario, con la cara del portal. Un phishing servido
--   desde casa.
--
--   Un mes después, migracion_endurecimiento_2026_09.sql recorrió TODAS
--   las funciones SECURITY DEFINER y le devolvió el permiso a
--   `authenticated` a cada una que no estuviera en su lista de internas.
--   Esa lista era corta y no traía _notificar ni _notificar_admins. Desde
--   entonces cualquier usuario con sesión (un cliente, un acreedor) puede
--   llamar por HTTP a
--
--     POST /rest/v1/rpc/_notificar
--
--   y dejarle a quien quiera, administrador incluido, un aviso con el
--   texto que se le antoje. Con recalcular_peso_carpeta pasó lo mismo, y
--   en una instalación nueva también con almacenamiento_registrar, que
--   deja poner cifras falsas en la barra del disco.
--
--   El endurecimiento ya viene corregido en el repositorio para que
--   volver a correrlo no las abra otra vez. Esta migración arregla el
--   servidor, que ya lo corrió con la lista vieja.
--
-- QUÉ HACE
--   1. Les quita el EXECUTE a PUBLIC, anon y authenticated a las
--      funciones que solo se llaman desde dentro de la base (desde otras
--      funciones o desde la tarea diaria) y a todas las de disparador.
--      Las funciones SECURITY DEFINER que las llaman corren como su
--      dueño, así que siguen funcionando igual.
--   2. Le quita al rol anon cualquier permiso sobre las tablas. Hoy ya no
--      puede leer nada porque las políticas se lo impiden, pero el
--      permiso seguía ahí: una política mal escrita mañana y la tabla
--      queda abierta. Quien no ha iniciado sesión no necesita tocar una
--      tabla: las visitas al ingreso y «olvidé mi contraseña» pasan por funciones.
--   3. Cada llamada de soporte recibe un nombre de canal al azar. La
--      señalización de la llamada viaja por un canal de Realtime, y esos
--      canales los puede abrir cualquiera que tenga la clave pública
--      (que va en config.js). Con el nombre «llamada-<número>», alguien
--      podía escuchar la negociación o meter una respuesta falsa y
--      quedarse con la llamada. El nombre nuevo solo lo pueden leer los
--      dos participantes, porque vive en su fila de llamadas_soporte.
--
-- SI ALGO FALLA
--   Nada del portal llama a estas funciones desde el navegador (se
--   comprobó en nube.js). Si aun así algo deja de funcionar, la consulta
--   del final dice qué permisos quedaron.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Funciones internas: nadie las llama por HTTP
-- ------------------------------------------------------------
do $$
declare
    f record;
    internas constant text[] := array[
        '_notificar', '_notificar_admins',
        'almacenamiento_registrar', 'recalcular_peso_carpeta',
        'cron_plazos_diario', 'avisar_plazos_tramite',
        'destinatarios_de_carpeta', 'perfil_alcanza_notaria'
    ];
begin
    for f in
        select p.oid::regprocedure as firma
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname = any(internas) or p.prorettype = 'trigger'::regtype)
    loop
        execute format('revoke execute on function %s from public, anon, authenticated', f.firma);
    end loop;
end $$;


-- ------------------------------------------------------------
-- 2) anon sin permisos sobre las tablas
-- ------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Y en las tablas que se creen de aquí en adelante. Para las que crea
-- supabase_admin puede faltar permiso: si pasa, se sigue sin ese paso.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
do $$
begin
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
exception when others then
    raise notice 'Sin permiso para cambiar los privilegios por defecto de supabase_admin: %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- 3) Un canal secreto por llamada
-- ------------------------------------------------------------
-- gen_random_uuid() es parte de Postgres desde la 13 y usa el
-- generador fuerte del sistema. Al añadir la columna, cada llamada
-- vieja recibe su propio valor.
alter table public.llamadas_soporte
    add column if not exists canal text not null default gen_random_uuid()::text;

comment on column public.llamadas_soporte.canal is
    'Nombre del canal de Realtime de la llamada. Solo lo leen los dos participantes (RLS).';

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- Todas las filas deben decir false en las dos columnas, salvo
-- registrar_evento_web y solicitar_restablecimiento, que son públicas
-- a propósito y no salen aquí.
select p.proname as funcion,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('_notificar', '_notificar_admins', 'almacenamiento_registrar',
                     'recalcular_peso_carpeta')
 order by 1;

-- Debe dar 0: anon ya no tiene ningún permiso sobre tablas de public
select count(*) as permisos_de_anon_en_tablas
  from information_schema.role_table_grants
 where grantee = 'anon' and table_schema = 'public';


-- ############################################################
-- PARTE 24 DE 31: migracion_presencia_privada.sql
-- «En línea» por latido en la base: solo lo ve el administrador
-- ############################################################

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


-- ############################################################
-- PARTE 25 DE 31: migracion_anexos.sql
-- Anexos de un documento (1, 1.1, 1.2…) y «mover a otra subcarpeta»
-- ############################################################

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


-- ############################################################
-- PARTE 26 DE 31: migracion_intentos_fallidos.sql
-- Intentos fallidos de ingreso por cuenta, para el tablero de Rendimiento
-- ############################################################

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


-- ############################################################
-- PARTE 27 DE 31: migracion_avisos_push.sql
-- Avisos en el celular del administrador y chat de soporte también para el monitor
-- ############################################################

-- ============================================================
-- MIGRACIÓN: avisos en el celular del administrador, y soporte
--            también para el monitor
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. El monitor tiene su propio hilo en el chat de soporte, igual que
--      un operador: escribe, adjunta, recibe llamadas del administrador
--      y su mensaje le llega a la campana del administrador.
--
--   2. Avisos nuevos en la campana del administrador:
--        archivo-admin     alguien subió un documento: quién, cuál, a
--                          qué carpeta (y subcarpeta)
--        audiencia-nueva   alguien programó una audiencia
--        proceso-nuevo     alguien creó un proceso (lo que se ve en
--                          «Estados»)
--        ingreso-cuenta    se inició sesión con la cuenta del
--                          administrador, desde qué equipo
--        audiencia-hoy     tarea diaria: audiencias de hoy y de mañana
--        audiencia-manana
--        recordatorio      tarea diaria: el recordatorio personal del
--                          administrador que empieza hoy
--      Los que ya existían (soporte, estados, plazos, vencidos,
--      solicitudes de clave) siguen igual.
--
--   3. AVISOS PUSH. Lo que cae en la campana de un administrador le
--      llega también al celular (o al computador) donde activó los
--      avisos, aunque el portal esté cerrado. Así:
--
--        notificaciones (insert)
--          └ disparador push_avisos, una vez por sentencia
--              └ pg_net: POST a la Edge Function avisos-push con los ids
--                  └ push_tomar(ids): marca cada aviso como enviado y
--                    devuelve a qué equipos va
--                      └ la función cifra y entrega por Web Push (VAPID)
--                          └ push_resultado: anota cómo salió y borra
--                            los equipos que ya no existen (404 / 410)
--
--      La base solo manda ids, nunca el texto. Por eso no importa que
--      la función se pueda llamar desde fuera: push_tomar entrega cada
--      aviso UNA vez, solo a su dueño, y solo si tiene menos de 15
--      minutos. Llamarla a mano no inventa avisos ni los repite.
--
--      Si falta pg_net, la función o las claves VAPID, la campana
--      funciona igual que antes: el aviso simplemente no sale al
--      celular. Nada de esto puede tumbar un insert.
--
-- CATEGORÍAS
--   Cada equipo elige qué recibe (documentos, audiencias, estados,
--   soporte, accesos, calendario). Lo dice _push_categoria().
--   'ingreso-propio' (el aviso de cada pestaña nueva) no sale al
--   celular: sería un aviso cada vez que se abre el portal.
--
-- LO QUE HAY QUE HACER EN EL SERVIDOR
--   Claves VAPID en los secretos de las funciones, la función
--   avisos-push, y la URL de la función en push_ajustes si no es la de
--   siempre (ver base-de-datos/LEEME.md).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) El monitor en el chat de soporte
-- ------------------------------------------------------------
create or replace function public.puede_soporte(operador uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
    select public.es_admin()
        or (public.rol_actual() in ('operador', 'monitor') and operador = auth.uid());
$$;

-- Lo que escriba un operador o un monitor le llega al administrador
create or replace function public.notif_soporte_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_quien text := coalesce(nullif(new.autor_nombre, ''), 'Alguien del equipo');
begin
    if new.rol in ('operador', 'monitor') then
        perform public._notificar_admins('soporte',
            v_quien || ' (' || new.rol || ') escribió a soporte: ' ||
            case when coalesce(new.texto, '') <> '' then '«' || left(new.texto, 120) || '»'
                 else 'envió el archivo «' || coalesce(nullif(new.archivo_nombre, ''), 'adjunto') || '»'
            end,
            null, new.id);
    end if;
    return new;
end;
$$;

-- El administrador también puede llamar al monitor desde su hilo
drop policy if exists "solo admin inicia llamadas" on public.llamadas_soporte;
create policy "solo admin inicia llamadas" on public.llamadas_soporte
    for insert with check (
        public.es_admin()
        and iniciador = (select auth.uid())
        and exists (select 1 from public.perfiles p
                    where p.id = destino and p.activo
                      and p.rol in ('operador', 'monitor', 'cliente', 'acreedor'))
    );


-- ------------------------------------------------------------
-- 2) Dónde se guarda cada equipo que recibe avisos
-- ------------------------------------------------------------
-- Una fila por navegador. endpoint, p256dh y auth los da el navegador
-- al suscribirse (PushSubscription.toJSON()); con ellos se cifra el
-- aviso para ese equipo y nadie más puede leerlo en el camino.
create table if not exists public.suscripciones_push (
    id            bigint generated always as identity primary key,
    perfil_id     uuid not null references public.perfiles (id) on delete cascade,
    endpoint      text not null unique
                  check (endpoint ~ '^https://\S+$' and length(endpoint) <= 1000),
    p256dh        text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}=*$'),
    auth          text not null check (auth ~ '^[A-Za-z0-9_-]{16,30}=*$'),
    dispositivo   text not null default '',
    categorias    text[] not null
                  default array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'],
    creada        timestamptz not null default now(),
    ultimo_envio  timestamptz,
    ultimo_estado int            -- lo que respondió el servicio de avisos (201 = entregado)
);
create index if not exists idx_suscripciones_push_perfil on public.suscripciones_push (perfil_id);

-- Cada quien ve las suyas (el portal pregunta si este equipo está
-- activo y cómo salió la prueba). Escribir, solo por las funciones.
alter table public.suscripciones_push enable row level security;
revoke all on public.suscripciones_push from public, anon, authenticated;
revoke all on sequence public.suscripciones_push_id_seq from public, anon, authenticated;
grant select on public.suscripciones_push to authenticated;

drop policy if exists "ver mis equipos con avisos" on public.suscripciones_push;
create policy "ver mis equipos con avisos" on public.suscripciones_push
    for select using (perfil_id = (select auth.uid()));

-- A dónde llama la base. Una sola fila, opcional: sin ella se usa la
-- dirección interna de autohospedado y ninguna clave. En Supabase cloud
-- va https://<proyecto>.supabase.co/functions/v1/avisos-push y la clave
-- igual al secreto AVISOS_CLAVE de la función (viaja en x-aviso-clave).
create table if not exists public.push_ajustes (
    id    int primary key default 1 check (id = 1),
    url   text not null default 'http://functions:9000/avisos-push',
    clave text not null default ''
);
alter table public.push_ajustes enable row level security;
revoke all on public.push_ajustes from public, anon, authenticated;

-- Cuándo salió al celular. Null = todavía no (o no tenía a dónde).
alter table public.notificaciones add column if not exists push_enviado timestamptz;


-- ------------------------------------------------------------
-- 3) Ayudantes
-- ------------------------------------------------------------
-- De qué categoría es cada aviso. Null = no sale al celular.
create or replace function public._push_categoria(p_tipo text)
returns text
language sql immutable
as $$
    select case
        when p_tipo = 'archivo-admin'   then 'documentos'
        when p_tipo = 'audiencia-nueva' then 'audiencias'
        when p_tipo in ('proceso-nuevo', 'proceso-estado', 'proceso-semaforo',
                        'tramite-pausado', 'tramite-reactivado', 'tramite-finalizado',
                        'tramite-prorroga', 'tramite-fin') then 'estados'
        when p_tipo = 'soporte'         then 'soporte'
        when p_tipo in ('ingreso-cuenta', 'solicitud-clave') then 'accesos'
        when p_tipo in ('audiencia-hoy', 'audiencia-manana', 'recordatorio', 'proceso-vencido')
          or p_tipo like 'plazo-%'      then 'calendario'
        when p_tipo = 'push-prueba'     then 'prueba'
    end;
$$;

-- «Android · Chrome» a partir del user-agent, como lo escribe nube.js
create or replace function public._push_dispositivo(ua text)
returns text
language sql immutable
as $$
    select case
               when ua ~* 'android'          then 'Android'
               when ua ~* 'iphone|ipad|ipod' then 'iPhone o iPad'
               when ua ~* 'windows'          then 'Windows'
               when ua ~* 'mac os'           then 'Mac'
               when ua ~* 'linux'            then 'Linux'
               else 'un equipo sin identificar'
           end ||
           coalesce(' · ' || case
               when ua ~ 'Edg/'        then 'Edge'
               when ua ~ 'OPR/|Opera'  then 'Opera'
               when ua ~ 'Chrome/'     then 'Chrome'
               when ua ~ 'Firefox/'    then 'Firefox'
               when ua ~ 'Safari/'     then 'Safari'
           end, '');
$$;

-- '14:30' → '2:30 PM'. Lo que no sea una hora se deja como vino.
create or replace function public._push_hora(p_hora text)
returns text
language plpgsql immutable
as $$
begin
    if coalesce(p_hora, '') !~ '^\d{1,2}:\d{2}' then return nullif(trim(p_hora), ''); end if;
    return to_char(substring(p_hora from '^\d{1,2}:\d{2}')::time, 'FMHH12:MI AM');
exception when others then
    return nullif(trim(p_hora), '');
end;
$$;

-- Quién hizo algo, para el texto del aviso: «Ana Gómez (operador)»
create or replace function public._push_quien(p_respaldo text default '')
returns text
language sql stable security definer set search_path = public
as $$
    select coalesce(
        (select p.nombre || ' (' || p.rol || ')' from public.perfiles p where p.id = auth.uid()),
        nullif(p_respaldo, ''),
        'Alguien');
$$;


-- ------------------------------------------------------------
-- 4) Avisos nuevos para el administrador
-- ------------------------------------------------------------
-- Documento subido. El que lo sube no se avisa a sí mismo
-- (_notificar_admins deja por fuera a quien hace la acción).
create or replace function public.notif_archivo_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
    v_sub     text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    if new.subcarpeta_id is not null then
        select nombre into v_sub from public.subcarpetas where id = new.subcarpeta_id;
    end if;
    perform public._notificar_admins('archivo-admin',
        public._push_quien(new.subido_por_usuario) || ' subió «' || new.nombre ||
        '» a «' || coalesce(v_carpeta, '') || '»' || coalesce(' › ' || v_sub, ''),
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_archivo_admin on public.archivos;
create trigger notif_archivo_admin after insert on public.archivos
    for each row execute function public.notif_archivo_admin();

-- Audiencia programada en el calendario de una carpeta
create or replace function public.notif_audiencia_nueva()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    perform public._notificar_admins('audiencia-nueva',
        public._push_quien() || ' programó la audiencia «' ||
        coalesce(nullif(new.titulo, ''), 'sin título') || '» para el ' ||
        to_char(new.fecha, 'DD/MM/YYYY') ||
        coalesce(' a las ' || public._push_hora(new.hora), '') ||
        ' en «' || coalesce(v_carpeta, '') || '»',
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_audiencia_nueva on public.audiencias;
create trigger notif_audiencia_nueva after insert on public.audiencias
    for each row execute function public.notif_audiencia_nueva();

-- Proceso nuevo (lo que el portal muestra en «Estados»)
create or replace function public.notif_proceso_nuevo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_carpeta text;
begin
    select nombre into v_carpeta from public.carpetas where id = new.carpeta_id;
    perform public._notificar_admins('proceso-nuevo',
        public._push_quien() || ' creó el proceso «' || new.nombre || '» (' ||
        new.dias_habiles_limite || ' días hábiles, vence el ' ||
        to_char(new.fecha_vencimiento_habil, 'DD/MM/YYYY') || ') en «' ||
        coalesce(v_carpeta, '') || '»',
        new.carpeta_id, new.id);
    return new;
end;
$$;
drop trigger if exists notif_proceso_nuevo on public.procesos_tramite;
create trigger notif_proceso_nuevo after insert on public.procesos_tramite
    for each row execute function public.notif_proceso_nuevo();

-- Inicio de sesión con la cuenta de un administrador. Se le avisa a
-- ese mismo administrador, en todos sus equipos.
--
-- Va sobre auth.sessions, que GoTrue escribe en CADA ingreso con
-- contraseña, pase por el portal o no. Corre dentro del ingreso, así
-- que no puede fallar nunca: cualquier error se traga y el ingreso
-- sigue. El user-agent se lee como jsonb porque esa columna no existe
-- en las versiones viejas de GoTrue.
create or replace function public.notif_ingreso_cuenta()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_ua   text;
    v_quien uuid;
begin
    begin
        if tg_table_schema = 'auth' then
            v_quien := (to_jsonb(new) ->> 'user_id')::uuid;
            v_ua := public._push_dispositivo(coalesce(to_jsonb(new) ->> 'user_agent', ''));
        else
            v_quien := (to_jsonb(new) ->> 'perfil_id')::uuid;
            v_ua := coalesce(nullif(to_jsonb(new) ->> 'dispositivo', ''), 'un equipo sin identificar');
        end if;
        if exists (select 1 from public.perfiles
                    where id = v_quien and rol = 'administrador' and activo) then
            perform public._notificar(v_quien, 'ingreso-cuenta',
                'Se inició sesión con tu usuario en ' || v_ua || ' el ' ||
                to_char(now() at time zone 'America/Bogota', 'DD/MM/YYYY') || ' a las ' ||
                to_char(now() at time zone 'America/Bogota', 'FMHH12:MI AM') ||
                '. Si no fuiste tú, cambia la contraseña.',
                null, null);
        end if;
    exception when others then
        raise warning 'aviso de ingreso: %', sqlerrm;
    end;
    return new;
end;
$$;

-- En auth.sessions si se puede; si no, en public.sesiones, que escribe
-- el portal al entrar (sesion_abrir).
do $$
begin
    drop trigger if exists notif_ingreso_cuenta on public.sesiones;
    begin
        execute 'drop trigger if exists notif_ingreso_cuenta on auth.sessions';
        execute 'create trigger notif_ingreso_cuenta after insert on auth.sessions
                     for each row execute function public.notif_ingreso_cuenta()';
        raise notice 'Aviso de ingreso: en auth.sessions.';
    exception when others then
        create trigger notif_ingreso_cuenta after insert or update of sesion_id on public.sesiones
            for each row execute function public.notif_ingreso_cuenta();
        raise notice 'Aviso de ingreso: sin permiso sobre auth.sessions (%), va en public.sesiones.', sqlerrm;
    end;
end $$;


-- ------------------------------------------------------------
-- 5) Calendario: la tarea de cada mañana
-- ------------------------------------------------------------
-- Audiencias de hoy y de mañana (a los administradores de esa
-- notaría) y los recordatorios propios del administrador que empiezan
-- hoy. Una vez por persona y por audiencia o recordatorio.
create or replace function public.avisos_calendario_diario()
returns int
language plpgsql security definer set search_path = public
as $$
declare
    hoy    date := (now() at time zone 'America/Bogota')::date;
    n      int := 0;
    n_fila int;
begin
    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    select p.id, x.tipo,
           left(x.cuando || coalesce(' a las ' || public._push_hora(a.hora), '') ||
                ': audiencia «' || coalesce(nullif(a.titulo, ''), 'sin título') ||
                '» de «' || c.nombre || '»', 300),
           a.carpeta_id, a.id, c.notaria_id
      from public.audiencias a
      join public.carpetas c on c.id = a.carpeta_id and c.activa
      cross join lateral (select case when a.fecha = hoy then 'audiencia-hoy' else 'audiencia-manana' end as tipo,
                                 case when a.fecha = hoy then 'Hoy' else 'Mañana' end as cuando) x
      join public.perfiles p on p.rol = 'administrador' and p.activo
                            and public.perfil_alcanza_notaria(p.id, c.notaria_id)
     where a.fecha in (hoy, hoy + 1)
       and not exists (select 1 from public.notificaciones n
                        where n.tipo = x.tipo and n.referencia_id = a.id
                          and n.destinatario_id = p.id);
    get diagnostics n_fila = row_count;
    n := n + n_fila;

    insert into public.notificaciones (destinatario_id, tipo, mensaje, carpeta_id,
                                       referencia_id, notaria_id)
    select r.perfil_id, 'recordatorio',
           left('Recordatorio de «' || c.nombre || '»: ' || r.mensaje, 300),
           r.carpeta_id, r.id, c.notaria_id
      from public.recordatorios r
      join public.perfiles p on p.id = r.perfil_id and p.rol = 'administrador' and p.activo
      join public.carpetas c on c.id = r.carpeta_id
     where r.fecha_inicio = hoy
       and not exists (select 1 from public.notificaciones n
                        where n.tipo = 'recordatorio' and n.referencia_id = r.id
                          and n.destinatario_id = r.perfil_id);
    get diagnostics n_fila = row_count;
    return n + n_fila;
end;
$$;

-- 11:45 UTC = 6:45 a. m. en Colombia, antes de la de plazos (7:00).
-- Todos los días: una audiencia de lunes se avisa el domingo.
select cron.unschedule('calendario-diario') where exists (
    select 1 from cron.job where jobname = 'calendario-diario'
);
select cron.schedule(
    'calendario-diario',
    '45 11 * * *',
    $$ select public.avisos_calendario_diario(); $$
);


-- ------------------------------------------------------------
-- 6) De la campana al celular
-- ------------------------------------------------------------
-- Una llamada por sentencia, con todos los ids que tienen a dónde ir.
-- La tarea diaria inserta varios avisos de una vez: así salen en un
-- solo viaje y la función los puede agrupar por equipo.
create or replace function public._push_avisar()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
    v_ids   bigint[];
    v_url   text;
    v_clave text;
begin
    select array_agg(n.id order by n.id) into v_ids
      from nuevas n
      join public.perfiles p on p.id = n.destinatario_id and p.rol = 'administrador' and p.activo
     where public._push_categoria(n.tipo) is not null
       and exists (select 1 from public.suscripciones_push s
                    where s.perfil_id = n.destinatario_id
                      and (public._push_categoria(n.tipo) = 'prueba'
                           or public._push_categoria(n.tipo) = any (s.categorias)));
    if v_ids is null then return null; end if;

    select url, clave into v_url, v_clave from public.push_ajustes where id = 1;
    begin
        perform net.http_post(
            url := coalesce(nullif(v_url, ''), 'http://functions:9000/avisos-push'),
            body := jsonb_build_object('ids', to_jsonb(v_ids)),
            headers := jsonb_build_object('Content-Type', 'application/json') ||
                       case when coalesce(v_clave, '') <> ''
                            then jsonb_build_object('x-aviso-clave', v_clave)
                            else '{}'::jsonb end,
            timeout_milliseconds := 15000);
    exception when others then
        -- Sin pg_net o sin red: la campana sigue, el celular no se entera
        raise warning 'avisos push: no se pudo llamar a la función: %', sqlerrm;
    end;
    return null;
end;
$$;
drop trigger if exists push_avisos on public.notificaciones;
create trigger push_avisos after insert on public.notificaciones
    referencing new table as nuevas
    for each statement execute function public._push_avisar();

-- pg_net viene en la imagen de Supabase. Si no está, se sigue sin él.
do $$
begin
    create extension if not exists pg_net with schema extensions;
exception when others then
    raise notice 'pg_net no está disponible (%): los avisos no saldrán al celular.', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- 7) Lo que llama la Edge Function (service_role)
-- ------------------------------------------------------------
-- Toma los avisos: cada uno una sola vez, recientes, y solo para un
-- administrador activo. Devuelve una entrada por equipo con sus avisos.
create or replace function public.push_tomar(p_ids bigint[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v jsonb;
begin
    with tomadas as (
        update public.notificaciones n
           set push_enviado = now()
         where n.id = any (coalesce(p_ids, '{}'::bigint[]))
           and n.push_enviado is null
           and n.fecha > now() - interval '15 minutes'
           and public._push_categoria(n.tipo) is not null
        returning n.id, n.destinatario_id, n.tipo, n.mensaje, n.carpeta_id, n.notaria_id
    )
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v
      from (
        select s.id, s.endpoint, s.p256dh, s.auth,
               jsonb_agg(jsonb_build_object(
                   'id', t.id, 'tipo', t.tipo, 'mensaje', t.mensaje,
                   'categoria', public._push_categoria(t.tipo),
                   'carpeta', t.carpeta_id,
                   'notaria', case when o.id is null then null
                                   else o.nombre || ' (' || o.ciudad || ')' end)
                   order by t.id) as avisos
          from tomadas t
          join public.perfiles p on p.id = t.destinatario_id and p.activo and p.rol = 'administrador'
          join public.suscripciones_push s on s.perfil_id = t.destinatario_id
               and (public._push_categoria(t.tipo) = 'prueba'
                    or public._push_categoria(t.tipo) = any (s.categorias))
          left join public.notarias o on o.id = t.notaria_id
         group by s.id
      ) e;

    -- La prueba ya cumplió: no se queda en la campana
    delete from public.notificaciones
     where id = any (coalesce(p_ids, '{}'::bigint[]))
       and tipo = 'push-prueba' and push_enviado is not null;
    return v;
end;
$$;

-- Cómo le fue a cada equipo: [{"id": 3, "estado": 201}, ...]
-- 404 y 410 = el navegador ya no tiene esa suscripción: se borra.
create or replace function public.push_resultado(p_resultados jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
begin
    if jsonb_typeof(p_resultados) is distinct from 'array' then return; end if;
    update public.suscripciones_push s
       set ultimo_envio = now(), ultimo_estado = (r ->> 'estado')::int
      from jsonb_array_elements(p_resultados) r
     where s.id = (r ->> 'id')::bigint;
    delete from public.suscripciones_push s
     using jsonb_array_elements(p_resultados) r
     where s.id = (r ->> 'id')::bigint
       and (r ->> 'estado')::int in (404, 410);
end;
$$;


-- ------------------------------------------------------------
-- 8) Lo que llama el portal (solo administradores)
-- ------------------------------------------------------------
-- Activa este equipo, o lo pone al día si el navegador cambió las
-- llaves. Con p_categorias null conserva las que ya tenía. Máximo 10
-- equipos por persona: el más viejo sale.
create or replace function public.push_suscribir(p_endpoint text, p_p256dh text, p_auth text,
                                                 p_dispositivo text default '',
                                                 p_categorias text[] default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
    validas constant text[] := array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'];
    v_cat text[];
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador recibe avisos en el celular.' using errcode = '42501';
    end if;
    if coalesce(p_endpoint, '') !~ '^https://\S+$' or length(p_endpoint) > 1000
       or coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}=*$'
       or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,30}=*$' then
        raise exception 'El navegador entregó una suscripción que no es válida.' using errcode = '22023';
    end if;
    v_cat := case when p_categorias is null then null
                  else array(select c from unnest(validas) c where c = any (p_categorias)) end;

    insert into public.suscripciones_push as s (perfil_id, endpoint, p256dh, auth, dispositivo, categorias)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_dispositivo, ''), 120),
            coalesce(v_cat, validas))
    on conflict (endpoint) do update
        set p256dh = excluded.p256dh,
            auth = excluded.auth,
            dispositivo = excluded.dispositivo,
            -- Mismo navegador, otra cuenta: empieza de cero
            categorias = case
                when v_cat is not null then v_cat
                when s.perfil_id = excluded.perfil_id then s.categorias
                else validas end,
            ultimo_envio  = case when s.perfil_id = excluded.perfil_id then s.ultimo_envio end,
            ultimo_estado = case when s.perfil_id = excluded.perfil_id then s.ultimo_estado end,
            perfil_id = excluded.perfil_id;

    delete from public.suscripciones_push
     where id in (select id from public.suscripciones_push
                   where perfil_id = auth.uid()
                   order by creada desc offset 10);
end;
$$;

create or replace function public.push_quitar(p_endpoint text)
returns void
language sql security definer set search_path = public
as $$
    delete from public.suscripciones_push
     where endpoint = p_endpoint and perfil_id = auth.uid();
$$;

create or replace function public.push_categorias(p_endpoint text, p_categorias text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
    validas constant text[] := array['documentos', 'audiencias', 'estados', 'soporte', 'accesos', 'calendario'];
begin
    update public.suscripciones_push
       set categorias = array(select c from unnest(validas) c where c = any (coalesce(p_categorias, '{}')))
     where endpoint = p_endpoint and perfil_id = auth.uid();
end;
$$;

-- Un aviso de prueba a todos los equipos del administrador. Devuelve
-- su id; el portal mira después ultimo_envio y ultimo_estado.
create or replace function public.push_probar()
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_id bigint;
begin
    if not coalesce(public.es_admin(), false) then
        raise exception 'Solo el administrador recibe avisos en el celular.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.suscripciones_push where perfil_id = auth.uid()) then
        raise exception 'Primero activa los avisos en este equipo.' using errcode = '22023';
    end if;
    if exists (select 1 from public.notificaciones
                where destinatario_id = auth.uid() and tipo = 'push-prueba'
                  and fecha > now() - interval '10 seconds') then
        raise exception 'Espera unos segundos antes de otra prueba.' using errcode = '22023';
    end if;
    insert into public.notificaciones (destinatario_id, tipo, mensaje)
    values (auth.uid(), 'push-prueba', 'Si ves esto en tu celular, los avisos del portal quedaron activos.')
    returning id into v_id;
    return v_id;
end;
$$;


-- ------------------------------------------------------------
-- 9) Permisos
-- ------------------------------------------------------------
do $$
declare
    f record;
    internas constant text[] := array[
        '_push_categoria', '_push_dispositivo', '_push_hora', '_push_quien', '_push_avisar',
        'notif_archivo_admin', 'notif_audiencia_nueva', 'notif_proceso_nuevo',
        'notif_ingreso_cuenta', 'notif_soporte_nuevo',
        'avisos_calendario_diario', 'push_tomar', 'push_resultado'
    ];
    del_portal constant text[] := array['push_suscribir', 'push_quitar', 'push_categorias', 'push_probar'];
begin
    for f in
        select p.oid::regprocedure as firma, p.proname as nombre
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname = any (internas) or p.proname = any (del_portal))
    loop
        execute format('revoke execute on function %s from public, anon', f.firma);
        if f.nombre = any (del_portal) then
            execute format('grant execute on function %s to authenticated', f.firma);
        else
            execute format('revoke execute on function %s from authenticated', f.firma);
        end if;
    end loop;
end $$;

grant execute on function public.push_tomar(bigint[])   to service_role;
grant execute on function public.push_resultado(jsonb)  to service_role;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- Del portal: authenticated sí, anon no. De la función: solo service_role.
select p.proname as funcion,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('push_suscribir', 'push_quitar', 'push_categorias', 'push_probar',
                     'push_tomar', 'push_resultado', '_notificar')
 order by 1;

-- ¿Está pg_net? ¿Dónde quedó el aviso de ingreso?
select exists (select 1 from pg_extension where extname = 'pg_net') as pg_net,
       (select string_agg(event_object_schema || '.' || event_object_table, ', ')
          from information_schema.triggers
         where trigger_name = 'notif_ingreso_cuenta') as aviso_de_ingreso_en;


-- ############################################################
-- PARTE 28 DE 31: migracion_aviso_solicitud_clave.sql
-- El aviso de solicitud de clave dice nombre y rol, y se repite si la persona insiste
-- ############################################################

-- ============================================================
-- MIGRACIÓN: el aviso de solicitud de clave dice quién es y se
--            repite si la persona insiste
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. Solicitud de clave («¿Olvidaste tu contraseña?»): el aviso al
--      administrador (campana y celular, categoría Accesos) dice nombre
--      y rol, y si la persona vuelve a pedirla con una solicitud todavía
--      pendiente, avisa otra vez (máximo uno cada 30 minutos). Antes la
--      segunda solicitud no avisaba nada mientras la primera siguiera
--      abierta.
--
--   2. Las llamadas siguen siendo solo del administrador a operadores,
--      monitores y clientes; operadores y monitores escriben por el chat.
--      Una versión anterior de este archivo (migracion_llamadas_al_admin)
--      dejaba que ellos llamaran a la administración y estuvo publicada
--      un rato: si alguien la alcanzó a correr, esto la deshace.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Solicitud de clave: quién es, y aviso otra vez si insiste
-- ------------------------------------------------------------
-- Igual que en migracion_endurecimiento_2026_09.sql (mismos topes y
-- misma respuesta exista o no el usuario), con dos cambios:
--   · el aviso dice nombre y rol; el usuario va primero entre « »
--     porque la campana lo lee de ahí para abrir su ficha;
--   · con una solicitud pendiente, la nueva no se descarta en silencio:
--     si la anterior avisó hace más de 30 minutos, avisa otra vez.
create or replace function public.solicitar_restablecimiento(p_usuario text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    u text := lower(trim(coalesce(p_usuario, '')));
    recientes int;
    suyas int;
    v_nombre text;
    v_rol    text;
    v_otra   boolean := false;
    TOPE_GLOBAL   constant int := 40;
    TOPE_USUARIO  constant int := 3;
    VENTANA       constant interval := interval '15 minutes';
    REPETIR       constant interval := interval '30 minutes';
begin
    if u = '' or length(u) > 30 then return; end if;

    select count(*) into recientes
      from public.solicitudes_clave
     where fecha > now() - VENTANA;
    if recientes >= TOPE_GLOBAL then return; end if;

    select count(*) into suyas
      from public.solicitudes_clave
     where usuario = u and fecha > now() - VENTANA;
    if suyas >= TOPE_USUARIO then return; end if;

    -- Se responde igual exista o no el usuario: lo contrario revelaría
    -- quién tiene cuenta en el portal
    select nombre, rol into v_nombre, v_rol from public.perfiles where usuario = u and activo;
    if not found then return; end if;

    if exists (select 1 from public.solicitudes_clave where usuario = u and estado = 'pendiente') then
        update public.solicitudes_clave
           set fecha = now()
         where usuario = u and estado = 'pendiente' and fecha < now() - REPETIR;
        if not found then return; end if;
        v_otra := true;
    else
        insert into public.solicitudes_clave (usuario) values (u);
    end if;

    perform public._notificar_admins('solicitud-clave',
        'El usuario «' || u || '» (' || coalesce(nullif(v_nombre, ''), 'sin nombre') || ', ' || v_rol || ') ' ||
        case when v_otra then 'vuelve a pedir que le restablezcan la contraseña'
             else 'olvidó su contraseña y solicita restablecerla' end,
        null, null);
end;
$$;

revoke execute on function public.solicitar_restablecimiento(text) from public;
grant  execute on function public.solicitar_restablecimiento(text) to anon, authenticated;


-- ------------------------------------------------------------
-- 2) Sin llamadas del equipo a la administración
-- ------------------------------------------------------------
drop function if exists public.llamar_administracion();
drop trigger if exists notif_llamada_soporte on public.llamadas_soporte;
drop function if exists public.notif_llamada_soporte();
drop index if exists public.idx_llamadas_iniciador_creado;
alter table public.llamadas_soporte drop column if exists grupo;
alter table public.llamadas_soporte drop column if exists iniciador_nombre;
delete from public.notificaciones where tipo in ('llamada-soporte', 'llamada-perdida');

-- La de migracion_avisos_push.sql, sin los dos tipos de llamada
create or replace function public._push_categoria(p_tipo text)
returns text
language sql immutable
as $$
    select case
        when p_tipo = 'archivo-admin'   then 'documentos'
        when p_tipo = 'audiencia-nueva' then 'audiencias'
        when p_tipo in ('proceso-nuevo', 'proceso-estado', 'proceso-semaforo',
                        'tramite-pausado', 'tramite-reactivado', 'tramite-finalizado',
                        'tramite-prorroga', 'tramite-fin') then 'estados'
        when p_tipo = 'soporte'         then 'soporte'
        when p_tipo in ('ingreso-cuenta', 'solicitud-clave') then 'accesos'
        when p_tipo in ('audiencia-hoy', 'audiencia-manana', 'recordatorio', 'proceso-vencido')
          or p_tipo like 'plazo-%'      then 'calendario'
        when p_tipo = 'push-prueba'     then 'prueba'
    end;
$$;

notify pgrst, 'reload schema';

commit;


-- ============================================================
-- COMPROBACIÓN (solo lee)
-- ============================================================
-- solicitar_restablecimiento: anon y authenticated (quien olvidó la
-- clave no ha entrado). llamar_administracion no debe salir.
select p.proname as funcion,
       has_function_privilege('anon',          p.oid, 'execute') as anon_puede,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('solicitar_restablecimiento', 'llamar_administracion')
 order by 1;


-- ############################################################
-- PARTE 29 DE 31: migracion_renombrar_y_tope_300.sql
-- El administrador y el operador renombran documentos y videos, y el tope por archivo baja a 300 MB
-- ############################################################

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


-- ############################################################
-- PARTE 30 DE 31: migracion_ajustes_cloud.sql
-- search_path fijo en las funciones de ayuda de los avisos y rls_auto_enable cerrada a usuarios con sesión
-- ############################################################

-- ============================================================
-- MIGRACIÓN: ajustes para Supabase cloud
-- ============================================================
-- Idempotente. Va en una transacción.
--
-- QUÉ HACE
--   1. Fija el search_path de las tres funciones de ayuda de los
--      avisos. El linter de Supabase las marca: sin search_path fijo,
--      quien cambie el suyo podría hacerlas resolver otra cosa.
--   2. Le quita a los usuarios con sesión el EXECUTE de
--      rls_auto_enable(), la función que Supabase cloud crea para
--      encender RLS en tablas nuevas. migracion_endurecimiento_2026_09.sql
--      recorre todas las SECURITY DEFINER de public y se lo devolvía.
-- ============================================================

begin;

alter function public._push_categoria(text)   set search_path = pg_catalog, public;
alter function public._push_hora(text)        set search_path = pg_catalog, public;
alter function public._push_dispositivo(text) set search_path = pg_catalog, public;

-- Solo existe en Supabase cloud; en autohospedado no hay nada que hacer
do $$
begin
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
        revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
    end if;
end $$;

commit;


-- ############################################################
-- PARTE 31 DE 31: migracion_almacenamiento_storage.sql
-- Almacenamiento se mide en Storage de Supabase contra el cupo del plan, sin tarea del servidor
-- ############################################################

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
