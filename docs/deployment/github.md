# GitHub CI and Image Releases

The repository is `ZenanH/Paper-tracker`; container images are published to GHCR. The workflow is defined in `.github/workflows/ci.yml`.

Every push and pull request runs source and data checks, tests, and a production build. A matrix of native Linux AMD64 and ARM64 runners builds the Docker image and verifies the Compose lifecycle and backup/restore flow. A successful push to `main` publishes architecture-specific tags (`<version>-amd64` and `<version>-arm64`) and then creates one immutable multi-platform `<version>` tag.

The release job uses a job-scoped `GITHUB_TOKEN` with `packages: write`. The image version comes from `package.json`; bump the three-part package version for each new release. The first published version was `1.0`; this revision advances to `1.7`. A failed, unpublished release retries with the same version. The workflow does not publish `latest` or Windows images.

## Upload Boundaries

Upload application source, scripts, tests, styles and public assets, the pinned journal CSV snapshots and manifest, third-party notices, documentation, Docker/Compose files, lockfiles, and the `.github` configuration.

`.gitignore` excludes instance data, secrets, SQLite/WAL/SHM files, backups, dependencies, and build output. `.gitattributes` preserves raw CSV line endings so their source SHA-256 values remain stable. `pnpm check:repository` checks the actual Git upload candidate set, including accidentally tracked ignored files.

Do not upload `.local/`, `.next/`, `dist/`, the generated `catalog/`, `node_modules/`, `.pnpm-store/`, `tsconfig.tsbuildinfo`, instance directories, `compose.env`, secrets, or database backups. CI rebuilds the journal catalog from the committed snapshots and builds the Docker images itself.

