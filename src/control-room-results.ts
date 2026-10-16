import { basename } from "node:path";
import type { ControlRunRecord } from "./control-room.js";
import { parseChangeDiff, type ChangeDiff } from "./control-room-diff.js";
import { parseReviewReport, type ReviewReport } from "./review.js";
import type { CanonicalStage, RunEvent } from "./run/events.js";

export type Evidence<TValue> =
  | { status: "available"; artifact: string; value: TValue }
  | { status: "unavailable" | "invalid"; artifact: string | null; message: string };

export type StageActivity = {
  name: string;
  status: "running" | "succeeded" | "failed";
  log: string | null;
};

export type StageCommand = {
  id: string;
  command: string;
  outcome: "running" | "succeeded" | "failed" | "timed_out";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
};

type ResultContext = {
  status: "pending" | "running" | "succeeded" | "failed" | "aborted";
  attempt: number | null;
  failureCode: string | null;
  artifacts: string[];
};

export type StageResult = ResultContext &
  (
    | {
        stage: "prepare";
        target: {
          issueTitle: string;
          repository: string;
          baseBranch: string;
          branch: string;
          executionMode: "docker" | "direct";
        } | null;
        activities: StageActivity[];
      }
    | {
        stage: "implement";
        iteration: number | null;
        maxIterations: number | null;
        changes: Evidence<ChangeDiff>;
      }
    | {
        stage: "verify";
        commands: StageCommand[];
        verification: {
          status: "passed" | "failed";
          commandCount: number;
          passedCount: number;
        } | null;
        secretGuard: "passed" | "failed" | null;
      }
    | {
        stage: "review";
        verdict: {
          decision: "pass" | "blocking";
          summary: string;
          findingCount: number;
        } | null;
        report: Evidence<ReviewReport>;
      }
    | {
        stage: "publish";
        change: {
          branch: string;
          commitMessage: string;
          title: string;
          url: string | null;
          baseBranch: string | null;
        } | null;
      }
  );

type ReadArtifact = (name: string) => Promise<string>;
const maxEvidenceCharacters = 2_000_000;

/** Results are derived from validated Runner events; evidence reads never follow event paths. */
export async function buildStageResult(
  run: ControlRunRecord,
  stage: CanonicalStage,
  readArtifact: ReadArtifact,
): Promise<StageResult> {
  const attempt = run.stages.filter((candidate) => candidate.stage === stage).at(-1);
  const events = run.events.filter(
    (event) =>
      "stage" in event &&
      event.stage === stage &&
      event.stageAttempt === attempt?.attempt,
  );
  const context: ResultContext = {
    status:
      run.status === "aborted" && attempt?.status === "running"
        ? "aborted"
        : (attempt?.status ??
          (stage === "prepare" && run.status === "failed" ? "failed" : "pending")),
    attempt: attempt?.attempt ?? null,
    failureCode:
      attempt?.failureCode ??
      (stage === "prepare" && attempt === undefined ? run.failureCode : null),
    artifacts: stageArtifactNames(run, stage, events),
  };
  const started = run.events.find((event) => event.type === "run.started");
  switch (stage) {
    case "prepare":
      return {
        ...context,
        stage,
        target:
          started === undefined
            ? null
            : {
                issueTitle: started.payload.issueTitle,
                repository: started.payload.repository,
                baseBranch: started.payload.baseBranch,
                branch: started.payload.branch,
                executionMode: started.payload.executionMode,
              },
        activities: activitiesFromEvents(events),
      };
    case "implement": {
      const iteration = events.find(
        (event) => event.type === "implementation.iteration_started",
      );
      const diffName =
        iteration === undefined ? null : `changes-${iteration.payload.iteration}.patch`;
      const artifact =
        diffName !== null && run.artifacts.includes(diffName)
          ? diffName
          : run.artifacts.includes("final.patch")
            ? "final.patch"
            : null;
      return {
        ...context,
        stage,
        iteration: iteration?.payload.iteration ?? null,
        maxIterations: iteration?.payload.maxIterations ?? null,
        changes: await readEvidence(run, artifact, readArtifact, parseChangeDiff),
      };
    }
    case "verify": {
      const verification = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "verification.updated" && event.payload.kind === "commands",
        );
      const guard = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "verification.updated" &&
            event.payload.kind === "secret_guard",
        );
      return {
        ...context,
        stage,
        commands: commandsFromEvents(events),
        verification:
          verification?.type === "verification.updated" &&
          verification.payload.kind === "commands"
            ? {
                status: verification.payload.status,
                commandCount: verification.payload.commandCount,
                passedCount: verification.payload.passedCount,
              }
            : null,
        secretGuard: guard?.type === "verification.updated" ? guard.payload.status : null,
      };
    }
    case "review": {
      const review = [...events]
        .reverse()
        .find((event) => event.type === "review.finished");
      return {
        ...context,
        stage,
        verdict:
          review === undefined
            ? null
            : {
                decision: review.payload.decision,
                summary: review.payload.summary,
                findingCount: review.payload.findingCount,
              },
        report: await readEvidence(
          run,
          review === undefined ? null : basename(review.payload.reportRef),
          readArtifact,
          (content) => {
            const report = parseReviewReport(content);
            if (
              review !== undefined &&
              (report.decision !== review.payload.decision ||
                report.findings.length !== review.payload.findingCount)
            ) {
              throw new Error("Report disagrees with its recorded result.");
            }
            return report;
          },
        ),
      };
    }
    case "publish": {
      const change = [...events]
        .reverse()
        .find((event) => event.type === "change.created");
      return {
        ...context,
        stage,
        change:
          change === undefined
            ? null
            : {
                branch: change.payload.branch,
                commitMessage: change.payload.commitMessage,
                title: change.payload.title,
                url: safeGithubPrUrl(change.payload.url),
                baseBranch: started?.payload.baseBranch ?? null,
              },
      };
    }
    default: {
      const exhaustive: never = stage;
      throw new Error(`Unknown stage: ${exhaustive}`);
    }
  }
}

function activitiesFromEvents(events: readonly RunEvent[]): StageActivity[] {
  const activities = new Map<string, StageActivity>();
  for (const event of events) {
    if (
      event.type !== "activity.started" &&
      event.type !== "activity.finished" &&
      event.type !== "activity.failed"
    )
      continue;
    activities.set(event.payload.activity, {
      name: event.payload.activity,
      status:
        event.type === "activity.started"
          ? "running"
          : event.type === "activity.finished"
            ? "succeeded"
            : "failed",
      log: basename(event.payload.logRef),
    });
  }
  return [...activities.values()];
}

function commandsFromEvents(events: readonly RunEvent[]): StageCommand[] {
  const commands = new Map<string, StageCommand>();
  for (const event of events) {
    if (
      event.type === "command.started" &&
      event.payload.logRef !== null &&
      basename(event.payload.logRef) === "verify.log"
    ) {
      commands.set(event.eventId, {
        id: event.eventId,
        command: event.payload.command,
        outcome: "running",
        exitCode: null,
        startedAt: event.occurredAt,
        finishedAt: null,
      });
    }
    if (event.type === "command.finished") {
      const command = commands.get(event.payload.startedEventId);
      if (command !== undefined) {
        command.outcome = event.payload.outcome;
        command.exitCode = event.payload.exitCode;
        command.finishedAt = event.occurredAt;
      }
    }
  }
  return [...commands.values()];
}

function stageArtifactNames(
  run: ControlRunRecord,
  stage: CanonicalStage,
  events: readonly RunEvent[],
): string[] {
  const names = new Set(
    events
      .filter((event) => event.type === "artifact.created")
      .map((event) => event.payload.name)
      .filter((name) => stage !== "verify" || !/^changes-\d+\.patch$/.test(name)),
  );
  const conventional: Record<CanonicalStage, readonly string[]> = {
    prepare: [
      "issue.json",
      "resolved-config.json",
      "runtime-image.json",
      "prompt-context.json",
      "preflight.log",
      "runtime_image.log",
      "cloning.log",
      "setup.log",
    ],
    implement: ["implement.log", "final.patch"],
    verify: ["verify.log"],
    review: ["review.log"],
    publish: ["pr.log", "pr.json", "summary.md", "final.patch"],
  };
  for (const name of conventional[stage]) names.add(name);
  if (stage === "implement") {
    const iteration = events.find(
      (event) => event.type === "implementation.iteration_started",
    );
    if (iteration !== undefined)
      names.add(`changes-${iteration.payload.iteration}.patch`);
  }
  if (stage === "review") {
    const review = [...events]
      .reverse()
      .find((event) => event.type === "review.finished");
    if (review !== undefined) names.add(basename(review.payload.reportRef));
  }
  return [...names].filter((name) => run.artifacts.includes(name)).sort();
}

async function readEvidence<TValue>(
  run: ControlRunRecord,
  artifact: string | null,
  readArtifact: ReadArtifact,
  parse: (content: string) => TValue,
): Promise<Evidence<TValue>> {
  if (
    artifact === null ||
    !/^[A-Za-z0-9._-]+$/.test(artifact) ||
    artifact.includes("..") ||
    !run.artifacts.includes(artifact)
  ) {
    return {
      status: "unavailable",
      artifact: null,
      message: "Evidence has not been recorded for this stage yet.",
    };
  }
  let content: string;
  try {
    content = await readArtifact(artifact);
  } catch {
    return {
      status: "unavailable",
      artifact,
      message:
        "The recorded evidence could not be read. Try refreshing or inspect the original artifact.",
    };
  }
  if (content.length > maxEvidenceCharacters) {
    return {
      status: "unavailable",
      artifact,
      message: "This evidence is too large to preview. Open the original artifact.",
    };
  }
  try {
    return { status: "available", artifact, value: parse(content) };
  } catch {
    return {
      status: "invalid",
      artifact,
      message:
        "The evidence does not match the recorded result. Inspect the original artifact for details.",
    };
  }
}

function safeGithubPrUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
