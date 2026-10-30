// Session `claude` pilotée en stream-json (validée par le prototype M0).
import { invoke } from "@tauri-apps/api/core";
import { Child, Command } from "@tauri-apps/plugin-shell";
import { rateLimitFrom, usageFrom } from "./rules";
import type { Usage } from "./rules";

type Json = Record<string, any>;

export type AgentCallbacks = {
  onSession(sessionId: string): void;
  onLog(type: string, text: string): void;
  onTurnEnd(result: { isError: boolean; text: string }): void;
  /** Limite d'usage atteinte ; `resetsAt` en ms quand le flux l'indique. */
  onRateLimit(info: { text: string; resetsAt: number | null }): void;
  /** Usage de l'abonnement, envoyé par le CLI à chaque requête. */
  onUsage(usage: Usage): void;
  onExit(code: number | null): void;
  /** Appel d'outil de l'agent (ou d'un sous-agent si `parentId` est renseigné). */
  onToolUse?(tool: { id: string; name: string; input: Json; parentId: string | null }): void;
  /** Résultat d'un appel d'outil. */
  onToolResult?(result: { toolUseId: string; isError: boolean }): void;
};

const brief = (v: unknown, n = 300) => {
  const s = typeof v === "string" ? v : String(JSON.stringify(v));
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export class AgentSession {
  private child: Child | null = null;
  private buffer = "";
  /** Arrêt demandé par Codbot : la fin du processus n'est pas une sortie inattendue. */
  private stopping = false;

  constructor(
    private runId: string,
    private cwd: string,
    private cb: AgentCallbacks,
    private model: string | null,
    private effort: string | null = null,
  ) {}

  get running() {
    return this.child !== null;
  }

  async start(prompt: string, resumeSessionId?: string | null) {
    const settings = await invoke<string>("prepare_run_settings", { runId: this.runId });
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--settings", settings,
      "--permission-mode", "default",
      // Les permissions passent par le hook PreToolUse : rien ne doit attendre un humain dans le CLI.
      "--permission-prompts", "none",
    ];
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--effort", this.effort);
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const cmd = Command.create("claude", args, { cwd: this.cwd });
    cmd.stdout.on("data", (chunk) => this.onStdout(chunk));
    cmd.stderr.on("data", (line) => this.cb.onLog("stderr", line));
    cmd.on("error", (err) => this.cb.onLog("error", `processus claude : ${err}`));
    cmd.on("close", ({ code }) => {
      this.child = null;
      // Sinon onExit, arrivé après coup, écraserait l'état posé par l'appelant (pause, bloqué…)
      // ou retirerait la session suivante du même run.
      if (!this.stopping) this.cb.onExit(code);
    });
    this.child = await cmd.spawn();
    await this.send(prompt);
  }

  async send(text: string) {
    if (!this.child) throw new Error("La session n'est pas active");
    const msg = { type: "user", message: { role: "user", content: text } };
    await this.child.write(JSON.stringify(msg) + "\n");
    this.cb.onLog("user", text);
  }

  async stop() {
    const c = this.child;
    this.child = null;
    this.stopping = true;
    await c?.kill();
  }

  private onStdout(chunk: string) {
    // Le plugin émet ligne par ligne, mais on tolère une ligne JSON coupée en plusieurs morceaux.
    this.buffer += chunk;
    let msg: Json;
    try {
      msg = JSON.parse(this.buffer);
    } catch {
      if (this.buffer.trim().startsWith("{")) return;
      this.cb.onLog("stdout", brief(this.buffer));
      this.buffer = "";
      return;
    }
    this.buffer = "";
    this.handle(msg);
  }

  private handle(msg: Json) {
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      this.cb.onSession(msg.session_id);
      const mcp = (msg.mcp_servers ?? []).filter((s: Json) => s.status === "connected").length;
      this.cb.onLog("init", `modèle ${msg.model}, ${msg.tools?.length ?? 0} outils, ${mcp} MCP connectés`);
      return;
    }
    const usage = usageFrom(msg);
    if (usage) this.cb.onUsage(usage);
    const limit = rateLimitFrom(msg);
    if (limit) this.cb.onRateLimit(limit);
    if (msg.type === "rate_limit_event" || (limit && msg.type !== "result")) return;
    switch (msg.type) {
      case "assistant": {
        const parentId = msg.parent_tool_use_id ? String(msg.parent_tool_use_id) : null;
        for (const part of msg.message?.content ?? []) {
          // Les messages d'un sous-agent restent visibles dans le journal mais marqués comme tels.
          if (part.type === "text" && !parentId) this.cb.onLog("agent", part.text);
          if (part.type === "tool_use") {
            this.cb.onLog(parentId ? "subtool" : "tool", `${part.name} ${brief(part.input, 200)}`);
            this.cb.onToolUse?.({ id: String(part.id ?? ""), name: String(part.name ?? ""), input: part.input ?? {}, parentId });
          }
        }
        return;
      }
      case "user":
        for (const part of msg.message?.content ?? []) {
          if (part.type === "tool_result") {
            if (part.is_error) this.cb.onLog("tool_error", brief(part.content));
            this.cb.onToolResult?.({ toolUseId: String(part.tool_use_id ?? ""), isError: Boolean(part.is_error) });
          }
        }
        return;
      case "result": {
        const text = String(msg.result ?? "");
        this.cb.onTurnEnd({ isError: Boolean(msg.is_error), text });
        return;
      }
    }
  }
}
