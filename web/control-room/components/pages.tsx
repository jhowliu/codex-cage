import { useMemo } from "react";
import { stages, type Repository, type Run } from "../types";
import { formatTime, issueNumber } from "../utils";
import {
  DetailItem,
  EmptyDetail,
  EmptyState,
  Icon,
  panelClass,
  primaryButtonClass,
  repositoryStatusClass,
  secondaryButtonClass,
  stageToneClass,
  statusPillClass,
  taskIconClass,
} from "./ui";

export function RunsPage({
  runs,
  repositories,
  selectedRun,
  onCreateTask,
  onSelectRun,
  onCancel,
  onAddRepository,
}: {
  runs: Run[];
  repositories: Repository[];
  selectedRun: Run | null;
  onCreateTask: () => void;
  onSelectRun: (id: string) => void;
  onCancel: () => void;
  onAddRepository: () => void;
}): JSX.Element {
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
      <section
        className="grid grid-cols-[minmax(0,1.65fr)_minmax(310px,0.75fr)] gap-[14px] max-lg:grid-cols-1"
        id="runs"
      >
        <div className={`${panelClass} min-w-0 p-[21px] max-sm:p-[15px]`}>
          <div className="flex items-center justify-between gap-[18px] border-b border-line pb-[15px]">
            <h2 className="text-[17px] font-bold tracking-[-0.03em] text-[#29344a]">
              Task activity
            </h2>
            <span className="grid size-[31px] place-items-center rounded-lg border border-[#cbdafa] bg-blue-soft font-mono text-[10px] font-bold text-blue">
              {runs.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div className="grid grid-cols-[minmax(190px,1.5fr)_minmax(74px,0.65fr)_88px_55px_16px] items-center gap-3 px-3 pb-[7px] pl-[52px] pt-4 font-mono text-[8px] tracking-[0.08em] text-soft-muted max-md:grid-cols-[34px_minmax(0,1fr)_78px_16px] max-md:pl-[52px] max-sm:hidden">
            <span>Task</span>
            <span>Stage</span>
            <span className="text-right max-md:hidden">Status</span>
            <span className="text-right max-md:hidden">Updated</span>
            <span />
          </div>
          {runs.length === 0 ? (
            <EmptyState onCreate={onCreateTask} />
          ) : (
            <div className="grid gap-[3px]">
              {runs.map((run) => (
                <TaskRow
                  key={run.id}
                  run={run}
                  selected={run.id === selectedRun?.id}
                  onSelect={() => onSelectRun(run.id)}
                />
              ))}
            </div>
          )}
        </div>
        <aside className="grid content-start gap-[14px] max-lg:grid-cols-[1.2fr_0.8fr] max-md:grid-cols-1">
          <div
            className={`${panelClass} min-h-[405px] min-w-0 bg-gradient-to-b from-[#f4f8ff] via-white to-white p-[21px] max-sm:p-[15px]`}
            id="evidence"
          >
            {selectedRun === null ? (
              <EmptyDetail />
            ) : (
              <RunDetail run={selectedRun} onCancel={onCancel} />
            )}
          </div>
          <div
            className={`${panelClass} min-w-0 bg-gradient-to-b from-[#f4f8ff] via-white to-white p-[21px] max-sm:p-[15px]`}
            id="repository-preview"
          >
            <div className="flex items-center justify-between gap-[18px] border-b border-line pb-3">
              <h2 className="text-[20px] font-bold tracking-[-0.04em] text-[#29344a]">
                Repositories
              </h2>
              <button
                className="grid size-[31px] place-items-center rounded-lg border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
                type="button"
                onClick={onAddRepository}
                aria-label="Register repository"
                title="Register repository"
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            <div className="grid gap-0 pt-[7px]">
              {repositories.length === 0 ? (
                <p className="text-[11px] text-muted">No repositories registered.</p>
              ) : (
                repositories.map((repository) => (
                  <RepositoryRow key={repository.id} repository={repository} />
                ))
              )}
            </div>
          </div>
        </aside>
      </section>
    </>
  );
}

export function RepositoriesPage({
  repositories,
  selectedRepository,
  search,
  onSearchChange,
  onSelectRepository,
  onAddRepository,
}: {
  repositories: Repository[];
  selectedRepository: Repository | undefined;
  search: string;
  onSearchChange: (value: string) => void;
  onSelectRepository: (id: string) => void;
  onAddRepository: () => void;
}): JSX.Element {
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
      <section
        className="grid grid-cols-[minmax(0,1fr)_310px] gap-[18px] max-lg:grid-cols-1"
        id="repositories"
      >
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
          <div className="mt-[29px] grid grid-cols-[minmax(190px,1.45fr)_minmax(100px,0.7fr)_100px_24px] items-center gap-4 border-b border-[#dbe3ef] px-4 pb-[11px] font-mono text-[9px] font-bold text-[#7a8bab] max-sm:grid-cols-[minmax(0,1fr)_86px]">
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
                const selected = repository.id === selectedRepository?.id;
                return (
                  <button
                    className={`relative grid min-h-[76px] w-full grid-cols-[minmax(190px,1.45fr)_minmax(100px,0.7fr)_100px_24px] items-center gap-4 rounded-[10px] border px-4 text-left transition max-sm:grid-cols-[minmax(0,1fr)_86px] ${selected ? "border-[#cbdafa] bg-[#f0f5ff] shadow-[0_4px_12px_rgb(40_87_175_/_5%)]" : "border-transparent hover:border-[#d8e2f3] hover:bg-[#f8faff]"}`}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectRepository(repository.id)}
                    key={repository.id}
                  >
                    {selected && (
                      <span
                        className="absolute bottom-0 left-0 top-0 w-1 rounded-l-[10px] bg-blue"
                        aria-hidden="true"
                      />
                    )}
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-blue-soft text-blue">
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
                    <span className="flex items-center gap-2 text-[12px] font-medium">
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
                    <span className="text-center text-[#7d8daa]" aria-hidden="true">
                      <Icon name="more" size={18} />
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {repositories.length > 0 && (
            <p className="mt-[20px] text-[11px] text-[#8a9ab6]">
              Select a repository to view its configuration.
            </p>
          )}
        </div>
        <aside className="rounded-[12px] border border-[#d6e1f2] bg-gradient-to-b from-[#f4f8ff] to-white p-[21px] shadow-[0_4px_14px_rgb(44_86_159_/_4%)]">
          <h2 className="border-b border-[#dde5f0] pb-[17px] text-[20px] font-bold tracking-[-0.04em] text-[#29344a]">
            Repository details
          </h2>
          {selectedRepository === undefined ? (
            <p className="py-7 text-[11px] text-muted">
              Select a repository to inspect it.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-[#dde5f0] py-[21px]">
                <span className="grid size-12 shrink-0 place-items-center rounded-[11px] bg-[#e6efff] text-blue">
                  <Icon name="repo" size={24} />
                </span>
                <span className="grid min-w-0 gap-1">
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] text-[#29344a]">
                    {selectedRepository.name}
                  </strong>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#7182a2]">
                    {selectedRepository.fullName ?? selectedRepository.message}
                  </span>
                  <span
                    className={`flex items-center gap-2 text-[12px] font-medium ${selectedRepository.status === "ready" ? "text-green" : "text-amber"}`}
                  >
                    <span
                      className={`size-2 rounded-full ${repositoryStatusClass(selectedRepository.status)}`}
                    />
                    {selectedRepository.status === "ready" ? "Ready" : "Review required"}
                  </span>
                </span>
              </div>
              <dl className="grid gap-0">
                <DetailItem
                  label="Source"
                  value={selectedRepository.fullName === null ? "Local" : "GitHub"}
                />
                <DetailItem label="Runner configuration" value=".codex-cage.yml" mono />
                <DetailItem
                  label="Policy status"
                  value={selectedRepository.status.replaceAll("_", " ")}
                />
              </dl>
              {selectedRepository.fullName !== null && (
                <a
                  className="mt-[22px] flex items-center justify-center gap-1.5 text-[12px] font-semibold text-blue hover:underline"
                  href={`https://github.com/${selectedRepository.fullName}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on GitHub <Icon name="external" size={14} />
                </a>
              )}
            </>
          )}
        </aside>
      </section>
    </>
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
  selected,
  onSelect,
}: {
  run: Run;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      className={`grid min-h-[70px] w-full grid-cols-[31px_minmax(190px,1.5fr)_minmax(74px,0.65fr)_88px_55px_16px] items-center gap-3 rounded-[9px] border px-3 py-[9px] text-left transition hover:translate-x-0.5 hover:border-[#cbd9fa] hover:bg-[#f5f8ff] max-md:grid-cols-[34px_minmax(0,1fr)_78px_16px] max-sm:grid-cols-[34px_minmax(0,1fr)_16px] max-sm:min-h-[66px] max-sm:gap-[9px] max-sm:px-[7px] ${selected ? "border-[#cbd9fa] bg-[#f5f8ff]" : "border-transparent bg-transparent"}`}
      type="button"
      onClick={onSelect}
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
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

function RunDetail({ run, onCancel }: { run: Run; onCancel: () => void }): JSX.Element {
  const stageByName = new Map(run.stages.map((stage) => [stage.stage, stage]));
  return (
    <div className="min-w-0">
      <div className="mb-[17px] flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.07em] text-soft-muted">
        <span>Selected task</span>
        <span className="flex items-center gap-1.5 text-green">
          <span className="size-[7px] rounded-full bg-green shadow-[0_0_0_3px_#d8f3e9]" />
          {run.observationMode}
        </span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[21px] font-bold tracking-[-0.03em] text-[#29344a]">
            {issueNumber(run.issueUrl)}
          </h2>
          <p className="mt-1 text-[11px] text-muted">{run.repositoryName}</p>
        </div>
        <span className={statusPillClass(run.status)}>{run.status}</span>
      </div>
      <a
        className="mt-3.5 flex w-fit items-center gap-1.5 font-mono text-[9px] text-blue no-underline hover:underline"
        href={run.issueUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open source issue <Icon name="external" size={13} />
      </a>
      <div className="flex flex-wrap gap-[17px] border-b border-line py-[18px]">
        <Metric label="Events" value={run.lastSequence.toString().padStart(2, "0")} />
        <Metric label="Updated" value={formatTime(run.updatedAt)} />
        {run.failureCode !== null && (
          <Metric label="Failure" value={run.failureCode} danger />
        )}
      </div>
      <div
        className="grid grid-cols-5 gap-[5px] pb-[17px] pt-[19px]"
        aria-label="Run stages"
      >
        {stages.map((stage) => {
          const attempt = stageByName.get(stage);
          const status =
            attempt?.status ?? (run.currentStage === stage ? "running" : "pending");
          return (
            <div
              className={`grid min-w-0 grid-cols-[17px_1fr] items-center gap-[5px] font-mono text-[8px] font-bold uppercase ${stageToneClass(status)}`}
              key={stage}
            >
              <span className="grid size-[17px] place-items-center rounded-full border border-[#d0d7e1]">
                {status === "succeeded" && <Icon name="check" size={11} />}
                {status === "failed" && <Icon name="alert" size={11} />}
                {status === "running" && (
                  <span className="size-[5px] rounded-full bg-blue" />
                )}
              </span>
              <span>{stage}</span>
              {attempt !== undefined && (
                <small className="col-start-2 font-mono text-[8px] font-normal normal-case text-soft-muted">
                  attempt {attempt.attempt}
                </small>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line pt-[15px]">
        <div className="mb-[9px] flex items-baseline justify-between gap-2.5">
          <h3 className="text-sm font-bold text-[#344158]">Latest events</h3>
          <span className="font-mono text-[8px] text-soft-muted">
            {run.events.length} recorded
          </span>
        </div>
        <div className="max-h-[148px] overflow-auto">
          {run.events.length === 0 ? (
            <p className="text-[11px] text-muted">Waiting for the Runner journal...</p>
          ) : (
            run.events
              .slice()
              .reverse()
              .slice(0, 5)
              .map((event) => (
                <div
                  className="grid grid-cols-[27px_8px_minmax(0,1fr)] items-start gap-[7px] border-b border-[#edf0f5] py-[7px]"
                  key={event.eventId}
                >
                  <span className="font-mono text-[8px] leading-[1.4] text-soft-muted">
                    {String(event.sequence).padStart(3, "0")}
                  </span>
                  <span className="mt-[3px] size-[7px] rounded-full bg-[#7fa1ec] shadow-[0_0_0_3px_#edf2ff]" />
                  <span className="grid min-w-0 gap-[3px]">
                    <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-semibold text-[#52617a]">
                      {event.summary}
                    </strong>
                    <small className="font-mono text-[8px] text-soft-muted">
                      {event.stage ?? "run"} · {formatTime(event.occurredAt)}
                    </small>
                  </span>
                </div>
              ))
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-[15px]">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[8px] text-soft-muted">
          {run.id}
        </span>
        <span className="flex gap-1">
          {run.canCancel && (
            <button
              className="inline-flex min-h-[33px] items-center justify-center gap-1.5 rounded-lg border border-[#f1c2c6] bg-red-soft px-2.5 text-[10px] font-bold text-red transition hover:border-[#df929a] hover:bg-[#ffe5e7]"
              type="button"
              onClick={onCancel}
            >
              Stop task
            </button>
          )}
          {run.prUrl !== null && (
            <a
              className={secondaryButtonClass
                .replace("min-h-[41px]", "min-h-[33px]")
                .replace("px-[15px]", "px-2.5")}
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open PR <Icon name="external" size={13} />
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}): JSX.Element {
  return (
    <span className="grid gap-[3px]">
      <b className="font-mono text-[9px] font-normal uppercase text-soft-muted">
        {label}
      </b>
      <em
        className={`font-mono text-[9px] not-italic ${danger ? "text-red" : "text-[#4c5b74]"}`}
      >
        {value}
      </em>
    </span>
  );
}

function RepositoryRow({ repository }: { repository: Repository }): JSX.Element {
  return (
    <div className="grid min-h-[51px] grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-[9px] border-b border-[#edf0f5]">
      <span
        className={`grid size-2 place-items-center rounded-full ${repositoryStatusClass(repository.status)}`}
      />
      <span className="grid min-w-0 gap-1">
        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#44536b]">
          {repository.name}
        </strong>
        <small className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[8px] text-soft-muted">
          {repository.fullName ?? repository.status.replaceAll("_", " ")}
        </small>
      </span>
      <span
        className={`font-mono text-[8px] uppercase ${repository.status === "ready" ? "text-green" : "text-amber"}`}
      >
        {repository.status === "ready" ? "ready" : "review"}
      </span>
    </div>
  );
}
