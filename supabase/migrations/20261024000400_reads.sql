CREATE FUNCTION public.pull_changes (CURSOR bigint DEFAULT 0, watermark bigint DEFAULT NULL, page_size integer DEFAULT 500)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $$
DECLARE
    OWNER uuid := taskmaster_private.require_auth ();
    current_sequence bigint;
    boundary bigint;
    next_cursor bigint;
    changes jsonb;
BEGIN
    SELECT
        s.sequence INTO current_sequence
    FROM
        taskmaster_private.sync_state s
    WHERE
        s.owner_id = OWNER;
    current_sequence := coalesce(current_sequence, 0);
    boundary := coalesce(watermark, current_sequence);
    IF CURSOR IS NULL OR CURSOR < 0 OR boundary < CURSOR OR boundary > current_sequence OR page_size IS NULL OR page_size < 1 OR page_size > 500 THEN
        RAISE EXCEPTION 'Invalid cursor, watermark or page size'
            USING errcode = '22023';
    END IF;
    SELECT
        coalesce(jsonb_agg(jsonb_build_object('sequence', c.sequence, 'kind', c.kind, 'id', c.id, 'operationId', c.operation_id, 'state', c.state)
            ORDER BY c.sequence), '[]'::jsonb),
        coalesce(max(c.sequence), CURSOR) INTO changes,
        next_cursor
    FROM (
        SELECT
            raw.*,
            sum(octet_length(raw.state::text) + 512) OVER (ORDER BY raw.sequence) AS byte_budget
        FROM (
            SELECT
                *
            FROM
                taskmaster_private.sync_changes
            WHERE
                owner_id = OWNER
                AND SEQUENCE >
                    CURSOR
                    AND SEQUENCE <=
                        boundary
                    ORDER BY
                        SEQUENCE
                    LIMIT page_size) raw) c
WHERE
    c.byte_budget <= 1048576;
    RETURN jsonb_build_object('protocolVersion', 1, 'cursor', next_cursor, 'watermark', boundary, 'hasMore', next_cursor < boundary, 'changes', changes);
END
$$;

CREATE FUNCTION public.get_receipt (operation_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $$
DECLARE
    OWNER uuid := taskmaster_private.require_auth ();
    result jsonb;
BEGIN
    SELECT
        r.response INTO result
    FROM
        taskmaster_private.sync_receipts r
    WHERE
        r.owner_id = OWNER
        AND r.operation_id = get_receipt.operation_id;
    RETURN result;
END
$$;

GRANT CREATE ON SCHEMA public TO taskmaster_executor;

ALTER FUNCTION public.pull_changes (bigint, bigint, integer) OWNER TO taskmaster_executor;

ALTER FUNCTION public.get_receipt (uuid) OWNER TO taskmaster_executor;

REVOKE ALL ON FUNCTION public.pull_changes (bigint, bigint, integer), public.get_receipt (uuid) FROM public, anon, service_role;

GRANT EXECUTE ON FUNCTION public.pull_changes (bigint, bigint, integer), public.get_receipt (uuid) TO authenticated;

-- Prevent future helpers from accidentally acquiring PUBLIC EXECUTE.
ALTER DEFAULT privileges FOR ROLE taskmaster_executor IN SCHEMA public REVOKE EXECUTE ON functions FROM public;

ALTER DEFAULT privileges FOR ROLE taskmaster_executor IN SCHEMA taskmaster_private REVOKE EXECUTE ON functions FROM public;

REVOKE CREATE ON SCHEMA public FROM taskmaster_executor;

