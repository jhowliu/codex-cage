---
name: agent-cage-planner
description: Delegate work to agent-cage runs. Split a feature into GitHub issues, check each one, start a run per ready issue, and report its PR or failure. Use when the user wants work handed to agent-cage, a feature split into delegatable issues, existing issues run with agent-cage, or an agent-cage PR revised from its review feedback.
---

# agent-cage planner

You are the **planner**. You turn the user's request into GitHub issues that agent-cage can implement without asking anyone, start one run per ready issue, and report each run's PR or failure. agent-cage implements, verifies, reviews and opens the PR inside its Docker sandbox. Your edits go into issues, not into the target repository.

Work from the target repository's checkout. `agent-cage check`, `agent-cage run` and `agent-cage revise` read `.agent-cage.yml` from the current directory and keep run artifacts under `.agent-cage/runs/`.

To change an open PR that an agent-cage run opened, such as to address its review feedback, follow [REVISE.md](REVISE.md) instead of the steps below.

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
- Issues that will change the same file conflict when they run at the same time. Chain them: list the earlier issue under the later one's `## Blocked by`, so the later run starts from the merged change. Small tasks in the same file, such as a few one-line functions, can be one issue instead.
- A task that needs a person, such as visual judgement, credentials, production access, or a change no command can verify, is not delegatable. Create its issue, leave it out of the runs, and tell the user.

Create blockers first, so later issues can reference their numbers:

```bash
gh issue create --repo <owner/repo> --title "<title>" --body-file <file>
```

Done when every task has an issue URL and you have shown the user the list.

## 3. Check each issue

```bash
agent-cage check <issue-url> --json
```

- `ready: true` with no warnings: start the run.
- A warning about a missing or empty section: fix the issue body, then check again.
- `ready: false` because a `Blocked by` issue is open: the issue **waits**. A run's PR closes its issue when merged, so check the waiting issues again after the user merges a blocker's PR.
- `ready: false` for any other reason, such as config or a blocker that cannot be looked up: report it to the user.

Done when every issue is started, waiting, or reported.

## 4. Start a run per ready issue

Ready issues run in parallel, each as its own background command with its own result file. `<n>` is the issue number:

```bash
mkdir -p .agent-cage/runs && rm -f .agent-cage/runs/planner-<n>.json
AGENT_CAGE_EXECUTION=docker agent-cage run <issue-url> --result-json .agent-cage/runs/planner-<n>.json
```

`AGENT_CAGE_EXECUTION=docker` keeps the run in the Docker sandbox even when the config selects direct mode. Keep working with the user while the runs go.

## 5. Wait and report

When a run's command exits, read `.agent-cage/runs/planner-<n>.json`:

| Result              | Report                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `status: succeeded` | The `prUrl`. The user reviews and merges it, or asks for changes: see [REVISE.md](REVISE.md). |
| `status: failed`    | The `failureCode` and `agent-cage runs show <runId>`.                                         |
| No file             | The run crashed before writing its result. Report the last lines of the command output.       |

Rerun a failed issue only after changing what made it fail, such as the issue body, the config, or a split into smaller issues.

Done when every started run has a reported result, and every waiting issue is listed with the blocker it waits on.
