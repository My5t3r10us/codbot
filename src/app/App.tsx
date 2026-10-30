import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runChecks, type Check } from "../diag";
import { AgentsPage } from "../pages/AgentsPage";
import { ProjectsPage } from "../pages/ProjectsPage";
import { SettingsPage } from "../pages/SettingsPage";
import { TasksPage } from "../pages/TasksPage";
import * as runs from "../runs";
import { checkForUpdate, type UpdateInfo } from "../updater";
import { Toaster } from "../ui/toast";
import { NavContext, type Page } from "./nav";
import { Suggestions } from "./Suggestions";
import { TopBar } from "./TopBar";
import { useCurrentProject } from "./store";

export function App() {
  const { current, loading } = useCurrentProject();
  const [page, setPage] = useState<Page | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [decisionFor, setDecisionFor] = useState<string | null | undefined>(undefined);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // Premier écran : Tâches si un projet est prêt, sinon Réglages.
  useEffect(() => {
    if (page === null && !loading) setPage(current ? "tasks" : "settings");
  }, [page, loading, current]);

  const openRun = useCallback((id: string) => {
    setOpenRunId(id);
    setPage("agents");
  }, []);
  const openDecision = useCallback((id?: string) => {
    setDecisionFor(id ?? null);
    setPage("agents");
  }, []);

  useEffect(() => {
    void runChecks().then(setChecks).catch(() => {});
    void checkForUpdate().then(setUpdate).catch(() => {});
  }, []);

  // Cliquer une notification ramène Codbot au premier plan : on ouvre le run concerné.
  useEffect(() => {
    const p = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const runId = focused ? runs.takeNotifiedRun(15 * 60_000) : null;
      if (runId) openRun(runId);
    });
    return () => void p.then((un) => un());
  }, [openRun]);

  const nav = useMemo(() => ({ page: page ?? "tasks", go: setPage, openRun, openDecision }), [page, openRun, openDecision]);
  const bad = checks?.filter((c) => !c.ok) ?? [];

  return (
    <Toaster>
      <NavContext.Provider value={nav}>
        <div className="flex h-full flex-col overflow-hidden">
          <TopBar settingsAlert={bad.length ? bad.map((c) => `${c.name} : ${c.detail}`).join("\n") : update?.available ? `Version ${update.available.version} disponible` : null} />
          <Suggestions />
          <main className="relative min-h-0 flex-1">
            {page === "projects" && <ProjectsPage />}
            {page === "tasks" && <TasksPage />}
            {page === "agents" && (
              <AgentsPage
                openRunId={openRunId}
                onSheetChange={setOpenRunId}
                decisionFor={decisionFor}
                onDecisionClose={() => setDecisionFor(undefined)}
              />
            )}
            {page === "settings" && <SettingsPage checks={checks} onRecheck={() => void runChecks().then(setChecks)} update={update} />}
          </main>
        </div>
      </NavContext.Provider>
    </Toaster>
  );
}
