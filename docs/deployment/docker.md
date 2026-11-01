# Docker Deployment

Local Compose builds use the version-independent image tag `paper-tracker:local`. Published GHCR releases use immutable version tags; the CI workflow validates Linux AMD64 and ARM64 before publishing the shared multi-platform tag.

Docker Compose is required. Setup uses a temporary Node.js container to prepare instance keys, so Node.js is not required on the host:

```sh
./scripts/setup.sh
```

By default, `paper-tracker-data/` contains `data/`, `secrets/`, and the non-secret `compose.env` file. AI settings are configured in the app; API keys are encrypted in the mounted database. If an existing instance is missing its encryption key, setup stops instead of generating a replacement.

Use the same environment file for subsequent Compose commands so the data path, port, and service UID stay consistent:

```sh
docker compose --env-file paper-tracker-data/compose.env ps
docker compose --env-file paper-tracker-data/compose.env logs --tail=50
```

Before rebuilding, stop the old web and worker services while keeping the data directory:

```sh
docker compose --env-file paper-tracker-data/compose.env down
docker compose --env-file paper-tracker-data/compose.env up -d --build
```

Never delete the mounted data or secrets directories during an upgrade. The web app and worker share a local SQLite database; do not move it to a cross-host network filesystem.

AI requests use the regular Compose bridge network. DNS answers made entirely of VPN Fake-IP addresses in `198.18.0.0/15` are recognized and mapped from IPv4-mapped IPv6 to IPv4 before connecting; mixed or other private IP answers remain blocked unless the exact origin is listed in `AI_ALLOWED_ORIGINS`. The web service binds to `127.0.0.1:3000` by default. For trusted Tailscale access, set `BIND_ADDRESS` to the host's Tailscale IP and `APP_URL` to the origin users actually open. Write-request origin checks rely on this value. Recreate the services after changing it; do not expose every host interface by default.

WebDAV configuration sync is optional and accepts standard HTTPS WebDAV servers, including services such as Nutstore. Configuration snapshots are encrypted with the instance `ENCRYPTION_KEY_FILE`; restoring them on another instance requires the same key file. The WebDAV password is encrypted in the local database and is never included in the snapshot. Public WebDAV hosts need no extra setting. To use a private or tailnet WebDAV server, add its exact origin (scheme and host, without a path) to `WEBDAV_ALLOWED_ORIGINS` in `compose.env`, then recreate the services. The client rejects redirects and limits response size and request duration.

An isolated deployment check can use its own data directory and port:

```sh
PAPER_TRACKER_DATA=.local/docker-smoke/paper-tracker-data \
APP_URL=http://localhost:3010 WEB_PORT=3010 \
COMPOSE_PROJECT_NAME=paper-tracker-smoke ./scripts/setup.sh
```

Compose starts `init` before `web` and `worker`. The worker has no published port; the web service exposes an HTTP health check.

## Health and Upgrades

The `web` health check calls `/api/ready` to verify the database and installation record. The worker health check requires a database heartbeat within 25 seconds. Both services should show `healthy` in `docker compose ps`. Docker does not automatically restart an unhealthy process; check logs, directory permissions, and available disk space. The worker has a 120-second shutdown grace period. An interrupted request releases its lease so the next worker can resume from its last committed checkpoint without consuming a retry.

When setup runs as root on a new instance, it prepares service directories for the default non-root UID/GID 1000. `PUID=0` is rejected. A regular user defaults to its own UID/GID. Re-running setup preserves the UID/GID in `compose.env`. If setting `PUID` or `PGID` explicitly, make sure that identity can write the host data directory and read the secret files. Do not use `chmod 777`. Setup waits for service health and exits with an error if initialization fails or health checks time out.

## Backup and Restore

Create a consistent online backup while the web and worker services are running:

```sh
docker compose --env-file paper-tracker-data/compose.env exec -T web node dist/scripts/backup.js
```

Backups are written under `paper-tracker-data/data/backups/<snapshot-id>/`. A complete snapshot contains `COMPLETE`, `manifest.json`, and independently gzipped 16 MiB raw blocks. Transfer only completed snapshot directories. If a block is missing or damaged, retransmit that block while keeping the others. Restore verifies each block's length and SHA-256, the full database hash, SQLite integrity and foreign keys, and decryption of the stored AI key. Backups are not encrypted; protect them with host filesystem permissions.

Back up `secrets/` separately and securely. Restore requires the original instance keys. The following command restores into a new `restore-check` directory without changing the live database:

```sh
docker compose --env-file paper-tracker-data/compose.env exec -T web \
  node dist/scripts/restore.js \
  /app/instance/data/backups/<snapshot-id> \
  /app/instance/data/restore-check
```

After verification, stop the old web and worker services, point a new instance at the restored data directory, mount the original secrets read-only, then run initialization and start the services. You may also move the restored database into a prepared instance data directory while the services are stopped. Never overwrite a live database with restore files or combine an old WAL/SHM file with a restored database. Restore fails if the target exists, a block is missing, or the keys do not match; do not delete an active instance to bypass an error.

From a source checkout, use `pnpm backup [output-directory]` and `pnpm restore <snapshot-directory> <new-data-directory>`. Set `PAPER_TRACKER_HOME` and `ENCRYPTION_KEY_FILE` to the original instance. Restore preserves installation time, follows, archive/favorite states, and AI results; it clears the old worker heartbeat so unfinished tasks can resume from their lease and checkpoints.
