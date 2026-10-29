// Liste blanche du mode sans surveillance.
// Motifs : un nom d'outil ("WebFetch", "mcp__github__*") ou "Bash(<motif>)", où `*` remplace
// n'importe quelle suite de caractères. Une commande Bash enchaînée (&&, ||, ;, |) n'est autorisée
// que si chacune de ses parties l'est.

export const DEFAULT_ALLOWLIST = [
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(ls*)",
  "Bash(pwd)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(wc *)",
  "Bash(echo *)",
  "Bash(npm test*)",
  "Bash(npm run *)",
  "Bash(npx tsc*)",
  "Bash(node *)",
];

/** Toujours refusé sans surveillance, même si un motif l'autorise : Codbot pousse lui-même. */
const HARD_DENY = [/^git(\s+-[Cc]\s+("[^"]*"|\S+))*\s+push\b/];

function globToRegex(glob: string) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s");
}

/** Découpe une commande shell en commandes simples (approximation qui respecte les guillemets). */
export function splitCommand(cmd: string) {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `cd` dans le worktree ne change rien au risque : il est toujours accepté. */
const isCd = (segment: string) => /^cd(\s|$)/.test(segment);

export function decideUnattended(allowlist: string[], tool: string, input: Record<string, unknown>) {
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    const bashPatterns = allowlist
      .map((p) => p.match(/^Bash\((.*)\)$/s)?.[1])
      .filter((p): p is string => p !== undefined)
      .map(globToRegex);
    for (const segment of splitCommand(command)) {
      if (HARD_DENY.some((re) => re.test(segment))) return { allow: false, reason: `« ${segment} » est interdit : Codbot pousse lui-même` };
      if (isCd(segment)) continue;
      if (!bashPatterns.some((re) => re.test(segment))) return { allow: false, reason: `« ${segment} » n'est pas dans la liste blanche` };
    }
    return { allow: true, reason: "commande dans la liste blanche" };
  }
  const ok = allowlist.filter((p) => !p.startsWith("Bash(")).some((p) => globToRegex(p).test(tool));
  return ok ? { allow: true, reason: "outil dans la liste blanche" } : { allow: false, reason: `outil ${tool} hors liste blanche` };
}
