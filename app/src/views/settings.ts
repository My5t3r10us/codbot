// Réglages : jeton ClickUp, espace de travail, mode des statuts, projets (liste ↔ repo) et correspondance des statuts.
import * as cu from "../clickup";
import { runChecks } from "../diag";
import * as lock from "../lock";
import * as settingsio from "../settingsio";
import * as db from "../db";
import { errorBox, h } from "../dom";
import { DEFAULT_ALLOWLIST } from "../allowlist";
import * as git from "../git";

export async function renderSettings(root: HTMLElement) {
  root.replaceChildren(
    diagCard(),
    tokenCard(),
    await workspaceCard(),
    await pcCard(),
    await modeCard(),
    await projectsCard(),
    shareCard(() => renderSettings(root)),
  );
}

function diagCard() {
  const list = h("ul", {}, h("li", { class: "muted" }, "Vérification…"));
  const refresh = async () => {
    const checks = await runChecks();
    list.replaceChildren(...checks.map((c) => h("li", { class: c.ok ? "ok" : "err" }, `${c.ok ? "OK" : "À corriger"} · ${c.name} : ${c.detail}`)));
  };
  void refresh();
  return h("section", { class: "card" },
    h("div", { class: "row spread" }, h("h2", {}, "Diagnostic de ce PC"), h("button", { class: "ghost", onclick: refresh }, "Revérifier")),
    list);
}

async function pcCard() {
  const name = await lock.pcName();
  const input = h("input", { value: name, style: "width: 220px" }) as HTMLInputElement;
  const tag = h("code", {}, lock.lockTag(name));
  input.oninput = () => (tag.textContent = lock.lockTag(input.value || name));
  return h("section", { class: "card" },
    h("h2", {}, "Ce PC"),
    h("div", { class: "row" },
      h("label", {}, "Nom (verrous multi-PC)", input),
      h("button", { onclick: async () => { await db.setSetting("pc_name", input.value.trim()); await lock.pcName(); } }, "Enregistrer")),
    h("p", { class: "muted small" }, "Une tâche prise par ce PC reçoit le tag ", tag, " dans ClickUp ; les autres PC la laissent de côté jusqu'à la fin du run."));
}

function shareCard(rerender: () => void) {
  const msg = h("p", { class: "small" });
  const done = (text: string, ok = true) => {
    msg.textContent = text;
    msg.className = `small ${ok ? "ok" : "err"}`;
  };
  return h("section", { class: "card" },
    h("h2", {}, "Partager les réglages entre PC"),
    h("p", { class: "muted small" },
      "L'export contient l'espace de travail, le mode des statuts, le modèle, la file, les projets (listes, branches, vérification, liste blanche) et la correspondance des statuts. ",
      "Ni le jeton ClickUp ni les chemins des repos : chaque PC garde les siens."),
    h("div", { class: "row" },
      h("button", {
        onclick: async () => {
          try {
            const path = await settingsio.exportToFile();
            if (path) done(`Exporté dans ${path}`);
          } catch (e) {
            done((e as Error).message, false);
          }
        },
      }, "Exporter…"),
      h("button", {
        class: "ghost",
        onclick: async () => {
          try {
            const r = await settingsio.importFromFile();
            if (!r) return;
            rerender();
          } catch (e) {
            done((e as Error).message, false);
          }
        },
      }, "Importer…")),
    msg);
}

function tokenCard() {
  const status = h("p", { class: "muted" }, "Vérification…");
  const input = h("input", { type: "password", placeholder: "pk_…", style: "min-width: 320px" }) as HTMLInputElement;
  const refresh = async () => {
    try {
      if (!(await cu.getToken())) {
        status.textContent = "Aucun jeton enregistré.";
        status.className = "warn";
        return;
      }
      const user = await cu.getUser();
      status.textContent = `Connecté à ClickUp en tant que ${user.username} (${user.email}).`;
      status.className = "ok";
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = "err";
    }
  };
  void refresh();
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Jeton API ClickUp"),
    h("p", { class: "muted small" }, "ClickUp → Réglages → Apps → API Token. Stocké dans le Gestionnaire d'identification Windows, jamais en clair."),
    h(
      "div",
      { class: "row" },
      input,
      h("button", {
        onclick: async () => {
          if (!input.value.trim()) return;
          await cu.setToken(input.value.trim());
          input.value = "";
          await refresh();
        },
      }, "Enregistrer"),
      h("button", { class: "ghost", onclick: async () => { await cu.clearToken(); await refresh(); } }, "Supprimer"),
    ),
    status,
  );
}

async function workspaceCard() {
  const card = h("section", { class: "card" }, h("h2", {}, "Espace de travail"));
  try {
    const teams = await cu.getTeams();
    let current = await db.getSetting<string>("team_id", "");
    if (!current && teams.length) {
      current = teams[0].id;
      await db.setSetting("team_id", current);
    }
    const select = h("select", {
      onchange: (e: Event) => db.setSetting("team_id", (e.target as HTMLSelectElement).value),
    }, ...teams.map((t) => h("option", { value: t.id, selected: t.id === current }, t.name)));
    card.append(select);
  } catch (e) {
    card.append(errorBox(e));
  }
  return card;
}

async function modeCard() {
  const mode = await db.getSetting<"auto" | "manual">("status_mode", "auto");
  const model = await db.getSetting<string>("model", "");
  const radio = (value: "auto" | "manual", label: string) =>
    h("label", { class: "inline" },
      h("input", { type: "radio", name: "status_mode", checked: mode === value, onchange: () => db.setSetting("status_mode", value) }),
      label);
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Statuts et agent"),
    h("div", { class: "row" },
      radio("auto", "Automatique : Codbot change le statut et commente la tâche"),
      radio("manual", "Manuel : Codbot propose, je valide")),
    h("h3", {}, "Modèle Claude (vide = modèle par défaut de Claude Code)"),
    h("input", {
      value: model,
      placeholder: "ex. opus, sonnet",
      onchange: (e: Event) => db.setSetting("model", (e.target as HTMLInputElement).value.trim()),
    }),
  );
}

async function projectsCard() {
  const card = h("section", { class: "card" }, h("h2", {}, "Projets (liste ClickUp ↔ repo local)"));
  const projects = await db.listProjects();
  if (!projects.length) card.append(h("p", { class: "muted" }, "Aucun projet. Ajoute une liste ClickUp et le repo qui lui correspond."));
  for (const p of projects) card.append(await projectBlock(p, () => renderSettings(card.parentElement as HTMLElement)));
  card.append(await addProjectForm(() => renderSettings(card.parentElement as HTMLElement)));
  return card;
}

async function projectBlock(p: db.Project, rerender: () => void) {
  const repo = h("input", { value: p.repo_path, style: "min-width: 320px" }) as HTMLInputElement;
  const base = h("input", { value: p.base_branch, style: "width: 100px" }) as HTMLInputElement;
  const verify = h("input", { value: p.verify_command ?? "", placeholder: "ex. npm test (optionnel)" }) as HTMLInputElement;
  const allow = h("textarea", { rows: 6, value: p.allowlist.join("\n"), placeholder: DEFAULT_ALLOWLIST.join("\n") }) as HTMLTextAreaElement;
  const msg = h("span", { class: "small" });
  const save = async () => {
    try {
      await git.git(repo.value.trim(), "rev-parse", "--git-dir");
      await db.saveProject({
        ...p,
        repo_path: repo.value.trim(),
        base_branch: base.value.trim() || "main",
        verify_command: verify.value.trim() || null,
        allowlist: allow.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      });
      msg.textContent = "Enregistré.";
      msg.className = "small ok";
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = "small err";
    }
  };

  const block = h(
    "div",
    { class: "card", style: "margin-top: 10px" },
    h("div", { class: "row spread" },
      h("b", {}, p.list_name, p.repo_path ? "" : h("span", { class: "warn small" }, "  · repo local à renseigner sur ce PC")),
      h("button", { class: "ghost", onclick: async () => { await db.deleteProject(p.list_id); rerender(); } }, "Retirer")),
    h("div", { class: "row" },
      h("label", {}, "Repo local", repo),
      h("label", {}, "Branche principale", base),
      h("label", {}, "Vérification avant push", verify),
      h("button", { onclick: save }, "Enregistrer"),
      msg),
    h("h3", {}, "Liste blanche du mode sans surveillance (un motif par ligne, puis Enregistrer)"),
    h("p", { class: "muted small" },
      "« Bash(npm test*) » autorise une commande (* = n'importe quoi), « WebFetch » ou « mcp__github__* » un outil. ",
      "Lecture et modifications dans le worktree sont toujours autorisées ; git push est toujours refusé. Liste vide = liste par défaut."),
    allow,
    h("div", { class: "row" },
      h("button", { class: "ghost", onclick: () => (allow.value = DEFAULT_ALLOWLIST.join("\n")) }, "Remettre la liste par défaut")),
    h("h3", {}, "Correspondance des statuts"),
  );
  try {
    const [list, mappings] = await Promise.all([cu.getList(p.list_id), db.getMappings(p.list_id)]);
    const table = h("table", {}, h("tr", {}, h("th", {}, "Événement"), h("th", {}, "Statut ClickUp")));
    for (const { event, label } of db.STATUS_EVENTS) {
      const select = h("select", {
        onchange: (e: Event) => db.setMapping(p.list_id, event, (e.target as HTMLSelectElement).value),
      },
        h("option", { value: "" }, "(ne rien changer)"),
        ...list.statuses.map((s) => h("option", { value: s.status, selected: mappings[event] === s.status }, s.status)));
      table.append(h("tr", {}, h("td", {}, label), h("td", {}, select)));
    }
    block.append(table);
  } catch (e) {
    block.append(errorBox(e));
  }
  return block;
}

async function addProjectForm(rerender: () => void) {
  const form = h("div", { class: "card", style: "margin-top: 10px" }, h("h3", {}, "Ajouter un projet"));
  const teamId = await db.getSetting<string>("team_id", "");
  if (!teamId) {
    form.append(h("p", { class: "muted" }, "Enregistre d'abord ton jeton ClickUp."));
    return form;
  }
  const spaceSel = h("select", {}, h("option", { value: "" }, "Espace…")) as HTMLSelectElement;
  const listSel = h("select", { disabled: true }, h("option", { value: "" }, "Liste…")) as HTMLSelectElement;
  const repo = h("input", { placeholder: "C:\\Code\\mon-projet", style: "min-width: 280px" }) as HTMLInputElement;
  const base = h("input", { value: "main", style: "width: 100px" }) as HTMLInputElement;
  const msg = h("span", { class: "small" });

  try {
    for (const s of await cu.getSpaces(teamId)) spaceSel.append(h("option", { value: s.id }, s.name));
  } catch (e) {
    form.append(errorBox(e));
  }
  spaceSel.onchange = async () => {
    listSel.replaceChildren(h("option", { value: "" }, "Liste…"));
    listSel.disabled = true;
    if (!spaceSel.value) return;
    const [folders, lists] = await Promise.all([cu.getFolders(spaceSel.value), cu.getFolderlessLists(spaceSel.value)]);
    for (const l of lists) listSel.append(h("option", { value: l.id }, l.name));
    for (const f of folders) {
      listSel.append(h("optgroup", { label: f.name }, ...f.lists.map((l) => h("option", { value: l.id }, l.name))));
    }
    listSel.disabled = false;
  };

  const add = async () => {
    if (!listSel.value || !repo.value.trim()) {
      msg.textContent = "Choisis une liste et un repo.";
      msg.className = "small err";
      return;
    }
    try {
      await git.git(repo.value.trim(), "rev-parse", "--git-dir");
      if (!(await git.hasRemote(repo.value.trim()))) throw new Error("Ce repo n'a pas de remote « origin ».");
      await db.saveProject({
        list_id: listSel.value,
        list_name: listSel.selectedOptions[0].textContent ?? listSel.value,
        repo_path: repo.value.trim(),
        base_branch: base.value.trim() || "main",
        verify_command: null,
        allowlist: DEFAULT_ALLOWLIST,
      });
      rerender();
    } catch (e) {
      msg.textContent = (e as Error).message;
      msg.className = "small err";
    }
  };

  form.append(h("div", { class: "row" },
    h("label", {}, "Espace", spaceSel),
    h("label", {}, "Liste", listSel),
    h("label", {}, "Repo local", repo),
    h("label", {}, "Branche principale", base),
    h("button", { onclick: add }, "Ajouter"),
    msg));
  return form;
}
