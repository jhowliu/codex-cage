# Codex Cage

Codex Cage is a lightweight CLI for running Codex against issue-driven work in an isolated Docker workspace. The project is currently in early scaffold form: the CLI exists, `init` works, and the later run/orchestration commands are intentionally stubbed until their implementation slices land.

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
- `runs list`
- `runs show`

Other commands are routed and documented in help output, but return a not-implemented error.

## Initialize a Target Repo

```bash
codex-cage init
```

This creates:

- `.codex-cage.yml`
- `.codex-cage.env.example`
- `.gitignore` entries for local Codex Cage runtime state

Use `--dockerfile` when the target repo needs custom system packages:

```bash
codex-cage init --dockerfile
```

The generated verify command intentionally fails until replaced with the target repo's real test command.

## Inspect Local Runs

```bash
codex-cage runs list
codex-cage runs show <run-id>
```

Run metadata is stored in `.codex-cage/codex-cage.sqlite`. Large artifacts such as logs, patches, issue payloads, and summaries are stored under `.codex-cage/runs/<run-id>` rather than inside SQLite.

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
- An agent container using the pinned default image `codex-cage/base:0.1.0`

The sandbox runs as the non-root `agent` user, clones the target repo into the volume, and does not bind mount the host working tree, Docker socket, SSH config, GitHub CLI config, or host ports.

## Development

```bash
npm install
npm run typecheck
npm test
npm run format
```

If the default npm cache has local permission problems, use a temporary cache for package smoke checks:

```bash
npm --cache /tmp/codex-cage-npm-cache exec -- codex-cage --help
npm --cache /tmp/codex-cage-npm-cache pack --dry-run
```
