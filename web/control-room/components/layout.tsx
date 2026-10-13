import type { ReactNode } from "react";
import type { AuthStatus, PageName } from "../types";
import { Icon } from "./ui";

export function AppShell({
  page,
  activeRuns,
  notice,
  onRefresh,
  authStatus,
  authRefreshing,
  onRefreshAuth,
  children,
  overlays,
}: {
  page: PageName;
  activeRuns: number;
  notice: string;
  onRefresh: () => void;
  authStatus: AuthStatus;
  authRefreshing: boolean;
  onRefreshAuth: () => void;
  children: ReactNode;
  overlays?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-dvh w-full overflow-hidden bg-[#fbfcff]">
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
          <NavLink
            href="#runs"
            label="Runs"
            icon="runs"
            active={page === "runs"}
            count={activeRuns}
          />
          <NavLink
            href="#repositories"
            label="Repositories"
            icon="repo"
            active={page === "repositories"}
          />
        </nav>
        <div className="mt-auto grid gap-[14px] max-md:hidden">
          <AuthStatusCard
            status={authStatus}
            refreshing={authRefreshing}
            onRefresh={onRefreshAuth}
          />
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
      <main className="min-w-0 flex-1 px-[39px] pb-[50px] pt-[27px] max-md:px-[18px] max-md:pb-[38px] max-md:pt-6">
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
            <AuthStatusChip status={authStatus} />
            <button
              className="grid size-[38px] shrink-0 place-items-center rounded-[9px] border border-line bg-white text-[#63728a] transition hover:border-[#b5c9ee] hover:bg-blue-soft hover:text-blue"
              type="button"
              onClick={onRefresh}
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
        {children}
      </main>
      {overlays}
    </div>
  );
}

function AuthStatusCard({
  status,
  refreshing,
  onRefresh,
}: {
  status: AuthStatus;
  refreshing: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const tone = authStatusTone(status.status);

  return (
    <section
      className="grid gap-2 rounded-[10px] border border-[#e6ebf2] bg-[#fbfcff] p-[11px]"
      aria-label="GitHub authentication status"
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-lg ${tone.icon}`}
        >
          <Icon name="github" size={14} />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <strong className="text-[10px] text-[#3a5066]">GitHub auth</strong>
          <span className={`flex items-center gap-1 font-mono text-[9px] ${tone.text}`}>
            <span className={`size-[6px] rounded-full ${tone.dot}`} aria-hidden="true" />
            {tone.label}
          </span>
        </span>
      </div>
      <p className="m-0 text-[9px] leading-[1.45] text-soft-muted">{status.message}</p>
      <span className="font-mono text-[8px] text-soft-muted">
        {status.source === "codex-cage-env"
          ? "Source: .codex-cage.env"
          : "Source: not configured"}
      </span>
      <button
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-line bg-white px-2 text-[9px] font-bold text-[#526178] transition hover:border-[#abc2ed] hover:bg-blue-soft hover:text-blue disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <Icon name="refresh" size={12} />
        {refreshing ? "Checking…" : "Recheck"}
      </button>
    </section>
  );
}

function AuthStatusChip({ status }: { status: AuthStatus }): JSX.Element {
  const tone = authStatusTone(status.status);

  return (
    <span
      className={`hidden items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[9px] ${tone.chip} max-md:inline-flex`}
      title={`GitHub auth: ${tone.label}`}
      aria-label={`GitHub auth: ${tone.label}`}
    >
      <span className={`size-[6px] rounded-full ${tone.dot}`} aria-hidden="true" />
      {tone.label}
    </span>
  );
}

function authStatusTone(status: AuthStatus["status"]): {
  label: string;
  dot: string;
  text: string;
  icon: string;
  chip: string;
} {
  if (status === "connected") {
    return {
      label: "Connected",
      dot: "bg-green",
      text: "text-green",
      icon: "bg-green-soft text-green",
      chip: "bg-green-soft text-green",
    };
  }
  if (status === "invalid") {
    return {
      label: "Invalid",
      dot: "bg-red",
      text: "text-red",
      icon: "bg-red-soft text-red",
      chip: "bg-red-soft text-red",
    };
  }
  if (status === "missing") {
    return {
      label: "Missing",
      dot: "bg-amber",
      text: "text-[#a26c00]",
      icon: "bg-amber-soft text-[#a26c00]",
      chip: "bg-amber-soft text-[#a26c00]",
    };
  }
  return {
    label: "Unavailable",
    dot: "bg-amber",
    text: "text-[#a26c00]",
    icon: "bg-amber-soft text-[#a26c00]",
    chip: "bg-amber-soft text-[#a26c00]",
  };
}

function NavLink({
  href,
  label,
  icon,
  active = false,
  count,
}: {
  href: string;
  label: string;
  icon: "repo" | "runs";
  active?: boolean;
  count?: number;
}): JSX.Element {
  return (
    <a
      className={`group relative flex min-h-[45px] items-center gap-[11px] rounded-[9px] px-3 text-[13px] font-semibold transition hover:bg-blue-soft max-md:justify-center max-md:px-0 ${active ? "bg-blue-soft text-blue" : "text-[#66738b] hover:text-blue"}`}
      href={href}
      aria-current={active ? "page" : undefined}
    >
      {active && (
        <span className="absolute -left-[18px] bottom-[11px] top-[11px] w-[3px] rounded-r-[3px] bg-blue max-md:-left-2.5" />
      )}
      <Icon name={icon} size={17} />
      <span className="max-md:hidden">{label}</span>
      {count !== undefined && (
        <span className="ml-auto min-w-[19px] rounded-lg bg-[#dbe8ff] px-[5px] py-0.5 text-center font-mono text-[9px] font-bold text-blue max-md:hidden">
          {count}
        </span>
      )}
    </a>
  );
}
