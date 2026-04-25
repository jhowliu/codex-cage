# CLI Examples

Common `codex-cage` CLI workflows are shown below with placeholder owners, repos, and issue IDs. Run these commands from the repository where Codex Cage is installed or available on `PATH`.

## Initialize A Repo

Create the default Codex Cage config in a target repository:

```bash
codex-cage init
```

Create the config plus a runtime Dockerfile for target repos that need extra system packages:

```bash
codex-cage init --dockerfile
```

After initialization, edit `.codex-cage.yml` so `setup` and `verify` match the target repository.

## Run A GitHub Issue

Use the positional issue URL form for GitHub issues:

```bash
codex-cage run https://github.com/acme/widgets/issues/123
```

GitHub issue URLs infer the target repository from the URL.

The legacy `--issue <url>` form is still accepted for compatibility:

```bash
codex-cage run --issue https://github.com/acme/widgets/issues/123
```

## Run A Linear Issue

Linear issue URLs provide task context, but the target GitHub repository must be resolved separately. Pass `--repo` explicitly when the current directory is not enough:

```bash
codex-cage run https://linear.app/acme/issue/ENG-123/fix-widget-loading --repo acme/widgets
```

## Override Model Or Base Branch

Override the configured Codex model for one run:

```bash
codex-cage run https://github.com/acme/widgets/issues/123 --model gpt-5.5
```

Override the configured base branch for one run:

```bash
codex-cage run https://github.com/acme/widgets/issues/123 --base release/2026-04
```

Use both overrides together:

```bash
codex-cage run https://github.com/acme/widgets/issues/123 --model gpt-5.5 --base release/2026-04
```

## List And Show Runs

List local run metadata:

```bash
codex-cage runs list
```

Show details for a specific run:

```bash
codex-cage runs show run_01hv7m3example
```

Run metadata is stored under `.codex-cage/` in the host repository.

## Cleanup

Remove stopped Codex Cage Docker resources plus inactive run networks and volumes:

```bash
codex-cage cleanup
```

Remove all Codex Cage managed Docker resources, including active managed containers:

```bash
codex-cage cleanup --all
```

Cleanup does not delete `.codex-cage/runs` artifacts or `.codex-cage/codex-cage.sqlite`.
