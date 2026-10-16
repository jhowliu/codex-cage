import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadCodexCageConfigFile } from "./config-file.js";
import { buildStageResult } from "./control-room-results.js";
import {
  readGithubAuthStatus,
  type GithubAuthFetcher,
  type GithubAuthStatus,
} from "./control-room-auth.js";
import { parseIssueUrl } from "./issue.js";
import { defaultGitRemoteReader, parseGithubRepo } from "./repo.js";
import {
  canonicalStages,
  parseRunEventLine,
  replayRunEvents,
  runEventSchema,
  runEventJournalFileName,
  type CanonicalStage,
  type ReplayedStageAttempt,
  type RunEvent,
} from "./run/events.js";
import { failureCodes, type FailureCode } from "./state.js";

const controlRoomStateVersion = 1 as const;
const controlRoomStateFileName = "control-room.json";
const defaultHost = "127.0.0.1";
const runIdPattern = /^run-[A-Za-z0-9._-]+$/;
const artifactNamePattern = /^[A-Za-z0-9._-]+$/;
const staticAssetNamePattern = /^[A-Za-z0-9._-]+$/;

const repositoryStatusSchema = z.enum([
  "setup_required",
  "invalid_config",
  "ready",
  "blocked",
]);
const controlRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "unknown",
]);
const observationModeSchema = z.enum(["live", "polling", "artifacts"]);
const stageAttemptFields = {
  stage: z.enum(canonicalStages),
  attempt: z.number().int().positive(),
  startedAt: z.string(),
} as const;
const stageAttemptSchema = z.discriminatedUnion("status", [
  z.object({
    ...stageAttemptFields,
    status: z.literal("running"),
    finishedAt: z.null(),
    failureCode: z.null(),
  }),
  z.object({
    ...stageAttemptFields,
    status: z.literal("succeeded"),
    finishedAt: z.string(),
    failureCode: z.null(),
  }),
  z.object({
    ...stageAttemptFields,
    status: z.literal("failed"),
    finishedAt: z.string(),
    failureCode: z.enum(failureCodes),
  }),
]);

const repositoryRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  fullName: z.string().nullable(),
  status: repositoryStatusSchema,
  message: z.string(),
  warnings: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const runRecordSchema = z.object({
  id: z.string().regex(runIdPattern),
  repositoryId: z.string().min(1),
  issueUrl: z.string().url(),
  status: controlRunStatusSchema,
  observationMode: observationModeSchema,
  events: z.array(runEventSchema),
  stages: z.array(stageAttemptSchema),
  currentStage: z.enum(canonicalStages).nullable(),
  lastSequence: z.number().int().nonnegative(),
  failureCode: z.enum(failureCodes).nullable(),
  prUrl: z.string().url().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canCancel: z.boolean(),
  artifacts: z.array(z.string()),
});

const controlRoomStateSchema = z.object({
  version: z.literal(controlRoomStateVersion),
  repositories: z.array(repositoryRecordSchema),
  runs: z.array(runRecordSchema),
});

const registerRepositorySchema = z.object({
  path: z.string().trim().min(1).max(4_096),
});

const createRunSchema = z.object({
  repositoryId: z.string().min(1),
  issueUrl: z.string().url(),
});

export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;
export type ControlRunStatus = z.infer<typeof controlRunStatusSchema>;
export type ObservationMode = z.infer<typeof observationModeSchema>;
export type RepositoryRecord = z.infer<typeof repositoryRecordSchema>;
export type ControlRunRecord = z.infer<typeof runRecordSchema>;

export type ControlRoomSnapshot = {
  repositories: readonly PublicRepository[];
  runs: readonly PublicRun[];
};

export type PublicRepository = Omit<RepositoryRecord, "path">;

export type PublicRunEvent = {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: RunEvent["type"];
  stage: CanonicalStage | null;
  stageAttempt: number | null;
  summary: string;
};

export type PublicRun = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  issueUrl: string;
  status: ControlRunStatus;
  observationMode: ObservationMode;
  currentStage: CanonicalStage | null;
  stages: readonly ReplayedStageAttempt[];
  lastSequence: number;
  failureCode: FailureCode | null;
  prUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canCancel: boolean;
  events: readonly PublicRunEvent[];
  artifacts: readonly string[];
};

export type LocalRunRequest = {
  runId: string;
  issueUrl: string;
  repositoryPath: string;
};

export type LocalRunnerHandle = {
  eventPath: string;
  resultPath: string;
  exit: Promise<number>;
  cancel: () => void;
};

export type LocalRunnerLauncher = (
  request: LocalRunRequest,
) => Promise<LocalRunnerHandle>;

export type ExecutionProviderCapabilities = {
  observationMode: ObservationMode;
  canCancel: boolean;
  canRetrieveArtifacts: boolean;
  canReconcile: boolean;
};

export type ExecutionProvider = {
  readonly name: "local";
  readonly capabilities: ExecutionProviderCapabilities;
  start(request: LocalRunRequest): Promise<void>;
  cancel(runId: string): Promise<void>;
};

type ControlRoomState = z.infer<typeof controlRoomStateSchema>;
type ChangeListener = () => void;

export async function openControlRoomStore(cwd: string): Promise<ControlRoomStore> {
  const stateDirectory = join(cwd, ".codex-cage");
  await mkdir(stateDirectory, { recursive: true });
  const path = join(stateDirectory, controlRoomStateFileName);
  let state: ControlRoomState;

  try {
    state = controlRoomStateSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      state = { version: controlRoomStateVersion, repositories: [], runs: [] };
    } else if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error(`Control Room state is invalid: ${formatError(error)}`);
    } else {
      throw error;
    }
  }

  const store = new ControlRoomStore(cwd, path, state);
  await store.save();
  return store;
}

export class ControlRoomStore {
  readonly cwd: string;
  readonly path: string;

  #state: ControlRoomState;
  #onChange: ChangeListener | undefined;

  constructor(cwd: string, path: string, state: ControlRoomState) {
    this.cwd = cwd;
    this.path = path;
    this.#state = state;
  }

  setChangeListener(listener: ChangeListener | undefined): void {
    this.#onChange = listener;
  }

  async save(): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`, "utf8");
    try {
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    this.#onChange?.();
  }

  listRepositories(): RepositoryRecord[] {
    return this.#state.repositories.map((repository) => ({ ...repository }));
  }

  getRepository(id: string): RepositoryRecord {
    const repository = this.#state.repositories.find((candidate) => candidate.id === id);
    if (repository === undefined)
      throw new ControlRoomError(404, "Repository not found.");
    return { ...repository };
  }

  async registerRepository(inputPath: string): Promise<RepositoryRecord> {
    const path = resolve(inputPath);
    let directory;
    try {
      directory = await stat(path);
    } catch (error) {
      throw new ControlRoomError(
        400,
        `Repository path cannot be read: ${formatError(error)}`,
      );
    }
    if (!directory.isDirectory()) {
      throw new ControlRoomError(400, "Repository path must be a directory.");
    }

    const existing = this.#state.repositories.find(
      (repository) => repository.path === path,
    );
    const now = new Date().toISOString();
    const record = await inspectRepository({
      id: existing?.id ?? `repo-${randomUUID()}`,
      path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    if (existing === undefined) this.#state.repositories.push(record);
    else
      this.#state.repositories = this.#state.repositories.map((candidate) =>
        candidate.id === record.id ? record : candidate,
      );
    await this.save();
    return { ...record };
  }

  listRuns(): PublicRun[] {
    return this.#state.runs.map((run) => this.toPublicRun(run));
  }

  getRun(id: string): ControlRunRecord {
    const run = this.#state.runs.find((candidate) => candidate.id === id);
    if (run === undefined) throw new ControlRoomError(404, "Run not found.");
    return structuredClone(run);
  }

  getPublicRun(id: string): PublicRun {
    return this.toPublicRun(this.getRun(id));
  }

  async createRun(input: {
    repositoryId: string;
    issueUrl: string;
  }): Promise<ControlRunRecord> {
    const repository = this.getRepository(input.repositoryId);
    if (repository.status !== "ready") {
      throw new ControlRoomError(409, `Repository is not ready: ${repository.message}`);
    }

    const parsedIssue = parseIssueUrl(input.issueUrl);
    if (parsedIssue.source !== "github") {
      throw new ControlRoomError(
        400,
        "The first Control Room slice accepts GitHub Issue URLs only.",
      );
    }
    if (
      repository.fullName !== null &&
      repository.fullName !== parsedIssue.inferredRepo
    ) {
      throw new ControlRoomError(
        409,
        `Issue repository ${parsedIssue.inferredRepo} does not match ${repository.fullName}.`,
      );
    }

    const active = this.#state.runs.find(
      (run) =>
        run.repositoryId === input.repositoryId &&
        run.issueUrl === input.issueUrl &&
        (run.status === "queued" || run.status === "running"),
    );
    if (active !== undefined) {
      throw new ControlRoomError(409, `An active Run already exists: ${active.id}.`);
    }

    const now = new Date().toISOString();
    const run: ControlRunRecord = {
      id: createRunId(),
      repositoryId: repository.id,
      issueUrl: input.issueUrl,
      status: "queued",
      observationMode: "live",
      events: [],
      stages: [],
      currentStage: null,
      lastSequence: 0,
      failureCode: null,
      prUrl: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      canCancel: true,
      artifacts: [],
    } as ControlRunRecord;
    this.#state.runs.unshift(run);
    await this.save();
    return structuredClone(run);
  }

  async markRunning(runId: string): Promise<void> {
    const run = this.getMutableRun(runId);
    run.status = "running";
    run.updatedAt = new Date().toISOString();
    await this.save();
  }

  async applyEvent(event: RunEvent): Promise<void> {
    const run = this.getMutableRun(event.runId);
    if (run.events.some((candidate) => candidate.eventId === event.eventId)) return;
    if (run.events.some((candidate) => candidate.sequence === event.sequence)) {
      throw new ControlRoomError(409, `Run event sequence ${event.sequence} conflicts.`);
    }

    const events = [...run.events, event].sort(
      (left, right) => left.sequence - right.sequence,
    );
    const replayed = replayRunEvents(
      events.map((candidate) => JSON.stringify(candidate)).join("\n"),
    );
    run.events = events;
    run.stages = replayed.stages;
    run.lastSequence = replayed.lastSequence;
    run.status = replayed.status;
    run.failureCode = replayed.failureCode;
    run.prUrl = replayed.prUrl;
    run.startedAt = replayed.startedAt;
    run.finishedAt = replayed.finishedAt;
    run.currentStage =
      replayed.stages.find((stage) => stage.status === "running")?.stage ?? null;
    run.updatedAt = new Date().toISOString();
    run.artifacts = artifactNames(events);
    await this.save();
  }

  async markFailed(runId: string, failureCode: FailureCode): Promise<void> {
    const run = this.getMutableRun(runId);
    if (run.status === "succeeded" || run.status === "failed" || run.status === "aborted")
      return;
    run.status = "failed";
    run.failureCode = failureCode;
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    await this.save();
  }

  async abortRun(runId: string): Promise<void> {
    const run = this.getMutableRun(runId);
    if (run.status === "succeeded" || run.status === "failed") return;
    run.status = "aborted";
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
    await this.save();
  }

  artifactPath(runId: string, name: string): string {
    if (!artifactNamePattern.test(name) || name.includes("..")) {
      throw new ControlRoomError(400, "Invalid artifact name.");
    }
    const run = this.getRun(runId);
    const repository = this.getRepository(run.repositoryId);
    return join(repository.path, ".codex-cage", "runs", runId, name);
  }

  private getMutableRun(id: string): ControlRunRecord {
    const run = this.#state.runs.find((candidate) => candidate.id === id);
    if (run === undefined) throw new ControlRoomError(404, "Run not found.");
    return run;
  }

  private toPublicRun(run: ControlRunRecord): PublicRun {
    const repository = this.getRepository(run.repositoryId);
    return {
      id: run.id,
      repositoryId: run.repositoryId,
      repositoryName: repository.name,
      issueUrl: run.issueUrl,
      status: run.status,
      observationMode: run.observationMode,
      currentStage: run.currentStage,
      stages: run.stages,
      lastSequence: run.lastSequence,
      failureCode: run.failureCode,
      prUrl: run.prUrl,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      canCancel: run.canCancel && (run.status === "queued" || run.status === "running"),
      events: run.events.map(toPublicEvent),
      artifacts: run.artifacts,
    };
  }
}

export async function createControlRoomServer(options: {
  cwd: string;
  host?: string;
  port?: number;
  launchRunner?: LocalRunnerLauncher;
  githubAuthFetch?: GithubAuthFetcher;
}): Promise<ControlRoomServer> {
  const store = await openControlRoomStore(options.cwd);
  const room = new ControlRoom(
    store,
    options.launchRunner ?? launchLocalRunner,
    options.githubAuthFetch ?? fetch,
  );
  const server = createServer((request, response) => {
    void room.handle(request, response);
  });
  const host = options.host ?? defaultHost;
  const port = options.port ?? 0;
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Control Room did not expose a TCP address.");
  }

  return {
    server,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    async close(): Promise<void> {
      await room.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        );
      });
      store.setChangeListener(undefined);
    },
  };
}

export type ControlRoomServer = {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

class ControlRoom {
  readonly #store: ControlRoomStore;
  readonly #provider: LocalExecutionProvider;
  readonly #githubAuthFetch: GithubAuthFetcher;
  readonly #clients = new Set<ServerResponse>();

  constructor(
    store: ControlRoomStore,
    launchRunner: LocalRunnerLauncher,
    githubAuthFetch: GithubAuthFetcher,
  ) {
    this.#store = store;
    this.#githubAuthFetch = githubAuthFetch;
    this.#provider = new LocalExecutionProvider({
      store,
      launchRunner,
    });
    store.setChangeListener(() => this.broadcastSnapshot());
  }

  async close(): Promise<void> {
    await this.#provider.close();
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        await this.serveIndex(response);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        await this.serveAsset(url.pathname.slice("/assets/".length), response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok", provider: this.#provider.capabilities });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/auth/status") {
        const status: GithubAuthStatus = await readGithubAuthStatus(
          this.#store.cwd,
          this.#githubAuthFetch,
        );
        sendJson(response, 200, status);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/repositories") {
        sendJson(response, 200, this.snapshot().repositories);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/repositories") {
        const body = registerRepositorySchema.parse(await readJson(request));
        const repository = await this.#store.registerRepository(body.path);
        sendJson(response, 201, toPublicRepository(repository));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        sendJson(response, 200, this.snapshot().runs);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = createRunSchema.parse(await readJson(request));
        const run = await this.#store.createRun(body);
        const repository = this.#store.getRepository(run.repositoryId);
        void this.startProviderRun(run, repository).catch(async (error: unknown) => {
          await this.#store.markFailed(run.id, failureCodeForError(error));
        });
        sendJson(response, 202, this.#store.getPublicRun(run.id));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        this.subscribe(response);
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(cancel|events))?$/);
      if (runMatch !== null) {
        const runId = decodeURIComponent(runMatch[1] ?? "");
        const action = runMatch[2];
        if (request.method === "GET" && action === undefined) {
          sendJson(response, 200, this.#store.getPublicRun(runId));
          return;
        }
        if (request.method === "GET" && action === "events") {
          sendJson(response, 200, this.#store.getPublicRun(runId).events);
          return;
        }
        if (request.method === "POST" && action === "cancel") {
          await this.#provider.cancel(runId);
          sendJson(response, 202, this.#store.getPublicRun(runId));
          return;
        }
      }

      const stageResultMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/stages\/([^/]+)$/,
      );
      if (request.method === "GET" && stageResultMatch !== null) {
        const runId = decodeURIComponent(stageResultMatch[1] ?? "");
        const stage = z
          .enum(canonicalStages)
          .parse(decodeURIComponent(stageResultMatch[2] ?? ""));
        const result = await buildStageResult(
          this.#store.getRun(runId),
          stage,
          async (name) => {
            const path = this.#store.artifactPath(runId, name);
            if ((await stat(path)).size > 2_000_000)
              throw new Error("Evidence preview is too large.");
            return await readFile(path, "utf8");
          },
        );
        sendJson(response, 200, result);
        return;
      }

      const artifactMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/,
      );
      if (request.method === "GET" && artifactMatch !== null) {
        const runId = decodeURIComponent(artifactMatch[1] ?? "");
        const name = decodeURIComponent(artifactMatch[2] ?? "");
        const content = await readFile(this.#store.artifactPath(runId, name));
        response.writeHead(200, { "content-type": contentTypeForArtifact(name) });
        response.end(content);
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status =
        error instanceof ControlRoomError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      sendJson(response, status, { error: formatError(error) });
    }
  }

  private snapshot(): ControlRoomSnapshot {
    return {
      repositories: this.#store.listRepositories().map(toPublicRepository),
      runs: this.#store.listRuns(),
    };
  }

  private async startProviderRun(
    run: ControlRunRecord,
    repository: RepositoryRecord,
  ): Promise<void> {
    await this.#store.markRunning(run.id);
    await this.#provider.start({
      runId: run.id,
      issueUrl: run.issueUrl,
      repositoryPath: repository.path,
    });
  }

  private subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    this.#clients.add(response);
    response.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    response.on("close", () => this.#clients.delete(response));
  }

  private broadcastSnapshot(): void {
    const payload = `event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const client of this.#clients) {
      try {
        client.write(payload);
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  private async serveIndex(response: ServerResponse): Promise<void> {
    const indexPath = join(webRootPath(), "index.html");
    const content = await readFile(indexPath, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(content);
  }

  private async serveAsset(name: string, response: ServerResponse): Promise<void> {
    const decodedName = decodeURIComponent(name);
    if (!staticAssetNamePattern.test(decodedName) || decodedName.includes("..")) {
      throw new ControlRoomError(400, "Invalid Control Room asset name.");
    }
    const content = await readFile(join(webRootPath(), "assets", decodedName));
    response.writeHead(200, { "content-type": contentTypeForStaticAsset(decodedName) });
    response.end(content);
  }
}

class LocalExecutionProvider implements ExecutionProvider {
  readonly name = "local" as const;
  readonly capabilities: ExecutionProviderCapabilities = {
    observationMode: "live",
    canCancel: true,
    canRetrieveArtifacts: true,
    canReconcile: true,
  };

  readonly #store: ControlRoomStore;
  readonly #launchRunner: LocalRunnerLauncher;
  readonly #handles = new Map<string, LocalRunnerHandle>();
  readonly #observations = new Map<string, Promise<void>>();

  constructor(input: { store: ControlRoomStore; launchRunner: LocalRunnerLauncher }) {
    this.#store = input.store;
    this.#launchRunner = input.launchRunner;
  }

  async start(request: LocalRunRequest): Promise<void> {
    const handle = await this.#launchRunner(request);
    this.#handles.set(request.runId, handle);
    const observation = this.observe(request, handle);
    this.#observations.set(request.runId, observation);
    void observation
      .catch((error: unknown) => {
        console.error(`Control Room observation failed: ${formatError(error)}`);
      })
      .finally(() => {
        if (this.#observations.get(request.runId) === observation) {
          this.#observations.delete(request.runId);
        }
      });
  }

  async cancel(runId: string): Promise<void> {
    const handle = this.#handles.get(runId);
    if (handle === undefined)
      throw new ControlRoomError(409, "Run is not locally active.");
    handle.cancel();
    await this.#store.abortRun(runId);
  }

  async close(): Promise<void> {
    const cancellations = [...this.#handles.entries()].map(async ([runId, handle]) => {
      handle.cancel();
      await this.#store.abortRun(runId);
    });
    await Promise.all(cancellations);
    await Promise.all(this.#observations.values());
  }

  private async observe(
    request: LocalRunRequest,
    handle: LocalRunnerHandle,
  ): Promise<void> {
    let polling = Promise.resolve();
    const poll = (): Promise<void> => {
      polling = polling.then(() => this.readEvents(handle.eventPath));
      return polling;
    };
    const timer = setInterval(() => void poll(), 100);

    try {
      const exitCode = await handle.exit;
      clearInterval(timer);
      await poll();
      const current = this.#store.getRun(request.runId);
      if (current.status === "running" || current.status === "queued") {
        const result = await readResultFile(handle.resultPath);
        if (result?.status === "failed") {
          await this.#store.markFailed(
            request.runId,
            result.failureCode ?? "internal_error",
          );
        } else if (result?.status === "succeeded") {
          await this.#store.markFailed(request.runId, "internal_error");
        } else {
          await this.#store.markFailed(
            request.runId,
            exitCode === 0 ? "internal_error" : "internal_error",
          );
        }
      }
    } catch (error) {
      if (this.#store.getRun(request.runId).status !== "aborted") {
        await this.#store.markFailed(request.runId, failureCodeForError(error));
      }
    } finally {
      clearInterval(timer);
      this.#handles.delete(request.runId);
    }
  }

  private async readEvents(path: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }

    const lines = content.split(/\r?\n/);
    if (!content.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      await this.#store.applyEvent(parseRunEventLine(line));
    }
  }
}

async function launchLocalRunner(request: LocalRunRequest): Promise<LocalRunnerHandle> {
  const entrypoint = fileURLToPath(new URL("./cli.js", import.meta.url));
  const runDirectory = join(request.repositoryPath, ".codex-cage", "runs", request.runId);
  await mkdir(runDirectory, { recursive: true });
  const eventPath = join(runDirectory, runEventJournalFileName);
  const resultPath = join(runDirectory, "result.json");
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "run",
      request.issueUrl,
      "--run-id",
      request.runId,
      "--result-json",
      resultPath,
    ],
    {
      cwd: request.repositoryPath,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  const exit = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  return {
    eventPath,
    resultPath,
    exit,
    cancel: () => child.kill("SIGTERM"),
  };
}

async function inspectRepository(input: {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}): Promise<RepositoryRecord> {
  const config = await loadCodexCageConfigFile(input.path);
  const origin = await defaultGitRemoteReader.getOriginUrl(input.path);
  let fullName: string | null = null;
  if (origin !== null) {
    try {
      fullName = parseGithubRepo(origin).fullName;
    } catch {
      fullName = null;
    }
  }

  if (config.status === "missing") {
    return {
      ...input,
      name: basename(input.path),
      fullName,
      status: "setup_required",
      message: "Add .codex-cage.yml with at least one verify command.",
      warnings: [],
    };
  }
  if (config.status === "invalid") {
    return {
      ...input,
      name: basename(input.path),
      fullName,
      status: "invalid_config",
      message: config.errors.map((error) => error.message).join("; "),
      warnings: [],
    };
  }
  return {
    ...input,
    name: basename(input.path),
    fullName,
    status: "ready",
    message: "Repository policy is valid and ready for a local Run.",
    warnings: config.warnings,
  };
}

function toPublicRepository(repository: RepositoryRecord): PublicRepository {
  const { path: _path, ...publicRepository } = repository;
  return publicRepository;
}

function toPublicEvent(event: RunEvent): PublicRunEvent {
  const stage = "stage" in event ? event.stage : null;
  const stageAttempt = "stageAttempt" in event ? event.stageAttempt : null;
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    stage,
    stageAttempt,
    summary: eventSummary(event),
  };
}

function eventSummary(event: RunEvent): string {
  switch (event.type) {
    case "run.started":
      return "Run accepted by Runner";
    case "run.finished":
      return event.payload.status === "succeeded"
        ? "Run completed"
        : `Run failed: ${event.payload.failureCode}`;
    case "stage.started":
      return `${event.stage} Stage started`;
    case "stage.finished":
      return `${event.stage} Stage passed`;
    case "stage.failed":
      return `${event.stage} Stage failed: ${event.payload.failureCode}`;
    case "activity.started":
      return `${event.payload.activity} started`;
    case "activity.finished":
      return `${event.payload.activity} passed`;
    case "activity.failed":
      return `${event.payload.activity} failed`;
    case "implementation.iteration_started":
      return `Implementation iteration ${event.payload.iteration}/${event.payload.maxIterations}`;
    case "command.started":
      return `${event.payload.command} started`;
    case "command.finished":
      return `${event.payload.command} ${event.payload.outcome}`;
    case "verification.updated":
      return event.payload.kind === "commands"
        ? `Verification ${event.payload.status}`
        : `Secret guard ${event.payload.status}`;
    case "review.finished":
      return `Independent review ${event.payload.decision}`;
    case "artifact.created":
      return `Artifact created: ${event.payload.name}`;
    case "change.created":
      return `Pull request created: ${event.payload.title}`;
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}

function artifactNames(events: readonly RunEvent[]): string[] {
  const names = new Set<string>([runEventJournalFileName]);
  for (const event of events) {
    if (event.type === "artifact.created") names.add(event.payload.name);
  }
  return [...names].sort();
}

async function readResultFile(path: string): Promise<RunResultFile | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return runResultFileSchema.parse(value);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    return null;
  }
}

const runResultFileSchema = z.object({
  runId: z.string(),
  status: z.enum(["succeeded", "failed"]),
  failureCode: z.enum(failureCodes).nullable(),
  prUrl: z.string().url().nullable(),
});

type RunResultFile = z.infer<typeof runResultFileSchema>;

function createRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `run-${timestamp}-${randomUUID().slice(0, 6)}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_048_576) throw new ControlRoomError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

function contentTypeForArtifact(name: string): string {
  if (name.endsWith(".json") || name.endsWith(".ndjson"))
    return "application/json; charset=utf-8";
  if (name.endsWith(".md") || name.endsWith(".log") || name.endsWith(".patch")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function contentTypeForStaticAsset(name: string): string {
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".map")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function webRootPath(): string {
  return fileURLToPath(new URL("../control-room/", import.meta.url));
}

function failureCodeForError(error: unknown): FailureCode {
  if (error instanceof ControlRoomError && error.status >= 500) return "internal_error";
  return "internal_error";
}

export class ControlRoomError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ControlRoomError";
    this.status = status;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
