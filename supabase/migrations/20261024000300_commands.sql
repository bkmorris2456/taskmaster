CREATE FUNCTION taskmaster_private.mutate (command jsonb, operation uuid, stamp timestamptz)
    RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path = ''
    AS $$
DECLARE
    payload jsonb := command -> 'payload';
    input jsonb;
    action text := payload ->> 'kind';
    entity_kind text;
    entity_id uuid;
    task_id uuid;
    series_id uuid;
    event_id uuid;
    successor_id uuid;
    old jsonb;
    value jsonb;
    task jsonb;
    series jsonb;
    successor jsonb;
    event jsonb;
    recurrence jsonb;
    config jsonb;
    row_data record;
    instant timestamptz;
    zone text;
    completion_day date;
    next_day date;
    anchor date;
    new_config boolean;
BEGIN
    IF action <> 'complete' THEN
        PERFORM
            taskmaster_private.validate_reads (command);
    END IF;
    IF action = 'organization' THEN
        PERFORM
            taskmaster_private.check_object (payload, ARRAY['kind', 'entityKind', 'action', 'entityId', 'name', 'categoryId'], ARRAY['entityKind', 'action', 'entityId']);
        PERFORM
            taskmaster_private.check_strings (payload, ARRAY['entityKind', 'action', 'entityId', 'name', 'categoryId']);
        entity_kind := payload ->> 'entityKind';
        action := payload ->> 'action';
        entity_id := (payload ->> 'entityId')::uuid;
        IF entity_kind NOT IN ('category', 'group') OR action NOT IN ('create', 'rename', 'delete') THEN
            RAISE EXCEPTION 'Unsupported organization operation'
                USING errcode = '22023';
        END IF;
        old := taskmaster_private.entity (entity_kind, entity_id);
        IF action = 'create' THEN
            IF old IS NOT NULL THEN
                RAISE EXCEPTION 'Identity already exists'
                    USING errcode = '22023';
            END IF;
            value := jsonb_build_object('id', entity_id, 'name', taskmaster_private.trim_text (payload ->> 'name'), 'categoryId', payload -> 'categoryId', 'deletedAt', NULL);
            IF entity_kind = 'group' THEN
                PERFORM
                    taskmaster_private.check_parents (command, value);
            END IF;
        ELSE
            PERFORM
                taskmaster_private.expect_revision (command, entity_kind, old, entity_id);
            IF old ->> 'deletedAt' IS NOT NULL THEN
                RAISE EXCEPTION 'Container deleted'
                    USING errcode = 'TM409', detail = jsonb_build_object('kind', entity_kind, 'id', old ->> 'id', 'state', old)::text;
            END IF;
            value := old;
            IF action = 'rename' THEN
                value := value || jsonb_build_object('name', taskmaster_private.trim_text (payload ->> 'name'));
            ELSE
                -- Cascade is discovered on the server, never accepted from optimistic changes.
                -- Bound work before iterating any dependent collections. The final
                -- record/byte guards remain authoritative for the complete result.
                IF (SELECT count(*) FROM (
                    SELECT 1 FROM public.groups g
                    WHERE entity_kind = 'category' AND g.owner_id = auth.uid()
                        AND g.category_id = entity_id AND g.deleted_at IS NULL
                    LIMIT 2000) bounded_groups)
                  + (SELECT count(*) FROM (
                    SELECT 1 FROM public.tasks t
                    WHERE t.owner_id = auth.uid() AND
                        CASE WHEN entity_kind = 'category' THEN t.category_id = entity_id ELSE t.group_id = entity_id END
                    LIMIT 2000) bounded_tasks)
                  + (SELECT count(*) FROM (
                    SELECT 1 FROM public.recurrence_series s
                    WHERE s.owner_id = auth.uid() AND
                        CASE WHEN entity_kind = 'category' THEN s.category_id = entity_id ELSE s.group_id = entity_id END
                    LIMIT 2000) bounded_series) > 1999 THEN
                    RAISE EXCEPTION 'Organizational cascade exceeds 2000 record limit'
                        USING errcode = '22023';
                END IF;
                IF (
                    SELECT
                        count(*)
                    FROM
                        public.tasks t
                    WHERE
                        t.owner_id = auth.uid () AND (
                        CASE WHEN entity_kind = 'category' THEN
                            t.category_id = entity_id
                        ELSE
                            t.group_id = entity_id
                        END)) > 1900 THEN
            RAISE EXCEPTION 'Organizational cascade exceeds 1900 task limit'
                        USING errcode = '22023';
                END IF;
                IF entity_kind = 'category' THEN
                    FOR row_data IN
                    SELECT
                        g.id
                    FROM
                        public.groups g
                    WHERE
                        g.owner_id = auth.uid ()
                        AND g.category_id = entity_id
                        AND g.deleted_at IS NULL
                    ORDER BY
                        g.id LOOP
                            input := taskmaster_private.entity ('group', row_data.id);
                            PERFORM
                                taskmaster_private.expect_revision (command, 'group', input);
                            PERFORM
                                taskmaster_private.store ('group', input || jsonb_build_object('deletedAt', stamp), operation, stamp);
                        END LOOP;
                END IF;
                FOR row_data IN
                SELECT
                    t.id
                FROM
                    public.tasks t
                WHERE
                    t.owner_id = auth.uid ()
                    AND (
                        CASE WHEN entity_kind = 'category' THEN
                            t.category_id = entity_id
                        ELSE
                            t.group_id = entity_id
                        END)
                ORDER BY
                    t.id LOOP
                        input := taskmaster_private.entity ('task', row_data.id);
                        PERFORM
                            taskmaster_private.expect_revision (command, 'task', input);
                        PERFORM
                            taskmaster_private.store ('task', input || jsonb_build_object('categoryId', CASE WHEN entity_kind = 'category' THEN
                                        NULL
                                    ELSE
                                        input ->> 'categoryId'
                                    END, 'groupId', NULL), operation, stamp);
                    END LOOP;
                FOR row_data IN
                SELECT
                    s.id
                FROM
                    public.recurrence_series s
                WHERE
                    s.owner_id = auth.uid ()
                    AND (
                        CASE WHEN entity_kind = 'category' THEN
                            s.category_id = entity_id
                        ELSE
                            s.group_id = entity_id
                        END)
                ORDER BY
                    s.id LOOP
                        input := taskmaster_private.entity ('series', row_data.id);
                        PERFORM
                            taskmaster_private.expect_revision (command, 'series', input);
                        input := jsonb_set(input, '{template}', input -> 'template' || jsonb_build_object('categoryId', CASE WHEN entity_kind = 'category' THEN
                                    NULL
                                ELSE
                                    input -> 'template' ->> 'categoryId'
                                END, 'groupId', NULL));
                        PERFORM
                            taskmaster_private.store ('series', input, operation, stamp);
                    END LOOP;
                value := value || jsonb_build_object('deletedAt', stamp);
            END IF;
        END IF;
        PERFORM
            taskmaster_private.store (entity_kind, value, operation, stamp);
        RETURN jsonb_build_object('status', 'applied');
    END IF;
    IF action NOT IN ('create', 'edit', 'complete', 'reopen', 'reopen-standalone', 'delete', 'restore') THEN
        RAISE EXCEPTION 'Unsupported command kind'
            USING errcode = '22023';
    END IF;
    task_id := CASE WHEN action = 'create' THEN
        (command -> 'result' ->> 'id')::uuid
    ELSE
        (command ->> 'taskId')::uuid
    END;
    IF task_id IS NULL THEN
        RAISE EXCEPTION 'Task ID required'
            USING errcode = '22023';
    END IF;
    IF action = 'create' AND (command ->> 'taskId')::uuid IS DISTINCT FROM task_id THEN
        RAISE EXCEPTION 'Inconsistent task identity'
            USING errcode = '22023';
    END IF;
    IF action IN ('complete', 'reopen', 'reopen-standalone') THEN
        PERFORM
            taskmaster_private.check_object (payload, ARRAY['kind', 'event'], ARRAY['event']);
        event := payload -> 'event';
        PERFORM
            taskmaster_private.check_object (event, ARRAY['id', 'ownerId', 'taskId', 'operationId', 'occurredAt', 'timeZone', 'kind', 'snapshot', 'recurrence', 'reversesEventId'], ARRAY['id', 'taskId', 'operationId', 'occurredAt', 'timeZone', 'kind']);
        PERFORM
            taskmaster_private.check_strings (event, ARRAY['id', 'ownerId', 'taskId', 'operationId', 'occurredAt', 'timeZone', 'kind', 'reversesEventId']);
        IF (event ->> 'taskId')::uuid <> task_id OR (event ->> 'operationId')::uuid <> operation OR (event ? 'ownerId' AND (event ->> 'ownerId')::uuid <> auth.uid ()) THEN
            RAISE EXCEPTION 'Invalid event identity'
                USING errcode = '22023';
        END IF;
        event_id := (event ->> 'id')::uuid;
        instant := (event ->> 'occurredAt')::timestamptz;
        zone := event ->> 'timeZone';
        IF event ->> 'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' OR instant IS NULL OR NOT isfinite(instant) OR NOT EXISTS (
            SELECT
                1
            FROM
                pg_catalog.pg_timezone_names
            WHERE
                name = zone) THEN
            RAISE EXCEPTION 'Invalid event date/zone'
                USING errcode = '22023';
        END IF;
    END IF;
    old := taskmaster_private.entity ('task', task_id);
    IF action = 'create' THEN
        IF old IS NOT NULL THEN
            RAISE EXCEPTION 'Identity already exists'
                USING errcode = '22023';
        END IF;
        task := jsonb_build_object('id', task_id, 'description', NULL, 'priority', NULL, 'categoryId', NULL, 'groupId', NULL, 'dueDate', NULL, 'seriesId', NULL, 'occurrenceDate', NULL, 'completed', FALSE, 'completedAt', NULL, 'currentCompletionId', NULL, 'deletedAt', NULL);
    ELSE
        -- Competing offline completion is a visible conflict, never a second advancement.
        IF action = 'complete' AND old ->> 'seriesId' IS NOT NULL AND (old ->> 'completed')::boolean THEN
            SELECT
                jsonb_build_object('kind', e.kind, 'ownerId', e.owner_id, 'id', e.id, 'taskId', e.task_id, 'operationId', e.operation_id, 'occurredAt', e.occurred_at, 'timeZone', e.time_zone, 'snapshot', e.snapshot, 'recurrence', e.recurrence) INTO event
            FROM
                public.completion_events e
            WHERE
                e.owner_id = auth.uid ()
                AND e.id = (old ->> 'currentCompletionId')::uuid;
            series := taskmaster_private.entity ('series', (old ->> 'seriesId')::uuid);
            successor := taskmaster_private.entity ('task', (event -> 'recurrence' ->> 'successorId')::uuid);
            IF old ->> 'deletedAt' IS NULL AND old ->> 'lastOperationId' = event ->> 'operationId' AND series ->> 'lastOperationId' = event ->> 'operationId' AND successor ->> 'lastOperationId' = event ->> 'operationId' AND series ->> 'activeTaskId' = successor ->> 'id' AND (series ->> 'enabled')::boolean AND NOT (successor ->> 'completed')::boolean AND successor ->> 'deletedAt' IS NULL THEN
                RETURN jsonb_build_object('status', 'conflict', 'code', 'already_completed', 'authoritative', jsonb_build_array(jsonb_build_object('kind', 'task', 'id', old ->> 'id', 'state', old), jsonb_build_object('kind', 'task', 'id', successor ->> 'id', 'state', successor), jsonb_build_object('kind', 'series', 'id', series ->> 'id', 'state', series)), 'canonicalEvent', event, 'submittedOccurredAt', payload -> 'event' ->> 'occurredAt', 'timestampDisagrees', (payload -> 'event' ->> 'occurredAt')::timestamptz IS DISTINCT FROM (event ->> 'occurredAt')::timestamptz);
            END IF;
        END IF;
        IF action = 'complete' THEN
            PERFORM
                taskmaster_private.validate_reads (command);
        END IF;
        PERFORM
            taskmaster_private.expect_revision (command, 'task', old, task_id);
        IF old ->> 'deletedAt' IS NOT NULL AND action <> 'restore' THEN
            RAISE EXCEPTION 'Task deleted'
                USING errcode = 'TM409', detail = jsonb_build_object('kind', 'task', 'id', old ->> 'id', 'state', old)::text;
        END IF;
        task := old;
    END IF;
    IF task ->> 'seriesId' IS NOT NULL THEN
        series := taskmaster_private.entity ('series', (task ->> 'seriesId')::uuid);
        PERFORM
            taskmaster_private.expect_revision (command, 'series', series, (task ->> 'seriesId')::uuid);
    ELSE
        series := NULL;
    END IF;
    IF action IN ('create', 'edit') THEN
        PERFORM
            taskmaster_private.check_object (payload, ARRAY['kind', 'input'], ARRAY['input']);
        input := payload -> 'input';
        PERFORM
            taskmaster_private.check_object (input, ARRAY['title', 'description', 'priority', 'dueDate', 'categoryId', 'groupId', 'recurrence'], ARRAY['title']);
        PERFORM
            taskmaster_private.check_strings (input, ARRAY['title', 'description', 'priority', 'dueDate', 'categoryId', 'groupId']);
        task := task || jsonb_build_object('title', taskmaster_private.trim_text (input ->> 'title'), 'description', nullif (input ->> 'description', ''));
        IF input ? 'priority' THEN
            task := task || jsonb_build_object('priority', input -> 'priority');
        END IF;
        IF input ? 'dueDate' THEN
            task := task || jsonb_build_object('dueDate', taskmaster_private.checked_date (input ->> 'dueDate'));
        END IF;
        IF input ? 'categoryId' THEN
            task := task || jsonb_build_object('categoryId', input -> 'categoryId');
            IF input ->> 'categoryId' IS DISTINCT FROM old ->> 'categoryId' THEN
                task := task || jsonb_build_object('groupId', NULL);
            END IF;
        END IF;
        IF input ? 'groupId' THEN
            task := task || jsonb_build_object('groupId', input -> 'groupId');
            IF input ->> 'groupId' IS NOT NULL THEN
                value := taskmaster_private.entity ('group', (input ->> 'groupId')::uuid);
                PERFORM
                    taskmaster_private.expect_revision (command, 'group', value, (input ->> 'groupId')::uuid);
                IF input ? 'categoryId' AND input ->> 'categoryId' IS DISTINCT FROM value ->> 'categoryId' THEN
                    RAISE EXCEPTION 'Group/category mismatch'
                        USING errcode = '22023';
                END IF;
                task := task || jsonb_build_object('categoryId', value -> 'categoryId');
            END IF;
        END IF;
        PERFORM
            taskmaster_private.check_parents (command, task);
        IF input ? 'recurrence' THEN
            IF (task ->> 'completed')::boolean THEN
                RAISE EXCEPTION 'Historical recurrence configuration forbidden'
                    USING errcode = '22023';
            END IF;
            IF series IS NOT NULL AND (NOT (series ->> 'enabled')::boolean OR series ->> 'deletedAt' IS NOT NULL OR series ->> 'activeTaskId' <> task ->> 'id') THEN
                RAISE EXCEPTION 'Not active occurrence'
                    USING errcode = 'TM409', detail = jsonb_build_object('kind', 'series', 'id', series ->> 'id', 'state', series)::text;
            END IF;
            config := input -> 'recurrence';
            IF config = 'null'::jsonb THEN
                IF series IS NOT NULL THEN
                    PERFORM
                        taskmaster_private.store ('series', series || jsonb_build_object('enabled', FALSE, 'activeTaskId', NULL), operation, stamp);
                END IF;
                task := task || jsonb_build_object('seriesId', NULL, 'occurrenceDate', NULL);
            ELSE
                PERFORM
                    taskmaster_private.check_object (config, ARRAY['frequency', 'anchorDate', 'timeZone'], ARRAY['frequency', 'anchorDate', 'timeZone']);
                PERFORM
                    taskmaster_private.check_strings (config, ARRAY['frequency', 'anchorDate', 'timeZone']);
                IF config ->> 'frequency' NOT IN ('daily', 'weekly', 'monthly') OR NOT EXISTS (
                    SELECT
                        1
                    FROM
                        pg_catalog.pg_timezone_names
                    WHERE
                        name = config ->> 'timeZone') THEN
                    RAISE EXCEPTION 'Invalid recurrence frequency/zone'
                        USING errcode = '22023';
                END IF;
                anchor := taskmaster_private.checked_date (config ->> 'anchorDate');
                new_config := series IS NULL;
                IF new_config THEN
                    series_id := (command -> 'result' ->> 'seriesId')::uuid;
                    IF series_id IS NULL OR taskmaster_private.entity ('series', series_id) IS NOT NULL THEN
                        RAISE EXCEPTION 'New series identity required'
                            USING errcode = '22023';
                    END IF;
                    series := jsonb_build_object('id', series_id, 'scheduleRevision', 1, 'enabled', TRUE, 'deletedAt', NULL);
                ELSE
                    -- Replacement, not mutation of the immutable occurrence date.
                    value := old || jsonb_build_object('deletedAt', stamp);
                    PERFORM
                        taskmaster_private.store ('task', value, operation, stamp);
                    task_id := taskmaster_private.occurrence_id ((series ->> 'id')::uuid, anchor, operation);
                    IF taskmaster_private.entity ('task', task_id) IS NOT NULL THEN
                        RAISE EXCEPTION 'Replacement identity exists'
                            USING errcode = '22023';
                    END IF;
                    task := task || jsonb_build_object('id', task_id);
                    series := series || jsonb_build_object('scheduleRevision', (series ->> 'scheduleRevision')::bigint + 1);
                END IF;
                task := task || jsonb_build_object('seriesId', series -> 'id', 'occurrenceDate', anchor, 'dueDate', anchor);
                series := series || config || jsonb_build_object('template', taskmaster_private.task_template (task), 'activeTaskId', task_id);
                PERFORM
                    taskmaster_private.store ('series', series, operation, stamp);
            END IF;
        ELSIF series IS NOT NULL
                AND NOT (task ->> 'completed')::boolean THEN
                IF NOT (series ->> 'enabled')::boolean OR series ->> 'activeTaskId' <> task ->> 'id' THEN
                    RAISE EXCEPTION 'Not active occurrence'
                        USING errcode = 'TM409', detail = jsonb_build_object('kind', 'series', 'id', series ->> 'id', 'state', series)::text;
                END IF;
            PERFORM
                taskmaster_private.store ('series', series || jsonb_build_object('template', taskmaster_private.task_template (task)), operation, stamp);
        END IF;
    ELSIF action IN ('delete', 'restore') THEN
        PERFORM
            taskmaster_private.check_object (payload, ARRAY['kind']);
        IF action = 'delete' THEN
            task := task || jsonb_build_object('deletedAt', stamp);
            IF series IS NOT NULL AND (series ->> 'enabled')::boolean AND series ->> 'activeTaskId' = task ->> 'id' THEN
                PERFORM
                    taskmaster_private.store ('series', series || jsonb_build_object('enabled', FALSE, 'activeTaskId', NULL, 'deletedAt', stamp), operation, stamp);
            END IF;
        ELSE
            IF task ->> 'deletedAt' IS NULL THEN
                RAISE EXCEPTION 'Task is not deleted'
                    USING errcode = '22023';
            END IF;
            task := task || jsonb_build_object('deletedAt', NULL);
            IF series IS NOT NULL AND NOT (task ->> 'completed')::boolean THEN
                task := task || jsonb_build_object('seriesId', NULL, 'occurrenceDate', NULL);
            END IF;
            PERFORM
                taskmaster_private.check_parents (command, task);
        END IF;
    ELSE
        IF action = 'complete' THEN
            IF (task ->> 'completed')::boolean OR event ->> 'kind' <> 'completion' THEN
                RAISE EXCEPTION 'Task already completed or wrong event kind'
                    USING errcode = '22023';
            END IF;
            recurrence := NULL;
            IF series IS NOT NULL THEN
                IF NOT (series ->> 'enabled')::boolean OR series ->> 'activeTaskId' <> task ->> 'id' OR series ->> 'timeZone' <> zone THEN
                    RAISE EXCEPTION 'Not the active recurring occurrence or wrong zone'
                        USING errcode = 'TM409', detail = jsonb_build_object('kind', 'series', 'id', series ->> 'id', 'state', series)::text;
                END IF;
                completion_day := taskmaster_private.checked_date (to_char(instant at time zone zone, 'YYYY-MM-DD'));
                next_day := taskmaster_private.next_occurrence (series ->> 'frequency', (series ->> 'anchorDate')::date, (task ->> 'occurrenceDate')::date, completion_day);
                successor_id := taskmaster_private.occurrence_id ((series ->> 'id')::uuid, next_day, operation);
                recurrence := jsonb_build_object('seriesId', series -> 'id', 'occurrenceDate', task -> 'occurrenceDate', 'successorId', successor_id, 'successorDate', next_day, 'frequency', series -> 'frequency', 'anchorDate', series -> 'anchorDate', 'timeZone', zone, 'completionDate', completion_day, 'scheduleRevision', series -> 'scheduleRevision');
                IF event -> 'recurrence' IS DISTINCT FROM recurrence THEN
                    RAISE EXCEPTION 'Recurrence calculation does not match frozen command'
                        USING errcode = '22023';
                END IF;
                successor := task || (series -> 'template') || jsonb_build_object('id', successor_id, 'dueDate', next_day, 'occurrenceDate', next_day, 'completed', FALSE, 'completedAt', NULL, 'currentCompletionId', NULL, 'deletedAt', NULL);
                PERFORM
                    taskmaster_private.check_parents (command, successor);
            ELSIF event ? 'recurrence' THEN
                RAISE EXCEPTION 'Standalone task cannot advance a series'
                    USING errcode = '22023';
            END IF;
            INSERT INTO public.completion_events (owner_id, id, task_id, operation_id, kind, occurred_at, time_zone, snapshot, recurrence)
                VALUES (auth.uid (), event_id, task_id, operation, 'completion', instant, zone, taskmaster_private.task_content (task), recurrence);
            value := jsonb_build_object('id', event_id, 'ownerId', auth.uid (), 'taskId', task_id, 'operationId', operation, 'kind', 'completion', 'occurredAt', instant, 'timeZone', zone, 'snapshot', taskmaster_private.task_content (task), 'recurrence', recurrence);
            PERFORM
                taskmaster_private.emit ('event', event_id, operation, value);
            task := task || jsonb_build_object('completed', TRUE, 'completedAt', instant, 'currentCompletionId', event_id);
            -- Release the unique active slot before inserting its successor.
            PERFORM
                taskmaster_private.store ('task', task, operation, stamp);
            IF series IS NOT NULL THEN
                IF taskmaster_private.entity ('task', successor_id) IS NOT NULL THEN
                    RAISE EXCEPTION 'Successor identity exists'
                        USING errcode = '22023';
                END IF;
                PERFORM
                    taskmaster_private.store ('task', successor, operation, stamp);
                PERFORM
                    taskmaster_private.store ('series', series || jsonb_build_object('activeTaskId', successor_id), operation, stamp);
            END IF;
            RETURN jsonb_build_object('status', 'applied');
        ELSE
            IF NOT (task ->> 'completed')::boolean OR event ->> 'kind' <> 'reversal' OR event ->> 'reversesEventId' IS DISTINCT FROM task ->> 'currentCompletionId' THEN
                RAISE EXCEPTION 'Invalid completion reversal'
                    USING errcode = '22023';
            END IF;
            SELECT
                e.recurrence INTO recurrence
            FROM
                public.completion_events e
            WHERE
                e.owner_id = auth.uid ()
                AND e.id = (task ->> 'currentCompletionId')::uuid;
            IF series IS NOT NULL AND action = 'reopen' THEN
                successor := taskmaster_private.entity ('task', (recurrence ->> 'successorId')::uuid);
                PERFORM
                    taskmaster_private.expect_revision (command, 'task', successor, (recurrence ->> 'successorId')::uuid);
                IF EXISTS (
                    SELECT
                        1
                    FROM
                        taskmaster_private.sync_receipts r
                    WHERE
                        r.owner_id = auth.uid ()
                        AND r.response ->> 'status' = 'applied'
                        AND r.dependencies @> ARRAY[(old ->> 'lastOperationId')::uuid])
                    OR successor IS NULL
                    OR NOT (series ->> 'enabled')::boolean
                    OR series ->> 'activeTaskId' <> successor ->> 'id'
                    OR (successor ->> 'completed')::boolean
                    OR successor ->> 'deletedAt' IS NOT NULL
                    OR (successor ->> 'revision')::bigint <> 1
                    OR successor ->> 'lastOperationId' <> old ->> 'lastOperationId'
                    OR series ->> 'lastOperationId' <> old ->> 'lastOperationId' THEN
                    RAISE EXCEPTION 'Recurring successor changed; review standalone reopen'
                    USING errcode = 'TM409', detail = jsonb_build_object('kind', 'series', 'id', series ->> 'id', 'state', series)::text;
            END IF;
            PERFORM
                taskmaster_private.store ('task', successor || jsonb_build_object('deletedAt', stamp), operation, stamp);
            PERFORM
                taskmaster_private.store ('series', series || jsonb_build_object('activeTaskId', task_id), operation, stamp);
        ELSIF action = 'reopen-standalone' THEN
            IF series IS NULL THEN
                RAISE EXCEPTION 'Already standalone'
                    USING errcode = '22023';
            END IF;
            task := task || jsonb_build_object('seriesId', NULL, 'occurrenceDate', NULL);
        END IF;
        INSERT INTO public.completion_events (owner_id, id, task_id, operation_id, kind, occurred_at, time_zone, reverses_event_id)
            VALUES (auth.uid (), event_id, task_id, operation, 'reversal', instant, zone, (old ->> 'currentCompletionId')::uuid);
        PERFORM
            taskmaster_private.emit ('event', event_id, operation, jsonb_build_object('id', event_id, 'ownerId', auth.uid (), 'taskId', task_id, 'operationId', operation, 'kind', 'reversal', 'occurredAt', instant, 'timeZone', zone, 'reversesEventId', old -> 'currentCompletionId'));
        task := task || jsonb_build_object('completed', FALSE, 'completedAt', NULL, 'currentCompletionId', NULL);
        PERFORM
            taskmaster_private.check_parents (command, task);
    END IF;
END IF;
    PERFORM
        taskmaster_private.store ('task', task, operation, stamp);
    RETURN jsonb_build_object('status', 'applied');
END
$$;

CREATE FUNCTION public.apply_command (command jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    SET lock_timeout = '5s'
    AS $$
DECLARE
    OWNER uuid := taskmaster_private.require_auth ();
    operation uuid;
    fingerprint text;
    receipt record;
    result jsonb;
    before_sequence bigint;
    after_sequence bigint;
    entry jsonb;
    state_detail text;
    error_state text;
    stamp timestamptz;
    resolved_dependencies uuid[] := '{}';
BEGIN
    IF command IS NULL OR jsonb_typeof(command) <> 'object' OR octet_length(command::text) > 262144 THEN
        RAISE EXCEPTION 'Command must be an object <=256 KiB; batches are not accepted'
            USING errcode = '22023';
    END IF;
    operation := (command ->> 'id')::uuid;
    IF operation IS NULL THEN
        RAISE EXCEPTION 'Operation ID required'
            USING errcode = '22023';
    END IF;
    IF command ? 'ownerId' AND (command ->> 'ownerId')::uuid IS DISTINCT FROM OWNER THEN
        RAISE EXCEPTION 'Owner mismatch'
            USING errcode = '42501';
    END IF;
    fingerprint := encode(sha256 (convert_to(command::text, 'UTF8')), 'hex');
    INSERT INTO taskmaster_private.sync_state (owner_id)
        VALUES (owner)
    ON CONFLICT
        DO NOTHING;
    SELECT
        SEQUENCE INTO
            before_sequence
        FROM
            taskmaster_private.sync_state
        WHERE
            owner_id = OWNER
        FOR UPDATE;
    SELECT
        * INTO receipt
    FROM
        taskmaster_private.sync_receipts
    WHERE
        owner_id = OWNER
        AND operation_id = operation;
    IF found THEN
        IF receipt.fingerprint <> fingerprint THEN
            RETURN jsonb_build_object('status', 'validation', 'code', 'operation_id_reused');
        END IF;
        RETURN receipt.response;
    END IF;
    stamp := clock_timestamp();
    BEGIN
        PERFORM
            taskmaster_private.check_object (command, ARRAY['id', 'protocolVersion', 'ownerId', 'deviceId', 'taskId', 'createdAt', 'sequence', 'dependsOn', 'expectedRevision', 'base', 'result', 'payload', 'status', 'dependencies', 'reads', 'changes'], ARRAY['protocolVersion', 'payload', 'result']);
        IF jsonb_typeof(command -> 'protocolVersion') <> 'number' OR command ->> 'protocolVersion' NOT IN ('1', '2') THEN
            RAISE EXCEPTION 'Unsupported protocol version'
                USING errcode = '22023';
        END IF;
        PERFORM
            taskmaster_private.check_object (command -> 'payload', ARRAY['kind', 'input', 'event', 'entityKind', 'action', 'entityId', 'name', 'categoryId'], ARRAY['kind']);
        IF command ->> 'protocolVersion' = '1' THEN
            IF command -> 'payload' ->> 'kind' = 'organization' OR command -> 'payload' -> 'input' ? 'recurrence' THEN
                RAISE EXCEPTION 'v1 supports legacy standalone task commands only'
                    USING errcode = '22023';
            END IF;
        ELSE
            IF jsonb_typeof(command -> 'reads') IS DISTINCT FROM 'array' OR jsonb_typeof(command -> 'changes') IS DISTINCT FROM 'array' OR jsonb_typeof(command -> 'dependencies') IS DISTINCT FROM 'array' OR jsonb_array_length(command -> 'reads') > 2000 OR jsonb_array_length(command -> 'changes') > 2000 OR jsonb_array_length(command -> 'dependencies') > 2000 THEN
                RAISE EXCEPTION 'Invalid bounded v2 read/change/dependency arrays'
                    USING errcode = '22023';
            END IF;
            FOR entry IN
            SELECT
                *
            FROM
                jsonb_array_elements(command -> 'reads')
                LOOP
                    PERFORM
                        taskmaster_private.check_object (entry, ARRAY['kind', 'id', 'revision', 'localRevision', 'lastOperationId'], ARRAY['kind', 'id']);
                    IF entry ->> 'kind' NOT IN ('task', 'category', 'group', 'series') THEN
                        RAISE EXCEPTION 'Unsupported read kind'
                            USING errcode = '22023';
                    END IF;
                END LOOP;
            -- Unsent dependency bases must be frozen by the future adapter before transmission.
            FOR entry IN
            SELECT
                *
            FROM
                jsonb_array_elements(command -> 'dependencies')
                LOOP
                    IF jsonb_typeof(entry) <> 'string' OR NOT EXISTS (
    SELECT
        1
    FROM
        taskmaster_private.sync_receipts r
    WHERE
        r.owner_id = OWNER AND r.operation_id = (entry #>> '{}')::uuid AND r.response ->> 'status' = 'applied') THEN
                        RAISE EXCEPTION 'Dependency not acknowledged' USING errcode = 'TM409', detail = jsonb_build_object('kind', 'dependency', 'id', entry #>> '{}', 'state', NULL)::text;
        END IF;
    END LOOP;
END IF;
        IF command ->> 'protocolVersion' = '2' THEN
            SELECT
                coalesce(array_agg(DISTINCT dep), '{}'::uuid[]) INTO resolved_dependencies
            FROM (
                SELECT
                    (taskmaster_private.entity (e ->> 'kind', (e ->> 'id')::uuid) ->> 'lastOperationId')::uuid dep
                FROM
                    jsonb_array_elements(command -> 'reads') e
                UNION
                SELECT
                    (e #>> '{}')::uuid
                FROM
                    jsonb_array_elements(command -> 'dependencies') e) source
        WHERE
            dep IS NOT NULL;
        ELSIF command ->> 'taskId' IS NOT NULL THEN
            resolved_dependencies := array_remove(ARRAY[(taskmaster_private.entity ('task', (command ->> 'taskId')::uuid) ->> 'lastOperationId')::uuid], NULL);
        END IF;
        result := taskmaster_private.mutate (command, operation, stamp);
        SET constraints ALL immediate;
        SET constraints ALL DEFERRED;
        SELECT
            SEQUENCE INTO
                after_sequence
            FROM
                taskmaster_private.sync_state
            WHERE
                owner_id = OWNER;
        IF after_sequence - before_sequence > 2000 THEN
            RAISE EXCEPTION 'Command exceeds 2000 affected records'
                USING errcode = '22023';
        END IF;
        IF (
            SELECT
                coalesce(sum(octet_length(c.state::text) + 512), 0)
            FROM
                taskmaster_private.sync_changes c
            WHERE
                c.owner_id = OWNER AND c.sequence > before_sequence) > 2097152 THEN
            RAISE EXCEPTION 'Command exceeds 2 MiB result budget'
                USING errcode = '22023';
        END IF;
        result := result || jsonb_build_object('operationId', operation, 'watermark', after_sequence, 'changes', coalesce((
                SELECT
                    jsonb_agg(jsonb_build_object('sequence', c.sequence, 'kind', c.kind, 'id', c.id, 'state', c.state)
                ORDER BY c.sequence)
                FROM taskmaster_private.sync_changes c
                WHERE
                    c.owner_id = OWNER
                    AND c.sequence > before_sequence), '[]'::jsonb));
    EXCEPTION
        WHEN sqlstate 'TM409' THEN
            get stacked diagnostics state_detail = pg_exception_detail;
            result := jsonb_build_object('status', 'conflict', 'code', 'revision_conflict', 'operationId', operation, 'authoritative', CASE WHEN state_detail IS NULL
                    OR state_detail = '' THEN
                    '[]'::jsonb
                ELSE
                    jsonb_build_array(state_detail::jsonb)
                END);
        WHEN data_exception
            OR check_violation
            OR unique_violation
            OR foreign_key_violation
            OR not_null_violation THEN
            get stacked diagnostics error_state = returned_sqlstate;
            result := jsonb_build_object('status', 'validation', 'code', 'invalid_command', 'operationId', operation, 'sqlstate', error_state, 'message', CASE WHEN error_state = '22023' THEN
                    LEFT (sqlerrm, 240)
                ELSE
                    'Field or relationship constraint failed'
                END);
    END;
INSERT INTO taskmaster_private.sync_receipts (owner_id, operation_id, fingerprint, response, dependencies)
    VALUES (owner, operation, fingerprint, result, resolved_dependencies);
    RETURN result;
END
$$;

GRANT CREATE ON SCHEMA public TO taskmaster_executor;

ALTER FUNCTION public.apply_command (jsonb) OWNER TO taskmaster_executor;

REVOKE ALL ON FUNCTION public.apply_command (jsonb) FROM public, anon, service_role;

GRANT EXECUTE ON FUNCTION public.apply_command (jsonb) TO authenticated;

REVOKE ALL ON ALL functions IN SCHEMA taskmaster_private FROM public, anon, authenticated, service_role;

GRANT EXECUTE ON ALL functions IN SCHEMA taskmaster_private TO taskmaster_executor;

REVOKE CREATE ON SCHEMA public FROM taskmaster_executor;

