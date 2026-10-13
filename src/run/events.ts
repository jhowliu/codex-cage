import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { z } from "zod";
import { failureCodes, phaseNames, type FailureCode, type PhaseName } from "../state.js";

export const runEventProtocolVersion = 1 as const;
export const runEventJournalFileName = "events.ndjson";

const maxIdentifierLength = 256;
const maxPayloadStringLength = 2_048;
const maxPayloadArrayLength = 100;
const maxPayloadDepth = 8;
const maxEventBytes = 16_384;
const truncatedMarker = "...[truncated]";

export const canonicalStages = [
  "prepare",
  "implement",
  "verify",
  "review",
  "publish",
] as const;

export type CanonicalStage = (typeof canonicalStages)[number];

const identifierSchema = z.string().min(1).max(maxIdentifierLength);
const eventIdentifierSchema = z
  .string()
  .min(1)
  .max(maxIdentifierLength * 2);
const payloadStringSchema = z.string().max(maxPayloadStringLength);
const artifactReferenceSchema = z.string().min(1).max(maxPayloadStringLength);
const stageSchema = z.enum(canonicalStages);
const phaseSchema = z.enum(phaseNames);
const failureCodeSchema = z.enum(failureCodes);
const positiveIntegerSchema = z.number().int().positive().safe();
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();

const eventEnvelopeShape = {
  protocolVersion: z.literal(runEventProtocolVersion),
  eventId: eventIdentifierSchema,
  runId: identifierSchema,
  sequence: positiveIntegerSchema,
  occurredAt: z.string().datetime({ offset: true }),
};

const stageContextShape = {
  stage: stageSchema,
  stageAttempt: positiveIntegerSchema,
};

const emptyPayloadSchema = z.object({}).strict();

const runStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.started"),
    payload: z
      .object({
        issueKey: payloadStringSchema,
        issueTitle: payloadStringSchema,
        repository: payloadStringSchema,
        baseBranch: payloadStringSchema,
        branch: payloadStringSchema,
        artifactDirectory: artifactReferenceSchema,
        executionMode: z.enum(["docker", "direct"]),
      })
      .strict(),
  })
  .strict();

const runFinishedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run.finished"),
    payload: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("succeeded"),
          failureCode: z.null(),
          prUrl: artifactReferenceSchema,
        })
        .strict(),
      z
        .object({
          status: z.literal("failed"),
          failureCode: failureCodeSchema,
          prUrl: z.null(),
        })
        .strict(),
    ]),
  })
  .strict();

const stageStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("stage.started"),
    payload: emptyPayloadSchema,
  })
  .strict();

const stageFinishedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("stage.finished"),
    payload: emptyPayloadSchema,
  })
  .strict();

const stageFailedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("stage.failed"),
    payload: z.object({ failureCode: failureCodeSchema }).strict(),
  })
  .strict();

const activityPayloadSchema = z
  .object({
    activity: phaseSchema,
    logRef: artifactReferenceSchema,
  })
  .strict();

const activityStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("activity.started"),
    payload: activityPayloadSchema,
  })
  .strict();

const activityFinishedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("activity.finished"),
    payload: activityPayloadSchema,
  })
  .strict();

const activityFailedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("activity.failed"),
    payload: activityPayloadSchema,
  })
  .strict();

const implementationIterationStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    stage: z.literal("implement"),
    stageAttempt: positiveIntegerSchema,
    type: z.literal("implementation.iteration_started"),
    payload: z
      .object({
        iteration: positiveIntegerSchema,
        maxIterations: positiveIntegerSchema,
      })
      .strict()
      .refine((payload) => payload.iteration <= payload.maxIterations, {
        message: "iteration cannot exceed maxIterations",
      }),
  })
  .strict();

const commandStartedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("command.started"),
    payload: z
      .object({
        command: payloadStringSchema,
        logRef: artifactReferenceSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const commandFinishedPayloadShape = {
  startedEventId: eventIdentifierSchema,
  command: payloadStringSchema,
  logRef: artifactReferenceSchema.nullable(),
};

const commandFinishedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    ...stageContextShape,
    type: z.literal("command.finished"),
    payload: z.discriminatedUnion("outcome", [
      z
        .object({
          ...commandFinishedPayloadShape,
          outcome: z.literal("succeeded"),
          exitCode: z.literal(0),
        })
        .strict(),
      z
        .object({
          ...commandFinishedPayloadShape,
          outcome: z.literal("failed"),
          exitCode: nonNegativeIntegerSchema
            .refine((exitCode) => exitCode !== 0 && exitCode !== 124, {
              message: "command outcome does not match exitCode",
            })
            .nullable(),
        })
        .strict(),
      z
        .object({
          ...commandFinishedPayloadShape,
          outcome: z.literal("timed_out"),
          exitCode: z.literal(124),
        })
        .strict(),
    ]),
  })
  .strict();

const verificationCommandsPayloadSchema = z
  .object({
    kind: z.literal("commands"),
    status: z.enum(["passed", "failed"]),
    commandCount: nonNegativeIntegerSchema,
    passedCount: nonNegativeIntegerSchema,
    logRef: artifactReferenceSchema,
  })
  .strict();

const secretGuardPayloadSchema = z.discriminatedUnion("status", [
  z
    .object({
      kind: z.literal("secret_guard"),
      status: z.literal("passed"),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("secret_guard"),
      status: z.literal("failed"),
      retryable: z.boolean(),
    })
    .strict(),
]);

const verificationPayloadSchema = z
  .union([verificationCommandsPayloadSchema, secretGuardPayloadSchema])
  .superRefine((payload, context) => {
    if (payload.kind !== "commands") {
      return;
    }

    if (payload.passedCount > payload.commandCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "passedCount cannot exceed commandCount",
        path: ["passedCount"],
      });
    }

    if (payload.status === "passed" && payload.passedCount !== payload.commandCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "passed verification must report every command as passed",
        path: ["passedCount"],
      });
    }

    if (payload.status === "failed" && payload.passedCount === payload.commandCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed verification must include an unpassed command",
        path: ["passedCount"],
      });
    }
  });

const verificationUpdatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    stage: z.literal("verify"),
    stageAttempt: positiveIntegerSchema,
    type: z.literal("verification.updated"),
    payload: verificationPayloadSchema,
  })
  .strict();

const reviewFinishedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    stage: z.literal("review"),
    stageAttempt: positiveIntegerSchema,
    type: z.literal("review.finished"),
    payload: z
      .object({
        cycle: nonNegativeIntegerSchema,
        decision: z.enum(["pass", "blocking"]),
        summary: payloadStringSchema,
        findingCount: nonNegativeIntegerSchema,
        reportRef: artifactReferenceSchema,
      })
      .strict(),
  })
  .strict();

const artifactCreatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    stage: stageSchema.nullable(),
    stageAttempt: positiveIntegerSchema.nullable(),
    type: z.literal("artifact.created"),
    payload: z
      .object({
        name: payloadStringSchema,
        kind: z.enum(["json", "log", "markdown", "patch", "other"]),
        artifactRef: artifactReferenceSchema,
      })
      .strict(),
  })
  .strict();

const changeCreatedEventSchema = z
  .object({
    ...eventEnvelopeShape,
    stage: z.literal("publish"),
    stageAttempt: positiveIntegerSchema,
    type: z.literal("change.created"),
    payload: z
      .object({
        branch: payloadStringSchema,
        commitMessage: payloadStringSchema,
        title: payloadStringSchema,
        url: artifactReferenceSchema,
        metadataRef: artifactReferenceSchema,
      })
      .strict(),
  })
  .strict();

export const runEventSchema = z
  .discriminatedUnion("type", [
    runStartedEventSchema,
    runFinishedEventSchema,
    stageStartedEventSchema,
    stageFinishedEventSchema,
    stageFailedEventSchema,
    activityStartedEventSchema,
    activityFinishedEventSchema,
    activityFailedEventSchema,
    implementationIterationStartedEventSchema,
    commandStartedEventSchema,
    commandFinishedEventSchema,
    verificationUpdatedEventSchema,
    reviewFinishedEventSchema,
    artifactCreatedEventSchema,
    changeCreatedEventSchema,
  ])
  .superRefine((event, context) => {
    if (
      (event.type === "activity.started" ||
        event.type === "activity.finished" ||
        event.type === "activity.failed") &&
      phaseToCanonicalStage(event.payload.activity) !== event.stage
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activity does not belong to the event's canonical stage",
        path: ["stage"],
      });
    }

    if (
      event.type === "artifact.created" &&
      (event.stage === null) !== (event.stageAttempt === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifact stage and stageAttempt must both be present or both be null",
        path: ["stage"],
      });
    }
  });

export type RunEvent = z.infer<typeof runEventSchema>;

type EventEnvelopeKey =
  | "protocolVersion"
  | "eventId"
  | "runId"
  | "sequence"
  | "occurredAt";

type WithoutEventEnvelope<TEvent> = TEvent extends RunEvent
  ? Omit<TEvent, EventEnvelopeKey>
  : never;

export type RunEventDetails = WithoutEventEnvelope<RunEvent>;
export type RunEventSink = (event: RunEvent) => void | Promise<void>;

export type ReplayedStageAttempt = {
  stage: CanonicalStage;
  attempt: number;
  startedAt: string;
} & (
  | { status: "running"; finishedAt: null; failureCode: null }
  | { status: "succeeded"; finishedAt: string; failureCode: null }
  | { status: "failed"; finishedAt: string; failureCode: FailureCode }
);

type ReplayedRunOutcome =
  | { status: "running"; finishedAt: null; failureCode: null; prUrl: null }
  | { status: "succeeded"; finishedAt: string; failureCode: null; prUrl: string }
  | { status: "failed"; finishedAt: string; failureCode: FailureCode; prUrl: null };

export type ReplayedRun = {
  protocolVersion: typeof runEventProtocolVersion;
  runId: string;
  startedAt: string;
  lastSequence: number;
  stages: ReplayedStageAttempt[];
} & ReplayedRunOutcome;

export class RunEventJournal {
  readonly #runId: string;
  readonly #path: string;
  readonly #redact: (value: string) => string;
  readonly #sink: RunEventSink | undefined;
  readonly #now: () => Date;

  #sequence = 0;
  #appendQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    runId: string;
    path: string;
    redact: (value: string) => string;
    sink?: RunEventSink | undefined;
    now?: (() => Date) | undefined;
  }) {
    this.#runId = input.runId;
    this.#path = input.path;
    this.#redact = input.redact;
    this.#sink = input.sink;
    this.#now = input.now ?? (() => new Date());
  }

  async append(details: RunEventDetails): Promise<RunEvent> {
    const operation = this.#appendQueue.then(async () => await this.#append(details));
    this.#appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async #append(details: RunEventDetails): Promise<RunEvent> {
    const sequence = this.#sequence + 1;
    const candidate: unknown = {
      ...details,
      payload: sanitizePayload(details.payload, this.#redact),
      protocolVersion: runEventProtocolVersion,
      eventId: randomUUID(),
      runId: this.#runId,
      sequence,
      occurredAt: this.#now().toISOString(),
    };
    const event = runEventSchema.parse(candidate);
    const line = `${JSON.stringify(event)}\n`;

    if (Buffer.byteLength(line, "utf8") > maxEventBytes) {
      throw new Error(`Run event ${event.eventId} exceeds ${maxEventBytes} bytes.`);
    }

    await appendDurably(this.#path, line);
    this.#sequence = sequence;
    try {
      await this.#sink?.(event);
    } catch (error) {
      console.error(
        this.#redact(
          `Run event delivery failed for ${event.eventId}: ${formatError(error)}`,
        ),
      );
    }

    return event;
  }
}

export function phaseToCanonicalStage(phase: PhaseName): CanonicalStage {
  switch (phase) {
    case "preflight":
    case "runtime_image":
    case "cloning":
    case "setup":
      return "prepare";
    case "implement":
      return "implement";
    case "verify":
      return "verify";
    case "review":
      return "review";
    case "pr":
      return "publish";
    default: {
      const exhaustivePhase: never = phase;
      return exhaustivePhase;
    }
  }
}

export function parseRunEvent(value: unknown): RunEvent {
  return runEventSchema.parse(value);
}

export function parseRunEventLine(line: string): RunEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error("Invalid run event JSON.", { cause: error });
  }

  return parseRunEvent(parsed);
}

export async function replayRunEventJournal(path: string): Promise<ReplayedRun> {
  return replayRunEvents(await readFile(path, "utf8"));
}

export function replayRunEvents(ndjson: string): ReplayedRun {
  const lines = ndjson.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    throw new Error("Run event journal is empty.");
  }

  const eventsById = new Map<string, string>();
  const eventIdsBySequence = new Map<number, string>();
  const stages = new Map<string, ReplayedStageAttempt>();
  const run: MutableRunReplay = {
    runId: undefined,
    startedAt: undefined,
    outcome: undefined,
  };
  let lastSequence = 0;

  for (const [lineIndex, line] of lines.entries()) {
    let event: RunEvent;

    try {
      event = parseRunEventLine(line);
    } catch (error) {
      throw new Error(`Invalid run event on line ${lineIndex + 1}.`, { cause: error });
    }

    const serializedEvent = JSON.stringify(event);
    const previousEvent = eventsById.get(event.eventId);

    if (previousEvent !== undefined) {
      if (previousEvent !== serializedEvent) {
        throw new Error(`Conflicting duplicate event ID ${event.eventId}.`);
      }

      continue;
    }

    const previousEventId = eventIdsBySequence.get(event.sequence);
    if (previousEventId !== undefined) {
      throw new Error(
        `Sequence ${event.sequence} is shared by ${previousEventId} and ${event.eventId}.`,
      );
    }

    const expectedSequence = lastSequence + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Expected run event sequence ${expectedSequence}, received ${event.sequence}.`,
      );
    }

    if (run.runId !== undefined && event.runId !== run.runId) {
      throw new Error(
        `Run event ${event.eventId} belongs to unexpected Run ${event.runId}.`,
      );
    }

    if (event.type !== "run.started" && run.outcome?.status !== "running") {
      throw new Error(`Run event ${event.eventId} appears outside an active Run.`);
    }

    applyEvent(event, stages, run);

    eventsById.set(event.eventId, serializedEvent);
    eventIdsBySequence.set(event.sequence, event.eventId);
    lastSequence = event.sequence;
  }

  const { runId, startedAt, outcome } = run;
  if (runId === undefined || startedAt === undefined || outcome === undefined) {
    throw new Error("Run event journal does not begin with run.started.");
  }

  return {
    protocolVersion: runEventProtocolVersion,
    runId,
    startedAt,
    lastSequence,
    stages: [...stages.values()],
    ...outcome,
  };
}

type MutableRunReplay = {
  runId: string | undefined;
  startedAt: string | undefined;
  outcome: ReplayedRunOutcome | undefined;
};

function applyEvent(
  event: RunEvent,
  stages: Map<string, ReplayedStageAttempt>,
  run: MutableRunReplay,
): void {
  switch (event.type) {
    case "run.started":
      if (run.runId !== undefined) {
        throw new Error("Run event journal contains more than one run.started event.");
      }
      if (event.sequence !== 1) {
        throw new Error("run.started must be the first Run event.");
      }
      run.runId = event.runId;
      run.startedAt = event.occurredAt;
      run.outcome = {
        status: "running",
        finishedAt: null,
        failureCode: null,
        prUrl: null,
      };
      return;
    case "run.finished": {
      assertNoRunningStage(stages);
      run.outcome =
        event.payload.status === "succeeded"
          ? {
              status: "succeeded",
              finishedAt: event.occurredAt,
              failureCode: null,
              prUrl: event.payload.prUrl,
            }
          : {
              status: "failed",
              finishedAt: event.occurredAt,
              failureCode: event.payload.failureCode,
              prUrl: null,
            };
      return;
    }
    case "stage.started": {
      assertNoRunningStage(stages);
      const expectedAttempt =
        [...stages.values()].filter((stage) => stage.stage === event.stage).length + 1;
      if (event.stageAttempt !== expectedAttempt) {
        throw new Error(
          `Expected ${event.stage} Stage Attempt ${expectedAttempt}, received ${event.stageAttempt}.`,
        );
      }

      stages.set(stageAttemptKey(event.stage, event.stageAttempt), {
        stage: event.stage,
        attempt: event.stageAttempt,
        status: "running",
        startedAt: event.occurredAt,
        finishedAt: null,
        failureCode: null,
      });
      return;
    }
    case "stage.finished": {
      const stage = runningStage(stages, event.stage, event.stageAttempt);
      stages.set(stageAttemptKey(event.stage, event.stageAttempt), {
        stage: stage.stage,
        attempt: stage.attempt,
        status: "succeeded",
        startedAt: stage.startedAt,
        finishedAt: event.occurredAt,
        failureCode: null,
      });
      return;
    }
    case "stage.failed": {
      const stage = runningStage(stages, event.stage, event.stageAttempt);
      stages.set(stageAttemptKey(event.stage, event.stageAttempt), {
        stage: stage.stage,
        attempt: stage.attempt,
        status: "failed",
        startedAt: stage.startedAt,
        finishedAt: event.occurredAt,
        failureCode: event.payload.failureCode,
      });
      return;
    }
    case "activity.started":
    case "activity.finished":
    case "activity.failed":
    case "implementation.iteration_started":
    case "command.started":
    case "command.finished":
    case "verification.updated":
    case "review.finished":
    case "change.created":
      runningStage(stages, event.stage, event.stageAttempt);
      return;
    case "artifact.created":
      if (event.stage !== null && event.stageAttempt !== null) {
        runningStage(stages, event.stage, event.stageAttempt);
      }
      return;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}

function runningStage(
  stages: Map<string, ReplayedStageAttempt>,
  stage: CanonicalStage,
  attempt: number,
): Extract<ReplayedStageAttempt, { status: "running" }> {
  const existing = stages.get(stageAttemptKey(stage, attempt));

  if (existing === undefined || existing.status !== "running") {
    throw new Error(`${stage} Stage Attempt ${attempt} is not running.`);
  }

  return existing;
}

function assertNoRunningStage(stages: Map<string, ReplayedStageAttempt>): void {
  const activeStage = [...stages.values()].find((stage) => stage.status === "running");

  if (activeStage !== undefined) {
    throw new Error(
      `${activeStage.stage} Stage Attempt ${activeStage.attempt} is still running.`,
    );
  }
}

function stageAttemptKey(stage: CanonicalStage, attempt: number): string {
  return `${stage}:${attempt}`;
}

async function appendDurably(path: string, line: string): Promise<void> {
  const file = await open(path, "a");

  try {
    await file.writeFile(line, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function sanitizePayload(
  value: unknown,
  redact: (value: string) => string,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return truncate(redact(value));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= maxPayloadDepth) {
    return truncatedMarker;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, maxPayloadArrayLength)
      .map((entry) => sanitizePayload(entry, redact, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizePayload(entry, redact, depth + 1),
    ]),
  );
}

function truncate(value: string): string {
  if (value.length <= maxPayloadStringLength) {
    return value;
  }

  return `${value.slice(0, maxPayloadStringLength - truncatedMarker.length)}${truncatedMarker}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
