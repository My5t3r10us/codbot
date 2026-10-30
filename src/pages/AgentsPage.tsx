// Page Agents : runs et file d'attente en Kanban, en arbre (agents → sous-agents) ou sur le
// graphe git (branches et worktrees). Ouvre la session d'un run et l'arbre de décision.
import { Columns3, GitFork, GripVertical, Hand, ListTree, Pause, Play, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import * as cu from "../clickup";
import type * as db from "../db";
import * as queue from "../queue";
import * as runs from "../runs";
import { activityText, ago, planProgress } from "../app/format";
import { useNav } from "../app/nav";
import { ProjectMark } from "../app/ProjectSwitcher";
import { useAsync, useCurrentProject, useNow, useQueue, useQueueVersion, useRuns, useRunsLive, useSetting, type RunLive } from "../app/store";
import { moodOf, NEEDS_YOU, STATE_TONE, TONE_COLOR } from "../labels";
import { Bot } from "../ui/bot";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Segmented } from "../ui/segmented";
import { useToast } from "../ui/toast";
import { AgentTree } from "./agents/AgentTree";
import { DecisionDialog, useWaiting } from "./agents/DecisionDialog";
import { GitView } from "./agents/GitView";
import { Elapsed, StateBadge } from "./agents/runbits";
import { SessionSheet } from "./agents/SessionSheet";

type Mode = "kanban" | "tree" | "git";
type Scope = "project" | "all";

const COLUMNS: { key: string; title: string; states: db.RunState[]; tone: string }[] = [
  { key: "work", title: "Au travail", states: ["preparing", "running", "pushing"], tone: "var(--brand)" },
  { key: "you", title: "À toi", states: ["waiting_permission", "waiting_reply", "blocked", "stopped", "paused"], tone: "var(--warn)" },
  { key: "review", title: "En revue", states: ["in_review"], tone: "var(--rev)" },
  { key: "done", title: "Terminé", states: ["done", "failed"], tone: "var(--ok)" },
];
const DONE_WINDOW_MS = 48 * 3600_000;

export function AgentsPage({ openRunId, onSheetChange, decisionFor, onDecisionClose }: {
  openRunId: string | null; onSheetChange(id: string | null): void; decisionFor: string | null | undefined; onDecisionClose(): void;
}) {
  const nav = useNav();
  const toast = useToast();
  const { projects, current } = useCurrentProject();
  const [mode, setMode] = useSetting<Mode>("agents_view", "kanban");
  const [scope, setScope] = useSetting<Scope>("agents_scope", "all");
  const runsQ = useRuns();
  const queueQ = useQueue();
  const waiting = useWaiting();
  const now = useNow();

  const inScope = (listId: string) => scope === "all" || listId === current?.list_id;
  const list = useMemo(() => runsQ.data.filter((r) => inScope(r.list_id)), [runsQ.data, scope, current]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = queueQ.data.items.filter((i) => inScope(i.list_id));
  const live = useRunsLive(list.filter((r) => !["done", "failed"].includes(r.state)).map((r) => r.id));
  const working = list.filter((r) => COLUMNS[0].states.includes(r.state)).length;
  const qs = queueQ.data.status;

  async function toggleQueue() {
    try {
      if (qs.running) await queue.stop();
      else await queue.start();
      toast(qs.running ? "File arrêtée" : "File démarrée", qs.running ? undefined : "Les tâches s'enchaînent, l'anti-veille est actif");
    } catch (e) {
      toast("File", (e as Error).message, "err");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-5 pb-3">
        <div className="mr-2">
          <h1 className="text-[20px] leading-tight font-semibold tracking-tight">Agents</h1>
          <p className="text-[12.5px] text-muted-foreground">
            {working} au travail · {waiting.filter((r) => inScope(r.list_id)).length} attendent ta décision · {items.length} en file
          </p>
        </div>
        <span className="flex-1" />
        <Segmented<Scope>
          value={scope} onChange={(v) => void setScope(v)} label="Portée"
          options={[{ value: "project", label: current?.list_name ?? "Ce projet", disabled: !current }, { value: "all", label: "Tous les projets" }]}
        />
        <Segmented<Mode>
          value={mode} onChange={(v) => void setMode(v)} label="Vue"
          options={[
            { value: "kanban", label: <><Columns3 />Kanban</> },
            { value: "tree", label: <><ListTree />Arbre</> },
            { value: "git", label: <><GitFork />Git</> },
          ]}
        />
        <Button variant={qs.running ? "outline" : "default"} onClick={() => void toggleQueue()}>
          {qs.running ? <Pause /> : <Play />}
          {qs.running ? "Arrêter la file" : "Démarrer la file"}
        </Button>
      </div>

      {qs.running && qs.pausedUntil && qs.pausedUntil > now && (
        <div className="mx-6 mb-3 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-[13px] text-warn-fg">
          File en pause (limite d'usage) jusqu'à {new Date(qs.pausedUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, elle reprendra seule.
        </div>
      )}
      {waiting.length > 0 && (
        <div className="fade-up mx-6 mb-3 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/8 px-3.5 py-2.5">
          <Bot size={22} mood="wait" />
          <span className="flex-1 text-[13.5px]">
            <b className="font-semibold">{waiting.length} agent{waiting.length > 1 ? "s" : ""}</b> {waiting.length > 1 ? "attendent" : "attend"} ta décision
            <span className="text-muted-foreground"> · {waiting.slice(0, 2).map((r) => r.task_names[0]).join(", ")}</span>
          </span>
          <Button variant="warn" size="sm" onClick={() => nav.openDecision()}><Hand />Décider</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "kanban" && <Kanban runsList={list} items={items} live={live} projects={projects} showProject={scope === "all"} onOpen={onSheetChange} onDecide={nav.openDecision} />}
        {mode === "tree" && <AgentTree runsList={list} live={live} onOpen={onSheetChange} />}
        {mode === "git" && <GitView runsList={list} project={scope === "project" ? current : null} projects={projects} onOpen={onSheetChange} />}
      </div>

      <SessionSheet runId={openRunId} onClose={() => onSheetChange(null)} onDecide={(id) => { onSheetChange(null); nav.openDecision(id); }} />
      <DecisionDialog runId={decisionFor} onClose={onDecisionClose} onOpenRun={onSheetChange} />
    </div>
  );
}

// ---------- Kanban ----------

function Kanban({ runsList, items, live, projects, showProject, onOpen, onDecide }: {
  runsList: db.Run[]; items: db.QueueItem[]; live: Map<string, RunLive>; projects: db.Project[]; showProject: boolean;
  onOpen(id: string): void; onDecide(id: string): void;
}) {
  const now = useNow();
  return (
    <div className="flex h-full min-w-max gap-3 px-6 pb-4">
      <QueueColumn items={items} projects={projects} showProject={showProject} />
      {COLUMNS.map((c) => {
        const col = runsList
          .filter((r) => c.states.includes(r.state))
          .filter((r) => c.key !== "done" || now - Date.parse(r.ended_at ?? r.created_at) < DONE_WINDOW_MS)
          .slice(0, c.key === "done" ? 15 : undefined);
        return (
          <section key={c.key} className="flex w-[268px] shrink-0 flex-col rounded-2xl bg-muted/60">
            <header className="flex h-11 items-center gap-2 px-3.5">
              <span className="size-2.5 rounded-full" style={{ background: c.tone }} />
              <span className="text-[13px] font-semibold">{c.title}</span>
              <span className="rounded-md bg-card px-1.5 font-mono text-[11.5px] text-muted-foreground">{col.length}</span>
              {c.key === "done" && <span className="ml-auto text-[11.5px] text-muted-foreground">48 h</span>}
            </header>
            <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {col.map((r) => (
                <RunCard key={r.id} run={r} live={live.get(r.id)} project={showProject ? projects.find((p) => p.list_id === r.list_id) : undefined} onOpen={() => onOpen(r.id)} onDecide={() => onDecide(r.id)} />
              ))}
              {!col.length && <div className="grid h-20 place-items-center rounded-xl border border-dashed border-border-strong text-[12px] text-muted-foreground">Aucun agent</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function RunCard({ run, live, project, onOpen, onDecide }: { run: db.Run; live?: RunLive; project?: db.Project; onOpen(): void; onDecide?(): void }) {
  const tone = STATE_TONE[run.state];
  const progress = planProgress(live?.plan);
  const ended = run.state === "done" || run.state === "failed";
  const waits = NEEDS_YOU.includes(run.state) || run.state === "paused" || [...runs.permissions.values()].some((p) => p.runId === run.id);
  return (
    <div
      role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn("fade-up group/run relative cursor-pointer overflow-hidden rounded-xl border bg-card p-3 shadow-xs transition-[border-color,box-shadow] hover:shadow-sm", waits ? "border-warn/45" : "border-border hover:border-border-strong")}
    >
      {tone === "run" && <span className="bar-live absolute top-0 right-0 left-0 h-[2px]" aria-hidden />}
      <div className="flex items-start gap-2.5">
        <Bot size={24} mood={moodOf(run.state)} brand={tone === "run"} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13.5px] leading-snug font-medium">{run.task_names.join(" · ")}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
            <StateBadge state={run.state} />
            {project && <span className="inline-flex items-center gap-1"><ProjectMark name={project.list_name} listId={project.list_id} size={12} />{project.list_name}</span>}
            {ended ? <span>{ago(run.ended_at ?? run.created_at)}</span> : <Elapsed run={run} />}
          </div>
        </div>
      </div>
      {!ended && (
        <p className={cn("mt-2 truncate text-[12.5px]", tone === "run" ? "shimmer-text" : tone === "wait" ? "text-warn-fg" : tone === "err" ? "text-err-fg" : "text-muted-foreground")}>
          {activityText(run, live?.ev)}
        </p>
      )}
      {ended && run.error && <p className="mt-2 line-clamp-2 text-[12px] text-err-fg">{run.error}</p>}
      {progress !== null && !ended && (
        <div className="mt-2 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${progress * 100}%`, background: TONE_COLOR[tone] }} />
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{Math.round(progress * 100)} %</span>
        </div>
      )}
      {(run.branch || waits) && (
        <div className="mt-2.5 flex items-center gap-2">
          {run.branch && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{run.branch}</span>}
          <span className="flex-1" />
          {waits && onDecide && !ended && (
            <Button variant="warn" size="sm" onClick={(e) => { e.stopPropagation(); onDecide(); }}><Hand />Décider</Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- file d'attente ----------

function QueueColumn({ items, projects, showProject }: { items: db.QueueItem[]; projects: db.Project[]; showProject: boolean }) {
  const toast = useToast();
  const nav = useNav();
  const qv = useQueueVersion();
  const report = useAsync(() => queue.lastReport(), [qv], null);
  const [drag, setDrag] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function launchNow(item: db.QueueItem) {
    const project = projects.find((p) => p.list_id === item.list_id);
    if (!project) return toast("Projet introuvable", item.list_id, "err");
    setBusy(item.id);
    try {
      // On sort l'élément de la file avant de lancer : la boucle de la file ne peut plus le lancer en double.
      if (!(await queue.remove(item.id))) return toast("Déjà lancée", "La file vient de lancer cette tâche");
      try {
        const tasks = await Promise.all(item.task_ids.map((id) => cu.getTask(id)));
        const ids = await runs.launch(tasks, project, { mode: item.mode, strategy: item.strategy, brief: item.brief ?? undefined, statusMode: item.status_mode ?? undefined });
        nav.openRun(ids[0]);
      } catch (e) {
        await queue.requeue(item);
        throw e;
      }
    } catch (e) {
      toast("Lancement impossible", (e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  }

  async function dropOn(target: string) {
    if (!drag || drag === target) return;
    const ids = items.map((i) => i.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    setDrag(null);
    await queue.reorder(ids);
  }

  return (
    <section className="flex w-[260px] shrink-0 flex-col rounded-2xl border border-dashed border-border-strong">
      <header className="flex h-11 items-center gap-2 px-3.5">
        <span className="size-2.5 rounded-full bg-faint" />
        <span className="text-[13px] font-semibold">File d'attente</span>
        <span className="rounded-md bg-muted px-1.5 font-mono text-[11.5px] text-muted-foreground">{items.length}</span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {items.map((item, i) => {
          const project = projects.find((p) => p.list_id === item.list_id);
          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData("text/plain", `queue:${item.id}`); setDrag(item.id); }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => drag && e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void dropOn(item.id); }}
              className={cn("group/q rounded-xl border border-border bg-card p-2.5 shadow-xs", drag === item.id && "opacity-40")}
            >
              <div className="flex items-start gap-1.5">
                <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-faint" />
                <span className="mt-px font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[13px] leading-snug font-medium">{item.task_names.join(" · ")}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
                    {showProject && project && <span className="inline-flex items-center gap-1"><ProjectMark name={project.list_name} listId={project.list_id} size={12} />{project.list_name}</span>}
                    <span>{item.strategy === "branche" ? "branche + PR" : "commit direct"}</span>
                    {item.task_ids.length > 1 && <span>groupé</span>}
                    {item.brief && <span>brief modifié</span>}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-1 opacity-70 transition-opacity group-hover/q:opacity-100">
                <Button variant="ghost" size="icon-sm" aria-label="Retirer de la file" title="Retirer" onClick={() => void queue.remove(item.id)}><Trash /></Button>
                <Button variant="outline" size="sm" disabled={busy === item.id} onClick={() => void launchNow(item)}><Play />Lancer</Button>
              </div>
            </div>
          );
        })}
        {!items.length && (
          <div className="grid h-20 place-items-center rounded-xl px-3 text-center text-[12px] text-muted-foreground">
            Ajoute des tâches depuis la page Tâches (« Ajouter à la file »).
          </div>
        )}
      </div>
      {report.data && (
        <footer className="border-t border-dashed border-border-strong px-3.5 py-2.5 text-[11.5px] text-muted-foreground">
          Dernière file · <span className="text-foreground">{report.data.headline}</span>
          <span className="block">{ago(report.data.session.started_at)}{report.data.session.ended_at ? "" : " · en cours"}</span>
        </footer>
      )}
    </section>
  );
}
