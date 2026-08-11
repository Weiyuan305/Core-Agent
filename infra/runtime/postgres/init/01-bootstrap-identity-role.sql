DO $identity_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'core_agent_identity'
  ) THEN
    CREATE ROLE core_agent_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$identity_role$;

ALTER ROLE core_agent_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE core_agent_runtime TO core_agent_identity;
GRANT USAGE ON SCHEMA public TO core_agent_identity;
