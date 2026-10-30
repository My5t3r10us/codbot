// Page Tâches : tâches ClickUp du projet en Kanban (glisser-déposer), Cartes ou Liste,
// et dock des agents pour les confier à Claude Code.
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronRight, Columns3, FolderGit2, LayoutGrid, List, RefreshCw, Search, Settings2, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as cu from "../clickup";
import * as db from "../db";
import * as lock from "../lock";
import { matchesDue, type DueFilter } from "../rules";
import { useNav } from "../app/nav";
import { useCurrentProject, useQueue, useRuns, useRunsLive, useSetting, useTasks } from "../app/store";
import { ACTIVE_STATES } from "../rules";
import { OPEN_STATES } from "../labels";
import { priorityLevel, withChildren } from "../taskview";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Segmented } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { useToast } from "../ui/toast";
import { AgentDock } from "./tasks/AgentDock";
import { LaunchDialog } from "./tasks/LaunchDialog";
import { AgentStrip, Assignees, Due, LockBadge, PriorityBars } from "./tasks/parts";
import type { RunLive } from "../app/store";

type View = "kanban" | "cards" | "list";
type Status = cu.CuTask["status"];

const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "overdue", label: "En retard" },
  { value: "today", label: "Aujourd'hui" },
  { value: "week", label: "Cette semaine" },
  { value: "none", label: "Sans échéance" },
];

/** Tout ce qu'une carte doit savoir pour s'afficher. */
type Ctx = {
  all: cu.CuTask[];
  runFor: Map<string, db.Run>;
  live: Map<string, RunLive>;
  myTag: string;
  selected: Set<string>;
  dragIds: string[] | null;
  toggle(t: cu.CuTask): void;
  dragStart(e: React.DragEvent, t: cu.CuTask): void;
  dragEnd(): void;
  openRun(id: string): void;
  reload(): void;
};

export function TasksPage() {
  const nav = useNav();
  const toast = useToast();
  const { current, loading: projLoading } = useCurrentProject();
  const [view, setView] = useSetting<View>("tasks_view", "kanban");
  const [cascade, setCascade] = useSetting<boolean>("tasks_cascade", true);
  const [concurrency] = useSetting<number>("concurrency", 2);
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [closed, setClosed] = useState(false);
  const [due, setDue] = useState<DueFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, Status>>({});
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [launching, setLaunching] = useState<cu.CuTask[] | null>(null);

  const listId = current?.list_id ?? null;
  const data = useTasks(listId, closed);
  const runsQ = useRuns();
  const queueQ = useQueue();

  useEffect(() => setOverrides({}), [data.data]);
  useEffect(() => setSelected(new Set()), [listId]);

  const projectRuns = useMemo(() => runsQ.data.filter((r) => r.list_id === listId), [runsQ.data, listId]);
  const openRuns = useMemo(() => projectRuns.filter((r) => OPEN_STATES.includes(r.state)), [projectRuns]);
  const activeRuns = useMemo(() => projectRuns.filter((r) => ACTIVE_STATES.includes(r.state)), [projectRuns]);
  const live = useRunsLive(openRuns.map((r) => r.id));
  const runFor = useMemo(() => {
    const m = new Map<string, db.Run>();
    for (const r of openRuns) for (const id of r.task_ids) if (!m.has(id)) m.set(id, r);
    return m;
  }, [openRuns]);

  const all = useMemo(() => data.data.tasks.map((t) => (overrides[t.id] ? { ...t, status: overrides[t.id] } : t)), [data.data.tasks, overrides]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const me = data.data.me;
    return all.filter((t) =>
      (!q || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || (t.custom_id ?? "").toLowerCase().includes(q)) &&
      (!mine || t.assignees.some((a) => a.id === me?.id)) &&
      matchesDue(t.due_date, due));
  }, [all, search, mine, due, data.data.me]);

  const busy = (t: cu.CuTask) => runFor.has(t.id) || Boolean(lock.lockOf(t) && lock.lockOf(t) !== data.data.myTag);
  const queuedIds = new Set(queueQ.data.items.flatMap((i) => i.task_ids));

  function toggle(t: cu.CuTask) {
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(t.id);
      const targets = [t, ...(cascade ? all.filter((c) => c.parent === t.id) : [])];
      for (const x of targets) {
        if (on && !busy(x)) next.add(x.id);
        else if (!on) next.delete(x.id);
      }
      return next;
    });
  }

  function dragStart(e: React.DragEvent, t: cu.CuTask) {
    const ids = selected.has(t.id) ? [...selected] : [t.id];
    e.dataTransfer.setData("text/plain", ids.join(","));
    e.dataTransfer.effectAllowed = "copyMove";
    setDragIds(ids);
  }

  async function moveTo(ids: string[], status: cu.CuStatus) {
    const targets = all.filter((t) => ids.includes(t.id) && t.status.status.toLowerCase() !== status.status.toLowerCase());
    if (!targets.length) return;
    const before = Object.fromEntries(targets.map((t) => [t.id, t.status]));
    const to: Status = { status: status.status, color: status.color, type: status.type };
    setOverrides((o) => ({ ...o, ...Object.fromEntries(targets.map((t) => [t.id, to])) }));
    try {
      await Promise.all(targets.map((t) => cu.setTaskStatus(t.id, status.status)));
      toast(targets.length > 1 ? `${targets.length} tâches → ${status.status}` : `${targets[0].name}`, `Statut ClickUp : ${status.status}`);
      data.reload();
    } catch (e) {
      setOverrides((o) => ({ ...o, ...before }));
      toast("Statut non modifié", (e as Error).message, "err");
    }
  }

  function launch(ids: string[]) {
    const tasks = all.filter((t) => ids.includes(t.id));
    // Une tâche en file sera lancée par la file : la relancer ici ferait deux agents sur la même tâche.
    const free = tasks.filter((t) => !busy(t) && !queuedIds.has(t.id));
    if (!free.length) {
      toast("Déjà prise", tasks.length > 1 ? "Ces tâches ont déjà un agent, sont en file ou prises par un autre PC" : "Cette tâche a déjà un agent, est en file ou prise par un autre PC", "err");
      return;
    }
    if (free.length < tasks.length) toast(`${tasks.length - free.length} tâche(s) ignorée(s)`, "Déjà prises par un agent, en file ou par un autre PC");
    setLaunching(free);
  }

  const ctx: Ctx = {
    all, runFor, live, myTag: data.data.myTag, selected, dragIds, toggle, dragStart,
    dragEnd: () => setDragIds(null), openRun: nav.openRun, reload: data.reload,
  };

  if (!current) {
    return (
      <Empty
        title={projLoading ? "Chargement…" : "Aucun projet prêt"}
        text="Associe une liste ClickUp à un repo local dans les Réglages pour voir ses tâches ici."
        action={!projLoading && <Button variant="brand" onClick={() => nav.go("settings")}><Settings2 />Ouvrir les réglages</Button>}
      />
    );
  }

  const selection = all.filter((t) => selected.has(t.id));
  const statuses = data.data.statuses;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-5 pb-3">
        <div className="mr-2 min-w-0">
          <h1 className="text-[20px] leading-tight font-semibold tracking-tight">Tâches</h1>
          <p className="flex items-center gap-1.5 truncate text-[12.5px] text-muted-foreground">
            {visible.length} tâche{visible.length > 1 ? "s" : ""}
            <span aria-hidden>·</span>
            <FolderGit2 className="size-3.5" />
            <span className="truncate font-mono">{current.repo_path.split(/[\\/]/).pop()}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{current.base_branch}</span>
          </p>
        </div>
        <span className="flex-1" />
        <label className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…" className="w-[200px] pl-8" aria-label="Rechercher une tâche" />
        </label>
        <Button variant={mine ? "default" : "outline"} onClick={() => setMine(!mine)} aria-pressed={mine}><UserRound />À moi</Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">
              Filtres{(due !== "all" || closed) && <span className="ml-0.5 size-1.5 rounded-full bg-brand" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[280px] p-3" align="end">
            <div className="mb-1.5 text-[11.5px] font-semibold text-muted-foreground">Échéance</div>
            <div className="grid gap-0.5">
              {DUE_OPTIONS.map((o) => (
                <button key={o.value} type="button" onClick={() => setDue(o.value)} className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-muted">
                  <Check className={cn("size-3.5", due === o.value ? "opacity-100" : "opacity-0")} />{o.label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-2.5 border-t border-border pt-3">
              <Switch checked={closed} onCheckedChange={setClosed} label="Inclure les tâches terminées" />
              <Switch checked={cascade} onCheckedChange={(v) => void setCascade(v)} label="Cocher une tâche coche ses sous-tâches" />
            </div>
          </PopoverContent>
        </Popover>
        <Segmented<View>
          value={view} onChange={(v) => void setView(v)} label="Vue"
          options={[
            { value: "kanban", label: <><Columns3 />Kanban</> },
            { value: "cards", label: <><LayoutGrid />Cartes</> },
            { value: "list", label: <><List />Liste</> },
          ]}
        />
        <Button variant="ghost" size="icon" onClick={data.reload} aria-label="Rafraîchir" title="Rafraîchir">
          <RefreshCw className={cn(data.loading && "spin")} />
        </Button>
      </div>

      {data.error && (
        <div className="mx-6 mb-3 rounded-lg border border-err/30 bg-err/6 px-3 py-2 text-[13px] text-err-fg">ClickUp : {data.error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {data.loading && !all.length ? (
          <Skeleton />
        ) : !visible.length ? (
          <Empty title="Aucune tâche" text={search || mine || due !== "all" ? "Aucune tâche ne correspond aux filtres." : "Cette liste ClickUp est vide."} />
        ) : view === "kanban" ? (
          <Kanban ctx={ctx} tasks={visible} statuses={statuses} onMove={moveTo} queued={queuedIds} />
        ) : view === "cards" ? (
          <Cards ctx={ctx} tasks={visible} queued={queuedIds} />
        ) : (
          <ListView ctx={ctx} tasks={visible} statuses={statuses} queued={queuedIds} />
        )}
      </div>

      <AgentDock
        slots={concurrency}
        active={activeRuns}
        live={live}
        queued={queueQ.data.items.length}
        selection={selection}
        dragging={Boolean(dragIds)}
        onDrop={(ids) => { setDragIds(null); launch(ids); }}
        onLaunch={() => launch([...selected])}
        onClear={() => setSelected(new Set())}
        onOpenRun={nav.openRun}
      />

      {launching && (
        <LaunchDialog
          tasks={launching}
          project={current}
          onClose={() => setLaunching(null)}
          onDone={() => { setLaunching(null); setSelected(new Set()); data.reload(); }}
        />
      )}
    </div>
  );
}

// ---------- carte ----------

function TaskCard({ task, ctx, queued, showStatus, sub }: { task: cu.CuTask; ctx: Ctx; queued: boolean; showStatus?: boolean; sub?: boolean }) {
  const run = ctx.runFor.get(task.id);
  const tag = lock.lockOf(task);
  const other = tag && tag !== ctx.myTag ? tag : null;
  const children = ctx.all.filter((c) => c.parent === task.id);
  const doneKids = children.filter((c) => c.status.type === "closed" || c.status.type === "done").length;
  const parent = task.parent ? ctx.all.find((p) => p.id === task.parent) : null;
  const sel = ctx.selected.has(task.id);
  const dragging = ctx.dragIds?.includes(task.id);
  const canSelect = !run && !other;

  return (
    <div
      draggable
      onDragStart={(e) => ctx.dragStart(e, task)}
      onDragEnd={ctx.dragEnd}
      onClick={() => canSelect && ctx.toggle(task)}
      className={cn(
        "group/card relative cursor-grab rounded-xl border bg-card p-3 shadow-xs transition-[border-color,box-shadow,opacity,transform] active:cursor-grabbing",
        sel ? "border-brand shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_16%,transparent)]" : "border-border hover:border-border-strong hover:shadow-sm",
        dragging && "rotate-[1.5deg] opacity-50",
        sub && "ml-3",
      )}
    >
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <Checkbox checked={sel} disabled={!canSelect} onChange={() => ctx.toggle(task)} />
        <PriorityBars task={task} />
        <span className="font-mono">{task.custom_id ?? `CU-${task.id}`}</span>
        {showStatus && (
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ background: task.status.color }} />{task.status.status}
          </span>
        )}
        <span className="flex-1" />
        {queued && !run && <span className="rounded bg-muted px-1.5 py-px text-[11px]">en file</span>}
        <Due due={task.due_date} />
      </div>
      {parent && (
        <div className="mt-1.5 flex items-center gap-1 truncate text-[11.5px] text-muted-foreground">
          <ChevronRight className="size-3" />sous-tâche de <span className="truncate">{parent.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); void openUrl(task.url); }}
        className="mt-1.5 block cursor-pointer text-left text-[13.5px] leading-snug font-medium hover:underline"
        title="Ouvrir dans ClickUp"
      >
        {task.name}
      </button>
      {(task.tags.some((t) => !t.name.startsWith(lock.LOCK_PREFIX)) || children.length > 0 || task.assignees.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {task.tags.filter((t) => !t.name.startsWith(lock.LOCK_PREFIX)).slice(0, 3).map((t) => (
            <span key={t.name} className="rounded-md bg-muted px-1.5 py-px text-[11.5px] text-muted-foreground">{t.name}</span>
          ))}
          {children.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground" title="Sous-tâches terminées">
              <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-ok" style={{ width: `${(doneKids / children.length) * 100}%` }} />
              </span>
              {doneKids}/{children.length}
            </span>
          )}
          <span className="flex-1" />
          <Assignees users={task.assignees} />
        </div>
      )}
      {other && !run && <div className="mt-2.5"><LockBadge task={task} tag={other} onReleased={ctx.reload} /></div>}
      {run && <div className="mt-2.5"><AgentStrip run={run} live={ctx.live.get(run.id)} onOpen={() => ctx.openRun(run.id)} /></div>}
    </div>
  );
}

function Checkbox({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange(): void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Sélectionner"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={cn(
        "grid size-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border transition-colors disabled:cursor-not-allowed disabled:opacity-30",
        checked ? "border-brand bg-brand text-white" : "border-border-strong bg-card",
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

// ---------- Kanban ----------

function Kanban({ ctx, tasks, statuses, onMove, queued }: { ctx: Ctx; tasks: cu.CuTask[]; statuses: cu.CuStatus[]; onMove(ids: string[], s: cu.CuStatus): void; queued: Set<string> }) {
  const [over, setOver] = useState<string | null>(null);
  const known = new Set(statuses.map((s) => s.status.toLowerCase()));
  const extra = tasks.filter((t) => !known.has(t.status.status.toLowerCase()));
  return (
    <div className="flex h-full min-w-max gap-3 px-6 pb-4">
      {statuses.map((s) => {
        const col = tasks
          .filter((t) => t.status.status.toLowerCase() === s.status.toLowerCase())
          .sort((a, b) => Number(ctx.runFor.has(b.id)) - Number(ctx.runFor.has(a.id)) || priorityLevel(b) - priorityLevel(a));
        const isOver = over === s.status;
        return (
          <section
            key={s.status}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(s.status); }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              ctx.dragEnd();
              const ids = e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
              if (ids.length) onMove(ids, s);
            }}
            className={cn(
              "flex w-[300px] shrink-0 flex-col rounded-2xl border transition-colors",
              isOver ? "border-brand/60 bg-brand/5" : "border-transparent bg-muted/60",
            )}
            aria-label={`Colonne ${s.status}`}
          >
            <header className="flex h-11 items-center gap-2 px-3.5">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} />
              <span className="truncate text-[13px] font-semibold inline-block first-letter:uppercase">{s.status}</span>
              <span className="rounded-md bg-card px-1.5 font-mono text-[11.5px] text-muted-foreground">{col.length}</span>
            </header>
            <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {col.map((t) => <TaskCard key={t.id} task={t} ctx={ctx} queued={queued.has(t.id)} />)}
              {isOver && <div className="h-16 shrink-0 rounded-xl border-2 border-dashed border-brand/50" />}
              {!col.length && !isOver && <div className="grid h-20 place-items-center rounded-xl border border-dashed border-border-strong text-[12px] text-muted-foreground">Glisse une tâche ici</div>}
            </div>
          </section>
        );
      })}
      {extra.length > 0 && (
        <section className="flex w-[300px] shrink-0 flex-col rounded-2xl bg-muted/60">
          <header className="flex h-11 items-center gap-2 px-3.5 text-[13px] font-semibold">Autres statuts</header>
          <div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2">
            {extra.map((t) => <TaskCard key={t.id} task={t} ctx={ctx} queued={queued.has(t.id)} showStatus />)}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- Cartes ----------

function Cards({ ctx, tasks, queued }: { ctx: Ctx; tasks: cu.CuTask[]; queued: Set<string> }) {
  const sorted = [...tasks].sort((a, b) =>
    Number(ctx.runFor.has(b.id)) - Number(ctx.runFor.has(a.id)) ||
    priorityLevel(b) - priorityLevel(a) ||
    Number(a.due_date ?? Infinity) - Number(b.due_date ?? Infinity));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 px-6 pb-4">
      {sorted.map((t) => <TaskCard key={t.id} task={t} ctx={ctx} queued={queued.has(t.id)} showStatus />)}
    </div>
  );
}

// ---------- Liste ----------

function ListView({ ctx, tasks, statuses, queued }: { ctx: Ctx; tasks: cu.CuTask[]; statuses: cu.CuStatus[]; queued: Set<string> }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const groups = statuses
    .map((s) => ({ s, rows: withChildren(tasks.filter((t) => t.status.status.toLowerCase() === s.status.toLowerCase())) }))
    .filter((g) => g.rows.length);
  return (
    <div className="px-6 pb-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid h-9 grid-cols-[28px_minmax(0,1fr)_120px_110px_minmax(0,260px)] items-center gap-3 border-b border-border bg-muted/50 px-3 text-[11.5px] font-medium text-muted-foreground">
          <span /><span>Tâche</span><span>Échéance</span><span>Assignés</span><span>Agent</span>
        </div>
        {groups.map(({ s, rows }) => {
          const isFolded = folded.has(s.status);
          return (
            <div key={s.status}>
              <button
                type="button"
                onClick={() => setFolded((f) => { const n = new Set(f); if (n.has(s.status)) n.delete(s.status); else n.add(s.status); return n; })}
                className="flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-[12.5px] font-semibold hover:bg-muted/50"
                aria-expanded={!isFolded}
              >
                <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", !isFolded && "rotate-90")} />
                <span className="size-2.5 rounded-full" style={{ background: s.color }} />
                <span className="inline-block first-letter:uppercase">{s.status}</span>
                <span className="font-mono text-[11.5px] font-normal text-muted-foreground">{rows.length}</span>
              </button>
              {!isFolded && rows.map(({ task: t, sub }) => {
                const run = ctx.runFor.get(t.id);
                const tag = lock.lockOf(t);
                const other = tag && tag !== ctx.myTag ? tag : null;
                const sel = ctx.selected.has(t.id);
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => ctx.dragStart(e, t)}
                    onDragEnd={ctx.dragEnd}
                    className={cn("grid min-h-11 grid-cols-[28px_minmax(0,1fr)_120px_110px_minmax(0,260px)] items-center gap-3 border-b border-border px-3 last:border-b-0 hover:bg-muted/40", sel && "bg-brand/5")}
                  >
                    <Checkbox checked={sel} disabled={Boolean(run || other)} onChange={() => ctx.toggle(t)} />
                    <div className={cn("flex min-w-0 items-center gap-2", sub && "pl-5")}>
                      {sub && <span className="h-3 w-2.5 shrink-0 rounded-bl border-b border-l border-border-strong" aria-hidden />}
                      <PriorityBars task={t} />
                      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{t.custom_id ?? `CU-${t.id}`}</span>
                      <button type="button" onClick={() => void openUrl(t.url)} className="cursor-pointer truncate text-left text-[13.5px] hover:underline">{t.name}</button>
                      {queued.has(t.id) && !run && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">en file</span>}
                    </div>
                    <span><Due due={t.due_date} /></span>
                    <span><Assignees users={t.assignees} /></span>
                    <span className="min-w-0">
                      {run ? <AgentStrip compact run={run} live={ctx.live.get(run.id)} onOpen={() => ctx.openRun(run.id)} /> : other ? <LockBadge task={t} tag={other} onReleased={ctx.reload} /> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- états vides ----------

function Skeleton() {
  return (
    <div className="flex gap-3 px-6">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="w-[300px] shrink-0 rounded-2xl bg-muted/60 p-2">
          <div className="mx-1.5 my-3 h-3 w-24 animate-pulse rounded bg-border" />
          {[0, 1, 2].slice(0, 3 - (i % 2)).map((j) => <div key={j} className="mb-2 h-24 animate-pulse rounded-xl bg-card" />)}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="fade-up max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-muted"><LayoutGrid className="size-5 text-muted-foreground" /></div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{text}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
