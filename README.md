# Codex Cage

Codex Cage is a lightweight CLI for running Codex against issue-driven work in an isolated Docker workspace. The CLI can initialize target repos, run the issue-driven orchestration loop, inspect local run metadata, and clean up managed Docker resources.

Full setup, token, configuration, security, and QA details live in [docs/workflow.md](docs/workflow.md).

## Current Commands

```bash
codex-cage --help
codex-cage init
codex-cage init --dockerfile
codex-cage run --issue <url>
codex-cage runs list
codex-cage runs show <run-id>
codex-cage cleanup
```

Implemented commands:

- `init`
- `run`
- `runs list`
- `runs show`
- `cleanup`

## Initialize a Target Repo

```bash
codex-cage init
```

This creates:

- `.codex-cage.yml`
- `.codex-cage/instructions.md`
- `.codex-cage.env.example`
- `.gitignore` entries for local Codex Cage runtime state

Use `--dockerfile` when the target repo needs custom system packages:

```bash
codex-cage init --dockerfile
```

The generated verify command intentionally fails until replaced with the target repo's real test command.

Codex Cage includes root-level repository instruction files in implementation and review prompts when they exist: `AGENTS.md`, `.codex-cage/instructions.md`, `.github/copilot-instructions.md`, and `CLAUDE.md`. The injected instruction text is capped and saved as run artifacts with the rendered prompts.

## Inspect Local Runs

```bash
codex-cage runs list
codex-cage runs show <run-id>
```

Run metadata is stored in `.codex-cage/codex-cage.sqlite`. Large artifacts such as logs, patches, issue payloads, and summaries are stored under `.codex-cage/runs/<run-id>` rather than inside SQLite.

## Run an Issue

```bash
codex-cage run --issue https://github.com/OWNER/REPO/issues/123
```

The `run` command reads `.codex-cage.yml` and `.codex-cage.env`, fetches issue context, resolves the target repo, creates a Docker workspace, starts configured Compose services, runs Codex implementation iterations, verifies configured commands, scans the diff for secrets, runs independent review, and publishes a PR when all gates pass.

## Issue Context

Codex Cage supports GitHub and Linear issue URLs as normalized task context.

- GitHub issue URLs infer the target repo from the URL.
- Linear issue URLs infer the issue key from the URL, but the target repo must come from a later repo-resolution step.
- GitHub context uses `GITHUB_TOKEN` when provided.
- Linear context requires `LINEAR_API_KEY`.
- Empty comments and known bot comments are filtered out.
- The default issue context includes the last 10 human comments.

## Repository Resolution

Target repositories are resolved in this order:

1. Explicit `--repo`
2. GitHub issue URL inference
3. Current directory `git remote get-url origin`

If a GitHub issue URL points at a different repo than the current directory origin, Codex Cage fails unless `--repo` is passed explicitly. GitHub operations use HTTPS token auth with `GITHUB_TOKEN`; SSH remotes are normalized to `owner/repo` and converted to token-authenticated HTTPS clone URLs internally.

## Docker Sandbox

Codex Cage prepares disposable Docker resources per run:

- A labeled Docker volume for `/workspace`
- A labeled Docker network for run-local connectivity
- An agent container using the pinned default image `ghcr.io/jhowliu/codex-cage/base:0.1.1`

The sandbox runs as the non-root `agent` user, clones the target repo into the volume, and does not bind mount the host working tree, Docker socket, SSH config, GitHub CLI config, or host ports.

The publishable base image is defined in `docker/base` and published to GHCR as `ghcr.io/jhowliu/codex-cage/base:<version>`. The image contains only the orchestration tools needed by Codex Cage: Node.js/npm, pinned Codex CLI, `git`, `gh`, `curl`, `jq`, certificates, OpenSSH client, and the non-root `agent` user. Target repositories should add project-specific runtimes or build tools through their own `.codex-cage/Dockerfile`.

Runtime images are configured in `.codex-cage.yml`. If `runtime.dockerfile` is set, Codex Cage builds a labeled per-run image from that Dockerfile using `.codex-cage/` as the build context before cloning the target repository. If no Dockerfile is configured, Codex Cage uses `runtime.image`. Custom runtime images are trusted code: they define the environment that runs agent commands and should be reviewed and pinned like other supply-chain inputs. Codex Cage warns when `runtime.image` uses `latest` or omits both a tag and digest, but it still allows arbitrary image references.

## Compose Services

Target repos can configure Docker Compose services in `.codex-cage.yml`:

```yaml
services:
  compose: docker-compose.yml
  ready:
    - pg_isready -h db -U postgres
```

Codex Cage uses a per-run Compose project name, starts services with `docker compose up -d`, attaches the agent container to the Compose network, runs readiness checks from an ephemeral container on that network, and tears services down with `docker compose down -v`.

## Secret Guards

Local secrets live in `.codex-cage.env`, which is parsed by the orchestrator and passed to Docker as process environment, not mounted into the container or written into command arguments. Known secret values are redacted from logs.

Guard scanning checks diffs for injected secret values, high-confidence token patterns, private key material, and sensitive auth files such as `.env`, `.codex-cage.env`, `.npmrc`, `.ssh/*`, `.config/gh/*`, and `.aws/*`. Sample env files like `.env.example`, `.env.sample`, and `.env.template` are allowed, but their added content is still scanned for secret-looking values.

## Independent Review

After implementation verification passes, Codex Cage runs a fresh Codex review process by default. The reviewer receives issue context, the diff against base, result metadata, and the verification summary, and it must return structured JSON with a `pass` or `blocking` decision.

Review is read-only. If the diff changes during review, the run fails instead of publishing. Blocking findings are formatted as implementation feedback until `agent.max_review_cycles` is exhausted.

## Publishing

Successful runs are published by the orchestrator, not by the implementation or review agents. Codex Cage rejects empty diffs, creates a run-specific branch, configures the Codex Cage git author, commits once, pushes without force, and creates a ready GitHub PR by default.

PR bodies include the summary, verification, review status, risks, run id, and issue linkage. GitHub issues use closing keywords such as `Closes #123`; Linear issues are linked without mutating Linear.

## Cleanup

```bash
codex-cage cleanup
codex-cage cleanup --all
```

Cleanup removes Docker resources labeled as managed by Codex Cage. By default it removes stopped containers plus networks and volumes for runs without active managed containers. `--all` also removes active managed containers and their networks and volumes. Cleanup never deletes `.codex-cage/runs` artifacts or the SQLite database.

## Development

```bash
npm install
npm run typecheck
npm test
npm run qa
npm run qa:image
npm run format
```

If the default npm cache has local permission problems, use a temporary cache for package smoke checks:

```bash
npm --cache /tmp/codex-cage-npm-cache exec -- codex-cage --help
npm --cache /tmp/codex-cage-npm-cache pack --dry-run
```
