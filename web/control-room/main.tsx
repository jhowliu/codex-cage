import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/layout";
import { TaskModal, RepositoryModal } from "./components/modals";
import { RepositoriesPage, RunsPage } from "./components/pages";
import {
  emptySnapshot,
  type PageName,
  type Repository,
  type Run,
  type Snapshot,
} from "./types";
import { fetchJson, isGithubIssueUrl, pageFromHash } from "./utils";
import "@fontsource-variable/inter";
import "./styles.css";

function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [page, setPage] = useState<PageName>(() => pageFromHash());
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

  const readyRepositories = snapshot.repositories.filter(
    (repository) => repository.status === "ready",
  );
  const selectedRepository =
    snapshot.repositories.find((repository) => repository.id === selectedRepositoryId) ??
    snapshot.repositories[0];
  const activeRuns = snapshot.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;

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
      if (event.key === "Escape") closeModals();
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
      setTaskModalOpen(false);
      setTaskStep(1);
      setNotice(`Task ${run.id} queued`);
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
    <AppShell
      page={page}
      activeRuns={activeRuns}
      notice={notice}
      onRefresh={() => void refresh()}
      overlays={
        <>
          {taskModalOpen && (
            <TaskModal
              closeButtonRef={closeButtonRef}
              step={taskStep}
              repositories={readyRepositories}
              selectedRepositoryId={selectedRepositoryId}
              repository={selectedRepository}
              issueUrl={issueUrl}
              busy={busy}
              error={formError}
              onClose={closeModals}
              onAddRepository={openRepositoryModal}
              onSelectRepository={(id) => {
                setSelectedRepositoryId(id);
                setFormError("");
              }}
              onIssueUrlChange={(value) => {
                setIssueUrl(value);
                setFormError("");
              }}
              onBack={() => {
                setTaskStep((step) => Math.max(1, step - 1));
                setFormError("");
              }}
              onNext={advanceTaskStep}
              onSubmit={() => void createRun()}
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
        </>
      }
    >
      {page === "repositories" ? (
        <RepositoriesPage
          repositories={snapshot.repositories}
          search={repositorySearch}
          onSearchChange={setRepositorySearch}
          onSelectRepository={setSelectedRepositoryId}
          onAddRepository={openRepositoryModal}
        />
      ) : (
        <RunsPage runs={snapshot.runs} onCreateTask={openTaskModal} />
      )}
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
