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
