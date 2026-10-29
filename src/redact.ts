// Masquage des secrets dans tout texte qui sort de l'agent : commentaires ClickUp, PR GitHub,
// journal local (§8 de la spec). Approche par motifs : mieux vaut masquer un faux positif.

const MASK = "[secret masqué]";

const PATTERNS: [RegExp, string][] = [
  // Blocs de clé privée (PEM, OpenSSH, minisign…)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Jetons à préfixe connu
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, MASK],
  [/\bpk_\d+_[A-Z0-9]{20,}\b/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK],
  // Identifiants dans une URL : scheme://user:motdepasse@hôte
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // En-tête Authorization
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic|token)?\s*)[^\s"']{8,}/gi, `$1${MASK}`],
  // CLE=valeur, "password": "valeur"… quand le nom évoque un secret
  [
    /(\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?!\[secret masqué\])[^\s"',;]{4,}/gi,
    `$1${MASK}`,
  ],
];

export function redact(text: string) {
  return PATTERNS.reduce((t, [re, by]) => t.replace(re, by), text);
}
