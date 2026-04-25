# Codex Cage Base Image

The base image is the minimal runtime for Codex Cage agent containers.

Published image:

```text
ghcr.io/jhowliu/codex-cage/base:0.1.1
```

The CLI should use immutable version tags for reproducible runs. The `latest` tag is published only as a manual testing convenience.

## Contents

The image is based on `node:22-bookworm` and includes:

- Node.js and npm
- pinned `@openai/codex`
- `git`
- GitHub CLI `gh`
- `curl`
- `jq`
- `ca-certificates`
- `openssh-client`
- a non-root `agent` user
- `/workspace` owned by `agent`

The image intentionally does not include Docker CLI, Python, Go, Rust, Java, native build toolchains, database clients, browser tooling, `tini`, or a custom entrypoint. Target repositories should add project-specific system dependencies in their own `.codex-cage/Dockerfile`.

## Local Validation

```bash
npm run qa:image
```

This builds `codex-cage/base:local` and verifies the expected tools are available as the `agent` user.

## Publishing

The image publish workflow builds `docker/base/Dockerfile` and pushes:

```text
ghcr.io/jhowliu/codex-cage/base:<version>
ghcr.io/jhowliu/codex-cage/base:latest
```

Publishing is available through manual workflow dispatch and tags shaped like `base-v0.1.1`. Published images include `linux/amd64` and `linux/arm64` manifests.
