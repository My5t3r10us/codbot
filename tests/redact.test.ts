import { describe, expect, it } from "vitest";
import { redact } from "../src/redact";

const M = "[secret masqué]";

describe("redact", () => {
  it.each([
    ["jeton GitHub", "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "token " + M],
    ["jeton fin GitHub", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", M],
    ["jeton ClickUp", "pk_152498026_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", M],
    ["clé Anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", M],
    ["clé AWS", "AKIAIOSFODNN7EXAMPLE", M],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", M],
  ])("masque un %s", (_, input, expected) => expect(redact(input)).toBe(expected));

  it("masque le mot de passe d'une URL de connexion", () => {
    expect(redact("postgres://dev:devpassword@127.0.0.1:5432/app")).toBe(`postgres://dev:${M}@127.0.0.1:5432/app`);
  });

  it("masque les affectations dont le nom évoque un secret", () => {
    expect(redact("DATABASE_PASSWORD=hunter22 et API_KEY: 'abcd1234'")).toBe(`DATABASE_PASSWORD=${M} et API_KEY: '${M}'`);
    expect(redact('{"client_secret": "s3cr3t-value"}')).toBe(`{"client_secret": "${M}"}`);
    expect(redact("Authorization: Bearer abcdefghijkl")).toBe(`Authorization: Bearer ${M}`);
  });

  it("masque un bloc de clé privée", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`clé :\n${pem}\nfin`)).toBe(`clé :\n${M}\nfin`);
  });

  it("laisse intact un résumé ordinaire", () => {
    const text = "J'ai redessiné index.html et commité 3ef082c [CU-1amh1wae3hg]. Le token de design reste inchangé.";
    expect(redact(text)).toBe(text);
  });

  it("est idempotent", () => {
    const once = redact("API_KEY=abcdef123456");
    expect(redact(once)).toBe(once);
  });
});
