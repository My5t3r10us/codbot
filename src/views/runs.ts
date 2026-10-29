// Vue des runs : liste, détail (journal, permissions, message à l'agent, actions).
import { openUrl } from "@tauri-apps/plugin-opener";
import * as db from "../db";
import { errorBox, fmtDate, h } from "../dom";
import * as runs from "../runs";

export const STATE_LABEL: Record<db.RunState, string> = {
  preparing: "préparation",
  running: "en cours",
  waiting_permission: "attend une permission",
  waiting_reply: "attend une réponse",
  pushing: "push en cours",
  in_review: "en revue",
  paused: "en pause",
  done: "terminé",
  blocked: "bloqué",
  failed: "échec",
  stopped: "arrêté",
};

const PROGRESS_LABEL: Partial<Record<db.StatusEvent, string>> = {
  started: "en cours",
  review: "en revue",
  done: "terminée",
};

export let selectedRun: string | null = null;
export function selectRun(id: string | null) {
  selectedRun = id;
}

export async function renderRuns(root: HTMLElement) {
  const all = await db.listRuns();
  if (!all.length) {
    root.replaceChildren(h("section", { class: "card" }, h("p", { class: "muted" }, "Aucun run pour l'instant. Lance un agent depuis l'onglet Tâches.")));
    return;
  }
  if (!selectedRun || !all.some((r) => r.id === selectedRun)) selectedRun = all[0].id;
  const list = h("section", { class: "card" }, h("h2", {}, "Runs"),
    ...all.map((r) => h("div", {
      class: `run-item${r.id === selectedRun ? " selected" : ""}`,
      onclick: () => { selectedRun = r.id; void renderRuns(root); },
    },
      h("div", {}, r.task_names.join(", ")),
      h("div", { class: "row small muted" }, h("span", { class: `state ${r.state}` }, STATE_LABEL[r.state]), fmtDate(r.created_at)))));
  const detail = await runDetail(all.find((r) => r.id === selectedRun)!, () => renderRuns(root));
  root.replaceChildren(h("div", { class: "runs" }, list, detail));
}

async function runDetail(run: db.Run, rerender: () => void) {
  const act = (label: string, fn: () => Promise<unknown>, cls = "ghost") =>
    h("button", {
      class: cls,
      onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        try {
          await fn();
        } catch (err) {
          (e.target as HTMLElement).after(errorBox(err));
        }
        rerender();
      },
    }, label);

  const live = runs.isLive(run.id);
  const active = runs.ACTIVE_STATES.includes(run.state);
  const actions = h("div", { class: "row" },
    live ? act("Arrêter", () => runs.stopRun(run.id)) : null,
    !live && run.session_id && run.state !== "done" && run.state !== "failed" ? act("Reprendre", () => runs.resumeRun(run.id)) : null,
    run.state === "blocked" ? act("Retenter vérification et push", () => runs.retryDeliver(run.id)) : null,
    run.state === "in_review" ? act("Vérifier le merge maintenant", () => runs.checkReview(run.id)) : null,
    run.state !== "done" && run.state !== "failed" ? act("Abandonner", () => runs.abandonRun(run.id), "danger") : null,
  );

  const pending = [...runs.permissions.values()].filter((p) => p.runId === run.id);
  const perms = pending.length
    ? h("div", { class: "card" }, h("h3", {}, "Permissions en attente"),
        ...pending.map((p) => h("div", {},
          h("b", {}, p.tool),
          h("pre", {}, JSON.stringify(p.input, null, 2)),
          h("div", { class: "row" },
            act("Autoriser", () => runs.decide(p.id, true), ""),
            act("Refuser", () => runs.decide(p.id, false), "danger")))))
    : null;

  const msg = h("textarea", {
    rows: 2,
    placeholder: run.state === "in_review" ? "Demander une correction à l'agent (la PR sera mise à jour)…" : "Répondre ou donner une consigne à l'agent…",
  }) as HTMLTextAreaElement;
  const canMessage = live || (run.session_id && run.state !== "done" && run.state !== "failed");
  const composer = canMessage
    ? h("div", { class: "row" }, msg, act("Envoyer", async () => { if (msg.value.trim()) await runs.sendMessage(run.id, msg.value.trim()); }, ""))
    : null;

  const events = await db.listRunEvents(run.id);
  const log = h("div", { class: "log" },
    ...events.map((e) => h("div", { class: `t-${e.type}` }, `${new Date(e.at).toLocaleTimeString("fr-FR")}  [${e.type}] ${e.text}`)));
  queueMicrotask(() => (log.scrollTop = log.scrollHeight));

  return h("section", { class: "card" },
    h("div", { class: "row spread" },
      h("h2", {}, run.task_names.join(", ")),
      h("span", { class: `state ${run.state}` }, STATE_LABEL[run.state])),
    h("p", { class: "muted small" },
      run.git_strategy === "branche" ? `branche ${run.branch} → ${run.base_branch}` : `commit direct sur ${run.base_branch}`,
      run.task_ids.length > 1 ? ` · mode ${run.mode === "groupe" ? "groupé" : "séparé"}` : "",
      run.status_mode ? ` · statuts ${run.status_mode === "auto" ? "automatiques" : "manuels"}` : "",
      ` · ${run.repo_path}`,
      run.worktree_path && (active || run.state === "in_review") ? ` · worktree ${run.worktree_path}` : "",
      run.pushed_commit ? ` · poussé ${run.pushed_commit.slice(0, 7)}` : ""),
    run.pr_url ? h("p", {}, "PR : ", h("a", { onclick: () => openUrl(run.pr_url!) }, run.pr_url)) : null,
    run.task_ids.length > 1
      ? h("ul", { class: "small" }, ...run.task_ids.map((id, i) =>
          h("li", {}, `${run.task_names[i]} (CU-${id}) : `, h("b", {}, PROGRESS_LABEL[run.task_progress[id]] ?? "en attente"))))
      : null,
    run.error ? h("pre", { class: "err" }, run.error) : null,
    actions, perms, composer,
    h("h3", {}, "Journal"), log);
}
