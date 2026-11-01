<div align="center">

<h1>Paper-tracker</h1>

<img src="./public/logo.svg" alt="Paper-tracker logo" width="80" height="80">

<p><strong>A private, self-hosted workspace for tracking journals and research papers.</strong></p>

<p>Paper-tracker is designed for one trusted deployment per user. Run it on a trusted private network or Tailscale; network access controls protect the instance. The app opens directly into the workspace and does not provide a public sign-up service or an administrator login page.</p>

</div>

## Quick start

Requirements: Docker Engine and the Docker Compose plugin. Node.js is not required on the host.

```sh
./scripts/setup.sh
```

Open [http://localhost:3000](http://localhost:3000). The setup script prepares persistent data and secret directories, builds the image, initializes the database, and starts the web app and its separate background worker. Running setup again reuses the existing configuration and data.

By default, instance files live under `paper-tracker-data/`:

- `data/` stores the database, synchronization state, papers, settings, and backups.
- `secrets/` stores the encryption and session keys.
- `compose.env` stores non-secret deployment settings.

Keep these directories when upgrading or rebuilding the image. For Tailscale access, backups, restores, and upgrades, see the [Docker deployment guide](docs/deployment/docker.md).

## Features

- Search the bundled journal catalog by title, alias, ISSN, or EISSN; review journal metrics before following a journal.
- Follow journals and synchronize papers from Crossref with cursor pagination and a rolling three-calendar-month window in `Asia/Shanghai`.
- Configure your own OpenAI-compatible API endpoint, key, model, and filtering prompt. Requests go directly from your instance to the endpoint you configure.
- Filter and translate paper titles only. Abstracts are not requested, stored, displayed, or sent to AI.
- Archive a journal's existing papers, favorite individual papers, and keep those states across restarts and unfollowing.
- Create consistent database backups in independently compressed 16 MiB chunks with SHA-256 verification.
- Back up followed journals, per-journal filter settings, AI connection settings, Crossref email, and the daily schedule to a generic WebDAV server; configuration snapshots are encrypted with the instance key.
- Use the bundled 2025 journal partition and JCR 2025 impact-factor snapshots. Data sources and metric-year details are documented in the [journal data notes](data/journals/README.md) and [NOTICE](NOTICE.md).

AI is optional. Without credentials, journal search, synchronization, archiving, and favorites remain available. Each deployment owner supplies and pays for their own AI API usage; the project does not provide shared credentials or an AI proxy.

## Development

Use the Node.js version in `.node-version` and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

Development data is stored under `.local/paper-tracker-data/`, separately from the deployment data directory. Run the verification commands with:

```sh
pnpm check:repository
pnpm typecheck
pnpm test
pnpm build
pnpm test:docker
```

## CI and container images

GitHub Actions runs source and data checks, tests, and production builds. On every push and pull request, native Linux AMD64 and ARM64 runners build the container and run the Compose lifecycle and backup checks. A successful push to `main` publishes architecture-specific image tags and a shared multi-platform version tag to GHCR, for example `ghcr.io/zenanh/paper-tracker:1.7`.

Release tags are immutable and come from `package.json`. Releases advance from `1.0` through `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, and `1.7`; failed, unpublished releases reuse their version. The shared version tag resolves to both `linux/amd64` and `linux/arm64`. Windows containers are not supported.

See the [CI and release guide](docs/deployment/github.md) for the workflow and upload boundaries. See [CONTRIBUTING.md](CONTRIBUTING.md) for local development details.
