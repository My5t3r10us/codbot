// Prototype M0 : piloter le CLI `claude` en stream-json depuis Tauri et valider
// les hypothèses H1 (permissions, reprise), H2 (limite d'usage) et H5 (4 h fenêtre cachée).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Child, Command } from "@tauri-apps/plugin-shell";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

type Json = Record<string, any>;
type Pending = { key: string; source: "hook" | "stdio"; tool: string; input: Json; requestId: string };
type HookEvent = { id: string; event: string; payload: Json; blocking: boolean };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SECRET_KEY = "clickup-token-test";

let child: Child | null = null;
let sessionId = "";
let stdoutBuffer = "";
const pending = new Map<string, Pending>();

// ---------- journal ----------

function log(text: string, cls = "") {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  if (cls) li.className = cls;
  const ol = $("log");
  ol.appendChild(li);
  ol.scrollTop = ol.scrollHeight;
}

function check(label: string, ok: boolean, detail = "") {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "err";
  li.textContent = `${ok ? "OK" : "ÉCHEC"} · ${label}${detail ? ` : ${detail}` : ""}`;
  $("checks").appendChild(li);
}

const brief = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function setState(state: string) {
  $("state").textContent = state;
  const running = child !== null;
  ($("start") as HTMLButtonElement).disabled = running;
  ($("send") as HTMLButtonElement).disabled = !running;
  ($("stop") as HTMLButtonElement).disabled = !running;
  ($("resume") as HTMLButtonElement).disabled = running || !sessionId;
}

async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
  return granted;
}

// ---------- session claude ----------

async function startSession(resume: boolean) {
  const cwd = ($("cwd") as HTMLInputElement).value.trim();
  const model = ($("model") as HTMLInputElement).value.trim();
  const route = ($("route") as HTMLSelectElement).value as "hook" | "stdio";
  const settings = await invoke<string>("prepare_run_settings", { decidePermissions: route === "hook" });

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--settings", settings,
    "--permission-mode", "default",
    "--permission-prompts", route === "stdio" ? "host" : "none",
  ];
  if (model) args.push("--model", model);
  if (resume && sessionId) args.push("--resume", sessionId);

  const cmd = Command.create("claude", args, { cwd });
  cmd.stdout.on("data", (chunk) => onStdout(chunk));
  cmd.stderr.on("data", (line) => log(`stderr: ${line}`, "warn"));
  cmd.on("error", (err) => log(`erreur processus : ${err}`, "err"));
  cmd.on("close", ({ code, signal }) => {
    log(`processus terminé (code ${code}, signal ${signal})`, code === 0 ? "" : "warn");
    child = null;
    setState("arrêté");
  });

  log(`lancement : claude ${args.join(" ")}  (cwd ${cwd}, permissions via ${route})`);
  child = await cmd.spawn();
  setState(resume ? "reprise" : "démarrage");
  await sendUser(($("prompt") as HTMLTextAreaElement).value);
}

async function sendUser(text: string) {
  if (!child || !text.trim()) return;
  const msg = { type: "user", message: { role: "user", content: text } };
  await child.write(JSON.stringify(msg) + "\n");
  log(`> ${brief(text)}`);
  setState("en cours");
}

function onStdout(chunk: string) {
  // Le plugin émet ligne par ligne, mais on tolère une ligne JSON coupée en plusieurs morceaux.
  stdoutBuffer += chunk;
  let msg: Json;
  try {
    msg = JSON.parse(stdoutBuffer);
  } catch {
    if (stdoutBuffer.trim().startsWith("{")) return;
    log(`stdout brut : ${brief(stdoutBuffer)}`, "warn");
    stdoutBuffer = "";
    return;
  }
  stdoutBuffer = "";
  handleMessage(msg);
}

function handleMessage(msg: Json) {
  if (msg.session_id && msg.session_id !== sessionId) {
    sessionId = msg.session_id;
    $("session").textContent = sessionId;
  }
  if (detectRateLimit(msg)) return;

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        const mcp = (msg.mcp_servers ?? []).map((s: Json) => `${s.name}(${s.status})`).join(", ");
        log(`init : modèle ${msg.model}, ${msg.tools?.length ?? 0} outils, ${msg.slash_commands?.length ?? 0} commandes/skills, MCP : ${mcp || "aucun"}`, "ok");
      } else if (msg.subtype !== "commands_changed") {
        log(`system/${msg.subtype}`);
      }
      return;
    case "assistant":
      for (const part of msg.message?.content ?? []) {
        if (part.type === "text") log(`agent : ${brief(part.text, 400)}`);
        if (part.type === "tool_use") log(`outil demandé : ${part.name} ${brief(part.input)}`);
      }
      return;
    case "user":
      for (const part of msg.message?.content ?? []) {
        if (part.type === "tool_result") log(`résultat outil${part.is_error ? " (erreur)" : ""} : ${brief(part.content)}`, part.is_error ? "warn" : "");
      }
      return;
    case "result":
      log(`fin du tour : ${msg.subtype}, ${msg.num_turns} tours, ${msg.duration_ms} ms${msg.is_error ? " · ERREUR" : ""} · ${brief(msg.result ?? "", 300)}`, msg.is_error ? "err" : "ok");
      setState("attend un message");
      return;
    case "control_request":
      if (msg.request?.subtype === "can_use_tool") {
        addPending({
          key: msg.request_id,
          source: "stdio",
          tool: msg.request.tool_name,
          input: msg.request.input ?? {},
          requestId: msg.request_id,
        });
      } else {
        log(`control_request non géré : ${msg.request?.subtype}`, "warn");
        writeControl(msg.request_id, {});
      }
      return;
    default:
      log(`${msg.type}${msg.subtype ? "/" + msg.subtype : ""} : ${brief(msg, 200)}`);
  }
}

function detectRateLimit(msg: Json): boolean {
  const text = JSON.stringify(msg);
  const isLimit =
    msg.type === "rate_limit_event" ||
    (msg.type === "result" && msg.is_error && /limit|quota|usage/i.test(String(msg.result))) ||
    (msg.error && /rate_limit|usage_limit/i.test(String(msg.error)));
  if (!isLimit) return false;
  $("ratelimit").textContent = msg.type === "rate_limit_event" ? brief(msg.rate_limit_info ?? msg, 120) : "ATTEINTE";
  log(`LIMITE D'USAGE : ${brief(text, 500)}`, "warn");
  // Un rate_limit_event peut être purement informatif : on le journalise sans bloquer le flux.
  return msg.type === "rate_limit_event";
}

async function writeControl(requestId: string, response: Json) {
  if (!child) return;
  const reply = { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
  await child.write(JSON.stringify(reply) + "\n");
}

// ---------- permissions ----------

function addPending(p: Pending) {
  pending.set(p.key, p);
  renderPending();
  setState("attend une permission");
  log(`PERMISSION demandée (${p.source}) : ${p.tool} ${brief(p.input)}`, "warn");
  notify("Codbot : permission demandée", `${p.tool} attend ta décision`);
}

async function decide(key: string, allow: boolean) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  renderPending();
  if (p.source === "hook") {
    const ok = await invoke<boolean>("resolve_hook", {
      id: p.key,
      behavior: allow ? "allow" : "deny",
      reason: allow ? "Autorisé depuis Codbot" : "Refusé depuis Codbot",
    });
    if (!ok) log("décision arrivée trop tard (délai dépassé)", "err");
  } else {
    await writeControl(
      p.requestId,
      allow ? { behavior: "allow", updatedInput: p.input } : { behavior: "deny", message: "Refusé depuis Codbot" },
    );
  }
  log(`décision : ${allow ? "autorisé" : "refusé"} ${p.tool}`, allow ? "ok" : "warn");
  setState("en cours");
}

function renderPending() {
  const ul = $("pending");
  ul.innerHTML = "";
  if (pending.size === 0) {
    ul.innerHTML = '<li class="muted">Aucune</li>';
    return;
  }
  for (const p of pending.values()) {
    const li = document.createElement("li");
    const title = document.createElement("b");
    title.textContent = `${p.tool} (${p.source})`;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(p.input, null, 2);
    const allow = document.createElement("button");
    allow.textContent = "Autoriser";
    allow.onclick = () => decide(p.key, true);
    const deny = document.createElement("button");
    deny.textContent = "Refuser";
    deny.className = "deny";
    deny.onclick = () => decide(p.key, false);
    const row = document.createElement("div");
    row.className = "row";
    row.append(allow, deny);
    li.append(title, pre, row);
    ul.appendChild(li);
  }
}

listen<HookEvent>("hook", ({ payload: h }) => {
  if (h.blocking) {
    addPending({ key: h.id, source: "hook", tool: h.payload.tool_name, input: h.payload.tool_input ?? {}, requestId: h.id });
    return;
  }
  const detail = h.payload.tool_name ?? h.payload.message ?? h.payload.source ?? "";
  log(`hook ${h.event}${detail ? ` : ${brief(detail)}` : ""}`);
  if (h.event === "Notification") notify("Codbot", String(h.payload.message ?? "L'agent attend"));
});

// ---------- vérifications système (H5) ----------

let ticks = 0;
let hiddenTicks = 0;
let maxGap = 0;
let last = Date.now();
$("since").textContent = new Date().toLocaleString();
setInterval(() => {
  const now = Date.now();
  const gap = now - last;
  last = now;
  ticks++;
  if (document.hidden) hiddenTicks++;
  if (ticks > 1 && gap > maxGap) maxGap = gap;
  $("ticks").textContent = String(ticks);
  $("maxgap").textContent = String(maxGap);
  $("hiddenticks").textContent = String(hiddenTicks);
}, 1000);
document.addEventListener("visibilitychange", () =>
  log(`fenêtre ${document.hidden ? "cachée" : "visible"} (ticks ${ticks}, écart max ${maxGap} ms)`),
);

$("secret-set").onclick = async () => {
  try {
    await invoke("secret_set", { key: SECRET_KEY, value: ($("secret") as HTMLInputElement).value });
    check("coffre Windows : écriture", true);
  } catch (e) {
    check("coffre Windows : écriture", false, String(e));
  }
};
$("secret-get").onclick = async () => {
  try {
    const v = await invoke<string | null>("secret_get", { key: SECRET_KEY });
    check("coffre Windows : relecture", v !== null, v === null ? "aucune valeur" : `${v.length} caractères relus`);
  } catch (e) {
    check("coffre Windows : relecture", false, String(e));
  }
};
$("secret-del").onclick = async () => {
  try {
    await invoke("secret_delete", { key: SECRET_KEY });
    check("coffre Windows : suppression", true);
  } catch (e) {
    check("coffre Windows : suppression", false, String(e));
  }
};
$("notify").onclick = async () => check("notification", await notify("Codbot M0", "Notification de test"));
($("awake") as HTMLInputElement).onchange = async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  try {
    const active = await invoke<boolean>("keep_awake", { on });
    check(`anti-veille ${on ? "activé" : "désactivé"}`, active === on);
  } catch (err) {
    check("anti-veille", false, String(err));
  }
};

// ---------- boutons session ----------

$("start").onclick = () => startSession(false).catch((e) => log(`échec du lancement : ${e}`, "err"));
$("resume").onclick = () => startSession(true).catch((e) => log(`échec de la reprise : ${e}`, "err"));
$("send").onclick = () => sendUser(($("prompt") as HTMLTextAreaElement).value);
$("stop").onclick = async () => {
  await child?.kill();
  child = null;
  setState("arrêté");
};
$("clear").onclick = () => ($("log").innerHTML = "");

($("cwd") as HTMLInputElement).value = "C:\\Code\\codbot\\m0-sandbox";
setState("inactif");
