-- Native Supabase/pgTAP companion gate. Runs only against a disposable local stack.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET local search_path = public, extensions;
GRANT usage ON SCHEMA extensions TO authenticated;
SELECT
    plan (18);
SELECT
    has_table ('public', 'tasks', 'tasks exist');
SELECT
    has_table ('public', 'categories', 'categories exist');
SELECT
    has_table ('public', 'groups', 'groups exist');
SELECT
    has_table ('public', 'recurrence_series', 'series exist');
SELECT
    has_table ('public', 'completion_events', 'events exist');
SELECT
    IS ((
            SELECT
                count(*)::integer
            FROM
                pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE
                c.relkind = 'r'
                AND n.nspname IN ('public', 'taskmaster_private')
                AND c.relrowsecurity
                AND c.relforcerowsecurity),
            8,
            'all eight data surfaces force RLS');
SELECT
    ok ((
            SELECT
                NOT rolcanlogin
                AND NOT rolsuper
                AND NOT rolbypassrls
                AND NOT rolinherit
            FROM
                pg_roles
            WHERE
                rolname = 'taskmaster_executor'), 'executor cannot log in or bypass RLS');
SELECT
    ok (NOT has_table_privilege('authenticated', 'public.tasks', 'INSERT,UPDATE,DELETE'),
        'authenticated direct writes denied');
SELECT
    ok (NOT has_table_privilege('anon', 'public.tasks', 'SELECT'),
        'anonymous reads denied');
SELECT
    ok (NOT has_function_privilege('authenticated', 'taskmaster_private.store(text,jsonb,uuid,timestamptz)', 'EXECUTE'),
        'internal mutation helper denied');
INSERT INTO auth.users (id, email)
    VALUES ('60000000-0000-4000-8000-000000000001', 'taskmaster-native-test@example.invalid');
SET local ROLE authenticated;
SELECT
    set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}', TRUE);
SELECT
    IS (public.apply_command ('{"id":"60000000-0000-4000-8000-000000000002","protocolVersion":1,"ownerId":"60000000-0000-4000-8000-000000000001","taskId":"60000000-0000-4000-8000-000000000003","result":{"id":"60000000-0000-4000-8000-000000000003"},"payload":{"kind":"create","input":{"title":"Native SQL test"}}}'::jsonb) ->> 'status',
        'applied',
        'AAL2 owner command succeeds');
SELECT
    IS ((
            SELECT
                count(*)::integer
            FROM
                public.tasks),
            1,
            'AAL2 sees own task');
SELECT
    set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', TRUE);
SELECT
    IS ((
            SELECT
                count(*)::integer
            FROM
                public.tasks),
            0,
            'AAL1 cannot read own task');
SELECT
    throws_ok ('select public.pull_changes()', '42501', 'Verified AAL2 authentication required', 'AAL1 cannot pull');
SELECT
    set_config('request.jwt.claims', '{"sub":"60000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}', TRUE);
SELECT
    IS ((
            SELECT
                count(*)::integer
            FROM
                public.tasks),
            0,
            'other AAL2 owner cannot read task');
SELECT
    IS (public.get_receipt ('60000000-0000-4000-8000-000000000002')::text,
        NULL::text,
        'other owner cannot read receipt');
RESET ROLE;
SELECT
    ok (NOT has_table_privilege('service_role', 'public.tasks', 'INSERT,UPDATE,DELETE'),
        'service-role direct writes also revoked');
SELECT
    ok (NOT pg_has_role('authenticated', 'taskmaster_executor', 'MEMBER'),
        'API user cannot assume executor');
SELECT
    *
FROM
    finish ();
ROLLBACK;

