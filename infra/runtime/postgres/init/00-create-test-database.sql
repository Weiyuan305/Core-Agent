CREATE ROLE core_agent_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE core_agent_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

ALTER DATABASE core_agent_runtime OWNER TO core_agent_migrator;
REVOKE CONNECT, TEMPORARY ON DATABASE core_agent_runtime FROM PUBLIC;
GRANT CONNECT ON DATABASE core_agent_runtime TO core_agent_migrator;
GRANT CONNECT ON DATABASE core_agent_runtime TO core_agent_app;

CREATE DATABASE core_agent_control OWNER core_agent_migrator;
REVOKE CONNECT, TEMPORARY ON DATABASE core_agent_control FROM PUBLIC;
GRANT CONNECT ON DATABASE core_agent_control TO core_agent_migrator;
GRANT CONNECT ON DATABASE core_agent_control TO core_agent_app;

\connect core_agent_runtime
ALTER SCHEMA public OWNER TO core_agent_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO core_agent_app;
ALTER DEFAULT PRIVILEGES FOR ROLE core_agent_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_agent_app;
ALTER DEFAULT PRIVILEGES FOR ROLE core_agent_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO core_agent_app;

\connect core_agent_control
ALTER SCHEMA public OWNER TO core_agent_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO core_agent_app;
ALTER DEFAULT PRIVILEGES FOR ROLE core_agent_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_agent_app;
ALTER DEFAULT PRIVILEGES FOR ROLE core_agent_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO core_agent_app;
