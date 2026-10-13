import { useEffect, useState } from "react";
import type { Run, Stage, StageAttempt } from "../types";
import { stages } from "../types";
import { fetchText, formatTime, issueNumber } from "../utils";
import { Icon, panelClass, statusPillClass } from "./ui";

type StageViewStatus = "pending" | "running" | "succeeded" | "failed";
type DetailView = "events" | "artifact";

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
        <div className="mb-[18px] flex items-start justify-between gap-4">
          <div>
            <p className="m-0 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-soft-muted">
              Stage timeline
            </p>
            <h2 className="mt-1 text-[19px] font-bold tracking-[-0.04em] text-[#29344a]">
              Follow the run one stage at a time
            </h2>
          </div>
          <span className="hidden rounded-lg border border-[#dbe3ef] bg-[#fbfcff] px-2.5 py-2 font-mono text-[9px] text-soft-muted max-sm:block">
            {run.lastSequence.toString().padStart(2, "0")} events
          </span>
        </div>
        <StageStepper
          run={run}
          selectedStage={selectedStage}
          onSelect={setSelectedStage}
        />
      </section>
      <StageDetail run={run} stage={selectedStage} />
    </div>
  );
}

function RunSummary({ run }: { run: Run }): JSX.Element {
  return (
    <section className={`${panelClass} overflow-hidden`}>
      <div className="flex items-start justify-between gap-5 border-b border-line p-[21px] max-sm:block max-sm:p-[15px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {run.repositoryName}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{run.id}</span>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-3 max-sm:gap-2">
            <h2 className="overflow-hidden text-ellipsis whitespace-nowrap text-[22px] font-bold tracking-[-0.045em] text-ink max-sm:text-[19px]">
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
          value={run.currentStage ? stageLabels[run.currentStage] : "Queued"}
        />
        <RunMetric
          label="Duration"
          value={formatDuration(run.startedAt, run.finishedAt ?? run.updatedAt)}
        />
        <RunMetric label="Updated" value={formatTime(run.updatedAt)} />
        <RunMetric label="Events" value={run.lastSequence.toString()} />
      </dl>
      {run.failureCode !== null && (
        <p className="m-0 border-t border-[#ffe0e2] bg-[#fff7f7] px-[21px] py-3 text-[11px] text-red max-sm:px-[15px]">
          Failure: <strong>{run.failureCode}</strong>
        </p>
      )}
    </section>
  );
}

function RunMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="grid min-h-[70px] content-center gap-1 px-[17px] py-3 first:pl-[21px] last:pr-[21px] max-sm:min-h-[62px] max-sm:px-[15px] max-sm:first:pl-[15px] max-sm:last:pr-[15px]">
      <dt className="font-mono text-[8px] font-bold uppercase tracking-[0.06em] text-soft-muted">
        {label}
      </dt>
      <dd className="m-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold text-[#44536b]">
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
    <div className="grid grid-cols-5 gap-2 max-sm:grid-cols-1 max-sm:gap-1.5">
      {stages.map((stage, index) => {
        const status = getStageStatus(run, stage);
        const selected = stage === selectedStage;
        return (
          <button
            className={`relative grid min-h-[88px] content-center justify-items-center gap-2 rounded-[10px] border px-2 py-3 text-center transition max-sm:min-h-[56px] max-sm:grid-cols-[38px_minmax(0,1fr)_auto] max-sm:justify-items-start max-sm:gap-2.5 max-sm:px-3 ${selected ? "border-[#a9c4ff] bg-[#f0f5ff] text-blue shadow-[0_4px_12px_rgb(40_87_175_/_6%)]" : "border-[#e3e8f0] bg-white text-[#7788a7] hover:border-[#cbdafa] hover:bg-[#f8faff]"}`}
            type="button"
            aria-current={selected ? "step" : undefined}
            aria-label={`${stageLabels[stage]}, ${stageStatusLabel(status)}${selected ? ", selected" : ""}`}
            onClick={() => onSelect(stage)}
          >
            <span
              className={`grid size-[30px] place-items-center rounded-full border font-mono text-[11px] font-bold ${stageMarkerClass(status, selected)}`}
            >
              {status === "succeeded" ? (
                <Icon name="check" size={15} />
              ) : status === "failed" ? (
                <Icon name="alert" size={15} />
              ) : (
                index + 1
              )}
            </span>
            <strong className="text-[11px] font-bold max-sm:justify-self-start">
              {stageLabels[stage]}
            </strong>
            <span className="font-mono text-[8px] uppercase tracking-[0.05em] opacity-80 max-sm:ml-auto">
              {stageStatusLabel(status)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StageDetail({ run, stage }: { run: Run; stage: Stage }): JSX.Element {
  const [view, setView] = useState<DetailView>("events");
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState("");
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const stageEvents = run.events.filter((event) => event.stage === stage);
  const artifacts = run.artifacts;
  const stageAttempt = latestAttempt(run, stage);
  const stageStatus = getStageStatus(run, stage);

  useEffect(() => {
    setView("events");
  }, [stage]);

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
  }, [run.id, selectedArtifact, view]);

  return (
    <section className={`${panelClass} min-w-0 overflow-hidden`}>
      <div className="flex items-start justify-between gap-5 border-b border-line p-[21px] max-sm:block max-sm:p-[15px]">
        <div className="min-w-0">
          <p className="m-0 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-soft-muted">
            Selected stage
          </p>
          <h2 className="mt-1 text-[20px] font-bold tracking-[-0.04em] text-[#29344a]">
            {stageLabels[stage]}
          </h2>
          <p className="mt-1 max-w-[620px] text-[12px] leading-[1.5] text-muted">
            {stageDescriptions[stage]}
          </p>
        </div>
        <span className={stagePillClass(stageStatus)}>
          {stageStatusLabel(stageStatus)}
        </span>
      </div>
      <div className="grid grid-cols-3 divide-x divide-line border-b border-line max-sm:grid-cols-2 max-sm:divide-x-0 max-sm:divide-y">
        <RunMetric
          label="Attempt"
          value={stageAttempt ? `#${stageAttempt.attempt}` : "—"}
        />
        <RunMetric label="Events" value={stageEvents.length.toString()} />
        <RunMetric label="Failure" value={stageAttempt?.failureCode ?? "None"} />
      </div>
      <div
        className="flex items-center gap-2 border-b border-line px-[21px] py-3 max-sm:px-[15px]"
        role="tablist"
        aria-label="Stage detail view"
      >
        <button
          className={`min-h-9 rounded-lg px-3 text-[11px] font-semibold transition ${view === "events" ? "bg-blue-soft text-blue" : "text-muted hover:bg-[#f8faff] hover:text-blue"}`}
          type="button"
          role="tab"
          aria-selected={view === "events"}
          onClick={() => setView("events")}
        >
          Events
        </button>
        <button
          className={`min-h-9 rounded-lg px-3 text-[11px] font-semibold transition ${view === "artifact" ? "bg-blue-soft text-blue" : "text-muted hover:bg-[#f8faff] hover:text-blue"}`}
          type="button"
          role="tab"
          aria-selected={view === "artifact"}
          onClick={() => setView("artifact")}
        >
          Logs & artifacts
        </button>
      </div>
      {view === "events" ? (
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
        No logs or artifacts have been created for this run yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 p-[21px] max-sm:p-[15px]">
      <div className="flex flex-wrap gap-2" aria-label="Run artifacts">
        {artifacts.map((artifact) => (
          <button
            className={`inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-left font-mono text-[10px] transition ${artifact === selectedArtifact ? "border-[#a9c4ff] bg-blue-soft text-blue" : "border-[#dbe3ef] bg-white text-[#63728a] hover:border-[#b9ccef] hover:text-blue"}`}
            key={artifact}
            type="button"
            aria-pressed={artifact === selectedArtifact}
            onClick={() => onSelect(artifact)}
          >
            <Icon name="archive" size={14} />
            {artifact}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-[10px] border border-[#dbe3ef] bg-[#fbfcff]">
        <div className="flex items-center justify-between gap-3 border-b border-[#dbe3ef] px-3 py-2.5">
          <strong className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-[#44536b]">
            {selectedArtifact ?? "Select an artifact"}
          </strong>
          {selectedArtifact !== null && (
            <span className="shrink-0 text-[9px] uppercase tracking-[0.05em] text-soft-muted">
              {artifactType(selectedArtifact)}
            </span>
          )}
        </div>
        {loading ? (
          <p className="m-0 p-5 text-[11px] text-muted">Loading artifact…</p>
        ) : error !== null ? (
          <p className="m-0 p-5 text-[11px] text-red">{error}</p>
        ) : (
          <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap p-4 font-mono text-[10px] leading-[1.6] text-[#44536b]">
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
  if (status === "succeeded") return "border-green bg-green-soft text-green";
  if (status === "failed") return "border-red bg-red-soft text-red";
  if (status === "running") return "border-blue bg-blue-soft text-blue";
  return selected
    ? "border-[#a9c4ff] bg-white text-blue"
    : "border-[#dbe3ef] bg-[#fbfcff] text-[#8292ad]";
}

function stagePillClass(status: StageViewStatus): string {
  const base =
    "inline-flex min-h-[23px] items-center rounded-full px-2.5 font-mono text-[8px] font-bold uppercase";
  if (status === "succeeded") return `${base} bg-green-soft text-green`;
  if (status === "failed") return `${base} bg-red-soft text-red`;
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
