import { Client } from "pg";

import {
  databaseConnectionOptions,
  readProtectedDatabasePassword,
} from "../config/database-password.js";

export interface RuntimeDatabaseAuthBootstrapInput {
  readonly databaseUrl: string;
  readonly bootstrapPasswordFile: string;
  readonly migratorPasswordFile: string;
  readonly applicationPasswordFile: string;
  readonly identityPasswordFile: string;
}

async function setRolePassword(client: Client, role: string, password: string): Promise<void> {
  await client.query("select set_config('core_agent.database_role_name', $1, true)", [role]);
  await client.query("select set_config('core_agent.database_role_password', $1, true)", [password]);
  await client.query(`do $password$
    declare
      role_name text := current_setting('core_agent.database_role_name');
      role_password text := current_setting('core_agent.database_role_password');
    begin
      execute format('alter role %I password %L', role_name, role_password);
      perform set_config('core_agent.database_role_name', '', true);
      perform set_config('core_agent.database_role_password', '', true);
    end
  $password$`);
}

export async function bootstrapRuntimeDatabaseAuth(input: RuntimeDatabaseAuthBootstrapInput): Promise<void> {
  const [bootstrapPassword, migratorPassword, applicationPassword, identityPassword] = await Promise.all([
    readProtectedDatabasePassword(input.bootstrapPasswordFile),
    readProtectedDatabasePassword(input.migratorPasswordFile),
    readProtectedDatabasePassword(input.applicationPasswordFile),
    readProtectedDatabasePassword(input.identityPasswordFile),
  ]);
  if (new Set([bootstrapPassword, migratorPassword, applicationPassword, identityPassword]).size !== 4) {
    throw new Error("Database authentication bootstrap failed");
  }
  let bootstrapRole: string;
  try {
    bootstrapRole = new URL(input.databaseUrl).username;
  } catch {
    throw new Error("Database authentication bootstrap failed");
  }
  if (!/^core_agent_[a-z0-9_]+$/u.test(bootstrapRole)) {
    throw new Error("Database authentication bootstrap failed");
  }
  const options = databaseConnectionOptions(input.databaseUrl, bootstrapPassword);
  const client = new Client(options);
  try {
    await client.connect();
    await client.query("begin");
    await client.query("set local password_encryption = 'scram-sha-256'");
    await client.query(`do $roles$
      begin
        if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then
          create role core_agent_migrator login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
          create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
          create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
        end if;
      end
    $roles$`);
    await client.query(`do $memberships$
      declare edge record;
      begin
        for edge in
          select granted_role.rolname as granted_role, member_role.rolname as member_role
          from pg_auth_members memberships
          join pg_roles granted_role on granted_role.oid = memberships.roleid
          join pg_roles member_role on member_role.oid = memberships.member
          where granted_role.rolname = any(array['core_agent_migrator', 'core_agent_app', 'core_agent_identity'])
             or member_role.rolname = any(array['core_agent_migrator', 'core_agent_app', 'core_agent_identity'])
          order by granted_role.rolname, member_role.rolname
        loop
          execute format('revoke %I from %I', edge.granted_role, edge.member_role);
        end loop;
      end
    $memberships$`);
    await client.query("alter role core_agent_migrator login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
    await client.query("alter role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
    await client.query("alter role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
    await setRolePassword(client, bootstrapRole, bootstrapPassword);
    await setRolePassword(client, "core_agent_migrator", migratorPassword);
    await setRolePassword(client, "core_agent_app", applicationPassword);
    await setRolePassword(client, "core_agent_identity", identityPassword);
    await client.query(`do $database_privileges$
      begin
        execute format('revoke connect, temporary on database %I from public', current_database());
        execute format('grant connect on database %I to core_agent_migrator', current_database());
        execute format('grant connect on database %I to core_agent_app', current_database());
        execute format('grant connect on database %I to core_agent_identity', current_database());
        if exists (select 1 from pg_database where datname = 'core_agent_control') then
          revoke connect on database core_agent_control from core_agent_identity;
        end if;
      end
    $database_privileges$`);
    await client.query("revoke all on schema public from public");
    await client.query("grant usage on schema public to core_agent_app, core_agent_identity");
    await client.query("commit");
  } catch {
    await client.query("rollback").catch(() => undefined);
    throw new Error("Database authentication bootstrap failed");
  } finally {
    await client.end().catch(() => undefined);
  }
}
