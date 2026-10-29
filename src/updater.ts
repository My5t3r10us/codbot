// Mises à jour automatiques : manifeste latest.json publié dans les releases GitHub,
// paquet signé avec la clé Codbot (vérifié par le plugin updater avant installation).
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateInfo = { current: string; available: Update | null };

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = await getVersion();
  return { current, available: await check() };
}

/** Télécharge, installe puis relance l'app. `onProgress` reçoit un pourcentage (ou null si inconnu). */
export async function installAndRelaunch(update: Update, onProgress: (pct: number | null) => void) {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    if (e.event === "Progress") {
      received += e.data.chunkLength;
      onProgress(total ? Math.round((received / total) * 100) : null);
    }
  });
  await relaunch();
}
