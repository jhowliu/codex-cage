import { useMemo, useState, type JSX } from "react";
import type { Repository, Run } from "../types";
import { formatTime, issueNumber } from "../utils";
import { RunDetails } from "./run-details";
import {
  EmptyState,
  Icon,
  panelClass,
  primaryButtonClass,
  repositoryStatusClass,
  secondaryButtonClass,
  statusPillClass,
  taskIconClass,
} from "./ui";

export function RunsPage({
  runs,
  selectedRun,
  onCreateTask,
  onSelectRun,
  onBack,
}: {
  runs: Run[];
  selectedRun: Run | undefined;
  onCreateTask: () => void;
  onSelectRun: (runId: string) => void;
  onBack: () => void;
}): JSX.Element {
  if (selectedRun !== undefined) {
    return (
      <>
        <PageHeading
          title="Run details"
          copy={`${selectedRun.repositoryName} · ${issueNumber(selectedRun.issueUrl)}`}
          action={
            <button
              className={`${secondaryButtonClass} max-sm:mt-[18px] max-sm:w-full`}
              type="button"
              onClick={onBack}
            >
              <Icon name="chevron-right" size={15} className="rotate-180" />
              Back to runs
            </button>
          }
        />
        <RunDetails key={selectedRun.id} run={selectedRun} />
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="Runs"
        copy="Every task has a trace. Watch each stage without losing the evidence trail."
        action={
          <button
            className={`${primaryButtonClass} max-sm:mt-[18px] max-sm:w-full`}
            type="button"
            onClick={onCreateTask}
          >
            <Icon name="plus" size={17} />
            New task
          </button>
        }
      />
      <section id="runs">
        <div className={`${panelClass} min-w-0 p-[21px] max-sm:p-[15px]`}>
          <div className="flex items-center justify-between gap-[18px] border-b border-line pb-[15px]">
            <h2 className="text-[17px] font-bold tracking-[-0.03em] text-[#29344a]">
              Task activity
            </h2>
            <span className="grid size-[31px] place-items-center rounded-lg border border-[#cbdafa] bg-blue-soft font-mono text-[10px] font-bold text-blue">
              {runs.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(190px,1.5fr)_minmax(74px,0.65fr)_88px_55px] items-center gap-3 px-3 pb-[7px] pl-[52px] pt-4 font-mono text-[8px] tracking-[0.08em] text-soft-muted max-md:grid-cols-[minmax(0,1fr)_78px_88px] max-sm:hidden">
            <span>Task</span>
            <span>Stage</span>
            <span className="text-right">Status</span>
            <span className="text-right max-md:hidden">Updated</span>
          </div>
          {runs.length === 0 ? (
            <EmptyState onCreate={onCreateTask} />
          ) : (
            <div className="grid gap-[3px]">
              {runs.map((run) => (
                <TaskRow key={run.id} run={run} onSelect={onSelectRun} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export function RepositoriesPage({
  repositories,
  search,
  onSearchChange,
  onSelectRepository,
  onAddRepository,
}: {
  repositories: Repository[];
  search: string;
  onSearchChange: (value: string) => void;
  onSelectRepository: (id: string) => void;
  onAddRepository: () => void;
}): JSX.Element {
  const [expandedRepositoryId, setExpandedRepositoryId] = useState<string | null>(null);
  const filteredRepositories = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return repositories.filter((repository) => {
      if (normalizedSearch === "") return true;
      return `${repository.name} ${repository.fullName ?? ""}`
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [repositories, search]);

  return (
    <>
      <PageHeading
        title="Repositories"
        copy="Connect repositories and manage their configuration."
        action={
          <button
            className={`${primaryButtonClass} max-sm:mt-[18px] max-sm:w-full`}
            type="button"
            onClick={onAddRepository}
          >
            <Icon name="plus" size={17} />
            Add repository
          </button>
        }
      />
      <section id="repositories">
        <div className="min-w-0">
          <label className="relative block max-w-[410px]">
            <span className="sr-only">Search repositories</span>
            <Icon
              name="search"
              size={18}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#50617f]"
            />
            <input
              className="h-[52px] w-full rounded-[10px] border border-[#d9e2f1] bg-white pl-[43px] pr-4 text-[13px] text-ink shadow-[0_3px_10px_rgb(37_71_133_/_4%)] outline-none transition placeholder:text-[#95a3ba] focus:border-[#88aefc] focus:ring-4 focus:ring-[#dfeaff]"
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search repositories..."
            />
          </label>
          <div className="mt-[29px] grid grid-cols-[minmax(190px,1.45fr)_minmax(100px,0.7fr)_100px_24px] items-center gap-4 border-b border-[#dbe3ef] px-4 pb-[11px] font-mono text-[9px] font-bold text-[#7a8bab] max-sm:grid-cols-[minmax(0,1fr)_68px_18px] max-sm:gap-2 max-sm:px-3">
            <span>Repository</span>
            <span className="max-sm:hidden">Source</span>
            <span>Status</span>
            <span />
          </div>
          <div className="grid gap-1 pt-1">
            {filteredRepositories.length === 0 ? (
              <div className="grid min-h-[155px] place-items-center rounded-[10px] border border-dashed border-[#cbd6e8] p-6 text-center text-[11px] text-muted">
                {repositories.length === 0
                  ? "No repositories registered yet."
                  : "No repositories match this search."}
              </div>
            ) : (
              filteredRepositories.map((repository) => {
                const expanded = repository.id === expandedRepositoryId;
                const detailsId = `repository-${repository.id}-details`;
                return (
                  <div key={repository.id}>
                    <button
                      className={`relative grid min-h-[76px] w-full grid-cols-[minmax(190px,1.45fr)_minmax(100px,0.7fr)_100px_24px] items-center gap-4 border px-4 text-left transition max-sm:grid-cols-[minmax(0,1fr)_68px_18px] max-sm:gap-2 max-sm:px-3 ${expanded ? "rounded-t-[10px] border-[#cbdafa] bg-[#f0f5ff] shadow-[0_4px_12px_rgb(40_87_175_/_5%)]" : "rounded-[10px] border-transparent hover:border-[#d8e2f3] hover:bg-[#f8faff]"}`}
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => {
                        onSelectRepository(repository.id);
                        setExpandedRepositoryId((currentId) =>
                          currentId === repository.id ? null : repository.id,
                        );
                      }}
                    >
                      {expanded && (
                        <span
                          className="absolute bottom-0 left-0 top-0 w-1 rounded-tl-[10px] bg-blue"
                          aria-hidden="true"
                        />
                      )}
                      <span className="flex min-w-0 items-center gap-3 max-sm:gap-2">
                        <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-blue-soft text-blue max-sm:size-9">
                          <Icon name="repo" size={22} />
                        </span>
                        <span className="grid min-w-0 gap-1">
                          <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-[#29344a]">
                            {repository.name}
                          </strong>
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#7788a7]">
                            {repository.fullName ?? repository.message}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-[12px] text-[#42506a] max-sm:hidden">
                        <span className="grid size-5 place-items-center rounded-full bg-[#202b3c] text-white">
                          <Icon name="github" size={13} />
                        </span>
                        {repository.fullName === null ? "Local" : "GitHub"}
                      </span>
                      <span className="flex items-center gap-2 text-[12px] font-medium max-sm:gap-1.5 max-sm:text-[11px]">
                        <span
                          className={`size-2 rounded-full ${repositoryStatusClass(repository.status)}`}
                        />
                        <span
                          className={
                            repository.status === "ready" ? "text-green" : "text-amber"
                          }
                        >
                          {repository.status === "ready" ? "Ready" : "Review"}
                        </span>
                      </span>
                      <span
                        className="grid place-items-center text-[#7d8daa]"
                        aria-hidden="true"
                      >
                        <Icon
                          name="chevron-right"
                          size={18}
                          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                        />
                      </span>
                    </button>
                    {expanded && (
                      <RepositoryInlineDetails id={detailsId} repository={repository} />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function RepositoryInlineDetails({
  id,
  repository,
}: {
  id: string;
  repository: Repository;
}): JSX.Element {
  return (
    <div
      className="-mt-px grid grid-cols-[repeat(3,minmax(0,1fr))_auto] items-center gap-4 rounded-b-[10px] border border-[#cbdafa] bg-[#f8faff] px-4 py-3 shadow-[0_5px_12px_rgb(40_87_175_/_4%)] max-md:grid-cols-2"
      id={id}
    >
      <RepositoryDetail
        label="Source"
        value={repository.fullName === null ? "Local" : "GitHub"}
      />
      <RepositoryDetail label="Runner config" value=".codex-cage.yml" mono />
      <RepositoryDetail
        label="Policy status"
        value={repository.status === "ready" ? "Ready" : "Review required"}
      />
      {repository.fullName !== null && (
        <a
          className="inline-flex min-h-10 items-center justify-self-end gap-1.5 whitespace-nowrap text-[12px] font-semibold text-blue hover:underline max-md:justify-self-start"
          href={`https://github.com/${repository.fullName}`}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <Icon name="external" size={14} />
        </a>
      )}
    </div>
  );
}

function RepositoryDetail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <span className="grid min-w-0 gap-1">
      <small className="text-[9px] font-semibold uppercase tracking-[0.04em] text-[#8292ad]">
        {label}
      </small>
      <strong
        className={`${mono ? "font-mono" : ""} overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium text-[#33415e]`}
        title={value}
      >
        {value}
      </strong>
    </span>
  );
}

function PageHeading({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action: JSX.Element;
}): JSX.Element {
  return (
    <section className="mb-[26px] flex items-center justify-between gap-7 max-sm:block">
      <div>
        <h1 className="mb-1 text-[clamp(28px,3vw,42px)] font-bold leading-none tracking-[-0.06em] text-ink">
          {title}
        </h1>
        <p className="m-0 max-w-[560px] text-xs text-muted">{copy}</p>
      </div>
      {action}
    </section>
  );
}

function TaskRow({
  run,
  onSelect,
}: {
  run: Run;
  onSelect: (runId: string) => void;
}): JSX.Element {
  return (
    <button
      className="grid min-h-[70px] w-full grid-cols-[31px_minmax(190px,1.5fr)_minmax(74px,0.65fr)_88px_55px] items-center gap-3 rounded-[9px] border border-transparent bg-transparent px-3 py-[9px] text-left transition hover:border-[#d8e2f3] hover:bg-[#f8faff] max-md:grid-cols-[34px_minmax(0,1fr)_78px_88px] max-sm:min-h-[66px] max-sm:grid-cols-[34px_minmax(0,1fr)_88px] max-sm:gap-[9px] max-sm:px-[7px]"
      type="button"
      onClick={() => onSelect(run.id)}
      aria-label={`Open details for ${issueNumber(run.issueUrl)}`}
    >
      <span
        className={`grid size-[31px] place-items-center rounded-[9px] ${taskIconClass(run.status)}`}
        aria-hidden="true"
      >
        <Icon
          name={
            run.status === "succeeded"
              ? "check"
              : run.status === "failed"
                ? "alert"
                : "task"
          }
          size={16}
        />
      </span>
      <span className="grid min-w-0 gap-1">
        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[#31405a]">
          {issueNumber(run.issueUrl)}
        </strong>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9px] text-soft-muted">
          {run.repositoryName} · {run.id}
        </span>
      </span>
      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase text-[#5574ae] max-sm:hidden">
        <span className="size-1.5 rounded-full bg-blue shadow-[0_0_0_3px_#edf3ff]" />
        {run.currentStage ?? "queued"}
      </span>
      <span className={`justify-self-end ${statusPillClass(run.status)}`}>
        {run.status}
      </span>
      <span className="overflow-hidden text-right font-mono text-[9px] text-soft-muted max-md:hidden">
        {formatTime(run.updatedAt)}
      </span>
    </button>
  );
}
