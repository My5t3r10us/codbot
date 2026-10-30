// Vue git : graphe des commits (branche principale + branches cu/*) avec, à droite, les
// worktrees et l'agent qui travaille dans chacun. Rafraîchi toutes les 5 s quand visible.
import { ArrowDown, ArrowUp, FileDiff, FolderGit2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type * as db from "../../db";
import * as git from "../../git";
import { layoutGraph } from "../../gitgraph";
import { ago, basename } from "../../app/format";
import { ProjectMark } from "../../app/ProjectSwitcher";
import { useAsync } from "../../app/store";
import { moodOf, STATE_TONE } from "../../labels";
import { Bot } from "../../ui/bot";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { useToast } from "../../ui/toast";
import { StateBadge } from "./runbits";

const LANE = 16;
const ROW = 34;
const COLORS = ["#2563EB", "#16A34A", "#D97706", "#7C3AED", "#DB2777", "#0891B2", "#DC2626", "#4F46E5"];
const laneColor = (i: number) => COLORS[i % COLORS.length];
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

export function GitView({ runsList, project, projects, onOpen }: { runsList: db.Run[]; project: db.Project | null; projects: db.Project[]; onOpen(id: string): void }) {
  const usable = projects.filter((p) => p.repo_path);
  const [picked, setPicked] = useState<string | null>(null);
  const busiest = usable.map((p) => ({ p, n: runsList.filter((r) => r.list_id === p.list_id && !["done", "failed"].includes(r.state)).length })).sort((a, b) => b.n - a.n)[0]?.p;
  const repo = project ?? usable.find((p) => p.list_id === picked) ?? busiest ?? null;
  if (!repo) return <p className="px-6 text-[13px] text-muted-foreground">Aucun projet avec un repo local.</p>;
  return (
    <div className="px-6 pb-6">
      {!project && usable.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {usable.map((p) => (
            <button key={p.list_id} type="button" onClick={() => setPicked(p.list_id)}
              className={cn("inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[13px]", p.list_id === repo.list_id ? "border-brand/50 bg-brand/6 font-medium" : "border-border hover:bg-muted")}>
              <ProjectMark name={p.list_name} listId={p.list_id} size={16} />{p.list_name}
            </button>
          ))}
        </div>
      )}
      <Repo key={repo.list_id} project={repo} runsList={runsList.filter((r) => r.list_id === repo.list_id)} onOpen={onOpen} />
    </div>
  );
}

type WtInfo = git.Worktree & { ahead: number; behind: number; changed: number; run?: db.Run };

function Repo({ project, runsList, onOpen }: { project: db.Project; runsList: db.Run[]; onOpen(id: string): void }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState(false);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const openRuns = runsList.filter((r) => !["done", "failed"].includes(r.state));

  const wts = useAsync<WtInfo[]>(async () => {
    const list = await git.worktreeList(project.repo_path);
    return Promise.all(list.map(async (w, i) => {
      const run = openRuns.find((r) => r.worktree_path && norm(r.worktree_path) === norm(w.path));
      const [ab, changed] = await Promise.all([
        git.aheadBehind(w.path, project.base_branch).catch(() => ({ ahead: 0, behind: 0 })),
        git.changedFiles(w.path).catch(() => 0),
      ]);
      return { ...w, ...ab, changed, run: i === 0 ? undefined : run };
    }));
  }, [project.repo_path, tick, openRuns.map((r) => r.id + r.state).join()], []);

  const extra = wts.data.slice(1).map((w) => w.head).filter(Boolean);
  const log = useAsync(() => git.graphLog(project.repo_path, project.base_branch, extra, 60), [project.repo_path, tick, extra.join()], [] as git.GraphCommit[]);
  const rows = useMemo(() => layoutGraph(log.data), [log.data]);
  const width = Math.max(1, ...rows.map((r) => r.width));

  const runOf = (c: git.GraphCommit) =>
    openRuns.find((r) => (r.branch && c.refs.some((x) => x === r.branch || x.endsWith(`/${r.branch}`))) || wts.data.some((w) => w.run?.id === r.id && w.head === c.sha));

  async function fetchNow() {
    setFetching(true);
    try {
      await git.fetchOrigin(project.repo_path);
      setTick((x) => x + 1);
    } catch (e) {
      toast("git fetch", (e as Error).message, "err");
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
        <header className="flex h-11 items-center gap-2 border-b border-border px-4">
          <FolderGit2 className="size-4 text-muted-foreground" />
          <span className="truncate font-mono text-[12.5px]">{basename(project.repo_path)}</span>
          <span className="text-[12px] text-muted-foreground">· {log.data.length} commits</span>
          <span className="flex-1" />
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><span className="ldot pulse" />direct</span>
          <Button variant="ghost" size="sm" onClick={() => void fetchNow()} disabled={fetching}><RefreshCw className={cn(fetching && "spin")} />Fetch</Button>
        </header>
        {log.error && <p className="px-4 py-3 text-[13px] text-err-fg">{log.error}</p>}
        <div className="overflow-x-auto">
          {rows.map((row, i) => {
            const c = log.data[i];
            const run = runOf(c);
            return (
              <div key={c.sha} className={cn("flex items-center gap-3 pr-4 hover:bg-muted/40", run && "bg-brand/[.03]")} style={{ height: ROW }}>
                <svg width={width * LANE + 8} height={ROW} className="shrink-0" aria-hidden>
                  {row.up.map((s, k) => <line key={`u${k}`} x1={s.from * LANE + 12} y1={0} x2={s.to * LANE + 12} y2={ROW / 2} style={{ stroke: laneColor(s.color) }} strokeWidth={2} strokeLinecap="round" />)}
                  {row.down.map((s, k) => <line key={`d${k}`} x1={s.from * LANE + 12} y1={ROW / 2} x2={s.to * LANE + 12} y2={ROW} style={{ stroke: laneColor(s.color) }} strokeWidth={2} strokeLinecap="round" />)}
                  <circle cx={row.lane * LANE + 12} cy={ROW / 2} r={run ? 5.5 : 4} style={{ fill: run ? laneColor(row.color) : "var(--card)", stroke: laneColor(row.color) }} strokeWidth={2} />
                </svg>
                <span className="w-[58px] shrink-0 font-mono text-[11.5px] text-muted-foreground">{c.sha.slice(0, 7)}</span>
                {c.refs.slice(0, 3).map((r) => (
                  <span key={r} className={cn("shrink-0 rounded-md px-1.5 py-px font-mono text-[11px]", r.startsWith("origin/") ? "border border-border text-muted-foreground" : r.startsWith("tag: ") ? "bg-warn/12 text-warn-fg" : "bg-brand/10 text-brand-fg")}>{r.replace("tag: ", "")}</span>
                ))}
                {run && (
                  <button type="button" onClick={() => onOpen(run.id)} className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px] hover:bg-border" title={run.task_names.join(", ")}>
                    <Bot size={12} mood={moodOf(run.state)} brand={STATE_TONE[run.state] === "run"} />agent
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.subject}</span>
                <span className="hidden shrink-0 text-[12px] text-muted-foreground md:block">{c.author}</span>
                <span className="w-[86px] shrink-0 text-right text-[11.5px] text-muted-foreground">{ago(c.at)}</span>
              </div>
            );
          })}
          {!rows.length && !log.error && <p className="px-4 py-6 text-[13px] text-muted-foreground">{log.loading ? "Lecture de l'historique…" : "Aucun commit."}</p>}
        </div>
      </section>

      <aside className="grid content-start gap-2">
        <h3 className="px-1 text-[13px] font-semibold">Worktrees <span className="font-normal text-muted-foreground">· {wts.data.length}</span></h3>
        {wts.data.map((w, i) => (
          <div
            key={w.path}
            role={w.run ? "button" : undefined}
            onClick={() => w.run && onOpen(w.run.id)}
            className={cn("rounded-xl border bg-card p-3", w.run ? "cursor-pointer border-border hover:border-border-strong" : "border-dashed border-border-strong", w.run && STATE_TONE[w.run.state] === "wait" && "border-warn/45")}
          >
            <div className="flex items-center gap-2">
              {w.run ? <Bot size={20} mood={moodOf(w.run.state)} brand={STATE_TONE[w.run.state] === "run"} /> : <FolderGit2 className="size-4 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{w.branch ?? `détaché @ ${w.head.slice(0, 7)}`}</span>
              {i === 0 && <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">principal</span>}
            </div>
            {w.run && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{w.run.task_names.join(" · ")}</span>
                <StateBadge state={w.run.state} />
              </div>
            )}
            <div className="mt-2 flex items-center gap-3 font-mono text-[11.5px] text-muted-foreground">
              <span className="inline-flex items-center gap-0.5" title="Commits d'avance"><ArrowUp className="size-3" />{w.ahead}</span>
              <span className="inline-flex items-center gap-0.5" title="Commits de retard"><ArrowDown className="size-3" />{w.behind}</span>
              <span className={cn("inline-flex items-center gap-1", w.changed && "text-warn-fg")} title="Fichiers modifiés non commités"><FileDiff className="size-3" />{w.changed}</span>
              <span className="min-w-0 flex-1 truncate text-right" title={w.path}>{basename(w.path)}</span>
            </div>
          </div>
        ))}
        {wts.loading && !wts.data.length && <div className="h-20 animate-pulse rounded-xl bg-muted" />}
      </aside>
    </div>
  );
}
