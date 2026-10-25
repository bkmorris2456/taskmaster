CREATE FUNCTION taskmaster_private.require_auth ()
    RETURNS uuid
    LANGUAGE plpgsql
    STABLE
    SET search_path = ''
    AS $$
BEGIN
    IF auth.uid () IS NULL OR auth.jwt () ->> 'aal' IS DISTINCT FROM 'aal2' THEN
        RAISE EXCEPTION 'Verified AAL2 authentication required'
            USING errcode = '42501';
    END IF;
    RETURN auth.uid ();
END
$$;

CREATE FUNCTION taskmaster_private.check_object (value jsonb, allowed text[], required text[] DEFAULT '{}')
    RETURNS void
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = ''
    AS $$
DECLARE
    k text;
BEGIN
    IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Expected object'
            USING errcode = '22023';
    END IF;
    FOR k IN
    SELECT
        jsonb_object_keys(value)
        LOOP
            IF NOT k = ANY (allowed) THEN
                RAISE EXCEPTION 'Unsupported field: %', k
                    USING errcode = '22023';
            END IF;
        END LOOP;
    foreach k IN ARRAY required LOOP
        IF NOT value ? k OR value -> k = 'null'::jsonb THEN
            RAISE EXCEPTION 'Required field: %', k
                USING errcode = '22023';
        END IF;
    END LOOP;
END
$$;

CREATE FUNCTION taskmaster_private.check_strings (value jsonb, fields text[])
    RETURNS void
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = ''
    AS $$
DECLARE
    k text;
BEGIN
    foreach k IN ARRAY fields LOOP
        IF value ? k AND jsonb_typeof(value -> k)
            NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'Expected string: %', k
                USING errcode = '22023';
        END IF;
    END LOOP;
END
$$;

CREATE FUNCTION taskmaster_private.checked_date (value text)
    RETURNS date
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = ''
    AS $$
DECLARE
    d date;
BEGIN
    IF value IS NULL THEN
        RETURN NULL;
    END IF;
    IF value !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'Invalid date'
            USING errcode = '22023';
    END IF;
    d := value::date;
    IF d < date '1900-01-01' OR d > date '9999-12-31' THEN
        RAISE EXCEPTION 'Date outside 1900-9999'
            USING errcode = '22023';
    END IF;
    RETURN d;
END
$$;

CREATE FUNCTION taskmaster_private.next_occurrence (frequency text, anchor date, occurrence date, completion date)
    RETURNS date
    LANGUAGE plpgsql
    IMMUTABLE
    SET search_path = ''
    AS $$
DECLARE
    cutoff date := greatest (occurrence, completion);
    candidate date;
    first_day date;
    target integer;
BEGIN
    IF anchor IS NULL OR occurrence IS NULL OR completion IS NULL THEN
        RAISE EXCEPTION 'Schedule dates required'
            USING errcode = '22023';
    END IF;
    IF frequency = 'daily' THEN
        candidate := cutoff + 1;
    ELSIF frequency = 'weekly' THEN
        candidate := cutoff + ((extract(dow FROM anchor)::integer - extract(dow FROM cutoff)::integer + 6) % 7) + 1;
    ELSIF frequency = 'monthly' THEN
        target := extract(day FROM anchor)::integer;
        first_day := date_trunc('month', cutoff)::date;
        candidate := first_day + (least (target, extract(day FROM first_day + interval '1 month - 1 day')::integer) - 1);
        IF candidate <= cutoff THEN
            first_day := (first_day + interval '1 month')::date;
            candidate := first_day + (least (target, extract(day FROM first_day + interval '1 month - 1 day')::integer) - 1);
        END IF;
    ELSE
        RAISE EXCEPTION 'Unsupported frequency'
            USING errcode = '22023';
    END IF;
    RETURN taskmaster_private.checked_date (to_char(candidate, 'YYYY-MM-DD'));
END
$$;

CREATE FUNCTION taskmaster_private.occurrence_id (series uuid, due date, operation uuid)
    RETURNS uuid
    LANGUAGE sql
    IMMUTABLE STRICT
    SET search_path = ''
    AS $$
    SELECT
        extensions.uuid_generate_v5 ('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid, '["taskmaster","occurrence",1,"' || series::text || '","' || to_char(due, 'YYYY-MM-DD') || '","' || operation::text || '"]');
$$;

CREATE FUNCTION taskmaster_private.entity (kind text, entity_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SET search_path = ''
    AS $$
DECLARE
    r record;
    fields jsonb;
BEGIN
    CASE kind
    WHEN 'task' THEN
        SELECT
            * INTO r
        FROM
            public.tasks
        WHERE
            owner_id = auth.uid ()
            AND id = entity_id; IF NOT found THEN
                    RETURN NULL;
                END IF;
    fields := jsonb_build_object('title', r.title, 'description', r.description, 'completed', r.completed, 'completedAt', r.completed_at, 'currentCompletionId', r.current_completion_id, 'dueDate', r.due_date, 'priority', r.priority, 'categoryId', r.category_id, 'groupId', r.group_id, 'seriesId', r.series_id, 'occurrenceDate', r.occurrence_date);
    WHEN 'category' THEN
        SELECT
            * INTO r
        FROM
            public.categories
        WHERE
            owner_id = auth.uid ()
            AND id = entity_id;
    IF NOT found THEN
        RETURN NULL;
    END IF;
    fields := jsonb_build_object('name', r.name);
    WHEN 'group' THEN
        SELECT
            * INTO r
        FROM
            public.groups
        WHERE
            owner_id = auth.uid ()
            AND id = entity_id;
    IF NOT found THEN
        RETURN NULL;
    END IF;
    fields := jsonb_build_object('name', r.name, 'categoryId', r.category_id);
    WHEN 'series' THEN
        SELECT
            * INTO r
        FROM
            public.recurrence_series
        WHERE
            owner_id = auth.uid ()
            AND id = entity_id;
    IF NOT found THEN
        RETURN NULL;
    END IF;
    fields := jsonb_build_object('template', jsonb_build_object('title', r.title, 'description', r.description, 'priority', r.priority, 'categoryId', r.category_id, 'groupId', r.group_id), 'frequency', r.frequency, 'anchorDate', r.anchor_date, 'timeZone', r.time_zone, 'scheduleRevision', r.schedule_revision, 'activeTaskId', r.active_task_id, 'enabled', r.enabled);
ELSE
    RAISE EXCEPTION 'Unsupported entity kind'
        USING errcode = '22023';
    END CASE;
    RETURN fields || jsonb_build_object('id', r.id, 'ownerId', r.owner_id, 'revision', r.revision, 'createdAt', r.created_at, 'updatedAt', r.updated_at, 'deletedAt', r.deleted_at, 'lastOperationId', r.last_operation_id);
END
$$;

CREATE FUNCTION taskmaster_private.expect_revision (command jsonb, kind text, current_state jsonb, entity_id uuid DEFAULT NULL)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    expected bigint;
    entry jsonb;
BEGIN
    IF current_state IS NULL THEN
        RAISE EXCEPTION 'Entity unavailable'
            USING errcode = 'TM409', detail = jsonb_build_object('kind', kind, 'id', entity_id, 'state', NULL)::text;
    END IF;
    IF (command ->> 'protocolVersion')::integer = 1 AND kind = 'task' AND command ->> 'taskId' = current_state ->> 'id' THEN
        expected := (command ->> 'expectedRevision')::bigint;
    ELSE
        SELECT
            e INTO entry
        FROM
            jsonb_array_elements(command -> 'reads') e
WHERE
    e ->> 'kind' = kind
    AND e ->> 'id' = current_state ->> 'id'
LIMIT 1;
        expected := (entry ->> 'revision')::bigint;
    END IF;
    IF expected IS NULL OR expected <> (current_state ->> 'revision')::bigint THEN
        RAISE EXCEPTION 'Revision conflict or unresolved dependency'
            USING errcode = 'TM409', detail = jsonb_build_object('kind', kind, 'id', current_state ->> 'id', 'state', current_state)::text;
    END IF;
END
$$;

CREATE FUNCTION taskmaster_private.validate_reads (command jsonb)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    entry jsonb;
BEGIN
    IF command ->> 'protocolVersion' = '2' THEN
        FOR entry IN
        SELECT
            *
        FROM
            jsonb_array_elements(command -> 'reads')
            LOOP
                PERFORM
                    taskmaster_private.expect_revision (jsonb_build_object('protocolVersion', 2, 'reads', jsonb_build_array(entry)), entry ->> 'kind', taskmaster_private.entity (entry ->> 'kind', (entry ->> 'id')::uuid), (entry ->> 'id')::uuid);
            END LOOP;
    END IF;
END
$$;

CREATE FUNCTION taskmaster_private.check_parents (command jsonb, value jsonb)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    c jsonb;
    g jsonb;
BEGIN
    IF value ->> 'categoryId' IS NOT NULL THEN
        c := taskmaster_private.entity ('category', (value ->> 'categoryId')::uuid);
        PERFORM
            taskmaster_private.expect_revision (command, 'category', c, (value ->> 'categoryId')::uuid);
        IF c ->> 'deletedAt' IS NOT NULL THEN
            RAISE EXCEPTION 'Category deleted'
                USING errcode = 'TM409', detail = jsonb_build_object('kind', 'category', 'id', c ->> 'id', 'state', c)::text;
        END IF;
    END IF;
    IF value ->> 'groupId' IS NOT NULL THEN
        g := taskmaster_private.entity ('group', (value ->> 'groupId')::uuid);
        PERFORM
            taskmaster_private.expect_revision (command, 'group', g, (value ->> 'groupId')::uuid);
        IF g ->> 'deletedAt' IS NOT NULL THEN
            RAISE EXCEPTION 'Group deleted'
                USING errcode = 'TM409', detail = jsonb_build_object('kind', 'group', 'id', g ->> 'id', 'state', g)::text;
        END IF;
        IF g ->> 'categoryId' IS DISTINCT FROM value ->> 'categoryId' THEN
            RAISE EXCEPTION 'Invalid group/category relationship'
                USING errcode = '22023';
        END IF;
    END IF;
END
$$;

CREATE FUNCTION taskmaster_private.task_content (value jsonb)
    RETURNS jsonb
    LANGUAGE sql
    IMMUTABLE
    SET search_path = ''
    AS $$
    SELECT
        jsonb_build_object('title', value -> 'title', 'description', value -> 'description', 'dueDate', value -> 'dueDate', 'priority', value -> 'priority', 'categoryId', value -> 'categoryId', 'groupId', value -> 'groupId', 'seriesId', value -> 'seriesId', 'occurrenceDate', value -> 'occurrenceDate');
$$;

CREATE FUNCTION taskmaster_private.task_template (value jsonb)
    RETURNS jsonb
    LANGUAGE sql
    IMMUTABLE
    SET search_path = ''
    AS $$
    SELECT
        value - ARRAY['id', 'ownerId', 'revision', 'createdAt', 'updatedAt', 'deletedAt', 'lastOperationId', 'completed', 'completedAt', 'currentCompletionId', 'dueDate', 'seriesId', 'occurrenceDate'];
$$;

CREATE FUNCTION taskmaster_private.emit (kind text, entity_id uuid, operation uuid, state jsonb)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    next_sequence bigint;
BEGIN
    UPDATE
        taskmaster_private.sync_state
    SET
        SEQUENCE =
            SEQUENCE +1
            WHERE
                owner_id = auth.uid ()
            RETURNING
                SEQUENCE INTO
                    next_sequence;
    IF NOT found THEN
        RAISE EXCEPTION 'Owner sequencing lock absent';
    END IF;
    INSERT INTO taskmaster_private.sync_changes (owner_id, SEQUENCE,
        kind,
        id,
        operation_id,
        state)
VALUES (auth.uid (),
    next_sequence,
    kind,
    entity_id,
    operation,
    state);
END
$$;

CREATE FUNCTION taskmaster_private.store (kind text, value jsonb, operation uuid, stamp timestamptz)
    RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    old jsonb := taskmaster_private.entity (kind, (value ->> 'id')::uuid);
    rev bigint := coalesce((old ->> 'revision')::bigint, 0) + 1;
    created timestamptz := coalesce((old ->> 'createdAt')::timestamptz, stamp);
    OWNER uuid := auth.uid ();
    entity_id uuid := (value ->> 'id')::uuid;
BEGIN
    CASE kind
    WHEN 'task' THEN
        INSERT INTO public.tasks (owner_id, id, title, description, completed, completed_at, current_completion_id, due_date, priority, category_id, group_id, series_id, occurrence_date, revision, created_at, updated_at, deleted_at, last_operation_id)
            VALUES (owner, entity_id, value ->> 'title', value ->> 'description', (value ->> 'completed')::boolean, (value ->> 'completedAt')::timestamptz, (value ->> 'currentCompletionId')::uuid, taskmaster_private.checked_date (value ->> 'dueDate'), value ->> 'priority', (value ->> 'categoryId')::uuid, (value ->> 'groupId')::uuid, (value ->> 'seriesId')::uuid, taskmaster_private.checked_date (value ->> 'occurrenceDate'), rev, created, stamp, (value ->> 'deletedAt')::timestamptz, operation)
        ON CONFLICT (owner_id, id)
            DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                completed = excluded.completed,
                completed_at = excluded.completed_at,
                current_completion_id = excluded.current_completion_id,
                due_date = excluded.due_date,
                priority = excluded.priority,
                category_id = excluded.category_id,
                group_id = excluded.group_id,
                series_id = excluded.series_id,
                occurrence_date = excluded.occurrence_date,
                revision = excluded.revision,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at,
                last_operation_id = excluded.last_operation_id;
            WHEN 'category' THEN
                INSERT INTO public.categories (owner_id, id, name, revision, created_at, updated_at, deleted_at, last_operation_id)
                    VALUES (owner, entity_id, value ->> 'name', rev, created, stamp, (value ->> 'deletedAt')::timestamptz, operation)
                ON CONFLICT (owner_id, id)
                    DO UPDATE SET
                        name = excluded.name,
                        revision = excluded.revision,
                        updated_at = excluded.updated_at,
                        deleted_at = excluded.deleted_at,
                        last_operation_id = excluded.last_operation_id;
                    WHEN 'group' THEN
                        INSERT INTO public.groups (owner_id, id, category_id, name, revision, created_at, updated_at, deleted_at, last_operation_id)
                            VALUES (owner, entity_id, (value ->> 'categoryId')::uuid, value ->> 'name', rev, created, stamp, (value ->> 'deletedAt')::timestamptz, operation)
                        ON CONFLICT (owner_id, id)
                            DO UPDATE SET
                                category_id = excluded.category_id,
                                name = excluded.name,
                                revision = excluded.revision,
                                updated_at = excluded.updated_at,
                                deleted_at = excluded.deleted_at,
                                last_operation_id = excluded.last_operation_id;
                            WHEN 'series' THEN
                                INSERT INTO public.recurrence_series (owner_id, id, title, description, priority, category_id, group_id, frequency, anchor_date, time_zone, schedule_revision, active_task_id, enabled, revision, created_at, updated_at, deleted_at, last_operation_id)
                                    VALUES (owner, entity_id, value -> 'template' ->> 'title', value -> 'template' ->> 'description', value -> 'template' ->> 'priority', (value -> 'template' ->> 'categoryId')::uuid, (value -> 'template' ->> 'groupId')::uuid, value ->> 'frequency', taskmaster_private.checked_date (value ->> 'anchorDate'), value ->> 'timeZone', (value ->> 'scheduleRevision')::bigint, (value ->> 'activeTaskId')::uuid, (value ->> 'enabled')::boolean, rev, created, stamp, (value ->> 'deletedAt')::timestamptz, operation)
                                ON CONFLICT (owner_id, id)
                                    DO UPDATE SET
                                        title = excluded.title,
                                        description = excluded.description,
                                        priority = excluded.priority,
                                        category_id = excluded.category_id,
                                        group_id = excluded.group_id,
                                        frequency = excluded.frequency,
                                        anchor_date = excluded.anchor_date,
                                        time_zone = excluded.time_zone,
                                        schedule_revision = excluded.schedule_revision,
                                        active_task_id = excluded.active_task_id,
                                        enabled = excluded.enabled,
                                        revision = excluded.revision,
                                        updated_at = excluded.updated_at,
                                        deleted_at = excluded.deleted_at,
                                        last_operation_id = excluded.last_operation_id;
    ELSE
        RAISE EXCEPTION 'Unsupported entity'
                                        USING errcode = '22023';
                                    END CASE;
                    value := taskmaster_private.entity (kind, entity_id);
                    PERFORM
                        taskmaster_private.emit (kind, entity_id, operation, value);
                    RETURN value;
END
$$;

REVOKE ALL ON ALL functions IN SCHEMA taskmaster_private FROM public, anon, authenticated, service_role;

GRANT EXECUTE ON ALL functions IN SCHEMA taskmaster_private TO taskmaster_executor;

