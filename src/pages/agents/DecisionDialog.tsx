// Arbre de décision : quand un agent attend (permission, question, blocage), les choix possibles
// en branches, avec leurs conséquences. Touches 1…n pour choisir.
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import type * as db from "../../db";
import { allowPatternFor } from "../../live";
import * as runs from "../../runs";
import { useRuns, useRunsVersion } from "../../app/store";
import { NEEDS_YOU } from "../../labels";
import { Bot } from "../../ui/bot";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { CloseButton, Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import { Kbd, Textarea } from "../../ui/input";
import { useToast } from "../../ui/toast";
import { StateBadge, ToolIcon } from "./runbits";

type Choice = {
  key: string;
  label: string;
  detail: string;
  tone: "ok" | "brand" | "warn" | "err" | "muted";
  /** Choix qui demande un texte (réponse, autre consigne). */
  input?: string;
  run(text?: string): Promise<unknown>;
};

/** Runs qui attendent l'utilisateur, la permission la plus ancienne d'abord. */
export function useWaiting() {
  useRunsVersion();
  const all = useRuns().data;
  return useMemo(() => {
    const perms = [...runs.permissions.values()];
    return all.filter((r) => perms.some((p) => p.runId === r.id) || NEEDS_YOU.includes(r.state) || r.state === "paused");
  }, [all]);
}

export function DecisionDialog({ runId, onClose, onOpenRun }: { runId: string | undefined | null; onClose(): void; onOpenRun(id: string): void }) {
  const waiting = useWaiting();
  const open = runId !== undefined;
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => { if (open) setCurrent(runId ?? null); }, [open, runId]);
  const run = waiting.find((r) => r.id === current) ?? waiting[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(860px,calc(100vw-32px))]" aria-describedby={undefined}>
        <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <DialogTitle className="text-[15px] font-semibold">À toi de décider</DialogTitle>
          <span className="rounded-md bg-warn/15 px-1.5 font-mono text-[12px] text-warn-fg">{waiting.length}</span>
          <span className="flex-1" />
          <CloseButton />
        </div>
        <div className="flex min-h-0 flex-1">
          {waiting.length > 1 && (
            <nav className="w-[220px] shrink-0 overflow-y-auto border-r border-border p-2">
              {waiting.map((r) => (
                <button
                  key={r.id} type="button" onClick={() => setCurrent(r.id)}
                  className={cn("mb-0.5 flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted", r.id === run?.id && "bg-muted")}
                >
                  <Bot size={16} mood={r.state === "blocked" ? "err" : "wait"} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{r.task_names.join(", ")}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">{reasonOf(r)}</span>
                  </span>
                </button>
              ))}
            </nav>
          )}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {run ? <Tree key={run.id} run={run} onOpenRun={(id) => { onClose(); onOpenRun(id); }} /> : (
              <div className="grid place-items-center px-6 py-16 text-center">
                <Bot size={34} brand />
                <p className="mt-3 text-[14px] font-medium">Rien ne t'attend</p>
                <DialogDescription className="mt-1 text-[13px] text-muted-foreground">Tous les agents avancent seuls.</DialogDescription>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function reasonOf(r: db.Run) {
  const p = [...runs.permissions.values()].find((x) => x.runId === r.id);
  if (p) return `Permission · ${p.tool}`;
  if (r.state === "waiting_reply") return "Question de l'agent";
  if (r.state === "blocked") return "Bloqué";
  if (r.state === "paused") return "En pause (limite d'usage)";
  return "Arrêté";
}

function Tree({ run, onOpenRun }: { run: db.Run; onOpenRun(id: string): void }) {
  const toast = useToast();
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const perm = [...runs.permissions.values()].filter((p) => p.runId === run.id).sort((a, b) => a.at - b.at)[0];

  const choices: Choice[] = useMemo(() => {
    const abandon: Choice = {
      key: "abandon", label: "Abandonner", tone: "err", detail: "Supprime le worktree, remet les statuts ClickUp d'avant.",
      run: async () => {
        const yes = await ask("Abandonner ce run ?", { title: "Codbot", kind: "warning" });
        if (yes) await runs.abandonRun(run.id);
      },
    };
    const terminal: Choice = { key: "term", label: "Reprendre la main dans un terminal", tone: "muted", detail: "Ouvre `claude --resume` dans le worktree.", run: () => runs.openInTerminal(run.id) };
    if (perm) {
      const pattern = allowPatternFor(perm.tool, perm.input);
      return [
        { key: "once", label: "Autoriser une fois", tone: "ok", detail: "L'agent continue, il redemandera la prochaine fois.", run: () => runs.decide(perm.id, true) },
        { key: "always", label: `Toujours autoriser ${pattern}`, tone: "brand", detail: "Retenu pour ce projet : plus de question pour ce motif.", run: () => runs.decideAndRemember(perm.id) },
        { key: "deny", label: "Refuser", tone: "warn", detail: "L'agent cherche une autre façon de faire.", run: () => runs.decide(perm.id, false) },
        { key: "pause", label: "Refuser et mettre en pause", tone: "muted", detail: "Arrête l'agent ; tu pourras le reprendre plus tard.", run: async () => { await runs.decide(perm.id, false); await runs.stopRun(run.id); } },
        { key: "other", label: "Refuser avec une consigne", tone: "brand", detail: "Dis-lui quoi faire à la place.", input: "Fais plutôt…", run: async (t) => { await runs.decide(perm.id, false); if (t) await runs.sendMessage(run.id, t); } },
      ];
    }
    if (run.state === "waiting_reply") {
      return [
        { key: "answer", label: "Répondre", tone: "brand", detail: "Ta réponse relance l'agent.", input: "Ta réponse…", run: (t) => runs.sendMessage(run.id, t ?? "") },
        { key: "resume", label: "Continuer sans répondre", tone: "ok", detail: "Il reprend là où il s'était arrêté, selon les consignes de départ.", run: () => runs.resumeRun(run.id) },
        terminal, abandon,
      ];
    }
    if (run.state === "blocked") {
      return [
        { key: "resume", label: "Relancer l'agent", tone: "ok", detail: "Il reprend avec l'erreur en contexte.", run: () => runs.resumeRun(run.id) },
        { key: "fix", label: "Lui dire comment corriger", tone: "brand", detail: "Ta consigne relance la session.", input: "Corrige…", run: (t) => runs.sendMessage(run.id, t ?? "") },
        { key: "deliver", label: "Relivrer les commits", tone: "muted", detail: "Après une correction à la main : revérifie et pousse.", run: () => runs.retryDeliver(run.id) },
        terminal, abandon,
      ];
    }
    return [
      { key: "resume", label: run.state === "paused" ? "Reprendre maintenant" : "Reprendre", tone: "ok", detail: "La session reprend là où elle s'était arrêtée.", run: () => runs.resumeRun(run.id) },
      { key: "say", label: "Reprendre avec une consigne", tone: "brand", detail: "Ta consigne relance la session.", input: "Consigne…", run: (t) => runs.sendMessage(run.id, t ?? "") },
      terminal, abandon,
    ];
  }, [perm, run]);

  async function pick(c: Choice) {
    if (c.input && chosen !== c.key) { setChosen(c.key); return; }
    if (c.input && !text.trim()) return;
    setBusy(true);
    try {
      await c.run(c.input ? text.trim() : undefined);
      toast(c.label, run.task_names.join(", "));
      setChosen(null);
      setText("");
    } catch (e) {
      toast("Action impossible", (e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= choices.length) { e.preventDefault(); void pick(choices[n - 1]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const question = perm ? null : run.state === "blocked" ? run.error : run.state === "waiting_reply" ? run.summary : run.state === "paused" ? "L'agent a atteint la limite d'usage." : "L'agent a été arrêté.";
  const toneCls = { ok: "border-ok/40 hover:bg-ok/6", brand: "border-brand/40 hover:bg-brand/5", warn: "border-warn/40 hover:bg-warn/6", err: "border-err/30 hover:bg-err/5", muted: "border-border hover:bg-muted/60" };
  const dotCls = { ok: "bg-ok", brand: "bg-brand", warn: "bg-warn", err: "bg-err", muted: "bg-faint" };

  return (
    <div className="p-5">
      {/* racine : l'agent */}
      <div className="flex items-center gap-3">
        <Bot size={30} mood={run.state === "blocked" ? "err" : "wait"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{run.task_names.join(" · ")}</div>
          <div className="mt-0.5 flex items-center gap-2"><StateBadge state={run.state} /></div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onOpenRun(run.id)}>Voir la session</Button>
      </div>

      {/* nœud : la question */}
      <div className="relative mt-3 ml-[14px] border-l-2 border-line-tree pt-3 pl-6">
        <span className="absolute top-[30px] left-0 h-0.5 w-5 bg-line-tree" aria-hidden />
        <div className="rounded-xl border border-warn/40 bg-warn/6 p-3.5">
          {perm ? (
            <>
              <div className="flex items-center gap-2 text-[13.5px] font-medium">
                <span className="grid size-6 place-items-center rounded-md bg-card"><ToolIcon name={perm.tool} /></span>
                Veut utiliser <span className="font-mono">{perm.tool}</span>
              </div>
              <ToolInput tool={perm.tool} input={perm.input} />
            </>
          ) : (
            <p className="max-h-56 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap">{question || "—"}</p>
          )}
        </div>

        {/* branches : les choix */}
        <ol className="relative mt-3 ml-5 border-l-2 border-line-tree pb-1">
          {choices.map((c, i) => (
            <li key={c.key} className="relative pt-2.5 pl-6">
              <span className="absolute top-[30px] left-0 h-0.5 w-5 bg-line-tree" aria-hidden />
              {i === choices.length - 1 && <span className="absolute top-[31px] -bottom-1 -left-0.5 w-1 bg-card" aria-hidden />}
              <button
                type="button" disabled={busy} onClick={() => void pick(c)}
                className={cn("flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-card px-3.5 py-2.5 text-left transition-colors disabled:opacity-50", toneCls[c.tone], chosen === c.key && "ring-2 ring-brand/30")}
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dotCls[c.tone])} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{c.label}</span>
                  <span className="block text-[12.5px] text-muted-foreground">{c.detail}</span>
                </span>
                <Kbd>{i + 1}</Kbd>
              </button>
              {chosen === c.key && c.input && (
                <div className="pop-in mt-2 flex items-end gap-2">
                  <Textarea
                    autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={c.input} className="min-h-20 flex-1"
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void pick(c); }}
                  />
                  <Button variant="brand" disabled={busy || !text.trim()} onClick={() => void pick(c)}>Envoyer</Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  if (tool === "Bash" && s("command")) {
    return (
      <>
        {s("description") && <p className="mt-2 text-[12.5px] text-muted-foreground">{s("description")}</p>}
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#0b0b0d] px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-zinc-200">$ {s("command")}</pre>
      </>
    );
  }
  const file = s("file_path") ?? s("notebook_path");
  const body = s("new_string") ?? s("content");
  return (
    <>
      {file && <p className="mt-2 font-mono text-[12.5px]">{file}</p>}
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-card px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
        {body ? body.slice(0, 1500) : JSON.stringify(input, null, 2).slice(0, 1500)}
      </pre>
    </>
  );
}
