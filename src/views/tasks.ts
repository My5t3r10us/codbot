// Vue des tâches : listes associées à un repo (ou parcourues dans l'espace de travail),
// filtres, sélection multiple et lancement d'agents. Rafraîchie toutes les 60 s.
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as cu from "../clickup";
import * as db from "../db";
import { errorBox, h } from "../dom";
import * as lock from "../lock";
import * as queue from "../queue";
import { matchesDue } from "../rules";
import type { DueFilter } from "../rules";
import * as runs from "../runs";

const REFRESH_MS = 60_000;
const filters = {
  listId: "",
  /** Nom d'une liste parcourue qui n'est associée à aucun repo. */
  browsedName: "",
  search: "",
  mine: false,
  closed: false,
  withSubtasks: true,
  due: "all" as DueFilter,
};
let refreshTimer: number | undefined;
const selected = new Set<string>();
let me: cu.CuUser | null = null;
let myTag = "";

export async function renderTasks(root: HTMLElement, goToRun: (id: string) => void) {
  // Un projet importé d'un autre PC n'est utilisable qu'une fois son repo local renseigné.
  const projects = (await db.listProjects()).filter((p) => p.repo_path);
  const rerender = () => renderTasks(root, goToRun);
  if (!projects.some((p) => p.list_id === filters.listId) && !filters.browsedName) filters.listId = projects[0]?.list_id ?? "";
  const browse = browsePanel((id, name) => {
    filters.listId = id;
    filters.browsedName = projects.some((p) => p.list_id === id) ? "" : name;
    selected.clear();
    void rerender();
  });
  if (!filters.listId) {
    root.replaceChildren(h("section", { class: "card" },
      h("p", {}, "Aucun projet configuré : associe une liste ClickUp à un repo dans les Réglages, ou parcours ton espace de travail."),
      browse));
    return;
  }
  /** Liste affichée sans repo associé : on peut la consulter, pas y lancer d'agent. */
  const project = projects.find((p) => p.list_id === filters.listId) ?? null;
  const listName = project?.list_name ?? filters.browsedName;

  const body = h("div", {}, h("p", { class: "muted" }, "Chargement des tâches…"));
  const bar = h("div", { class: "row" });
  const dialog = h("div");
  const toolbar = h("div", { class: "row" },
    h("select", {
      onchange: (e: Event) => {
        filters.listId = (e.target as HTMLSelectElement).value;
        filters.browsedName = "";
        selected.clear();
        void rerender();
      },
    },
      ...projects.map((p) => h("option", { value: p.list_id, selected: p.list_id === filters.listId }, p.list_name)),
      project ? "" : h("option", { value: filters.listId, selected: true }, `${listName} (sans repo)`)),
    h("button", { class: "ghost", onclick: () => browse.toggleAttribute("hidden") }, "Parcourir…"),
    h("select", {
      onchange: (e: Event) => { filters.due = (e.target as HTMLSelectElement).value as DueFilter; void fill(); },
    },
      ...([["all", "Toutes échéances"], ["overdue", "En retard"], ["today", "Aujourd'hui"], ["week", "7 prochains jours"], ["none", "Sans échéance"]] as const)
        .map(([v, label]) => h("option", { value: v, selected: filters.due === v }, label))),
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
    h("label", { class: "inline" },
      h("input", { type: "checkbox", checked: filters.withSubtasks, onchange: (e: Event) => { filters.withSubtasks = (e.target as HTMLInputElement).checked; } }),
      "Cocher une tâche coche ses sous-tâches"),
    h("button", { class: "ghost", onclick: () => { tasks = null; void fill(); } }, "Rafraîchir"),
  );
  browse.hidden = true;
  root.replaceChildren(h("section", { class: "card" },
    h("div", { class: "row spread" },
      h("h2", {}, listName),
      project
        ? h("span", { class: "muted small" }, project.repo_path)
        : h("span", { class: "warn small" }, "Liste sans repo : associe-la dans les Réglages pour y lancer des agents")),
    toolbar, browse, bar, dialog, body));

  // Rafraîchissement périodique, suspendu fenêtre cachée ou fenêtre de lancement ouverte.
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (!body.isConnected) return window.clearInterval(refreshTimer);
    if (document.hidden || dialog.childElementCount) return;
    tasks = null;
    void fill();
  }, REFRESH_MS);

  let tasks: cu.CuTask[] | null = null;
  async function fill() {
    try {
      me ??= await cu.getUser();
      myTag = await lock.myLockTag();
      tasks ??= await cu.getListTasks(filters.listId, filters.closed);
      const open = (await db.listRuns()).filter((r) => runs.ACTIVE_STATES.includes(r.state) || ["blocked", "in_review"].includes(r.state));
      body.replaceChildren(table(tasks, open));
      renderBar();
    } catch (e) {
      body.replaceChildren(errorBox(e));
    }
  }

  function renderBar() {
    const chosen = (tasks ?? []).filter((t) => selected.has(t.id));
    if (!project) {
      bar.replaceChildren(h("span", { class: "muted small" }, "Consultation seule : cette liste n'est associée à aucun repo."));
      return;
    }
    bar.replaceChildren(
      chosen.length
        ? h("span", {}, `${chosen.length} tâche(s) sélectionnée(s)`)
        : h("span", { class: "muted small" }, "Coche une ou plusieurs tâches pour leur assigner un agent."),
      chosen.length ? h("button", { onclick: () => void openDialog(project, chosen) }, "Assigner un agent") : "",
      chosen.length ? h("button", { class: "ghost", onclick: () => { selected.clear(); dialog.replaceChildren(); void fill(); } }, "Tout décocher") : "",
    );
  }

  async function openDialog(project: db.Project, chosen: cu.CuTask[]) {
    let mode: db.RunMode = chosen.length > 1 ? "groupe" : "separe";
    let strategy: db.GitStrategy = "branche";
    let statusMode = await db.getSetting<db.StatusMode>("status_mode", "auto");
    const briefBox = h("textarea", { rows: 12 }) as HTMLTextAreaElement;
    let briefEdited = false;
    briefBox.oninput = () => (briefEdited = true);
    const content = h("div");

    async function refresh() {
      const rule = await runs.strategyFor(chosen, project, mode);
      if (rule.forced) strategy = rule.forced;
      const radio = <T extends string>(name: string, value: T, current: T, label: string, set: (v: T) => void, disabled = false) =>
        h("label", { class: "inline" },
          h("input", { type: "radio", name, checked: current === value, disabled, onchange: () => { set(value); void refresh(); } }),
          label);
      const single = mode === "groupe" || chosen.length === 1;
      if (single && !briefEdited) {
        const full = await Promise.all(chosen.map((t) => cu.getTask(t.id)));
        briefBox.value = runs.buildBrief(full, {
          worktree: runs.BRIEF_WORKTREE,
          base: project.base_branch,
          branch: strategy === "branche" ? runs.BRIEF_BRANCH : null,
        });
      }
      content.replaceChildren(
        chosen.length > 1
          ? h("div", { class: "row" },
              h("b", {}, "Mode :"),
              radio("mode", "groupe", mode, "Groupé : un agent pour toutes les tâches", (v) => (mode = v)),
              radio("mode", "separe", mode, `Séparé : ${chosen.length} agents en parallèle`, (v) => (mode = v)))
          : "",
        h("div", { class: "row" },
          h("b", {}, "Git :"),
          radio("strategy", "branche", strategy, "Branche + PR", (v) => (strategy = v), Boolean(rule.forced)),
          radio("strategy", "direct-main", strategy, `Commit direct sur ${project.base_branch}`, (v) => (strategy = v), Boolean(rule.forced))),
        h("p", { class: "muted small" }, rule.reason),
        h("div", { class: "row" },
          h("b", {}, "Statuts ClickUp :"),
          radio("statusMode", "auto", statusMode, "automatiques", (v) => (statusMode = v)),
          radio("statusMode", "manual", statusMode, "manuels (je valide chaque changement)", (v) => (statusMode = v))),
        single
          ? h("div", {}, h("h3", {}, "Brief envoyé à l'agent (modifiable)"), briefBox)
          : h("p", { class: "muted small" }, "En mode séparé, chaque agent reçoit le brief de sa tâche."),
        h("div", { class: "row" },
          h("button", {
            onclick: async (e: Event) => {
              const btn = e.target as HTMLButtonElement;
              btn.disabled = true;
              btn.textContent = "Lancement…";
              try {
                const ids = await runs.launch(chosen, project, { mode, strategy, statusMode, brief: single && briefEdited ? briefBox.value : undefined });
                selected.clear();
                goToRun(ids[0]);
              } catch (err) {
                btn.disabled = false;
                btn.textContent = "Lancer maintenant";
                btn.after(errorBox(err));
              }
            },
          }, "Lancer maintenant"),
          h("button", {
            class: "ghost",
            onclick: async (e: Event) => {
              const btn = e.target as HTMLButtonElement;
              btn.disabled = true;
              try {
                await queue.add(chosen, project, { mode, strategy, statusMode, brief: single && briefEdited ? briefBox.value : undefined });
                selected.clear();
                dialog.replaceChildren(h("p", { class: "ok" }, `${chosen.length} tâche(s) ajoutée(s) à la file.`));
                void fill();
              } catch (err) {
                btn.disabled = false;
                btn.after(errorBox(err));
              }
            },
          }, "Ajouter à la file"),
          h("button", { class: "ghost", onclick: () => dialog.replaceChildren() }, "Annuler")),
      );
    }

    dialog.replaceChildren(h("div", { class: "card" },
      h("h3", {}, `Assigner un agent : ${chosen.map((t) => t.name).join(", ")}`), content));
    await refresh();
  }

  function table(all: cu.CuTask[], open: db.Run[]) {
    const q = filters.search.toLowerCase();
    const visible = all.filter((t) =>
      (!q || t.name.toLowerCase().includes(q) || t.id.includes(q)) &&
      (!filters.mine || t.assignees.some((a) => a.id === me?.id)) &&
      matchesDue(t.due_date, filters.due));
    const ids = new Set(visible.map((t) => t.id));
    // Les sous-tâches s'affichent sous leur parente quand celle-ci est visible.
    const roots = visible.filter((t) => !t.parent || !ids.has(t.parent));
    const children = (id: string) => visible.filter((t) => t.parent === id);

    const tbl = h("table", {},
      h("tr", {}, h("th", {}, ""), h("th", {}, "Tâche"), h("th", {}, "Statut"), h("th", {}, "Assignés"), h("th", {}, "Agent")));
    const row = (t: cu.CuTask, sub: boolean) => {
      const run = open.find((r) => r.task_ids.includes(t.id));
      const tag = lock.lockOf(t);
      const otherPc = tag && tag !== myTag ? tag : null;
      const box = h("input", {
        type: "checkbox",
        checked: selected.has(t.id),
        disabled: Boolean(run || otherPc || !project),
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          const targets = [t, ...(filters.withSubtasks ? all.filter((c) => c.parent === t.id) : [])];
          for (const x of targets) {
            const busy = open.some((r) => r.task_ids.includes(x.id)) || (lock.lockOf(x) && lock.lockOf(x) !== myTag);
            if (on && !busy) selected.add(x.id);
            else if (!on) selected.delete(x.id);
          }
          body.replaceChildren(table(all, open));
          renderBar();
        },
      });
      tbl.append(h("tr", { class: sub ? "sub" : "" },
        h("td", {}, box),
        h("td", {}, h("a", { onclick: () => openUrl(t.url) }, t.name), h("span", { class: "muted small" }, `  CU-${t.id}`)),
        h("td", {}, h("span", { class: "pill", style: `background:${t.status.color}` }, t.status.status)),
        h("td", { class: "small" }, t.assignees.map((a) => a.username).join(", ")),
        h("td", {}, run
          ? h("a", { onclick: () => goToRun(run.id) }, `run ${run.state}`)
          : otherPc
            ? h("span", { class: "small warn" }, `pris par ${otherPc.slice(lock.LOCK_PREFIX.length)} `,
                h("a", {
                  onclick: async () => {
                    const yes = await ask(
                      `Libérer « ${t.name} » ? À faire seulement si ${otherPc.slice(lock.LOCK_PREFIX.length)} ne travaille plus dessus (PC éteint, app plantée).`,
                      { title: "Codbot", kind: "warning" },
                    );
                    if (!yes) return;
                    await lock.release(t.id, otherPc);
                    tasks = null;
                    void fill();
                  },
                }, "Libérer"))
            : "")));
    };
    for (const t of roots) {
      row(t, false);
      for (const c of children(t.id)) row(c, true);
    }
    if (!roots.length) tbl.append(h("tr", {}, h("td", { colSpan: 5, class: "muted" }, "Aucune tâche.")));
    return tbl;
  }

  await fill();
}

/** Parcours espace → dossier → liste de l'espace de travail ClickUp. */
function browsePanel(onPick: (listId: string, name: string) => void) {
  const spaceSel = h("select", {}, h("option", { value: "" }, "Espace…")) as HTMLSelectElement;
  const listSel = h("select", { disabled: true }, h("option", { value: "" }, "Liste…")) as HTMLSelectElement;
  const panel = h("div", { class: "row" }, spaceSel, listSel);
  void (async () => {
    try {
      const teamId = await db.getSetting<string>("team_id", "");
      for (const sp of await cu.getSpaces(teamId)) spaceSel.append(h("option", { value: sp.id }, sp.name));
    } catch (e) {
      panel.append(errorBox(e));
    }
  })();
  spaceSel.onchange = async () => {
    listSel.replaceChildren(h("option", { value: "" }, "Liste…"));
    listSel.disabled = true;
    if (!spaceSel.value) return;
    const [folders, lists] = await Promise.all([cu.getFolders(spaceSel.value), cu.getFolderlessLists(spaceSel.value)]);
    for (const l of lists) listSel.append(h("option", { value: l.id }, l.name));
    for (const f of folders) listSel.append(h("optgroup", { label: f.name }, ...f.lists.map((l) => h("option", { value: l.id }, l.name))));
    listSel.disabled = false;
  };
  listSel.onchange = () => {
    if (listSel.value) onPick(listSel.value, listSel.selectedOptions[0].textContent ?? listSel.value);
  };
  return panel;
}
