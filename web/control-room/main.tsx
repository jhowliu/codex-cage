import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const stages = ["prepare", "implement", "verify", "review", "publish"] as const;
type Stage = (typeof stages)[number];
type RunStatus = "queued" | "running" | "succeeded" | "failed" | "aborted" | "unknown";
type RepositoryStatus = "setup_required" | "invalid_config" | "ready" | "blocked";
type PageName = "runs" | "repositories";
type IconName =
  | "alert"
  | "archive"
  | "check"
  | "chevron-right"
  | "close"
  | "external"
  | "grid"
  | "github"
  | "more"
  | "plus"
  | "refresh"
  | "repo"
  | "runs"
  | "search"
  | "shield"
  | "task";

type Repository = {
  id: string;
  name: string;
  fullName: string | null;
  status: RepositoryStatus;
  message: string;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};

type StageAttempt = {
  stage: Stage;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
};

type RunEvent = {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: string;
  stage: Stage | null;
  stageAttempt: number | null;
  summary: string;
};

type Run = {
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

type Snapshot = { repositories: Repository[]; runs: Run[] };

const emptySnapshot: Snapshot = { repositories: [], runs: [] };
const stepLabels = ["Repository", "Work item", "Review & launch"] as const;
const panelClass = "rounded-xl border border-line bg-white shadow-panel";
const primaryButtonClass =
  "inline-flex min-h-[41px] items-center justify-center gap-2 rounded-lg border border-transparent bg-blue px-[15px] text-[11px] font-bold text-white shadow-button transition hover:bg-blue-dark hover:shadow-button-hover disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "inline-flex min-h-[41px] items-center justify-center gap-2 rounded-lg border border-[#d5dce7] bg-white px-[15px] text-[11px] font-bold text-[#526178] transition hover:border-[#abc2ed] hover:bg-blue-soft hover:text-blue disabled:cursor-not-allowed disabled:opacity-50";

function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [page, setPage] = useState<PageName>(() => pageFromHash());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositorySearch, setRepositorySearch] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [repositoryModalOpen, setRepositoryModalOpen] = useState(false);
  const [taskStep, setTaskStep] = useState(1);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("Connecting to local Control Room...");
  const [busy, setBusy] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const selectedRun =
    snapshot.runs.find((run) => run.id === selectedRunId) ?? snapshot.runs[0] ?? null;
  const readyRepositories = snapshot.repositories.filter(
    (repository) => repository.status === "ready",
  );
  const activeRuns = snapshot.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  );
  const selectedRepository =
    snapshot.repositories.find((repository) => repository.id === selectedRepositoryId) ??
    snapshot.repositories[0];

  useEffect(() => {
    const syncPage = (): void => setPage(pageFromHash());
    window.addEventListener("hashchange", syncPage);
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource("/api/events");
    stream.addEventListener("snapshot", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
      setSnapshot(next);
      setNotice("Live projection connected");
    });
    stream.onerror = () => setNotice("Live stream interrupted; retrying automatically");
    return () => stream.close();
  }, []);

  useEffect(() => {
    if (selectedRepositoryId === "" && readyRepositories[0] !== undefined) {
      setSelectedRepositoryId(readyRepositories[0].id);
    }
  }, [readyRepositories, selectedRepositoryId]);

  useEffect(() => {
    if (!taskModalOpen && !repositoryModalOpen) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setTaskModalOpen(false);
        setRepositoryModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [repositoryModalOpen, taskModalOpen]);

  async function refresh(): Promise<void> {
    try {
      const [repositories, runs] = await Promise.all([
        fetchJson<Repository[]>("/api/repositories"),
        fetchJson<Run[]>("/api/runs"),
      ]);
      setSnapshot({ repositories, runs });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function openTaskModal(): void {
    setTaskStep(1);
    setFormError("");
    setIssueUrl("");
    setTaskModalOpen(true);
  }

  function closeModals(): void {
    setTaskModalOpen(false);
    setRepositoryModalOpen(false);
    setFormError("");
  }

  function advanceTaskStep(): void {
    if (taskStep === 1 && selectedRepositoryId === "") {
      setFormError("Choose a ready repository before continuing.");
      return;
    }
    if (taskStep === 2 && !isGithubIssueUrl(issueUrl)) {
      setFormError(
        "Enter a GitHub Issue URL, for example https://github.com/org/repo/issues/123.",
      );
      return;
    }
    setFormError("");
    setTaskStep((step) => Math.min(3, step + 1));
  }

  function openRepositoryModal(): void {
    setTaskModalOpen(false);
    setRepositoryPath("");
    setFormError("");
    setRepositoryModalOpen(true);
  }

  async function registerRepository(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (repositoryPath.trim() === "") return;
    await runAction(async () => {
      const repository = await fetchJson<Repository>("/api/repositories", {
        method: "POST",
        body: JSON.stringify({ path: repositoryPath }),
      });
      setRepositoryPath("");
      setSelectedRepositoryId(repository.id);
      setNotice(`${repository.name} is ${repository.status.replaceAll("_", " ")}`);
      setRepositoryModalOpen(false);
      await refresh();
    });
  }

  async function createRun(): Promise<void> {
    if (selectedRepositoryId === "" || !isGithubIssueUrl(issueUrl)) return;
    await runAction(async () => {
      const run = await fetchJson<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ repositoryId: selectedRepositoryId, issueUrl }),
      });
      setIssueUrl("");
      setSelectedRunId(run.id);
      setTaskModalOpen(false);
      setTaskStep(1);
      setNotice(`Task ${run.id} queued`);
      await refresh();
    });
  }

  async function cancelRun(): Promise<void> {
    if (selectedRun === null) return;
    await runAction(async () => {
      await fetchJson<Run>(`/api/runs/${encodeURIComponent(selectedRun.id)}/cancel`, {
        method: "POST",
      });
      setNotice(`Stop requested for ${selectedRun.id}`);
      await refresh();
    });
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh_-_48px)] w-[calc(100%_-_48px)] max-w-[1510px] overflow-hidden rounded-[28px] border border-white/75 bg-[#fbfcff] shadow-shell max-md:m-0 max-md:min-h-screen max-md:w-full max-md:rounded-none max-md:border-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-white px-[18px] pb-6 pt-[30px] max-md:w-[66px] max-md:basis-[66px] max-md:items-center max-md:px-2.5 max-md:py-6">
        <div className="flex items-center gap-[11px] px-2 text-[14px] font-extrabold tracking-[-0.03em] text-ink max-md:px-0">
          <div className="grid size-[38px] place-items-center rounded-[11px] border border-[#bad0ff] bg-blue-soft text-blue">
            <Icon name="grid" size={19} />
          </div>
          <span className="max-md:hidden">Codex Cage</span>
        </div>
        <p className="mb-[15px] mt-[50px] px-2.5 text-[11px] font-semibold tracking-[0.02em] text-[#7b8aa5] max-md:hidden">
          Local control room
        </p>
        <nav
          aria-label="Primary navigation"
          className="grid gap-[5px] max-md:mt-[45px] max-md:w-full"
        >
          <a
            className={`group relative flex min-h-[45px] items-center gap-[11px] rounded-[9px] px-3 text-[13px] font-semibold transition hover:bg-blue-soft max-md:justify-center max-md:px-0 ${page === "runs" ? "bg-blue-soft text-blue" : "text-[#66738b] hover:text-blue"}`}
            href="#runs"
            aria-current={page === "runs" ? "page" : undefined}
          >
            {page === "runs" && (
              <span className="absolute -left-[18px] top-[11px] bottom-[11px] w-[3px] rounded-r-[3px] bg-blue max-md:-left-2.5" />
            )}
            <Icon name="runs" size={17} />
            <span className="max-md:hidden">Runs</span>
            <span className="ml-auto min-w-[19px] rounded-lg bg-[#dbe8ff] px-[5px] py-0.5 text-center font-mono text-[9px] font-bold text-blue max-md:hidden">
              {activeRuns.length}
            </span>
          </a>
          <a
            className={`relative flex min-h-[45px] items-center gap-[11px] rounded-[9px] px-3 text-[13px] font-semibold transition hover:bg-blue-soft max-md:justify-center max-md:px-0 ${page === "repositories" ? "bg-blue-soft text-blue" : "text-[#66738b] hover:text-blue"}`}
            href="#repositories"
            aria-current={page === "repositories" ? "page" : undefined}
          >
            {page === "repositories" && (
              <span className="absolute -left-[18px] top-[11px] bottom-[11px] w-[3px] rounded-r-[3px] bg-blue max-md:-left-2.5" />
            )}
            <Icon name="repo" size={17} />
            <span className="max-md:hidden">Repositories</span>
          </a>
          <a
            className="flex min-h-[45px] items-center gap-[11px] rounded-[9px] px-3 text-[13px] font-semibold text-[#66738b] transition hover:bg-blue-soft hover:text-blue max-md:justify-center max-md:px-0"
            href="#evidence"
          >
            <Icon name="archive" size={17} />
            <span className="max-md:hidden">Evidence</span>
          </a>
        </nav>
        <div className="mt-auto grid gap-[23px] max-md:hidden">
          <div className="flex items-start gap-[9px] rounded-[10px] border border-[#e6ebf2] bg-[#fbfdfc] p-[13px_11px] text-green">
            <Icon name="shield" size={15} />
            <span className="grid gap-[3px]">
              <strong className="text-[10px] text-[#3a5066]">Loopback only</strong>
              <small className="font-mono text-[9px] text-soft-muted">
                Runner stays authoritative
              </small>
            </span>
          </div>
          <div className="px-[11px] font-mono text-[9px] text-soft-muted">
            v0.1.0 / local
          </div>
        </div>
      </aside>

      <main className="w-full min-w-0 max-w-[1280px] px-[39px] pb-[50px] pt-[27px] max-md:px-[18px] max-md:pb-[38px] max-md:pt-6">
        <header className="mb-[34px] flex min-h-[46px] items-center justify-between gap-6 max-sm:mb-7 max-sm:block">
          <div className="flex items-center gap-[7px] text-xs text-soft-muted">
            <span>Operations</span>
            <Icon name="chevron-right" size={14} />
            <strong className="font-bold text-ink">
              {page === "repositories" ? "Repositories" : "Runs"}
            </strong>
          </div>
          <div className="flex items-center justify-end gap-3 max-sm:justify-between max-sm:pt-4">
            <span
              className="flex items-center gap-[7px] overflow-hidden whitespace-nowrap font-mono text-[10px] text-muted"
              role="status"
              aria-live="polite"
            >
              <span className="size-[7px] shrink-0 rounded-full bg-green shadow-[0_0_0_3px_#d8f3e9]" />
              {notice}
            </span>
            <button
              className="grid size-[38px] shrink-0 place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh Control Room"
              title="Refresh"
            >
              <Icon name="refresh" size={17} />
            </button>
            <div className="flex items-center gap-[9px] pl-[7px] max-md:hidden">
              <span className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-[#355de0] to-[#6e98ff] font-mono text-[9px] font-bold text-white">
                LC
              </span>
              <span className="grid gap-0.5">
                <strong className="text-[11px] text-[#3b475c]">Local operator</strong>
                <small className="font-mono text-[8px] text-soft-muted">
                  Workspace session
                </small>
              </span>
            </div>
          </div>
        </header>

        {page === "repositories" ? (
          <RepositoriesPage
            repositories={snapshot.repositories}
            selectedRepository={selectedRepository}
            search={repositorySearch}
            onSearchChange={setRepositorySearch}
            onSelectRepository={setSelectedRepositoryId}
            onAddRepository={openRepositoryModal}
          />
        ) : (
          <>
            <section className="mb-[26px] flex items-center justify-between gap-7 max-sm:block">
              <div>
                <h1 className="mb-1 text-[clamp(28px,3vw,42px)] font-bold leading-none tracking-[-0.06em] text-ink">
                  Runs
                </h1>
                <p className="m-0 max-w-[560px] text-xs text-muted">
                  Every task has a trace. Watch each stage without losing the evidence
                  trail.
                </p>
              </div>
              <button
                className={`${primaryButtonClass} max-sm:mt-[18px] max-sm:w-full`}
                type="button"
                onClick={openTaskModal}
              >
                <Icon name="plus" size={17} />
                New task
              </button>
            </section>

            <section
              className="grid grid-cols-[minmax(0,1.65fr)_minmax(310px,0.75fr)] gap-[14px] max-lg:grid-cols-1"
              id="runs"
            >
              <div className={`${panelClass} min-w-0 p-[21px] max-sm:p-[15px]`}>
                <div className="flex items-center justify-between gap-[18px] border-b border-line pb-[15px]">
                  <div>
                    <h2 className="text-[17px] font-bold tracking-[-0.03em] text-[#29344a]">
                      Task activity
                    </h2>
                  </div>
                  <span className="grid size-[31px] place-items-center rounded-lg border border-[#cbdafa] bg-blue-soft font-mono text-[10px] font-bold text-blue">
                    {snapshot.runs.length.toString().padStart(2, "0")}
                  </span>
                </div>
                <div className="grid grid-cols-[minmax(190px,1.5fr)_minmax(74px,0.65fr)_88px_55px_16px] items-center gap-3 px-3 pb-[7px] pl-[52px] pt-4 font-mono text-[8px] tracking-[0.08em] text-soft-muted max-md:grid-cols-[34px_minmax(0,1fr)_78px_16px] max-md:pl-[52px] max-sm:hidden">
                  <span>Task</span>
                  <span>Stage</span>
                  <span className="text-right max-md:hidden">Status</span>
                  <span className="text-right max-md:hidden">Updated</span>
                  <span />
                </div>
                {snapshot.runs.length === 0 ? (
                  <EmptyState onCreate={openTaskModal} />
                ) : (
                  <div className="grid gap-[3px]">
                    {snapshot.runs.map((run) => (
                      <TaskRow
                        key={run.id}
                        run={run}
                        selected={run.id === selectedRun?.id}
                        onSelect={() => setSelectedRunId(run.id)}
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
                    <RunDetail run={selectedRun} onCancel={() => void cancelRun()} />
                  )}
                </div>
                <div
                  className={`${panelClass} min-w-0 bg-gradient-to-b from-[#f4f8ff] via-white to-white p-[21px] max-sm:p-[15px]`}
                  id="repository-preview"
                >
                  <div className="flex items-center justify-between gap-[18px] border-b border-line pb-3">
                    <div>
                      <h2 className="text-[20px] font-bold tracking-[-0.04em] text-[#29344a]">
                        Repositories
                      </h2>
                    </div>
                    <button
                      className="grid size-[31px] place-items-center rounded-lg border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
                      type="button"
                      onClick={openRepositoryModal}
                      aria-label="Register repository"
                      title="Register repository"
                    >
                      <Icon name="plus" size={16} />
                    </button>
                  </div>
                  <div className="grid gap-0 pt-[7px]">
                    {snapshot.repositories.length === 0 ? (
                      <p className="text-[11px] text-muted">
                        No repositories registered.
                      </p>
                    ) : (
                      snapshot.repositories.map((repository) => (
                        <RepositoryRow key={repository.id} repository={repository} />
                      ))
                    )}
                  </div>
                </div>
              </aside>
            </section>
          </>
        )}
      </main>

      {taskModalOpen && (
        <TaskModal
          closeButtonRef={closeButtonRef}
          step={taskStep}
          repositories={readyRepositories}
          selectedRepositoryId={selectedRepositoryId}
          issueUrl={issueUrl}
          busy={busy}
          error={formError}
          onClose={closeModals}
          onSelectRepository={setSelectedRepositoryId}
          onIssueUrlChange={(value) => {
            setIssueUrl(value);
            setFormError("");
          }}
          onBack={() => {
            setFormError("");
            setTaskStep((step) => Math.max(1, step - 1));
          }}
          onNext={advanceTaskStep}
          onSubmit={() => void createRun()}
          onAddRepository={openRepositoryModal}
        />
      )}
      {repositoryModalOpen && (
        <RepositoryModal
          closeButtonRef={closeButtonRef}
          path={repositoryPath}
          busy={busy}
          error={formError}
          onClose={closeModals}
          onPathChange={(value) => {
            setRepositoryPath(value);
            setFormError("");
          }}
          onSubmit={(event) => void registerRepository(event)}
        />
      )}
    </div>
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
        <span className="grid gap-[3px]">
          <b className="font-mono text-[9px] font-normal uppercase text-soft-muted">
            Events
          </b>
          <em className="font-mono text-[9px] not-italic text-[#4c5b74]">
            {run.lastSequence.toString().padStart(2, "0")}
          </em>
        </span>
        <span className="grid gap-[3px]">
          <b className="font-mono text-[9px] font-normal uppercase text-soft-muted">
            Updated
          </b>
          <em className="font-mono text-[9px] not-italic text-[#4c5b74]">
            {formatTime(run.updatedAt)}
          </em>
        </span>
        {run.failureCode !== null && (
          <span className="grid gap-[3px]">
            <b className="font-mono text-[9px] font-normal uppercase text-soft-muted">
              Failure
            </b>
            <em className="font-mono text-[9px] not-italic text-red">
              {run.failureCode}
            </em>
          </span>
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

function RepositoriesPage({
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
  const normalizedSearch = search.trim().toLowerCase();
  const filteredRepositories = repositories.filter((repository) => {
    if (normalizedSearch === "") return true;
    return `${repository.name} ${repository.fullName ?? ""}`
      .toLowerCase()
      .includes(normalizedSearch);
  });

  return (
    <>
      <section className="mb-[30px] flex items-end justify-between gap-7 max-sm:block">
        <div>
          <h1 className="mb-1 text-[clamp(28px,3vw,42px)] font-bold leading-none tracking-[-0.06em] text-ink">
            Repositories
          </h1>
          <p className="m-0 max-w-[560px] text-xs text-muted">
            Connect repositories and manage their configuration.
          </p>
        </div>
        <button
          className={`${primaryButtonClass} max-sm:mt-[18px] max-sm:w-full`}
          type="button"
          onClick={onAddRepository}
        >
          <Icon name="plus" size={17} />
          Add repository
        </button>
      </section>

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

function DetailItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="grid gap-2 border-b border-[#dde5f0] py-[17px] last:border-b-0">
      <dt className="text-[11px] font-semibold text-[#8292ad]">{label}</dt>
      <dd className={`${mono ? "font-mono" : ""} m-0 text-[13px] text-[#33415e]`}>
        {value}
      </dd>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="grid min-h-[312px] place-items-center p-[25px] text-center text-muted">
      <div>
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-[#eaf2ff] text-blue">
          <Icon name="task" size={25} />
        </span>
        <strong className="mt-5 block text-[15px] text-ink">No tasks yet</strong>
        <p className="mb-4 mt-2 max-w-[260px] text-[12px] leading-[1.55]">
          Start a task from a GitHub Work Item and its Runner trace will appear here.
        </p>
      </div>
      <button className={secondaryButtonClass} type="button" onClick={onCreate}>
        <Icon name="plus" size={15} />
        Create first task
      </button>
    </div>
  );
}

function EmptyDetail(): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="border-b border-[#dbe5f3] pb-[17px]">
        <h2 className="text-[20px] font-bold tracking-[-0.04em] text-[#29344a]">
          Task details
        </h2>
      </div>
      <div className="grid min-h-[342px] place-items-center p-[25px] text-center text-muted">
        <div>
          <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-[#eaf2ff] text-blue">
            <Icon name="archive" size={25} />
          </span>
          <strong className="mt-5 block text-[15px] text-ink">Select a task</strong>
          <p className="mb-0 mt-2 max-w-[220px] text-[12px] leading-[1.55]">
            Choose a task from the ledger to inspect its stage trace and evidence.
          </p>
        </div>
      </div>
    </div>
  );
}

function TaskModal({
  closeButtonRef,
  step,
  repositories,
  selectedRepositoryId,
  issueUrl,
  busy,
  error,
  onClose,
  onSelectRepository,
  onIssueUrlChange,
  onBack,
  onNext,
  onSubmit,
  onAddRepository,
}: {
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  step: number;
  repositories: Repository[];
  selectedRepositoryId: string;
  issueUrl: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSelectRepository: (id: string) => void;
  onIssueUrlChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
  onAddRepository: () => void;
}): JSX.Element {
  const repository = repositories.find(
    (candidate) => candidate.id === selectedRepositoryId,
  );
  return (
    <div
      className="fixed inset-0 z-10 grid place-items-center overflow-auto bg-[rgb(20_36_67_/_34%)] p-6 backdrop-blur-[5px] max-sm:items-end max-sm:p-0"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="w-[min(560px,100%)] overflow-hidden rounded-[17px] border border-[#e2e8f2] bg-white shadow-modal max-sm:max-h-[92vh] max-sm:overflow-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
      >
        <header className="flex items-center justify-between gap-[18px] border-b border-line p-[22px_24px] max-sm:p-[18px]">
          <div>
            <p className="mb-2 font-mono text-[9px] font-bold tracking-[0.13em] text-[#96a1b2]">
              TASK INTAKE
            </p>
            <h2
              id="task-modal-title"
              className="text-xl font-bold tracking-[-0.03em] text-[#29344a]"
            >
              Start a new task
            </h2>
          </div>
          <button
            className="grid size-[38px] place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
            type="button"
            onClick={onClose}
            aria-label="Close new task modal"
            ref={closeButtonRef}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <ol
          className="grid grid-cols-3 gap-2 px-6 pb-1 pt-5 max-sm:px-[18px]"
          aria-label="New task steps"
        >
          {stepLabels.map((label, index) => {
            const number = index + 1;
            return (
              <li
                className={`relative flex min-w-0 items-center gap-[7px] font-mono text-[8px] font-semibold uppercase ${number === step ? "text-blue" : number < step ? "text-green" : "text-soft-muted"}`}
                key={label}
                aria-current={number === step ? "step" : undefined}
              >
                <span
                  className={`grid size-[23px] shrink-0 place-items-center rounded-full border ${number <= step ? "border-blue bg-blue text-white" : "border-[#d2dae6] bg-white"}`}
                >
                  {number < step ? <Icon name="check" size={12} /> : number}
                </span>
                <b className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</b>
                {number < 3 && (
                  <span className="absolute right-[-5px] top-[11px] h-px w-2 bg-[#dce3ee]" />
                )}
              </li>
            );
          })}
        </ol>
        <div className="min-h-[290px] p-[22px_24px] max-sm:px-[18px]">
          {step === 1 && (
            <>
              <ModalIntro
                number="01"
                title="Choose a repository"
                copy="Tasks use the repository-owned `.codex-cage.yml` as their execution policy."
              />
              <div className="grid gap-[7px]">
                {repositories.length === 0 ? (
                  <div className="grid place-items-center gap-2 rounded-[10px] border border-dashed border-[#ccd6e5] p-7 text-center text-muted">
                    <Icon name="repo" size={23} />
                    <strong className="text-xs text-ink">No ready repositories</strong>
                    <span className="max-w-[280px] text-[10px]">
                      Register a repository with a valid Control Room policy first.
                    </span>
                    <button
                      className={secondaryButtonClass}
                      type="button"
                      onClick={onAddRepository}
                    >
                      Register repository
                    </button>
                  </div>
                ) : (
                  repositories.map((candidate) => (
                    <button
                      className={`grid min-h-[57px] w-full grid-cols-[33px_minmax(0,1fr)_20px] items-center gap-2.5 rounded-[10px] border p-2 text-left transition ${candidate.id === selectedRepositoryId ? "border-[#9ebcf3] bg-[#f5f8ff]" : "border-[#e3e8f0] bg-white hover:border-[#9ebcf3] hover:bg-[#f5f8ff]"}`}
                      type="button"
                      key={candidate.id}
                      aria-pressed={candidate.id === selectedRepositoryId}
                      onClick={() => onSelectRepository(candidate.id)}
                    >
                      <span className="grid size-[31px] place-items-center rounded-lg bg-blue-soft text-blue">
                        <Icon name="repo" size={17} />
                      </span>
                      <span className="grid min-w-0 gap-[3px]">
                        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#40506b]">
                          {candidate.name}
                        </strong>
                        <small className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[8px] text-soft-muted">
                          {candidate.fullName ?? "Local repository"}
                        </small>
                      </span>
                      <span className="text-blue">
                        {candidate.id === selectedRepositoryId && (
                          <Icon name="check" size={14} />
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <ModalIntro
                number="02"
                title="Point to the work item"
                copy="Give the Runner a GitHub Issue URL. The repository and issue origin must match."
              />
              <label
                className="mb-[7px] block text-[10px] font-bold text-[#536079]"
                htmlFor="modal-issue-url"
              >
                GitHub Issue URL
              </label>
              <input
                className="min-h-[45px] w-full rounded-lg border border-[#cfd8e6] bg-[#fbfcfe] px-[13px] text-xs text-ink placeholder:text-[#adb6c3]"
                id="modal-issue-url"
                value={issueUrl}
                onChange={(event) => onIssueUrlChange(event.target.value)}
                placeholder="https://github.com/org/repo/issues/123"
                autoFocus
              />
              <div className="mt-[17px] flex items-start gap-[9px] rounded-lg bg-[#f3f7ff] p-[11px_12px] text-[10px] text-[#55709e]">
                <Icon name="shield" size={15} />
                <span>
                  Only the Issue context is sent to the Runner. The browser never receives
                  credentials.
                </span>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <ModalIntro
                number="03"
                title="Review before launch"
                copy="Confirm the task target and the local execution path."
              />
              <div className="grid gap-0 rounded-[10px] border border-[#e5eaf1] px-3 py-[7px]">
                <SummaryLine
                  label="Repository"
                  value={repository?.fullName ?? repository?.name ?? "Not selected"}
                  icon="repo"
                />
                <SummaryLine
                  label="Work item"
                  value={issueNumber(issueUrl)}
                  icon="task"
                />
                <SummaryLine
                  label="Execution"
                  value="Local Runner · live events"
                  icon="runs"
                />
                <SummaryLine
                  label="Isolation"
                  value="Existing Docker workflow"
                  icon="shield"
                />
              </div>
              <div className="mt-[17px] flex items-start gap-[9px] rounded-lg bg-[#f3f7ff] p-[11px_12px] text-[10px] text-[#55709e]">
                <span className="mt-1 size-[7px] shrink-0 rounded-full bg-green shadow-[0_0_0_3px_#d8f3e9]" />
                <span>
                  The task will appear in the ledger immediately, then progress through
                  prepare, implement, verify, review, and publish.
                </span>
              </div>
            </>
          )}
          {error !== "" && (
            <div
              className="mt-[14px] flex items-start gap-2 rounded-lg bg-red-soft p-[10px_12px] text-[10px] text-red"
              role="alert"
            >
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-[18px] border-t border-line bg-[#fcfdff] p-[22px_24px] max-sm:p-[18px]">
          <button
            className="mr-auto inline-flex min-h-[41px] items-center justify-center rounded-lg px-[15px] text-[11px] font-bold text-muted transition hover:bg-[#f3f6fa] hover:text-ink"
            type="button"
            onClick={step === 1 ? onClose : onBack}
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              className={primaryButtonClass}
              type="button"
              onClick={onNext}
              disabled={busy || (step === 1 && repositories.length === 0)}
            >
              Continue <Icon name="chevron-right" size={15} />
            </button>
          ) : (
            <button
              className={primaryButtonClass}
              type="button"
              onClick={onSubmit}
              disabled={busy}
            >
              <Icon name="runs" size={15} />
              {busy ? "Starting..." : "Start task"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function RepositoryModal({
  closeButtonRef,
  path,
  busy,
  error,
  onClose,
  onPathChange,
  onSubmit,
}: {
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  path: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onPathChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-10 grid place-items-center overflow-auto bg-[rgb(20_36_67_/_34%)] p-6 backdrop-blur-[5px] max-sm:items-end max-sm:p-0"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="w-[min(500px,100%)] overflow-hidden rounded-[17px] border border-[#e2e8f2] bg-white shadow-modal max-sm:max-h-[92vh] max-sm:overflow-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-modal-title"
        onSubmit={onSubmit}
      >
        <header className="flex items-center justify-between gap-[18px] border-b border-line p-[22px_24px] max-sm:p-[18px]">
          <div>
            <p className="mb-2 font-mono text-[9px] font-bold tracking-[0.13em] text-[#96a1b2]">
              WORKSPACE SETUP
            </p>
            <h2
              id="repository-modal-title"
              className="text-xl font-bold tracking-[-0.03em] text-[#29344a]"
            >
              Register repository
            </h2>
          </div>
          <button
            className="grid size-[38px] place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
            type="button"
            onClick={onClose}
            aria-label="Close repository modal"
            ref={closeButtonRef}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="min-h-[210px] p-[22px_24px] max-sm:px-[18px]">
          <p className="m-0 text-[11px] text-muted">
            The Control Room will inspect the repository policy and Git remote. It does
            not change the repository during registration.
          </p>
          <label
            className="mb-[7px] mt-5 block text-[10px] font-bold text-[#536079]"
            htmlFor="repository-path"
          >
            Local repository path
          </label>
          <input
            className="min-h-[45px] w-full rounded-lg border border-[#cfd8e6] bg-[#fbfcfe] px-[13px] text-xs text-ink placeholder:text-[#adb6c3]"
            id="repository-path"
            value={path}
            onChange={(event) => onPathChange(event.target.value)}
            placeholder="/Users/you/Developer/project"
            autoFocus
          />
          {error !== "" && (
            <div
              className="mt-[14px] flex items-start gap-2 rounded-lg bg-red-soft p-[10px_12px] text-[10px] text-red"
              role="alert"
            >
              <Icon name="alert" size={15} />
              {error}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-end gap-[18px] border-t border-line bg-[#fcfdff] p-[22px_24px] max-sm:p-[18px]">
          <button
            className="mr-auto inline-flex min-h-[41px] items-center justify-center rounded-lg px-[15px] text-[11px] font-bold text-muted transition hover:bg-[#f3f6fa] hover:text-ink"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={primaryButtonClass}
            type="submit"
            disabled={busy || path.trim() === ""}
          >
            {busy ? "Inspecting..." : "Inspect repository"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ModalIntro({
  number,
  title,
  copy,
}: {
  number: string;
  title: string;
  copy: string;
}): JSX.Element {
  return (
    <div className="mb-[23px] flex items-start gap-3">
      <span className="grid size-[31px] shrink-0 place-items-center rounded-[9px] bg-blue-soft font-mono text-[10px] font-bold text-blue">
        {number}
      </span>
      <div>
        <h3 className="mb-1 text-base font-bold text-[#344158]">{title}</h3>
        <p className="m-0 text-[11px] text-muted">{copy}</p>
      </div>
    </div>
  );
}

function SummaryLine({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: IconName;
}): JSX.Element {
  return (
    <div className="flex min-h-12 items-center gap-2.5 border-b border-[#edf0f5] last:border-b-0">
      <span className="grid size-[31px] place-items-center rounded-lg bg-blue-soft text-blue">
        <Icon name={icon} size={16} />
      </span>
      <span className="grid min-w-0 gap-[3px]">
        <small className="font-mono text-[8px] uppercase text-soft-muted">{label}</small>
        <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#44536b]">
          {value}
        </strong>
      </span>
    </div>
  );
}

function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): JSX.Element {
  const paths: Record<IconName, JSX.Element> = {
    alert: <path d="m12 4 8 15H4L12 4Zm0 5.2v4.5m0 3.1v.1" />,
    archive: (
      <>
        <path d="M4 7h16v12H4zM3 4h18v3H3z" />
        <path d="M9 11h6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    "chevron-right": <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    external: (
      <>
        <path d="M14 5h5v5M19 5l-8 8" />
        <path d="M18 13v5H5V5h5" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
    github: (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 3a9 9 0 0 0-2.85 17.53c.45.08.62-.2.62-.44v-1.55c-2.52.55-3.05-1.06-3.05-1.06-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.07 1.37.93 1.37.93.8 1.37 2.1.98 2.62.75.08-.58.31-.98.57-1.2-2.01-.23-4.13-1.01-4.13-4.49 0-.99.35-1.8.92-2.43-.09-.23-.4-1.15.09-2.4 0 0 .75-.24 2.48.93A8.62 8.62 0 0 1 12 7.4c.76 0 1.52.1 2.23.3 1.7-1.17 2.46-.93 2.46-.93.49 1.25.18 2.17.09 2.4.57.63.92 1.44.92 2.43 0 3.49-2.12 4.26-4.14 4.48.32.28.6.82.6 1.66v2.35c0 .24.16.52.62.43A9 9 0 0 0 12 3Z"
      />
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.5-3L4 10" />
        <path d="M4 5v5h5M4 13a8 8 0 0 0 14.5 3L20 14" />
        <path d="M20 19v-5h-5" />
      </>
    ),
    repo: (
      <>
        <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z" />
        <path d="M12 20v-9M4 7.5l8 3.5 8-3.5" />
      </>
    ),
    runs: (
      <>
        <path d="M5 5h14v14H5z" />
        <path d="m9 9 6 3-6 3V9Z" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="5.5" />
        <path d="m15 15 4.5 4.5" />
      </>
    ),
    shield: <path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />,
    task: (
      <>
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === "github" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function taskIconClass(status: RunStatus): string {
  if (status === "succeeded") return "bg-green-soft text-green";
  if (status === "failed" || status === "aborted") return "bg-red-soft text-red";
  return "bg-blue-soft text-blue";
}

function statusPillClass(status: RunStatus): string {
  const base =
    "inline-flex min-h-[23px] items-center justify-center rounded-full px-2 font-mono text-[8px] font-bold uppercase";
  if (status === "succeeded") return `${base} bg-green-soft text-green`;
  if (status === "failed" || status === "aborted") return `${base} bg-red-soft text-red`;
  if (status === "queued") return `${base} bg-[#eff2f6] text-[#68768c]`;
  if (status === "unknown") return `${base} bg-[#f0ebff] text-violet`;
  return `${base} bg-blue-soft text-blue`;
}

function stageToneClass(status: "running" | "succeeded" | "failed" | "pending"): string {
  if (status === "succeeded")
    return "text-green [&>span:first-child]:border-[#77cbaa] [&>span:first-child]:bg-green-soft";
  if (status === "failed")
    return "text-red [&>span:first-child]:border-[#e4a2a9] [&>span:first-child]:bg-red-soft";
  if (status === "running")
    return "text-blue [&>span:first-child]:border-[#8eacee] [&>span:first-child]:bg-blue-soft";
  return "text-[#a6b0be]";
}

function repositoryStatusClass(status: RepositoryStatus): string {
  return status === "ready" ? "bg-green shadow-[0_0_0_3px_#e6f7f0]" : "bg-amber";
}

function pageFromHash(): PageName {
  return typeof window !== "undefined" && window.location.hash === "#repositories"
    ? "repositories"
    : "runs";
}

function issueNumber(url: string): string {
  const issue = url.match(/issues\/(\d+)/)?.[1];
  return issue === undefined ? "Work item" : `Issue #${issue}`;
}

function isGithubIssueUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(value.trim());
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function fetchJson<TValue>(url: string, options?: RequestInit): Promise<TValue> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : `Request failed (${response.status})`,
    );
  return body as TValue;
}

createRoot(document.getElementById("root")!).render(<App />);
