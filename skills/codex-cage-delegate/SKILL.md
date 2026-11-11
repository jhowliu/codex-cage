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

Ready issues run in parallel, each in a **fresh pane** with its own result file. `<n>` is the issue number:

```bash
mkdir -p .codex-cage/runs && rm -f .codex-cage/runs/delegate-<n>.json
```

The start command:

```bash
CODEX_CAGE_EXECUTION=docker codex-cage run <issue-url> --result-json .codex-cage/runs/delegate-<n>.json; echo "cage-exit=$?"
```

- `CODEX_CAGE_EXECUTION=docker` keeps the run in the Docker sandbox even when the config selects direct mode.
- The `cage-exit=` line marks the end of the run, including a crash.

### Inside herdr (`HERDR_ENV=1`)

Runs live in a background tab labelled `cage`, so the user's view stays where it is:

1. Find it: `herdr tab list --workspace "$HERDR_WORKSPACE_ID"` lists a tab with `"label":"cage"`.
2. If there is none, create it: `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label cage --cwd "$PWD" --no-focus`. Its `.result.root_pane.pane_id` takes the first run.
3. Every other run splits a pane of the cage tab: `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` shows each pane's `tab_id`. Then `herdr pane split <cage-pane> --direction right --cwd "$PWD" --no-focus`, alternating `right` and `down`. Use the new `.result.pane.pane_id`.
4. Start the run: `herdr pane run <pane> '<start command>'`. The single quotes leave `$?` for the pane's shell.

Splits stay inside the cage tab; the user's own panes keep their size. herdr's agent list shows each run's stage, so the user can follow along without switching tabs.

### Outside herdr

Run the start command as a background command, one per issue.

## 5. Wait and report

Inside herdr, wait on each pane:

```bash
herdr pane wait-output <pane> --regex 'cage-exit=[0-9]+' --timeout 7200000
```

This blocks until the run ends, so run it in the background if your harness can, and keep working with the user meanwhile. It also matches output already in the pane, so it is safe to call late or again after a context reset. Outside herdr, wait for the background command to exit.

Then read `.codex-cage/runs/delegate-<n>.json`:

| Result              | Report                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `status: succeeded` | The `prUrl`. The user reviews and merges it. Close the run's pane.                                                         |
| `status: failed`    | The `failureCode` and `codex-cage runs show <runId>`. Leave the pane open for the user.                                    |
| No file             | The run crashed. Report the error from `herdr pane read <pane> --source recent-unwrapped --lines 80`. Leave the pane open. |

Rerun a failed issue only after changing what made it fail, such as the issue body, the config, or a split into smaller issues, and always in a fresh pane.

Done when every started run has a reported result, and every waiting issue is listed with the blocker it waits on.
