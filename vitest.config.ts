import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Les tests d'intégration git lancent de vrais processus git : 5 s par défaut ne suffit pas.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
