#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose version >/dev/null
instance_dir=${PAPER_TRACKER_DATA:-./paper-tracker-data}
mkdir -p "$instance_dir"
instance_dir=$(cd "$instance_dir" && pwd)
# Existing compose.env owns the deployment identity; do not override it with the invoking user.
if [ ! -f "$instance_dir/compose.env" ]; then
  if [ "$(id -u)" = 0 ]; then
    export PUID="${PUID:-1000}" PGID="${PGID:-1000}"
  else
    export PUID="${PUID:-$(id -u)}" PGID="${PGID:-$(id -g)}"
  fi
fi
# Generate secrets on the host bind mount without requiring host Node.js.
docker run --rm -i --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$instance_dir,target=/instance" \
  -e INSTANCE_HOST_PATH="$instance_dir" -e PUID -e PGID -e APP_URL -e WEB_PORT \
  -e BIND_ADDRESS -e COMPOSE_PROJECT_NAME -e AI_ALLOWED_ORIGINS -e WEBDAV_ALLOWED_ORIGINS -e CROSSREF_MAILTO \
  node:24.22.1-bookworm-slim node --input-type=module < scripts/prepare-instance.mjs
docker compose --env-file "$instance_dir/compose.env" build init
docker compose --env-file "$instance_dir/compose.env" stop web worker
docker compose --env-file "$instance_dir/compose.env" up -d --no-build --force-recreate --wait --wait-timeout 180
