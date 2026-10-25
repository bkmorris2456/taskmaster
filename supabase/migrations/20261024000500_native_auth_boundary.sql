-- Native certification correction: Supabase postgres cannot delegate USAGE on
-- the managed auth schema. Preserve the four applied migrations. Narrow private
-- bridges delegate only auth.uid()/aal reads, never business-table operations.
-- No authenticated-role inheritance or privileged task-data writer is introduced.
CREATE FUNCTION taskmaster_private.current_user_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT auth.uid(); $$;

CREATE FUNCTION taskmaster_private.current_aal()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT auth.jwt()->>'aal'; $$;

REVOKE ALL ON FUNCTION taskmaster_private.current_user_id(), taskmaster_private.current_aal()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION taskmaster_private.current_user_id(), taskmaster_private.current_aal()
TO taskmaster_executor;

-- Preserve each existing function's signature, attributes, owner and grants.
-- Only the two literal Auth calls in Taskmaster-owned definitions are replaced.
DO $$
DECLARE definition text;
BEGIN
    FOR definition IN
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='taskmaster_private' OR
            (n.nspname='public' AND p.proname IN ('apply_command','pull_changes','get_receipt')))
            AND (p.prosrc LIKE '%auth.uid ()%' OR p.prosrc LIKE '%auth.jwt ()%')
    LOOP
        EXECUTE replace(replace(definition,
            'auth.uid ()', 'taskmaster_private.current_user_id()'),
            'auth.jwt () ->> ''aal''', 'taskmaster_private.current_aal()');
    END LOOP;
END $$;

-- Authenticated reads retain native auth.uid()/jwt() directly. Only the executor
-- uses the private bridges; API roles receive no access to the private schema.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['public.tasks','public.categories','public.groups',
        'public.recurrence_series','public.completion_events',
        'taskmaster_private.sync_state','taskmaster_private.sync_receipts',
        'taskmaster_private.sync_changes'] LOOP
        EXECUTE format('ALTER POLICY owner_aal2_read ON %s TO authenticated',t);
        EXECUTE format('CREATE POLICY executor_aal2_read ON %s FOR SELECT TO taskmaster_executor USING (owner_id=(SELECT taskmaster_private.current_user_id()) AND (SELECT taskmaster_private.current_aal())=''aal2'')',t);
        EXECUTE format('ALTER POLICY owner_aal2_insert ON %s WITH CHECK (owner_id=(SELECT taskmaster_private.current_user_id()) AND (SELECT taskmaster_private.current_aal())=''aal2'')',t);
        EXECUTE format('ALTER POLICY owner_aal2_update ON %s USING (owner_id=(SELECT taskmaster_private.current_user_id()) AND (SELECT taskmaster_private.current_aal())=''aal2'') WITH CHECK (owner_id=(SELECT taskmaster_private.current_user_id()) AND (SELECT taskmaster_private.current_aal())=''aal2'')',t);
    END LOOP;
END $$;

-- Fail closed if a deployment role cannot run the two native Auth accessors.
DO $$
BEGIN
    PERFORM taskmaster_private.current_user_id(), taskmaster_private.current_aal();
END $$;
