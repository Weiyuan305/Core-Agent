#!/bin/sh
set -eu
if [ "$#" -ne 0 ]; then
  echo "Hermes gateway entrypoint accepts no arguments" >&2
  exit 64
fi
key_file=/run/secrets/hermes_ingress
if [ ! -f "$key_file" ]; then
  echo "Hermes ingress secret file is unavailable" >&2
  exit 78
fi
API_SERVER_KEY=$(tr -d '\r\n' < "$key_file")
if [ "${#API_SERVER_KEY}" -lt 16 ]; then
  echo "Hermes ingress secret is unusable" >&2
  exit 78
fi
export API_SERVER_KEY
policy_token_file=/run/secrets/core_agent_policy_runtime_token
if [ ! -f "$policy_token_file" ]; then
  echo "Core-Agent policy runtime secret file is unavailable" >&2
  exit 78
fi
CORE_AGENT_POLICY_RUNTIME_TOKEN=$(tr -d '\r\n' < "$policy_token_file")
if [ "${#CORE_AGENT_POLICY_RUNTIME_TOKEN}" -lt 16 ]; then
  echo "Core-Agent policy runtime secret is unusable" >&2
  exit 78
fi
export CORE_AGENT_POLICY_RUNTIME_TOKEN
exec hermes gateway run
