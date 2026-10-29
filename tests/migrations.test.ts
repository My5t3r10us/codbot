// Applique toutes les migrations dans l'ordre sur une base SQLite en mémoire (node:sqlite),
// comme le plugin sql au démarrage de l'app.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "src-tauri", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("migrations SQL", () => {
  it("sont numérotées sans trou et déclarées dans lib.rs", () => {
    const lib = readFileSync(join(import.meta.dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
    files.forEach((f, i) => {
      expect(f.startsWith(String(i + 1).padStart(3, "0"))).toBe(true);
      expect(lib).toContain(`migrations/${f}`);
      expect(lib).toContain(`version: ${i + 1},`);
    });
  });

  it("s'appliquent dans l'ordre et produisent le schéma attendu", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of files) db.exec(readFileSync(join(dir, f), "utf8"));
    expect(columns(db, "runs")).toEqual(expect.arrayContaining([
      "id", "task_ids", "state", "mode", "branch", "pr_url", "task_progress", "task_initial_status", "queue_session", "status_mode",
    ]));
    expect(columns(db, "queue")).toEqual(expect.arrayContaining(["position", "strategy", "brief", "status_mode"]));
    expect(columns(db, "projects")).toContain("allowlist");
    db.close();
  });
});
