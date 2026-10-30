// Vue arbre : Codbot → projets → agents (runs) → plan et sous-agents, en direct.
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import * as db from "../../db";
import { subagentsFromEvents, type Subagent } from "../../live";
import * as runs from "../../runs";
import { activityText, mmss, parseTodos, toolText } from "../../app/format";
import { ProjectMark } from "../../app/ProjectSwitcher";
import { useAsync, useNow, useProjects, useRunsVersion, type RunLive } from "../../app/store";
import { moodOf, STATE_TONE } from "../../labels";
import { Bot } from "../../ui/bot";
import { cn } from "../../ui/cn";
import { Elapsed, StateBadge } from "./runbits";

const RECENT_MS = 24 * 3600_000;

export function AgentTree({ runsList, live, onOpen }: { runsList: db.Run[]; live: Map<string, RunLive>; onOpen(id: string): void }) {
  const now = useNow();
  const v = useRunsVersion();
  const projects = useProjects().data;
  const shown = runsList.filter((r) => !["done", "failed"].includes(r.state) || now - Date.parse(r.ended_at ?? r.created_at) < RECENT_MS);
  const ids = shown.filter((r) => !["done", "failed"].includes(r.state)).map((r) => r.id);
  const subEvents = useAsync(() => db.eventsOfRuns(ids, ["subagent"]), [ids.join(","), v], [] as db.RunEvent[]).data;
  const subsByRun = useMemo(() => {
    const m = new Map<string, Subagent[]>();
    for (const id of ids) m.set(id, subagentsFromEvents(subEvents.filter((e) => e.run_id === id)));
    return m;
  }, [subEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const m = new Map<string, db.Run[]>();
    for (const r of shown) m.set(r.list_id, [...(m.get(r.list_id) ?? []), r]);
    return [...m.entries()];
  }, [shown]);
  const active = shown.filter((r) => STATE_TONE[r.state] === "run").length;

  return (
    <div className="px-6 pb-6">
      <div className="max-w-[920px] rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <Bot size={30} brand mood={active ? "run" : "idle"} />
          <div>
            <div className="text-[14px] font-semibold">Codbot</div>
            <div className="text-[12px] text-muted-foreground">{active} agent{active > 1 ? "s" : ""} au travail · {shown.length} run{shown.length > 1 ? "s" : ""} sur 24 h</div>
          </div>
        </div>
        {!groups.length && <p className="mt-4 ml-11 text-[13px] text-muted-foreground">Aucun agent pour l'instant. Confie une tâche depuis la page Tâches.</p>}
        <Branch>
          {groups.map(([listId, list]) => {
            const p = projects.find((x) => x.list_id === listId);
            return (
              <Node key={listId} label={
                <span className="flex items-center gap-2">
                  <ProjectMark name={p?.list_name ?? "?"} listId={listId} size={20} />
                  <span className="text-[13.5px] font-semibold">{p?.list_name ?? listId}</span>
                  <span className="text-[12px] text-muted-foreground">{list.length} run{list.length > 1 ? "s" : ""}</span>
                </span>
              }>
                {list.map((r) => <RunNode key={r.id} run={r} live={live.get(r.id)} subs={subsByRun.get(r.id) ?? []} onOpen={() => onOpen(r.id)} now={now} />)}
              </Node>
            );
          })}
        </Branch>
      </div>
    </div>
  );
}

function Branch({ children }: { children: React.ReactNode }) {
  return <ul className="relative mt-2 ml-[14px] border-l-2 border-line-tree [&>li:last-child]:before:bg-card">{children}</ul>;
}

/** Nœud de l'arbre, avec son coude de liaison et ses enfants repliables. */
function Node({ label, children, defaultOpen = true }: { label: React.ReactNode; children?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const has = Boolean(children) && (!Array.isArray(children) || children.length > 0);
  return (
    <li className="relative pt-2 pl-6 before:absolute before:top-[25px] before:-bottom-px before:-left-0.5 before:w-0.5 last:before:content-['']">
      <span className="absolute top-[24px] left-0 h-0.5 w-5 bg-line-tree" aria-hidden />
      <div className="flex items-start gap-1">
        {has ? (
          <button type="button" onClick={() => setOpen(!open)} className="mt-[7px] grid size-5 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-muted" aria-expanded={open} aria-label={open ? "Replier" : "Déplier"}>
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : <span className="w-5 shrink-0" />}
        <div className="min-w-0 flex-1">{label}</div>
      </div>
      {has && open && <Branch>{children}</Branch>}
    </li>
  );
}

function RunNode({ run, live, subs, onOpen, now }: { run: db.Run; live?: RunLive; subs: Subagent[]; onOpen(): void; now: number }) {
  const tone = STATE_TONE[run.state];
  const todos = live?.plan ? parseTodos(live.plan.text) : [];
  const cur = todos.find((t) => t.status === "in_progress");
  const done = todos.filter((t) => t.status === "completed").length;
  const ended = ["done", "failed"].includes(run.state);
  return (
    <Node defaultOpen={!ended} label={
      <button type="button" onClick={onOpen} className={cn("flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-muted/50", tone === "wait" ? "border-warn/45" : "border-border")}>
        <Bot size={22} mood={moodOf(run.state)} brand={tone === "run"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{run.task_names.join(" · ")}</span>
          <span className={cn("block truncate text-[12px]", tone === "run" ? "shimmer-text" : "text-muted-foreground")}>{ended ? run.branch ?? run.git_strategy : activityText(run, live?.ev)}</span>
        </span>
        <StateBadge state={run.state} />
        <span className="w-14 text-right text-[12px] text-muted-foreground"><Elapsed run={run} /></span>
      </button>
    }>
      {!ended && todos.length > 0 && (
        <Node label={
          <div className="flex h-9 items-center gap-2.5 text-[12.5px]">
            <span className="font-medium">Plan</span>
            <span className="h-1 w-24 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-brand" style={{ width: `${(done / todos.length) * 100}%` }} /></span>
            <span className="font-mono text-muted-foreground">{done}/{todos.length}</span>
            {cur && <span className={cn("min-w-0 truncate", run.state === "running" ? "shimmer-text" : "text-muted-foreground")}>{cur.activeForm ?? cur.content}</span>}
          </div>
        } />
      )}
      {!ended && subs.map((s) => {
        const act = s.status === "running" ? runs.subagentActivity(s.id) : null;
        return (
          <Node key={s.id} label={
            <div className="flex h-9 items-center gap-2 text-[12.5px]">
              <Bot size={16} mood={s.status === "running" ? "run" : s.status === "error" ? "err" : "idle"} />
              <span className="min-w-0 truncate font-medium">{s.description || s.type}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{s.type}</span>
              {act && <span className="min-w-0 truncate shimmer-text">{toolText(act).name} {toolText(act).target}</span>}
              <span className="flex-1" />
              {s.status === "running" && <LoaderCircle className="spin size-3.5 text-brand" />}
              <span className="font-mono text-[11.5px] text-muted-foreground">{mmss((s.endedAt ?? now) - s.startedAt)}</span>
            </div>
          } />
        );
      })}
    </Node>
  );
}
