-- Certification follow-up: the bounded cascade guard uses compact auth.uid()
-- spelling. Rewrite remaining calls without changing any applied migration.
DO $$
DECLARE definition text;
BEGIN
    FOR definition IN
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='taskmaster_private'
            AND p.proname NOT IN ('current_user_id','current_aal')
            AND p.prosrc ~ 'auth[.]uid[[:space:]]*[(][[:space:]]*[)]'
    LOOP
        EXECUTE regexp_replace(definition,
            'auth[.]uid[[:space:]]*[(][[:space:]]*[)]',
            'taskmaster_private.current_user_id()', 'g');
    END LOOP;
END $$;
