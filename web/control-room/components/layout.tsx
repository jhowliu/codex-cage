import type { ReactNode } from "react";
import type { PageName } from "../types";
import { Icon } from "./ui";

export function AppShell({
  page,
  activeRuns,
  notice,
  onRefresh,
  children,
  overlays,
}: {
  page: PageName;
  activeRuns: number;
  notice: string;
  onRefresh: () => void;
  children: ReactNode;
  overlays?: ReactNode;
}): JSX.Element {
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
          <NavLink href="#evidence" label="Evidence" icon="archive" />
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

function NavLink({
  href,
  label,
  icon,
  active = false,
  count,
}: {
  href: string;
  label: string;
  icon: "archive" | "repo" | "runs";
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
