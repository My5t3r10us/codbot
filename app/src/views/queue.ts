// Vue File : marche / pause, réglages de la nuit, ordre des éléments (glisser-déposer), rapport.
import { openUrl } from "@tauri-apps/plugin-opener";
import * as db from "../db";
import { fmtDate, h } from "../dom";
import * as queue from "../queue";
import { STATE_LABEL } from "./runs";

export async function renderQueue(root: HTMLElement, goToRun: (id: string) => void) {
  const rerender = () => renderQueue(root, goToRun);
  root.replaceChildren(await controls(rerender), await itemsCard(rerender), await reportCard(goToRun));
}

async function controls(rerender: () => void) {
  const st = await queue.status();
  const unattended = await db.getSetting("unattended", false);
  const concurrency = await db.getSetting("concurrency", 2);
  const timeout = await db.getSetting("question_timeout_min", 10);
  const line = !st.running
    ? h("span", { class: "muted" }, "File arrêtée.")
    : st.pausedUntil
      ? h("span", { class: "warn" }, `En pause (limite d'usage) jusqu'à ${new Date(st.pausedUntil).toLocaleTimeString("fr-FR")}.`)
      : h("span", { class: "ok" }, "File en marche : les runs s'enchaînent, l'anti-veille est actif.");

  const num = (key: string, value: number, min: number, max: number) =>
    h("input", {
      type: "number", value, min, max, style: "width: 70px",
      onchange: (e: Event) => db.setSetting(key, Math.max(min, Math.min(max, Number((e.target as HTMLInputElement).value) || min))),
    });

  return h("section", { class: "card" },
    h("div", { class: "row spread" },
      h("h2", {}, "File d'attente"),
      st.running
        ? h("button", { class: "ghost", onclick: async () => { await queue.stop(); rerender(); } }, "Arrêter la file")
        : h("button", { onclick: async () => { await queue.start(); rerender(); } }, "Démarrer la file")),
    h("p", {}, line),
    h("div", { class: "row" },
      h("label", {}, "Agents en parallèle", num("concurrency", concurrency, 1, 6)),
      h("label", {}, "Délai de réponse (min)", num("question_timeout_min", timeout, 1, 240)),
      h("label", { class: "inline" },
        h("input", { type: "checkbox", checked: unattended, onchange: (e: Event) => db.setSetting("unattended", (e.target as HTMLInputElement).checked) }),
        "Sans surveillance : permissions décidées par la liste blanche de chaque projet")),
    h("p", { class: "muted small" },
      "Sans réponse dans le délai, un run de la file passe en « Bloqué » et la file continue. ",
      "Sur limite d'usage, toute la file attend la réinitialisation puis reprend les runs en pause."),
  );
}

async function itemsCard(rerender: () => void) {
  const items = await db.listQueue();
  const projects = new Map((await db.listProjects()).map((p) => [p.list_id, p]));
  const card = h("section", { class: "card" }, h("h2", {}, `À lancer (${items.length})`));
  if (!items.length) {
    card.append(h("p", { class: "muted" }, "Rien en attente. Ajoute des tâches depuis l'onglet Tâches (« Ajouter à la file »)."));
    return card;
  }
  let dragged: string | null = null;
  const list = h("ol", { class: "queue" });
  for (const item of items) {
    const li = h("li", {
      draggable: true,
      ondragstart: () => (dragged = item.id),
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: async (e: DragEvent) => {
        e.preventDefault();
        if (!dragged || dragged === item.id) return;
        const ids = items.map((i) => i.id).filter((id) => id !== dragged);
        ids.splice(ids.indexOf(item.id), 0, dragged);
        await queue.reorder(ids);
        rerender();
      },
    },
      h("div", { class: "row spread" },
        h("span", {}, h("span", { class: "grip" }, "⋮⋮ "), item.task_names.join(", ")),
        h("button", { class: "ghost", onclick: async () => { await queue.remove(item.id); rerender(); } }, "Retirer")),
      h("div", { class: "muted small" },
        `${projects.get(item.list_id)?.list_name ?? item.list_id} · `,
        item.strategy === "branche" ? "branche + PR" : "commit direct",
        item.task_ids.length > 1 ? " · groupé" : "",
        item.brief ? " · brief modifié" : ""));
    list.append(li);
  }
  card.append(h("p", { class: "muted small" }, "Glisse-dépose pour changer l'ordre."), list);
  return card;
}

async function reportCard(goToRun: (id: string) => void) {
  const report = await queue.lastReport();
  const card = h("section", { class: "card" }, h("h2", {}, "Rapport de la dernière file"));
  if (!report) {
    card.append(h("p", { class: "muted" }, "Aucune file lancée pour l'instant."));
    return card;
  }
  const s = report.session;
  card.append(
    h("p", {}, h("b", {}, report.headline), h("span", { class: "muted small" },
      ` · démarrée ${fmtDate(s.started_at)}${s.ended_at ? `, terminée ${fmtDate(s.ended_at)}` : ", en cours"}`)),
  );
  const tbl = h("table", {}, h("tr", {}, h("th", {}, "Tâches"), h("th", {}, "État"), h("th", {}, "Durée"), h("th", {}, "Détail")));
  for (const r of report.runs) {
    const minutes = Math.round(((r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.created_at)) / 60_000);
    const detail = r.pr_url
      ? h("a", { onclick: () => openUrl(r.pr_url!) }, "PR")
      : r.error
        ? h("span", { class: "small err" }, r.error.slice(0, 160))
        : r.pushed_commit
          ? h("span", { class: "small" }, `poussé ${r.pushed_commit.slice(0, 7)}`)
          : "";
    tbl.append(h("tr", {},
      h("td", {}, h("a", { onclick: () => goToRun(r.id) }, r.task_names.join(", "))),
      h("td", {}, h("span", { class: `state ${r.state}` }, STATE_LABEL[r.state])),
      h("td", { class: "small" }, `${minutes} min`),
      h("td", {}, detail)));
  }
  card.append(tbl);
  return card;
}
