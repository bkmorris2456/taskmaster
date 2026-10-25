-- Native Supabase retains default TRUNCATE/REFERENCES/TRIGGER/MAINTAIN grants
-- even when automatic API exposure is disabled. Taskmaster migration-created
-- objects must start default-deny, including non-REST privilege surfaces.
ALTER DEFAULT PRIVILEGES IN SCHEMA public, taskmaster_private
REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, taskmaster_private
REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE taskmaster_executor IN SCHEMA public, taskmaster_private
REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE taskmaster_executor IN SCHEMA public, taskmaster_private
REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
