import * as db from "../db";

export type ThemePref = "auto" | "light" | "dark";

/** Thème : réglage « theme » (auto, clair, sombre), « auto » suit Windows. */
export async function applyTheme(pref?: ThemePref) {
  const p = pref ?? (await db.getSetting<ThemePref>("theme", "auto").catch(() => "auto" as const));
  const dark = p === "dark" || (p === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => void applyTheme());
