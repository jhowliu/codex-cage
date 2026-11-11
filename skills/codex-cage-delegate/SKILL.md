---
name: codex-cage-delegate
description: Delegate work to codex-cage runs. Split a feature into GitHub issues, check each one, start a run per ready issue, and report its PR or failure. Use when the user wants work handed to codex-cage, a feature split into delegatable issues, or existing issues run with codex-cage.
---

# codex-cage delegate

You are the **planner**. You turn the user's request into GitHub issues that codex-cage can implement without asking anyone, start one run per ready issue, and report each run's PR or failure. codex-cage implements, verifies, reviews and opens the PR inside its Docker sandbox. Your edits go into issues, not into the target repository.

Work from the target repository's checkout. `codex-cage check` and `codex-cage run` read `.codex-cage.yml` from the current directory and keep run artifacts under `.codex-cage/runs/`.

## 1. Size the request

| Size | Looks like                                                       | Intake                                                                                  |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S    | One task; the change and how to verify it are clear              | No questions.                                                                           |
| M    | A few tasks, or one task with open choices                       | One round of at most 5 questions, each with your proposed default.                      |
| L    | A feature across modules, or a new interface, data model, or API | Grill the user until every one-way door is decided. Use a grilling skill if one exists. |

Ask only about **one-way doors**: public interfaces, data formats and migrations, new dependencies, security boundaries. Decide two-way doors yourself and write them into the issue as defaults.

Done when every one-way door in the request has the user's decision.

## 2. Write the issues

Make each issue a **vertical slice** one run can finish: one PR that the repository's `verify` commands can prove. The body has exactly these three sections:

```markdown
## What to build

<The change, in the repository's own terms.>

- <Each default you chose, as a bullet.>

## Acceptance criteria

- [ ] <An observable outcome a test or command can show.>

## Blocked by

- #<issue number>, or: None - can start immediately
```

- Keep each issue to its task. Write new scope you notice as its own follow-up issue.
- A task that needs a person, such as visual judgement, credentials, production access, or a change no command can verify, is not delegatable. Create its issue, leave it out of the runs, and tell the user.

Create blockers first, so later issues can reference their numbers:

```bash
gh issue create --repo <owner/repo> --title "<title>" --body-file <file>
```

Done when every task has an issue URL and you have shown the user the list.

## 3. Check each issue

```bash
codex-cage check <issue-url> --json
```

- `ready: true` with no warnings: start the run.
- A warning about a missing or empty section: fix the issue body, then check again.
- `ready: false` because a `Blocked by` issue is open: the issue **waits**. A run's PR closes its issue when merged, so check the waiting issues again after the user merges a blocker's PR.
- `ready: false` for any other reason, such as config or a blocker that cannot be looked up: report it to the user.

Done when every issue is started, waiting, or reported.

## 4. Start a run per ready issue

Ready issues run in parallel, each as its own background command with its own result file. `<n>` is the issue number:

```bash
mkdir -p .codex-cage/runs && rm -f .codex-cage/runs/delegate-<n>.json
CODEX_CAGE_EXECUTION=docker codex-cage run <issue-url> --result-json .codex-cage/runs/delegate-<n>.json
```

`CODEX_CAGE_EXECUTION=docker` keeps the run in the Docker sandbox even when the config selects direct mode. Keep working with the user while the runs go.

## 5. Wait and report

When a run's command exits, read `.codex-cage/runs/delegate-<n>.json`:

| Result              | Report                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `status: succeeded` | The `prUrl`. The user reviews and merges it.                                            |
| `status: failed`    | The `failureCode` and `codex-cage runs show <runId>`.                                   |
| No file             | The run crashed before writing its result. Report the last lines of the command output. |

Rerun a failed issue only after changing what made it fail, such as the issue body, the config, or a split into smaller issues.

Done when every started run has a reported result, and every waiting issue is listed with the blocker it waits on.
