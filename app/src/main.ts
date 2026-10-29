// Point d'entrée : navigation entre les vues, bandeau des suggestions de statut (mode manuel).
import * as db from "./db";
import { errorBox, h } from "./dom";
import * as runs from "./runs";
import { renderRuns, selectRun } from "./views/runs";
import { renderSettings } from "./views/settings";
import { renderTasks } from "./views/tasks";

type View = "tasks" | "runs" | "settings";
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
    if (current === "runs" && !typing) void show("runs");
  }, 300);
});

for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.onclick = () => show(b.dataset.view as View);
}

await runs.init();
await renderActiveCount();
await show((await db.listProjects()).length ? "tasks" : "settings");
