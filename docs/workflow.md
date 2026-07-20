# Codex Cage Workflow

Codex Cage runs issue-driven Codex work in Docker-owned workspaces. The CLI is built as a set of small orchestration slices: config/init, issue context, repo auth, Docker sandboxing, Compose services, guards, review, publishing, and cleanup.

The `run` command wires those slices into one orchestration loop. It fetches issue context, clones into a Docker volume, runs setup and verification commands, feeds failures back into Codex for bounded retries, runs an independent read-only review, blocks secret-bearing diffs, and publishes a PR only after all gates pass.

For concise copy-pasteable commands, see the [CLI examples guide](cli-examples.md).

## Install

From this repository:

```bash
npm install
npm run build
npm install -g .
codex-cage --help
```

For a one-off local invocation:

```bash
npm run build
npm exec -- codex-cage --help
```

Node.js `>=22` is required.

## Token Setup

Create `.codex-cage.env` in the host repo where you run Codex Cage:

```dotenv
OPENAI_API_KEY=...
GITHUB_TOKEN=...
LINEAR_API_KEY=...
```

`LINEAR_API_KEY` is required only for Linear issue URLs. `.codex-cage.env` is ignored by `codex-cage init` and must not be committed.

### GitHub Token Permissions

Use a fine-grained GitHub token scoped to the target repository.

Required repository permissions:

- **Contents: Read and write** for clone, branch push, and commit publishing.
- **Issues: Read-only** for GitHub issue context.
- **Pull requests: Read and write** for PR creation.
- **Metadata: Read-only** is required by GitHub for repository access.

No organization-wide token is required.

## Initialize A Target Repo

Run this in the target repository:

```bash
codex-cage init
```

This creates:

- `.codex-cage.yml`
- `.codex-cage/review-policy.md`
- `.codex-cage.env.example`
- `.gitignore` entries for `.codex-cage.env`, run artifacts, and SQLite metadata

Use a custom Dockerfile when the target repository needs system packages:

```bash
codex-cage init --dockerfile
```

## `.codex-cage.yml` Schema

```yaml
setup:
  - npm ci
  - cp .codex-cage/test.env .env

verify:
  - npm test

services:
  compose: .codex-cage/docker-compose.yml
  ready:
    - pg_isready -h postgres -U postgres

runtime:
  image: ghcr.io/jhowliu/codex-cage/base:0.1.1
  dockerfile: null

agent:
  model: gpt-5.4-mini
  max_iterations: 5
  max_review_cycles: 2

timeouts:
  total_minutes: 90
  command_minutes: 20
  idle_minutes: 10

pr:
  draft: false

git:
  base: main
  author_name: Codex Cage
  author_email: codex-cage@users.noreply.github.com

issue:
  comments: 10

guards:
  max_secret_fix_attempts: 2
```

`verify` must contain at least one command. The generated default intentionally fails until replaced with the target repo's real validation command.

`runtime.image` accepts any valid Docker image reference and defaults to the Codex Cage GHCR base image. If `runtime.dockerfile` is set, Codex Cage builds a labeled per-run image before cloning the target repository. The first version uses `.codex-cage/` as the Docker build context, so target runtime Dockerfiles should keep package-install inputs inside that directory.

## Docker Compose Services

Compose services are started by the host-side Codex Cage orchestrator, not by the implementation agent. Codex Cage runs `docker compose up -d` with a per-run project name, attaches the agent container to the Compose network, runs each `services.ready` command from a short-lived container on that same network, and tears services down with `docker compose down -v`.

This keeps the agent boundary simple:

- Do not mount `/var/run/docker.sock` into the agent container.
- Do not rely on host ports for agent-to-service traffic.
- Use Compose service DNS names in target repo env files, such as `postgres`, `redis`, `minio`, or whatever service names the Compose file declares.
- Keep services private by default; publish host ports only when a target repo explicitly needs them.

Target repos that need an `.env` file for tests should prefer a committed, non-secret fixture copied during `setup`:

```yaml
setup:
  - npm ci
  - cp .codex-cage/test.env .env
  - npm run migrate --workspace=server

services:
  compose: .codex-cage/docker-compose.yml
  ready:
    - pg_isready -h postgres -U postgres
```

Example `.codex-cage/test.env`:

```dotenv
NODE_ENV=test
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/app_test
REDIS_URL=redis://redis:6379
MINIO_ENDPOINT=minio
```

This is clearer than embedding a long inline script in `.codex-cage.yml`, and it keeps generated `.env` files untracked. Fixture env files must contain only local test credentials; real secrets belong in `.codex-cage.env`.

When a Compose file lives under `.codex-cage/`, Codex Cage still runs Compose with the target repo as the project directory. Relative bind mounts like `./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` resolve from the repo root during `codex-cage run`. If you run the same Compose file manually, pass `--project-directory <repo-root>` to match Codex Cage's behavior.

## Execution Modes

> Status: in progress. Tracked in [#80](https://github.com/jhowliu/codex-cage/issues/80). The engine supports both modes, and the label-triggered GitHub Actions workflow (see [GitHub Actions Automation](#github-actions-automation)) runs direct mode. A PR-revise loop is still pending.

Select the mode with the `CODEX_CAGE_EXECUTION` environment variable (`docker` or `direct`) or the `execution` key in `.codex-cage.yml`. The environment variable wins; both default to `docker`.

Codex Cage's isolation strategy depends on where it runs. The engine — bounded retry loop, independent review gate, secret guard, publish gate — is identical across modes; only the workspace isolation and service provisioning differ.

- **Docker mode (default; local and self-hosted runners).** Codex Cage owns isolation: per-run volume clone, optional runtime image build, and Compose services started by the host-side orchestrator (see [Docker Compose Services](#docker-compose-services)). This is required wherever the host is not itself disposable — a laptop has no ephemeral VM, so the Docker sandbox is what keeps the agent off the host filesystem and credentials.
- **Direct mode (GitHub Actions).** The runner's ephemeral VM already provides disposable isolation, so the inner Docker sandbox is skipped: Codex Cage clones on the runner and runs commands directly on the host through the same `ShellRunner` seam. Services come from GitHub Actions native `services:` containers, not Compose. Opt in via the execution-mode selector set by the workflow.

Which `.codex-cage.yml` keys apply per mode:

| Key                                                 | Docker mode | Direct mode                                                  |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| `setup`, `verify`                                   | yes         | yes                                                          |
| `agent`, `timeouts`, `pr`, `git`, `issue`, `guards` | yes         | yes                                                          |
| `services.compose`, `services.ready`                | yes         | ignored — declare services in the workflow `services:` block |
| `runtime.image`                                     | yes         | use as the job `container:` image                            |
| `runtime.dockerfile` (per-run build)                | yes         | not supported                                                |

In direct mode, running the Actions job inside the Codex Cage base image (`container:`) keeps the existing service DNS-name convention (`postgres`, `redis`) working, with service readiness expressed via service-container `--health-cmd`.

### CI Outcome Signal

For automation, `codex-cage run` emits a deterministic outcome so a workflow can branch on success or failure:

- **Exit code.** The process exits non-zero when the run fails and zero when it succeeds.
- **Result file.** Pass `--result-json <path>` (or set `CODEX_CAGE_RESULT_FILE`; the flag wins) to write the run result as JSON on both success and failure:

  ```json
  {
    "runId": "run-20260704-abcdef",
    "status": "succeeded",
    "failureCode": null,
    "prUrl": "https://github.com/OWNER/REPO/pull/123"
  }
  ```

  `status` is `succeeded` or `failed`; `failureCode` is `null` on success and a failure code (for example `verify_failed`, `review_blocking`) otherwise; `prUrl` is `null` unless a PR was opened.

## GitHub Actions Automation

`.github/workflows/issue-run.yml` turns an issue label into a direct-mode run. Adding the `codex-cage:run` label to an issue builds Codex Cage, runs it against that issue on the runner, and opens a PR on success.

**Label state machine.** The workflow drives three labels:

- `codex-cage:run` — the trigger. Removed as soon as the run starts.
- `codex-cage:in-progress` — added at start, removed at the end (success or failure).
- `codex-cage:blocked` — added on failure, together with a comment that carries the failure code, a link to the workflow run, and the run summary when present.

Create all three labels once before using the workflow. The full run artifact directory is uploaded to each workflow run for debugging.

**Secrets.** Configure two repository secrets:

- `OPENAI_API_KEY` — Codex auth for direct-mode runs.
- `CODEX_CAGE_GITHUB_TOKEN` — a fine-grained PAT or GitHub App installation token used for clone, push, PR creation, and label/comment updates.

Use `CODEX_CAGE_GITHUB_TOKEN` rather than the built-in `GITHUB_TOKEN`: events produced by the default token (opening a PR, adding a label) do not trigger further workflows, so any downstream automation (for example a future review workflow) would never fire. A PAT or App token is also required for the run to push branches and open PRs. The same token permissions as a local run apply (see [GitHub Token Permissions](#github-token-permissions)), plus **Issues: Read and write** for the label state machine.

**Services (db, redis, …).** The default workflow runs directly on `ubuntu-latest` and installs the Codex CLI, which is enough for repos whose `verify` needs no external services. For a repo that needs services, run the job inside the Codex Cage base image and declare service containers so they resolve by DNS name:

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    container: ghcr.io/jhowliu/codex-cage/base:0.1.1
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-retries 10
```

Inside a job container, service containers share a network and are reachable by service name (`postgres`, `redis`), matching the Compose DNS-name convention used in Docker mode. Service definitions live in the workflow, not in `.codex-cage.yml` (`services.compose` is ignored in direct mode).

## Prompt Instructions

Codex Cage relies on Codex CLI's native `AGENTS.md` handling for repository implementation guidance. It does not inject the contents of `AGENTS.md`, `.codex-cage/instructions.md`, `.github/copilot-instructions.md`, or `CLAUDE.md` into implementation or review prompts.

Independent review has a separate project policy file at `.codex-cage/review-policy.md`. `codex-cage init` creates a starter template. The review policy may add stricter project-specific checks, but it cannot override Codex Cage built-in reviewer rules or weaken blocking criteria. Missing review policy files are allowed.

Each run records prompt context artifacts under `.codex-cage/runs/<run-id>`:

- `prompt-context.json`
- `implementation-prompt-<iteration>.md`
- `review-prompt-<cycle>.md`

Prompt artifacts include review policy path/status only; they do not include full review policy contents.

## Running GitHub Issues

```bash
codex-cage run https://github.com/OWNER/REPO/issues/123
```

GitHub issue URLs infer the target repository. If the current directory has a different GitHub origin, Codex Cage fails unless `--repo OWNER/REPO` is passed explicitly.

Successful runs create one branch, one commit, one push, and one ready PR. GitHub issue PR bodies include a closing keyword such as `Closes #123`, so GitHub closes the issue only after PR merge.

## Running Linear Issues

```bash
codex-cage run https://linear.app/ORG/issue/ENG-123/title --repo OWNER/REPO
```

Linear issue URLs provide issue context but do not infer a GitHub repo. Use `--repo`, or run from a directory with a GitHub `origin` remote. Codex Cage links the Linear issue in the PR body but does not mutate Linear.

## Security Boundaries

Codex Cage is designed so agent code runs in Docker-managed resources, not the host working tree.

Current boundaries:

- No host working tree bind mount.
- No Docker socket mount.
- No host SSH config mount.
- No GitHub CLI config mount.
- No host port publishing by default.
- Agent commands run as the non-root `agent` user.
- Secrets are passed as process environment and redacted from logs.
- Diff guards block injected secrets, high-confidence token patterns, private keys, and sensitive auth files.
- Compose services are orchestrator-managed and per-run isolated by project name.

Non-goals:

- Codex Cage is not a general untrusted-code sandbox.
- Codex Cage does not guarantee protection against Docker daemon or kernel vulnerabilities.
- Codex Cage does not manage cloud IAM or external secret rotation.
- Codex Cage does not update Linear issues.

## Base Image

The base agent image is defined in `docker/base/Dockerfile` and published to GHCR:

```text
ghcr.io/jhowliu/codex-cage/base:0.1.1
```

The image is intentionally orchestration-only. It includes Node.js/npm, a pinned `@openai/codex` CLI, `git`, GitHub CLI `gh`, `curl`, `jq`, certificates, OpenSSH client, the non-root `agent` user, and `/workspace`. It does not include Docker CLI, Python, Go, Rust, Java, native build toolchains, database clients, browser tooling, `tini`, or a custom entrypoint.

Target repositories that need language runtimes or system packages should use `codex-cage init --dockerfile` and add those dependencies in `.codex-cage/Dockerfile`.

The publish workflow supports manual dispatch and tags shaped like `base-v0.1.1`. It publishes both the immutable version tag and `latest`, but runtime defaults should use version tags. Published images include `linux/amd64` and `linux/arm64` manifests.

Local image validation is opt-in because it requires Docker and network access:

```bash
npm run qa:image
```

## Cleanup

```bash
codex-cage cleanup
codex-cage cleanup --all
```

Default cleanup removes stopped managed containers plus networks and volumes for runs without active managed containers. `--all` explicitly removes active managed containers and all managed networks and volumes.

Cleanup does not delete `.codex-cage/runs` artifacts or `.codex-cage/codex-cage.sqlite`.

## Local QA

Run all checks:

```bash
npm run typecheck
npm test
npm run qa
npm run format
```

`npm run qa` executes a fake integration harness for the main outcomes:

- success
- verify failure
- review blocking
- secret guard failure
- no-op diff

The QA harness avoids real Codex, Docker, GitHub, and Linear calls by using injected fake runners.
