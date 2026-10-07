import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/lib/test/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/e2e/**",
      "**/agent-builder/dist/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
    coverage: {
      provider: "v8",
      // Server logic and API routes; UI components are covered by Playwright instead.
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["**/*.test.ts", "src/lib/test/**", "**/*.d.ts"],
      // No html reporter: its generated .js would be picked up by `npm run lint`.
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      // Thresholds sit at the baseline measured during Sprint 4 (v1.4.0), rounded down with
      // ~3 points of slack (measured 2026-10-05 with every lane's work in the tree:
      // src/lib 80.8/71.9/80.4/83.3, src/app/api 56.4/42.2/73.3/59.1 for
      // statements/branches/functions/lines; Sprint 3 gates were 70/62/68/72 and 48/33/68/50).
      // Sprint 5 (v1.5.0) added route tests for api-keys, webhooks, authorization, export and
      // billing: src/app/api measured 68.0/52.9/74.1/71.4 (2026-10-07), gated ~2 points under.
      // Raise them as coverage improves; never lower them to get a PR through.
      thresholds: {
        "src/lib/**": { statements: 77, branches: 68, functions: 77, lines: 80 },
        "src/app/api/**": { statements: 66, branches: 51, functions: 72, lines: 69 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
