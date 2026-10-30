// Page Projets : tous les projets avec leurs tâches par statut, leurs agents et l'activité récente.
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Columns3, FolderGit2, GitPullRequest, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as cu from "../clickup";
import * as db from "../db";
import { activityText, ago } from "../app/format";
import { useNav } from "../app/nav";
import { ProjectMark } from "../app/ProjectSwitcher";
import { useAsync, useCurrentProject, useNow, useQueue, useRuns, useRunsLive, useRunsVersion } from "../app/store";
import { moodOf, NEEDS_YOU, OPEN_STATES, STATE_TONE } from "../labels";
import { ACTIVE_STATES } from "../rules";
import { Bot } from "../ui/bot";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Ticker } from "../ui/ticker";
import { useWaiting } from "./agents/DecisionDialog";

type ListStats = { total: number; byStatus: { status: string; color: string; n: number }[] };

export function ProjectsPage() {
  const nav = useNav();
  const { projects, setCurrent, current } = useCurrentProject();
  const runsQ = useRuns();
  const queueQ = useQueue();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((x) => x + 1), 120_000);
    return () => clearInterval(t);
  }, []);
  const stats = useAsync(async () => {
    const out = new Map<string, ListStats | string>();
    await Promise.all(projects.map(async (p) => {
      try {
        const [tasks, list] = await Promise.all([cu.getListTasks(p.list_id), cu.getList(p.list_id)]);
        const byStatus = [...list.statuses].sort((a, b) => a.orderindex - b.orderindex).map((s) => ({
          status: s.status, color: s.color, n: tasks.filter((t) => t.status.status.toLowerCase() === s.status.toLowerCase()).length,
        }));
        out.set(p.list_id, { total: tasks.length, byStatus });
      } catch (e) {
        out.set(p.list_id, (e as Error).message);
      }
    }));
    return out;
  }, [projects.map((p) => p.list_id).join(), tick], new Map<string, ListStats | string>());

  const all = runsQ.data;
  const working = all.filter((r) => ACTIVE_STATES.includes(r.state) && !NEEDS_YOU.includes(r.state)).length;
  // Même compte que le dialogue « À toi de décider » ouvert par ce KPI (runs en pause et permissions comprises).
  const waiting = useWaiting().length;
  const review = all.filter((r) => r.state === "in_review").length;
  const open = all.filter((r) => OPEN_STATES.includes(r.state));
  const live = useRunsLive(open.map((r) => r.id));

  function goTasks(p: db.Project) {
    void setCurrent(p.list_id);
    nav.go("tasks");
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-10">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-[20px] leading-tight font-semibold tracking-tight">Projets</h1>
            <p className="text-[12.5px] text-muted-foreground">Tous tes projets, leurs tâches et leurs agents en un coup d'œil.</p>
          </div>
          <Button variant="outline" onClick={() => nav.go("settings")}><Plus />Ajouter un projet</Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Projets" value={projects.length} />
          <Kpi label="Agents au travail" value={working} tone="var(--brand)" live={working > 0} />
          <Kpi label="Attendent ta décision" value={waiting} tone="var(--warn)" onClick={waiting ? () => nav.openDecision() : undefined} />
          <Kpi label="En file" value={queueQ.data.items.length} />
          <Kpi label="En revue" value={review} tone="var(--rev)" />
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid content-start gap-3 md:grid-cols-[repeat(2,minmax(0,1fr))]">
            {projects.map((p) => (
              <ProjectCard
                key={p.list_id} project={p} current={p.list_id === current?.list_id}
                stats={stats.data.get(p.list_id)} loading={stats.loading}
                runsList={all.filter((r) => r.list_id === p.list_id)}
                queued={queueQ.data.items.filter((i) => i.list_id === p.list_id).length}
                live={live}
                onTasks={() => goTasks(p)}
                onAgents={() => { void setCurrent(p.list_id); nav.go("agents"); }}
                onOpenRun={nav.openRun}
                onSettings={() => nav.go("settings")}
              />
            ))}
            {!projects.length && (
              <div className="col-span-full grid place-items-center rounded-2xl border border-dashed border-border-strong px-6 py-14 text-center">
                <FolderGit2 className="size-6 text-muted-foreground" />
                <p className="mt-2 text-[14px] font-medium">Aucun projet</p>
                <p className="mt-1 text-[13px] text-muted-foreground">Associe une liste ClickUp à un repo local pour commencer.</p>
                <Button variant="brand" className="mt-4" onClick={() => nav.go("settings")}><Settings2 />Ouvrir les réglages</Button>
              </div>
            )}
          </div>
          <Feed projects={projects} runsList={all} onOpenRun={nav.openRun} />
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, live, onClick }: { label: string; value: number; tone?: string; live?: boolean; onClick?(): void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} className={cn("rounded-xl border border-border bg-card px-3.5 py-3 text-left", onClick && "cursor-pointer hover:border-border-strong")}>
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {tone && <span className={cn("size-2 rounded-full", live && "pulse")} style={{ background: tone }} />}
        {label}
      </div>
      <div className="mt-1 text-[24px] leading-none font-semibold tabular-nums"><Ticker value={value} /></div>
    </Tag>
  );
}

function ProjectCard({ project: p, current, stats, loading, runsList, queued, live, onTasks, onAgents, onOpenRun, onSettings }: {
  project: db.Project; current: boolean; stats?: ListStats | string; loading: boolean; runsList: db.Run[]; queued: number;
  live: Map<string, import("../app/store").RunLive>; onTasks(): void; onAgents(): void; onOpenRun(id: string): void; onSettings(): void;
}) {
  const now = useNow();
  const open = runsList.filter((r) => OPEN_STATES.includes(r.state));
  const prs = runsList.filter((r) => r.state === "in_review" && r.pr_url);
  const lastAt = runsList[0] ? Date.parse(runsList[0].ended_at ?? runsList[0].created_at) : null;
  const s = typeof stats === "object" ? stats : null;

  return (
    <article className={cn("fade-up flex flex-col rounded-2xl border bg-card p-4", current ? "border-brand/40" : "border-border")}>
      <header className="flex items-start gap-3">
        <ProjectMark name={p.list_name} listId={p.list_id} size={32} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{p.list_name}</h2>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground">{p.repo_path ? `${p.repo_path.split(/[\\/]/).pop()} · ${p.base_branch}` : "repo à renseigner"}</p>
        </div>
        {current && <span className="rounded-md bg-brand/10 px-1.5 py-px text-[11px] font-medium text-brand-fg">actuel</span>}
      </header>

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[12px] text-muted-foreground">
          <span><b className="text-[15px] font-semibold text-foreground">{s?.total ?? "—"}</b> tâches ouvertes</span>
          {lastAt && <span>actif {ago(lastAt, now)}</span>}
        </div>
        {s ? (
          <>
            <div className="mt-2 flex h-2 gap-[2px] overflow-hidden rounded-full bg-muted">
              {s.byStatus.filter((b) => b.n).map((b) => (
                <span key={b.status} title={`${b.status} : ${b.n}`} style={{ flexGrow: b.n, background: b.color }} className="transition-[flex-grow] duration-700" />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {s.byStatus.filter((b) => b.n).slice(0, 5).map((b) => (
                <span key={b.status} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ background: b.color }} /><span className="inline-block first-letter:uppercase">{b.status}</span><b className="font-mono font-medium text-foreground">{b.n}</b>
                </span>
              ))}
            </div>
          </>
        ) : typeof stats === "string" ? (
          <p className="mt-2 text-[12px] text-err-fg">{stats}</p>
        ) : (
          <div className={cn("mt-2 h-2 rounded-full bg-muted", loading && "animate-pulse")} />
        )}
      </div>

      <div className="mt-4 grid min-w-0 gap-1.5">
        {open.slice(0, 3).map((r) => {
          const tone = STATE_TONE[r.state];
          return (
            <button key={r.id} type="button" onClick={() => onOpenRun(r.id)} className={cn("flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2 text-left hover:bg-muted/50", tone === "wait" ? "border-warn/40" : "border-border")}>
              <Bot size={18} mood={moodOf(r.state)} brand={tone === "run"} />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                <span className="font-medium">{r.task_names[0]}</span>
                <span className={cn("ml-2", tone === "run" ? "shimmer-text" : tone === "wait" ? "text-warn-fg" : "text-muted-foreground")}>{activityText(r, live.get(r.id)?.ev)}</span>
              </span>
            </button>
          );
        })}
        {open.length > 3 && <button type="button" onClick={onAgents} className="cursor-pointer text-left text-[12px] text-muted-foreground hover:text-foreground">+ {open.length - 3} autre{open.length - 3 > 1 ? "s" : ""} agent{open.length - 3 > 1 ? "s" : ""}</button>}
        {!open.length && <p className="flex h-9 items-center gap-2 text-[12.5px] text-muted-foreground"><Bot size={16} mood="sleep" />Aucun agent sur ce projet</p>}
      </div>

      <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {queued > 0 && <span className="text-[12px] text-muted-foreground">{queued} en file</span>}
        {prs.map((r) => (
          <button key={r.id} type="button" onClick={() => void openUrl(r.pr_url!)} className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-rev/10 px-1.5 text-[11.5px] text-rev-fg hover:bg-rev/15" title={r.task_names.join(", ")}>
            <GitPullRequest className="size-3" />PR
          </button>
        ))}
        <span className="flex-1" />
        {!p.repo_path ? (
          <Button size="sm" variant="outline" onClick={onSettings}><Settings2 />Configurer</Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onAgents}>Agents</Button>
            <Button size="sm" variant="outline" onClick={onTasks}><Columns3 />Tâches<ArrowRight /></Button>
          </>
        )}
      </footer>
    </article>
  );
}

const FEED_TYPES = ["git", "status", "permission", "error", "steer"];

function Feed({ projects, runsList, onOpenRun }: { projects: db.Project[]; runsList: db.Run[]; onOpenRun(id: string): void }) {
  const v = useRunsVersion();
  const now = useNow();
  const events = useAsync(() => db.listRecentEvents(30, FEED_TYPES), [v], [] as db.RunEvent[]);
  return (
    <aside className="h-fit rounded-2xl border border-border bg-card xl:sticky xl:top-0">
      <header className="flex h-11 items-center gap-2 border-b border-border px-4">
        <span className="ldot pulse" />
        <h2 className="text-[13.5px] font-semibold">Activité en direct</h2>
      </header>
      <ol className="max-h-[640px] overflow-y-auto px-2 py-2">
        {events.data.map((e) => {
          const run = runsList.find((r) => r.id === e.run_id);
          const p = run ? projects.find((x) => x.list_id === run.list_id) : undefined;
          const dot = e.type === "error" ? "var(--err)" : e.type === "permission" ? "var(--warn)" : e.type === "git" ? "var(--ok)" : e.type === "steer" ? "var(--brand)" : "var(--faint)";
          return (
            <li key={e.id}>
              <button type="button" onClick={() => run && onOpenRun(run.id)} className="fresh flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/60">
                <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: dot }} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px]">{e.text}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    {p && <ProjectMark name={p.list_name} listId={p.list_id} size={12} />}
                    <span className="truncate">{run?.task_names[0] ?? "run supprimé"}</span>
                    <span>· {ago(e.at, now)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {!events.data.length && <li className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">Rien pour l'instant.</li>}
      </ol>
    </aside>
  );
}
