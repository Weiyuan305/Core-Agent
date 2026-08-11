export interface RuntimeEnvironment {
  databaseUrl: string;
  databasePasswordFile: string;
  bootstrapKeyFile: string;
  apiHost: string;
  apiPort: number;
  secretRoot: string;
  supervisorSocket: string;
  providerCatalogFile: string;
  workerId: string;
}

export function loadRuntimeEnvironment(env: NodeJS.ProcessEnv): RuntimeEnvironment {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is required`);
    }
    return value;
  };

  const apiHost = env.CONTROL_PLANE_API_HOST?.trim() || "127.0.0.1";
  const containerBind = env.CONTROL_PLANE_API_CONTAINER_BIND === "1";
  if (
    apiHost !== "127.0.0.1"
    && apiHost !== "::1"
    && !(apiHost === "0.0.0.0" && containerBind)
  ) {
    throw new Error("CONTROL_PLANE_API_HOST must be loopback or private deployment wiring");
  }

  const apiPort = Number(env.CONTROL_PLANE_API_PORT || "8787");
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65_535) {
    throw new Error("CONTROL_PLANE_API_PORT must be an integer from 1024 through 65535");
  }

  const workerId = required("CONTROL_PLANE_WORKER_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(workerId)) {
    throw new Error("CONTROL_PLANE_WORKER_ID must be a bounded worker identifier");
  }

  return {
    databaseUrl: required("CONTROL_PLANE_DATABASE_URL"),
    databasePasswordFile: required("CONTROL_PLANE_DATABASE_PASSWORD_FILE"),
    bootstrapKeyFile: required("CONTROL_PLANE_BOOTSTRAP_KEY_FILE"),
    apiHost,
    apiPort,
    secretRoot: required("CONTROL_PLANE_SECRET_ROOT"),
    supervisorSocket: required("CONTROL_PLANE_SUPERVISOR_SOCKET"),
    providerCatalogFile: required("CONTROL_PLANE_PROVIDER_CATALOG_FILE"),
    workerId,
  };
}
