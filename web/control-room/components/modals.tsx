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
      className="fixed inset-0 z-10 grid place-items-center overflow-auto bg-[rgb(211_226_250_/_64%)] p-6 backdrop-blur-[6px] max-sm:items-end max-sm:p-3"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="w-[min(1320px,calc(100vw-48px))] overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-modal max-sm:max-h-[94vh] max-sm:w-full max-sm:rounded-[20px] max-sm:overflow-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
      >
        <ModalHeader
          eyebrow="New task"
          title="Start a new task"
          titleId="task-modal-title"
          variant="large"
          onClose={onClose}
          closeButtonRef={closeButtonRef}
        />
        <ol
          className="relative grid grid-cols-3 gap-2 px-[50px] pb-[38px] pt-[38px] max-sm:px-5 max-sm:pb-7 max-sm:pt-7"
          aria-label="New task steps"
        >
          <span
            className="absolute left-[16.5%] right-[16.5%] top-[65px] h-px bg-[#c8d7eb] max-sm:left-[18%] max-sm:right-[18%] max-sm:top-[50px]"
            aria-hidden="true"
          />
          {stepLabels.map((label, index) => {
            const number = index + 1;
            return (
              <li
                className={`relative z-[1] flex min-w-0 flex-col items-center gap-3 text-[18px] font-medium max-sm:text-[13px] ${number === step ? "text-blue" : number < step ? "text-[#5d8fe9]" : "text-[#788cae]"}`}
                key={label}
                aria-current={number === step ? "step" : undefined}
              >
                <span
                  className={`grid size-[54px] shrink-0 place-items-center rounded-full border-2 bg-white text-[20px] max-sm:size-11 max-sm:text-[16px] ${number === step ? "border-blue bg-blue text-white shadow-[0_0_0_7px_#e8f0ff]" : number < step ? "border-[#7da5ef] bg-blue text-white" : "border-[#cad8eb] text-[#627798]"}`}
                >
                  {number < step ? <Icon name="check" size={22} /> : number}
                </span>
                <b className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</b>
              </li>
            );
          })}
        </ol>
        <div className="min-h-[430px] px-[50px] pb-[50px] pt-[4px] max-sm:min-h-[360px] max-sm:px-5 max-sm:pb-8">
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
        <footer className="flex items-center justify-end gap-6 border-t border-[#e5edf8] bg-[#fcfdff] px-[50px] py-[29px] max-sm:px-5 max-sm:py-5">
          <button
            className="mr-auto inline-flex min-h-[54px] items-center justify-center rounded-lg px-5 text-[17px] font-semibold text-[#647b9c] transition hover:bg-[#f3f6fa] hover:text-ink max-sm:text-[14px]"
            type="button"
            onClick={step === 1 ? onClose : onBack}
          >
            {step === 1 ? "Cancel" : "Back"}
          </button>
          {step < 3 ? (
            <button
              className="inline-flex min-h-[56px] min-w-[218px] items-center justify-center gap-3 rounded-[10px] border border-transparent bg-blue px-8 text-[17px] font-bold text-white shadow-button transition hover:bg-blue-dark hover:shadow-button-hover disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-w-0 max-sm:px-5 max-sm:text-[14px]"
              type="button"
              onClick={onNext}
              disabled={busy || (step === 1 && repositories.length === 0)}
            >
              Continue <Icon name="chevron-right" size={22} />
            </button>
          ) : (
            <button
              className="inline-flex min-h-[56px] min-w-[218px] items-center justify-center gap-3 rounded-[10px] border border-transparent bg-blue px-8 text-[17px] font-bold text-white shadow-button transition hover:bg-blue-dark hover:shadow-button-hover disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-w-0 max-sm:px-5 max-sm:text-[14px]"
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
  variant = "compact",
  onClose,
  closeButtonRef,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  variant?: "large" | "compact";
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const large = variant === "large";
  return (
    <header
      className={
        large
          ? "flex items-start justify-between gap-[18px] border-b border-[#e5edf8] px-[50px] pb-[42px] pt-[42px] max-sm:px-5 max-sm:pb-7 max-sm:pt-7"
          : "flex items-center justify-between gap-[18px] border-b border-line p-[22px_24px] max-sm:p-[18px]"
      }
    >
      <div>
        <p
          className={
            large
              ? "mb-4 text-[19px] font-medium leading-none text-[#8ca0bd] max-sm:text-[14px]"
              : "mb-2 font-mono text-[9px] font-bold tracking-[0.13em] text-[#96a1b2]"
          }
        >
          {eyebrow}
        </p>
        <h2
          id={titleId}
          className={
            large
              ? "text-[36px] font-bold leading-[1.08] tracking-[-0.045em] text-[#152642] max-sm:text-[27px]"
              : "text-xl font-bold tracking-[-0.03em] text-[#29344a]"
          }
        >
          {title}
        </h2>
      </div>
      <button
        className={
          large
            ? "grid size-12 place-items-center rounded-xl text-[#5e7293] transition hover:bg-blue-soft hover:text-blue max-sm:size-10"
            : "grid size-[38px] place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
        }
        type="button"
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()} modal`}
        ref={closeButtonRef}
      >
        <Icon name="close" size={large ? 29 : 17} />
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
        title="Choose a repository"
        copy="Select the repository for this task."
      />
      <div className="grid gap-4">
        {repositories.length === 0 ? (
          <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-[#b8cbe5] p-10 text-center text-muted">
            <Icon name="repo" size={36} />
            <strong className="text-[18px] text-ink">No ready repositories</strong>
            <span className="max-w-[420px] text-[14px]">
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
              className={`grid min-h-[126px] w-full grid-cols-[78px_minmax(0,1fr)_48px] items-center gap-5 rounded-2xl border px-6 py-4 text-left transition max-sm:grid-cols-[58px_minmax(0,1fr)_36px] max-sm:gap-3 max-sm:px-4 ${candidate.id === selectedRepositoryId ? "border-[#a9cbff] bg-[#f4f8ff] shadow-[0_4px_18px_rgb(71_125_218_/_8%)]" : "border-[#d9e5f5] bg-white hover:border-[#a9cbff] hover:bg-[#f7faff]"}`}
              type="button"
              key={candidate.id}
              aria-pressed={candidate.id === selectedRepositoryId}
              onClick={() => onSelectRepository(candidate.id)}
            >
              <span className="grid size-[76px] place-items-center rounded-2xl bg-[#eaf2ff] text-blue max-sm:size-14">
                <Icon name="repo" size={39} />
              </span>
              <span className="grid min-w-0 gap-2">
                <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[21px] font-bold text-[#142541] max-sm:text-[16px]">
                  {candidate.name}
                </strong>
                <small className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[16px] text-[#7185a4] max-sm:text-[11px]">
                  {candidate.fullName ?? "Local repository"}
                </small>
              </span>
              <span className="grid size-10 place-items-center rounded-full bg-blue text-white max-sm:size-8">
                {candidate.id === selectedRepositoryId && <Icon name="check" size={22} />}
              </span>
            </button>
          ))
        )}
      </div>
      <div className="mt-[27px] flex items-center gap-4 text-[16px] text-[#7185a4] max-sm:items-start max-sm:text-[12px]">
        <Icon name="info" size={28} className="shrink-0 text-[#607b9e] max-sm:mt-0.5" />
        <span>
          Execution settings come from this repository&apos;s{" "}
          <code className="rounded-md bg-[#f0f5ff] px-2 py-1 font-mono text-[15px] text-[#58739d] max-sm:text-[11px]">
            .codex-cage.yml
          </code>
          .
        </span>
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
        title="Point to the work item"
        copy="Give the Runner a GitHub Issue URL. The repository and issue origin must match."
      />
      <label
        className="mb-2 block text-[14px] font-bold text-[#536079]"
        htmlFor="modal-issue-url"
      >
        GitHub Issue URL
      </label>
      <input
        className="min-h-[60px] w-full rounded-xl border border-[#cfd8e6] bg-[#fbfcfe] px-4 text-[16px] text-ink outline-none placeholder:text-[#adb6c3] focus:border-[#88aefc] focus:ring-4 focus:ring-[#dfeaff]"
        id="modal-issue-url"
        value={issueUrl}
        onChange={(event) => onIssueUrlChange(event.target.value)}
        placeholder="https://github.com/org/repo/issues/123"
        autoFocus
      />
      <div className="mt-6 flex items-start gap-3 rounded-xl bg-[#f3f7ff] p-4 text-[14px] text-[#55709e]">
        <Icon name="shield" size={20} />
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
        title="Review before launch"
        copy="Confirm the task target and the local execution path."
      />
      <div className="grid gap-0 rounded-2xl border border-[#e5eaf1] px-5 py-2">
        <SummaryLine
          label="Repository"
          value={repository?.fullName ?? repository?.name ?? "Not selected"}
          icon="repo"
        />
        <SummaryLine label="Work item" value={issueNumber(issueUrl)} icon="task" />
        <SummaryLine label="Execution" value="Local Runner · live events" icon="runs" />
        <SummaryLine label="Isolation" value="Existing Docker workflow" icon="shield" />
      </div>
      <div className="mt-6 flex items-start gap-3 rounded-xl bg-[#f3f7ff] p-4 text-[14px] text-[#55709e]">
        <span className="mt-1 size-[7px] shrink-0 rounded-full bg-green shadow-[0_0_0_3px_#d8f3e9]" />
        <span>
          The task will appear in the ledger immediately, then progress through prepare,
          implement, verify, review, and publish.
        </span>
      </div>
    </>
  );
}
