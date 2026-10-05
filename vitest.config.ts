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
      // Thresholds sit at the baseline measured during Sprint 3 (v1.3.0), rounded down
      // with ~2 points of slack (measured with all lanes in: src/lib 72.2/64.4/70.3/74.8,
      // src/app/api 50.8/35.6/70.3/52.9 for statements/branches/functions/lines).
      // Raise them as coverage improves; never lower them to get a PR through.
      thresholds: {
        "src/lib/**": { statements: 70, branches: 62, functions: 68, lines: 72 },
        "src/app/api/**": { statements: 48, branches: 33, functions: 68, lines: 50 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
