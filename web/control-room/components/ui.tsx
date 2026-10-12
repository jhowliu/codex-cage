import type { ReactNode } from "react";
import type { IconName, RepositoryStatus, RunStatus } from "../types";

export const panelClass = "rounded-xl border border-line bg-white shadow-panel";
export const primaryButtonClass =
  "inline-flex min-h-[41px] items-center justify-center gap-2 rounded-lg border border-transparent bg-blue px-[15px] text-[11px] font-bold text-white shadow-button transition hover:bg-blue-dark hover:shadow-button-hover disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex min-h-[41px] items-center justify-center gap-2 rounded-lg border border-[#d5dce7] bg-white px-[15px] text-[11px] font-bold text-[#526178] transition hover:border-[#abc2ed] hover:bg-blue-soft hover:text-blue disabled:cursor-not-allowed disabled:opacity-50";

export function taskIconClass(status: RunStatus): string {
  if (status === "succeeded") return "bg-green-soft text-green";
  if (status === "failed" || status === "aborted") return "bg-red-soft text-red";
  return "bg-blue-soft text-blue";
}

export function statusPillClass(status: RunStatus): string {
  const base =
    "inline-flex min-h-[23px] items-center justify-center rounded-full px-2 font-mono text-[8px] font-bold uppercase";
  if (status === "succeeded") return `${base} bg-green-soft text-green`;
  if (status === "failed" || status === "aborted") return `${base} bg-red-soft text-red`;
  if (status === "queued") return `${base} bg-[#eff2f6] text-[#68768c]`;
  if (status === "unknown") return `${base} bg-[#f0ebff] text-violet`;
  return `${base} bg-blue-soft text-blue`;
}

export function stageToneClass(
  status: "running" | "succeeded" | "failed" | "pending",
): string {
  if (status === "succeeded")
    return "text-green [&>span:first-child]:border-[#77cbaa] [&>span:first-child]:bg-green-soft";
  if (status === "failed")
    return "text-red [&>span:first-child]:border-[#e4a2a9] [&>span:first-child]:bg-red-soft";
  if (status === "running")
    return "text-blue [&>span:first-child]:border-[#8eacee] [&>span:first-child]:bg-blue-soft";
  return "text-[#a6b0be]";
}

export function repositoryStatusClass(status: RepositoryStatus): string {
  return status === "ready" ? "bg-green shadow-[0_0_0_3px_#e6f7f0]" : "bg-amber";
}

export function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="grid min-h-[312px] place-items-center p-[25px] text-center text-muted">
      <div>
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-[#eaf2ff] text-blue">
          <Icon name="task" size={24} />
        </span>
        <strong className="mt-5 block text-[15px] text-ink">No tasks yet</strong>
        <p className="mb-4 mt-2 max-w-[260px] text-[12px] leading-[1.55]">
          Start a task from a GitHub Issue and the Runner will record every stage here.
        </p>
        <button className={secondaryButtonClass} type="button" onClick={onCreate}>
          <Icon name="plus" size={15} />
          Create first task
        </button>
      </div>
    </div>
  );
}

export function EmptyDetail(): JSX.Element {
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
            <Icon name="runs" size={24} />
          </span>
          <strong className="mt-5 block text-[15px] text-ink">Select a task</strong>
          <p className="mb-0 mt-2 max-w-[220px] text-[12px] leading-[1.55]">
            Select a task to inspect its stages, events, and published evidence.
          </p>
        </div>
      </div>
    </div>
  );
}

export function DetailItem({
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

export function ModalIntro({
  title,
  copy,
}: {
  title: string;
  copy: string;
}): JSX.Element {
  return (
    <div className="mb-6 grid gap-1.5">
      <h3 className="text-[24px] font-bold leading-tight tracking-[-0.035em] text-[#142541] max-sm:text-[21px]">
        {title}
      </h3>
      <p className="m-0 text-[14px] text-[#7185a4] max-sm:text-[12px]">{copy}</p>
    </div>
  );
}

export function SummaryLine({
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

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): JSX.Element {
  const paths: Record<IconName, ReactNode> = {
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
        d="M12 3a9 9 0 0 0-2.85 17.53c.45.08.62-.2.62-.44v-1.55c-2.52.55-3.05-1.06-3.05-1.06-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.07 1.37.93 1.37.93.8 1.37 2.1.98 2.62.75.08-.58.31-.98.57-1.2-2.01-.23-4.13-1.01-4.13-4.49 0-.99.35-1.8.92-2.43-.09-.23-.4-1.15.09-2.4 0 0 .75-.24 2.48.93A8.62 8.62 0 0 1 12 7.4c.76 0 1.52.1 2.23.3 1.7-1.17 2.46-.93 2.46-.93.49 1.25.18 2.17.09 2.4.57.63.92.82.6 1.66v2.35c0 .24.16.52.62.43A9 9 0 0 0 12 3Z"
      />
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 10.5v5M12 7.5v.1" />
      </>
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
