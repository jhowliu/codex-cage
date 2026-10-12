export const stages = ["prepare", "implement", "verify", "review", "publish"] as const;
export type Stage = (typeof stages)[number];

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "unknown";
export type RepositoryStatus = "setup_required" | "invalid_config" | "ready" | "blocked";
export type PageName = "runs" | "repositories";
export type IconName =
  | "alert"
  | "archive"
  | "check"
  | "chevron-right"
  | "close"
  | "external"
  | "grid"
  | "github"
  | "info"
  | "more"
  | "plus"
  | "refresh"
  | "repo"
  | "runs"
  | "search"
  | "shield"
  | "task";

export type Repository = {
  id: string;
  name: string;
  fullName: string | null;
  status: RepositoryStatus;
  message: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};

export type StageAttempt = {
  stage: Stage;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
};

export type RunEvent = {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  stage: Stage | null;
  stageAttempt: number | null;
  summary: string;
};

export type Run = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  issueUrl: string;
  status: RunStatus;
  observationMode: "live" | "polling" | "artifacts";
  currentStage: Stage | null;
  stages: StageAttempt[];
  lastSequence: number;
  failureCode: string | null;
  prUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canCancel: boolean;
  events: RunEvent[];
  artifacts: string[];
};

export type Snapshot = { repositories: Repository[]; runs: Run[] };

export const emptySnapshot: Snapshot = { repositories: [], runs: [] };
export const stepLabels = ["Repository", "Work item", "Review & launch"] as const;
