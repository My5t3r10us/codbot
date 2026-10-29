// Point d'entrée : navigation entre les vues, bandeau des suggestions de statut (mode manuel).
import * as db from "./db";
import { runChecks } from "./diag";
import { errorBox, h } from "./dom";
import * as queue from "./queue";
import * as runs from "./runs";
import { renderQueue } from "./views/queue";
import { renderRuns, selectRun } from "./views/runs";
import { renderSettings } from "./views/settings";
import { renderTasks } from "./views/tasks";

type View = "tasks" | "runs" | "queue" | "settings";
let current: View = "tasks";
const root = document.getElementById("view")!;

async function show(view: View) {
  current = view;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.classList.toggle("active", b.dataset.view === view);
  }
  try {
    if (view === "tasks") await renderTasks(root, goToRun);
    if (view === "runs") await renderRuns(root);
    if (view === "queue") await renderQueue(root, goToRun);
    if (view === "settings") await renderSettings(root);
  } catch (e) {
    root.replaceChildren(errorBox(e));
  }
}

function goToRun(id: string) {
  selectRun(id);
  void show("runs");
}

function renderSuggestions() {
  const box = document.getElementById("suggestions")!;
  box.replaceChildren(...[...runs.suggestions.values()].map((s) =>
    h("div", { class: "row" },
      h("span", {}, `« ${s.taskName} » : ${s.status ? `passer en ${s.status}` : ""}${s.status && s.comment ? " et " : ""}${s.comment ? "ajouter le commentaire du run" : ""} ?`),
      h("button", { onclick: () => runs.acceptSuggestion(s.id) }, "Oui"),
      h("button", { class: "ghost", onclick: () => runs.dismissSuggestion(s.id) }, "Ignorer"))));
}

async function renderActiveCount() {
  const n = (await db.listRuns()).filter((r) => runs.ACTIVE_STATES.includes(r.state)).length;
  document.getElementById("active-count")!.textContent = n ? String(n) : "";
}

// Les changements de runs rafraîchissent la vue Runs (regroupés pour éviter de redessiner à chaque ligne).
let pending = false;
runs.onChange(() => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    renderSuggestions();
    void renderActiveCount();
    // On ne redessine pas pendant une saisie, pour ne pas perdre le texte en cours.
    const typing = document.activeElement?.tagName === "TEXTAREA" || document.activeElement?.tagName === "INPUT";
    if ((current === "runs" || current === "queue") && !typing) void show(current);
  }, 300);
});
queue.onQueueChange(() => {
  void renderQueueCount();
  if (current === "queue") void show("queue");
});

async function renderQueueCount() {
  const st = await queue.status();
  const n = (await db.listQueue()).length;
  document.getElementById("queue-count")!.textContent = n ? String(n) : st.running ? "▶" : "";
}

for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.onclick = () => show(b.dataset.view as View);
}

await runs.init();
await queue.init();
await renderActiveCount();
await renderQueueCount();
await show((await db.listProjects()).some((p) => p.repo_path) ? "tasks" : "settings");

// Diagnostic au démarrage : un problème (CLI déconnecté, jeton invalide…) se signale sur l'onglet Réglages.
void runChecks().then((checks) => {
  const bad = checks.filter((c) => !c.ok);
  const btn = document.querySelector<HTMLButtonElement>('nav button[data-view="settings"]')!;
  if (bad.length) {
    btn.textContent = "Réglages ⚠";
    btn.title = bad.map((c) => `${c.name} : ${c.detail}`).join("\n");
  }
});
