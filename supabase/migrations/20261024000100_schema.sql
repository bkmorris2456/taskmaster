-- Phase 6: append-only migrations. Apply as the database migration administrator.
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

CREATE SCHEMA taskmaster_private;

REVOKE ALL ON SCHEMA taskmaster_private FROM public, anon, authenticated, service_role;

REVOKE CREATE ON SCHEMA public FROM public, anon, authenticated, service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'taskmaster_executor') THEN
    CREATE ROLE taskmaster_executor nologin NOSUPERUSER NOCREATEDB NOCREATEROLE noinherit nobypassrls;
ELSIF EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'taskmaster_executor'
            AND (rolcanlogin
                OR rolsuper
                OR rolbypassrls
                OR rolcreatedb
                OR rolcreaterole
                OR rolinherit)) THEN
    RAISE EXCEPTION 'Unsafe existing taskmaster_executor role';
END IF;
    IF pg_has_role('anon', 'taskmaster_executor', 'MEMBER') OR pg_has_role('authenticated', 'taskmaster_executor', 'MEMBER') OR pg_has_role('service_role', 'taskmaster_executor', 'MEMBER') OR pg_has_role('authenticator', 'taskmaster_executor', 'MEMBER') THEN
        RAISE EXCEPTION 'Unsafe API role membership in executor';
    END IF;
END
$$;

-- Only the protected migration administrator may assign object ownership.
GRANT taskmaster_executor TO CURRENT_USER;

GRANT usage ON SCHEMA public, taskmaster_private, auth, extensions TO taskmaster_executor;

GRANT EXECUTE ON FUNCTION auth.uid (), auth.jwt () TO taskmaster_executor;

ALTER DEFAULT privileges IN SCHEMA taskmaster_private REVOKE EXECUTE ON functions FROM public;

ALTER DEFAULT privileges IN SCHEMA public REVOKE EXECUTE ON functions FROM public;

CREATE FUNCTION taskmaster_private.trim_text (value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE STRICT
    SET search_path = ''
    AS $$
    SELECT
        btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;

CREATE FUNCTION taskmaster_private.utf16_length (value text)
    RETURNS integer
    LANGUAGE sql
    IMMUTABLE STRICT
    SET search_path = ''
    AS $$
    SELECT
        coalesce(sum(
                CASE WHEN octet_length(c) = 4 THEN
                    2
                ELSE
                    1
                END), 0)::integer
    FROM
        pg_catalog.regexp_split_to_table(value, '') c;
$$;

GRANT EXECUTE ON FUNCTION taskmaster_private.trim_text (text), taskmaster_private.utf16_length (text) TO taskmaster_executor;

CREATE TABLE public.categories (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    name text NOT NULL CHECK (name = taskmaster_private.trim_text (name) AND length(name) > 0 AND taskmaster_private.utf16_length (name) <= 80),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    last_operation_id uuid NOT NULL,
    PRIMARY KEY (owner_id, id)
);

CREATE UNIQUE INDEX categories_live_name ON public.categories (owner_id, lower(normalize (name, NFC)))
WHERE
    deleted_at IS NULL;

CREATE TABLE public.groups (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    category_id uuid NOT NULL,
    name text NOT NULL CHECK (name = taskmaster_private.trim_text (name) AND length(name) > 0 AND taskmaster_private.utf16_length (name) <= 80),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    last_operation_id uuid NOT NULL,
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, id, category_id),
    FOREIGN KEY (owner_id, category_id) REFERENCES public.categories (owner_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX groups_live_name ON public.groups (owner_id, category_id, lower(normalize (name, NFC)))
WHERE
    deleted_at IS NULL;

CREATE TABLE public.recurrence_series (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    title text NOT NULL CHECK (length(title) > 0 AND title = taskmaster_private.trim_text (title) AND taskmaster_private.utf16_length (title) <= 240),
    description text CHECK (taskmaster_private.utf16_length (description) <= 10000),
    priority text CHECK (priority IN ('low', 'normal', 'high')),
    category_id uuid,
    group_id uuid,
    frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    anchor_date date NOT NULL CHECK (anchor_date between date '1900-01-01' and date '9999-12-31'),
    time_zone text NOT NULL,
    schedule_revision bigint NOT NULL CHECK (schedule_revision BETWEEN 1 AND 9007199254740991),
    active_task_id uuid,
    enabled boolean NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    last_operation_id uuid NOT NULL,
    PRIMARY KEY (owner_id, id),
    CHECK (group_id IS NULL OR category_id IS NOT NULL),
    CHECK ((enabled AND deleted_at IS NULL AND active_task_id IS NOT NULL) OR (NOT enabled AND active_task_id IS NULL)),
    FOREIGN KEY (owner_id, category_id) REFERENCES public.categories (owner_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_id, group_id, category_id) REFERENCES public.groups (owner_id, id, category_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX series_category ON public.recurrence_series (owner_id, category_id);

CREATE INDEX series_group ON public.recurrence_series (owner_id, group_id);

CREATE TABLE public.tasks (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    title text NOT NULL CHECK (title = taskmaster_private.trim_text (title) AND length(title) > 0 AND taskmaster_private.utf16_length (title) <= 240),
    description text CHECK (taskmaster_private.utf16_length (description) <= 10000),
    completed boolean NOT NULL DEFAULT FALSE,
    completed_at timestamptz,
    current_completion_id uuid,
    due_date date CHECK (due_date between date '1900-01-01' and date '9999-12-31'),
    priority text CHECK (priority IN ('low', 'normal', 'high')),
    category_id uuid,
    group_id uuid,
    series_id uuid,
    occurrence_date date CHECK (occurrence_date between date '1900-01-01' and date '9999-12-31'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    last_operation_id uuid NOT NULL,
    PRIMARY KEY (owner_id, id),
    CHECK (completed = (completed_at IS NOT NULL) AND completed = (current_completion_id IS NOT NULL)),
    CHECK ((series_id IS NULL) = (occurrence_date IS NULL)),
    CHECK (group_id IS NULL OR category_id IS NOT NULL),
    FOREIGN KEY (owner_id, category_id) REFERENCES public.categories (owner_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_id, group_id, category_id) REFERENCES public.groups (owner_id, id, category_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_id, series_id) REFERENCES public.recurrence_series (owner_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX tasks_one_active_occurrence ON public.tasks (owner_id, series_id)
WHERE
    series_id IS NOT NULL AND NOT completed AND deleted_at IS NULL;

CREATE INDEX tasks_category ON public.tasks (owner_id, category_id);

CREATE INDEX tasks_group ON public.tasks (owner_id, group_id);

CREATE INDEX tasks_series ON public.tasks (owner_id, series_id);

CREATE INDEX tasks_due ON public.tasks (owner_id, due_date)
WHERE
    deleted_at IS NULL;

ALTER TABLE public.recurrence_series
    ADD CONSTRAINT series_active_task FOREIGN KEY (owner_id, active_task_id) REFERENCES public.tasks (owner_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.completion_events (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    task_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('completion', 'reversal')),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    time_zone text NOT NULL,
    snapshot jsonb,
    recurrence jsonb,
    reverses_event_id uuid,
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, operation_id),
    UNIQUE (owner_id, id, task_id),
    UNIQUE (owner_id, reverses_event_id),
    CHECK ((kind = 'completion' AND jsonb_typeof(SNAPSHOT) = 'object' AND reverses_event_id IS NULL) OR (kind = 'reversal' AND SNAPSHOT IS NULL AND recurrence IS NULL AND reverses_event_id IS NOT NULL)),
    FOREIGN KEY (owner_id, task_id) REFERENCES public.tasks (owner_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (owner_id, reverses_event_id, task_id) REFERENCES public.completion_events (owner_id, id, task_id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_current_completion FOREIGN KEY (owner_id, current_completion_id, id) REFERENCES public.completion_events (owner_id, id, task_id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX events_task ON public.completion_events (owner_id, task_id, occurred_at);

CREATE TABLE taskmaster_private.sync_state (
    owner_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    sequence bigint
        NOT NULL DEFAULT 0 CHECK (SEQUENCE BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE taskmaster_private.sync_receipts (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    response jsonb NOT NULL,
    dependencies uuid[] NOT NULL DEFAULT '{}',
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, operation_id)
);

CREATE INDEX receipts_dependencies ON taskmaster_private.sync_receipts USING gin (dependencies);

CREATE TABLE taskmaster_private.sync_changes (
    owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    sequence bigint
        NOT NULL CHECK (SEQUENCE BETWEEN 1 AND 9007199254740991),
        kind text NOT NULL CHECK (kind IN ('task', 'category', 'group', 'series', 'event')),
        id uuid NOT NULL,
        operation_id uuid NOT NULL,
        state jsonb NOT NULL,
        PRIMARY KEY (owner_id, SEQUENCE)
);

-- Same policy predicate for every business and protocol surface. The executor does not bypass RLS.
DO $$
DECLARE
    t text;
BEGIN
    foreach t IN ARRAY ARRAY['public.tasks', 'public.categories', 'public.groups', 'public.recurrence_series', 'public.completion_events', 'taskmaster_private.sync_state', 'taskmaster_private.sync_receipts', 'taskmaster_private.sync_changes'] LOOP
        EXECUTE format('alter table %s enable row level security', t);
        EXECUTE format('alter table %s force row level security', t);
        EXECUTE format('revoke all on %s from public, anon, authenticated, service_role', t);
        EXECUTE format('create policy owner_aal2_read on %s for select to authenticated, taskmaster_executor using (owner_id = (select auth.uid()) and (select auth.jwt()->>''aal'') = ''aal2'')', t);
        EXECUTE format('create policy owner_aal2_insert on %s for insert to taskmaster_executor with check (owner_id = (select auth.uid()) and (select auth.jwt()->>''aal'') = ''aal2'')', t);
        EXECUTE format('create policy owner_aal2_update on %s for update to taskmaster_executor using (owner_id = (select auth.uid()) and (select auth.jwt()->>''aal'') = ''aal2'') with check (owner_id = (select auth.uid()) and (select auth.jwt()->>''aal'') = ''aal2'')', t);
        EXECUTE format('grant select, insert, update on %s to taskmaster_executor', t);
    END LOOP;
END
$$;

GRANT usage ON SCHEMA public TO authenticated, anon;

GRANT SELECT ON public.tasks, public.categories, public.groups, public.recurrence_series, public.completion_events TO authenticated;

REVOKE UPDATE ON public.completion_events FROM taskmaster_executor;

CREATE FUNCTION taskmaster_private.check_graph ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    s record;
    n bigint;
    ids uuid[] := '{}';
    checked_task uuid;
    expected bigint;
    actual bigint;
BEGIN
    IF tg_table_name = 'tasks' THEN
        ids := ARRAY[NEW.series_id];
        checked_task := NEW.id;
        IF tg_op = 'UPDATE' THEN
            ids := ids || OLD.series_id;
        END IF;
        IF EXISTS (
            SELECT
                1
            FROM
                public.tasks t
            LEFT JOIN public.categories c ON c.owner_id = t.owner_id
                AND c.id = t.category_id
        LEFT JOIN public.groups g ON g.owner_id = t.owner_id
            AND g.id = t.group_id
    WHERE
        t.owner_id = NEW.owner_id
            AND t.id = NEW.id
            AND (c.deleted_at IS NOT NULL
                OR g.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Deleted parent reference'
            USING errcode = '23514';
    END IF;
ELSIF tg_table_name = 'recurrence_series' THEN
    ids := ARRAY[NEW.id];
    IF EXISTS (
        SELECT
            1
        FROM
            public.recurrence_series rs
        LEFT JOIN public.categories c ON c.owner_id = rs.owner_id
            AND c.id = rs.category_id
    LEFT JOIN public.groups g ON g.owner_id = rs.owner_id
        AND g.id = rs.group_id
WHERE
    rs.owner_id = NEW.owner_id
        AND rs.id = NEW.id
        AND (c.deleted_at IS NOT NULL
            OR g.deleted_at IS NOT NULL)) THEN
RAISE EXCEPTION 'Deleted series parent reference'
        USING errcode = '23514';
END IF;
ELSIF tg_table_name = 'completion_events' THEN
    checked_task := NEW.task_id;
ELSIF tg_table_name = 'categories' THEN
    IF EXISTS (
        SELECT
            1
        FROM
            public.categories c
        WHERE
            c.owner_id = NEW.owner_id
            AND c.id = NEW.id
            AND c.deleted_at IS NOT NULL)
    AND (EXISTS (
            SELECT
                1
            FROM
                public.groups g
            WHERE
                g.owner_id = NEW.owner_id
                AND g.category_id = NEW.id
                AND g.deleted_at IS NULL)
            OR EXISTS (
                SELECT
                    1
                FROM
                    public.tasks t
                WHERE
                    t.owner_id = NEW.owner_id
                    AND t.category_id = NEW.id)
                OR EXISTS (
                    SELECT
                        1
                    FROM
                        public.recurrence_series rs
                    WHERE
                        rs.owner_id = NEW.owner_id
                        AND rs.category_id = NEW.id)) THEN
            RAISE EXCEPTION 'Category deletion must clear assignments'
    USING errcode = '23514';
END IF;
ELSIF tg_table_name = 'groups' THEN
    IF EXISTS (
        SELECT
            1
        FROM
            public.groups g
            JOIN public.categories c ON c.owner_id = g.owner_id
                AND c.id = g.category_id
        WHERE
            g.owner_id = NEW.owner_id
            AND g.id = NEW.id
            AND g.deleted_at IS NULL
            AND c.deleted_at IS NOT NULL)
    OR (EXISTS (
            SELECT
                1
            FROM
                public.groups g
            WHERE
                g.owner_id = NEW.owner_id
                AND g.id = NEW.id
                AND g.deleted_at IS NOT NULL)
            AND (EXISTS (
                    SELECT
                        1
                    FROM
                        public.tasks t
                    WHERE
                        t.owner_id = NEW.owner_id
                        AND t.group_id = NEW.id)
                    OR EXISTS (
                        SELECT
                            1
                        FROM
                            public.recurrence_series rs
                        WHERE
                            rs.owner_id = NEW.owner_id
                            AND rs.group_id = NEW.id))) THEN
            RAISE EXCEPTION 'Group deletion must clear assignments'
    USING errcode = '23514';
END IF;
END IF;
    FOR s IN
    SELECT
        *
    FROM
        public.recurrence_series rs
    WHERE
        rs.owner_id = NEW.owner_id
        AND rs.id = ANY (ids)
            LOOP
                SELECT
                    count(*) INTO n
                FROM
                    public.tasks t
                WHERE
                    t.owner_id = s.owner_id
                    AND t.series_id = s.id
                    AND NOT t.completed
                    AND t.deleted_at IS NULL;
                IF (s.enabled AND (n <> 1 OR NOT EXISTS (
                    SELECT
                        1
                    FROM
                        public.tasks t
                    WHERE
                        t.owner_id = s.owner_id AND t.id = s.active_task_id AND t.series_id = s.id AND NOT t.completed AND t.deleted_at IS NULL))) OR (NOT s.enabled AND n <> 0) THEN
                    RAISE EXCEPTION 'Invalid recurring active occurrence'
                        USING errcode = '23514';
                END IF;
            END LOOP;
    IF checked_task IS NOT NULL THEN
        SELECT
            CASE WHEN t.completed THEN
                1
            ELSE
                0
            END INTO expected
        FROM
            public.tasks t
        WHERE
            t.owner_id = NEW.owner_id
            AND t.id = checked_task;
        SELECT
            count(*) INTO actual
        FROM
            public.completion_events e
        WHERE
            e.owner_id = NEW.owner_id
            AND e.task_id = checked_task
            AND e.kind = 'completion'
            AND NOT EXISTS (
                SELECT
                    1
                FROM
                    public.completion_events r
                WHERE
                    r.owner_id = e.owner_id
                    AND r.reverses_event_id = e.id);
        IF actual <> expected OR EXISTS (
            SELECT
                1
            FROM
                public.tasks t
                JOIN public.completion_events e ON e.owner_id = t.owner_id AND e.id = t.current_completion_id
            WHERE
                t.owner_id = NEW.owner_id AND t.id = checked_task AND (e.kind <> 'completion' OR EXISTS (
                SELECT
                    1
                FROM
                    public.completion_events r
                WHERE
                    r.owner_id = t.owner_id AND r.reverses_event_id = e.id))) THEN
            RAISE EXCEPTION 'Invalid current completion'
                USING errcode = '23514';
        END IF;
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER tasks_graph
    AFTER INSERT OR UPDATE ON public.tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.check_graph ();

CREATE CONSTRAINT TRIGGER series_graph
    AFTER INSERT OR UPDATE ON public.recurrence_series DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.check_graph ();

CREATE CONSTRAINT TRIGGER categories_graph
    AFTER INSERT OR UPDATE ON public.categories DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.check_graph ();

CREATE CONSTRAINT TRIGGER groups_graph
    AFTER INSERT OR UPDATE ON public.groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.check_graph ();

CREATE CONSTRAINT TRIGGER events_graph
    AFTER INSERT ON public.completion_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.check_graph ();

CREATE FUNCTION taskmaster_private.immutable_occurrence ()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
BEGIN
    IF NEW.owner_id <> OLD.owner_id OR NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR (OLD.series_id IS NOT NULL AND NEW.series_id IS NOT NULL AND (NEW.series_id <> OLD.series_id OR NEW.occurrence_date <> OLD.occurrence_date)) THEN
        RAISE EXCEPTION 'Immutable task identity'
            USING errcode = '23514';
    END IF;
    RETURN new;
END
$$;

CREATE TRIGGER immutable_occurrence
    BEFORE UPDATE ON public.tasks FOR EACH ROW
    EXECUTE FUNCTION taskmaster_private.immutable_occurrence ();

REVOKE ALL ON ALL functions IN SCHEMA taskmaster_private FROM public, anon, authenticated, service_role;

GRANT EXECUTE ON ALL functions IN SCHEMA taskmaster_private TO taskmaster_executor;

