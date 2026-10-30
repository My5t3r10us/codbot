import { Play, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import * as cu from "../../clickup";
import * as db from "../../db";
import * as mp from "../../modelpick";
import * as queue from "../../queue";
import * as runs from "../../runs";
import type { StrategyChoice } from "../../rules";
import { useNav } from "../../app/nav";
import { useSetting } from "../../app/store";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader } from "../../ui/dialog";
import { Textarea } from "../../ui/input";
import { Segmented } from "../../ui/segmented";
import { useToast } from "../../ui/toast";

/** Fenêtre « Confier à un agent » : mode, stratégie git (règle Codbot), statuts, brief. */
export function LaunchDialog({ tasks, project, onClose, onDone }: { tasks: cu.CuTask[]; project: db.Project; onClose(): void; onDone(): void }) {
  const toast = useToast();
  const nav = useNav();
  const [globalMode] = useSetting<db.StatusMode>("status_mode", "auto");
  const [mode, setMode] = useState<db.RunMode>(tasks.length > 1 ? "groupe" : "separe");
  const [strategy, setStrategy] = useState<db.GitStrategy | null>(null);
  const [statusMode, setStatusMode] = useState<db.StatusMode | null>(null);
  const [rule, setRule] = useState<StrategyChoice | null>(null);
  const [brief, setBrief] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<mp.ModelPolicy | null>(null);
  const [suggested, setSuggested] = useState<mp.Pick | null>(null);
  const [model, setModel] = useState<mp.Choice | null>(null);
  const single = mode === "groupe" || tasks.length === 1;
  const effective = rule?.forced ?? strategy ?? rule?.suggested ?? "branche";

  useEffect(() => {
    let alive = true;
    void runs.strategyFor(tasks, project, mode).then((r) => alive && setRule(r));
    return () => void (alive = false);
  }, [tasks, project, mode]);

  useEffect(() => {
    let alive = true;
    void runs.modelPolicy().then((p) => alive && setPolicy(p));
    // Aperçu par les règles locales : le triage IA éventuel n'a lieu qu'au lancement.
    void runs.chooseModel(single ? tasks : tasks.slice(0, 1), { ai: false }).then((p) => alive && setSuggested(p));
    return () => void (alive = false);
  }, [tasks, single]);

  useEffect(() => {
    if (!single || edited) return;
    let alive = true;
    void Promise.all(tasks.map((t) => cu.getTask(t.id))).then((full) => {
      if (!alive) return;
      setBrief(runs.buildBrief(full, { worktree: runs.BRIEF_WORKTREE, base: project.base_branch, branch: effective === "branche" ? runs.BRIEF_BRANCH : null }));
    }).catch(() => {});
    return () => void (alive = false);
  }, [tasks, project, single, effective, edited]);

  const opts = (): runs.LaunchOptions => ({ mode, strategy: effective, statusMode: statusMode ?? globalMode, brief: single && edited ? brief : undefined, model: model ?? undefined });

  async function launchNow() {
    setBusy(true);
    try {
      const ids = await runs.launch(tasks, project, opts());
      toast(ids.length > 1 ? `${ids.length} agents lancés` : "Agent lancé", tasks.map((t) => t.name).join(", "));
      onDone();
      nav.openRun(ids[0]);
    } catch (e) {
      toast("Lancement impossible", (e as Error).message, "err");
      setBusy(false);
    }
  }

  async function addToQueue() {
    setBusy(true);
    try {
      await queue.add(tasks, project, opts());
      toast(tasks.length > 1 ? `${tasks.length} tâches ajoutées à la file` : "Ajoutée à la file", "Elle démarre dès qu'un agent se libère");
      onDone();
    } catch (e) {
      toast("Ajout impossible", (e as Error).message, "err");
      setBusy(false);
    }
  }

  const row = "grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 border-t border-border px-5 py-3.5 first:border-t-0";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-32px))]">
        <DialogHeader title="Confier à un agent" description={tasks.length > 1 ? `${tasks.length} tâches de ${project.list_name}` : tasks[0]?.name} />
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex flex-wrap gap-1.5 px-5 pt-4">
            {tasks.map((t) => (
              <span key={t.id} className="inline-flex h-7 max-w-full items-center gap-2 rounded-md border border-border bg-muted/50 px-2 text-[12.5px]">
                <span className="font-mono text-muted-foreground">CU-{t.id}</span>
                <span className="truncate">{t.name}</span>
              </span>
            ))}
          </div>
          <div className="mt-3">
            {tasks.length > 1 && (
              <div className={row}>
                <span className="pt-1.5 text-[13.5px] font-medium">Mode</span>
                <div>
                  <Segmented<db.RunMode>
                    className="w-full" value={mode} onChange={setMode} label="Mode"
                    options={[{ value: "groupe", label: "Groupé · un agent" }, { value: "separe", label: `Séparé · ${tasks.length} agents` }]}
                  />
                  <p className="mt-2 text-[12.5px] text-muted-foreground">{mode === "groupe" ? "Un agent, un worktree, un commit par tâche." : "Un agent et une branche par tâche, en parallèle."}</p>
                </div>
              </div>
            )}
            <div className={row}>
              <span className="pt-1.5 text-[13.5px] font-medium">Git</span>
              <div>
                <Segmented<db.GitStrategy>
                  className="w-full" value={effective} onChange={setStrategy} label="Stratégie git"
                  options={[
                    { value: "branche", label: "Branche + PR" },
                    { value: "direct-main", label: `Commit direct sur ${project.base_branch}`, disabled: Boolean(rule?.forced) },
                  ]}
                />
                <p className="mt-2 text-[12.5px] text-muted-foreground">{rule?.reason ?? "…"}</p>
              </div>
            </div>
            <div className={row}>
              <span className="pt-1.5 text-[13.5px] font-medium">Statuts ClickUp</span>
              <Segmented<db.StatusMode>
                className="w-full" value={statusMode ?? globalMode} onChange={setStatusMode} label="Statuts"
                options={[{ value: "auto", label: "Automatiques" }, { value: "manual", label: "Je valide chaque changement" }]}
              />
            </div>
            {policy && policy.mode !== "default" && (
              <div className={row}>
                <span className="pt-1.5 text-[13.5px] font-medium">Modèle</span>
                <div>
                  <select
                    className="h-[34px] w-full rounded-md border border-border bg-card px-2 text-[13.5px] shadow-xs outline-none focus:border-border-strong"
                    value={model ? `${model.model}:${model.effort}` : "auto"} aria-label="Modèle et effort"
                    onChange={(e) => {
                      const [m, eff] = e.target.value.split(":");
                      setModel(e.target.value === "auto" ? null : { model: m as mp.ModelId, effort: eff as mp.Effort });
                    }}
                  >
                    <option value="auto">{policy.mode === "fixed" ? "Réglage fixe" : "Automatique"}{suggested && single ? ` · ${mp.choiceLabel(suggested)}` : ""}</option>
                    {mp.MODELS.flatMap((m) => policy.allowed[m.id].map((eff) => (
                      <option key={`${m.id}:${eff}`} value={`${m.id}:${eff}`}>{mp.choiceLabel({ model: m.id, effort: eff })}</option>
                    )))}
                  </select>
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    {model ? "Choisi à la main pour ce lancement." : !single ? "Choisi pour chaque tâche au lancement." : policy.triage === "ai" && policy.mode === "auto" ? `Aperçu par les règles ; Haiku affinera au lancement. ${suggested?.reason ?? ""}` : suggested?.reason ?? "…"}
                  </p>
                </div>
              </div>
            )}
            <div className={row}>
              <span className="pt-1.5 text-[13.5px] font-medium">Brief</span>
              {single ? (
                <Textarea
                  className="min-h-48 font-mono text-[12px] leading-relaxed"
                  value={brief}
                  onChange={(e) => { setBrief(e.target.value); setEdited(true); }}
                  aria-label="Brief envoyé à l'agent"
                />
              ) : (
                <p className="pt-1.5 text-[13px] text-muted-foreground">En mode séparé, chaque agent reçoit le brief de sa tâche.</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-5 py-3">
          <span className="text-[12.5px] text-muted-foreground">{edited ? "Brief modifié à la main" : "Brief généré depuis ClickUp"}</span>
          <span className="flex-1" />
          <Button variant="outline" disabled={busy} onClick={() => void addToQueue()}><Plus />Ajouter à la file</Button>
          <Button variant="brand" disabled={busy} onClick={() => void launchNow()}><Play />Lancer maintenant</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
