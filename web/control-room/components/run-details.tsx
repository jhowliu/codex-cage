import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { Run, Stage, StageAttempt } from "../types";
import { stages } from "../types";
import { fetchText, formatTime, issueNumber } from "../utils";
import { Icon, panelClass, statusPillClass } from "./ui";
import { StageResultContent, useStageResult } from "./stage-results.js";

type StageViewStatus = "pending" | "running" | "succeeded" | "failed";
const detailViews = [
  { id: "results", label: "Results" },
  { id: "events", label: "Events" },
  { id: "artifact", label: "Logs & artifacts" },
] as const;
type DetailView = (typeof detailViews)[number]["id"];

const stageLabels: Record<Stage, string> = {
  prepare: "Prepare",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  publish: "Publish",
};

const stageDescriptions: Record<Stage, string> = {
  prepare: "Issue context, repository resolution, and workspace setup.",
  implement: "Codex implementation iterations and the generated changes.",
  verify: "Repository-defined verification commands and their output.",
  review: "Independent review findings and the publish decision.",
  publish: "Branch, commit, push, and pull request creation.",
};

export function RunDetails({ run }: { run: Run }): JSX.Element {
  const [selectedStage, setSelectedStage] = useState<Stage>(() => defaultStage(run));

  return (
    <div className="grid gap-[18px]">
      <RunSummary run={run} />
      <section className={`${panelClass} p-[21px] max-sm:p-[15px]`}>
        <h2 className="mb-[18px] text-[19px] font-bold tracking-[-0.03em] text-[#29344a]">
          Follow the run one stage at a time
        </h2>
        <StageStepper
          run={run}
          selectedStage={selectedStage}
          onSelect={setSelectedStage}
        />
      </section>
      <StageDetail key={selectedStage} run={run} stage={selectedStage} />
    </div>
  );
}

function RunSummary({ run }: { run: Run }): JSX.Element {
  return (
    <section className={`${panelClass} overflow-hidden`}>
      <div className="flex items-start justify-between gap-5 border-b border-line p-[21px] max-sm:block max-sm:p-[15px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#63728a]">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {run.repositoryName}
            </span>
            <span aria-hidden="true">·</span>
            <span className="break-all font-mono">{run.id}</span>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-3 max-sm:gap-2">
            <h2 className="overflow-hidden text-ellipsis whitespace-nowrap text-[22px] font-bold tracking-[-0.035em] text-ink max-sm:text-[19px]">
              {issueNumber(run.issueUrl)}
            </h2>
            <a
              className="inline-flex min-h-8 shrink-0 items-center gap-1 text-[10px] font-semibold text-blue hover:underline"
              href={run.issueUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open issue <Icon name="external" size={12} />
            </a>
          </div>
        </div>
        <div className="grid shrink-0 justify-items-end gap-2 max-sm:mt-3 max-sm:flex max-sm:items-center max-sm:justify-between">
          <span className={statusPillClass(run.status)}>{run.status}</span>
          {run.prUrl !== null && (
            <a
              className="inline-flex min-h-9 items-center gap-1.5 text-[11px] font-semibold text-blue hover:underline"
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open pull request <Icon name="external" size={13} />
            </a>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-4 divide-x divide-line max-md:grid-cols-2 max-md:divide-x-0 max-md:divide-y max-sm:grid-cols-2">
        <RunMetric
          label="Current stage"
          value={
            run.currentStage
              ? stageLabels[run.currentStage]
              : run.status === "succeeded"
                ? "Completed"
                : run.status === "queued"
                  ? "Queued"
                  : "Stopped"
          }
        />
        <RunMetric
          label="Duration"
          value={formatDuration(run.startedAt, run.finishedAt ?? run.updatedAt)}
        />
        <RunMetric label="Updated" value={formatTime(run.updatedAt)} />
        <RunMetric label="Events" value={run.lastSequence.toString()} />
      </dl>
      {run.failureCode !== null && (
        <p className="m-0 break-words border-t border-[#ffe0e2] bg-[#fff7f7] px-[21px] py-3 text-xs text-[#a1323c] max-sm:px-[15px]">
          Failure: <strong>{run.failureCode}</strong>
        </p>
      )}
    </section>
  );
}

function RunMetric({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}): JSX.Element {
  return (
    <div className="grid min-h-[66px] min-w-0 content-center gap-1 px-[17px] py-3 first:pl-[21px] last:pr-[21px] max-sm:min-h-[62px] max-sm:px-[15px] max-sm:first:pl-[15px] max-sm:last:pr-[15px]">
      <dt className="text-[10px] font-medium text-[#63728a]">{label}</dt>
      <dd
        className={`m-0 text-[13px] font-semibold tabular-nums text-[#44536b] ${wrap ? "break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function StageStepper({
  run,
  selectedStage,
  onSelect,
}: {
  run: Run;
  selectedStage: Stage;
  onSelect: (stage: Stage) => void;
}): JSX.Element {
  return (
    <ol
      className="relative grid grid-cols-5 gap-2 max-sm:grid-cols-1 max-sm:gap-1.5"
      aria-label="Run stages"
    >
      {stages.map((stage, index) => {
        const status = getStageStatus(run, stage);
        const selected = stage === selectedStage;
        return (
          <li className="relative min-w-0" key={stage}>
            {index < stages.length - 1 && (
              <span
                className={`pointer-events-none absolute left-1/2 top-[35px] hidden h-px w-[calc(100%+8px)] -translate-y-1/2 sm:block ${status === "succeeded" ? "bg-[#6e9bea]" : "bg-[#c8d7eb]"}`}
                aria-hidden="true"
              />
            )}
            <button
              className={`group relative z-[1] grid w-full justify-items-center gap-2 rounded-[10px] border border-transparent bg-transparent px-2 py-3 text-center focus-visible:outline-none max-sm:min-h-[60px] max-sm:grid-cols-[38px_minmax(0,1fr)_auto] max-sm:justify-items-start max-sm:gap-2.5 max-sm:px-3 ${selected ? "text-blue" : "text-[#63728a]"}`}
              type="button"
              aria-current={selected ? "step" : undefined}
              aria-label={`${stageLabels[stage]}, ${stageStatusLabel(status)}${selected ? ", selected" : ""}`}
              onClick={() => onSelect(stage)}
            >
              <span
                className={`grid size-[44px] place-items-center rounded-full border-2 font-mono text-[16px] font-bold transition-colors group-focus-visible:outline-[3px] group-focus-visible:outline-offset-[4px] group-focus-visible:outline-[#8db4ff] max-sm:size-[38px] max-sm:text-[14px] ${stageMarkerClass(status, selected)}`}
              >
                {status === "succeeded" ? (
                  <Icon name="check" size={18} />
                ) : status === "failed" ? (
                  <Icon name="alert" size={17} />
                ) : (
                  index + 1
                )}
              </span>
              <strong className="text-xs font-semibold transition-colors group-hover:text-blue max-sm:justify-self-start">
                {stageLabels[stage]}
              </strong>
              <span className="text-[10px] font-medium max-sm:ml-auto">
                {stageStatusLabel(status)}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StageDetail({ run, stage }: { run: Run; stage: Stage }): JSX.Element {
  const [view, setView] = useState<DetailView>("results");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { state: resultState, retry: retryResult } = useStageResult(run, stage);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState("");
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const stageAttempt = latestAttempt(run, stage);
  const stageEvents = run.events.filter(
    (event) => event.stage === stage && event.stageAttempt === stageAttempt?.attempt,
  );
  const artifacts = resultState.status === "ready" ? resultState.result.artifacts : [];
  const stageStatus = getStageStatus(run, stage);
  const panelId = `${run.id}-${stage}-panel`;

  function openArtifact(name: string): void {
    setSelectedArtifact(name);
    setView("artifact");
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? detailViews.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % detailViews.length
            : event.key === "ArrowLeft"
              ? (index - 1 + detailViews.length) % detailViews.length
              : null;
    if (nextIndex === null) return;
    const next = detailViews[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    setView(next.id);
    tabRefs.current[nextIndex]?.focus();
  }

  useEffect(() => {
    if (selectedArtifact !== null && artifacts.includes(selectedArtifact)) return;
    setSelectedArtifact(artifacts[0] ?? null);
  }, [artifacts, selectedArtifact]);

  useEffect(() => {
    if (view !== "artifact" || selectedArtifact === null) return;
    const controller = new AbortController();
    setArtifactLoading(true);
    setArtifactError(null);
    void fetchText(
      `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(selectedArtifact)}`,
      { signal: controller.signal },
    )
      .then((content) => {
        if (!controller.signal.aborted)
          setArtifactContent(formatArtifact(selectedArtifact, content));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setArtifactError(error instanceof Error ? error.message : String(error));
        setArtifactContent("");
      })
      .finally(() => {
        if (!controller.signal.aborted) setArtifactLoading(false);
      });
    return () => controller.abort();
  }, [run.id, run.lastSequence, selectedArtifact, view]);

  return (
    <section className={`${panelClass} min-w-0 overflow-hidden`}>
      <div className="flex items-start justify-between gap-4 border-b border-line p-[21px] max-sm:p-[15px]">
        <div className="min-w-0">
          <h2 className="text-[20px] font-bold tracking-[-0.03em] text-[#29344a]">
            {stageLabels[stage]}
          </h2>
          <p className="mt-1 max-w-[620px] text-xs leading-relaxed text-[#63728a]">
            {stageDescriptions[stage]}
          </p>
        </div>
        <span className={stagePillClass(stageStatus)}>
          {stageStatusLabel(stageStatus)}
        </span>
      </div>
      <dl className="grid grid-cols-3 divide-x divide-line border-b border-line">
        <RunMetric
          label="Attempt"
          value={stageAttempt ? `#${stageAttempt.attempt}` : "—"}
        />
        <RunMetric label="Events" value={stageEvents.length.toString()} />
        <RunMetric label="Failure" value={stageAttempt?.failureCode ?? "None"} wrap />
      </dl>
      <div
        className="flex items-center gap-2 border-b border-line px-[21px] py-3 max-sm:px-[15px]"
        role="tablist"
        aria-label="Stage detail view"
      >
        {detailViews.map((tab, index) => (
          <button
            className={`min-h-11 rounded-lg px-3 text-xs font-semibold transition ${view === tab.id ? "bg-blue-soft text-blue" : "text-[#56657a] hover:bg-[#f8faff] hover:text-blue"}`}
            key={tab.id}
            id={`${panelId}-${tab.id}`}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            aria-controls={panelId}
            tabIndex={view === tab.id ? 0 : -1}
            onKeyDown={(event) => navigateTabs(event, index)}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${view}`}
        tabIndex={0}
      >
        {view === "results" ? (
          <StageResultContent
            state={resultState}
            onRetry={retryResult}
            onOpenArtifact={openArtifact}
          />
        ) : view === "events" ? (
          <EventList events={stageEvents} />
        ) : (
          <ArtifactViewer
            artifacts={artifacts}
            selectedArtifact={selectedArtifact}
            content={artifactContent}
            error={artifactError}
            loading={artifactLoading}
            onSelect={(artifact) => setSelectedArtifact(artifact)}
          />
        )}
      </div>
    </section>
  );
}

function EventList({ events }: { events: Run["events"] }): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="grid min-h-[220px] place-items-center p-6 text-center text-[12px] text-muted">
        No events recorded for this stage yet.
      </div>
    );
  }

  return (
    <ol className="grid max-h-[430px] gap-0 overflow-y-auto px-[21px] py-3 max-sm:px-[15px]">
      {events.map((event) => (
        <li
          className="relative grid grid-cols-[14px_minmax(0,1fr)_auto] gap-3 border-b border-[#edf0f5] py-3 last:border-b-0"
          key={event.eventId}
        >
          <span
            className="mt-1.5 size-2 rounded-full bg-blue shadow-[0_0_0_3px_#edf3ff]"
            aria-hidden="true"
          />
          <span className="grid min-w-0 gap-1">
            <strong className="text-[12px] font-semibold text-[#33415e]">
              {event.summary}
            </strong>
            <span className="font-mono text-[9px] uppercase tracking-[0.04em] text-soft-muted">
              {event.type.replaceAll(".", " ")}
              {event.stageAttempt === null ? "" : ` · attempt ${event.stageAttempt}`}
            </span>
          </span>
          <time
            className="font-mono text-[9px] text-soft-muted"
            dateTime={event.occurredAt}
          >
            {formatTime(event.occurredAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}

function ArtifactViewer({
  artifacts,
  selectedArtifact,
  content,
  error,
  loading,
  onSelect,
}: {
  artifacts: string[];
  selectedArtifact: string | null;
  content: string;
  error: string | null;
  loading: boolean;
  onSelect: (artifact: string) => void;
}): JSX.Element {
  if (artifacts.length === 0) {
    return (
      <div className="grid min-h-[220px] place-items-center p-6 text-center text-[12px] text-muted">
        No logs or artifacts are available for this stage.
      </div>
    );
  }

  return (
    <div className="grid gap-4 p-[21px] max-sm:p-[15px]">
      <div className="flex flex-wrap gap-2" aria-label="Stage artifacts">
        {artifacts.map((artifact) => (
          <button
            className={`inline-flex min-h-11 max-w-full items-center gap-2 break-all rounded-lg border px-3 text-left font-mono text-[11px] transition-colors ${artifact === selectedArtifact ? "border-[#a9c4ff] bg-blue-soft text-blue" : "border-[#dbe3ef] bg-white text-[#63728a] hover:border-[#b9ccef] hover:text-blue"}`}
            key={artifact}
            type="button"
            aria-pressed={artifact === selectedArtifact}
            onClick={() => onSelect(artifact)}
          >
            <span className="shrink-0">
              <Icon name="archive" size={14} />
            </span>
            {artifact}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-[10px] border border-[#dbe3ef] bg-[#fbfcff]">
        <div className="flex items-center justify-between gap-3 border-b border-[#dbe3ef] px-3 py-2.5">
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-[#44536b]">
            {selectedArtifact ?? "Select an artifact"}
          </strong>
          {selectedArtifact !== null && (
            <span className="shrink-0 text-[10px] text-[#63728a]">
              {artifactType(selectedArtifact)}
            </span>
          )}
        </div>
        {loading ? (
          <p className="m-0 p-5 text-xs text-[#63728a]" role="status">
            Loading artifact…
          </p>
        ) : error !== null ? (
          <p className="m-0 break-words p-5 text-xs text-[#a1323c]" role="alert">
            {error}
          </p>
        ) : (
          <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-[1.7] text-[#44536b]">
            {content || "This artifact is empty."}
          </pre>
        )}
      </div>
    </div>
  );
}

function defaultStage(run: Run): Stage {
  if (run.currentStage !== null) return run.currentStage;
  return run.stages.at(-1)?.stage ?? "prepare";
}

function latestAttempt(run: Run, stage: Stage): StageAttempt | undefined {
  return run.stages.filter((attempt) => attempt.stage === stage).at(-1);
}

function getStageStatus(run: Run, stage: Stage): StageViewStatus {
  return latestAttempt(run, stage)?.status ?? "pending";
}

function stageStatusLabel(status: StageViewStatus): string {
  if (status === "succeeded") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Pending";
}

function stageMarkerClass(status: StageViewStatus, selected: boolean): string {
  if (selected && status === "failed") {
    return "border-red bg-red text-white shadow-[0_0_0_5px_#fff0f1]";
  }
  if (selected) {
    return "border-blue bg-blue text-white shadow-[0_0_0_5px_#e8f0ff]";
  }
  if (status === "succeeded")
    return "border-[#7da5ef] bg-blue text-white group-hover:border-blue-dark group-hover:bg-blue-dark";
  if (status === "failed")
    return "border-red bg-red-soft text-[#a1323c] group-hover:bg-[#ffe2e5]";
  if (status === "running") {
    return "border-blue bg-blue-soft text-blue group-hover:bg-[#dce8ff]";
  }
  return "border-[#c8d4e6] bg-[#fbfcff] text-[#63728a] group-hover:border-[#7da5ef] group-hover:bg-blue-soft group-hover:text-blue";
}

function stagePillClass(status: StageViewStatus): string {
  const base =
    "inline-flex min-h-7 shrink-0 items-center rounded-full px-2.5 text-[11px] font-semibold";
  if (status === "succeeded") return `${base} bg-green-soft text-[#14745a]`;
  if (status === "failed") return `${base} bg-red-soft text-[#a1323c]`;
  if (status === "running") return `${base} bg-blue-soft text-blue`;
  return `${base} bg-[#eff2f6] text-[#68768c]`;
}

function formatDuration(start: string | null, end: string | null): string {
  if (start === null) return "Not started";
  const startMs = new Date(start).getTime();
  const endMs = new Date(end ?? new Date().toISOString()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return "—";
  const seconds = Math.floor((endMs - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatArtifact(name: string, content: string): string {
  if (!name.endsWith(".json")) return content;
  try {
    const parsed: unknown = JSON.parse(content);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return content;
  }
}

function artifactType(name: string): string {
  if (name.endsWith(".json")) return "JSON";
  if (name.endsWith(".md")) return "Markdown";
  if (name.endsWith(".patch")) return "Patch";
  if (name.endsWith(".log")) return "Log";
  return "File";
}
