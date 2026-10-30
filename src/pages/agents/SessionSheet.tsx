// Panneau de session d'un run : Étapes (plan + sous-agents + consignes en file), Activité,
// Trace, Diff et Terminal, avec la zone de consigne en bas.
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check, CircleCheck, CircleX, CornerDownRight, Ellipsis, GitBranch, GitPullRequest, Hand, LoaderCircle,
  Play, RefreshCw, RotateCcw, Send, Square, SquareTerminal, Trash, X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as db from "../../db";
import * as git from "../../git";
import { planFromEvents, subagentsFromEvents, type PlanItem } from "../../live";
import * as runs from "../../runs";
import { basename, dur, mmss, toolText } from "../../app/format";
import { useAsync, useNow, useProjects, useRunEvents, useRuns, useRunsVersion } from "../../app/store";
import { moodOf, NEEDS_YOU } from "../../labels";
import { Bot } from "../../ui/bot";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { CloseButton, Dialog, DialogDescription, DialogTitle, SheetContent } from "../../ui/dialog";
import { Kbd, Textarea } from "../../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Segmented } from "../../ui/segmented";
import { useToast } from "../../ui/toast";
import { ProjectMark } from "../../app/ProjectSwitcher";
import { Elapsed, StateBadge, taskUrl, ToolIcon } from "./runbits";

type Tab = "steps" | "activity" | "trace" | "diff" | "term";
const DONE: db.RunState[] = ["done", "failed"];

export function SessionSheet({ runId, onClose, onDecide }: { runId: string | null; onClose(): void; onDecide(runId: string): void }) {
  return (
    <Dialog open={Boolean(runId)} onOpenChange={(o) => !o && onClose()}>
      {runId && (
        <SheetContent className="w-[min(760px,100vw)]" aria-describedby={undefined}>
          <Session runId={runId} onDecide={onDecide} />
        </SheetContent>
      )}
    </Dialog>
  );
}

function Session({ runId, onDecide }: { runId: string; onDecide(runId: string): void }) {
  const toast = useToast();
  const runsQ = useRuns();
  const fallback = useAsync(() => db.getRun(runId), [runId, runsQ.data], null);
  const run = runsQ.data.find((r) => r.id === runId) ?? fallback.data;
  const events = useRunEvents(runId).data;
  const projects = useProjects().data;
  const [tab, setTab] = useState<Tab>("steps");
  if (!run) return <div className="p-6 text-[13px] text-muted-foreground">Chargement…</div>;

  const project = projects.find((p) => p.list_id === run.list_id);
  const pending = [...runs.permissions.values()].filter((p) => p.runId === run.id);
  const needsYou = pending.length > 0 || NEEDS_YOU.includes(run.state) || run.state === "paused";

  async function act(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast(label, run!.task_names.join(", "));
    } catch (e) {
      toast("Action impossible", (e as Error).message, "err");
    }
  }

  return (
    <>
      <header className="border-b border-border px-5 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <Bot size={34} mood={moodOf(run.state)} brand={run.state === "running"} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[16px] leading-snug font-semibold">{run.task_names.join(" · ")}</DialogTitle>
            <DialogDescription asChild>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted-foreground">
                <StateBadge state={run.state} />
                {project && <span className="inline-flex items-center gap-1.5"><ProjectMark name={project.list_name} listId={project.list_id} size={14} />{project.list_name}</span>}
                <Elapsed run={run} />
                {run.branch && <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="size-3" />{run.branch}</span>}
                {run.task_ids.map((id) => (
                  <button key={id} type="button" onClick={() => void openUrl(taskUrl(id))} className="cursor-pointer font-mono hover:text-foreground hover:underline">CU-{id}</button>
                ))}
              </div>
            </DialogDescription>
          </div>
          <CloseButton />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {needsYou && !DONE.includes(run.state) && (
            <Button variant="warn" size="sm" onClick={() => onDecide(run.id)}><Hand />Décider</Button>
          )}
          {["running", "preparing", "waiting_permission", "waiting_reply"].includes(run.state) && (
            <Button variant="outline" size="sm" onClick={() => void act("Agent arrêté", () => runs.stopRun(run.id))}><Square />Arrêter</Button>
          )}
          {["stopped", "blocked", "paused"].includes(run.state) && (
            <Button variant="outline" size="sm" onClick={() => void act("Agent relancé", () => runs.resumeRun(run.id))}><Play />Reprendre</Button>
          )}
          {run.pr_url && <Button variant="outline" size="sm" onClick={() => void openUrl(run.pr_url!)}><GitPullRequest />Voir la PR</Button>}
          {run.state === "in_review" && (
            <Button variant="outline" size="sm" onClick={() => void act("Revue vérifiée", () => runs.checkReview(run.id))}><RefreshCw />Vérifier le merge</Button>
          )}
          <span className="flex-1" />
          {!DONE.includes(run.state) && (
            <Popover>
              <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Plus d'actions"><Ellipsis /></Button></PopoverTrigger>
              <PopoverContent align="end" className="w-[250px] p-1">
                <MenuItem icon={<SquareTerminal />} label="Ouvrir dans un terminal" onClick={() => void act("Session ouverte dans un terminal", () => runs.openInTerminal(run.id))} />
                {["blocked", "stopped"].includes(run.state) && (
                  <MenuItem icon={<RotateCcw />} label="Relivrer les commits" onClick={() => void act("Livraison relancée", () => runs.retryDeliver(run.id))} />
                )}
                <MenuItem
                  danger icon={<Trash />} label="Abandonner le run"
                  onClick={async () => {
                    const yes = await ask("Abandonner ce run ? Le worktree et la branche non poussée sont supprimés, les statuts ClickUp remis comme avant.", { title: "Codbot", kind: "warning" });
                    if (yes) await act("Run abandonné", () => runs.abandonRun(run.id));
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
        <Segmented<Tab>
          className="mt-3 w-full" value={tab} onChange={setTab} label="Vue de la session"
          options={[
            { value: "steps", label: "Étapes" },
            { value: "activity", label: "Activité" },
            { value: "trace", label: "Trace" },
            { value: "diff", label: "Diff" },
            { value: "term", label: "Terminal" },
          ]}
        />
      </header>

      {run.error && ["blocked", "failed"].includes(run.state) && (
        <div className="mx-5 mt-3 rounded-lg border border-err/30 bg-err/6 px-3 py-2 text-[12.5px] whitespace-pre-wrap text-err-fg">{run.error.slice(0, 600)}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "steps" && <Steps run={run} events={events} />}
        {tab === "activity" && <Activity events={events} />}
        {tab === "trace" && <Trace run={run} events={events} />}
        {tab === "diff" && <Diff run={run} />}
        {tab === "term" && <Term events={events} />}
      </div>

      {!DONE.includes(run.state) && <Composer run={run} />}
    </>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick(): void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-muted [&_svg]:size-3.5", danger && "text-err-fg")}>
      {icon}{label}
    </button>
  );
}

// ---------- Étapes ----------

function Steps({ run, events }: { run: db.Run; events: db.RunEvent[] }) {
  const now = useNow();
  useRunsVersion();
  const plan = useMemo(() => planFromEvents(events), [events]);
  const subs = useMemo(() => subagentsFromEvents(events), [events]);
  const steers = runs.steerList(run.id);
  const done = plan.filter((p) => p.status === "completed").length;
  const last = [...events].reverse().find((e) => e.type === "tool" || e.type === "agent");

  return (
    <div className="px-5 py-4">
      {plan.length ? (
        <>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-[13px] font-semibold">Plan de l'agent</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${(done / plan.length) * 100}%` }} />
            </span>
            <span className="font-mono text-[12px] text-muted-foreground">{done}/{plan.length}</span>
          </div>
          <ol className="relative">
            {plan.map((p, i) => <Step key={`${i}-${p.content}`} item={p} last={i === plan.length - 1} now={now} live={run.state === "running"} />)}
          </ol>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-center text-[13px] text-muted-foreground">
          <Bot size={22} mood={run.state === "running" ? "run" : "idle"} className="mx-auto mb-2" />
          {run.state === "running" ? "L'agent n'a pas encore publié de plan." : "Pas de plan pour ce run."}
          {last && <div className="mt-1.5 truncate font-mono text-[12px]">{last.type === "tool" ? `${toolText(last.text).name} ${toolText(last.text).target}` : last.text.slice(0, 120)}</div>}
        </div>
      )}

      {steers.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-[13px] font-semibold">Consignes en file <span className="font-normal text-muted-foreground">· partent à la fin de l'étape en cours</span></h3>
          <ul className="grid gap-1.5">
            {steers.map((s) => (
              <li key={s.id} className="fade-up flex items-start gap-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-[13px]">
                <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-brand-fg" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{s.text}</span>
                <Button variant="ghost" size="icon-sm" title="Envoyer maintenant" aria-label="Envoyer maintenant" onClick={() => void runs.steerNow(run.id, s.id)}><Send /></Button>
                <Button variant="ghost" size="icon-sm" title="Retirer" aria-label="Retirer" onClick={() => runs.removeSteer(run.id, s.id)}><X /></Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {subs.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-[13px] font-semibold">Sous-agents</h3>
          <ul className="grid gap-1.5">
            {subs.map((s) => {
              const activity = s.status === "running" ? runs.subagentActivity(s.id) : null;
              return (
                <li key={s.id} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
                  <Bot size={18} mood={s.status === "running" ? "run" : s.status === "error" ? "err" : "idle"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{s.description || s.type}</div>
                    <div className={cn("truncate text-[12px]", s.status === "running" ? "shimmer-text" : "text-muted-foreground")}>
                      {s.type}{activity ? ` · ${toolText(activity).name} ${toolText(activity).target}` : ""}
                    </div>
                  </div>
                  <span className="font-mono text-[12px] text-muted-foreground">{mmss((s.endedAt ?? now) - s.startedAt)}</span>
                  {s.status === "done" ? <CircleCheck className="size-4 text-ok" /> : s.status === "error" ? <CircleX className="size-4 text-err" /> : <LoaderCircle className="spin size-4 text-brand" />}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {run.summary && DONE.concat(["in_review", "waiting_reply"]).includes(run.state) && (
        <section className="mt-5">
          <h3 className="mb-2 text-[13px] font-semibold">Dernier message de l'agent</h3>
          <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">{run.summary}</p>
        </section>
      )}
    </div>
  );
}

function Step({ item, last, now, live }: { item: PlanItem; last: boolean; now: number; live: boolean }) {
  const st = item.status;
  return (
    <li className="relative flex gap-3 pb-3.5">
      {!last && <span className={cn("absolute top-6 bottom-0 left-[11px] w-px", st === "completed" ? "bg-ok/50" : "bg-border")} aria-hidden />}
      <span className={cn(
        "relative z-[1] grid size-[23px] shrink-0 place-items-center rounded-full border",
        st === "completed" ? "border-ok bg-ok text-white" : st === "in_progress" ? "border-brand bg-card text-brand" : "border-border-strong bg-card",
      )}>
        {st === "completed" ? <Check className="size-3.5" strokeWidth={3} /> : st === "in_progress" ? <LoaderCircle className={cn("size-3.5", live && "spin")} /> : null}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className={cn("text-[13.5px] leading-snug", st === "completed" && "text-muted-foreground", st === "in_progress" && "font-medium")}>
          {st === "in_progress" && live ? <span className="shimmer-text">{item.activeForm ?? item.content}</span> : item.content}
        </div>
      </div>
      {item.startedAt && (
        <span className="pt-1 font-mono text-[11.5px] text-muted-foreground">
          {dur((item.endedAt ?? (st === "in_progress" ? now : item.startedAt)) - item.startedAt)}
        </span>
      )}
    </li>
  );
}

// ---------- Activité ----------

const FEED = new Set(["agent", "tool", "user", "permission", "git", "status", "error", "steer", "info", "warn", "rate_limit", "tool_error"]);

function Activity({ events }: { events: db.RunEvent[] }) {
  const feed = events.filter((e) => FEED.has(e.type)).slice(-300);
  const end = useStick([feed.length]);
  if (!feed.length) return <p className="px-5 py-6 text-[13px] text-muted-foreground">Pas encore d'activité.</p>;
  return (
    <div className="grid gap-1 px-5 py-4">
      {feed.map((e) => <FeedRow key={e.id} e={e} />)}
      <div ref={end} />
    </div>
  );
}

function FeedRow({ e }: { e: db.RunEvent }) {
  const time = new Date(e.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (e.type === "agent") {
    return (
      <div className="fade-up my-1.5 flex gap-2.5">
        <Bot size={20} brand className="mt-0.5" />
        <p className="min-w-0 flex-1 rounded-xl rounded-tl-sm bg-muted/70 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">{e.text}</p>
      </div>
    );
  }
  if (e.type === "user") {
    return (
      <div className="fade-up my-1.5 flex justify-end">
        <p className="max-w-[80%] rounded-xl rounded-tr-sm bg-brand px-3 py-2 text-[13px] whitespace-pre-wrap text-white">{e.text.slice(0, 1200)}</p>
      </div>
    );
  }
  if (e.type === "tool") {
    const t = toolText(e.text);
    return (
      <div className="fade-up flex h-7 items-center gap-2 rounded-md px-1.5 text-[12.5px] hover:bg-muted/50" title={e.text}>
        <span className="grid size-5 place-items-center rounded bg-muted text-muted-foreground"><ToolIcon name={t.name} className="size-3" /></span>
        <span className="font-medium">{t.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{t.target}</span>
        <span className="font-mono text-[11px] text-faint">{time}</span>
      </div>
    );
  }
  const tone = e.type === "error" || e.type === "tool_error" ? "text-err-fg" : e.type === "warn" || e.type === "permission" || e.type === "rate_limit" ? "text-warn-fg" : e.type === "git" ? "text-ok-fg" : "text-muted-foreground";
  return (
    <div className={cn("fade-up flex items-start gap-2 px-1.5 py-1 text-[12.5px]", tone)}>
      <span className="w-[74px] shrink-0 font-mono text-[11px] uppercase opacity-70">{e.type.replace("_", " ")}</span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{e.text.slice(0, 600)}</span>
      <span className="font-mono text-[11px] text-faint">{time}</span>
    </div>
  );
}

/** Garde la vue collée en bas quand de nouvelles lignes arrivent (si l'on y était déjà). */
function useStick(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.closest(".overflow-y-auto") as HTMLElement | null;
    if (!el || !box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (first.current || near) el.scrollIntoView({ block: "end" });
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

// ---------- Trace ----------

function Trace({ run, events }: { run: db.Run; events: db.RunEvent[] }) {
  const now = useNow();
  const steps = useMemo(() => {
    const rel = events.filter((e) => ["tool", "agent", "user", "permission", "git"].includes(e.type));
    return rel.map((e, i) => {
      const start = Date.parse(e.at);
      const next = rel[i + 1] ? Date.parse(rel[i + 1].at) : run.ended_at ? Date.parse(run.ended_at) : now;
      return { e, start, end: Math.max(start + 200, next) };
    }).slice(-80);
  }, [events, run.ended_at, now]);
  if (!steps.length) return <p className="px-5 py-6 text-[13px] text-muted-foreground">Pas encore de trace.</p>;
  const t0 = steps[0].start;
  const span = Math.max(1, steps[steps.length - 1].end - t0);
  const total = steps.reduce((m, s) => { const k = s.e.type === "tool" ? toolText(s.e.text).name : s.e.type; m.set(k, (m.get(k) ?? 0) + s.end - s.start); return m; }, new Map<string, number>());
  const top = [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex flex-wrap gap-2">
        {top.map(([k, ms]) => (
          <span key={k} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[12px]">
            <ToolIcon name={k} className="size-3 text-muted-foreground" />{k}<span className="font-mono text-muted-foreground">{dur(ms)}</span>
          </span>
        ))}
      </div>
      <div className="grid gap-[3px]">
        {steps.map(({ e, start, end }) => {
          const t = e.type === "tool" ? toolText(e.text) : { name: e.type === "agent" ? "Réflexion" : e.type, target: e.text.slice(0, 80) };
          const color = e.type === "tool" ? "var(--brand)" : e.type === "agent" ? "var(--rev)" : e.type === "permission" ? "var(--warn)" : e.type === "git" ? "var(--ok)" : "var(--faint)";
          return (
            <div key={e.id} className="grid grid-cols-[180px_minmax(0,1fr)_56px] items-center gap-3 text-[12px]" title={e.text.slice(0, 300)}>
              <span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 font-medium">{t.name}</span><span className="truncate font-mono text-[11px] text-muted-foreground">{basename(t.target)}</span></span>
              <span className="relative h-3.5 rounded-sm bg-muted/50">
                <span className="absolute top-0 bottom-0 rounded-sm" style={{ left: `${((start - t0) / span) * 100}%`, width: `max(3px, ${((end - start) / span) * 100}%)`, background: color, opacity: 0.85 }} />
              </span>
              <span className="text-right font-mono text-[11px] text-muted-foreground">{dur(end - start)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Diff ----------

function Diff({ run }: { run: db.Run }) {
  const [file, setFile] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const path = run.worktree_path;
  const base = run.base_commit;
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const stats = useAsync(async () => (path && base ? git.diffStat(path, base) : []), [path, base, tick], [] as git.FileStat[]);
  const text = useAsync(async () => (path && base && file ? git.diffFile(path, base, file) : ""), [path, base, file, tick], "");
  if (!path || !base) return <p className="px-5 py-6 text-[13px] text-muted-foreground">Pas de worktree pour ce run.</p>;
  if (stats.error) return <p className="px-5 py-6 text-[13px] text-muted-foreground">{DONE.includes(run.state) ? "Le worktree a été supprimé à la fin du run." : `Diff indisponible : ${stats.error}`}</p>;
  const add = stats.data.reduce((s, f) => s + f.add, 0);
  const del = stats.data.reduce((s, f) => s + f.del, 0);
  return (
    <div className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <b className="font-semibold text-foreground">{stats.data.length}</b> fichier{stats.data.length > 1 ? "s" : ""}
        <span className="font-mono text-ok-fg">+{add}</span><span className="font-mono text-err-fg">−{del}</span>
        <span className="flex-1" />
        <span>depuis <span className="font-mono">{base.slice(0, 7)}</span></span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {stats.data.map((f) => {
          const max = Math.max(1, f.add + f.del);
          return (
            <button key={f.path} type="button" onClick={() => setFile(file === f.path ? null : f.path)} className={cn("flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-[12.5px] last:border-b-0 hover:bg-muted/50", file === f.path && "bg-muted")}>
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              {f.untracked ? <span className="rounded bg-ok/12 px-1.5 text-[11px] text-ok-fg">nouveau</span> : (
                <>
                  <span className="font-mono text-[11.5px] text-ok-fg">+{f.add}</span>
                  <span className="font-mono text-[11.5px] text-err-fg">−{f.del}</span>
                  <span className="flex h-2 w-14 overflow-hidden rounded-full bg-muted">
                    <span className="bg-ok" style={{ width: `${(f.add / max) * 100}%` }} />
                    <span className="bg-err" style={{ width: `${(f.del / max) * 100}%` }} />
                  </span>
                </>
              )}
            </button>
          );
        })}
        {!stats.data.length && <p className="px-3 py-4 text-[13px] text-muted-foreground">{stats.loading ? "Calcul du diff…" : "Aucune modification pour l'instant."}</p>}
      </div>
      {file && (
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-code p-0 font-mono text-[11.5px] leading-[1.6]">
          {(text.data || "(fichier non suivi ou binaire)").split("\n").map((l, i) => (
            <div key={i} className={cn("px-3 whitespace-pre", l.startsWith("+") && !l.startsWith("+++") ? "bg-ok/12 text-ok-fg" : l.startsWith("-") && !l.startsWith("---") ? "bg-err/10 text-err-fg" : l.startsWith("@@") ? "bg-brand/8 text-brand-fg" : "text-muted-foreground")}>{l || " "}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ---------- Terminal ----------

function Term({ events }: { events: db.RunEvent[] }) {
  const lines = events.slice(-600);
  const end = useStick([lines.length]);
  return (
    <div className="m-4 rounded-xl bg-[#0b0b0d] p-3 font-mono text-[11.5px] leading-[1.65] text-zinc-300">
      {lines.map((e) => (
        <div key={e.id} className="flex gap-2 whitespace-pre-wrap">
          <span className="shrink-0 text-zinc-600">{new Date(e.at).toLocaleTimeString("fr-FR")}</span>
          <span className={cn("w-[70px] shrink-0", e.type === "error" || e.type === "tool_error" || e.type === "stderr" ? "text-red-400" : e.type === "tool" ? "text-sky-400" : e.type === "agent" ? "text-violet-300" : e.type === "git" ? "text-emerald-400" : e.type === "user" ? "text-amber-300" : "text-zinc-500")}>{e.type}</span>
          <span className="min-w-0 break-all">{e.text.slice(0, 2000)}</span>
        </div>
      ))}
      {!lines.length && <span className="text-zinc-500">$ en attente de sortie…</span>}
      <div ref={end} />
    </div>
  );
}

// ---------- consigne ----------

function Composer({ run }: { run: db.Run }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const live = runs.isLive(run.id) && run.state === "running";

  async function submit(now: boolean) {
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      if (live && !now) {
        await runs.queueSteer(run.id, t);
        toast("Consigne en file", "Elle part à la fin de l'étape en cours");
      } else {
        await runs.sendMessage(run.id, t);
        toast("Message envoyé à l'agent");
      }
    } catch (e) {
      setText(t);
      toast("Envoi impossible", (e as Error).message, "err");
    }
  }

  return (
    <div className="border-t border-border bg-card px-4 py-3">
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-1.5 focus-within:border-brand/60 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_14%,transparent)]">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(e.ctrlKey || e.metaKey);
            }
          }}
          rows={1}
          placeholder={live ? "Ajoute une consigne pour l'agent…" : "Écris à l'agent pour le relancer…"}
          className="max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          aria-label="Consigne pour l'agent"
        />
        <Button variant="brand" size="icon" onClick={() => void submit(false)} disabled={!text.trim()} aria-label={live ? "Mettre en file" : "Envoyer"}>
          <Send />
        </Button>
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] text-muted-foreground">
        {live ? (
          <>
            <span><Kbd>Entrée</Kbd> en file pour la fin de l'étape</span>
            <span><Kbd>Ctrl</Kbd>+<Kbd>Entrée</Kbd> envoyer maintenant</span>
          </>
        ) : (
          <span><Kbd>Entrée</Kbd> envoyer · relance la session</span>
        )}
        <span><Kbd>Maj</Kbd>+<Kbd>Entrée</Kbd> nouvelle ligne</span>
      </p>
    </div>
  );
}
