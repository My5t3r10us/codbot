// Verrou multi-PC : quand un PC prend une tâche, il lui pose le tag `codbot-<pc>`.
// Les autres PC ignorent les tâches qui portent le tag d'un autre PC. Un verrou périmé
// (PC éteint, app plantée) se libère à la main depuis l'onglet Tâches.
import { invoke } from "@tauri-apps/api/core";
import * as cu from "./clickup";
import * as db from "./db";

export const LOCK_PREFIX = "codbot-";

let cachedName: string | null = null;

/** Nom de ce PC : réglage « pc_name », sinon nom Windows de la machine. */
export async function pcName() {
  const custom = (await db.getSetting<string>("pc_name", "")).trim();
  cachedName = custom || (await invoke<string>("machine_name"));
  return cachedName;
}

export function lockTag(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${LOCK_PREFIX}${slug || "pc"}`;
}

export async function myLockTag() {
  return lockTag(cachedName ?? (await pcName()));
}

/** Tag de verrou posé sur la tâche, s'il y en a un. */
export function lockOf(task: Pick<cu.CuTask, "tags">) {
  return task.tags.map((t) => t.name.toLowerCase()).find((n) => n.startsWith(LOCK_PREFIX)) ?? null;
}

/** Tag de verrou d'un autre PC, ou null si la tâche est libre ou verrouillée par ce PC. */
export async function lockedByOther(task: Pick<cu.CuTask, "tags">) {
  const tag = lockOf(task);
  return tag && tag !== (await myLockTag()) ? tag : null;
}

export async function acquire(task: cu.CuTask) {
  const tag = await myLockTag();
  if (lockOf(task) === tag) return;
  try {
    await cu.addTag(task.id, tag);
  } catch {
    // Le tag n'existe pas encore dans l'espace : on le crée puis on réessaie.
    await cu.createSpaceTag(task.space.id, tag).catch(() => {});
    await cu.addTag(task.id, tag);
  }
}

export async function release(taskId: string, tag?: string) {
  await cu.removeTag(taskId, tag ?? (await myLockTag())).catch(() => {});
}
