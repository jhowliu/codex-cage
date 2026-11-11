import { execa } from "execa";
import type { RunEvent, RunEventSink } from "./run/events.js";

/**
 * Reports a run's progress to the herdr pane it runs in: the pane title, the
 * current stage under the agent name, a final agent state, and a
 * notification.
 *
 * herdr keeps a reported agent state only while a program runs in the
 * pane's foreground, which `codex-cage run` does until it exits. The final
 * state maps to what `herdr agent wait <pane>` returns:
 * - `done`: the run opened a PR.
 * - `blocked`: the run failed and needs a person.
 * - error `agent_not_running`: the run exited before it finished, for
 *   example because it crashed.
 */

const herdrSource = "codex-cage";
const herdrAgentLabel = "codex-cage";
const herdrCommandTimeoutMs = 2_000;
const maxTitleLength = 80;

export type HerdrPane = { paneId: string };

/** Runs one herdr CLI command; `args` excludes the leading `herdr`. */
export type HerdrCommandRunner = (args: readonly string[]) => Promise<void>;

type ReportedState = "working" | "idle" | "blocked";
type LabelledState = ReportedState | "done";

export type HerdrUpdate =
  | { kind: "agent"; state: ReportedState; message: string }
  | {
      kind: "metadata";
      title: string;
      /** Shown under the agent name in herdr's agent list. */
      displayAgent: string;
      /** Not shown in the herdr 0.9.5 sidebar; readable through `pane get`. */
      labels: Partial<Record<LabelledState, string>>;
    }
  | { kind: "notification"; title: string; body: string; sound: "done" | "request" };

/** The herdr pane this process runs in, or null when it is not inside herdr. */
export function herdrPaneFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HerdrPane | null {
  const paneId = env.HERDR_PANE_ID?.trim() ?? "";
  return env.HERDR_ENV === "1" && paneId !== "" ? { paneId } : null;
}

export type HerdrRunEventSinkOptions = {
  pane: HerdrPane;
  runCommand?: HerdrCommandRunner;
  /** Milliseconds since the epoch; herdr orders reports by `--seq`. */
  now?: () => number;
  warn?: (message: string) => void;
};

/**
 * Creates a run event sink that mirrors the run into herdr. Status updates
 * are best effort: the first failed herdr command prints one warning and
 * turns the sink off, and the run continues.
 */
export function createHerdrRunEventSink(options: HerdrRunEventSinkOptions): RunEventSink {
  const runCommand = options.runCommand ?? runHerdrCommand;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const tracker = new HerdrRunTracker();
  let lastSequence = 0n;
  let disabled = false;

  const nextSequence = (): bigint => {
    const candidate = BigInt(now()) * 1_000_000n;
    lastSequence = candidate > lastSequence ? candidate : lastSequence + 1n;
    return lastSequence;
  };

  return async (event) => {
    if (disabled) {
      return;
    }

    for (const update of tracker.updatesFor(event)) {
      try {
        await runCommand(herdrCommandArgs(update, options.pane, nextSequence));
      } catch (error) {
        disabled = true;
        warn(
          `herdr status updates are off for this run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }
  };
}

/**
 * Turns run events into herdr updates. It remembers the issue from
 * `run.started`, because later events do not repeat it.
 */
export class HerdrRunTracker {
  #title = "codex-cage";
  #issueKey = "";

  updatesFor(event: RunEvent): HerdrUpdate[] {
    switch (event.type) {
      case "run.started":
        this.#issueKey = event.payload.issueKey;
        this.#title = truncate(
          `${event.payload.issueKey} ${event.payload.issueTitle}`,
          maxTitleLength,
        );
        // Report the agent first: herdr attaches metadata to a reported agent.
        return [
          { kind: "agent", state: "working", message: `run ${event.runId}` },
          { kind: "metadata", title: this.#title, displayAgent: "starting", labels: {} },
        ];
      case "stage.started":
        return [
          this.#working(
            event.stageAttempt > 1
              ? `${event.stage} try ${event.stageAttempt}`
              : event.stage,
          ),
        ];
      case "implementation.iteration_started":
        return [
          this.#working(
            `implement ${event.payload.iteration}/${event.payload.maxIterations}`,
          ),
        ];
      case "run.finished":
        if (event.payload.status === "succeeded") {
          return this.#finished({
            state: "idle",
            label: "PR opened",
            displayAgent: "PR opened",
            detail: event.payload.prUrl,
            sound: "done",
          });
        }

        return this.#finished({
          state: "blocked",
          label: `failed: ${event.payload.failureCode}`,
          // The blocked icon already says "failed"; the sidebar fits about
          // 17 characters, so show only the failure code there.
          displayAgent: event.payload.failureCode,
          detail: `Inspect it with: codex-cage runs show ${event.runId}`,
          sound: "request",
        });
      default:
        return [];
    }
  }

  #working(label: string): HerdrUpdate {
    return {
      kind: "metadata",
      title: this.#title,
      displayAgent: label,
      labels: { working: label },
    };
  }

  #finished(outcome: {
    state: "idle" | "blocked";
    label: string;
    displayAgent: string;
    detail: string;
    sound: "done" | "request";
  }): HerdrUpdate[] {
    const { state, label, displayAgent, detail, sound } = outcome;

    return [
      {
        kind: "metadata",
        title: this.#title,
        displayAgent,
        // An idle report shows as `done` until someone looks at the pane.
        labels: state === "idle" ? { idle: label, done: label } : { blocked: label },
      },
      { kind: "agent", state, message: `${label}. ${detail}` },
      {
        kind: "notification",
        title: `codex-cage ${this.#issueKey}: ${label}`.replace(/\s+/g, " "),
        body: detail,
        sound,
      },
    ];
  }
}

export function herdrCommandArgs(
  update: HerdrUpdate,
  pane: HerdrPane,
  nextSequence: () => bigint,
): string[] {
  switch (update.kind) {
    case "agent":
      return [
        "pane",
        "report-agent",
        pane.paneId,
        "--source",
        herdrSource,
        "--agent",
        herdrAgentLabel,
        "--state",
        update.state,
        "--message",
        update.message,
        "--seq",
        String(nextSequence()),
      ];
    case "metadata":
      return [
        "pane",
        "report-metadata",
        pane.paneId,
        "--source",
        herdrSource,
        "--agent",
        herdrAgentLabel,
        "--title",
        update.title,
        "--display-agent",
        update.displayAgent,
        // Each report replaces the pane's labels, so send the whole set.
        ...Object.entries(update.labels).flatMap(([state, label]) => [
          "--state-label",
          `${state}=${label}`,
        ]),
        "--seq",
        String(nextSequence()),
      ];
    case "notification":
      return [
        "notification",
        "show",
        update.title,
        "--body",
        update.body,
        "--sound",
        update.sound,
      ];
    default: {
      const exhaustive: never = update;
      return exhaustive;
    }
  }
}

async function runHerdrCommand(args: readonly string[]): Promise<void> {
  await execa("herdr", args, { timeout: herdrCommandTimeoutMs });
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
