import type { FormEvent, RefObject } from "react";
import type { Repository } from "../types";
import { issueNumber } from "../utils";
import {
  Icon,
  ModalIntro,
  primaryButtonClass,
  secondaryButtonClass,
  SummaryLine,
} from "./ui";
import { stepLabels } from "../types";

export function TaskModal({
  closeButtonRef,
  step,
  repositories,
  selectedRepositoryId,
  repository,
  issueUrl,
  busy,
  error,
  onClose,
  onAddRepository,
  onSelectRepository,
  onIssueUrlChange,
  onBack,
  onNext,
  onSubmit,
}: {
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  step: number;
  repositories: Repository[];
  selectedRepositoryId: string;
  repository: Repository | undefined;
  issueUrl: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onAddRepository: () => void;
  onSelectRepository: (id: string) => void;
  onIssueUrlChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}): JSX.Element {
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
        <ModalHeader
          eyebrow="TASK INTAKE"
          title="Start a new task"
          titleId="task-modal-title"
          onClose={onClose}
          closeButtonRef={closeButtonRef}
        />
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
            <RepositoryStep
              repositories={repositories}
              selectedRepositoryId={selectedRepositoryId}
              onAddRepository={onAddRepository}
              onSelectRepository={onSelectRepository}
            />
          )}
          {step === 2 && (
            <IssueStep issueUrl={issueUrl} onIssueUrlChange={onIssueUrlChange} />
          )}
          {step === 3 && <ReviewStep repository={repository} issueUrl={issueUrl} />}
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

export function RepositoryModal({
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
        <ModalHeader
          eyebrow="WORKSPACE SETUP"
          title="Register repository"
          titleId="repository-modal-title"
          onClose={onClose}
          closeButtonRef={closeButtonRef}
        />
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

function ModalHeader({
  eyebrow,
  title,
  titleId,
  onClose,
  closeButtonRef,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-[18px] border-b border-line p-[22px_24px] max-sm:p-[18px]">
      <div>
        <p className="mb-2 font-mono text-[9px] font-bold tracking-[0.13em] text-[#96a1b2]">
          {eyebrow}
        </p>
        <h2 id={titleId} className="text-xl font-bold tracking-[-0.03em] text-[#29344a]">
          {title}
        </h2>
      </div>
      <button
        className="grid size-[38px] place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
        type="button"
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()} modal`}
        ref={closeButtonRef}
      >
        <Icon name="close" size={17} />
      </button>
    </header>
  );
}

function RepositoryStep({
  repositories,
  selectedRepositoryId,
  onAddRepository,
  onSelectRepository,
}: {
  repositories: Repository[];
  selectedRepositoryId: string;
  onAddRepository: () => void;
  onSelectRepository: (id: string) => void;
}): JSX.Element {
  return (
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
                {candidate.id === selectedRepositoryId && <Icon name="check" size={14} />}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

function IssueStep({
  issueUrl,
  onIssueUrlChange,
}: {
  issueUrl: string;
  onIssueUrlChange: (value: string) => void;
}): JSX.Element {
  return (
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
  );
}

function ReviewStep({
  repository,
  issueUrl,
}: {
  repository: Repository | undefined;
  issueUrl: string;
}): JSX.Element {
  return (
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
        <SummaryLine label="Work item" value={issueNumber(issueUrl)} icon="task" />
        <SummaryLine label="Execution" value="Local Runner · live events" icon="runs" />
        <SummaryLine label="Isolation" value="Existing Docker workflow" icon="shield" />
      </div>
      <div className="mt-[17px] flex items-start gap-[9px] rounded-lg bg-[#f3f7ff] p-[11px_12px] text-[10px] text-[#55709e]">
        <span className="mt-1 size-[7px] shrink-0 rounded-full bg-green shadow-[0_0_0_3px_#d8f3e9]" />
        <span>
          The task will appear in the ledger immediately, then progress through prepare,
          implement, verify, review, and publish.
        </span>
      </div>
    </>
  );
}
