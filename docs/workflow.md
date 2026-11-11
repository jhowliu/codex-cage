# Codex Cage Workflow

Codex Cage runs issue-driven Codex work in Docker-owned workspaces. The CLI is built as a set of small orchestration slices: config/setup, issue context, repo auth, Docker sandboxing, Compose services, guards, review, publishing, and cleanup.

The `run` command wires those slices into one orchestration loop. It fetches issue context, clones into a Docker volume, runs setup and verification commands, feeds failures back into Codex for bounded retries, runs an independent read-only review, blocks secret-bearing diffs, and publishes a PR only after all gates pass.

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

Node.js `>=22.13` is required (the run store uses the built-in `node:sqlite` module).

## Local Control Room

Start the local Control Room from a host repository:

```bash
codex-cage control-room
```

The server binds to `127.0.0.1` by default. Use `--port 0` to select an available
port, or provide an explicit local port:

```bash
codex-cage control-room --port 4317
```

The first Control Room slice supports one local repository and GitHub Issue URLs.
It reads the repository's `.codex-cage.yml`, refuses to dispatch repositories that
are not ready, starts the existing Docker-isolated Run workflow in a child Runner,
and streams the Runner's structured Stage events to the browser. Run state is
persisted in `.codex-cage/control-room.json`; full logs and other artifacts remain
under the existing `.codex-cage/runs/<run-id>/` directory.

The Control Room does not expose Docker controls to the browser. The Runner remains
the execution authority, while the Control Room stores a projection of its validated
events. GitHub-hosted Actions remains a separate direct-mode workflow and is not
made live by the local Control Room.

Open a Run and select a stage to see its **Results**: preparation checks and target
branches, a readable file diff, verification command outcomes, independent review
findings, or published branch and PR metadata. **Events** and **Logs & artifacts**
remain available for the selected stage. Result tabs support arrow keys and
Home/End, and update from the existing live event projection.

Change previews are saved after verification and secret checks. New Runs preserve
the final patch before publishing commits the workspace. Older Runs without saved
evidence show an explicit unavailable state; their existing PR remains the source
for inspecting published changes.

## Token Setup

Credentials come from two files. Agent and issue-tracker credentials live once per machine in `~/.config/codex-cage/env` (or `$XDG_CONFIG_HOME/codex-cage/env`), mode `600`:

```dotenv
# Claude Code (implementation by default). Create a token with `claude setup-token`,
# or set ANTHROPIC_API_KEY instead.
CLAUDE_CODE_OAUTH_TOKEN=...
# Codex (review by default). Optional when you are signed in with the Codex CLI.
OPENAI_API_KEY=...
LINEAR_API_KEY=...
```

GitHub credentials stay per repo in `.codex-cage.env` in the host repo where you run Codex Cage, so one repo never uses another repo's account. Either set a token:

```dotenv
GITHUB_TOKEN=...
```

or pin a GitHub CLI account. When `GITHUB_TOKEN` is empty, runs call `gh auth token --hostname github.com --user <login>` at start; without a pin they use gh's active account:

```dotenv
CODEX_CAGE_GH_USER=your-login
```

`codex-cage setup` writes the pin when gh is signed in: one account is used directly, several are offered as a choice (`--yes` takes the active one). Setup also runs its `gh label`/`gh secret` commands as that account. A pinned account that is no longer signed in fails the run instead of falling back to another account; `codex-cage doctor` reports which account local runs use. The gh token carries the scopes of your `gh auth login` session rather than the fine-grained permissions below.

Values in the repo's `.codex-cage.env` override the global file key by key; empty placeholders are ignored. The global file only supplies `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `LINEAR_API_KEY`; `codex-cage doctor` warns about anything else in it. Each agent receives only its own provider's credentials.

`LINEAR_API_KEY` is required only for Linear issue URLs. `.codex-cage.env` is ignored by `codex-cage setup` and must not be committed.

### GitHub Token Permissions

Use a fine-grained GitHub token scoped to the target repository.

Required repository permissions:

- **Contents: Read and write** for clone, branch push, and commit publishing.
- **Issues: Read-only** for GitHub issue context.
- **Pull requests: Read and write** for PR creation.
- **Metadata: Read-only** is required by GitHub for repository access.

No organization-wide token is required.

## Configure A Target Repo

Run this in the target repository:

```bash
codex-cage setup
```

The state-aware wizard detects existing configuration and asks only about missing or changed settings. It can configure local Docker credentials, generate GitHub Actions automation, create the four issue-state labels, and configure missing repository secrets through `gh`.

It creates files only when needed:

- `.codex-cage.yml`
- `.codex-cage/review-policy.md` when missing
- `.codex-cage.env.example` when missing (missing keys are merged into an existing file)
- `.gitignore` entries for `.codex-cage.env`, run artifacts, and SQLite metadata
- `.codex-cage.env` when local credentials are entered
- `.github/workflows/codex-cage.yml` when Actions is enabled

Setup is rerunnable. Use detected defaults non-interactively or preview changes:

```bash
codex-cage setup --yes --actions on
codex-cage setup --dry-run
```

`codex-cage init` was removed; use `codex-cage setup`.

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
  image: ghcr.io/jhowliu/codex-cage/base:0.1.2
  dockerfile: null

agent:
  implement:
    provider: claude
    model: claude-opus-5-5
  review:
    provider: codex
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

actions:
  enabled: true
  workflow: .github/workflows/codex-cage.yml
  codex_cage_version: 0.1.0
  runner: ubuntu-latest
  timeout_minutes: 90
  container: null
  services: {}
  labels:
    run: codex-cage:run
    in_progress: codex-cage:in-progress
    ready: codex-cage:ready-for-review
    blocked: codex-cage:blocked
```

`verify` must contain at least one command. Setup refuses to write a new configuration when no verification command can be selected. It detects commands from files at the repository root:

| Detected from                                                      | `setup`                                          | `verify`                                           | Toolchain added to the runtime Dockerfile |
| ------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- | ----------------------------------------- |
| `package.json` + `package-lock.json`                               | `npm ci`                                         | `npm test` (else `typecheck`, else `build` script) | none                                      |
| `package.json` without a lockfile                                  | `npm install --no-package-lock`                  | same                                               | none                                      |
| `pnpm-lock.yaml`                                                   | `pnpm install --frozen-lockfile`                 | `pnpm test`                                        | corepack                                  |
| `yarn.lock` (Yarn 1 / Yarn 2+)                                     | `yarn install --frozen-lockfile` / `--immutable` | `yarn test`                                        | none / corepack                           |
| `uv.lock`                                                          | `uv sync --frozen`                               | `uv run pytest`                                    | uv                                        |
| `poetry.lock`                                                      | `poetry install`                                 | `poetry run pytest`                                | uv, poetry                                |
| `requirements.txt`                                                 | venv in `$HOME/.venv` + `pip install -r`         | `"$HOME/.venv/bin/python" -m pytest`               | python                                    |
| `go.mod`                                                           | `go mod download`                                | `go test ./...`                                    | go                                        |
| `Cargo.toml`                                                       | `cargo fetch`                                    | `cargo test`                                       | rust                                      |
| `pom.xml` (with or without `mvnw`)                                 | none                                             | `./mvnw -B test` / `mvn -B test`                   | jdk (+ maven)                             |
| `build.gradle(.kts)` + `gradlew`                                   | none                                             | `./gradlew test`                                   | jdk                                       |
| `Makefile` with a `test:` target (only when nothing else verifies) | none                                             | `make test`                                        | none                                      |

Every matching ecosystem contributes, so a Node + Go repository gets both setup commands. Interactive setup shows the detected commands for confirmation. When a toolchain is missing from the base image and `runtime.dockerfile` is not set, setup offers to write `.codex-cage/Dockerfile` (`FROM` the configured `runtime.image`, with toolchains copied from official images such as `golang:1-bookworm`) and points `runtime.dockerfile` at it; an existing file at that path is kept. Pin the image tags in that file for reproducible runs. Virtualenvs and Cargo build output live under `$HOME` in the container so they never land in the pull request.

`agent.implement` and `agent.review` each pick a `provider` (`claude` or `codex`) and an optional `model` (default `claude-opus-5-5` for Claude, `gpt-5.4-mini` for Codex). A new config from `codex-cage setup` implements with Claude and reviews with Codex; non-interactive setup falls back to Codex for implementation when no Claude credential is found. A Codex login with a ChatGPT account cannot use `gpt-5.4-mini`, so when there is no `OPENAI_API_KEY`, setup takes the Codex model from the top-level `model` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). A config without these keys keeps the original behavior: Codex for both roles, with the legacy `agent.model` as the Codex model. `codex-cage run --model` overrides only the implementation model.

Codex review runs in Codex's read-only sandbox. Claude Code has no OS-level sandbox, so Claude implementation runs with permission prompts disabled inside the Docker sandbox, and a Claude review is limited to read-only tools (`Read`, `Grep`, `Glob`, read-only `git`); in both cases a review that changes the diff fails the run.

`runtime.image` accepts any valid Docker image reference and defaults to the Codex Cage GHCR base image. If `runtime.dockerfile` is set, Codex Cage builds a labeled per-run image before cloning the target repository. The first version uses `.codex-cage/` as the Docker build context, so target runtime Dockerfiles should keep package-install inputs inside that directory.

`actions.enabled` generates a managed issue workflow. Local execution remains Docker-based; the generated workflow sets `CODEX_CAGE_EXECUTION=direct` for the disposable Actions runner. Actions services and an optional job container are configured under `actions`, while local Compose services remain under `services`.

## Doctor

```bash
codex-cage doctor
codex-cage doctor --json
codex-cage doctor --probe
```

Doctor validates the shared config, Git repository, Docker daemon, local credentials, generated workflow, GitHub CLI authentication, issue labels, and required Actions secret names. Warnings describe optional local gaps; failed checks return a non-zero exit code.

`--probe` also makes one minimal call per configured agent, the way a run does: in `runtime.image`, with only that provider's credentials, read-only, with structured output. It takes a few seconds and a few tokens. It catches problems that a credential check that only looks at files misses: an expired or invalid token, a model the account cannot use, and an agent CLI in the image that is too old for the model. Roles that share a provider and model are probed once. Direct mode skips the probe, because agents run on the CI runner. Interactive `codex-cage setup` runs the probe at the end; `setup --yes` does not.

## Issue Readiness

```bash
codex-cage check <issue-url>
codex-cage check <issue-url> --json
```

`check` tells you whether an issue is ready to hand to `codex-cage run`. Run it before `run`; `run` itself does not repeat the check. It reads the issue body and:

- **fails** when an issue listed under a `## Blocked by` heading is still open, or cannot be looked up. References can be `#N` (same repository as the issue), `owner/repo#N`, or a full issue or pull request URL. A section that lists no references, such as `None - can start immediately`, passes.
- **warns** when the `## What to build` or `## Acceptance criteria` section is missing or empty. Warnings do not make the check fail.
- **fails** when `.codex-cage.yml` is missing or invalid.

`check` exits non-zero when the issue is not ready, so a script or agent can gate `run` on it: `codex-cage check <issue-url> && codex-cage run <issue-url>`. For Linear issues, `#N` references cannot be resolved to a repository; they are reported as warnings and not checked.

## Running Inside herdr

When `codex-cage run` starts inside a [herdr](https://herdr.dev) pane (`HERDR_ENV=1` and `HERDR_PANE_ID` set), it reports its progress to that pane. Outside herdr, nothing changes.

| Run event     | What herdr shows                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run started   | Agent `codex-cage` is `working`. The pane title is the issue, such as `#1 Add multiply()`.                                                                                        |
| Stage started | The line under the agent name in the agent list shows the stage: `prepare`, `implement 2/3`, `verify`, `review`, `publish`, or `implement try 2` after review sends the run back. |
| PR opened     | The state is `done`, and the agent list shows `PR opened`. A notification shows the PR URL.                                                                                       |
| Run failed    | The state is `blocked`, and the agent list shows the failure code, such as `verify_failed`. A notification asks for attention.                                                    |

herdr keeps this state only while `run` is running in the pane's foreground. Once the command exits, the pane returns to a plain shell. The same text is also stored as herdr state labels (`herdr pane get <pane-id>` shows `state_labels`) for tools that read pane state.

Another agent can wait for a run it started in a pane:

```bash
herdr agent wait <pane-id> --timeout 3600000
```

The result tells it how the run ended:

- `done`: the run opened a PR.
- `blocked`: the run failed. Read the pane or `codex-cage runs show <run-id>`.
- error `agent_not_running`: the run exited before it finished, for example because it crashed.

Status updates are best effort. If a `herdr` command fails, `run` prints one warning, stops sending updates, and continues.

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

### Failure Codes

| Code                                | Meaning                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `missing_config`, `invalid_config`  | `.codex-cage.yml` is missing or does not match the schema.                                                                      |
| `runtime_image_failed`              | Building `runtime.dockerfile` failed.                                                                                           |
| `docker_unavailable`                | The docker CLI is not on `PATH`, or the Docker daemon does not answer.                                                          |
| `clone_failed`                      | Cloning the repository or checking out the base branch failed: no access, an empty repository, or an unknown base branch.       |
| `setup_failed`                      | A `setup` command failed.                                                                                                       |
| `agent_auth_failed`                 | Claude Code or Codex rejected its credentials (HTTP 401/403). Renew the token in `~/.config/codex-cage/env` or the Codex login. |
| `agent_model_unavailable`           | The configured `agent.*.model` does not exist or is not available to this account.                                              |
| `implement_failed`, `review_failed` | The implementation or review agent failed for another reason, or the review output was not a valid report.                      |
| `verify_failed`                     | Verification still failed after `max_iterations`.                                                                               |
| `review_blocking`                   | The review still blocked after `max_review_cycles`, or the reviewer changed the diff.                                           |
| `secret_guard_failed`, `no_diff`    | The diff still contained a secret after `guards.max_secret_fix_attempts`, or was empty.                                         |
| `timeout`                           | A command exceeded `timeouts.command_minutes`, `idle_minutes`, or `total_minutes`.                                              |
| `pr_failed`                         | Pushing the branch or opening the pull request failed.                                                                          |
| `internal_error`                    | An unexpected error in Codex Cage itself. The run's `summary.md` holds the details.                                             |

## GitHub Actions Automation

The workflow generated by `codex-cage setup` turns an issue label into a direct-mode run. Adding the `codex-cage:run` label installs the exact configured Codex Cage npm version, runs it against that issue on the runner, and opens a PR on success.

**Label state machine.** The workflow drives four labels:

- `codex-cage:run` — the trigger. Removed as soon as the run starts.
- `codex-cage:in-progress` — added at start, removed at the end (success or failure).
- `codex-cage:blocked` — added on failure, together with a comment that carries the failure code, a link to the workflow run, and the run summary when present.
- `codex-cage:ready-for-review` — added after a pull request is created successfully.

Setup can create all four labels through GitHub CLI. The workflow normalizes stale state labels on every run and uploads the run artifacts and result JSON for debugging.

**Secrets.** Configure the agent secrets for the providers in `.codex-cage.yml`, plus the GitHub token:

- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — Claude Code auth, when a role uses Claude.
- `OPENAI_API_KEY` — Codex auth, when a role uses Codex.
- `CODEX_CAGE_GITHUB_TOKEN` — a fine-grained PAT or GitHub App installation token used for clone, push, PR creation, and label/comment updates.

Use `CODEX_CAGE_GITHUB_TOKEN` rather than the built-in `GITHUB_TOKEN`: events produced by the default token (opening a PR, adding a label) do not trigger further workflows, so any downstream automation (for example a future review workflow) would never fire. A PAT or App token is also required for the run to push branches and open PRs. The same token permissions as a local run apply (see [GitHub Token Permissions](#github-token-permissions)), plus **Issues: Read and write** for the label state machine.

**Services (db, redis, …).** The default workflow runs directly on `ubuntu-latest` and installs the configured agent CLIs, which is enough for repos whose `verify` needs no external services. For a repo that needs services, run the job inside the Codex Cage base image and declare service containers so they resolve by DNS name:

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    container: ghcr.io/jhowliu/codex-cage/base:0.1.2
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-retries 10
```

Inside a job container, service containers share a network and are reachable by service name (`postgres`, `redis`), matching the Compose DNS-name convention used in Docker mode. Actions service definitions live under `actions.services` and are rendered into the generated workflow; `services.compose` remains Docker-only.

## Prompt Instructions

Codex Cage relies on Codex CLI's native `AGENTS.md` handling for repository implementation guidance. It does not inject the contents of `AGENTS.md`, `.codex-cage/instructions.md`, `.github/copilot-instructions.md`, or `CLAUDE.md` into implementation or review prompts.

Independent review has an optional project policy file at `.codex-cage/review-policy.md`. The review policy may add stricter project-specific checks, but it cannot override Codex Cage built-in reviewer rules or weaken blocking criteria. Missing review policy files are allowed.

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
ghcr.io/jhowliu/codex-cage/base:0.1.2
```

The image is intentionally orchestration-only. It includes Node.js/npm, a pinned `@openai/codex` CLI, `git`, GitHub CLI `gh`, `curl`, `jq`, certificates, OpenSSH client, the non-root `agent` user, and `/workspace`. It does not include Docker CLI, Python, Go, Rust, Java, native build toolchains, database clients, browser tooling, `tini`, or a custom entrypoint.

Target repositories that need language runtimes or system packages should configure `runtime.dockerfile` in `.codex-cage.yml` and add those dependencies in `.codex-cage/Dockerfile`.

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
