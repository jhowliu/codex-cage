# Agent Cage

Agent Cage is a lightweight CLI for running Codex against issue-driven work in an isolated Docker workspace. The CLI configures target repos, runs the issue-driven orchestration loop, inspects local run metadata, and cleans up managed Docker resources.

Full setup, token, configuration, security, and QA details live in [docs/workflow.md](docs/workflow.md).

## Demo

https://github.com/user-attachments/assets/66e43421-9aa6-4024-8f82-6f0e9d385d6f

## Install

Requirements:

- Node.js `>=22.13` (for the built-in `node:sqlite` run store)
- Docker
- Git
- Auth for the configured agents: Claude Code (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`) and Codex (`OPENAI_API_KEY` or host Codex OAuth)
- GitHub auth for issue lookup, clone, push, and PR creation: `GITHUB_TOKEN`, or a signed-in GitHub CLI (`gh auth login`)

From this repository:

```bash
npm install
npm run build
npm install -g .
agent-cage --help
```

For a one-off local invocation without global install:

```bash
npm install
npm run build
npm exec -- agent-cage --help
```

## Run Agent Cage

Run the guided setup inside the target repository:

```bash
agent-cage setup
```

Agent Cage detects setup and verification commands for Node (npm, pnpm, Yarn), Python (uv, Poetry, `requirements.txt`), Go, Rust, and Java (Maven, Gradle wrapper) projects, falling back to a Makefile `test` target, plus the base branch. When the project needs a toolchain the base image lacks (Python, Go, Rust, a JDK, or corepack for pnpm/Yarn 2+), setup offers to generate `.agent-cage/Dockerfile` that adds it and sets `runtime.dockerfile`. It configures local Docker runs and can optionally generate GitHub Actions automation. Re-run the same command whenever settings need to change.

For a non-interactive setup using detected defaults:

```bash
agent-cage setup --yes --actions on
```

The resulting `.agent-cage.yml` remains the single configuration source:

```yaml
setup:
  - npm ci

verify:
  - npm test

agent:
  implement:
    provider: claude # or codex
  review:
    provider: codex # or claude
```

New configs implement with Claude Code and review with Codex. Configs without `agent.implement`/`agent.review` keep using Codex for both.

The wizard writes credentials with restricted permissions: agent credentials go to `~/.config/agent-cage/env` once per machine, and GitHub credentials go to the repo's `.agent-cage.env`. You can also create them manually:

```dotenv
# ~/.config/agent-cage/env
CLAUDE_CODE_OAUTH_TOKEN=...
OPENAI_API_KEY=...
LINEAR_API_KEY=...
```

```dotenv
# .agent-cage.env in the target repo: either a token...
GITHUB_TOKEN=...
# ...or the gh account to take a token from (`gh auth token --user`)
AGENT_CAGE_GH_USER=your-login
```

With several `gh` accounts signed in, setup asks which one this repo uses and saves it as `AGENT_CAGE_GH_USER`.

Run a GitHub issue:

```bash
agent-cage run https://github.com/OWNER/REPO/issues/123
```

Run a Linear issue by passing the target GitHub repo:

```bash
agent-cage run https://linear.app/ORG/issue/ENG-123/title --repo OWNER/REPO
```

Revise a PR that a run opened, from its review threads and comments:

```bash
agent-cage revise https://github.com/OWNER/REPO/pull/45
```

Inspect local run state:

```bash
agent-cage runs list
agent-cage runs show <run-id>
```

To have an agent split a feature into issues and run each one, install the [`agent-cage-planner` skill](docs/workflow.md#delegating-from-an-agent).

## Command Reference

Use `agent-cage --help` or `agent-cage <command> --help` for the current CLI help.

| Command                         | Purpose                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `agent-cage setup`              | Configure local Docker runs and optional GitHub Actions automation.                                             |
| `agent-cage doctor`             | Diagnose local tools, credentials, workflow, labels, and Actions secrets; `--probe` also test-calls each agent. |
| `agent-cage check <issue-url>`  | Check whether an issue is ready to run: its `## Blocked by` issues are closed and the config is valid.          |
| `agent-cage run <issue-url>`    | Run the full issue-to-PR workflow for a GitHub or Linear issue.                                                 |
| `agent-cage revise <pr-url>`    | Revise an open PR that Agent Cage opened, from its feedback; `--feedback` adds instructions.                    |
| `agent-cage runs list`          | List locally recorded runs from `.agent-cage/agent-cage.sqlite`; `--json` for tools.                            |
| `agent-cage runs show <run-id>` | Show run metadata, phase status, and artifact paths.                                                            |
| `agent-cage cleanup`            | Remove stale stopped Docker resources managed by Agent Cage.                                                    |
| `agent-cage cleanup --all`      | Remove all managed Docker resources, including active ones.                                                     |

### Configure a Target Repo

```bash
agent-cage setup
```

Setup creates only the files required by the selected configuration:

- `.agent-cage.yml`
- `.agent-cage/review-policy.md` when missing
- `.agent-cage.env.example` when missing (missing keys are merged into an existing file)
- `.gitignore` entries for local Agent Cage runtime state
- `.agent-cage.env` when local credentials are entered
- `.github/workflows/agent-cage.yml` when Actions automation is enabled

Useful automation options:

```bash
agent-cage setup --yes --actions on
agent-cage setup --yes --actions off
agent-cage setup --dry-run
```

Setup is safe to re-run. It preserves comments and unknown top-level configuration, updates only managed settings, and refuses to overwrite a workflow it did not generate. Disabling Actions removes only the generated workflow; repository labels and secrets remain untouched.

Agent Cage relies on Codex CLI's native `AGENTS.md` handling for repository implementation guidance. It does not inject `AGENTS.md`, `.agent-cage/instructions.md`, `.github/copilot-instructions.md`, or `CLAUDE.md` contents into prompts. Independent review can use `.agent-cage/review-policy.md` for stricter project-specific checks; prompt artifacts record only whether that policy file is present and where the reviewer can read it.

Run diagnostics at any time:

```bash
agent-cage doctor
agent-cage doctor --json
```

### Run an Issue

```bash
agent-cage run https://github.com/OWNER/REPO/issues/123
```

Common options:

- `--repo OWNER/REPO`: override target repo resolution, commonly needed for Linear issues.
- `--base <branch>`: override the base branch from config.
- `--model <model>`: override the Codex model for this run.
- `--draft`: create a draft GitHub PR.

The `run` command reads `.agent-cage.yml` and `.agent-cage.env`, fetches issue context, resolves the target repo, creates a Docker workspace, starts configured Compose services, runs Codex implementation iterations, verifies configured commands, scans the diff for secrets, runs independent review, and publishes a PR when all gates pass.

### Revise a Pull Request

```bash
agent-cage revise https://github.com/OWNER/REPO/pull/45 --feedback "Keep the old flag working."
```

`revise` takes an open PR that an Agent Cage run opened, in the same repository, and addresses its feedback: every unresolved review thread, the comments and reviews posted since the last revise, and `--feedback`. It runs the same implement, verify, and review loop on the PR's branch, with the review reading the whole PR against its base. It then pushes one new commit without force, replaces the PR description with the review's, and comments with the feedback it addressed. It leaves review threads unresolved; resolve the ones the commit settles, since the next revise reads every unresolved thread again.

Options: `--feedback <text>`, `--model <model>`, `--run-id <id>`, `--result-json <path>`, and `--verbose`, as for `run`. A PR without a Run ID in its description, from a fork, or closed fails with `pr_not_revisable`; a PR with nothing to address fails with `no_feedback`.

### Inspect Local Runs

```bash
agent-cage runs list
agent-cage runs show <run-id>
```

Run metadata is stored in `.agent-cage/agent-cage.sqlite` (SQLite in WAL mode, so several runs in the same repository can write at once and `runs list` reads without blocking them). Large artifacts such as logs, patches, issue payloads, prompt context, and summaries are stored under `.agent-cage/runs/<run-id>` rather than inside SQLite.

Tools that track runs, such as an editor or terminal panel, read `agent-cage runs list --json`. It prints every run newest first with its `issueUrl`, `status`, `failureCode`, `prUrl`, and `interrupted`. `interrupted` is `true` when the run never finished and its process is gone, such as after a crash or a closed terminal. `runs list` shows such a run as `<status> interrupted`.

## Design Architecture

Agent Cage is organized as a host-side orchestrator around disposable Docker workspaces. The host CLI owns configuration, issue lookup, repository resolution, Docker resource lifecycle, credential scoping, run state, verification, review, and publishing. Implementation and review agents run inside the sandbox with only the credentials and filesystem access required for their phase.

Host preparation:

```mermaid
sequenceDiagram
  actor User
  participant CLI
  participant Run as Orchestrator
  participant Issue as Issue provider
  participant Repo as Target repo
  participant State as State/artifacts

  User->>CLI: agent-cage run <issue-url>
  CLI->>Run: Load config and local env
  Run->>Issue: Fetch issue context
  Issue-->>Run: Normalized issue payload
  Run->>Repo: Resolve repo and base branch
  Repo-->>Run: Clone URL and base ref
  Run->>State: Create run record and artifact directory
```

Sandbox execution:

```mermaid
sequenceDiagram
  participant Run as Orchestrator
  participant Docker as Docker sandbox
  participant Agent as Implementation agent

  Run->>Docker: Build/select runtime image
  Run->>Docker: Create volume, network, and container
  Docker-->>Run: Workspace ready
  opt Compose services configured
    Run->>Docker: Start services and readiness checks
  end
  Run->>Docker: Run setup commands
  loop Implementation iterations
    Run->>Agent: Execute implementation prompt
    Agent->>Docker: Edit /workspace
    Run->>Docker: Run verification commands
    Docker-->>Run: Verification result
  end
```

Gates and publish:

```mermaid
sequenceDiagram
  participant Run as Orchestrator
  participant Guard as Secret guards
  participant Review as Review agent
  participant GitHub
  participant State as State/artifacts

  Run->>Guard: Scan diff
  alt Guard fails
    Run->>State: Record guard_failed or retry implementation
  else Guard passes
    Run->>Review: Run read-only structured review
    alt Review blocks
      Run->>State: Record review_failed or retry implementation
    else Review passes
      Run->>GitHub: Commit, push, and create PR
      GitHub-->>Run: PR URL
      Run->>State: Record success metadata
    end
  end
```

The main runtime flow is:

1. Load `.agent-cage.yml` and `.agent-cage.env`.
2. Fetch issue context from GitHub or Linear.
3. Resolve the target repository and base branch.
4. Create a run record, artifact directory, Docker volume, and Docker network.
5. Build or select the runtime image.
6. Clone the target repo into the Docker workspace.
7. Start configured Compose services and run setup commands.
8. Run Codex implementation iterations.
9. Run configured verification commands.
10. Scan the diff for secret leaks and protected files.
11. Run independent read-only Codex review.
12. Commit, push, and create a GitHub PR only after all gates pass.

Module responsibilities:

- `src/cli.ts` and `src/commands.ts`: command-line parsing, user-facing output, and command dispatch.
- `src/config.ts`: `.agent-cage.yml` schema, defaults, validation, and warnings.
- `src/issue.ts` and `src/repo.ts`: issue-provider normalization and repository resolution.
- `src/run.ts`: top-level orchestration loop and phase transitions.
- `src/docker.ts` and `src/compose.ts`: Docker sandbox, runtime image, command execution, and Compose lifecycle.
- `src/credentials.ts`: credential classification and phase-scoped command options.
- `src/state.ts`: SQLite run metadata plus filesystem artifact paths.
- `src/prompt-context.ts` and `src/review.ts`: prompt artifacts, review policy discovery, structured review execution, and review parsing.
- `src/guards.ts`: diff and secret guard checks before publish.
- `src/publish.ts`: branch, commit, push, and pull request creation.
- `src/setup.ts`: target-repo bootstrap files, local secrets, and managed GitHub Actions workflow.

Architectural boundaries:

- Keep host orchestration separate from sandbox execution. The target repo is cloned into a Docker volume; the host working tree is not bind-mounted into the agent container.
- Keep credentials phase-scoped. Setup and verify should not receive Codex, OpenAI, or GitHub credentials by default; implementation and review receive only Codex auth; publish receives only GitHub auth.
- Treat issue bodies, comments, target repo files, and command output as untrusted input. Validate structured data at boundaries and redact known secret values before writing logs.
- Keep publishing host-owned. Implementation and review agents must not commit, push, or create PRs.
- Store small run metadata in SQLite and large artifacts as files under `.agent-cage/runs/<run-id>`.

## Issue Context

Agent Cage supports GitHub and Linear issue URLs as normalized task context.

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

If a GitHub issue URL points at a different repo than the current directory origin, Agent Cage fails unless `--repo` is passed explicitly. GitHub operations use HTTPS token auth with `GITHUB_TOKEN`; SSH remotes are normalized to `owner/repo` and converted to token-authenticated HTTPS clone URLs internally.

## Docker Sandbox

Agent Cage prepares disposable Docker resources per run:

- A labeled Docker volume for `/workspace`
- A labeled Docker network for run-local connectivity
- An agent container using the pinned default image `ghcr.io/jhowliu/agent-cage/base:0.1.2`

The sandbox runs as the non-root `agent` user, clones the target repo into the volume, and does not bind mount the host working tree, Docker socket, SSH config, GitHub CLI config, or host ports.

The publishable base image is defined in `docker/base` and published to GHCR as `ghcr.io/jhowliu/agent-cage/base:<version>`. The image contains only the orchestration tools needed by Agent Cage: Node.js/npm, pinned Codex CLI, `git`, `gh`, `curl`, `jq`, certificates, OpenSSH client, and the non-root `agent` user. Target repositories should add project-specific runtimes or build tools through their own `.agent-cage/Dockerfile`.

Runtime images are configured in `.agent-cage.yml`. If `runtime.dockerfile` is set, Agent Cage builds a labeled per-run image from that Dockerfile using `.agent-cage/` as the build context before cloning the target repository. If no Dockerfile is configured, Agent Cage uses `runtime.image`.

## Compose Services

Target repos can configure Docker Compose services in `.agent-cage.yml`:

```yaml
setup:
  - npm ci
  - cp .agent-cage/test.env .env
  - npm run migrate --workspace=server

verify:
  - npm run test --workspace=server

services:
  compose: .agent-cage/docker-compose.yml
  ready:
    - pg_isready -h postgres -U postgres
```

Agent Cage uses a per-run Compose project name, starts services with `docker compose up -d`, attaches the agent container to the Compose network, runs readiness checks from an ephemeral container on that network, and tears services down with `docker compose down -v`.

Compose is host-orchestrated by Agent Cage. Do not mount `/var/run/docker.sock` into the agent container or expect the agent to run Docker itself. Agent commands should reach dependencies through Compose service DNS names such as `postgres`, `redis`, or `minio`; avoid publishing host ports unless the target repo has a specific reason.

For target repo test environment files, prefer a committed non-secret fixture such as `.agent-cage/test.env` and copy it to `.env` during `setup`. That keeps generated `.env` files local while making test credentials and service hostnames easy to review. Do not commit real secrets in these fixture files.

## Secret Guards

Local secrets live in `.agent-cage.env`, which is parsed by the orchestrator and passed to Docker as process environment, not mounted into the container or written into command arguments. Known secret values are redacted from logs.

Guard scanning checks diffs for injected secret values, high-confidence token patterns, private key material, and sensitive auth files such as `.env`, `.agent-cage.env`, `.npmrc`, `.ssh/*`, `.config/gh/*`, and `.aws/*`. Sample env files like `.env.example`, `.env.sample`, and `.env.template` are allowed, but their added content is still scanned for secret-looking values.

## Independent Review

After implementation verification passes, Agent Cage runs a fresh Codex review process by default. The reviewer receives issue context, the diff against base, result metadata, and the verification summary, and it must return structured JSON with a `pass` or `blocking` decision.

Review is read-only. If the diff changes during review, the run fails instead of publishing. Blocking findings are formatted as implementation feedback until `agent.max_review_cycles` is exhausted.

## Publishing

Successful runs are published by the orchestrator, not by the implementation or review agents. Agent Cage rejects empty diffs, creates a run-specific branch, configures the Agent Cage git author, commits once, pushes without force, and creates a ready GitHub PR by default.

A passing review writes the PR description. It follows the pull request rules in the `AGENTS.md` and `CLAUDE.md` files that apply to the changed paths, so put rules such as required PR sections there. Agent Cage appends the verification, review status, risks, run id, and issue linkage after it. If the review leaves the description out, the PR opens with a one-line summary instead. GitHub issues use closing keywords such as `Closes #123`; Linear issues are linked without mutating Linear.

## Cleanup

Use cleanup to remove Docker resources with Agent Cage labels. It never deletes local run artifacts or the SQLite database.

```bash
agent-cage cleanup
agent-cage cleanup --all
```

- `agent-cage cleanup` removes stopped containers plus networks and volumes for runs without active managed containers.
- `agent-cage cleanup --all` also removes active managed containers and their networks and volumes.

## Development

| Command             | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `npm install`       | Install project dependencies.               |
| `npm run typecheck` | Run TypeScript without emitting files.      |
| `npm test`          | Build and run the Node test suite.          |
| `npm run qa`        | Run the focused QA harness.                 |
| `npm run qa:image`  | Build and smoke-test the base Docker image. |
| `npm run format`    | Check repository formatting with Prettier.  |

If the default npm cache has local permission problems, use a temporary cache for package smoke checks:

```bash
npm --cache /tmp/agent-cage-npm-cache exec -- agent-cage --help
npm --cache /tmp/agent-cage-npm-cache pack --dry-run
```

## License

Agent Cage is licensed under the [Apache License 2.0](LICENSE).
