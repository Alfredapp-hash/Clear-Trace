import fs from "fs";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3456;
// E2E runs against its own SQLite file, recreated on every run.
const E2E_DB = path.resolve(__dirname, "data", "e2e.db");
const usingExternalServer = !!process.env.PLAYWRIGHT_BASE_URL;
// E2E_SERVER=prod runs the suite against the standalone production build (`npm run build`
// first): production CSP, cookies and bundles. The default is the dev server.
const prodServer = process.env.E2E_SERVER === "prod";
const PROD_COMMAND = [
  "rm -rf .next/standalone/.next/static .next/standalone/public",
  "cp -r .next/static .next/standalone/.next/static",
  "cp -r public .next/standalone/public",
  `PORT=${PORT} HOSTNAME=127.0.0.1 node .next/standalone/server.js`,
].join(" && ");

// Playwright re-evaluates this config in every worker process. Reset the DB only once,
// in the main process: deleting it after the web server has opened it leaves parts of the
// app on a fresh empty file (sessions then fail and pages bounce to /login).
if (!usingExternalServer && !process.env.CLEARTRACE_E2E_DB_RESET) {
  process.env.CLEARTRACE_E2E_DB_RESET = "1";
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${E2E_DB}${suffix}`, { force: true });
  }
}

export default defineConfig({
  testDir: "./e2e",
  // Compiles every main route on the dev server before the first test (no-op for prod builds).
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: usingExternalServer
    ? undefined
    : {
        command: prodServer ? PROD_COMMAND : `npm run dev -- -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        // Never reuse a developer's server: it would point at their real DB.
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATABASE_URL: E2E_DB,
          SESSION_SECRET: "e2e-session-secret-not-for-production-0123456789",
          ENCRYPTION_KEY: "e2e-encryption-key-not-for-production-0123456789",
          WORKER_SECRET: "e2e-worker-secret",
          NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
          // The suite registers several accounts; the default (first_user) closes
          // self-signup after the first one.
          REGISTRATION_MODE: "open",
        },
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
