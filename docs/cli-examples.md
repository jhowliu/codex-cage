# CLI Examples

Copy-pasteable examples for common `codex-cage` workflows. Replace placeholder owners, repos, issue IDs, and branches with real values from your target repository.

## Initialize A Repo

Run initialization from the target repository:

```bash
cd path/to/target-repo
codex-cage init
```

If the repo needs custom system packages in the agent image, also create the starter Dockerfile:

```bash
codex-cage init --dockerfile
```

Then update `.codex-cage.yml` with the repo's real setup and verification commands:

```yaml
setup:
  - npm ci

verify:
  - npm test
```

## Run A GitHub Issue

Use the positional issue URL form for GitHub issues:

```bash
codex-cage run https://github.com/acme/web-app/issues/123
```

GitHub issue URLs infer the target repository from the URL. The older `--issue <url>` option is still accepted for compatibility, but new commands should prefer `codex-cage run <issue-url>`.

## Run A Linear Issue

Pass the target GitHub repository with `--repo` when running a Linear issue:

```bash
codex-cage run https://linear.app/acme/issue/ENG-123/fix-login-timeout --repo acme/web-app
```

Linear issue URLs provide issue context, while `--repo OWNER/REPO` tells Codex Cage which GitHub repository to clone and publish back to.

## Override Model Or Base Branch

Override the Codex model for one run:

```bash
codex-cage run https://github.com/acme/web-app/issues/123 --model gpt-5.4
```

Run against a non-default base branch:

```bash
codex-cage run https://github.com/acme/web-app/issues/123 --base release/2026-04
```

Options can be combined:

```bash
codex-cage run https://github.com/acme/web-app/issues/123 --base develop --model gpt-5.4
```

## List And Show Runs

List local run records:

```bash
codex-cage runs list
```

Show details for one run:

```bash
codex-cage runs show 20260427-153012-acme-web-app-123
```

Run metadata is stored locally in `.codex-cage/codex-cage.sqlite`, with larger artifacts under `.codex-cage/runs/<run-id>`.

## Cleanup

Remove stopped managed Docker resources:

```bash
codex-cage cleanup
```

Remove all managed Docker resources, including active managed containers:

```bash
codex-cage cleanup --all
```

Cleanup does not delete local run artifacts or SQLite metadata.
