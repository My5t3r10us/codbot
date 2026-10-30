// Couche réactive : relie les modules métier (runs, file, db) aux composants React.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as cu from "../clickup";
import * as db from "../db";
import * as lock from "../lock";
import * as queue from "../queue";
import * as runs from "../runs";

// ---------- signaux de changement ----------

function signal() {
  let version = 0;
  const subs = new Set<() => void>();
  return {
    bump() {
      version++;
      for (const fn of subs) fn();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    get: () => version,
  };
}

/** Runs : regroupé pour ne pas redessiner à chaque ligne de journal. */
const runsSignal = signal();
let pending = false;
runs.onChange(() => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    runsSignal.bump();
  }, 250);
});
const queueSignal = signal();
queue.onQueueChange(() => queueSignal.bump());
/** Projets et réglages modifiés depuis l'interface. */
export const settingsSignal = signal();

export const useRunsVersion = () => useSyncExternalStore(runsSignal.subscribe, runsSignal.get);
export const useQueueVersion = () => useSyncExternalStore(queueSignal.subscribe, queueSignal.get);
export const useSettingsVersion = () => useSyncExternalStore(settingsSignal.subscribe, settingsSignal.get);

// ---------- chargement asynchrone ----------

export type Async<T> = { data: T; loading: boolean; error: string | null; reload: () => void };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], initial: T): Async<T> {
  const [state, setState] = useState<{ data: T; loading: boolean; error: string | null }>({ data: initial, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  // StrictMode monte, démonte puis remonte : on remet le drapeau à chaque montage.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    fn()
      .then((data) => current && alive.current && setState({ data, loading: false, error: null }))
      .catch((e) => current && alive.current && setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })));
    return () => void (current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Horloge partagée (une seconde), pour les chronos et comptes à rebours. */
const clock = signal();
setInterval(() => clock.bump(), 1000);
export function useNow() {
  useSyncExternalStore(clock.subscribe, clock.get);
  return Date.now();
}

// ---------- données ----------

export function useRuns() {
  const v = useRunsVersion();
  return useAsync(() => db.listRuns(200), [v], [] as db.Run[]);
}

export function useRunEvents(runId: string | null) {
  const v = useRunsVersion();
  return useAsync(() => (runId ? db.listRunEvents(runId) : Promise.resolve([])), [runId, v], [] as db.RunEvent[]);
}

export function useQueue() {
  const v = useQueueVersion();
  const r = useRunsVersion();
  return useAsync(async () => ({ items: await db.listQueue(), status: await queue.status() }), [v, r], {
    items: [] as db.QueueItem[],
    status: { running: false, pausedUntil: null, sessionId: null } as queue.QueueStatus,
  });
}

export function useProjects() {
  const v = useSettingsVersion();
  return useAsync(() => db.listProjects(), [v], [] as db.Project[]);
}

export function useSetting<T>(key: string, fallback: T): [T, (v: T) => Promise<void>] {
  const v = useSettingsVersion();
  const { data } = useAsync(() => db.getSetting<T>(key, fallback), [key, v], fallback);
  const set = useCallback(async (value: T) => {
    await db.setSetting(key, value);
    settingsSignal.bump();
  }, [key]);
  return [data, set];
}

/** Projet actuel (liste ClickUp) : choisi dans la barre du haut, retenu entre deux lancements. */
export function useCurrentProject() {
  const projects = useProjects();
  const [currentId, setCurrentId] = useSetting<string>("current_project", "");
  const usable = projects.data.filter((p) => p.repo_path);
  const current = usable.find((p) => p.list_id === currentId) ?? usable[0] ?? null;
  return { projects: projects.data, current, setCurrent: (id: string) => setCurrentId(id), loading: projects.loading };
}

export function useUsage() {
  const v = useRunsVersion();
  return useAsync(() => runs.lastUsage(), [v], null);
}

export type TasksState = { tasks: cu.CuTask[]; statuses: cu.CuStatus[]; me: cu.CuUser | null; myTag: string };

/** Tâches d'une liste ClickUp et ses statuts, rafraîchies toutes les 60 s (fenêtre visible). */
export function useTasks(listId: string | null, includeClosed: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return useAsync<TasksState>(async () => {
    if (!listId) return { tasks: [], statuses: [], me: null, myTag: "" };
    const [tasks, list, me, myTag] = await Promise.all([
      cu.getListTasks(listId, includeClosed),
      cu.getList(listId),
      cachedUser(),
      lock.myLockTag(),
    ]);
    return { tasks, statuses: [...list.statuses].sort((a, b) => a.orderindex - b.orderindex), me, myTag };
  }, [listId, includeClosed, tick], { tasks: [], statuses: [], me: null, myTag: "" });
}

let user: Promise<cu.CuUser> | null = null;
export function cachedUser() {
  user ??= cu.getUser().catch((e) => {
    user = null;
    throw e;
  });
  return user;
}

/** Jeton ClickUp changé : l'utilisateur (filtre « À moi ») est relu au prochain appel. */
export function resetCachedUser() {
  user = null;
}

export type RunLive = { ev?: db.RunEvent; plan?: db.RunEvent };

/** Dernière activité et dernier plan de chaque run (cartes, dock, kanban des agents). */
export function useRunsLive(runIds: string[]) {
  const v = useRunsVersion();
  const key = runIds.join(",");
  return useAsync(async () => {
    const [evs, plans] = await Promise.all([db.latestEvents(runIds), db.latestPlans(runIds)]);
    const m = new Map<string, RunLive>();
    for (const e of evs) m.set(e.run_id, { ...m.get(e.run_id), ev: e });
    for (const p of plans) m.set(p.run_id, { ...m.get(p.run_id), plan: p });
    return m;
  }, [key, v], new Map<string, RunLive>()).data;
}
