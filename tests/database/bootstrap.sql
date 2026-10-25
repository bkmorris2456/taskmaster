-- Isolated PostgreSQL/PostgREST harness only. NEVER apply to a Supabase project.
-- Minimal Auth database interface, not an Auth server or MFA implementation.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'anon') THEN
    CREATE ROLE anon nologin;
END IF;
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'authenticated') THEN
    CREATE ROLE authenticated nologin;
END IF;
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'service_role') THEN
    CREATE ROLE service_role nologin bypassrls;
END IF;
    IF NOT EXISTS (
        SELECT
            1
        FROM
            pg_roles
        WHERE
            rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN noinherit;
END IF;
END
$$;

GRANT anon, authenticated TO authenticator;

CREATE SCHEMA auth;

CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    email text UNIQUE
);

CREATE FUNCTION auth.uid ()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        coalesce(nullif (current_setting('request.jwt.claim.sub', TRUE), ''),nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid;
$$;

CREATE FUNCTION auth.jwt ()
    RETURNS jsonb
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        coalesce(nullif (current_setting('request.jwt.claim', TRUE), ''),nullif(current_setting('request.jwt.claims',true),''))::jsonb;
$$;

GRANT usage ON SCHEMA auth TO anon, authenticated;

GRANT EXECUTE ON FUNCTION auth.uid (), auth.jwt () TO anon, authenticated;

