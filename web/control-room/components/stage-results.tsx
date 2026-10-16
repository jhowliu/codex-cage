import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { ChangeDiff } from "../../../src/control-room-diff.js";
import type { Evidence, StageResult } from "../../../src/control-room-results.js";
import type { Run, Stage } from "../types";
import { fetchJson } from "../utils";
import { Icon, secondaryButtonClass } from "./ui";

type ResultState =
  | { status: "loading" }
  | { status: "ready"; result: StageResult }
  | { status: "error"; message: string };

export function useStageResult(
  run: Run,
  stage: Stage,
): {
  state: ResultState;
  retry: () => void;
} {
  const [state, setState] = useState<ResultState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    void fetchJson<StageResult>(
      `/api/runs/${encodeURIComponent(run.id)}/stages/${stage}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setState({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => controller.abort();
  }, [run.id, run.lastSequence, run.status, stage, revision]);
  return { state, retry: () => setRevision((current) => current + 1) };
}

export function StageResultContent({
  state,
  onRetry,
  onOpenArtifact,
}: {
  state: ResultState;
  onRetry: () => void;
  onOpenArtifact: (name: string) => void;
}): JSX.Element {
  if (state.status === "loading") {
    return (
      <div
        className="grid min-h-[180px] content-start gap-4 p-[21px] max-sm:p-[15px]"
        role="status"
        aria-label="Loading stage results"
      >
        <div className="h-5 w-44 rounded bg-[#edf1f7]" />
        <div className="h-3 w-3/4 rounded bg-[#f1f4f8]" />
        <p className="text-sm text-[#56657a]">Loading results…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid gap-3 p-[21px] max-sm:p-[15px]" role="alert">
        <p className="text-sm font-semibold text-red">Could not load stage results</p>
        <p className="break-words text-sm text-[#56657a]">{state.message}</p>
        <button
          type="button"
          className={`${secondaryButtonClass} justify-self-start`}
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  const result = state.result;
  return (
    <div className="min-w-0 p-[21px] max-sm:p-[15px]">
      <ResultBody result={result} onOpenArtifact={onOpenArtifact} />
    </div>
  );
}

function ResultBody({
  result,
  onOpenArtifact,
}: {
  result: StageResult;
  onOpenArtifact: (name: string) => void;
}): JSX.Element {
  switch (result.stage) {
    case "prepare":
      return (
        <div className="grid gap-5">
          <ResultHeading
            title={
              result.status === "succeeded"
                ? "Workspace ready"
                : result.status === "running"
                  ? "Preparing the workspace"
                  : result.status === "pending"
                    ? "Preparation has not started"
                    : "Preparation stopped"
            }
            copy="Issue context, target branch, and workspace preparation."
          />
          {result.target !== null && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 max-sm:grid-cols-1">
              <ResultField label="Work item" value={result.target.issueTitle} />
              <ResultField label="Repository" value={result.target.repository} mono />
              <ResultField label="Base branch" value={result.target.baseBranch} mono />
              <ResultField label="Run branch" value={result.target.branch} mono />
              <ResultField
                label="Execution"
                value={
                  result.target.executionMode === "docker"
                    ? "Docker workspace"
                    : "Isolated runner (direct)"
                }
              />
            </dl>
          )}
          {result.activities.length > 0 ? (
            <ul className="divide-y divide-line border-y border-line">
              {result.activities.map((activity) => (
                <li
                  key={activity.name}
                  className="flex min-h-12 items-center justify-between gap-4 py-3"
                >
                  <span className="text-sm font-medium text-[#33415e]">
                    {activityLabel(activity.name)}
                  </span>
                  <Outcome status={activity.status} />
                </li>
              ))}
            </ul>
          ) : (
            <ResultNote>
              {result.status === "pending"
                ? "Preparation details will appear when the Runner starts."
                : "No preparation activity was recorded. Check the events and original logs for this run."}
            </ResultNote>
          )}
        </div>
      );
    case "implement": {
      const changes = result.changes;
      return (
        <div className="grid gap-4">
          <ResultHeading
            title="Code changes"
            copy={
              result.iteration === null
                ? "Changes produced by the implementation agent."
                : `Implementation ${result.iteration} of ${result.maxIterations ?? "—"}.`
            }
          />
          {changes.status === "available" ? (
            <DiffViewer
              diff={changes.value}
              onOpenOriginal={() => onOpenArtifact(changes.artifact)}
            />
          ) : (
            <EvidenceNote
              evidence={result.changes}
              onOpenArtifact={onOpenArtifact}
              fallback={
                result.status === "pending"
                  ? "Implementation has not started."
                  : result.status === "running" || result.status === "succeeded"
                    ? "The change preview appears after verification and secret checks, or when a safe final patch is saved."
                    : "No safe change preview was saved. Check the implementation events and original logs."
              }
            />
          )}
        </div>
      );
    }
    case "verify":
      return (
        <div className="grid gap-4">
          <ResultHeading
            title={
              result.verification === null
                ? "Verification commands"
                : result.verification.status === "passed"
                  ? "Verification passed"
                  : "Verification failed"
            }
            copy={
              result.verification === null
                ? "Command results appear as verification progresses."
                : `${result.verification.passedCount} of ${result.verification.commandCount} commands passed.`
            }
          />
          {result.commands.length === 0 ? (
            <ResultNote>
              {result.status === "pending"
                ? "Verification has not started."
                : result.status === "running"
                  ? "Waiting for the first verification command."
                  : "Individual command results are not available for this run. Check the original verification log."}
            </ResultNote>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {result.commands.map((command) => (
                <li
                  key={command.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 py-4 max-sm:grid-cols-1"
                >
                  <div className="grid min-w-0 gap-2">
                    <code className="break-words text-sm text-[#33415e]">
                      {command.command}
                    </code>
                    <span className="text-xs text-[#5f6d80]">
                      Exit code: {command.exitCode ?? "—"}
                      {command.finishedAt === null
                        ? ""
                        : ` · ${elapsed(command.startedAt, command.finishedAt)}`}
                    </span>
                  </div>
                  <Outcome
                    status={
                      result.status === "aborted" && command.outcome === "running"
                        ? "aborted"
                        : command.outcome
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div>
              <p className="text-sm font-semibold text-[#33415e]">Secret check</p>
              <p className="mt-1 text-xs leading-relaxed text-[#5f6d80]">
                Changes are checked before independent review and publishing.
              </p>
            </div>
            {result.secretGuard === null ? (
              <span className="text-xs text-[#5f6d80]">
                {result.status === "pending" || result.status === "running"
                  ? "Not run yet"
                  : "Not recorded"}
              </span>
            ) : (
              <Outcome
                status={result.secretGuard === "passed" ? "succeeded" : "failed"}
              />
            )}
          </div>
        </div>
      );
    case "review": {
      const report = result.report.status === "available" ? result.report.value : null;
      const verdict = result.verdict;
      return (
        <div className="grid gap-4">
          <ResultHeading
            title={
              verdict?.decision === "pass"
                ? "Review passed"
                : verdict?.decision === "blocking"
                  ? "Changes requested"
                  : result.status === "pending"
                    ? "Review has not started"
                    : result.status === "running"
                      ? "Independent review in progress"
                      : "Review did not produce a result"
            }
            copy={
              verdict?.summary ??
              "The reviewer checks the change independently against the work item."
            }
          />
          {verdict !== null && (
            <p className="text-sm text-[#56657a]">
              {verdict.findingCount} {verdict.findingCount === 1 ? "finding" : "findings"}
              {report === null
                ? " recorded"
                : ` · ${report.findings.filter((finding) => finding.severity === "blocking").length} blocking`}
            </p>
          )}
          {report !== null ? (
            report.findings.length === 0 ? (
              <div className="flex items-center gap-2 border-t border-line pt-4 text-sm text-[#14745a]">
                <Icon name="check" size={18} />
                No findings reported.
              </div>
            ) : (
              <ol className="divide-y divide-line border-y border-line">
                {report.findings.map((finding, index) => (
                  <li
                    className="grid gap-3 py-4"
                    key={`${index}-${finding.path ?? "finding"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2 py-1 text-xs font-semibold ${finding.severity === "blocking" ? "bg-red-soft text-[#a1323c]" : "bg-amber-soft text-[#83520f]"}`}
                      >
                        {finding.severity === "blocking" ? "Blocking" : "Suggestion"}
                      </span>
                      {finding.path !== undefined && (
                        <code className="break-all text-xs text-[#56657a]">
                          {finding.path}
                          {finding.line === undefined ? "" : `:${finding.line}`}
                        </code>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#33415e]">
                      {finding.message}
                    </p>
                  </li>
                ))}
              </ol>
            )
          ) : (
            <EvidenceNote
              evidence={result.report}
              onOpenArtifact={onOpenArtifact}
              fallback={
                verdict === null && result.status === "pending"
                  ? "Review details will appear after verification passes."
                  : verdict === null && result.status === "running"
                    ? "The review report will appear when the reviewer finishes."
                    : undefined
              }
            />
          )}
        </div>
      );
    }
    case "publish":
      return (
        <div className="grid gap-5">
          <ResultHeading
            title={
              result.change !== null
                ? "Pull request created"
                : result.status === "pending"
                  ? "Publishing has not started"
                  : result.status === "running"
                    ? "Publishing the change"
                    : "No pull request was recorded"
            }
            copy={
              result.change?.title ??
              "The Runner publishes after verification, secret checks, and review pass."
            }
          />
          {result.change === null ? (
            <ResultNote>
              {result.status === "failed" || result.status === "aborted"
                ? "Publishing did not complete. Check the events and original publish log."
                : "Branch and pull request details will appear after publishing."}
            </ResultNote>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 max-sm:grid-cols-1">
                <ResultField label="Branch" value={result.change.branch} mono />
                <ResultField
                  label="Base branch"
                  value={result.change.baseBranch ?? "Not recorded"}
                  mono
                />
                <ResultField label="Commit message" value={result.change.commitMessage} />
              </dl>
              {result.change.url !== null ? (
                <a
                  className="inline-flex min-h-11 items-center justify-self-start gap-2 rounded-lg bg-blue px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-dark"
                  href={result.change.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request
                  <Icon name="external" size={15} />
                </a>
              ) : (
                <ResultNote>
                  The recorded pull request link is unavailable. Check the original
                  publish metadata.
                </ResultNote>
              )}
            </>
          )}
        </div>
      );
    default: {
      const exhaustive: never = result;
      throw new Error(`Unknown stage result: ${exhaustive}`);
    }
  }
}

function DiffViewer({
  diff,
  onOpenOriginal,
}: {
  diff: ChangeDiff;
  onOpenOriginal: () => void;
}): JSX.Element {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[#56657a]">
          {diff.files.length} {diff.files.length === 1 ? "file" : "files"} in preview{" "}
          <span className="ml-2 text-[#14745a]">+{diff.additions}</span>{" "}
          <span className="ml-1 text-[#a1323c]">−{diff.deletions}</span>
        </p>
        <button
          className="min-h-11 text-sm font-semibold text-blue hover:underline"
          type="button"
          onClick={onOpenOriginal}
        >
          View original patch
        </button>
      </div>
      {diff.truncated && (
        <ResultNote>
          This preview is limited. Open the original patch to inspect the full change.
        </ResultNote>
      )}
      {diff.files.length === 0 ? (
        <ResultNote>
          No file changes were saved in this patch. For an older completed run, inspect
          the pull request to see the published changes.
        </ResultNote>
      ) : (
        <div className="min-w-0 divide-y divide-line overflow-hidden rounded-lg border border-line">
          {diff.files.map((file, index) => (
            <details
              className="group/diff min-w-0"
              key={`${index}-${file.path}`}
              open={index === 0}
            >
              <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 bg-[#f6f8fc] px-3 py-3 text-sm text-[#33415e] transition-colors hover:bg-[#eef3fa] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#8db4ff] [&::-webkit-details-marker]:hidden">
                <span className="shrink-0 text-[#63728a] transition-transform group-open/diff:rotate-90">
                  <Icon name="chevron-right" size={14} />
                </span>
                <code className="min-w-0 flex-1 break-all">{file.path}</code>
                <span className="text-xs capitalize text-[#5f6d80]">{file.kind}</span>
                <span className="text-xs text-[#14745a]">+{file.additions}</span>
                <span className="text-xs text-[#a1323c]">−{file.deletions}</span>
              </summary>
              {file.kind === "renamed" && file.previousPath !== null && (
                <p className="break-all border-t border-line px-3 py-2 text-xs text-[#5f6d80]">
                  Renamed from {file.previousPath}
                </p>
              )}
              {file.binary ? (
                <p className="p-4 text-sm text-[#56657a]">
                  Binary file changed. Open the original patch or pull request for
                  details.
                </p>
              ) : file.lines.length === 0 ? (
                <p className="p-4 text-sm text-[#56657a]">
                  File metadata changed; no text diff is available.
                </p>
              ) : (
                <div
                  className="max-h-[440px] overflow-auto border-t border-line"
                  tabIndex={0}
                  aria-label={`Diff for ${file.path}`}
                >
                  <pre className="m-0 min-w-max py-2 font-mono text-xs leading-6">
                    {file.lines.map((line, lineIndex) => (
                      <span
                        className={`block min-h-6 px-3 ${line.kind === "added" ? "bg-[#edf8f1] text-[#176244]" : line.kind === "removed" ? "bg-[#fff0f1] text-[#9c303a]" : line.kind === "hunk" ? "bg-[#edf3ff] text-[#345d9c]" : "text-[#44536b]"}`}
                        key={lineIndex}
                      >
                        {line.text}
                      </span>
                    ))}
                  </pre>
                </div>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultHeading({ title, copy }: { title: string; copy: string }): JSX.Element {
  return (
    <div>
      <h3 className="text-base font-semibold tracking-[-0.02em] text-[#29344a]">
        {title}
      </h3>
      <p className="mt-2 max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-relaxed text-[#56657a]">
        {copy}
      </p>
    </div>
  );
}

function ResultField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[#5f6d80]">{label}</dt>
      <dd
        className={`mt-1.5 break-words text-sm font-medium text-[#33415e] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function ResultNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="break-words rounded-lg bg-[#f5f7fb] px-4 py-3 text-sm leading-relaxed text-[#56657a]">
      {children}
    </p>
  );
}

function EvidenceNote({
  evidence,
  fallback,
  onOpenArtifact,
}: {
  evidence: Evidence<unknown>;
  fallback?: string | undefined;
  onOpenArtifact: (name: string) => void;
}): JSX.Element {
  if (evidence.status === "available") return <></>;
  const artifact = evidence.artifact;
  return (
    <div className="grid justify-items-start gap-2">
      <ResultNote>
        {evidence.status === "unavailable" &&
        evidence.artifact === null &&
        fallback !== undefined
          ? fallback
          : evidence.message}
      </ResultNote>
      {artifact !== null && (
        <button
          className="min-h-11 text-sm font-semibold text-blue hover:underline"
          type="button"
          onClick={() => onOpenArtifact(artifact)}
        >
          Inspect original evidence
        </button>
      )}
    </div>
  );
}

function Outcome({
  status,
}: {
  status: "running" | "succeeded" | "failed" | "timed_out" | "aborted";
}): JSX.Element {
  const labels = {
    running: "Running",
    succeeded: "Passed",
    failed: "Failed",
    timed_out: "Timed out",
    aborted: "Interrupted",
  } as const;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 justify-self-start whitespace-nowrap rounded px-2 py-1 text-xs font-semibold ${status === "succeeded" ? "bg-green-soft text-[#14745a]" : status === "running" ? "bg-blue-soft text-blue" : "bg-red-soft text-[#a1323c]"}`}
    >
      <Icon
        name={status === "succeeded" ? "check" : status === "running" ? "runs" : "alert"}
        size={13}
      />
      {labels[status]}
    </span>
  );
}

function activityLabel(name: string): string {
  const labels: Record<string, string> = {
    preflight: "Issue and repository checks",
    runtime_image: "Runtime image",
    cloning: "Repository workspace",
    setup: "Dependencies and setup",
  };
  return labels[name] ?? name;
}

function elapsed(start: string, end: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1_000));
  if (!Number.isFinite(seconds)) return "Duration unavailable";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
