# Revise an agent-cage pull request

The user wants changes to an open PR that an agent-cage run opened: review threads or comments on it, or changes they describe to you. `agent-cage revise` makes them on the PR's branch with the same implement, verify and review loop, pushes one new commit, rewrites the description, and comments with the feedback it addressed. It reads the PR's feedback itself: every unresolved review thread, and the comments and reviews since the last revise, from people with write access. Your job is to pick the path for each piece of feedback, settle its one-way doors, and pass on what only this conversation holds.

## 1. Pick the path

Read the PR, its conversation, and its inline review comments:

```bash
gh pr view <pr-url> --comments
gh api 'repos/{owner}/{repo}/pulls/<n>/comments' --jq '.[] | {path, line: (.line // .original_line), user: .user.login, body}'
```

The inline comments include resolved threads, which revise skips.

| The feedback asks for                                                                | Path                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A change within the issue: a bug, a missed case, a rename, tests, different behavior | Revise.                                                                                       |
| Work beyond the issue                                                                | A follow-up issue through the main steps 2 to 5. Revise only the part within the issue.       |
| A different approach that replaces most of the PR                                    | Rewrite the issue with the decision and run it again. Tell the user the old PR can be closed. |
| Changes to a merged or closed PR                                                     | A follow-up issue.                                                                            |

A revise follows the feedback where it conflicts with the issue, so the agent decides any **one-way door** left in a reviewer's comment: a public interface, a data format or migration, a new dependency, a security boundary. Ask the user about each one, unless the user wrote that feedback.

Done when every piece of feedback has a path and every one-way door in it has the user's decision.

## 2. Revise

Run it in the background, as for runs. `<n>` is the PR number:

```bash
mkdir -p .agent-cage/runs && rm -f .agent-cage/runs/planner-pr-<n>.json
AGENT_CAGE_EXECUTION=docker agent-cage revise <pr-url> --feedback "<what only this conversation holds>" --result-json .agent-cage/runs/planner-pr-<n>.json
```

`--feedback` carries what the PR does not: the user's requests in this conversation, their one-way-door decisions, and the threads routed elsewhere, such as "Leave the caching thread to #42." Leave out what the PR already says, and leave the option out when the PR says it all.

Start one revise per PR at a time: a second one fails to push.

## 3. Report

When the command exits, read `.agent-cage/runs/planner-pr-<n>.json`:

| Result                          | Report                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status: succeeded`             | The `prUrl`. Ask the user to resolve the review threads the new commit settles: the next revise reads every unresolved thread again.               |
| `failureCode: no_feedback`      | The PR holds nothing to address. Ask the user what to change, then revise with `--feedback`.                                                       |
| `failureCode: pr_not_revisable` | The PR is closed, comes from a fork, or was not opened by agent-cage. Write a follow-up issue for a closed PR, and tell the user about the others. |
| `failureCode: pr_failed`        | Pushing or updating the PR failed, often because someone pushed to its branch during the run. Revise again once the branch is quiet.               |
| Any other `failureCode`         | The `failureCode` and `agent-cage runs show <runId>`, as for runs.                                                                                 |
| No file                         | The revise crashed before writing its result. Report the last lines of the command output.                                                         |

Done when every revise has a reported result and every follow-up issue is listed.
