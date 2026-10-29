// Vue des tâches : tâches des listes associées à un repo, avec lancement d'un agent.
import { openUrl } from "@tauri-apps/plugin-opener";
import * as cu from "../clickup";
import * as db from "../db";
import { errorBox, h } from "../dom";
import { ACTIVE_STATES, launchRun } from "../runs";

const filters = { listId: "", search: "", mine: false, closed: false };
let me: cu.CuUser | null = null;

export async function renderTasks(root: HTMLElement, goToRun: (id: string) => void) {
  const projects = await db.listProjects();
  if (!projects.length) {
    root.replaceChildren(h("section", { class: "card" },
      h("p", {}, "Aucun projet configuré. Va dans Réglages pour associer une liste ClickUp à un repo.")));
    return;
  }
  if (!projects.some((p) => p.list_id === filters.listId)) filters.listId = projects[0].list_id;
  const project = projects.find((p) => p.list_id === filters.listId)!;

  const body = h("div", {}, h("p", { class: "muted" }, "Chargement des tâches…"));
  const rerender = () => renderTasks(root, goToRun);
  const toolbar = h("div", { class: "row" },
    h("select", { onchange: (e: Event) => { filters.listId = (e.target as HTMLSelectElement).value; void rerender(); } },
      ...projects.map((p) => h("option", { value: p.list_id, selected: p.list_id === filters.listId }, p.list_name))),
    h("input", {
      placeholder: "Rechercher…",
      value: filters.search,
      oninput: (e: Event) => { filters.search = (e.target as HTMLInputElement).value; void fill(); },
    }),
    h("label", { class: "inline" },
      h("input", { type: "checkbox", checked: filters.mine, onchange: (e: Event) => { filters.mine = (e.target as HTMLInputElement).checked; void fill(); } }),
      "Assignées à moi"),
    h("label", { class: "inline" },
      h("input", { type: "checkbox", checked: filters.closed, onchange: (e: Event) => { filters.closed = (e.target as HTMLInputElement).checked; tasks = null; void fill(); } }),
      "Inclure les terminées"),
    h("button", { class: "ghost", onclick: () => { tasks = null; void fill(); } }, "Rafraîchir"),
  );
  root.replaceChildren(h("section", { class: "card" },
    h("div", { class: "row spread" }, h("h2", {}, project.list_name), h("span", { class: "muted small" }, project.repo_path)),
    toolbar, body));

  let tasks: cu.CuTask[] | null = null;
  async function fill() {
    try {
      me ??= await cu.getUser();
      tasks ??= await cu.getListTasks(project.list_id, filters.closed);
      const runs = (await db.listRuns()).filter((r) => ACTIVE_STATES.includes(r.state) || r.state === "blocked");
      body.replaceChildren(table(tasks, runs));
    } catch (e) {
      body.replaceChildren(errorBox(e));
    }
  }

  function table(all: cu.CuTask[], runs: db.Run[]) {
    const q = filters.search.toLowerCase();
    const visible = all.filter((t) =>
      (!q || t.name.toLowerCase().includes(q) || t.id.includes(q)) &&
      (!filters.mine || t.assignees.some((a) => a.id === me?.id)));
    const ids = new Set(visible.map((t) => t.id));
    // Les sous-tâches s'affichent sous leur parente quand celle-ci est visible.
    const roots = visible.filter((t) => !t.parent || !ids.has(t.parent));
    const children = (id: string) => visible.filter((t) => t.parent === id);

    const tbl = h("table", {}, h("tr", {}, h("th", {}, "Tâche"), h("th", {}, "Statut"), h("th", {}, "Assignés"), h("th", {}, "Agent")));
    const row = (t: cu.CuTask, sub: boolean) => {
      const run = runs.find((r) => r.task_ids.includes(t.id));
      const action = run
        ? h("a", { onclick: () => goToRun(run.id) }, `run ${run.state}`)
        : h("button", {
            onclick: async (e: Event) => {
              const btn = e.target as HTMLButtonElement;
              btn.disabled = true;
              btn.textContent = "Lancement…";
              try {
                goToRun(await launchRun(t, project));
              } catch (err) {
                btn.replaceWith(errorBox(err));
              }
            },
          }, "Lancer un agent");
      tbl.append(h("tr", { class: sub ? "sub" : "" },
        h("td", {}, h("a", { onclick: () => openUrl(t.url) }, t.name), h("span", { class: "muted small" }, `  CU-${t.id}`)),
        h("td", {}, h("span", { class: "pill", style: `background:${t.status.color}` }, t.status.status)),
        h("td", { class: "small" }, t.assignees.map((a) => a.username).join(", ")),
        h("td", {}, action)));
    };
    for (const t of roots) {
      row(t, false);
      for (const c of children(t.id)) row(c, true);
    }
    if (!roots.length) tbl.append(h("tr", {}, h("td", { colSpan: 4, class: "muted" }, "Aucune tâche.")));
    return tbl;
  }

  await fill();
}
