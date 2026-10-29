// Publie une version de Codbot dans les releases GitHub, avec le manifeste lu par l'updater.
//
//   infisical run --env=dev -- npm run release -- --notes "Ce qui change"
//
// `--skip-build` republie les fichiers déjà construits (après un échec de `gh`, par exemple).
//
// Prérequis : version incrémentée dans src-tauri/tauri.conf.json, `gh` connecté, et la clé de
// signature dans l'environnement (TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? "";
const repo = endpoint.match(/github\.com\/([^/]+\/[^/]+)\/releases/)?.[1];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const notes = flag("--notes") ?? `Codbot ${version}`;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// Le shell n'est utilisé que pour npm (npm.cmd sous Windows) : avec lui, les arguments contenant
// des espaces (titre, notes) seraient découpés.
function run(cmd, cmdArgs, { shell = false } = {}) {
  console.log(`\n> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: shell && process.platform === "win32" });
  if (r.status !== 0) fail(`${cmd} a échoué (code ${r.status})`);
}

if (!repo) fail("Endpoint de l'updater absent ou hors GitHub dans tauri.conf.json (plugins.updater.endpoints).");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) fail("TAURI_SIGNING_PRIVATE_KEY absente : lance la commande via `infisical run --env=dev -- …`.");
if (spawnSync("gh", ["release", "view", `v${version}`, "--repo", repo], { stdio: "ignore" }).status === 0) {
  fail(`La release v${version} existe déjà sur ${repo} : incrémente la version dans tauri.conf.json.`);
}

if (!args.includes("--skip-build")) run("npm", ["run", "tauri", "build"], { shell: true });

const dir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const exe = `${conf.productName}_${version}_x64-setup.exe`;
const sig = `${exe}.sig`;
if (!existsSync(join(dir, exe)) || !existsSync(join(dir, sig))) fail(`Installeur ou signature introuvable dans ${dir}.`);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(dir, sig), "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${exe}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));

run("gh", [
  "release", "create", `v${version}`,
  join(dir, exe), join(dir, sig), join(dir, "latest.json"),
  "--repo", repo, "--title", `Codbot ${version}`, "--notes", notes,
]);
console.log(`\n✓ Codbot ${version} publié sur https://github.com/${repo}/releases/tag/v${version}`);
