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
exec hermes gateway run
